/**
 * CAPS1 container parser.
 *
 * This file is normative: it and mock-device/capsfile.py define the format, and
 * the firmware is checked against them. See docs/api.md section 4.
 *
 * Deliberately has no React Native imports, so it runs under vitest on a laptop.
 *
 * Parsing returns *offsets* into the buffer rather than copies. A 60-second clip
 * is ~28 MB; copying every frame out would triple that for no reason.
 */

export const HEADER_SIZE = 32;
export const PACKET_HEADER_SIZE = 12;
export const VERSION = 1;

export const PacketType = {
  Video: 1,
  Audio: 2,
} as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export interface ClipHeader {
  version: number;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  audioSampleRate: number;
  audioBits: number;
  audioChannels: number;
  /** Wall clock of the first packet. 0 means the device's clock was never set. */
  t0UnixMs: number;
  packetCount: number;
}

/** A packet located inside the clip buffer, not copied out of it. */
export interface PacketRef {
  type: PacketType;
  ptsUs: number;
  /** Offset of the payload (not the packet header) within the clip buffer. */
  offset: number;
  length: number;
}

export interface ClipIndex {
  header: ClipHeader;
  video: PacketRef[];
  audio: PacketRef[];
  /** End of content, so the last frame and last audio block are included. */
  durationUs: number;
}

export class ClipParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClipParseError';
  }
}

function asDataView(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function parseHeader(data: Uint8Array): ClipHeader {
  if (data.byteLength < HEADER_SIZE) {
    throw new ClipParseError(
      `clip is ${data.byteLength} bytes, shorter than the ${HEADER_SIZE}-byte header`
    );
  }

  const v = asDataView(data);
  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (magic !== 'CAPS') {
    throw new ClipParseError(`bad magic "${magic}", expected "CAPS"`);
  }

  const version = v.getUint8(4);
  if (version !== VERSION) {
    throw new ClipParseError(
      `unsupported clip version ${version}, this app speaks ${VERSION}`
    );
  }

  const flags = v.getUint8(5);

  return {
    version,
    hasAudio: (flags & 0x01) !== 0,
    width: v.getUint16(6, true),
    height: v.getUint16(8, true),
    fps: v.getUint16(10, true),
    audioSampleRate: v.getUint32(12, true),
    audioBits: v.getUint8(16),
    audioChannels: v.getUint8(17),
    // Safe as a Number until year 287396.
    t0UnixMs: Number(v.getBigUint64(20, true)),
    packetCount: v.getUint32(28, true),
  };
}

/**
 * Walk every packet and build an index. Throws on truncation, which is what a
 * download interrupted mid-transfer looks like.
 */
export function indexClip(data: Uint8Array): ClipIndex {
  const header = parseHeader(data);
  const v = asDataView(data);

  const video: PacketRef[] = [];
  const audio: PacketRef[] = [];

  let pos = HEADER_SIZE;
  let lastPts = -1;

  for (let i = 0; i < header.packetCount; i++) {
    if (pos + PACKET_HEADER_SIZE > data.byteLength) {
      throw new ClipParseError(
        `clip truncated: packet ${i + 1} of ${header.packetCount} has no header ` +
          `(at byte ${pos} of ${data.byteLength})`
      );
    }

    const type = v.getUint8(pos) as PacketType;
    const ptsUs = v.getUint32(pos + 4, true);
    const length = v.getUint32(pos + 8, true);
    const payloadAt = pos + PACKET_HEADER_SIZE;

    if (payloadAt + length > data.byteLength) {
      throw new ClipParseError(
        `clip truncated: packet ${i + 1} wants ${length} bytes at ${payloadAt}, ` +
          `only ${data.byteLength - payloadAt} remain`
      );
    }

    if (ptsUs < lastPts) {
      throw new ClipParseError(
        `packet ${i + 1} goes backwards in time (${ptsUs}us after ${lastPts}us)`
      );
    }
    lastPts = ptsUs;

    const ref: PacketRef = { type, ptsUs, offset: payloadAt, length };
    if (type === PacketType.Video) {
      video.push(ref);
    } else if (type === PacketType.Audio) {
      audio.push(ref);
    } else {
      throw new ClipParseError(`packet ${i + 1} has unknown type ${type}`);
    }

    pos = payloadAt + length;
  }

  // A stream ends when its last unit finishes playing, not when it starts.
  const videoEndUs = video.length
    ? video[video.length - 1].ptsUs + 1_000_000 / header.fps
    : 0;
  const lastAudio = audio[audio.length - 1];
  const audioEndUs = lastAudio
    ? lastAudio.ptsUs +
      (lastAudio.length / 2 / header.audioSampleRate) * 1_000_000
    : 0;

  return {
    header,
    video,
    audio,
    durationUs: Math.max(videoEndUs, audioEndUs),
  };
}

/** Copy one packet's payload out of the clip buffer. */
export function payloadOf(data: Uint8Array, ref: PacketRef): Uint8Array {
  return data.subarray(ref.offset, ref.offset + ref.length);
}

/**
 * How far apart the two streams end, in milliseconds. Positive means video runs
 * longer than audio. This is the number the clapperboard test produces.
 */
export function avDriftMs(index: ClipIndex): number {
  if (!index.video.length || !index.audio.length) return 0;
  const videoEnd =
    index.video[index.video.length - 1].ptsUs + 1_000_000 / index.header.fps;
  const last = index.audio[index.audio.length - 1];
  const audioEnd =
    last.ptsUs + (last.length / 2 / index.header.audioSampleRate) * 1_000_000;
  return (videoEnd - audioEnd) / 1000;
}

/** Index of the frame that should be on screen at a given playback time. */
export function frameIndexAt(video: PacketRef[], timeUs: number): number {
  if (!video.length) return -1;
  let lo = 0;
  let hi = video.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (video[mid].ptsUs <= timeUs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
