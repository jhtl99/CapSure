// Types shared across capsure_fw.ino. They live here, not in the .ino, because the
// Arduino IDE inserts auto-generated function prototypes above any struct that is
// defined later in an .ino, which breaks functions taking these types.
#pragma once
#include <Arduino.h>
#include "FS.h"
#include "SD.h"
#include "esp_heap_caps.h"
#include <esp_http_server.h>
#include "esp_camera.h"

#define IO_BUF (16 * 1024)      // SD read buffer and socket send buffer, each

struct __attribute__((packed)) PktHdr { uint8_t type; uint8_t rsv[3]; int64_t ts; uint32_t len; };   // 16 B
struct __attribute__((packed)) SegHdr { char magic[8]; uint32_t version, segId; int64_t firstTs, lastTs; uint32_t crc, packets; }; // 40 B
struct __attribute__((packed)) SegPkt { uint8_t type; uint8_t rsv[3]; int64_t ts; uint32_t off, len; };   // 20 B, one per packet in .idx
struct Packet { PktHdr h; uint8_t data[]; };
// old = recorded before this power-on. Its timestamps come from a timer that
// restarted at 0 since, so they can't be compared with today's; old segments
// only ever belong to the clips that already reference them.
struct SegInfo { uint32_t id; int64_t firstTs, lastTs; uint32_t bytes, crc; uint16_t refs; bool old; };

// HTTP -> writer commands (clip delete)
struct WCmd { uint32_t clipId; SemaphoreHandle_t done; bool ok; };

struct OutPkt { uint32_t seg, src, len, out, pts; uint8_t type; };

struct ClipIdx {
  uint32_t id = 0;
  OutPkt *p = nullptr; uint32_t n = 0;
  uint64_t bytes = 0;
  uint8_t hdr[32];
  uint32_t durationMs = 0;
  uint16_t fps = 15;
  int64_t createdUnixMs = 0;
  int64_t pressUs = 0, unixAtPress = 0;   // from the manifest, for ClipSummary
  uint32_t boot = 0;
  ~ClipIdx() { free(p); }
};

String segPath(uint32_t id);

// buffered reader over segment files; one per server task
struct SegReader {
  File f; uint32_t seg = 0; bool open = false;
  uint8_t *buf; uint32_t cap, bufStart = 0, bufLen = 0;
  SegReader(uint32_t size = IO_BUF) : cap(size) { buf = (uint8_t *)heap_caps_malloc(size, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL); }
  void close() { if (open) f.close(); open = false; bufLen = 0; }
  bool readAt(uint32_t s, uint32_t pos, uint8_t *dst, size_t n) {
    if (!open || s != seg) {
      close();
      f = SD.open(segPath(s));
      if (!f) return false;
      open = true; seg = s;
    }
    while (n) {
      size_t k;
      if (bufLen && pos >= bufStart && pos < bufStart + bufLen) {
        k = min(n, (size_t)(bufStart + bufLen - pos));
        memcpy(dst, buf + (pos - bufStart), k);
      } else if (n >= cap) {                                // big JPEG: straight into the send buffer
        if (!f.seek(pos)) return false;
        k = f.read(dst, n);
        if (!k) return false;
      } else {
        if (!f.seek(pos)) return false;
        bufLen = f.read(buf, cap);
        bufStart = pos;
        if (!bufLen) return false;
        continue;
      }
      dst += k; pos += k; n -= k;
    }
    return true;
  }
};

typedef esp_err_t (*HandlerFn)(httpd_req_t *);

// Where the time went in one transfer (GET /admin/last, serial log).
struct XferStats {
  char what[24] = "";
  uint64_t bytes = 0;
  int64_t totalUs = 0, sdUs = 0, sendUs = 0, maxSdUs = 0, maxSendUs = 0;
  uint32_t chunks = 0, dropped = 0;
  bool ok = false;
};

// jpg2rgb565's scale argument is jpg_scale_t in older esp32-camera releases and
// esp_jpeg_image_scale_t in newer ones. Both number the scales the same way
// (0 = full, 1 = 1/2, 2 = 1/4, 3 = 1/8), so take the type from the function itself.
#include "img_converters.h"
template <typename S>
static inline bool jpgTo565(bool (*fn)(const uint8_t *, size_t, uint8_t *, S),
                            const uint8_t *src, size_t len, uint8_t *out, int scale) {
  return fn(src, len, out, (S)scale);
}
#define JPG_TO_565(src, len, out, scale) jpgTo565(jpg2rgb565, (src), (len), (out), (scale))

// One clip download handed from the HTTP server task to a transfer worker.
struct XferJob { httpd_req_t *req; uint32_t id; };

// What /api/clips needs about a clip, without its packet index. Saved next to
// the manifest as clip_XXXX.sum the first time the clip is indexed, so later
// listings (and listings after a reboot) read 40 bytes instead of ~30 files.
struct __attribute__((packed)) ClipSummary {
  uint32_t magic;            // 'CSUM'
  uint32_t id;
  uint64_t bytes;
  uint32_t durationMs;
  uint16_t fps, rsv;
  int64_t pressUs, unixAtPress;
  uint32_t boot;
};
#define CLIP_SUMMARY_MAGIC 0x4D555343u
