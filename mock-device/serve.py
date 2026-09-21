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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from capsfile import ClipHeader, HEADER_SIZE, PACKET_SIZE

HERE = os.path.dirname(os.path.abspath(__file__))
CLIPS_DIR = os.path.join(HERE, "clips")

API_VERSION = 1
FW_VERSION = "0.1.0-mock"
DEVICE_ID = "capsure-a6-mock"

CLIP_CONTENT_TYPE = "application/x-capsure-clip"

STATE = {
    "boot_time": time.time(),
    "clock_unix_ms": 0,
    "clock_set": False,
    "acked": set(),
    "deleted": set(),
    "args": None,
}


def clip_ids():
    if not os.path.isdir(CLIPS_DIR):
        return []
    ids = [f[:-4] for f in os.listdir(CLIPS_DIR) if f.endswith(".cap")]
    return sorted(set(ids) - STATE["deleted"], reverse=True)


def clip_path(clip_id):
    return os.path.join(CLIPS_DIR, f"{clip_id}.cap")


def clip_meta(clip_id):
    path = clip_path(clip_id)
    if not os.path.exists(path) or clip_id in STATE["deleted"]:
        return None
    size = os.path.getsize(path)
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
        """Extract the first JPEG out of the newest clip and serve it."""
        ids = clip_ids()
        if not ids:
            return self._err(503, "not_ready", "no frames yet")
        import struct
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
        self.send_header("Content-Type", CLIP_CONTENT_TYPE)
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
