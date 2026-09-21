# CapSure Device API (v1)

This document is the contract between the **device** (ESP32-S3, Ankita) and the
**phone app** (Expo/TypeScript, Jayden). It is the only agreement between the two
halves of the system. If both sides satisfy this document, integration works.

**Do not change this file unilaterally.** Any change is a pull request that both
Jayden and Ankita approve, and the `api_version` field bumps.

---

## 1. Link layer

The device hosts its own Wi-Fi network (SoftAP). The phone joins it to pull clips.

| Property | Value |
|---|---|
| SSID | `CapSure-XXXX` (XXXX = last 4 hex of MAC) |
| Security | WPA2-PSK |
| Password | `capsure2026` (dev default; provisioned later) |
| Device IP | `192.168.4.1` |
| Base URL | `http://192.168.4.1` |
| Port | 80 |

**Why SoftAP and not joining a home network:** the use case is walking home at
night. There is no router there. SoftAP also means zero configuration at demo time.

**Radio duty cycle:** the AP is **off** by default. A button press (or long-press,
Ankita's call) brings it up for a 5-minute window, then it shuts down again. This is
a large part of the 2-hour battery budget. The app must therefore tolerate the device
being unreachable and tell the user to press the button rather than silently retrying.

**Single client.** The device accepts one HTTP client at a time. A second concurrent
client may receive `503`.

---

## 2. Conventions

- All responses are `application/json; charset=utf-8` **except** clip bodies.
- All timestamps named `*_unix_ms` are milliseconds since the Unix epoch.
- All timestamps named `*_us` are microseconds on the device's **monotonic** clock.
- IDs are opaque strings, `[A-Za-z0-9_-]{1,32}`. The app never parses them.
- Errors use the appropriate HTTP status plus a body of:

```json
{ "error": "clip_not_found", "message": "no clip with id 0042" }
```

Error codes in use: `bad_request`, `clip_not_found`, `busy`, `storage_error`,
`not_ready`.

---

## 3. Endpoints

### `GET /api/status`

Cheap, always available while the AP is up. The app polls this to render the
connection screen.

```json
{
  "api_version": 1,
  "device_id": "capsure-a6-01",
  "fw_version": "0.1.0",
  "uptime_s": 1234,
  "recording": true,
  "buffer_healthy": true,
  "buffer_seconds": 60,
  "battery_pct": 87,
  "battery_mv": 3920,
  "storage_free_mb": 5120,
  "storage_total_mb": 15200,
  "dropped_frames": 0,
  "clock_unix_ms": 1758470000000,
  "clock_set": true
}
```

- `recording` — capture pipeline is running and the ring buffer is filling.
- `buffer_healthy` — no frame drops in the last 60 s. This is the field that backs
  our ">99% reliability" requirement; the app surfaces it as a warning.
- `dropped_frames` — cumulative since boot. Should stay at 0. Non-zero is a bug.
- `clock_set` — `false` until the phone has called `POST /api/time`. The ESP32 has
  no battery-backed RTC, so its wall clock is meaningless until we set it.

---

### `POST /api/time`

The phone is the source of truth for wall-clock time. The app calls this on every
successful connection, before listing clips.

Request:
```json
{ "unix_ms": 1758470000000 }
```

Response: `200` with the same body as `/api/status`.

Clips created before the clock is set carry `created_unix_ms: 0` and are shown by
the app as "unknown time".

---

### `GET /api/clips`

Lists saved (button-pressed) clips, **newest first**. Does not list the live ring
buffer — that is not addressable.

```json
{
  "clips": [
    {
      "id": "0042",
      "created_unix_ms": 1758470000000,
      "duration_ms": 60000,
      "bytes": 21400000,
      "width": 640,
      "height": 480,
      "fps": 15,
      "audio_sample_rate": 16000,
      "acked": false,
      "complete": true
    }
  ]
}
```

- `bytes` — exact byte length of the body `GET /api/clips/{id}` will return. The app
  uses it for progress and for a free-space check. It must be exact.
- `complete` — `false` while the device is still finalizing the clip (the press just
  happened). The app hides incomplete clips from download.
- `acked` — the app has confirmed a successful full download. See below.

---

### `GET /api/clips/{id}`

Returns the clip body. **This is the only large transfer in the system.**

Response headers:

```
200 OK
Content-Type: application/x-capsure-clip
Content-Length: 21400000
Accept-Ranges: bytes
```

- `Content-Length` is **required** (not chunked encoding) — the app renders a
  progress bar from it.
- `Range` requests are **required**: `Range: bytes=10485760-` must return `206
  Partial Content` with a `Content-Range` header. A 20 MB transfer over flaky Wi-Fi
  from a hat will get interrupted; the app resumes rather than restarting.
- The device **must keep buffering while serving this**. Capture is on core 1, HTTP
  on core 0. A transfer never pauses recording.

### `POST /api/clips/{id}/ack`

The app calls this after a byte-complete, parse-verified download. Until it is
acked, the device treats the clip as precious and will not reclaim its space.

Response: `200`, the updated clip object.

### `DELETE /api/clips/{id}`

Deletes immediately. Used by the "delete from device" action in the gallery.

Response: `200`, `{ "deleted": "0042" }`.

### `GET /api/preview`

Returns a **single** current JPEG frame (`image/jpeg`). Not a stream.

This exists for two reasons: the app's "is the camera actually working" check, and
it gives Ankita a way to see what the sensor sees without pulling a whole clip.

---

## 4. Clip format: `CAPS1`

We do not use AVI, MP4, or any standard container. The device produces MJPEG frames
and raw PCM audio, and muxing those into a standard container on an ESP32 is work
that buys us nothing — iOS will not play MJPEG-in-AVI anyway. Instead we define a
container so simple that the device writes it with `fwrite` and the app parses it
with a 40-line loop.

### Header — 32 bytes, little-endian

| Offset | Size | Type | Field |
|---|---|---|---|
| 0  | 4 | char[4] | magic, `"CAPS"` |
| 4  | 1 | u8  | version, `1` |
| 5  | 1 | u8  | flags (bit0 = has_audio) |
| 6  | 2 | u16 | width |
| 8  | 2 | u16 | height |
| 10 | 2 | u16 | fps |
| 12 | 4 | u32 | audio_sample_rate |
| 16 | 1 | u8  | audio_bits (16) |
| 17 | 1 | u8  | audio_channels (1) |
| 18 | 2 | u16 | reserved (0) |
| 20 | 8 | u64 | t0_unix_ms — wall clock of the first packet |
| 28 | 4 | u32 | packet_count |

### Packet — 12-byte header, then payload

| Offset | Size | Type | Field |
|---|---|---|---|
| 0 | 1 | u8  | type: `1` = video JPEG, `2` = audio PCM |
| 1 | 1 | u8  | reserved (0) |
| 2 | 2 | u16 | reserved (0) |
| 4 | 4 | u32 | pts_us — microseconds from t0, same clock for both streams |
| 8 | 4 | u32 | length — payload bytes that follow |

Payload is a complete JPEG (type 1) or a block of signed 16-bit mono PCM (type 2).

Packets are in **ascending `pts_us` order**, interleaved. Audio blocks are 20 ms
(320 samples, 640 bytes at 16 kHz).

### Why this format earns its place

- **The device never transcodes.** The camera driver hands Ankita a JPEG buffer; she
  writes 12 bytes and then that buffer. The I2S DMA hands her PCM; same.
- **The same bytes are the on-SD format.** A 2-second segment file on the card is
  just a run of packets. Making a clip is writing a 32-byte header and concatenating
  segments — no copy, no re-encode, which is what lets a button press be instant.
- **A/V sync is measurable, not hoped for.** Both streams carry `pts_us` from one
  monotonic clock, so drift is a subtraction. This is what the clapperboard test in
  the proposal actually measures.
- **The app can play it without a codec.** Draw JPEGs to a canvas on their `pts_us`,
  feed PCM to an audio buffer. At 480p15 this is comfortable on any phone from the
  last decade.

### Reference parser

`app/src/device/clip.ts` is the normative parser. `mock-device/capsfile.py` is the
normative writer. If the firmware disagrees with those two, the firmware is wrong.

---

## 5. Budgets

Sanity numbers everyone should be holding the same version of:

| Quantity | Value |
|---|---|
| JPEG frame @ 480p, quality ~12 | ~25 KB |
| Video rate | 15 fps x 25 KB = **375 KB/s** |
| Audio rate | 16 kHz x 16-bit mono = **32 KB/s** |
| Total write rate | **~407 KB/s** |
| 60-second clip | **~24 MB** |
| Transfer @ 2 MB/s (ESP32-S3 SoftAP, realistic) | **~12 s** |
| Requirement | < 60 s |

That ~5x margin is the headroom that lets us survive a bad Wi-Fi day. It is also why
Bluetooth is not on the table: BLE moves 20-50 KB/s, which puts a 24 MB clip at
8-20 minutes.

---

## 6. Change log

| Version | Date | Change |
|---|---|---|
| 1 | 2026-09-21 | Initial contract |
