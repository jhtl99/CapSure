"""Read a local video as the starting point for CapSure CV processing."""

import argparse
from pathlib import Path

import cv2


def inspect_video(video_path: Path) -> None:
    if not video_path.is_file():
        raise ValueError(f"Video file does not exist: {video_path}")

    capture = cv2.VideoCapture(str(video_path))
    try:
        if not capture.isOpened():
            raise ValueError(f"Could not open video: {video_path}")

        frame_count = 0
        resolution = None
        while True:
            success, frame = capture.read()
            if not success:
                break
            frame_count += 1
            height, width = frame.shape[:2]
            resolution = (width, height)
            # Add per-frame CV processing here.

        if frame_count == 0:
            raise ValueError(f"No readable frames found in: {video_path}")

        print(f"Video: {video_path}")
        print(f"Frames read: {frame_count}")
        print(f"Last frame resolution: {resolution[0]} x {resolution[1]}")
    finally:
        capture.release()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path, help="Path to a local video file")
    args = parser.parse_args()
    try:
        inspect_video(args.video)
    except ValueError as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
