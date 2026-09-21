/**
 * Wrap raw PCM in a WAV header.
 *
 * The device sends signed 16-bit mono PCM because that is what the I2S DMA
 * hands the firmware -- no encoder, no CPU cost, no battery cost. Phones will
 * not play raw PCM, but every phone plays WAV, and WAV *is* raw PCM with a
 * 44-byte header in front of it. So this is the entire audio pipeline.
 */

const HEADER_SIZE = 44;

export interface WavFormat {
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
}

export function buildWav(chunks: Uint8Array[], fmt: WavFormat): Uint8Array {
  const dataSize = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(HEADER_SIZE + dataSize);
  const v = new DataView(out.buffer);

  const blockAlign = (fmt.channels * fmt.bitsPerSample) / 8;
  const byteRate = fmt.sampleRate * blockAlign;

  writeAscii(out, 0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true); // file size minus the first 8 bytes
  writeAscii(out, 8, 'WAVE');

  writeAscii(out, 12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // 1 = PCM, uncompressed
  v.setUint16(22, fmt.channels, true);
  v.setUint32(24, fmt.sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, fmt.bitsPerSample, true);

  writeAscii(out, 36, 'data');
  v.setUint32(40, dataSize, true);

  let at = HEADER_SIZE;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }

  return out;
}

function writeAscii(buf: Uint8Array, at: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i);
}
