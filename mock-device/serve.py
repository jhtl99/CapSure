#!/usr/bin/env python3
"""
Mock CapSure device: speaks docs/api.md exactly, over plain HTTP.

This is the most useful file in the repo right now. It lets the app be built
and tested before any firmware exists, and it gives the firmware a known-good
reference to be diffed against.

    python3 serve.py                          # http://localhost:8080
    python3 serve.py --throttle 2000          # 2 MB/s, like real Wi-Fi
    python3 serve.py --fail-after 3000000     # drop the socket mid-clip
    python3 serve.py --offline-after 60       # pretend the AP timed out

Endpoints: see docs/api.md.
"""

import argparse
import json
import os
import re
import socket
import struct
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from capsfile import ClipHeader, HEADER_SIZE, PACKET_SIZE

HERE = os.path.dirname(os.path.abspath(__file__))
CLIPS_DIR = os.path.join(HERE, "clips")

API_VERSION = 1
FW_VERSION = "0.1.0-mock"
DEVICE_ID = "capsure-a6-mock"

CLIP_CONTENT_TYPE = "application/x-capsure-clip"
MOV_CONTENT_TYPE = "video/quicktime"

# QuickTime timestamps are seconds since 1904-01-01 UTC.
MAC_EPOCH_OFFSET = 2082844800
CLIP_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,32}")

STATE = {
    "boot_time": time.time(),
    "clock_unix_ms": 0,
    "clock_set": False,
    "acked": set(),
    "deleted": set(),
    "args": None,
}


def clip_entries():
    """(clip_id, extension) for every servable file, newest-id first.

    `.cap` is the device format. A `.mov` dropped in the same folder is served
    as a QuickTime file so a phone can download it. If both exist for one id,
    the `.cap` wins.
    """
    if not os.path.isdir(CLIPS_DIR):
        return []
    by_id = {}
    for name in os.listdir(CLIPS_DIR):
        stem, ext = os.path.splitext(name)
        ext = ext.lower()
        if ext not in (".cap", ".mov") or not CLIP_ID_RE.fullmatch(stem):
            continue
        if stem not in by_id or ext == ".cap":
            by_id[stem] = ext
    ids = sorted(set(by_id) - STATE["deleted"], reverse=True)
    return [(clip_id, by_id[clip_id]) for clip_id in ids]


def clip_ids():
    return [clip_id for clip_id, _ext in clip_entries()]


def clip_path(clip_id):
    for found_id, ext in clip_entries():
        if found_id == clip_id:
            return os.path.join(CLIPS_DIR, clip_id + ext)
    return os.path.join(CLIPS_DIR, f"{clip_id}.cap")


def _iter_atoms(buf, start, end):
    pos = start
    while pos + 8 <= end:
        size, typ = struct.unpack_from(">I4s", buf, pos)
        header = 8
        if size == 1 and pos + 16 <= end:
            size = struct.unpack_from(">Q", buf, pos + 8)[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            return
        yield typ, pos + header, pos + size
        pos += size


def _walk_atoms(buf, start, end):
    for typ, body, end_ in _iter_atoms(buf, start, end):
        yield typ, body, end_
        if typ in (b"moov", b"trak", b"mdia", b"minf", b"stbl"):
            yield from _walk_atoms(buf, body, end_)


def mov_info(path):
    """Duration, size, and rates from a QuickTime file, without decoding it.

    Only the `moov` atom is read. `mdat` (the media) stays on disk.
    """
    info = {
        "created_unix_ms": int(os.path.getmtime(path) * 1000),
        "duration_ms": 0,
        "width": 0,
        "height": 0,
        "fps": 0,
        "audio_sample_rate": 0,
    }
    file_size = os.path.getsize(path)
    moov = b""
    with open(path, "rb") as f:
        while f.tell() + 8 <= file_size:
            pos = f.tell()
            raw = f.read(8)
            if len(raw) < 8:
                break
            size, typ = struct.unpack(">I4s", raw)
            header = 8
            if size == 1:
                ext = f.read(8)
                if len(ext) < 8:
                    break
                size = struct.unpack(">Q", ext)[0]
                header = 16
            elif size == 0:
                size = file_size - pos
            if size < header or pos + size > file_size:
                break
            if typ == b"moov" and size <= 32 * 1024 * 1024:
                moov = f.read(size - header)
                break
            f.seek(pos + size)
    if not moov:
        return info

    for typ, body, end in _iter_atoms(moov, 0, len(moov)):
        if typ == b"mvhd":
            created, duration_ms = _mvhd(moov, body, end)
            if created:
                info["created_unix_ms"] = created
            info["duration_ms"] = duration_ms
        elif typ == b"trak":
            _apply_trak(moov, body, end, info)
    return info


def _mvhd(buf, body, end):
    if end - body < 20:
        return 0, 0
    version = buf[body]
    if version == 0:
        created, _modified, timescale, duration = struct.unpack_from(">IIII", buf, body + 4)
    elif version == 1 and end - body >= 32:
        created, _modified, timescale, duration = struct.unpack_from(">QQIQ", buf, body + 4)
    else:
        return 0, 0
    created_unix_ms = 0
    if created > MAC_EPOCH_OFFSET:
        created_unix_ms = int((created - MAC_EPOCH_OFFSET) * 1000)
    duration_ms = int(duration * 1000 / timescale) if timescale else 0
    return created_unix_ms, duration_ms


def _apply_trak(buf, start, end, info):
    handler = None
    width = height = 0
    timescale = duration = samples = 0
    for typ, body, end_ in _walk_atoms(buf, start, end):
        if typ == b"tkhd":
            width, height = _tkhd_size(buf, body, end_)
        elif typ == b"hdlr" and end_ - body >= 12:
            kind = buf[body + 8:body + 12]
            # Alias and metadata handlers share a trak with the real one.
            if kind in (b"vide", b"soun"):
                handler = kind
        elif typ == b"mdhd":
            timescale, duration = _mdhd(buf, body, end_)
        elif typ == b"stts":
            samples = _stts_samples(buf, body, end_)

    if handler == b"vide" and width and not info["width"]:
        info["width"] = width
        info["height"] = height
        if samples and timescale and duration:
            info["fps"] = round(samples * timescale / duration)
    elif handler == b"soun" and timescale and not info["audio_sample_rate"]:
        info["audio_sample_rate"] = timescale


def _tkhd_size(buf, body, end):
    version = buf[body]
    if version == 0 and end - body >= 84:
        w, h = struct.unpack_from(">II", buf, body + 76)
    elif version == 1 and end - body >= 96:
        w, h = struct.unpack_from(">II", buf, body + 88)
    else:
        return 0, 0
    return w >> 16, h >> 16


def _mdhd(buf, body, end):
    version = buf[body]
    if version == 0 and end - body >= 20:
        timescale, duration = struct.unpack_from(">II", buf, body + 12)
    elif version == 1 and end - body >= 32:
        timescale, duration = struct.unpack_from(">IQ", buf, body + 20)
    else:
        return 0, 0
    return timescale, duration


def _stts_samples(buf, body, end):
    if end - body < 8:
        return 0
    count = struct.unpack_from(">I", buf, body + 4)[0]
    samples = 0
    pos = body + 8
    for _ in range(count):
        if pos + 8 > end:
            break
        sample_count, _delta = struct.unpack_from(">II", buf, pos)
        samples += sample_count
        pos += 8
    return samples


def clip_meta(clip_id):
    path = clip_path(clip_id)
    if not os.path.exists(path) or clip_id in STATE["deleted"]:
        return None
    size = os.path.getsize(path)
    ext = os.path.splitext(path)[1].lower()

    if ext == ".mov":
        info = mov_info(path)
        return {
            "id": clip_id,
            "created_unix_ms": info["created_unix_ms"],
            "duration_ms": info["duration_ms"],
            "bytes": size,
            "width": info["width"],
            "height": info["height"],
            "fps": info["fps"],
            "audio_sample_rate": info["audio_sample_rate"],
            "format": "mov",
            "acked": clip_id in STATE["acked"],
            "complete": True,
        }

    with open(path, "rb") as f:
        h = ClipHeader.unpack(f.read(HEADER_SIZE))

    # Derive duration from the packet stream's nominal rates rather than
    # walking the whole file on every listing.
    video_packets = max(1, h.packet_count * h.fps // (h.fps + 50))
    duration_ms = int(video_packets / h.fps * 1000)

    return {
        "id": clip_id,
        "created_unix_ms": h.t0_unix_ms,
        "duration_ms": duration_ms,
        "bytes": size,
        "width": h.width,
        "height": h.height,
        "fps": h.fps,
        "audio_sample_rate": h.audio_sample_rate,
        "acked": clip_id in STATE["acked"],
        "complete": True,
    }


def status_body():
    args = STATE["args"]
    uptime = time.time() - STATE["boot_time"]
    total = sum(
        os.path.getsize(clip_path(c)) for c in clip_ids()
    )
    return {
        "api_version": API_VERSION,
        "device_id": DEVICE_ID,
        "fw_version": FW_VERSION,
        "uptime_s": int(uptime),
        "recording": True,
        "buffer_healthy": not args.unhealthy,
        "buffer_seconds": 60,
        "battery_pct": max(5, 100 - int(uptime / 72)),
        "battery_mv": 4100 - int(uptime / 72) * 6,
        "storage_free_mb": max(0, 15200 - total // (1024 * 1024)),
        "storage_total_mb": 15200,
        "dropped_frames": 17 if args.unhealthy else 0,
        "clock_unix_ms": STATE["clock_unix_ms"],
        "clock_set": STATE["clock_set"],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CapSureMock/0.1"

    # ---- helpers -------------------------------------------------------

    def _json(self, code, payload):
        body = json.dumps(payload, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, error, message):
        self._json(code, {"error": error, "message": message})

    def _offline(self):
        args = STATE["args"]
        if args.offline_after <= 0:
            return False
        return (time.time() - STATE["boot_time"]) > args.offline_after

    def log_message(self, fmt, *a):
        print(f"  {self.command:6s} {self.path:40s} {fmt % a}")

    # ---- routing -------------------------------------------------------

    def do_GET(self):
        if self._offline():
            self.close_connection = True
            return

        if self.path == "/api/status":
            return self._json(200, status_body())

        if self.path == "/api/clips":
            clips = [m for m in (clip_meta(c) for c in clip_ids()) if m]
            clips.sort(key=lambda c: c["created_unix_ms"], reverse=True)
            return self._json(200, {"clips": clips})

        if self.path == "/api/preview":
            return self._serve_preview()

        m = re.fullmatch(r"/api/clips/([A-Za-z0-9_-]{1,32})", self.path)
        if m:
            return self._serve_clip(m.group(1))

        return self._err(404, "bad_request", f"no route for {self.path}")

    def do_POST(self):
        if self._offline():
            self.close_connection = True
            return

        if self.path == "/api/time":
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
                STATE["clock_unix_ms"] = int(body["unix_ms"])
                STATE["clock_set"] = True
            except (ValueError, KeyError, TypeError):
                return self._err(400, "bad_request", "expected {\"unix_ms\": int}")
            return self._json(200, status_body())

        m = re.fullmatch(r"/api/clips/([A-Za-z0-9_-]{1,32})/ack", self.path)
        if m:
            clip_id = m.group(1)
            meta = clip_meta(clip_id)
            if not meta:
                return self._err(404, "clip_not_found", f"no clip {clip_id}")
            STATE["acked"].add(clip_id)
            return self._json(200, clip_meta(clip_id))

        return self._err(404, "bad_request", f"no route for {self.path}")

    def do_DELETE(self):
        m = re.fullmatch(r"/api/clips/([A-Za-z0-9_-]{1,32})", self.path)
        if not m:
            return self._err(404, "bad_request", f"no route for {self.path}")
        clip_id = m.group(1)
        if not clip_meta(clip_id):
            return self._err(404, "clip_not_found", f"no clip {clip_id}")
        STATE["deleted"].add(clip_id)
        return self._json(200, {"deleted": clip_id})

    # ---- bodies --------------------------------------------------------

    def _serve_preview(self):
        """Extract the first JPEG out of the newest CAPS1 clip and serve it."""
        ids = [clip_id for clip_id, ext in clip_entries() if ext == ".cap"]
        if not ids:
            return self._err(503, "not_ready", "no frames yet")
        with open(clip_path(ids[0]), "rb") as f:
            f.seek(HEADER_SIZE)
            for _ in range(64):
                raw = f.read(PACKET_SIZE)
                if len(raw) < PACKET_SIZE:
                    break
                ptype, _, _, _pts, length = struct.unpack("<BBHII", raw)
                payload = f.read(length)
                if ptype == 1:
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
        return self._err(503, "not_ready", "no video frame found")

    def _serve_clip(self, clip_id):
        meta = clip_meta(clip_id)
        if not meta:
            return self._err(404, "clip_not_found", f"no clip {clip_id}")

        path = clip_path(clip_id)
        size = meta["bytes"]
        content_type = MOV_CONTENT_TYPE if meta.get("format") == "mov" else CLIP_CONTENT_TYPE
        start, end = 0, size - 1
        partial = False

        rng = self.headers.get("Range")
        if rng:
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
            if not m:
                return self._err(400, "bad_request", f"bad Range: {rng}")
            s, e = m.group(1), m.group(2)
            if s:
                start = int(s)
                end = int(e) if e else size - 1
            elif e:                      # suffix range: bytes=-500
                start = max(0, size - int(e))
            if start >= size or end >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            partial = True

        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        args = STATE["args"]
        chunk = 32 * 1024
        sent = 0
        with open(path, "rb") as f:
            f.seek(start)
            while sent < length:
                buf = f.read(min(chunk, length - sent))
                if not buf:
                    break

                if args.fail_after and (start + sent + len(buf)) > args.fail_after:
                    print(f"  !! simulating dropped connection at "
                          f"{start + sent} bytes")
                    self.close_connection = True
                    return

                try:
                    self.wfile.write(buf)
                except (BrokenPipeError, ConnectionResetError):
                    print("  !! client went away")
                    return
                sent += len(buf)

                if args.throttle:
                    time.sleep(len(buf) / (args.throttle * 1000.0))


def lan_ip():
    """This machine's address on the local network, as the phone would see it.

    Opening a UDP socket to an outside address makes the OS pick the interface
    it would actually route through, which is more reliable than guessing from
    the hostname. Nothing is sent.
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        pass

    # Fallback for machines where that route is unavailable.
    try:
        addr = socket.gethostbyname(socket.gethostname())
        if not addr.startswith("127."):
            return addr
    except OSError:
        pass

    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--throttle", type=int, default=0, metavar="KBPS",
                    help="limit transfer speed; 2000 approximates real Wi-Fi")
    ap.add_argument("--fail-after", type=int, default=0, metavar="BYTES",
                    help="drop the socket mid-clip, to exercise resume")
    ap.add_argument("--offline-after", type=int, default=0, metavar="SECONDS",
                    help="stop answering, as if the AP timed out")
    ap.add_argument("--unhealthy", action="store_true",
                    help="report dropped frames and buffer_healthy=false")
    args = ap.parse_args()
    STATE["args"] = args

    ids = clip_ids()
    if not ids:
        print("No clips found. Run:  python3 gen_clips.py\n")

    print(f"CapSure mock device on http://{args.host}:{args.port}")
    lan = lan_ip()
    if lan:
        print(f"  from your phone:  http://{lan}:{args.port}")
        print("  (put that in the app's device address field)")
    else:
        print("  could not detect this machine's LAN address; find it with:")
        print("    ipconfig getifaddr en0      # macOS Wi-Fi")
    print(f"  clips: {', '.join(ids) if ids else '(none)'}")
    if args.throttle:
        print(f"  throttled to {args.throttle} KB/s")
    if args.fail_after:
        print(f"  will drop connections after {args.fail_after} bytes")
    print()

    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
