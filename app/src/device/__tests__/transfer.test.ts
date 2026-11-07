import { describe, expect, it } from 'vitest';

import { DeviceApiError, DeviceUnreachableError, TransferError } from '../client';
import { HEADER_SIZE, PACKET_HEADER_SIZE, PacketType } from '../clip';
import { IntegrityError, transferRemaining, verifyClip } from '../transfer';

const noSleep = async () => {};

function sink() {
  const parts: Uint8Array[] = [];
  return {
    parts,
    append: (b: Uint8Array) => parts.push(b.slice()),
    joined(): Uint8Array {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.byteLength;
      }
      return out;
    },
  };
}

/** A device that serves `data` by range and fails the calls listed in `failOn`. */
function device(data: Uint8Array, failOn: Record<number, () => Error> = {}) {
  let call = 0;
  const asked: [number, number][] = [];
  return {
    asked,
    fetchRange: async (start: number, end: number) => {
      const fail = failOn[call++];
      asked.push([start, end]);
      if (fail) throw fail();
      return data.slice(start, end + 1);
    },
  };
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

describe('transferRemaining', () => {
  it('fetches the clip in ordered chunks and appends each one', async () => {
    const data = bytes(10);
    const dev = device(data);
    const out = sink();
    await transferRemaining(10, 0, { ...dev, append: out.append, sleep: noSleep }, undefined, {
      chunkBytes: 4,
    });
    expect(dev.asked).toEqual([
      [0, 3],
      [4, 7],
      [8, 9],
    ]);
    expect(out.joined()).toEqual(data);
  });

  it('retries a dropped chunk and still produces the exact bytes', async () => {
    const data = bytes(10);
    const dev = device(data, {
      1: () => new DeviceUnreachableError(),
      2: () => new TransferError('short'),
    });
    const out = sink();
    await transferRemaining(10, 0, { ...dev, append: out.append, sleep: noSleep }, undefined, {
      chunkBytes: 4,
    });
    expect(out.joined()).toEqual(data);
    expect(dev.asked.filter(([s]) => s === 4)).toHaveLength(3);
  });

  it('resumes from bytes already on disk instead of starting over', async () => {
    const data = bytes(10);
    const dev = device(data);
    const out = sink();
    const progress: number[] = [];
    await transferRemaining(
      10,
      6,
      { ...dev, append: out.append, sleep: noSleep },
      (p) => progress.push(p.bytesReceived),
      { chunkBytes: 4 }
    );
    expect(dev.asked).toEqual([[6, 9]]);
    expect(out.joined()).toEqual(data.slice(6));
    expect(progress).toEqual([6, 10]);
  });

  it('gives up after the retry budget, keeping the chunks that did arrive', async () => {
    const data = bytes(10);
    const unreachable = () => new DeviceUnreachableError();
    const dev = device(data, { 1: unreachable, 2: unreachable, 3: unreachable, 4: unreachable });
    const out = sink();
    await expect(
      transferRemaining(10, 0, { ...dev, append: out.append, sleep: noSleep }, undefined, {
        chunkBytes: 4,
        retries: 3,
      })
    ).rejects.toBeInstanceOf(DeviceUnreachableError);
    expect(out.joined()).toEqual(data.slice(0, 4));
  });

  it('does not retry an error a retry cannot fix', async () => {
    const dev = device(bytes(10), {
      0: () => new DeviceApiError(404, { error: 'clip_not_found', message: 'gone' }),
    });
    const out = sink();
    await expect(
      transferRemaining(10, 0, { ...dev, append: out.append, sleep: noSleep })
    ).rejects.toBeInstanceOf(DeviceApiError);
    expect(dev.asked).toHaveLength(1);
  });
});

describe('transferRemaining in parallel', () => {
  // Answers each range after a delay, so later chunks can finish first.
  function slowDevice(data: Uint8Array, delayFor: (start: number) => number) {
    let inFlight = 0;
    let peak = 0;
    return {
      get peak() {
        return peak;
      },
      fetchRange: async (start: number, end: number) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, delayFor(start)));
        inFlight--;
        return data.slice(start, end + 1);
      },
    };
  }

  it('keeps several chunks in flight and still writes the bytes in order', async () => {
    const data = bytes(40);
    // The first chunk is the slowest, so chunks 2-4 arrive before it.
    const dev = slowDevice(data, (start) => (start === 0 ? 30 : 5));
    const out = sink();
    const seen: number[] = [];
    await transferRemaining(
      40,
      0,
      { fetchRange: dev.fetchRange, append: out.append, sleep: noSleep },
      (p) => seen.push(p.bytesReceived),
      { chunkBytes: 4, parallel: 4 }
    );
    expect(out.joined()).toEqual(data);
    expect(dev.peak).toBe(4);
    // Progress only ever moves forward, one contiguous chunk at a time.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[seen.length - 1]).toBe(40);
  });

  it('never buffers far ahead of the file while one chunk is stuck', async () => {
    const data = bytes(80);
    let maxAhead = 0;
    let appended = 0;
    let requested = 0;
    const dev = {
      fetchRange: async (start: number, end: number) => {
        requested = Math.max(requested, end + 1);
        maxAhead = Math.max(maxAhead, requested - appended);
        await new Promise((r) => setTimeout(r, start === 0 ? 40 : 1));
        return data.slice(start, end + 1);
      },
    };
    const out = sink();
    await transferRemaining(
      80,
      0,
      {
        fetchRange: dev.fetchRange,
        append: (b) => {
          out.append(b);
          appended += b.byteLength;
        },
        sleep: noSleep,
      },
      undefined,
      { chunkBytes: 4, parallel: 2 }
    );
    expect(out.joined()).toEqual(data);
    expect(maxAhead).toBeLessThanOrEqual((2 + 1) * 4);
  });

  it('resumes from bytes already on disk', async () => {
    const data = bytes(20);
    const dev = slowDevice(data, () => 1);
    const out = sink();
    await transferRemaining(
      20,
      8,
      { fetchRange: dev.fetchRange, append: out.append, sleep: noSleep },
      undefined,
      { chunkBytes: 4, parallel: 3 }
    );
    expect(out.joined()).toEqual(data.slice(8));
  });

  it('on a dead chunk, stops and keeps only the contiguous bytes before it', async () => {
    const data = bytes(40);
    const fetchRange = async (start: number, end: number) => {
      if (start === 8) throw new DeviceUnreachableError();
      await new Promise((r) => setTimeout(r, 1));
      return data.slice(start, end + 1);
    };
    const out = sink();
    await expect(
      transferRemaining(40, 0, { fetchRange, append: out.append, sleep: noSleep }, undefined, {
        chunkBytes: 4,
        parallel: 3,
        retries: 1,
      })
    ).rejects.toBeInstanceOf(DeviceUnreachableError);
    // Chunks after the dead one may have arrived, but nothing past the gap is written.
    expect(out.joined()).toEqual(data.slice(0, 8));
  });
});

function tinyClip(): Uint8Array {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const out = new Uint8Array(HEADER_SIZE + PACKET_HEADER_SIZE + jpeg.byteLength);
  const v = new DataView(out.buffer);
  out.set([0x43, 0x41, 0x50, 0x53], 0);
  v.setUint8(4, 1);
  v.setUint16(6, 640, true);
  v.setUint16(8, 480, true);
  v.setUint16(10, 15, true);
  v.setUint32(12, 16000, true);
  v.setUint8(16, 16);
  v.setUint8(17, 1);
  v.setUint32(28, 1, true);
  v.setUint8(HEADER_SIZE, PacketType.Video);
  v.setUint32(HEADER_SIZE + 8, jpeg.byteLength, true);
  out.set(jpeg, HEADER_SIZE + PACKET_HEADER_SIZE);
  return out;
}

describe('verifyClip', () => {
  const clip = tinyClip();
  const meta = { bytes: clip.byteLength, width: 640, height: 480, fps: 15 };

  it('passes a complete clip that matches its listing', () => {
    expect(() => verifyClip(meta, clip)).not.toThrow();
  });

  it('fails a clip that is the wrong size', () => {
    expect(() => verifyClip(meta, clip.slice(0, -1))).toThrow(IntegrityError);
  });

  it('fails a clip whose bytes do not parse', () => {
    const bad = clip.slice();
    bad[0] = 0;
    expect(() => verifyClip(meta, bad)).toThrow(IntegrityError);
  });

  it('fails a clip with a corrupted packet length', () => {
    const bad = clip.slice();
    new DataView(bad.buffer).setUint32(HEADER_SIZE + 8, 9999, true);
    expect(() => verifyClip(meta, bad)).toThrow(IntegrityError);
  });

  it('fails a clip that is not the one the device listed', () => {
    expect(() => verifyClip({ ...meta, fps: 30 }, clip)).toThrow(IntegrityError);
  });

  it('only size-checks QuickTime files', () => {
    const mov = bytes(20);
    expect(() => verifyClip({ ...meta, bytes: 20, format: 'mov' }, mov)).not.toThrow();
    expect(() => verifyClip({ ...meta, bytes: 21, format: 'mov' }, mov)).toThrow(IntegrityError);
  });
});
