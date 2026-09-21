import { describe, expect, it } from 'vitest';

import { buildWav } from './wav';

const ascii = (buf: Uint8Array, at: number, len: number) =>
  String.fromCharCode(...buf.subarray(at, at + len));

describe('buildWav', () => {
  const fmt = { sampleRate: 16000, bitsPerSample: 16, channels: 1 };

  it('writes a header every player recognises', () => {
    const pcm = new Uint8Array(640);
    const wav = buildWav([pcm], fmt);
    const v = new DataView(wav.buffer);

    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(ascii(wav, 36, 4)).toBe('data');

    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16);
  });

  it('declares the sizes the data actually has', () => {
    const wav = buildWav([new Uint8Array(640), new Uint8Array(640)], fmt);
    const v = new DataView(wav.buffer);

    expect(wav.byteLength).toBe(44 + 1280);
    expect(v.getUint32(4, true)).toBe(36 + 1280);
    expect(v.getUint32(40, true)).toBe(1280);
  });

  it('concatenates the packets in order', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([5, 6, 7, 8]);
    const wav = buildWav([a, b], fmt);
    expect(Array.from(wav.subarray(44))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('handles a clip with no audio at all', () => {
    const wav = buildWav([], fmt);
    expect(wav.byteLength).toBe(44);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
  });
});
