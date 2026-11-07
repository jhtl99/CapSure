/**
 * Clip download, with resume and a verified ack.
 *
 * A 60-second clip is ~24 MB coming off a hat over Wi-Fi. Transfers get
 * interrupted -- the wearer walks away, the switch goes off, the phone switches
 * networks. Bytes land in `{id}.{ext}.part` in Range chunks (see transfer.ts),
 * so a retry picks up after the last good chunk instead of starting over.
 *
 * Only a file that passes `verifyClip` is renamed to its final name, and only
 * then is the device told it may reclaim the space. Anything that exists
 * under the final name has been verified.
 */

import { Directory, File, Paths } from 'expo-file-system';

import { DOWNLOAD_PARALLEL } from '../config';
import type { DeviceClient } from './client';
import {
  CHUNK_TIMEOUT_MS,
  IntegrityError,
  transferRemaining,
  verifyClip,
} from './transfer';
import type { TransferProgress } from './transfer';
import type { ClipMeta } from './types';
import { assertClipId } from './validate';

export type DownloadProgressInfo = TransferProgress;

export const CLIPS_DIR = 'clips';

/** Room left on the phone after a download, so we never fill it to zero. */
const FREE_SPACE_MARGIN_BYTES = 50 * 1024 * 1024;

export function clipsDirectory(): Directory {
  const dir = new Directory(Paths.document, CLIPS_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function extension(meta: Pick<ClipMeta, 'format'>): string {
  return meta.format === 'mov' ? 'mov' : 'cap';
}

export function localClipFile(meta: Pick<ClipMeta, 'id' | 'format'>): File {
  return new File(clipsDirectory(), `${assertClipId(meta.id)}.${extension(meta)}`);
}

function partialClipFile(meta: Pick<ClipMeta, 'id' | 'format'>): File {
  return new File(clipsDirectory(), `${assertClipId(meta.id)}.${extension(meta)}.part`);
}

export function isDownloaded(meta: ClipMeta): boolean {
  const file = localClipFile(meta);
  return file.exists && file.size === meta.bytes;
}

/** Fraction already on the phone from an interrupted download, or 0. */
export function partialFraction(meta: ClipMeta): number {
  const part = partialClipFile(meta);
  if (!part.exists || part.size > meta.bytes) return 0;
  return part.size / meta.bytes;
}

/**
 * Download, verify, and ack one clip. Safe to call again after any failure:
 * an interrupted transfer resumes, a corrupt one starts over, and the device
 * is never acked for a copy that did not verify.
 */
export async function pullClip(
  client: DeviceClient,
  meta: ClipMeta,
  onProgress?: (p: DownloadProgressInfo) => void
): Promise<File> {
  const final = localClipFile(meta);
  if (!isDownloaded(meta)) {
    await downloadVerified(client, meta, onProgress);
  }
  await client.ackClip(meta.id);
  return final;
}

async function downloadVerified(
  client: DeviceClient,
  meta: ClipMeta,
  onProgress?: (p: DownloadProgressInfo) => void
): Promise<void> {
  const final = localClipFile(meta);
  const part = partialClipFile(meta);

  if (part.exists && part.size > meta.bytes) part.delete();
  if (!part.exists) part.create();

  const needed = meta.bytes - part.size;
  if (Paths.availableDiskSpace - needed < FREE_SPACE_MARGIN_BYTES) {
    throw new Error(
      `Not enough space on this phone for this clip (${Math.ceil(needed / 1e6)} MB needed).`
    );
  }

  const endTransfer = client.beginTransfer();
  try {
    await transferRemaining(
      meta.bytes,
      part.size,
      {
        fetchRange: (start, end) =>
          client.getClipRange(meta.id, start, end, meta.bytes, {
            timeoutMs: CHUNK_TIMEOUT_MS,
            concurrent: DOWNLOAD_PARALLEL > 1,
          }),
        append: (bytes) => part.write(bytes, { append: true }),
      },
      onProgress,
      { parallel: DOWNLOAD_PARALLEL }
    );
  } finally {
    endTransfer();
  }

  try {
    verifyClip(meta, await part.bytes());
  } catch (e) {
    // Resuming a bad copy would only reproduce it. Start the next try clean.
    if (e instanceof IntegrityError) part.delete();
    throw e;
  }

  if (final.exists) final.delete();
  await part.move(final);
}

export function deleteLocalClip(meta: Pick<ClipMeta, 'id' | 'format'>): void {
  for (const file of [localClipFile(meta), partialClipFile(meta)]) {
    if (file.exists) file.delete();
  }
}
