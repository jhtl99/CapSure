/**
 * Moving one clip off the device, independent of where the bytes land.
 *
 * The clip comes over in Range chunks and each chunk is appended to a partial
 * file. A dropped connection costs at most one chunk: the next attempt, or the
 * next tap, asks for the bytes after what is already on disk. Then the whole
 * file is checked before anyone is allowed to tell the device it may reclaim
 * the space -- an ack on a bad copy would let the device overwrite the only
 * good one.
 *
 * No React Native imports, so the loop and the checks run under vitest.
 */

import { ClipParseError, indexClip } from './clip';
import { DeviceUnreachableError, TransferError } from './client';
import type { ClipMeta } from './types';

/** Big enough that per-request overhead is small, small enough that a drop is cheap. */
export const CHUNK_BYTES = 1024 * 1024;

/** A chunk at a bad-day 250 KB/s still fits. */
export const CHUNK_TIMEOUT_MS = 15000;

/** Back-to-back attempts on one chunk before the download gives up for now. */
export const CHUNK_RETRIES = 3;

/** The clip downloaded fully but is not the clip the device described. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export interface TransferProgress {
  bytesReceived: number;
  bytesExpected: number;
  fraction: number;
}

export interface TransferIO {
  /** Inclusive byte range of the clip, exactly as asked or it throws. */
  fetchRange: (start: number, end: number) => Promise<Uint8Array>;
  /** Append to the partial file. */
  append: (bytes: Uint8Array) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Errors that a second try might fix. Anything else is reported at once. */
export function isRetryable(e: unknown): boolean {
  return e instanceof DeviceUnreachableError || e instanceof TransferError;
}

/**
 * Fill bytes `startAt` through `total - 1`. Returns once the partial file holds
 * the whole clip; throws once a chunk has failed `retries + 1` times in a row,
 * leaving everything already appended in place for the next call.
 *
 * With `parallel > 1`, that many chunks are in flight at once, each on its own
 * request (and so its own TCP connection). The device's TCP send buffer is
 * small, so one connection spends most of its time waiting for acks; several
 * keep the radio busy. Chunks can arrive out of order, so finished ones wait
 * here until everything before them has been appended: the file only ever
 * grows contiguously, and resume works exactly as it does with one connection.
 */
export async function transferRemaining(
  total: number,
  startAt: number,
  io: TransferIO,
  onProgress?: (p: TransferProgress) => void,
  { chunkBytes = CHUNK_BYTES, retries = CHUNK_RETRIES, parallel = 1 } = {}
): Promise<void> {
  const sleep = io.sleep ?? defaultSleep;
  let appended = startAt;            // bytes in the partial file
  let nextStart = startAt;           // next chunk nobody has claimed yet
  let failure: unknown = null;
  const finished = new Map<number, Uint8Array>();
  // Never hold more than this many bytes ahead of the file, even if one chunk is slow.
  const maxAhead = (Math.max(1, parallel) + 1) * chunkBytes;
  let wake: (() => void)[] = [];

  const report = () =>
    onProgress?.({
      bytesReceived: appended,
      bytesExpected: total,
      fraction: total > 0 ? appended / total : 0,
    });
  report();

  const fetchChunk = async (start: number): Promise<Uint8Array> => {
    const end = Math.min(start + chunkBytes, total) - 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await io.fetchRange(start, end);
      } catch (e) {
        if (!isRetryable(e) || attempt >= retries || failure) throw e;
        await sleep(500 * 2 ** attempt);
      }
    }
  };

  const flush = () => {
    while (finished.has(appended)) {
      const bytes = finished.get(appended)!;
      finished.delete(appended);
      io.append(bytes);
      appended += bytes.byteLength;
      report();
    }
    const w = wake;
    wake = [];
    w.forEach((f) => f());
  };

  const worker = async () => {
    while (!failure && nextStart < total) {
      if (nextStart - appended >= maxAhead) {
        await new Promise<void>((r) => wake.push(r));
        continue;
      }
      const start = nextStart;
      nextStart = Math.min(start + chunkBytes, total);
      try {
        finished.set(start, await fetchChunk(start));
        flush();
      } catch (e) {
        if (!failure) failure = e;
        flush();                     // release anyone waiting so they see the failure
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  if (failure) throw failure;
}

/**
 * The gate in front of `ackClip`. Size must match the listing exactly, and a
 * CAPS1 clip must parse end to end with the dimensions the listing promised.
 * A QuickTime file is only size-checked; the phone's player parses it.
 */
export function verifyClip(
  meta: Pick<ClipMeta, 'bytes' | 'format' | 'width' | 'height' | 'fps'>,
  bytes: Uint8Array
): void {
  if (bytes.byteLength !== meta.bytes) {
    throw new IntegrityError(
      `downloaded ${bytes.byteLength} bytes, device said ${meta.bytes}`
    );
  }
  if (meta.format === 'mov') return;

  let header;
  try {
    header = indexClip(bytes).header;
  } catch (e) {
    if (e instanceof ClipParseError) throw new IntegrityError(e.message);
    throw e;
  }
  if (
    (meta.width && header.width !== meta.width) ||
    (meta.height && header.height !== meta.height) ||
    (meta.fps && header.fps !== meta.fps)
  ) {
    throw new IntegrityError(
      `clip is ${header.width}x${header.height}@${header.fps}, device listed ` +
        `${meta.width}x${meta.height}@${meta.fps}`
    );
  }
}
