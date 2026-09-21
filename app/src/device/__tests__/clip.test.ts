import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ClipParseError,
  HEADER_SIZE,
  PACKET_HEADER_SIZE,
  PacketType,
  avDriftMs,
  frameIndexAt,
  indexClip,
  parseHeader,
  payloadOf,
} from '../clip';

/**
 * A CAPS1 writer, mirroring mock-device/capsfile.py. Having one here lets the
 * parser be tested without the mock running -- and the last test in this file
 * checks the two implementations actually agree on real bytes.
 */
function buildClip(opts: {
  fps?: number;
  sampleRate?: number;
  frames?: { ptsUs: number; payload: Uint8Array }[];
  audio?: { ptsUs: number; payload: Uint8Array }[];
  t0UnixMs?: number;
  magic?: string;
  version?: number;
  packetCountOverride?: number;
}): Uint8Array {
  const fps = opts.fps ?? 15;
  const sampleRate = opts.sampleRate ?? 16000;
  const frames = opts.frames ?? [];
  const audio = opts.audio ?? [];

  const packets = [
    ...frames.map((f) => ({ type: PacketType.Video, ...f })),
    ...audio.map((a) => ({ type: PacketType.Audio, ...a })),
  ].sort((a, b) => a.ptsUs - b.ptsUs || a.type - b.type);

  const size =
    HEADER_SIZE +
    packets.reduce((n, p) => n + PACKET_HEADER_SIZE + p.payload.byteLength, 0);

  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);

  const magic = opts.magic ?? 'CAPS';
  for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
  v.setUint8(4, opts.version ?? 1);
  v.setUint8(5, audio.length ? 0x01 : 0x00);
  v.setUint16(6, 640, true);
  v.setUint16(8, 480, true);
  v.setUint16(10, fps, true);
  v.setUint32(12, sampleRate, true);
  v.setUint8(16, 16);
  v.setUint8(17, 1);
  v.setUint16(18, 0, true);
  v.setBigUint64(20, BigInt(opts.t0UnixMs ?? 0), true);
  v.setUint32(28, opts.packetCountOverride ?? packets.length, true);

  let at = HEADER_SIZE;
  for (const p of packets) {
    v.setUint8(at, p.type);
    v.setUint8(at + 1, 0);
    v.setUint16(at + 2, 0, true);
    v.setUint32(at + 4, p.ptsUs, true);
    v.setUint32(at + 8, p.payload.byteLength, true);
    out.set(p.payload, at + PACKET_HEADER_SIZE);
    at += PACKET_HEADER_SIZE + p.payload.byteLength;
  }

  return out;
}

const jpeg = (n: number) =>
  new Uint8Array([0xff, 0xd8, ...new Array(n).fill(0x42), 0xff, 0xd9]);
const pcm = (samples: number) => new Uint8Array(samples * 2);

describe('parseHeader', () => {
  it('reads every field', () => {
    const clip = buildClip({ t0UnixMs: 1758470000000 });
    const h = parseHeader(clip);
    expect(h.width).toBe(640);
    expect(h.height).toBe(480);
    expect(h.fps).toBe(15);
    expect(h.audioSampleRate).toBe(16000);
    expect(h.audioBits).toBe(16);
    expect(h.audioChannels).toBe(1);
    expect(h.t0UnixMs).toBe(1758470000000);
  });

  it('rejects a buffer that is not a clip', () => {
    expect(() => parseHeader(buildClip({ magic: 'JUNK' }))).toThrow(ClipParseError);
  });

  it('rejects a future format version rather than guessing', () => {
    expect(() => parseHeader(buildClip({ version: 2 }))).toThrow(/version 2/);
  });

  it('rejects a buffer shorter than the header', () => {
    expect(() => parseHeader(new Uint8Array(10))).toThrow(/shorter than/);
  });
});

describe('indexClip', () => {
  it('separates the two streams and keeps them in order', () => {
    const clip = buildClip({
      frames: [
        { ptsUs: 0, payload: jpeg(100) },
        { ptsUs: 66_666, payload: jpeg(120) },
        { ptsUs: 133_333, payload: jpeg(110) },
      ],
      audio: [
        { ptsUs: 0, payload: pcm(320) },
        { ptsUs: 20_000, payload: pcm(320) },
      ],
    });

    const idx = indexClip(clip);
    expect(idx.video).toHaveLength(3);
    expect(idx.audio).toHaveLength(2);
    expect(idx.video.map((f) => f.ptsUs)).toEqual([0, 66_666, 133_333]);
  });

  it('hands back payloads without copying the buffer', () => {
    const frame = jpeg(50);
    const clip = buildClip({ frames: [{ ptsUs: 0, payload: frame }] });
    const idx = indexClip(clip);
    const got = payloadOf(clip, idx.video[0]);
    expect(Array.from(got)).toEqual(Array.from(frame));
  });

  it('measures duration to the end of content, not the last timestamp', () => {
    // Last frame starts at 133_333us; at 15fps it is on screen until 200_000us.
    const clip = buildClip({
      frames: [
        { ptsUs: 0, payload: jpeg(10) },
        { ptsUs: 66_666, payload: jpeg(10) },
        { ptsUs: 133_333, payload: jpeg(10) },
      ],
    });
    expect(indexClip(clip).durationUs).toBeCloseTo(200_000, -2);
  });

  // This is the failure a dropped Wi-Fi connection produces, so it needs to
  // come back as a clear error rather than a crash or a half-played clip.
  it('reports truncation instead of producing a partial clip', () => {
    const clip = buildClip({
      frames: [
        { ptsUs: 0, payload: jpeg(100) },
        { ptsUs: 66_666, payload: jpeg(100) },
      ],
    });
    expect(() => indexClip(clip.subarray(0, clip.byteLength - 40))).toThrow(
      /truncated/
    );
  });

  it('rejects a packet count that does not match the body', () => {
    const clip = buildClip({
      frames: [{ ptsUs: 0, payload: jpeg(10) }],
      packetCountOverride: 5,
    });
    expect(() => indexClip(clip)).toThrow(/truncated/);
  });

  it('rejects timestamps that go backwards', () => {
    const bad = buildClip({
      frames: [
        { ptsUs: 100_000, payload: jpeg(10) },
        { ptsUs: 200_000, payload: jpeg(10) },
      ],
    });
    expect(() => indexClip(bad)).not.toThrow();

    // Rewind the second frame's pts behind the first. Ask the parser where the
    // packet is rather than doing the offset arithmetic by hand.
    const secondPayloadAt = indexClip(bad).video[1].offset;
    const ptsField = secondPayloadAt - PACKET_HEADER_SIZE + 4;
    new DataView(bad.buffer).setUint32(ptsField, 0, true);

    expect(() => indexClip(bad)).toThrow(/backwards in time/);
  });
});

describe('frameIndexAt', () => {
  const clip = buildClip({
    frames: [0, 66_666, 133_333, 200_000].map((ptsUs) => ({
      ptsUs,
      payload: jpeg(10),
    })),
  });
  const { video } = indexClip(clip);

  it('holds the current frame until the next one is due', () => {
    expect(frameIndexAt(video, 0)).toBe(0);
    expect(frameIndexAt(video, 66_665)).toBe(0);
    expect(frameIndexAt(video, 66_666)).toBe(1);
    expect(frameIndexAt(video, 150_000)).toBe(2);
  });

  it('clamps outside the clip', () => {
    expect(frameIndexAt(video, -1)).toBe(0);
    expect(frameIndexAt(video, 99_999_999)).toBe(3);
    expect(frameIndexAt([], 0)).toBe(-1);
  });
});

describe('avDriftMs', () => {
  it('is zero when both streams end together', () => {
    // 3 frames at 15fps end at 200ms; 10 audio blocks of 20ms end at 200ms.
    const clip = buildClip({
      frames: [0, 66_666, 133_333].map((ptsUs) => ({ ptsUs, payload: jpeg(10) })),
      audio: Array.from({ length: 10 }, (_, i) => ({
        ptsUs: i * 20_000,
        payload: pcm(320),
      })),
    });
    expect(Math.abs(avDriftMs(indexClip(clip)))).toBeLessThan(1);
  });

  it('is positive when video outruns audio', () => {
    const clip = buildClip({
      frames: [0, 66_666, 133_333].map((ptsUs) => ({ ptsUs, payload: jpeg(10) })),
      audio: [{ ptsUs: 0, payload: pcm(320) }],
    });
    expect(avDriftMs(indexClip(clip))).toBeGreaterThan(100);
  });
});

/**
 * Cross-check: the TypeScript parser against bytes written by the Python
 * writer. If these two ever disagree, the format has drifted and the firmware
 * has no stable target. Skipped when the mock has not generated clips yet.
 */
describe('agreement with mock-device/capsfile.py', () => {
  const clipsDir = join(__dirname, '../../../../mock-device/clips');
  const files = existsSync(clipsDir)
    ? readdirSync(clipsDir).filter((f) => f.endsWith('.cap'))
    : [];

  it.skipIf(files.length === 0)('parses a real generated clip', () => {
    const bytes = new Uint8Array(readFileSync(join(clipsDir, files[0])));
    const idx = indexClip(bytes);

    expect(idx.header.width).toBe(640);
    expect(idx.header.height).toBe(480);
    expect(idx.header.fps).toBe(15);
    expect(idx.header.audioSampleRate).toBe(16000);
    expect(idx.header.hasAudio).toBe(true);
    expect(idx.video.length).toBeGreaterThan(0);
    expect(idx.audio.length).toBeGreaterThan(0);

    // Every video payload must be a real JPEG.
    for (const ref of idx.video.slice(0, 20)) {
      const p = payloadOf(bytes, ref);
      expect(p[0]).toBe(0xff);
      expect(p[1]).toBe(0xd8);
      expect(p[p.byteLength - 2]).toBe(0xff);
      expect(p[p.byteLength - 1]).toBe(0xd9);
    }

    // And the two streams must line up, which is the whole requirement.
    expect(Math.abs(avDriftMs(idx))).toBeLessThan(40);
  });
});
