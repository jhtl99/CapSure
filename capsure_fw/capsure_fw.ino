/*
 * CapSure firmware: recorder + HTTP API (docs/api.md v1) + Wi-Fi benchmarks.
 *
 *   camera + PDM mic -> PSRAM queue -> 2 s CAPS1SEG segments on SD,
 *   button / 's' saves the last 60 s as a manifest that protects its segments.
 * New on the recording side:
 *   - every closed segment also gets /caps/idx/XXXXXXXX.idx (one entry per
 *     packet) so the server can build a clip without rescanning the segment
 *   - manifests are written to .tmp and renamed, so a listing never sees half
 *   - writer task moved to core 1 (WRITER_CORE) so Wi-Fi on core 0 can't starve it
 *
 * Radio side (core 0):
 *   port 80   esp_http_server  the real API + /bench/ram + /admin/*
 *   port 8080 Arduino WebServer /ram + /clip?id=   (for the comparison only)
 *
 * Clip bodies are CAPS1 containers synthesized on the fly from the segment
 * files: 32-byte header, then each packet with a 12-byte header and the
 * payload read straight from SD. Exact Content-Length, Range supported.
 */

#include "esp_camera.h"
#include "img_converters.h"
#include "esp_sleep.h"
#include "driver/rtc_io.h"
#include "esp_timer.h"
#include "esp_random.h"
#include "esp_heap_caps.h"
#include <ESP_I2S.h>
#include "FS.h"
#include "SD.h"
#include "SPI.h"
#include <WiFi.h>
#include <WebServer.h>
#include <esp_wifi.h>
#include <esp_http_server.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <vector>
#include <map>
#include <memory>
#include <algorithm>
#include "capsure_types.h"

// ------------------------- configuration -------------------------
#define SEG_US        2000000LL        // 2-s segments
#define WINDOW_US     60000000LL       // a clip is whatever was recorded in the 60 s before the press
#define GAP_US        500000LL         // a jump this big between packets is a pause (no table), not footage
#define SAVE_MARGIN   200000LL         // wait until data past T+200 ms is written
#define MAX_UNPROT    34               // rolling buffer: 34 x 2 s = 68 s
#define QUEUE_BYTES   (4 * 1024 * 1024)
#define WBUF_SIZE     (32 * 1024)
#define AUDIO_GAIN    4.0f
// Pin assignments (see the team's pin table)
#define SAVE_PIN      D0               // GPIO1: momentary button to GND, pull-up, LOW = pressed
#define LED_PIN       D4               // GPIO5: recording LED, ON while camera + mic are running
#define WIFI_SW_PIN   D1               // GPIO2: maintained switch to GND, pull-up, LOW = Wi-Fi ON
#define SHUTDOWN_PIN  D3               // GPIO4: reserved, input from power control (polarity TBD, Clarence)
#define PWR_HOLD_PIN  D5               // GPIO6: reserved, output to power control (polarity TBD, Clarence)
// Both power-control pins are deliberately left unconfigured until the circuit
// and polarity are confirmed: driving PWR_HOLD the wrong way could cut power mid-write.

#define WIFI_SWITCH_ENABLED 1          // 0 = ignore D1 and keep the AP up (no switch wired)
#define ENABLE_WEB8080      0          // Arduino WebServer on :8080, only for the server comparison (~40 KB RAM)

// ---- pool table detection: >= GREEN_ON_PCT of the frame is green -> table ----
#define DETECT_PERIOD_MS   200         // 5 checks per second
#define GREEN_ON_PCT       10          // spec: at least 10% of the frame
#define GREEN_OFF_PCT      7           // must drop below this to switch off (hysteresis)
#define TABLE_LOST_MS      1000        // no green for longer than this -> stop recording
#define TABLE_GATES_RECORDING 1        // 0 = record all the time; detection is only reported
// What counts as a green pixel, in HSV. Keep the hue range symmetric around 120
// (pure green) and inside 60-180, so it only matches pixels where green is the
// largest channel, and the result does not depend on the decoder's R/B order.
#define GREEN_HUE_MIN      58          // degrees (tuned 11/9 on the color-tuning page); green must
#define GREEN_HUE_MAX      167         //   also be the largest channel, so the effective floor is 60
#define GREEN_SAT_MIN_PCT  16          // rejects grey/white/skin tones with a faint green tint
#define GREEN_VAL_MIN      42          // 0-255; rejects near-black pixels, whose hue is noise

// ---- color correction (tuned 11/9; same math as the color-tuning page and caps2mp4.py) ----
// The OV2640's output has its blacks lifted to ~25-30%, which greys everything
// out. The detector corrects its 80x60 frame with these before the green test,
// so the thresholds above mean the same thing as on the page.
// SENSOR_COLOR 1: the OV2640's own processor corrects color before JPEG
// compression, so recorded frames, the detector, the app and the MP4s all start
// from corrected color. Its controls are coarse (-2..2); tune them live with
// GET /admin/camera?brightness=..&contrast=..&saturation=..&ae=.. and copy the
// values here. SENSOR_COLOR 0: raw sensor output, corrected in software by the
// detector (CC_* below) and by caps2mp4.py.
#define SENSOR_COLOR       1
#define CAM_BRIGHTNESS     -2          // pulls the lifted blacks down
#define CAM_CONTRAST       2
#define CAM_SATURATION     2
#define CAM_AE_LEVEL       0
#define CAM_GAINCEILING    GAINCEILING_8X   // less noise/grey in dim areas
#define CC_EV              0.05f       // exposure, stops
#define CC_TEMP            0.15f       // + warmer
#define CC_TINT            0.20f       // + magenta (frames lean green)
#define CC_BLACK           0.23f       // black point
#define CC_WHITE           0.99f       // white point
#define CC_CONTRAST        1.10f
#define CC_GAMMA           1.15f       // > 1 lifts midtones
#define CC_SAT             1.55f
#define WRITER_CORE   1                // was 0 in sdwriteandviewtest
#define SD_MAX_FILES  10               // open files at once (default 5). Each slot costs ~4 KB of internal RAM:
                                       // recorder 1 + download workers 4 + indexing/thumb/ack/sum 2-3

#define TARGET_FPS    24               // design choice; the sensor free-runs at ~60 at VGA
#define CAM_VFLIP     1                // camera is mounted upside down
#define CAM_HMIRROR   0                // 0: frames were mirrored with 1 (text read backwards)
#define CLIP_W        640
#define CLIP_H        480
#define AUDIO_RATE    16000

const char *AP_SSID = "CapSure-1234";
const char *AP_PASS = "capsure123";
#define AP_CHANNEL_DEFAULT 6


enum : uint8_t { PKT_JPEG = 1, PKT_PCM = 2 };


// ------------------------- shared state -------------------------
I2SClass i2s;
QueueHandle_t pktQ;
portMUX_TYPE qMux = portMUX_INITIALIZER_UNLOCKED, saveMux = portMUX_INITIALIZER_UNLOCKED;
volatile size_t queuedBytes = 0, peakQueued = 0;
volatile uint32_t dropped = 0, framesCaptured = 0, audioBlocks = 0, worstWrite = 0, writeErrors = 0;
volatile int unprotCount = 0;
volatile bool listReq = false;
volatile int64_t btnT = 0; volatile bool btnFlag = false;
volatile uint32_t btnIrqs = 0; volatile bool btnDebug = false;

int64_t pendingT[8]; int nPending = 0;

// wall clock, set by POST /api/time
volatile bool clockSet = false;
volatile int64_t clockOffsetMs = 0;    // unix_ms - esp_timer_get_time()/1000
uint32_t bootId = 0;
volatile bool bufferHealthy = true;
volatile int ledFeedback = 0;            // blinks to show on the LED (1 = press seen, 3 = nothing saved)

// The wall clock survives deep sleep ('x'): the ESP32's RTC keeps counting,
// and this flag lives in RTC memory. It does not survive losing power.
RTC_DATA_ATTR bool rtcClockSet = false;

// safe shutdown ('x'): capture stops, writer drains and closes, then deep sleep
volatile bool captureStop = false, writerStop = false, writerDone = false;

// table detection: detector asks, camera task copies the next frame
volatile bool detWant = false;
SemaphoreHandle_t detReady;
uint8_t *detBuf = nullptr; volatile size_t detLen = 0;
volatile bool tableDetected = false;
volatile uint32_t greenPermille = 0;    // last check, tenths of a percent
volatile uint32_t detectMs = 0, detectChecks = 0;
volatile bool detVerbose = false;
volatile bool detEnabled = true;          // 'd' on serial toggles it
// Live camera tuning (/admin/camera). sensorColor decides whether the detector
// still corrects in software and what the clip manifest records.
volatile bool sensorColor = SENSOR_COLOR;
int camBrightness = CAM_BRIGHTNESS, camContrast = CAM_CONTRAST, camSaturation = CAM_SATURATION, camAe = CAM_AE_LEVEL;
// Footage is only kept while the table is in view. Starts off: nothing is
// recorded until the first green frame.
volatile bool recordingActive = !TABLE_GATES_RECORDING;
volatile int64_t detFrameTs = 0;          // capture time of the frame the detector is checking
volatile int64_t lastGreenTs = 0;         // capture time of the last frame that had the table
volatile uint32_t storageFreeMb = 0, storageTotalMb = 0;

// writer-only state
std::vector<SegInfo> segs;              // closed segments, oldest first
File segFile; bool segOpen = false;
SegInfo cur; uint32_t curPackets = 0;
std::vector<SegPkt> curIdx;
uint8_t *wbuf; size_t wlen = 0;
uint32_t nextSegId = 1, nextClipId = 1;

QueueHandle_t cmdQ;                     // HTTP -> writer commands (clip delete)

// preview: HTTP asks, camera task copies the next frame
volatile bool previewWant = false;
SemaphoreHandle_t previewReady;
uint8_t *previewBuf = nullptr; volatile size_t previewLen = 0;
#define PREVIEW_MAX (256 * 1024)

int64_t nowUnixMs() { return clockSet ? clockOffsetMs + esp_timer_get_time() / 1000 : 0; }

// ------------------------- CRC32 (zlib-compatible) -------------------------
static uint32_t crcTab[256];
void crcInit() {
  for (uint32_t i = 0; i < 256; i++) {
    uint32_t c = i;
    for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >> 1) : c >> 1;
    crcTab[i] = c;
  }
}
uint32_t crcUpdate(uint32_t crc, const uint8_t *p, size_t n) {
  crc = ~crc;
  while (n--) crc = crcTab[(crc ^ *p++) & 0xFF] ^ (crc >> 8);
  return ~crc;
}

// ------------------------- paths -------------------------
String segPath(uint32_t id) { char b[40]; snprintf(b, sizeof b, "/caps/seg/%08lu.cap", (unsigned long)id); return String(b); }
String idxPath(uint32_t id) { char b[40]; snprintf(b, sizeof b, "/caps/idx/%08lu.idx", (unsigned long)id); return String(b); }
String clipPath(uint32_t id, const char *ext) { char b[48]; snprintf(b, sizeof b, "/caps/clips/clip_%04lu.%s", (unsigned long)id, ext); return String(b); }

// tiny JSON helpers for our own manifests (no ArduinoJson dependency)
long long jnum(const String &s, const char *key, long long def) {
  String k = String("\"") + key + "\"";
  int i = s.indexOf(k); if (i < 0) return def;
  i = s.indexOf(':', i); if (i < 0) return def;
  return atoll(s.c_str() + i + 1);
}
std::vector<uint32_t> manifestSegIds(const String &txt) {
  std::vector<uint32_t> ids;
  for (int i = txt.indexOf("\"id\": "); i >= 0; i = txt.indexOf("\"id\": ", i + 1))
    ids.push_back(txt.substring(i + 6).toInt());
  return ids;
}

// ------------------------- capture side -------------------------
bool pushPacket(uint8_t type, int64_t ts, const uint8_t *src, uint32_t len) {
  size_t total = sizeof(Packet) + len;
  portENTER_CRITICAL(&qMux);
  bool ok = queuedBytes + total <= QUEUE_BYTES;
  if (ok) { queuedBytes += total; if (queuedBytes > peakQueued) peakQueued = queuedBytes; }
  portEXIT_CRITICAL(&qMux);
  if (!ok) { dropped++; return false; }

  Packet *p = (Packet *)ps_malloc(total);
  if (p) {
    p->h.type = type; memset(p->h.rsv, 0, 3); p->h.ts = ts; p->h.len = len;
    memcpy(p->data, src, len);
    if (xQueueSend(pktQ, &p, 0) == pdTRUE) return true;
    free(p);
  }
  portENTER_CRITICAL(&qMux); queuedBytes -= total; portEXIT_CRITICAL(&qMux);
  dropped++;
  return false;
}

void cameraTask(void *) {
  for (;;) {
    if (captureStop) { vTaskDelay(pdMS_TO_TICKS(100)); continue; }
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) continue;
    int64_t now = esp_timer_get_time();
    int64_t ts = (int64_t)fb->timestamp.tv_sec * 1000000LL + fb->timestamp.tv_usec;
    if (ts <= 0 || ts > now || now - ts > 500000) ts = now;

    if (previewWant && previewBuf && fb->len <= PREVIEW_MAX) {   // preview may use any frame
      memcpy(previewBuf, fb->buf, fb->len);
      previewLen = fb->len;
      previewWant = false;
      xSemaphoreGive(previewReady);
    }
    if (detWant && detBuf && fb->len <= PREVIEW_MAX) {           // so does the table detector
      memcpy(detBuf, fb->buf, fb->len);
      detLen = fb->len;
      detFrameTs = ts;
      detWant = false;
      xSemaphoreGive(detReady);
    }

    // Keep frames on a 24 fps schedule. A plain "at least 41.7 ms apart" rule
    // would give 20 fps from a 60 fps sensor (every 3rd frame), so track when
    // the next frame is due and accept one that lands within half a sensor
    // frame of it.
    if (!recordingActive) { esp_camera_fb_return(fb); continue; }   // no table: not recorded

    static int64_t nextDue = 0;
    const int64_t period = 1000000 / TARGET_FPS;
    if (ts + 8000 < nextDue) { esp_camera_fb_return(fb); continue; }
    nextDue += period;
    if (ts - nextDue > period) nextDue = ts + period;          // resync after a stall

    pushPacket(PKT_JPEG, ts, fb->buf, fb->len);
    framesCaptured++;
    esp_camera_fb_return(fb);
  }
}

void audioTask(void *) {
  int16_t raw[320], out[320];                              // 20 ms at 16 kHz
  int64_t anchorTs = -1;
  uint64_t samples = 0;
  float hpX = 0, hpY = 0;
  const float a = 0.9695f;                                  // ~80 Hz high-pass

  for (;;) {
    if (captureStop) { vTaskDelay(pdMS_TO_TICKS(100)); continue; }
    size_t n = i2s.readBytes((char *)raw, sizeof(raw)) / 2;
    if (!n) continue;
    int64_t now = esp_timer_get_time();
    int64_t ts = anchorTs + (int64_t)(samples * 1000000ULL / AUDIO_RATE);
    if (anchorTs < 0 || llabs((ts + (int64_t)n * 1000000 / AUDIO_RATE) - now) > 40000) {
      anchorTs = now - (int64_t)n * 1000000 / AUDIO_RATE;
      samples = 0;
      ts = anchorTs;
    }
    for (size_t i = 0; i < n; i++) {
      float x = raw[i];
      float y = a * (hpY + x - hpX);
      hpX = x; hpY = y;
      float v = y * AUDIO_GAIN;
      if (v > 32767.f) v = 32767.f;
      if (v < -32768.f) v = -32768.f;
      out[i] = (int16_t)v;
    }
    samples += n;
    if (!recordingActive) continue;                          // no table: not recorded
    pushPacket(PKT_PCM, ts, (uint8_t *)out, n * 2);
    audioBlocks++;
  }
}

// ------------------------- table detection -------------------------
// Integer HSV test. Only pixels whose largest channel is green can have a hue
// in 60-180, so check that first; then hue = 120 + 60 * (b - r) / (max - min).
static inline bool isGreen(uint8_t r, uint8_t g, uint8_t b) {
  if (g < r || g < b) return false;
  int mx = g, mn = r < b ? r : b, d = mx - mn;
  if (mx < GREEN_VAL_MIN || d == 0) return false;
  if (d * 100 < GREEN_SAT_MIN_PCT * mx) return false;              // saturation
  int hx = 60 * ((int)b - (int)r);                                   // (hue - 120) * d
  return hx >= (GREEN_HUE_MIN - 120) * d && hx <= (GREEN_HUE_MAX - 120) * d;
}

// jpg2rgb565 output byte order differs between esp32-camera versions;
// calibrateDecoder() measures it at boot.
bool rgb565HighByteFirst = true;
uint8_t *det565 = nullptr;
#define DET_W (CLIP_W / 8)
#define DET_H (CLIP_H / 8)

// Exposure + white balance, then levels, then contrast/gamma on luma and
// saturation on chroma. Matches the page and the ffmpeg chain in caps2mp4.py.
static float ccLut[1024];
void ccInit() {
  for (int i = 0; i < 1024; i++) {
    float y = (i / 1023.0f - 0.5f) * CC_CONTRAST + 0.5f;
    ccLut[i] = powf(y < 0 ? 0 : y > 1 ? 1 : y, 1.0f / CC_GAMMA);
  }
}
static inline uint8_t cc8(float v) { v *= 255.0f; return v <= 0 ? 0 : v >= 255 ? 255 : (uint8_t)(v + 0.5f); }
static inline void colorCorrect(uint8_t &r8, uint8_t &g8, uint8_t &b8) {
  static const float g = powf(2.0f, CC_EV);
  static const float gr = g * (1 + 0.1f * CC_TEMP), gg = g * (1 - 0.1f * CC_TINT), gb = g * (1 - 0.1f * CC_TEMP);
  static const float span = CC_WHITE - CC_BLACK;
  auto lv = [](float v) { v = (v > 1 ? 1 : v) - CC_BLACK; v /= span; return v < 0 ? 0.0f : v > 1 ? 1.0f : v; };
  float r = lv(r8 / 255.0f * gr), gn = lv(g8 / 255.0f * gg), b = lv(b8 / 255.0f * gb);
  float Y = 0.299f * r + 0.587f * gn + 0.114f * b;
  float U = (b - Y) * CC_SAT, V = (r - Y) * CC_SAT;
  float Y2 = ccLut[(int)(Y * 1023.0f + 0.5f)];
  float R = Y2 + V, B = Y2 + U, G = (Y2 - 0.299f * R - 0.114f * B) / 0.587f;
  r8 = cc8(R); g8 = cc8(G); b8 = cc8(B);
}

static inline void unpack565(const uint8_t *p, uint8_t &r, uint8_t &g, uint8_t &b) {
  uint16_t v = rgb565HighByteFirst ? (uint16_t)(p[0] << 8 | p[1]) : (uint16_t)(p[1] << 8 | p[0]);
  uint8_t r5 = v >> 11, g6 = (v >> 5) & 0x3F, b5 = v & 0x1F;
  r = (r5 << 3) | (r5 >> 2); g = (g6 << 2) | (g6 >> 4); b = (b5 << 3) | (b5 >> 2);
}

// Encode a solid green 16x16 image, decode it, and see which byte order gives
// back green. Pure green has R = B = 0, so it reads the same whether the
// encoder expects RGB or BGR.
bool calibrateDecoder() {
  const int W = 16, H = 16;
  uint8_t *rgb = (uint8_t *)malloc(W * H * 3), *jpg = nullptr;
  uint8_t out[W * H * 2];
  size_t jl = 0;
  if (!rgb) return false;
  for (int i = 0; i < W * H; i++) { rgb[3 * i] = 0; rgb[3 * i + 1] = 255; rgb[3 * i + 2] = 0; }
  bool ok = fmt2jpg(rgb, W * H * 3, W, H, PIXFORMAT_RGB888, 90, &jpg, &jl);
  free(rgb);
  if (!ok) { Serial.println("detect: calibration encode failed; assuming high byte first"); return false; }
  ok = JPG_TO_565(jpg, jl, out, 0);                                    // scale 0 = full size
  free(jpg);
  if (!ok) { Serial.println("detect: calibration decode failed; assuming high byte first"); return false; }
  const uint8_t *px = out + (8 * W + 8) * 2;                           // middle pixel
  uint16_t hi = px[0] << 8 | px[1], lo = px[1] << 8 | px[0];
  int gHi = (hi >> 5) & 0x3F, gLo = (lo >> 5) & 0x3F;
  rgb565HighByteFirst = gHi >= gLo;
  Serial.printf("detect: decoder outputs RGB565 %s (green test pixel bytes %02x %02x)\n",
                rgb565HighByteFirst ? "high byte first" : "low byte first", px[0], px[1]);
  return true;
}

// Turn recording (and the LED) on or off. Only the detector and the 'd'
// command call this.
void setRecording(bool on, const char *why) {
  if (recordingActive == on) return;
  recordingActive = on;
  digitalWrite(LED_PIN, on ? HIGH : LOW);
  Serial.printf(">>> %s: %s\n", on ? "RECORDING" : "PAUSED, LED off", why);
}

void detectTask(void *) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(DETECT_PERIOD_MS));
    if (captureStop || !detEnabled) continue;
    xSemaphoreTake(detReady, 0);
    detWant = true;
    if (xSemaphoreTake(detReady, pdMS_TO_TICKS(1000)) != pdTRUE) { detWant = false; continue; }

    int64_t t0 = esp_timer_get_time();
    bool ok = JPG_TO_565(detBuf, detLen, det565, 3);                  // scale 3 = 1/8: 640x480 -> 80x60
    struct { uint32_t green, total; } c = {0, 0};
    if (ok) {
      uint8_t r, g, b;
      for (int i = 0; i < DET_W * DET_H; i++) {
        unpack565(det565 + 2 * i, r, g, b);
        if (!sensorColor) colorCorrect(r, g, b);             // sensor already did it otherwise
        if (isGreen(r, g, b)) c.green++;
        c.total++;
      }
    }
    detectMs = (esp_timer_get_time() - t0) / 1000;
    if (!ok || !c.total) { if (detVerbose) Serial.println("detect: JPEG decode failed"); continue; }

    uint32_t pm = c.green * 1000 / c.total;
    greenPermille = pm;
    detectChecks++;
    // Hysteresis: 10% to switch on, but once on, 7% is enough to count as
    // "still the table" (so a shadow or a player leaning in doesn't stop it).
    int64_t ft = detFrameTs;
    bool green = pm >= (tableDetected ? GREEN_OFF_PCT : GREEN_ON_PCT) * 10;
    if (green) lastGreenTs = ft;
    if (!tableDetected && green) {
      tableDetected = true;                                  // on at the first green check
      Serial.printf(">>> POOL TABLE DETECTED (green %.1f%% of frame)\n", pm / 10.0);
      if (TABLE_GATES_RECORDING) setRecording(true, "table in view");
    } else if (tableDetected && !green && ft - lastGreenTs > (int64_t)TABLE_LOST_MS * 1000) {
      tableDetected = false;                                 // off after > 1 s with no green
      Serial.printf(">>> pool table lost (no green for %lld ms)\n", (long long)((ft - lastGreenTs) / 1000));
      if (TABLE_GATES_RECORDING) setRecording(false, "no table for over 1 s");
    }
    if (detVerbose)
      Serial.printf("detect: green %5.1f%% (%lu/%lu px) in %lu ms -> %s\n", pm / 10.0,
                    (unsigned long)c.green, (unsigned long)c.total, (unsigned long)detectMs,
                    tableDetected ? "TABLE" : "no table");
  }
}

// ------------------------- writer side -------------------------
void wflush() {
  if (!wlen) return;
  uint32_t t = millis();
  if (segFile.write(wbuf, wlen) != wlen) writeErrors++;
  uint32_t dt = millis() - t; if (dt > worstWrite) worstWrite = dt;
  wlen = 0;
}

void wput(const void *src, size_t n) {
  const uint8_t *p = (const uint8_t *)src;
  cur.crc = crcUpdate(cur.crc, p, n);
  cur.bytes += n;
  while (n) {
    size_t k = min(n, (size_t)WBUF_SIZE - wlen);
    memcpy(wbuf + wlen, p, k); wlen += k; p += k; n -= k;
    if (wlen == WBUF_SIZE) wflush();
  }
}

void openSeg(int64_t ts) {
  cur = {}; cur.id = nextSegId++; cur.firstTs = cur.lastTs = ts;
  curPackets = 0;
  curIdx.clear();
  segFile = SD.open(segPath(cur.id), FILE_WRITE);
  SegHdr h = {};                                           // placeholder, rewritten on close
  segFile.write((uint8_t *)&h, sizeof h);
  segOpen = true;
}

// The clip's thumbnail is the frame closest to the button press: that is the
// shot the player wanted to keep, and it's what the gallery shows before the
// clip is downloaded. Uses each segment's .idx table (newest segment first).
void writeThumb(uint32_t clipId, int64_t S, int64_t T) {
  for (auto it = segs.rbegin(); it != segs.rend(); ++it) {
    if (it->old || it->lastTs < S || it->firstTs > T) continue;
    File ix = SD.open(idxPath(it->id));
    if (!ix) continue;
    size_t n = ix.size() / sizeof(SegPkt);
    SegPkt e, best = {};
    bool found = false;
    for (size_t k = 0; k < n && ix.read((uint8_t *)&e, sizeof e) == sizeof e; k++)
      if (e.type == PKT_JPEG && e.ts >= S && e.ts <= T) { best = e; found = true; }   // keep the latest
    ix.close();
    if (!found) continue;
    File f = SD.open(segPath(it->id));
    uint8_t *b = (uint8_t *)ps_malloc(best.len);
    if (f && b && f.seek(best.off) && f.read(b, best.len) == best.len) {
      File o = SD.open(clipPath(clipId, "jpg"), FILE_WRITE); o.write(b, best.len); o.close();
    }
    free(b);
    if (f) f.close();
    return;
  }
}

void doSave(int64_t T) {
  // The clip is whatever was recorded in the 60 s before the press, from this
  // power-on only. Pauses (table out of view) inside that minute are cut out
  // later, so the clip can be shorter:
  //   - pressed 20 s after power-on       -> 20 s clip
  //   - table in view 30 s of the last 60  -> 30 s clip
  //   - no table at all in the last 60 s   -> nothing saved, LED blinks 3 times
  const int64_t S = T - WINDOW_US;
  int64_t have = 0;                                          // footage actually in the window, for the log
  for (auto &sg : segs) {
    if (sg.old || sg.lastTs < S || sg.firstTs > T) continue;
    have += min(sg.lastTs, T) - max(sg.firstTs, S);
  }
  uint32_t clipId = nextClipId++;
  String tmp = clipPath(clipId, "tmp");
  File m = SD.open(tmp, FILE_WRITE);
  m.printf("{\n  \"clip\": %lu,\n  \"boot\": %lu,\n  \"color\": \"%s\",\n  \"table_detected\": %s,\n  \"green_pct\": %.1f,\n"
           "  \"unix_ms\": %lld,\n  \"press_us\": %lld,\n  \"start_us\": %lld,\n  \"end_us\": %lld,\n  \"segments\": [\n",
           (unsigned long)clipId, (unsigned long)bootId, sensorColor ? "sensor" : "raw",
           tableDetected ? "true" : "false", greenPermille / 10.0,
           (long long)(clockSet ? clockOffsetMs + T / 1000 : 0),
           (long long)T, (long long)S, (long long)T);
  bool first = true; uint32_t total = 0, n = 0;
  for (auto &s : segs) {
    if (s.old || s.lastTs < S || s.firstTs > T) continue;
    s.refs++;
    uint32_t fileBytes = s.bytes + sizeof(SegHdr);
    total += fileBytes; n++;
    m.printf("%s    {\"id\": %lu, \"crc\": %lu, \"bytes\": %lu}", first ? "" : ",\n",
             (unsigned long)s.id, (unsigned long)s.crc, (unsigned long)fileBytes);
    first = false;
  }
  m.printf("\n  ],\n  \"total_bytes\": %lu\n}\n", (unsigned long)total);
  m.close();
  if (!n) {
    SD.remove(tmp);
    nextClipId--;
    Serial.println(">>> Nothing saved: nothing was recorded in the last 60 s");
    ledFeedback = 3;                                         // three quick blinks: nothing to keep
    return;
  }
  writeThumb(clipId, S, T);
  String fin = clipPath(clipId, "json");
  SD.rename(tmp, fin);                                     // listing only ever sees whole manifests
  Serial.printf(">>> Saved clip %04lu: %lu segments, %.1f s of footage over %.1f s, %.1f MB -> %s\n",
                (unsigned long)clipId, (unsigned long)n, have / 1e6, (T - S) / 1e6, total / 1048576.0, fin.c_str());
}

void processSaves(int64_t writtenUpTo) {
  for (;;) {
    int64_t T = 0; bool ready = false;
    portENTER_CRITICAL(&saveMux);
    if (nPending && pendingT[0] + SAVE_MARGIN <= writtenUpTo) {
      T = pendingT[0];
      for (int i = 1; i < nPending; i++) pendingT[i - 1] = pendingT[i];
      nPending--; ready = true;
    }
    portEXIT_CRITICAL(&saveMux);
    if (!ready) break;
    doSave(T);
  }
}

void enforceRetention() {
  int unprot = 0;
  for (auto &s : segs) if (!s.refs) unprot++;
  for (auto it = segs.begin(); unprot > MAX_UNPROT && it != segs.end();) {
    if (!it->refs) { SD.remove(segPath(it->id)); SD.remove(idxPath(it->id)); it = segs.erase(it); unprot--; }
    else ++it;
  }
  unprotCount = unprot;
}

void closeSeg() {
  wflush();
  SegHdr h;
  memcpy(h.magic, "CAPS1SEG", 8); h.version = 1; h.segId = cur.id;
  h.firstTs = cur.firstTs; h.lastTs = cur.lastTs; h.crc = cur.crc; h.packets = curPackets;
  segFile.seek(0);
  segFile.write((uint8_t *)&h, sizeof h);
  segFile.close();
  segOpen = false;

  File ix = SD.open(idxPath(cur.id), FILE_WRITE);         // packet table for the server
  if (ix) { ix.write((uint8_t *)curIdx.data(), curIdx.size() * sizeof(SegPkt)); ix.close(); }

  segs.push_back(cur);
  processSaves(cur.lastTs);
  enforceRetention();
}

// Recording just paused. Close the segment; if every packet in it came after
// the last frame that had the table, it is only "no table" footage: delete it.
void closePausedSeg() {
  uint32_t id = cur.id;
  bool noTable = cur.firstTs > lastGreenTs;
  closeSeg();
  if (noTable && !segs.empty() && segs.back().id == id && segs.back().refs == 0) {
    SD.remove(segPath(id)); SD.remove(idxPath(id));
    segs.pop_back();
    enforceRetention();
    Serial.printf("    deleted segment %08lu (no table in it)\n", (unsigned long)id);
  } else {
    Serial.printf("    closed segment %08lu (ends at the table's last frame + up to 1 s)\n", (unsigned long)id);
  }
}

void writePacket(Packet *p) {
  if (!segOpen) openSeg(p->h.ts);
  else if (p->h.ts >= cur.firstTs + SEG_US) { closeSeg(); openSeg(p->h.ts); }
  SegPkt e;
  e.type = p->h.type; memset(e.rsv, 0, 3); e.ts = p->h.ts;
  e.off = sizeof(SegHdr) + cur.bytes + sizeof(PktHdr);     // payload position in the file
  e.len = p->h.len;
  curIdx.push_back(e);
  wput(&p->h, sizeof(PktHdr));
  wput(p->data, p->h.len);
  curPackets++;
  if (p->h.ts < cur.firstTs) cur.firstTs = p->h.ts;
  if (p->h.ts > cur.lastTs) cur.lastTs = p->h.ts;
}

bool deleteClipFiles(uint32_t id) {                        // writer task only
  String mp = clipPath(id, "json");
  File f = SD.open(mp);
  if (!f) return false;
  String txt = f.readString(); f.close();
  for (uint32_t sid : manifestSegIds(txt))
    for (auto &s : segs) if (s.id == sid && s.refs) { s.refs--; break; }
  SD.remove(mp); SD.remove(clipPath(id, "jpg")); SD.remove(clipPath(id, "ack")); SD.remove(clipPath(id, "sum"));
  enforceRetention();
  Serial.printf(">>> Deleted clip %04lu\n", (unsigned long)id);
  return true;
}

void listClips() {
  File d = SD.open("/caps/clips");
  Serial.println("--- clips on card ---");
  for (File f = d.openNextFile(); f; f = d.openNextFile())
    Serial.printf("  %s  (%lu bytes)\n", f.name(), (unsigned long)f.size());
  Serial.printf("rolling segments: %d, protected/total segments: %u\n", unprotCount, (unsigned)segs.size());
}

void writerTask(void *) {
  for (;;) {
    Packet *p;
    if (xQueueReceive(pktQ, &p, pdMS_TO_TICKS(50)) == pdTRUE) {
      size_t total = sizeof(Packet) + p->h.len;
      writePacket(p);
      free(p);
      portENTER_CRITICAL(&qMux); queuedBytes -= total; portEXIT_CRITICAL(&qMux);
    }
    WCmd *c;
    while (xQueueReceive(cmdQ, &c, 0) == pdTRUE) { c->ok = deleteClipFiles(c->clipId); xSemaphoreGive(c->done); }
    if (listReq) { listReq = false; listClips(); }
    if (!recordingActive && !writerStop && uxQueueMessagesWaiting(pktQ) == 0) {
      if (segOpen) closePausedSeg();
      processSaves(INT64_MAX);                               // nothing more is coming: finish saves now
    }
    if (writerStop && !writerDone && uxQueueMessagesWaiting(pktQ) == 0) {
      if (segOpen) closeSeg();                               // header + .idx written, pending saves processed
      writerDone = true;
    }
  }
}

// ------------------------- boot recovery -------------------------
void recoverCard() {
  SD.mkdir("/caps"); SD.mkdir("/caps/seg"); SD.mkdir("/caps/clips"); SD.mkdir("/caps/idx");

  std::vector<uint32_t> refIds;
  std::vector<String> toDelete;
  File d = SD.open("/caps/clips");
  for (File f = d.openNextFile(); f; f = d.openNextFile()) {
    String name = f.name();
    if (name.endsWith(".tmp")) { toDelete.push_back(String(f.path())); continue; }
    if (!name.endsWith(".json")) continue;
    uint32_t cid = name.substring(5, 9).toInt();           // clip_XXXX.json
    if (cid >= nextClipId) nextClipId = cid + 1;
    String txt = f.readString();
    for (uint32_t id : manifestSegIds(txt)) refIds.push_back(id);
  }

  File sd = SD.open("/caps/seg");
  for (File f = sd.openNextFile(); f; f = sd.openNextFile()) {
    String name = f.name();
    if (!name.endsWith(".cap")) continue;
    uint32_t id = name.toInt();
    if (id >= nextSegId) nextSegId = id + 1;
    uint16_t refs = 0;
    for (uint32_t r : refIds) if (r == id) refs++;
    if (!refs) { toDelete.push_back(String(f.path())); continue; }
    SegHdr h;
    if (f.read((uint8_t *)&h, sizeof h) != sizeof h) continue;
    segs.push_back({id, h.firstTs, h.lastTs, (uint32_t)(f.size() - sizeof(SegHdr)), h.crc, refs, true});
  }
  File idd = SD.open("/caps/idx");
  for (File f = idd.openNextFile(); f; f = idd.openNextFile()) {
    uint32_t id = String(f.name()).toInt();
    if (std::find(refIds.begin(), refIds.end(), id) == refIds.end()) toDelete.push_back(String(f.path()));
  }
  for (auto &p : toDelete) SD.remove(p);
  std::sort(segs.begin(), segs.end(), [](const SegInfo &a, const SegInfo &b) { return a.id < b.id; });
  Serial.printf("Recovered %u protected segments, next clip #%lu, removed %u stale files\n",
                (unsigned)segs.size(), (unsigned long)nextClipId, (unsigned)toDelete.size());
}

// =====================================================================
//                       clip index + CAPS1 synthesis
// =====================================================================

SemaphoreHandle_t idxMux;
std::map<uint32_t, std::shared_ptr<ClipIdx>> idxCache;     // small LRU-ish cache
#define IDX_CACHE_MAX 8                                   // ~110 KB PSRAM per 60 s clip

// packet table for one segment: the .idx sidecar, or a scan of the .cap file
bool readSegIndex(uint32_t segId, std::vector<SegPkt> &out) {
  out.clear();
  File ix = SD.open(idxPath(segId));
  if (ix) {
    size_t n = ix.size() / sizeof(SegPkt);
    out.resize(n);
    bool ok = ix.read((uint8_t *)out.data(), n * sizeof(SegPkt)) == n * sizeof(SegPkt);
    ix.close();
    if (ok) return true;
    out.clear();
  }
  File f = SD.open(segPath(segId));                         // fallback (older recordings)
  if (!f) return false;
  uint32_t pos = sizeof(SegHdr), size = f.size();
  PktHdr h;
  while (pos + sizeof(PktHdr) <= size) {
    f.seek(pos);
    if (f.read((uint8_t *)&h, sizeof h) != sizeof h) break;
    if (pos + sizeof(PktHdr) + h.len > size) break;
    SegPkt e; e.type = h.type; memset(e.rsv, 0, 3); e.ts = h.ts; e.off = pos + sizeof(PktHdr); e.len = h.len;
    out.push_back(e);
    pos += sizeof(PktHdr) + h.len;
  }
  f.close();
  // Save the table so this slow scan happens once per old segment, not every listing.
  File w = SD.open(idxPath(segId), FILE_WRITE);
  if (w) { w.write((uint8_t *)out.data(), out.size() * sizeof(SegPkt)); w.close(); }
  Serial.printf("  scanned old segment %08lu (%u packets), saved its .idx\n",
                (unsigned long)segId, (unsigned)out.size());
  return true;
}

static void put16(uint8_t *b, uint16_t v) { memcpy(b, &v, 2); }
static void put32(uint8_t *b, uint32_t v) { memcpy(b, &v, 4); }
static void put64(uint8_t *b, uint64_t v) { memcpy(b, &v, 8); }

std::shared_ptr<ClipIdx> buildClip(uint32_t id, const char **err) {
  File mf = SD.open(clipPath(id, "json"));
  if (!mf) { *err = "clip_not_found"; return nullptr; }
  String txt = mf.readString(); mf.close();

  int64_t S = jnum(txt, "start_us", 0), T = jnum(txt, "end_us", 0), press = jnum(txt, "press_us", T);
  long long boot = jnum(txt, "boot", -1), unixAtPress = jnum(txt, "unix_ms", 0);
  std::vector<uint32_t> ids = manifestSegIds(txt);
  std::sort(ids.begin(), ids.end());

  auto c = std::make_shared<ClipIdx>();
  c->id = id;
  uint32_t cap = 2048;
  c->p = (OutPkt *)ps_malloc(cap * sizeof(OutPkt));
  if (!c->p) { *err = "storage_error"; return nullptr; }

  std::vector<SegPkt> sp;
  int64_t t0 = -1; uint32_t lastRel = 0;
  int64_t prevTs = -1, shift = 0;                           // pause gaps removed so far
  uint64_t out = 32;
  uint32_t nVideo = 0; int64_t vFirst = 0, vLast = 0; bool hasAudio = false;

  for (uint32_t sid : ids) {
    if (!readSegIndex(sid, sp)) { *err = "storage_error"; return nullptr; }
    for (auto &e : sp) {
      if (e.ts < S || e.ts > T) continue;                  // trim to [T-60 s, T]
      if (e.type != PKT_JPEG && e.type != PKT_PCM) continue;
      if (c->n == cap) {
        cap *= 2;
        OutPkt *np = (OutPkt *)ps_realloc(c->p, cap * sizeof(OutPkt));
        if (!np) { *err = "storage_error"; return nullptr; }
        c->p = np;
      }
      // A jump of more than GAP_US is a pause (table out of view): close it up,
      // leaving one frame's worth of time, so playback doesn't freeze.
      if (prevTs >= 0 && e.ts - prevTs > GAP_US) shift += e.ts - prevTs - 1000000 / TARGET_FPS;
      if (e.ts > prevTs) prevTs = e.ts;
      int64_t adj = e.ts - shift;
      if (t0 < 0) t0 = adj;
      int64_t rel = adj - t0;
      uint32_t r = rel < (int64_t)lastRel ? lastRel : (uint32_t)rel;   // CAPS1 needs non-decreasing pts
      lastRel = r;
      OutPkt &o = c->p[c->n++];
      o.seg = sid; o.src = e.off; o.len = e.len; o.out = (uint32_t)out; o.pts = r; o.type = e.type;
      out += 12 + e.len;
      if (e.type == PKT_JPEG) { if (!nVideo) vFirst = adj; vLast = adj; nVideo++; }
      else hasAudio = true;
    }
  }
  if (!c->n) { *err = "not_ready"; return nullptr; }

  c->bytes = out;
  float span = (vLast - vFirst) / 1e6f;
  int fps = (nVideo > 1 && span > 0) ? (int)lroundf((nVideo - 1) / span) : 15;
  c->fps = (uint16_t)constrain(fps, 1, 60);
  c->durationMs = lastRel / 1000;

  auto unixFor = [&](int64_t ts) -> int64_t {
    if (unixAtPress > 0) return unixAtPress - (press - ts) / 1000;
    if (boot == (long long)bootId && clockSet) return clockOffsetMs + ts / 1000;
    return 0;
  };
  c->createdUnixMs = unixFor(press);
  c->pressUs = press; c->unixAtPress = unixAtPress; c->boot = (uint32_t)boot;

  uint8_t *h = c->hdr;
  memset(h, 0, 32);
  memcpy(h, "CAPS", 4);
  h[4] = 1; h[5] = hasAudio ? 1 : 0;
  put16(h + 6, CLIP_W); put16(h + 8, CLIP_H); put16(h + 10, c->fps);
  put32(h + 12, AUDIO_RATE); h[16] = 16; h[17] = 1;
  put64(h + 20, (uint64_t)unixFor(t0));
  put32(h + 28, c->n);
  return c;
}

std::shared_ptr<ClipIdx> getClip(uint32_t id, const char **err) {
  xSemaphoreTake(idxMux, portMAX_DELAY);
  auto it = idxCache.find(id);
  std::shared_ptr<ClipIdx> c = it != idxCache.end() ? it->second : nullptr;
  xSemaphoreGive(idxMux);
  if (c) return c;

  uint32_t t = millis();
  c = buildClip(id, err);
  if (!c) return nullptr;
  Serial.printf("indexed clip %04lu: %lu packets, %.2f MB, %lu ms\n", (unsigned long)id,
                (unsigned long)c->n, c->bytes / 1e6, (unsigned long)(millis() - t));
  xSemaphoreTake(idxMux, portMAX_DELAY);
  while (idxCache.size() >= IDX_CACHE_MAX) idxCache.erase(idxCache.begin());
  idxCache[id] = c;
  xSemaphoreGive(idxMux);
  return c;
}

std::map<uint32_t, ClipSummary> summaries;                 // every clip seen this boot; ~40 B each

void dropClip(uint32_t id) {
  xSemaphoreTake(idxMux, portMAX_DELAY); idxCache.erase(id); summaries.erase(id); xSemaphoreGive(idxMux);
}

// Size/duration for the listing: RAM, else the .sum file, else index it once.
bool getSummary(uint32_t id, ClipSummary &out, const char **err) {
  xSemaphoreTake(idxMux, portMAX_DELAY);
  auto it = summaries.find(id);
  bool hit = it != summaries.end();
  if (hit) out = it->second;
  xSemaphoreGive(idxMux);
  if (hit) return true;

  File f = SD.open(clipPath(id, "sum"));
  bool ok = f && f.read((uint8_t *)&out, sizeof out) == sizeof out && out.magic == CLIP_SUMMARY_MAGIC && out.id == id;
  if (f) f.close();
  if (!ok) {
    auto c = getClip(id, err);
    if (!c) return false;
    out = {};
    out.magic = CLIP_SUMMARY_MAGIC; out.id = id; out.bytes = c->bytes; out.durationMs = c->durationMs;
    out.fps = c->fps; out.pressUs = c->pressUs; out.unixAtPress = c->unixAtPress; out.boot = c->boot;
    File w = SD.open(clipPath(id, "sum"), FILE_WRITE);
    if (w) { w.write((uint8_t *)&out, sizeof out); w.close(); }
  }
  xSemaphoreTake(idxMux, portMAX_DELAY);
  summaries[id] = out;
  xSemaphoreGive(idxMux);
  return true;
}


// Fill dst with clip bytes [off, off+n). Returns false on an SD error.
bool clipRead(const ClipIdx &c, uint64_t off, uint8_t *dst, size_t n, SegReader &r) {
  if (off < 32) {
    size_t k = min(n, (size_t)(32 - off));
    memcpy(dst, c.hdr + off, k);
    dst += k; off += k; n -= k;
  }
  while (n) {
    uint32_t lo = 0, hi = c.n - 1;                          // last packet with out <= off
    while (lo < hi) { uint32_t mid = (lo + hi + 1) / 2; if (c.p[mid].out <= off) lo = mid; else hi = mid - 1; }
    const OutPkt &q = c.p[lo];
    uint64_t rel = off - q.out;
    size_t k;
    if (rel < 12) {
      uint8_t ph[12] = {0};
      ph[0] = q.type; put32(ph + 4, q.pts); put32(ph + 8, q.len);
      k = min(n, (size_t)(12 - rel));
      memcpy(dst, ph + rel, k);
    } else {
      uint32_t pr = rel - 12;
      k = min(n, (size_t)(q.len - pr));
      if (!r.readAt(q.seg, q.src + pr, dst, k)) return false;
    }
    dst += k; off += k; n -= k;
  }
  return true;
}

// =====================================================================
//                           status JSON
// =====================================================================
String statusJson() {
  String j = "{";
  j += "\"api_version\":1,";
  j += "\"device_id\":\"capsure-a6-01\",";
  j += "\"fw_version\":\"0.2.0\",";
  j += "\"uptime_s\":" + String((unsigned long)(esp_timer_get_time() / 1000000)) + ",";
  j += String("\"recording\":") + (recordingActive ? "true" : "false") + ",";
  j += String("\"buffer_healthy\":") + (bufferHealthy ? "true" : "false") + ",";
  j += "\"buffer_seconds\":" + String(min(unprotCount * 2, 60)) + ",";
  j += "\"battery_pct\":100,";                               // TODO: Clarence's battery ADC
  j += "\"battery_mv\":4100,";
  j += "\"storage_free_mb\":" + String((unsigned long)storageFreeMb) + ",";
  j += "\"storage_total_mb\":" + String((unsigned long)storageTotalMb) + ",";
  j += "\"dropped_frames\":" + String((unsigned long)dropped) + ",";
  j += "\"clock_unix_ms\":" + String((long long)nowUnixMs()) + ",";
  j += String("\"clock_set\":") + (clockSet ? "true" : "false") + ",";
  j += String("\"table_detected\":") + (tableDetected ? "true" : "false") + ",";   // extra, not in api.md v1
  j += "\"green_pct\":" + String(greenPermille / 10.0f, 1);
  j += "}";
  return j;
}

String clipJson(const ClipSummary &c) {
  // Worked out on every listing, so a clip saved before the phone set the clock
  // gets its real time once the clock is set (same boot only).
  int64_t created = c.unixAtPress > 0 ? c.unixAtPress
                  : (c.boot == bootId && clockSet) ? clockOffsetMs + c.pressUs / 1000 : 0;
  char b[320];
  snprintf(b, sizeof b,
           "{\"id\":\"%04lu\",\"created_unix_ms\":%lld,\"duration_ms\":%lu,\"bytes\":%llu,"
           "\"width\":%d,\"height\":%d,\"fps\":%u,\"audio_sample_rate\":%d,\"acked\":%s,\"complete\":true}",
           (unsigned long)c.id, (long long)created, (unsigned long)c.durationMs,
           (unsigned long long)c.bytes, CLIP_W, CLIP_H, (unsigned)c.fps, AUDIO_RATE,
           SD.exists(clipPath(c.id, "ack")) ? "true" : "false");
  return String(b);
}

// =====================================================================
//                     radio: channel / bandwidth
// =====================================================================
volatile int reqChannel = AP_CHANNEL_DEFAULT, reqBw = 20;

void applyRadio(int ch, int bw) {
  WiFi.softAP(AP_SSID, AP_PASS, ch, 0, 4);
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_err_t e = esp_wifi_set_bandwidth(WIFI_IF_AP, bw == 40 ? WIFI_BW_HT40 : WIFI_BW_HT20);
  uint8_t p; wifi_second_chan_t s; esp_wifi_get_channel(&p, &s);
  wifi_bandwidth_t got; esp_wifi_get_bandwidth(WIFI_IF_AP, &got);
  Serial.printf("radio: asked ch %d / %d MHz -> now ch %u / %s MHz (set_bandwidth: %s)\n",
                ch, bw, p, got == WIFI_BW_HT40 ? "40" : "20", esp_err_to_name(e));
}

void radioTask(void *) {
  vTaskDelay(pdMS_TO_TICKS(400));                           // let the HTTP reply leave first
  applyRadio(reqChannel, reqBw);
  vTaskDelete(nullptr);
}

String radioJson() {
  uint8_t p; wifi_second_chan_t s; esp_wifi_get_channel(&p, &s);
  wifi_bandwidth_t bw; esp_wifi_get_bandwidth(WIFI_IF_AP, &bw);
  wifi_sta_list_t list = {}; esp_wifi_ap_get_sta_list(&list);
  String j = "{\"channel\":" + String(p) + ",\"bw\":" + String(bw == WIFI_BW_HT40 ? 40 : 20) +
             ",\"tx_power_dbm\":" + String(WiFi.getTxPower() / 4.0f, 1) + ",\"stations\":[";
  for (int i = 0; i < list.num; i++) {
    char m[64];
    snprintf(m, sizeof m, "%s{\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"rssi\":%d}", i ? "," : "",
             list.sta[i].mac[0], list.sta[i].mac[1], list.sta[i].mac[2], list.sta[i].mac[3],
             list.sta[i].mac[4], list.sta[i].mac[5], list.sta[i].rssi);
    j += m;
  }
  return j + "]}";
}

// =====================================================================
//                   port 80: esp_http_server (the API)
// =====================================================================
// Where the time went in the most recent transfer, for GET /admin/last and serial.
XferStats lastXfer;

void xferReport(XferStats &x) {
  float tot = x.totalUs / 1e6f;
  Serial.printf("[%s] %.2f MB in %.2f s = %.2f MB/s%s | SD read %.0f%% (%.2f s, worst chunk %.0f ms) | "
                "socket send %.0f%% (%.2f s, worst chunk %.0f ms) | %lu x %d KB chunks | dropped +%lu\n",
                x.what, x.bytes / 1e6, tot, tot > 0 ? x.bytes / 1e6 / tot : 0, x.ok ? "" : " (ABORTED)",
                x.totalUs ? 100.0 * x.sdUs / x.totalUs : 0, x.sdUs / 1e6, x.maxSdUs / 1e3,
                x.totalUs ? 100.0 * x.sendUs / x.totalUs : 0, x.sendUs / 1e6, x.maxSendUs / 1e3,
                (unsigned long)x.chunks, IO_BUF / 1024, (unsigned long)x.dropped);
}

String xferJson(const XferStats &x) {
  char b[320];
  snprintf(b, sizeof b,
           "{\"what\":\"%s\",\"bytes\":%llu,\"ok\":%s,\"total_ms\":%.1f,\"sd_ms\":%.1f,\"send_ms\":%.1f,"
           "\"max_sd_ms\":%.1f,\"max_send_ms\":%.1f,\"chunks\":%lu,\"dropped\":%lu}",
           x.what, (unsigned long long)x.bytes, x.ok ? "true" : "false", x.totalUs / 1e3, x.sdUs / 1e3,
           x.sendUs / 1e3, x.maxSdUs / 1e3, x.maxSendUs / 1e3, (unsigned long)x.chunks, (unsigned long)x.dropped);
  return String(b);
}

#define API_BUF (8 * 1024)                                  // :80 inline-path send buffer
httpd_handle_t api = nullptr;
uint8_t *apiOut;                                            // send buffer (httpd runs one handler at a time)
SegReader *apiReader;

static const char *statusLine(int code) {
  switch (code) {
    case 200: return "200 OK"; case 206: return "206 Partial Content";
    case 400: return "400 Bad Request"; case 404: return "404 Not Found";
    case 416: return "416 Range Not Satisfiable"; case 500: return "500 Internal Server Error";
    default:  return "503 Service Unavailable";
  }
}

static esp_err_t sendJson(httpd_req_t *req, int code, const String &body) {
  httpd_resp_set_status(req, statusLine(code));
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_send(req, body.c_str(), body.length());
}

static esp_err_t sendErr(httpd_req_t *req, int code, const char *err, const char *msg) {
  return sendJson(req, code, String("{\"error\":\"") + err + "\",\"message\":\"" + msg + "\"}");
}

static int errCode(const char *err) {
  if (!strcmp(err, "clip_not_found")) return 404;
  if (!strcmp(err, "not_ready")) return 503;
  return 500;
}

static bool sendAll(httpd_req_t *req, const uint8_t *b, size_t n) {
  while (n) {
    int k = httpd_send(req, (const char *)b, n);
    if (k <= 0) return false;
    b += k; n -= k;
  }
  return true;
}

static int queryInt(httpd_req_t *req, const char *key, int def) {
  char q[96], v[16];
  if (httpd_req_get_url_query_str(req, q, sizeof q) != ESP_OK) return def;
  if (httpd_query_key_value(q, key, v, sizeof v) != ESP_OK) return def;
  return atoi(v);
}

static esp_err_t hStatus(httpd_req_t *req) { return sendJson(req, 200, statusJson()); }

static esp_err_t hTime(httpd_req_t *req) {
  char body[128] = {0};
  int n = httpd_req_recv(req, body, min((size_t)req->content_len, sizeof body - 1));
  if (n <= 0) return sendErr(req, 400, "bad_request", "expected {\"unix_ms\": <number>}");
  long long unixMs = jnum(String(body), "unix_ms", 0);
  if (unixMs <= 0) return sendErr(req, 400, "bad_request", "unix_ms must be positive");
  clockOffsetMs = unixMs - esp_timer_get_time() / 1000;
  clockSet = true;
  struct timeval tv = { (time_t)(unixMs / 1000), (suseconds_t)((unixMs % 1000) * 1000) };
  settimeofday(&tv, nullptr);
  rtcClockSet = true;
  Serial.printf("clock set: %lld\n", unixMs);
  return sendJson(req, 200, statusJson());
}

static esp_err_t hClips(httpd_req_t *req) {
  std::vector<uint32_t> ids;
  File d = SD.open("/caps/clips");
  for (File f = d.openNextFile(); f; f = d.openNextFile()) {
    String name = f.name();
    if (name.startsWith("clip_") && name.endsWith(".json")) ids.push_back(name.substring(5, 9).toInt());
  }
  std::sort(ids.rbegin(), ids.rend());                      // newest first
  String j = "{\"clips\":[";
  bool first = true;
  uint32_t t0 = millis(), built = 0;
  for (uint32_t id : ids) {
    const char *err = "";
    ClipSummary sm;
    bool known = summaries.count(id);
    if (!getSummary(id, sm, &err)) continue;
    if (!known) built++;
    if (!first) j += ",";
    j += clipJson(sm);
    first = false;
  }
  j += "]}";
  Serial.printf("[httpd] listed %u clips in %lu ms (%lu not in RAM yet)\n",
                (unsigned)ids.size(), (unsigned long)(millis() - t0), (unsigned long)built);
  return sendJson(req, 200, j);
}

static esp_err_t serveClipWith(httpd_req_t *req, uint32_t id, uint8_t *out, size_t outCap, SegReader &rdr) {
  const char *err = "";
  auto c = getClip(id, &err);
  if (!c) return sendErr(req, errCode(err), err, "could not open clip");

  uint64_t size = c->bytes, start = 0, end = size - 1;
  bool partial = false;
  char rh[64];
  if (httpd_req_get_hdr_value_str(req, "Range", rh, sizeof rh) == ESP_OK) {
    unsigned long long a = 0, b = 0;
    int got = sscanf(rh, "bytes=%llu-%llu", &a, &b);
    if (got < 1) return sendErr(req, 400, "bad_request", "bad Range");
    if (a >= size) {
      char hdr[160];
      int hl = snprintf(hdr, sizeof hdr, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */%llu\r\nContent-Length: 0\r\n\r\n",
                        (unsigned long long)size);
      sendAll(req, (uint8_t *)hdr, hl);
      return ESP_OK;
    }
    start = a; end = (got == 2 && b < size) ? b : size - 1;
    partial = true;
  }
  uint64_t len = end - start + 1;

  // Raw response so Content-Length is exact and nothing is chunked.
  char hdr[320], cr[96] = "";
  if (partial) snprintf(cr, sizeof cr, "Content-Range: bytes %llu-%llu/%llu\r\n",
                        (unsigned long long)start, (unsigned long long)end, (unsigned long long)size);
  int hl = snprintf(hdr, sizeof hdr,
                    "HTTP/1.1 %s\r\nContent-Type: application/x-capsure-clip\r\nContent-Length: %llu\r\n"
                    "Accept-Ranges: bytes\r\n%s\r\n",
                    partial ? "206 Partial Content" : "200 OK", (unsigned long long)len, cr);
  if (!sendAll(req, (uint8_t *)hdr, hl)) return ESP_FAIL;

  XferStats x;
  snprintf(x.what, sizeof x.what, "httpd-sd %04lu", (unsigned long)id);
  uint32_t d0 = dropped;
  int64_t t0 = esp_timer_get_time();
  uint64_t off = start, left = len;
  x.ok = true;
  while (left) {
    if (captureStop) { x.ok = false; break; }                // shutting down
    size_t k = min((uint64_t)outCap, left);
    int64_t a = esp_timer_get_time();
    if (!clipRead(*c, off, out, k, rdr)) {
      Serial.printf("[%s] SD read failed at byte %llu (too many open files? card busy?)\n", x.what, (unsigned long long)off);
      x.ok = false; break;
    }
    int64_t b = esp_timer_get_time();
    if (!sendAll(req, out, k)) { x.ok = false; break; }
    int64_t e = esp_timer_get_time();
    x.sdUs += b - a; x.sendUs += e - b;
    x.maxSdUs = max(x.maxSdUs, b - a); x.maxSendUs = max(x.maxSendUs, e - b);
    x.chunks++; x.bytes += k;
    off += k; left -= k;
  }
  rdr.close();
  x.totalUs = esp_timer_get_time() - t0;
  x.dropped = dropped - d0;
  xferReport(x);
  lastXfer = x;
  return x.ok ? ESP_OK : ESP_FAIL;
}

static esp_err_t serveFile(httpd_req_t *req, const String &path, const char *type) {
  File f = SD.open(path);
  if (!f) return sendErr(req, 404, "clip_not_found", "no such file");
  size_t n = f.size();
  uint8_t *b = (uint8_t *)ps_malloc(n ? n : 1);
  if (!b) { f.close(); return sendErr(req, 500, "storage_error", "out of memory"); }
  size_t got = f.read(b, n); f.close();
  httpd_resp_set_type(req, type);
  esp_err_t e = httpd_resp_send(req, (const char *)b, got);
  free(b);
  return e;
}

// /api/clips/{id}, /api/clips/{id}/ack, /api/clips/{id}/thumb
static bool parseClipUri(const char *uri, uint32_t *id, String *suffix) {
  const char *p = uri + strlen("/api/clips/");
  char digits[16]; int n = 0;
  while (*p >= '0' && *p <= '9' && n < 15) digits[n++] = *p++;
  digits[n] = 0;
  if (!n) return false;
  *id = atoi(digits);
  String rest(p);
  int q = rest.indexOf('?'); if (q >= 0) rest = rest.substring(0, q);
  *suffix = rest;
  return true;
}

static esp_err_t serveClip(httpd_req_t *req, uint32_t id) {
  return serveClipWith(req, id, apiOut, API_BUF, *apiReader);
}

// ---- parallel clip downloads ----
// esp_http_server runs one handler at a time. A clip body is handed to a
// worker task instead (httpd's async-request API), so the server goes back to
// accepting connections and up to XFER_WORKERS downloads run at once. Each TCP
// connection has its own 5.7 KB send buffer, so N connections put N times as
// much data in flight.
#define XFER_WORKERS 4
#define WORKER_OUT   (8 * 1024)       // send buffer per worker (internal RAM)
#define WORKER_RDR   (4 * 1024)       // SD read buffer per worker (internal RAM)
QueueHandle_t xferQ = nullptr;
volatile int xferActive = 0;

void xferWorker(void *) {
  uint8_t *out = (uint8_t *)heap_caps_malloc(WORKER_OUT, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  SegReader rdr(WORKER_RDR);
  for (;;) {
    XferJob j;
    xQueueReceive(xferQ, &j, portMAX_DELAY);
    xferActive++;
    esp_err_t r = serveClipWith(j.req, j.id, out, WORKER_OUT, rdr);
    xferActive--;
    if (r != ESP_OK) {
      // The header promised Content-Length bytes; if we stop short, the phone
      // would wait for the rest until it times out. Reset the connection so it
      // fails immediately and the app retries that chunk.
      int fd = httpd_req_to_sockfd(j.req);
      shutdown(fd, SHUT_RDWR);
      httpd_sess_trigger_close(api, fd);
    }
    httpd_req_async_handler_complete(j.req);
  }
}

static esp_err_t hClipGet(httpd_req_t *req) {
  uint32_t id; String sfx;
  if (!parseClipUri(req->uri, &id, &sfx)) return sendErr(req, 400, "bad_request", "bad clip id");
  if (sfx == "") {
    httpd_req_t *copy = nullptr;
    if (xferQ && uxQueueSpacesAvailable(xferQ) > 0 && httpd_req_async_handler_begin(req, &copy) == ESP_OK) {
      XferJob j = {copy, id};
      if (xQueueSend(xferQ, &j, 0) == pdTRUE) return ESP_OK;
      esp_err_t e = serveClip(copy, id);                       // queue filled up in between: serve it here
      httpd_req_async_handler_complete(copy);
      return e;
    }
    return serveClip(req, id);
  }
  if (sfx == "/thumb") return serveFile(req, clipPath(id, "jpg"), "image/jpeg");
  return sendErr(req, 404, "bad_request", "no such endpoint");
}

static esp_err_t hClipPost(httpd_req_t *req) {
  uint32_t id; String sfx;
  if (!parseClipUri(req->uri, &id, &sfx) || sfx != "/ack") return sendErr(req, 404, "bad_request", "no such endpoint");
  const char *err = "";
  ClipSummary sm;
  if (!getSummary(id, sm, &err)) return sendErr(req, errCode(err), err, "no such clip");
  File f = SD.open(clipPath(id, "ack"), FILE_WRITE); if (f) f.close();
  return sendJson(req, 200, clipJson(sm));
}

static esp_err_t hClipDelete(httpd_req_t *req) {
  uint32_t id; String sfx;
  if (!parseClipUri(req->uri, &id, &sfx) || sfx != "") return sendErr(req, 404, "bad_request", "no such endpoint");
  WCmd *c = new WCmd{id, xSemaphoreCreateBinary(), false};
  xQueueSend(cmdQ, &c, portMAX_DELAY);
  if (xSemaphoreTake(c->done, pdMS_TO_TICKS(3000)) != pdTRUE)
    return sendErr(req, 503, "busy", "writer did not answer");  // leak c on purpose: writer may still use it
  bool ok = c->ok;
  vSemaphoreDelete(c->done); delete c;
  dropClip(id);
  if (!ok) return sendErr(req, 404, "clip_not_found", "no such clip");
  char b[48]; snprintf(b, sizeof b, "{\"deleted\":\"%04lu\"}", (unsigned long)id);
  return sendJson(req, 200, String(b));
}

static esp_err_t hPreview(httpd_req_t *req) {
  xSemaphoreTake(previewReady, 0);                          // clear a stale give
  previewWant = true;
  if (xSemaphoreTake(previewReady, pdMS_TO_TICKS(1500)) != pdTRUE) {
    previewWant = false;
    return sendErr(req, 503, "not_ready", "no frame from the camera");
  }
  httpd_resp_set_type(req, "image/jpeg");
  return httpd_resp_send(req, (const char *)previewBuf, previewLen);
}

// GET /bench/ram?mb=8 : N MB from RAM, same raw-send path as clips
static esp_err_t hBenchRam(httpd_req_t *req) {
  int mb = constrain(queryInt(req, "mb", 8), 1, 64);
  uint64_t total = (uint64_t)mb * 1024 * 1024;
  char hdr[160];
  int hl = snprintf(hdr, sizeof hdr, "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %llu\r\n\r\n",
                    (unsigned long long)total);
  if (!sendAll(req, (uint8_t *)hdr, hl)) return ESP_FAIL;
  XferStats x;
  strcpy(x.what, "httpd-ram");
  uint32_t d0 = dropped;
  int64_t t0 = esp_timer_get_time();
  x.ok = true;
  for (uint64_t left = total; left;) {
    size_t k = min((uint64_t)API_BUF, left);
    int64_t b = esp_timer_get_time();
    if (!sendAll(req, apiOut, k)) { x.ok = false; break; }
    int64_t e = esp_timer_get_time();
    x.sendUs += e - b; x.maxSendUs = max(x.maxSendUs, e - b);
    x.chunks++; x.bytes += k; left -= k;
  }
  x.totalUs = esp_timer_get_time() - t0;
  x.dropped = dropped - d0;
  xferReport(x);
  lastXfer = x;
  return x.ok ? ESP_OK : ESP_FAIL;
}

// GET /bench/sd?id=5&mb=8 : read N MB of a clip off the SD card and send nothing.
// SD speed with the recorder running, with Wi-Fi out of the picture.
static esp_err_t hBenchSd(httpd_req_t *req) {
  int id = queryInt(req, "id", -1), mb = constrain(queryInt(req, "mb", 8), 1, 64);
  const char *err = "";
  auto c = getClip(id, &err);
  if (!c) return sendErr(req, errCode(err), err, "no such clip (pass ?id=)");
  uint64_t want = min((uint64_t)mb * 1024 * 1024, c->bytes);
  XferStats x;
  snprintf(x.what, sizeof x.what, "sd-read %04d", id);
  uint32_t d0 = dropped;
  int64_t t0 = esp_timer_get_time();
  x.ok = true;
  for (uint64_t off = 0; off < want;) {
    if (captureStop) { x.ok = false; break; }                // shutting down
    size_t k = min((uint64_t)API_BUF, want - off);
    int64_t a = esp_timer_get_time();
    if (!clipRead(*c, off, apiOut, k, *apiReader)) { x.ok = false; break; }
    int64_t b = esp_timer_get_time();
    x.sdUs += b - a; x.maxSdUs = max(x.maxSdUs, b - a);
    x.chunks++; x.bytes += k; off += k;
  }
  apiReader->close();
  x.totalUs = esp_timer_get_time() - t0;
  x.dropped = dropped - d0;
  xferReport(x);
  lastXfer = x;
  return sendJson(req, 200, xferJson(x));
}

// GET /admin/camera                       -> current settings
// GET /admin/camera?contrast=2&brightness=-1&saturation=2&ae=0&sensor=1
//   Changes take effect on the next frame; grab /api/preview to see them and
//   /admin/table for the green %. Copy the values you like into CAM_* above.
static esp_err_t hCamera(httpd_req_t *req) {
  auto clampStep = [](int v) { return v < -2 ? -2 : v > 2 ? 2 : v; };
  const int NONE = -99;
  int v;
  if ((v = queryInt(req, "brightness", NONE)) != NONE) camBrightness = clampStep(v);
  if ((v = queryInt(req, "contrast", NONE)) != NONE) camContrast = clampStep(v);
  if ((v = queryInt(req, "saturation", NONE)) != NONE) camSaturation = clampStep(v);
  if ((v = queryInt(req, "ae", NONE)) != NONE) camAe = clampStep(v);
  if ((v = queryInt(req, "sensor", NONE)) != NONE) sensorColor = v != 0;
  applyCameraTuning();
  char b[200];
  snprintf(b, sizeof b, "{\"sensor\":%s,\"brightness\":%d,\"contrast\":%d,\"saturation\":%d,\"ae\":%d,"
           "\"green_pct\":%.1f,\"table\":%s}", sensorColor ? "true" : "false", camBrightness, camContrast,
           camSaturation, camAe, greenPermille / 10.0, tableDetected ? "true" : "false");
  return sendJson(req, 200, String(b));
}

static esp_err_t hTable(httpd_req_t *req) {
  char b[200];
  snprintf(b, sizeof b, "{\"detected\":%s,\"green_pct\":%.1f,\"decode_ms\":%lu,\"checks\":%lu,"
           "\"on_pct\":%d,\"off_pct\":%d}", tableDetected ? "true" : "false", greenPermille / 10.0,
           (unsigned long)detectMs, (unsigned long)detectChecks, GREEN_ON_PCT, GREEN_OFF_PCT);
  return sendJson(req, 200, String(b));
}

static esp_err_t hLast(httpd_req_t *req) { return sendJson(req, 200, xferJson(lastXfer)); }

static esp_err_t hRadioGet(httpd_req_t *req) { return sendJson(req, 200, radioJson()); }

// POST /admin/radio?ch=11&bw=40 : reply, then restart the AP on that channel
static esp_err_t hRadioSet(httpd_req_t *req) {
  int ch = queryInt(req, "ch", -1), bw = queryInt(req, "bw", 20);
  if (ch < 1 || ch > 13 || (bw != 20 && bw != 40)) return sendErr(req, 400, "bad_request", "ch 1-13, bw 20|40");
  reqChannel = ch; reqBw = bw;
  esp_err_t e = sendJson(req, 200, "{\"ok\":true,\"channel\":" + String(ch) + ",\"bw\":" + String(bw) + "}");
  xTaskCreatePinnedToCore(radioTask, "radio", 4096, nullptr, 3, nullptr, 0);
  return e;
}

void requestSave(int64_t T);
static esp_err_t hSave(httpd_req_t *req) {
  requestSave(esp_timer_get_time());
  return sendJson(req, 200, "{\"ok\":true,\"note\":\"clip appears in /api/clips in ~2-3 s\"}");
}

static void regUri(const char *uri, httpd_method_t m, HandlerFn h) {
  httpd_uri_t u = {};
  u.uri = uri; u.method = m; u.handler = h; u.user_ctx = nullptr;
  httpd_register_uri_handler(api, &u);
}

void startApi() {
  apiOut = (uint8_t *)heap_caps_malloc(API_BUF, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  memset(apiOut, 0xA5, API_BUF);
  apiReader = new SegReader(4 * 1024);

  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = 80;
  cfg.ctrl_port = 32768;
  cfg.core_id = 0;                                          // radio core
  cfg.stack_size = 8192;
  cfg.max_uri_handlers = 20;
  cfg.lru_purge_enable = true;
  cfg.send_wait_timeout = 10;
  cfg.recv_wait_timeout = 10;
  cfg.uri_match_fn = httpd_uri_match_wildcard;
  cfg.max_open_sockets = 8;                                  // 4 parallel downloads + status/listing
  if (httpd_start(&api, &cfg) != ESP_OK) { Serial.println("httpd start FAILED"); return; }
  xferQ = xQueueCreate(XFER_WORKERS * 2, sizeof(XferJob));
  for (int i = 0; i < XFER_WORKERS; i++) {
    char name[12]; snprintf(name, sizeof name, "xfer%d", i);
    xTaskCreatePinnedToCore(xferWorker, name, 6144, nullptr, 5, nullptr, 0);   // radio core, same prio as httpd
  }
  Serial.printf("clip downloads: %d parallel workers\n", XFER_WORKERS);

  regUri("/api/status", HTTP_GET, hStatus);
  regUri("/status", HTTP_GET, hStatus);                        // alias for the app's Wi-Fi test screen
  regUri("/api/time", HTTP_POST, hTime);
  regUri("/api/clips", HTTP_GET, hClips);
  regUri("/api/clips/*", HTTP_GET, hClipGet);
  regUri("/api/clips/*", HTTP_POST, hClipPost);
  regUri("/api/clips/*", HTTP_DELETE, hClipDelete);
  regUri("/api/preview", HTTP_GET, hPreview);
  regUri("/bench/ram", HTTP_GET, hBenchRam);
  regUri("/bench", HTTP_GET, hBenchRam);                       // alias for the app's Wi-Fi test screen
  regUri("/admin/radio", HTTP_GET, hRadioGet);
  regUri("/admin/radio", HTTP_POST, hRadioSet);
  regUri("/admin/save", HTTP_POST, hSave);
  regUri("/admin/last", HTTP_GET, hLast);
  regUri("/admin/table", HTTP_GET, hTable);
  regUri("/admin/camera", HTTP_GET, hCamera);
  regUri("/bench/sd", HTTP_GET, hBenchSd);
  Serial.println("httpd on :80");
}

// =====================================================================
//             port 8080: Arduino WebServer (comparison only)
// =====================================================================
WebServer web(8080);
uint8_t *webOut;
SegReader *webReader;

// write everything or give up; returns false if the client went away
static bool webWriteAll(WiFiClient &cl, const uint8_t *b, size_t n) {
  int64_t start = esp_timer_get_time();
  while (n && cl.connected()) {
    size_t k = cl.write(b, n);
    if (!k) {
      if (esp_timer_get_time() - start > 10000000) return false;   // 10 s with no progress
      delay(1); continue;
    }
    b += k; n -= k; start = esp_timer_get_time();
  }
  return n == 0;
}

void webRam() {
  int mb = web.hasArg("mb") ? constrain((int)web.arg("mb").toInt(), 1, 64) : 8;
  size_t total = (size_t)mb * 1024 * 1024;
  web.setContentLength(total);
  web.send(200, "application/octet-stream", "");
  WiFiClient cl = web.client();
  XferStats x;
  strcpy(x.what, "web-ram");
  uint32_t d0 = dropped;
  int64_t t0 = esp_timer_get_time();
  x.ok = true;
  for (size_t sent = 0; sent < total;) {
    size_t k = min((size_t)IO_BUF, total - sent);
    int64_t b = esp_timer_get_time();
    if (!webWriteAll(cl, webOut, k)) { x.ok = false; break; }
    int64_t e = esp_timer_get_time();
    x.sendUs += e - b; x.maxSendUs = max(x.maxSendUs, e - b);
    x.chunks++; x.bytes += k; sent += k;
  }
  x.totalUs = esp_timer_get_time() - t0;
  x.dropped = dropped - d0;
  xferReport(x);
  lastXfer = x;
}

// GET /clip?id=5[&mb=8] : the clip (or its first N MB) off the SD card
void webClip() {
  const char *err = "";
  auto c = getClip(web.arg("id").toInt(), &err);
  if (!c) { web.send(404, "application/json", "{\"error\":\"clip_not_found\",\"message\":\"no such clip\"}"); return; }
  uint64_t want = c->bytes;
  if (web.hasArg("mb")) want = min(want, (uint64_t)constrain((int)web.arg("mb").toInt(), 1, 512) * 1024 * 1024);
  web.setContentLength(want);
  web.send(200, "application/x-capsure-clip", "");
  WiFiClient cl = web.client();
  XferStats x;
  snprintf(x.what, sizeof x.what, "web-sd %04lu", (unsigned long)c->id);
  uint32_t d0 = dropped;
  int64_t t0 = esp_timer_get_time();
  x.ok = true;
  for (uint64_t off = 0; off < want;) {
    if (captureStop) { x.ok = false; break; }                // shutting down
    size_t k = min((uint64_t)IO_BUF, want - off);
    int64_t a = esp_timer_get_time();
    if (!clipRead(*c, off, webOut, k, *webReader)) { x.ok = false; break; }
    int64_t b = esp_timer_get_time();
    if (!webWriteAll(cl, webOut, k)) { x.ok = false; break; }
    int64_t e = esp_timer_get_time();
    x.sdUs += b - a; x.sendUs += e - b;
    x.maxSdUs = max(x.maxSdUs, b - a); x.maxSendUs = max(x.maxSendUs, e - b);
    x.chunks++; x.bytes += k; off += k;
  }
  webReader->close();
  x.totalUs = esp_timer_get_time() - t0;
  x.dropped = dropped - d0;
  xferReport(x);
  lastXfer = x;
}

void webTask(void *) {
  for (;;) { web.handleClient(); vTaskDelay(1); }
}

void startWeb() {
  webOut = (uint8_t *)heap_caps_malloc(IO_BUF, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  memset(webOut, 0x5A, IO_BUF);
  webReader = new SegReader();
  web.on("/ram", HTTP_GET, webRam);
  web.on("/clip", HTTP_GET, webClip);
  web.begin();
  xTaskCreatePinnedToCore(webTask, "web8080", 8192, nullptr, 4, nullptr, 0);
  Serial.println("WebServer on :8080");
}

// ------------------------- setup / loop -------------------------
void IRAM_ATTR onSaveButton() { btnT = esp_timer_get_time(); btnFlag = true; btnIrqs++; }

void requestSave(int64_t T) {
  portENTER_CRITICAL(&saveMux);
  if (nPending < 8) pendingT[nPending++] = T;
  portEXIT_CRITICAL(&saveMux);
  Serial.printf(">>> Save requested at t=%.2f s (clip finalizes in ~2 s) | table %s, green %.1f%%\n",
                T / 1e6, tableDetected ? "DETECTED" : "not detected", greenPermille / 10.0);
}

// Build-time network settings. These are baked into the Arduino core's
// precompiled libraries; small TCP buffers cap throughput no matter the radio.
void printNetConfig() {
  Serial.println("---- network build config ----");
#ifdef CONFIG_LWIP_TCP_SND_BUF_DEFAULT
  Serial.printf("  TCP send buffer (TCP_SND_BUF)     %d bytes\n", CONFIG_LWIP_TCP_SND_BUF_DEFAULT);
#endif
#ifdef CONFIG_LWIP_TCP_WND_DEFAULT
  Serial.printf("  TCP receive window (TCP_WND)      %d bytes\n", CONFIG_LWIP_TCP_WND_DEFAULT);
#endif
#ifdef CONFIG_LWIP_TCP_MSS
  Serial.printf("  TCP MSS                           %d bytes\n", CONFIG_LWIP_TCP_MSS);
#endif
#ifdef CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM
  Serial.printf("  Wi-Fi static RX buffers           %d\n", CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM);
#endif
#ifdef CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM
  Serial.printf("  Wi-Fi dynamic RX buffers          %d\n", CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM);
#endif
#ifdef CONFIG_ESP_WIFI_DYNAMIC_TX_BUFFER_NUM
  Serial.printf("  Wi-Fi dynamic TX buffers          %d\n", CONFIG_ESP_WIFI_DYNAMIC_TX_BUFFER_NUM);
#endif
#ifdef CONFIG_ESP_WIFI_AMPDU_TX_ENABLED
  Serial.println("  Wi-Fi AMPDU TX                    enabled");
#else
  Serial.println("  Wi-Fi AMPDU TX                    disabled");
#endif
#ifdef CONFIG_ESP_WIFI_TX_BA_WIN
  Serial.printf("  Wi-Fi TX block-ack window         %d\n", CONFIG_ESP_WIFI_TX_BA_WIN);
#endif
#ifdef CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP
  Serial.println("  Wi-Fi/lwIP buffers in PSRAM       yes (slower)");
#endif
  Serial.printf("  CPU %lu MHz, PSRAM %u KB\n", (unsigned long)getCpuFrequencyMhz(), (unsigned)(ESP.getPsramSize() / 1024));
  Serial.printf("  camera target %d fps, SD/socket chunk %d KB\n", TARGET_FPS, IO_BUF / 1024);
  Serial.println("------------------------------");
}

// AP follows the Wi-Fi switch. Servers start the first time the AP comes up
// and stay registered after; turning the radio off just stops the AP.
bool apOn = false, serversStarted = false;

void apStart() {
  WiFi.mode(WIFI_AP);
  applyRadio(reqChannel, reqBw);
  Serial.print(">>> Wi-Fi ON, AP up, IP: "); Serial.println(WiFi.softAPIP());
  if (!serversStarted) { startApi(); if (ENABLE_WEB8080) startWeb(); serversStarted = true; }
  apOn = true;
}

void apStop() {
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);
  Serial.println(">>> Wi-Fi OFF (radio powered down)");
  apOn = false;
}

// 'x' on serial. Each step makes sure nothing is still writing before the
// next runs, so the card is never unmounted mid-write.
void safeShutdown() {
  Serial.println(">>> Shutting down safely...");

  // 1. A save needs ~200 ms of footage after the press plus a segment boundary
  //    (up to ~2 s), so keep recording until any pending save is written.
  uint32_t t0 = millis();
  int pending;
  for (;;) {
    portENTER_CRITICAL(&saveMux); pending = nPending; portEXIT_CRITICAL(&saveMux);
    if (!pending || millis() - t0 > 5000) break;
    delay(50);
  }
  if (pending) Serial.printf("    WARNING: %d save(s) did not finish in 5 s and are lost\n", pending);
  else Serial.println("    1/5 no saves pending");

  // 2. Stop camera, mic and detector; frames already captured still reach the queue.
  captureStop = true;
  delay(300);
  Serial.println("    2/5 camera + mic stopped");

  // 3. Writer empties the queue and closes the open segment.
  writerStop = true;
  t0 = millis();
  while (!writerDone && millis() - t0 < 10000) delay(20);
  Serial.printf("    3/5 %s (%lu dropped frames this session)\n",
                writerDone ? "all buffered footage written, segment closed" : "WARNING: writer did not finish in 10 s",
                (unsigned long)dropped);

  // 4. Network off. Running transfers saw captureStop and stopped reading SD.
  if (serversStarted) { httpd_stop(api); if (ENABLE_WEB8080) web.stop(); }
  delay(200);
  if (apOn) apStop();
  Serial.println("    4/5 servers and Wi-Fi off");

  // 5. Card unmounted, LED off.
  SD.end();
  digitalWrite(LED_PIN, LOW);
  Serial.println("    5/5 SD card unmounted");

  // Deep sleep: nothing runs. The save button (D0 = GPIO1, an RTC pin) wakes
  // it by pulling LOW; waking is a fresh boot, so recording starts again.
  Serial.println(">>> SAFE TO UNPLUG. Or press the save button to wake and start recording again.");
  Serial.println("    (USB serial disconnects while asleep; re-open the Serial Monitor after waking.)");
  Serial.flush();
  while (digitalRead(SAVE_PIN) == LOW) delay(10);            // don't wake straight away if it's held
  delay(50);
  rtc_gpio_pullup_en((gpio_num_t)SAVE_PIN);
  rtc_gpio_pulldown_dis((gpio_num_t)SAVE_PIN);
  esp_sleep_enable_ext0_wakeup((gpio_num_t)SAVE_PIN, 0);
  esp_deep_sleep_start();
}

bool wifiSwitchOn() { return !WIFI_SWITCH_ENABLED || digitalRead(WIFI_SW_PIN) == LOW; }

// Push the color settings to the OV2640. With sensorColor off, everything
// goes back to neutral and correction happens in software instead.
void applyCameraTuning() {
  sensor_t *s = esp_camera_sensor_get();
  if (!s) return;
  bool on = sensorColor;
  s->set_brightness(s, on ? camBrightness : 0);
  s->set_contrast(s, on ? camContrast : 0);
  s->set_saturation(s, on ? camSaturation : 0);
  s->set_ae_level(s, on ? camAe : 0);
  s->set_gainceiling(s, on ? CAM_GAINCEILING : GAINCEILING_2X);
  s->set_whitebal(s, 1); s->set_awb_gain(s, 1); s->set_wb_mode(s, 0);
  s->set_raw_gma(s, 1); s->set_lenc(s, 1);
  Serial.printf("camera color: %s (brightness %d, contrast %d, saturation %d, ae %d)\n",
                on ? "corrected on the sensor" : "raw (software correction)",
                camBrightness, camContrast, camSaturation, camAe);
}

void fail(const char *msg) { for (;;) { Serial.println(msg); delay(3000); } }

void setup() {
  Serial.begin(115200); delay(2000);
  pinMode(LED_PIN, OUTPUT); digitalWrite(LED_PIN, LOW);
  pinMode(SAVE_PIN, INPUT_PULLUP);
  pinMode(WIFI_SW_PIN, INPUT_PULLUP);
  // SHUTDOWN_PIN / PWR_HOLD_PIN: reserved, intentionally not configured yet
  crcInit();
  bootId = esp_random();
  // Waking from deep sleep: the RTC kept time, so the clock is still right.
  if (rtcClockSet && esp_sleep_get_wakeup_cause() != ESP_SLEEP_WAKEUP_UNDEFINED) {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    int64_t nowMs = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
    if (nowMs > 1700000000000LL) {
      clockOffsetMs = nowMs - esp_timer_get_time() / 1000;
      clockSet = true;
      Serial.println("clock kept through deep sleep");
    }
  }

  SPI.begin(7, 8, 9, 21);
  // A card interrupted mid-write (e.g. by a re-upload) can refuse the first try,
  // and some cards are flaky at 40 MHz over SPI. Retry, slowing down each time.
  const uint32_t sdHz[] = {40000000, 20000000, 10000000, 4000000};
  bool sdOk = false;
  for (int attempt = 0; attempt < 8 && !sdOk; attempt++) {
    uint32_t hz = sdHz[min(attempt / 2, 3)];
    // max_files: the library default is 5, and the recorder (1) + each
    // download worker (1 each) + indexing/thumbs/acks all hold files open.
    sdOk = SD.begin(21, SPI, hz, "/sd", SD_MAX_FILES);
    Serial.printf("SD mount at %lu MHz: %s\n", (unsigned long)(hz / 1000000), sdOk ? "OK" : "failed");
    if (!sdOk) { SD.end(); delay(300); }
  }
  if (!sdOk) fail("SD mount FAILED: power-cycle the board (unplug USB) and reseat the card");
  const char *types[] = {"none", "MMC", "SD", "SDHC/SDXC", "unknown"};
  uint8_t ct = SD.cardType();
  Serial.printf("SD card: %s, %llu MB\n", types[min((int)ct, 4)], SD.cardSize() / (1024ULL * 1024));
  Serial.printf("[heap] after SD mount: %u internal free\n", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
  wbuf = (uint8_t *)malloc(WBUF_SIZE);
  curIdx.reserve(256);
  recoverCard();
  storageTotalMb = SD.totalBytes() / (1024 * 1024);
  storageFreeMb = (SD.totalBytes() - SD.usedBytes()) / (1024 * 1024);

  camera_config_t c = {};
  c.pin_pwdn = -1; c.pin_reset = -1; c.pin_xclk = 10;
  c.pin_sccb_sda = 40; c.pin_sccb_scl = 39;
  c.pin_d7 = 48; c.pin_d6 = 11; c.pin_d5 = 12; c.pin_d4 = 14;
  c.pin_d3 = 16; c.pin_d2 = 18; c.pin_d1 = 17; c.pin_d0 = 15;
  c.pin_vsync = 38; c.pin_href = 47; c.pin_pclk = 13;
  c.xclk_freq_hz = 20000000;
  c.ledc_timer = LEDC_TIMER_0; c.ledc_channel = LEDC_CHANNEL_0;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_XGA;
  c.jpeg_quality = 12; c.fb_count = 3;
  c.fb_location = CAMERA_FB_IN_PSRAM; c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  if (esp_camera_init(&c) != ESP_OK) fail("Camera init FAILED");
  Serial.printf("[heap] after camera init: %u internal free\n", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
  sensor_t *s = esp_camera_sensor_get();
  s->set_framesize(s, FRAMESIZE_VGA);
  // Mounted upside down: rotate 180 degrees on the sensor (free; also fixes
  // preview, thumbnails and the detector). If text looks mirrored afterwards,
  // set CAM_HMIRROR to 0.
  s->set_vflip(s, CAM_VFLIP);
  s->set_hmirror(s, CAM_HMIRROR);
  applyCameraTuning();

  i2s.setPinsPdmRx(42, 41);
  if (!i2s.begin(I2S_MODE_PDM_RX, AUDIO_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) fail("I2S init FAILED");

  previewBuf = (uint8_t *)ps_malloc(PREVIEW_MAX);
  previewReady = xSemaphoreCreateBinary();
  detBuf = (uint8_t *)ps_malloc(PREVIEW_MAX);
  det565 = (uint8_t *)ps_malloc(DET_W * DET_H * 2);                   // 9.6 KB; CPU-only, PSRAM is fine
  detReady = xSemaphoreCreateBinary();
  calibrateDecoder();
  ccInit();
  idxMux = xSemaphoreCreateMutex();
  cmdQ = xQueueCreate(4, sizeof(WCmd *));
  pktQ = xQueueCreate(1024, sizeof(Packet *));
  xTaskCreatePinnedToCore(writerTask, "writer", 8192, nullptr, 5, nullptr, WRITER_CORE);
  xTaskCreatePinnedToCore(audioTask,  "audio",  4096, nullptr, 7, nullptr, 1);
  xTaskCreatePinnedToCore(cameraTask, "camera", 4096, nullptr, 6, nullptr, 1);
  xTaskCreatePinnedToCore(detectTask, "detect", 8192, nullptr, 2, nullptr, 0);   // radio core, low priority

  attachInterrupt(digitalPinToInterrupt(SAVE_PIN), onSaveButton, FALLING);
  digitalWrite(LED_PIN, recordingActive ? HIGH : LOW);
  if (TABLE_GATES_RECORDING) Serial.println("Waiting for the pool table: recording starts (LED on) when green fills >= 10% of the frame");

  if (wifiSwitchOn()) apStart();
  else Serial.println("Wi-Fi switch is OFF (D1 high): AP stays down until D1 goes to GND");

  printNetConfig();
  Serial.printf("free internal heap %u, free PSRAM %u\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)ESP.getFreePsram());
  Serial.printf("Pins: save button D0, LED D4, Wi-Fi switch D1 (%s)\n",
                WIFI_SWITCH_ENABLED ? "LOW = on" : "ignored, AP always on");
  Serial.println("Recording. Serial: s = save, l = list clips, x = safe shutdown, b = button debug, d = detection on/off, h = heap, g = toggle per-check green output, t = table status");
}

void loop() {
  static int64_t lastBtn = 0;
  if (btnFlag) {
    btnFlag = false;
    // Still LOW when we look (<= 10 ms later): a real press, not a spike on a breadboard wire.
    // The 500 ms lockout swallows contact bounce.
    bool still = digitalRead(SAVE_PIN) == LOW, locked = btnT - lastBtn <= 500000;
    if (still && !locked) { lastBtn = btnT; requestSave(btnT); ledFeedback = 1; }
    else if (btnDebug) Serial.printf("button: interrupt ignored (%s)\n",
                                     !still ? "pin was already HIGH again: noise or a very short tap" : "within 500 ms of the last press");
  }
  if (btnDebug) {                                            // raw pin level, printed on every change
    static int lastLevel = -1; static uint32_t lastIrqs = 0;
    int level = digitalRead(SAVE_PIN);
    if (level != lastLevel || btnIrqs != lastIrqs) {
      Serial.printf("button: D0 reads %s | interrupts so far %lu\n",
                    level == LOW ? "LOW (pressed)" : "HIGH (released)", (unsigned long)btnIrqs);
      lastLevel = level; lastIrqs = btnIrqs;
    }
  }
  // LED blinks without blocking: each blink flips the LED away from its
  // normal state (on = recording, off = paused) for 120 ms and back.
  static int blinkLeft = 0; static uint32_t blinkAt = 0;
  if (ledFeedback) { blinkLeft += 2 * ledFeedback; ledFeedback = 0; }
  if (blinkLeft > 0 && (int32_t)(millis() - blinkAt) >= 0) {
    blinkLeft--;
    bool base = recordingActive;
    digitalWrite(LED_PIN, (blinkLeft % 2) ? !base : base);
    blinkAt = millis() + 120;
  }

  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == 'x') safeShutdown();                           // does not return
    if (ch == 's') requestSave(esp_timer_get_time());
    if (ch == 'l') listReq = true;
    if (ch == 'b') { btnDebug = !btnDebug; Serial.printf("button debug %s (D0 = GPIO%d, now %s)\n", btnDebug ? "ON" : "OFF",
                                                       (int)SAVE_PIN, digitalRead(SAVE_PIN) == LOW ? "LOW" : "HIGH"); }
    if (ch == 'd') {
      detEnabled = !detEnabled;
      Serial.printf("table detection %s\n", detEnabled ? "ON" : "OFF");
      if (!detEnabled) setRecording(true, "detection off, recording everything");
      else if (TABLE_GATES_RECORDING && !tableDetected) setRecording(false, "detection back on, waiting for the table");
    }
    if (ch == 'h') Serial.printf("free internal heap %u (largest block %u), free PSRAM %u\n",
                                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL), (unsigned)ESP.getFreePsram());
    if (ch == 'g') { detVerbose = !detVerbose; Serial.printf("per-check green output %s\n", detVerbose ? "ON" : "OFF"); }
    if (ch == 't') Serial.printf("table %s, green %.1f%%, decode %lu ms, %lu checks\n",
                                 tableDetected ? "DETECTED" : "not detected", greenPermille / 10.0,
                                 (unsigned long)detectMs, (unsigned long)detectChecks);
  }

  // Wi-Fi switch: act after 3 matching reads 50 ms apart (debounce)
  static uint32_t lastSw = 0; static int swCount = 0;
  if (millis() - lastSw >= 50) {
    lastSw = millis();
    bool on = wifiSwitchOn();
    if (on != apOn) { if (++swCount >= 3) { swCount = 0; on ? apStart() : apStop(); } }
    else swCount = 0;
  }

  // buffer_healthy = no drops in the last 60 s (12 x 5 s samples)
  static uint32_t dropHist[12] = {0}; static int hi = 0;
  static uint32_t lastPrint = 0, lastF = 0, lastA = 0, lastStorage = 0;
  if (millis() - lastPrint >= 5000) {
    uint32_t f = framesCaptured, a = audioBlocks, d = dropped;
    bufferHealthy = (d == dropHist[hi]);
    dropHist[hi] = d; hi = (hi + 1) % 12;
    Serial.printf("fps %.1f | audio %.0f blk/s | queue peak %u KB | dropped %lu | worst write %lu ms | rolling %d segs | errors %lu | table %s (green %.1f%%) | %s | wifi %s\n",
                  (f - lastF) / 5.0, (a - lastA) / 5.0, (unsigned)(peakQueued / 1024),
                  (unsigned long)d, (unsigned long)worstWrite, unprotCount, (unsigned long)writeErrors,
                  tableDetected ? "YES" : "no", greenPermille / 10.0, recordingActive ? "REC" : "paused", apOn ? "on" : "off");
    lastF = f; lastA = a; lastPrint = millis(); worstWrite = 0;
  }
  if (millis() - lastStorage >= 30000) {                    // f_getfree can be slow; keep it off the hot paths
    storageFreeMb = (SD.totalBytes() - SD.usedBytes()) / (1024 * 1024);
    lastStorage = millis();
  }
  delay(10);
}
