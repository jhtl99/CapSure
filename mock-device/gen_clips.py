#!/usr/bin/env python3
"""
Generate fake CAPS1 clips so the app can be built before the device exists.

Each clip contains a visible frame counter and a "clapper" event: one white
flash frame accompanied by a 1 kHz beep at exactly the same pts_us. That gives
the app (and validate.py) a ground-truth A/V sync marker to measure against --
the software version of the clapperboard test in the proposal.

    python3 gen_clips.py --count 3 --duration 10
"""

import argparse
import io
import math
import os
import struct
import time

import numpy as np
from PIL import Image, ImageDraw

from capsfile import ClipHeader, Packet, write_clip, TYPE_VIDEO, TYPE_AUDIO

WIDTH, HEIGHT = 640, 480
FPS = 15
SAMPLE_RATE = 16000
AUDIO_BLOCK_MS = 20
CLAPPER_AT_S = 2.0          # when the flash + beep happen
JPEG_QUALITY = 58           # lands around 25 KB, matching the budget in docs/api.md


def make_frame(index: int, t_s: float, is_clapper: bool, rng) -> bytes:
    if is_clapper:
        img = Image.new("RGB", (WIDTH, HEIGHT), (255, 255, 255))
    else:
        # A gradient plus noise, so the JPEG has realistic entropy and lands
        # near the ~25 KB/frame the power and storage budget assumes.
        x = np.linspace(0, 255, WIDTH, dtype=np.float32)
        y = np.linspace(0, 180, HEIGHT, dtype=np.float32)
        base = (x[None, :] * 0.5 + y[:, None] * 0.5)
        noise = rng.normal(0, 8, (HEIGHT, WIDTH))
        r = np.clip(base + noise, 0, 255)
        g = np.clip(base * 0.6 + noise, 0, 255)
        b = np.clip(180 - base * 0.4 + noise, 0, 255)
        arr = np.stack([r, g, b], axis=-1).astype(np.uint8)
        img = Image.fromarray(arr, "RGB")

    d = ImageDraw.Draw(img)
    fg = (0, 0, 0) if is_clapper else (255, 255, 255)

    d.rectangle([12, 12, 360, 96], fill=(0, 0, 0) if not is_clapper else (255, 255, 255))
    d.text((24, 24), f"FRAME {index:05d}", fill=fg)
    d.text((24, 44), f"t = {t_s:7.3f} s", fill=fg)
    d.text((24, 64), "CAPSURE MOCK DEVICE", fill=fg)

    # A marker that sweeps across the frame, so dropped or reordered frames are
    # obvious to the eye during playback.
    sweep_x = int((t_s * 80) % (WIDTH - 40))
    d.rectangle([sweep_x, HEIGHT - 60, sweep_x + 40, HEIGHT - 20], fill=(255, 0, 0))

    if is_clapper:
        d.text((24, 120), ">>> CLAPPER <<<", fill=(255, 0, 0))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def make_audio_block(block_index: int) -> bytes:
    n = SAMPLE_RATE * AUDIO_BLOCK_MS // 1000       # 320 samples
    t0 = block_index * n / SAMPLE_RATE
    t = t0 + np.arange(n) / SAMPLE_RATE

    # Quiet 220 Hz room tone, so silence is distinguishable from a dead stream.
    sig = 0.05 * np.sin(2 * math.pi * 220 * t)

    # 1 kHz beep, 60 ms, aligned to the clapper frame.
    beep_end = CLAPPER_AT_S + 0.06
    mask = (t >= CLAPPER_AT_S) & (t < beep_end)
    sig[mask] += 0.6 * np.sin(2 * math.pi * 1000 * t[mask])

    pcm = np.clip(sig * 32767, -32768, 32767).astype("<i2")
    return pcm.tobytes()


def build_clip(path: str, duration_s: float, t0_unix_ms: int, seed: int) -> int:
    rng = np.random.default_rng(seed)
    frame_count = int(duration_s * FPS)
    block_count = int(duration_s * 1000 / AUDIO_BLOCK_MS)
    clapper_frame = int(CLAPPER_AT_S * FPS)

    packets = []

    for i in range(frame_count):
        t_s = i / FPS
        packets.append(Packet(
            type=TYPE_VIDEO,
            pts_us=int(t_s * 1_000_000),
            payload=make_frame(i, t_s, i == clapper_frame, rng),
        ))

    for b in range(block_count):
        packets.append(Packet(
            type=TYPE_AUDIO,
            pts_us=int(b * AUDIO_BLOCK_MS * 1000),
            payload=make_audio_block(b),
        ))

    # Interleave by presentation time, exactly as the device writes them.
    packets.sort(key=lambda p: (p.pts_us, p.type))

    header = ClipHeader(
        width=WIDTH, height=HEIGHT, fps=FPS,
        audio_sample_rate=SAMPLE_RATE, audio_bits=16, audio_channels=1,
        t0_unix_ms=t0_unix_ms, has_audio=True,
    )

    with open(path, "wb") as f:
        return write_clip(f, header, packets)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=3, help="number of clips")
    ap.add_argument("--duration", type=float, default=10.0,
                    help="seconds per clip (use 60 for a realistic ~24 MB clip)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "clips"))
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    now_ms = int(time.time() * 1000)

    for i in range(args.count):
        clip_id = f"{i:04d}"
        path = os.path.join(args.out, f"{clip_id}.cap")
        # Space the clips out in the past so the gallery has varied timestamps.
        t0 = now_ms - (args.count - i) * 37 * 60 * 1000
        size = build_clip(path, args.duration, t0, seed=i)
        print(f"  {clip_id}.cap  {size/1_000_000:6.2f} MB  {args.duration:.0f}s")

    print(f"\nWrote {args.count} clip(s) to {args.out}")


if __name__ == "__main__":
    main()
