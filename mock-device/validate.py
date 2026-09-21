#!/usr/bin/env python3
"""
Validate a CAPS1 clip and report A/V sync.

Point this at output from the real device as soon as the firmware writes its
first segment. An unparseable clip found in week 4 is an afternoon; found in
week 11 it is the project.

    python3 validate.py /tmp/0042.cap
"""

import argparse
import os
import sys

from capsfile import (
    ClipHeader, HEADER_SIZE, read_packets, TYPE_VIDEO, TYPE_AUDIO,
)

JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"


def validate(path: str) -> int:
    size = os.path.getsize(path)
    problems = []
    warnings = []

    with open(path, "rb") as f:
        header = ClipHeader.unpack(f.read(HEADER_SIZE))

        print(f"file            {path}")
        print(f"size            {size:,} bytes ({size/1e6:.2f} MB)")
        print(f"resolution      {header.width}x{header.height} @ {header.fps} fps")
        print(f"audio           {header.audio_sample_rate} Hz, "
              f"{header.audio_bits}-bit, {header.audio_channels} ch, "
              f"present={header.has_audio}")
        print(f"t0_unix_ms      {header.t0_unix_ms}"
              f"{'  (clock never set)' if header.t0_unix_ms == 0 else ''}")
        print(f"packet_count    {header.packet_count}")
        print()

        n_video = n_audio = 0
        video_bytes = audio_bytes = 0
        last_pts = -1
        last_video_pts = 0
        last_audio_pts = 0
        last_audio_samples = 0
        seen = 0

        for p in read_packets(f, header.packet_count):
            seen += 1

            if p.pts_us < last_pts:
                problems.append(
                    f"packet {seen}: pts went backwards "
                    f"({p.pts_us} after {last_pts})"
                )
            last_pts = p.pts_us

            if p.type == TYPE_VIDEO:
                n_video += 1
                video_bytes += len(p.payload)
                last_video_pts = p.pts_us
                if not p.payload.startswith(JPEG_SOI):
                    problems.append(f"packet {seen}: video payload is not a JPEG "
                                    f"(no SOI marker)")
                elif not p.payload.rstrip(b"\x00").endswith(JPEG_EOI):
                    warnings.append(f"packet {seen}: JPEG has no EOI marker "
                                    f"(truncated frame?)")
            elif p.type == TYPE_AUDIO:
                n_audio += 1
                audio_bytes += len(p.payload)
                last_audio_pts = p.pts_us
                last_audio_samples = len(p.payload) // 2
                if len(p.payload) % 2 != 0:
                    problems.append(f"packet {seen}: odd PCM length "
                                    f"{len(p.payload)} (not 16-bit aligned)")
            else:
                problems.append(f"packet {seen}: unknown type {p.type}")

        if seen != header.packet_count:
            problems.append(
                f"header claims {header.packet_count} packets, found {seen}"
            )

        # End of *content*, not of the last timestamp: a stream ends when its
        # final unit finishes playing, not when it starts.
        video_end_s = (last_video_pts / 1e6 + 1.0 / header.fps) if n_video else 0.0
        audio_end_s = (
            last_audio_pts / 1e6 + last_audio_samples / header.audio_sample_rate
        ) if n_audio else 0.0
        duration_s = max(video_end_s, audio_end_s)

        print(f"video packets   {n_video:6d}   {video_bytes/1e6:7.2f} MB")
        print(f"audio packets   {n_audio:6d}   {audio_bytes/1e6:7.2f} MB")
        print(f"duration        {duration_s:.3f} s")

        if duration_s > 0:
            measured_fps = n_video / video_end_s if video_end_s else 0
            print(f"measured fps    {measured_fps:.2f}  (header says {header.fps})")
            if abs(measured_fps - header.fps) > header.fps * 0.1:
                warnings.append(
                    f"measured fps {measured_fps:.2f} is >10% off the declared "
                    f"{header.fps}"
                )

            if header.has_audio and n_audio:
                samples = audio_bytes // 2
                measured_rate = samples / audio_end_s if audio_end_s else 0
                print(f"measured audio  {measured_rate:.0f} Hz  "
                      f"(header says {header.audio_sample_rate})")
                if abs(measured_rate - header.audio_sample_rate) > \
                        header.audio_sample_rate * 0.02:
                    warnings.append(
                        f"measured audio rate {measured_rate:.0f} Hz is >2% off "
                        f"the declared {header.audio_sample_rate}"
                    )

                # The number that matters: how far apart the two streams ended.
                drift_ms = (video_end_s - audio_end_s) * 1000.0
                print(f"A/V drift       {drift_ms:+.1f} ms at end of clip")
                if abs(drift_ms) > 100:
                    problems.append(
                        f"A/V drift {drift_ms:+.1f} ms exceeds 100 ms -- audio and "
                        f"video will look out of sync"
                    )
                elif abs(drift_ms) > 40:
                    warnings.append(
                        f"A/V drift {drift_ms:+.1f} ms is past the 40 ms "
                        f"perceptual threshold"
                    )

        if n_video:
            print(f"avg frame       {video_bytes/n_video/1024:.1f} KB")
        if duration_s > 0:
            print(f"data rate       {size/duration_s/1000:.0f} KB/s")

    print()
    for w in warnings:
        print(f"WARN   {w}")
    for p in problems:
        print(f"FAIL   {p}")

    if problems:
        print(f"\n{len(problems)} problem(s). Clip is not valid.")
        return 1
    print("OK" + (f" ({len(warnings)} warning(s))" if warnings else ""))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip", help="path to a .cap file")
    args = ap.parse_args()
    try:
        sys.exit(validate(args.clip))
    except ValueError as e:
        print(f"FAIL   {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
