"""
CAPS1 container: the normative reader/writer.

This file and app/src/device/clip.ts must agree byte for byte. The firmware is
checked against them, not the other way round. See docs/api.md section 4.
"""

import struct
from dataclasses import dataclass
from typing import BinaryIO, Iterator, List

MAGIC = b"CAPS"
VERSION = 1

FLAG_HAS_AUDIO = 0x01

TYPE_VIDEO = 1
TYPE_AUDIO = 2

# <4sBBHHHIBBHQI  == 32 bytes, little-endian, no padding
HEADER_FMT = "<4sBBHHHIBBHQI"
HEADER_SIZE = struct.calcsize(HEADER_FMT)

# <BBHII == 12 bytes
PACKET_FMT = "<BBHII"
PACKET_SIZE = struct.calcsize(PACKET_FMT)

assert HEADER_SIZE == 32, HEADER_SIZE
assert PACKET_SIZE == 12, PACKET_SIZE


@dataclass
class ClipHeader:
    width: int = 640
    height: int = 480
    fps: int = 15
    audio_sample_rate: int = 16000
    audio_bits: int = 16
    audio_channels: int = 1
    t0_unix_ms: int = 0
    packet_count: int = 0
    has_audio: bool = True

    def pack(self) -> bytes:
        flags = FLAG_HAS_AUDIO if self.has_audio else 0
        return struct.pack(
            HEADER_FMT,
            MAGIC,
            VERSION,
            flags,
            self.width,
            self.height,
            self.fps,
            self.audio_sample_rate,
            self.audio_bits,
            self.audio_channels,
            0,
            self.t0_unix_ms,
            self.packet_count,
        )

    @classmethod
    def unpack(cls, raw: bytes) -> "ClipHeader":
        if len(raw) < HEADER_SIZE:
            raise ValueError(f"header too short: {len(raw)} < {HEADER_SIZE}")
        (
            magic, version, flags, width, height, fps,
            rate, bits, channels, _reserved, t0, count,
        ) = struct.unpack(HEADER_FMT, raw[:HEADER_SIZE])

        if magic != MAGIC:
            raise ValueError(f"bad magic {magic!r}, expected {MAGIC!r}")
        if version != VERSION:
            raise ValueError(f"unsupported version {version}")

        return cls(
            width=width, height=height, fps=fps,
            audio_sample_rate=rate, audio_bits=bits, audio_channels=channels,
            t0_unix_ms=t0, packet_count=count,
            has_audio=bool(flags & FLAG_HAS_AUDIO),
        )


@dataclass
class Packet:
    type: int
    pts_us: int
    payload: bytes

    def pack(self) -> bytes:
        return struct.pack(
            PACKET_FMT, self.type, 0, 0, self.pts_us, len(self.payload)
        ) + self.payload


def write_clip(f: BinaryIO, header: ClipHeader, packets: List[Packet]) -> int:
    """Write a complete clip. Returns total bytes written."""
    header.packet_count = len(packets)
    f.write(header.pack())
    total = HEADER_SIZE
    for p in packets:
        b = p.pack()
        f.write(b)
        total += len(b)
    return total


def read_packets(f: BinaryIO, count: int) -> Iterator[Packet]:
    """Stream packets out of an open file positioned just past the header."""
    for _ in range(count):
        raw = f.read(PACKET_SIZE)
        if len(raw) < PACKET_SIZE:
            return
        ptype, _r1, _r2, pts_us, length = struct.unpack(PACKET_FMT, raw)
        payload = f.read(length)
        if len(payload) < length:
            raise ValueError(
                f"truncated payload: wanted {length}, got {len(payload)}"
            )
        yield Packet(type=ptype, pts_us=pts_us, payload=payload)
