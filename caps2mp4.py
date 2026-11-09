#!/usr/bin/env python3
"""Convert a CapSure clip on the SD card into a playable MP4 (H.264 + AAC).

Usage: python3 caps2mp4.py /Volumes/<SD>/caps/clips/clip_0001.json [out.mp4] [--flip] [--keep-gaps]
  --flip       rotate 180 degrees (clips recorded before the firmware flipped the sensor)
  --keep-gaps  keep pauses (table out of view) as frozen frames instead of cutting them
Requires ffmpeg on PATH (macOS: brew install ffmpeg).
"""
import argparse, json, shutil, statistics, struct, subprocess, sys, tempfile, wave, zlib
from pathlib import Path

SEG_HDR = struct.Struct("<8sIIqqII")   # magic, version, segId, firstTs, lastTs, crc, packets (40 B)
PKT_HDR = struct.Struct("<B3xqI")      # type, pad, ts_us, len (16 B)
JPEG, PCM = 1, 2
NOMINAL_RATE = 16000
GAP_US = 500_000        # a jump this big between packets is a recording pause, not footage
FRAME_US = 41_667       # 24 fps: a closed gap keeps one frame's worth of time


def read_segment(path, expected_crc):
    data = path.read_bytes()
    magic, _ver, _id, _first, _last, crc, npk = SEG_HDR.unpack_from(data, 0)
    if magic != b"CAPS1SEG":
        raise ValueError(f"{path.name}: not a CAPS1 segment")
    body = data[SEG_HDR.size:]
    ok = zlib.crc32(body) == crc == expected_crc
    pkts, off = [], 0
    while off + PKT_HDR.size <= len(body):
        typ, ts, n = PKT_HDR.unpack_from(body, off)
        off += PKT_HDR.size
        pkts.append((typ, ts, body[off:off + n]))
        off += n
    return pkts, ok, npk


def main():
    ap = argparse.ArgumentParser(usage=__doc__)
    ap.add_argument("manifest")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--flip", action="store_true")
    ap.add_argument("--keep-gaps", action="store_true")
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    a = ap.parse_args()
    manifest = Path(a.manifest)
    out = Path(a.out) if a.out else manifest.with_suffix(".mp4")
    m = json.loads(manifest.read_text())
    seg_dir = manifest.parent.parent / "seg"
    start, end = m["start_us"], m["end_us"]

    # keep packets in CAPTURE order (segment id, then file order) -- never re-sort by timestamp
    # Recording pauses while the table is out of view, so the timestamps jump.
    # Shift everything after a jump back by (jump - one frame) so the pause is
    # cut out instead of showing up as a frozen frame (and silence).
    frames, audio, all_ok = [], [], True
    prev, shift, gaps = None, 0, []
    for s in sorted(m["segments"], key=lambda s: s["id"]):
        pkts, ok, npk = read_segment(seg_dir / f"{s['id']:08d}.cap", s["crc"])
        all_ok &= ok
        print(f"segment {s['id']:08d}: {len(pkts)}/{npk} packets, CRC {'OK' if ok else 'MISMATCH'}")
        for typ, ts, d in pkts:
            if not start <= ts <= end:                   # trim to the clip window
                continue
            if prev is not None and ts - prev > GAP_US and not a.keep_gaps:
                gaps.append(ts - prev)
                shift += ts - prev - FRAME_US
            prev = ts if prev is None else max(prev, ts)
            (frames if typ == JPEG else audio).append((ts - shift, d))
    if gaps:
        print(f"cut {len(gaps)} pause(s) totalling {sum(gaps) / 1e6:.1f} s "
              f"(longest {max(gaps) / 1e6:.1f} s)")
    if not frames:
        sys.exit("No video frames inside the clip window.")

    # ---------------- diagnostics ----------------
    t0 = min(frames[0][0], audio[0][0] if audio else frames[0][0])
    vspan = (frames[-1][0] - frames[0][0]) / 1e6
    iv = [(b[0] - a[0]) / 1e3 for a, b in zip(frames, frames[1:])]
    print(f"\nclip {m['clip']}: video {vspan:.2f} s, {len(frames)} frames ({len(frames) / max(vspan, 1e-6):.1f} fps)")
    if iv:
        print(f"  frame interval: median {statistics.median(iv):.1f} ms, max {max(iv):.0f} ms "
              f"(spec <= 83), >83 ms: {sum(g > 83 for g in iv)}, "
              f"bunched (<10 ms): {sum(g < 10 for g in iv)}, backwards: {sum(g < 0 for g in iv)}")

    rate = NOMINAL_RATE
    if audio:
        n_samp = sum(len(d) // 2 for _, d in audio)
        last_dur = (len(audio[-1][1]) // 2) / NOMINAL_RATE * 1e6
        aspan = (audio[-1][0] + last_dur - audio[0][0]) / 1e6
        measured = n_samp / aspan if aspan > 0 else NOMINAL_RATE
        jumps = sum(abs(b[0] - (a[0] + (len(a[1]) // 2) * 1e6 / NOMINAL_RATE)) > 5000
                    for a, b in zip(audio, audio[1:]))
        print(f"  audio: {len(audio)} blocks, {aspan:.2f} s, measured rate {measured:.0f} Hz "
              f"(nominal {NOMINAL_RATE}), timestamp jumps: {jumps}")
        if abs(measured - NOMINAL_RATE) / NOMINAL_RATE > 0.01:
            rate = int(round(measured))
            print(f"  -> audio rate is off by >1%; playing it at the measured {rate} Hz so it stays in sync")
    if not all_ok:
        print("WARNING: at least one segment failed its CRC check")

    tmp = Path(tempfile.mkdtemp(prefix="caps_"))
    try:
        # video: each frame shown until the next frame's timestamp (min 1 ms)
        lines = ["ffconcat version 1.0"]
        lead = (frames[0][0] - t0) / 1e6
        for i, (ts, d) in enumerate(frames):
            f = tmp / f"f{i:06d}.jpg"
            f.write_bytes(d)
            nxt = frames[i + 1][0] if i + 1 < len(frames) else ts + 41667
            dur = max((nxt - ts) / 1e6, 0.001) + (lead if i == 0 else 0)
            lines += [f"file '{f}'", f"duration {dur:.6f}"]
        lines.append(f"file '{tmp / f'f{len(frames) - 1:06d}.jpg'}'")
        (tmp / "frames.txt").write_text("\n".join(lines) + "\n")

        # audio: blocks laid end to end in capture order; timestamps only set the start
        # offset and fill real gaps (>1.5 blocks) with silence
        pcm = bytearray(int(round((audio[0][0] - t0) * rate / 1e6)) * 2 if audio else 0)
        expected = None
        for ts, d in audio:
            if expected is not None and ts - expected > 30000:
                pcm += bytes(int((ts - expected) * rate / 1e6) * 2)
            pcm += d
            expected = ts + (len(d) // 2) * 1e6 / rate
        with wave.open(str(tmp / "audio.wav"), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(bytes(pcm))

        subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                        "-f", "concat", "-safe", "0", "-i", str(tmp / "frames.txt"),
                        "-i", str(tmp / "audio.wav"),
                        *(["-vf", "hflip,vflip"] if a.flip else []),
                        "-fps_mode", "cfr", "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-ar", "48000", str(out)], check=True)
        print(f"\nwrote {out}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()