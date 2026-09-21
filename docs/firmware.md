# CapSure Firmware Guide

**Owner: Ankita.** This is a proposed setup, not a decree — if you disagree with a
choice here, say so and we change it. The one thing that is not negotiable is
[`docs/api.md`](./api.md), because Jayden's app is being built against it right now.

---

## 1. Toolchain

**Recommendation: PlatformIO + Arduino framework, in VS Code or Cursor.**

You will see two options online for ESP32-S3 work:

- **ESP-IDF** — Espressif's native SDK. Full control, better documentation for the
  low-level camera/I2S/PSRAM APIs, and a steeper ramp.
- **Arduino-ESP32** — a friendlier layer sitting on top of ESP-IDF.

Take Arduino, but call the IDF functions directly where they matter. This is not a
compromise — Arduino-ESP32 *is* ESP-IDF underneath, so `esp_camera_fb_get()`,
`xTaskCreatePinnedToCore()`, `esp_http_server`, and `esp_timer_get_time()` are all
available to you from an `.ino`-style `setup()`/`loop()` project. You get IDF's
capability with Arduino's ergonomics and PlatformIO's one-command build/flash/monitor.

Use **PlatformIO** rather than the Arduino IDE so the build is reproducible, the
library versions are pinned in a file we can commit, and you can work in the same
editor as the rest of us.

### Setup

```bash
# PlatformIO CLI (or install the PlatformIO IDE extension in Cursor/VS Code)
pip install platformio

cd firmware
pio run                  # build
pio run -t upload        # flash
pio device monitor       # serial console
```

### `firmware/platformio.ini`

```ini
[env:seeed_xiao_esp32s3]
platform = espressif32
board = seeed_xiao_esp32s3
framework = arduino
monitor_speed = 115200

; ---- critical: the XIAO Sense has 8 MB OPI PSRAM. Without this the ring
; ---- buffer has nowhere to live and everything below falls apart.
board_build.arduino.memory_type = qio_opi
build_flags =
    -DBOARD_HAS_PSRAM
    -DCORE_DEBUG_LEVEL=3

board_build.partitions = huge_app.csv

lib_deps =
    bblanchon/ArduinoJson@^7.0.0
```

Verify PSRAM before you write anything else:

```cpp
Serial.printf("PSRAM: %u bytes free\n", ESP.getFreePsram());
// must print ~8000000. If it prints 0, memory_type above is wrong.
```

---

## 2. Hardware assumptions

| Part | Choice | Notes |
|---|---|---|
| SoC | Seeed XIAO ESP32-S3 Sense | 8 MB PSRAM, Wi-Fi, camera connector |
| Camera | OV2640 (on the Sense expansion board) | **outputs JPEG itself** |
| Mic | PDM mic (on the Sense board) | read over I2S in PDM mode |
| Storage | microSD on the Sense board | SPI mode |
| Button | GPIO + interrupt, external pull-up | |
| Indicator LED | GPIO | on whenever `recording == true` |

The single most important property: **the OV2640 compresses to JPEG on the sensor
module.** The ESP32 never touches pixels. That is the only reason this project fits
in the power and CPU budget, and it is why the clip format in `api.md` is MJPEG.

---

## 3. Task structure

Five FreeRTOS tasks, pinned deliberately. Pinning is what keeps a Wi-Fi transfer from
stalling the camera.

| Task | Core | Prio | Job |
|---|---|---|---|
| `capture_task` | 1 | 5 | `esp_camera_fb_get()` at 15 fps, stamp, enqueue |
| `audio_task`   | 1 | 5 | I2S PDM read, 20 ms blocks, stamp, enqueue |
| `writer_task`  | 1 | 4 | drain queue to SD as 2-second segments |
| `http_task`    | 0 | 3 | `esp_http_server`, serves `docs/api.md` |
| `supervisor`   | 0 | 2 | battery ADC, LED, AP timeout, stats |

**Core 1 is the recording side. Core 0 is the radio side.** They communicate only
through the segment files on the SD card and a small mutex-protected stats struct.
This is the concrete version of "keeping the Wi-Fi separate from the recording side"
from the proposal.

---

## 4. The ring buffer

This is the heart of the device and the part worth designing carefully.

### Two stages

```
camera ─┐
        ├─► PSRAM staging queue ──► SD segment files (the real 60 s ring)
mic ────┘        (~4 MB)                (30 x 2-second files)
```

**Stage 1 — PSRAM queue.** Absorbs SD write stalls. The problem from the proposal:
most SD writes take a few ms, and then occasionally one takes 300 ms because the card
decided to do wear-levelling. If video is arriving at 407 KB/s and you are blocked,
you drop frames.

Size it at **4 MB**, which at 407 KB/s is **~10 seconds of slack**. Observed worst-case
SD stalls are well under a second, so this is enormous headroom — deliberately, because
`dropped_frames` must stay at zero to satisfy our reliability requirement.

Use a FreeRTOS queue of *descriptors* (pointer + length + pts + type), not of data.
The data itself lives in a PSRAM slab allocator you write once. Copying 25 KB frames
through a queue would defeat the point.

```cpp
typedef struct {
    uint8_t  type;      // 1 = video, 2 = audio
    uint32_t pts_us;
    uint32_t len;
    uint8_t *data;      // points into the PSRAM slab
} cap_packet_t;

static QueueHandle_t pkt_queue;  // xQueueCreate(256, sizeof(cap_packet_t))
```

**Stage 2 — SD segments.** The 60-second ring is 30 files of 2 seconds each, plus a
few spare so you are never writing into the file you are about to need:

```
/seg/0000.cap  /seg/0001.cap  ...  /seg/0034.cap
```

`writer_task` writes packets into the current segment; every 2 seconds it closes it
and opens `(n+1) % 35`. Opening a slot that already has a file means deleting the
oldest — **unless that segment is protected.**

### The button press

The proposal says: the one moment we absolutely cannot delete footage is the moment
you press. So the press does almost nothing:

1. ISR sets a volatile flag. That is all the ISR does.
2. `writer_task` sees the flag at its next segment boundary.
3. It marks the **last 30 segments** `protected` in an in-RAM bitmap.
4. It writes a small index file naming them, in order:

```
/clips/0042.capidx   →   {"segments":["0021","0022",...,"0015"],"t0_unix_ms":...}
```

5. It clears `protected` on segments only when the app `ack`s the clip.

**No footage is copied and nothing is re-encoded.** Clip creation is a bitmap write
and a ~200-byte file, so it completes in milliseconds and cannot drop a frame. When
the app requests `GET /api/clips/0042`, `http_task` synthesizes the 32-byte `CAPS1`
header on the fly and then streams the listed segment files back to back.

This also means the protected segments are simply excluded from the ring's reuse
rotation — the ring gets shorter while a clip is un-acked, which is fine, because you
sized for 35 slots and a press needs 30. If a second press arrives while the first is
still protected, either refuse it (`503 busy`) or grow into the spare slots. Your call;
document whichever you pick.

---

## 5. Timestamping

One clock for both streams. Use `esp_timer_get_time()`, which is monotonic
microseconds since boot.

```cpp
// in capture_task, immediately after the frame comes back
camera_fb_t *fb = esp_camera_fb_get();
uint32_t pts = (uint32_t)(esp_timer_get_time() - t0_us);
```

Stamp **as close to the hardware as you can get** — the frame at `fb_get()` return,
the audio block at I2S read return. Do not stamp after queueing; queue latency is
exactly the error you are trying to measure.

Wall-clock time (`t0_unix_ms` in the header) comes from the phone via
`POST /api/time`. The ESP32 has no battery-backed RTC, so until the app connects
once, the device genuinely does not know what time it is. Report that honestly in
`/api/status` as `clock_set: false`.

**Drift.** If the camera free-runs at 15 fps and the I2S clock runs at 16 kHz, they
are two independent oscillators and they *will* separate over 60 seconds. You are not
preventing that — you are recording it. Because both packet streams carry `pts_us`
from one clock, the app lines them up on playback, and the clapperboard test gives us
a number in milliseconds instead of somebody squinting at a video.

---

## 6. HTTP server

Use `esp_http_server` (available from Arduino: `#include "esp_http_server.h"`).

```cpp
httpd_config_t config = HTTPD_DEFAULT_CONFIG();
config.core_id        = 0;      // keep it off the recording core
config.stack_size     = 8192;
config.max_uri_handlers = 12;
config.lru_purge_enable = true;
```

Three rules that come straight from `api.md` and are easy to get wrong:

1. **Send `Content-Length`, not chunked encoding.** The app draws a progress bar
   from it. `httpd_resp_set_hdr()` then `httpd_resp_send_chunk()` in a loop is fine,
   but set the length header first.
2. **Support `Range`.** Parse `Range: bytes=N-`, reply `206` with `Content-Range`,
   and seek into the segment list. A 24 MB transfer from a hat will get interrupted
   and the app resumes rather than starting over.
3. **Stream, never buffer.** Read a segment in 8 KB chunks straight to the socket.
   Do not assemble 24 MB anywhere; you do not have 24 MB.

The AP itself should be **off by default** and come up for 5 minutes on a long-press.
The radio is a large fraction of the power budget, and the proposal's 2-hour claim
depends on it being off almost always.

---

## 7. Testing

Jayden's mock device in `mock-device/` speaks the exact same contract. That gives you
a way to check your firmware against a known-good reference:

```bash
# from the repo root
python3 mock-device/serve.py --port 8080

# then point the same curl commands at your device and at the mock
# and diff the output
curl -s http://192.168.4.1/api/status | python3 -m json.tool
curl -s http://localhost:8080/api/status | python3 -m json.tool
```

And there is a validator for your clip bytes:

```bash
curl -s http://192.168.4.1/api/clips/0042 -o /tmp/0042.cap
python3 mock-device/validate.py /tmp/0042.cap
```

It checks the header, walks every packet, verifies `pts_us` is monotonic, reports
measured fps and audio rate, and reports **A/V drift across the clip**. Run it on
real device output early — an unparseable clip found in week 4 is a bad afternoon,
found in week 11 it is the project.

### Milestones

Roughly in dependency order, each one independently demonstrable:

1. PSRAM confirmed, camera returns a JPEG, dump it over serial.
2. `GET /api/preview` returns that JPEG over Wi-Fi. **This is the first integration
   point with Jayden** — his app has a preview check built for exactly this.
3. I2S PDM audio reads, dump raw PCM, confirm it sounds like a room.
4. `writer_task` writes valid `CAPS1` segments to SD. `validate.py` passes.
5. Ring buffer rotates, runs 10 minutes with `dropped_frames == 0`.
6. Button press produces a clip index; `/api/clips` lists it.
7. `GET /api/clips/{id}` streams a full 60 s clip; app plays it. **Integration done.**
8. Range/resume, ack-driven reclaim, AP duty cycling.

Milestone 2 is worth rushing — it is small, and it proves the whole wireless path
works before either of us has built anything complicated on top of it.

---

## 8. Things that will bite

- **PSRAM not enabled** → `esp_camera_init` fails or frames are tiny. Check first.
- **Camera framebuffer leak** → every `esp_camera_fb_get()` needs
  `esp_camera_fb_return()`. Miss one and you stall within seconds.
- **SD in SPI mode is slow.** Measure your actual sustained write rate early; you
  need 407 KB/s with margin. If it is marginal, larger segment writes help more than
  anything else.
- **`Serial.printf` in the capture path** costs more than you think at 15 fps. Log
  counters from `supervisor`, not from the hot loop.
- **Brownout on Wi-Fi TX.** The radio's current spikes can reset the board on a weak
  supply. If you see random reboots when the AP comes up, that is this, and it is
  Clarence's domain — tell him rather than debugging it in software.
