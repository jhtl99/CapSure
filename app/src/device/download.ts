/**
 * Clip download, with resume.
 *
 * A 60-second clip is ~28 MB coming off a hat over Wi-Fi. Transfers get
 * interrupted -- the wearer walks away, the AP times out, the phone switches
 * networks. Restarting a 28 MB transfer from zero every time is the difference
 * between a demo that works and one that does not, so we resume instead.
 *
 * expo-file-system's DownloadTask handles the Range request for us, which is
 * why docs/api.md makes Range support mandatory on the device side.
 */

import { Directory, DownloadTask, File, Paths } from 'expo-file-system';

import type { ClipMeta } from './types';

export interface DownloadProgressInfo {
  bytesReceived: number;
  bytesExpected: number;
  fraction: number;
}

export const CLIPS_DIR = 'clips';

export function clipsDirectory(): Directory {
  const dir = new Directory(Paths.document, CLIPS_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function localClipFile(id: string): File {
  return new File(clipsDirectory(), `${id}.cap`);
}

export function isDownloaded(meta: ClipMeta): boolean {
  const file = localClipFile(meta.id);
  if (!file.exists) return false;
  // Size is the cheap integrity check. The real one is parsing it, which
  // happens when the clip is opened.
  return file.size === meta.bytes;
}

export interface DownloadHandle {
  promise: Promise<File>;
  cancel: () => void;
  pause: () => void;
  resume: () => Promise<File | null>;
}

export function downloadClip(
  url: string,
  meta: ClipMeta,
  onProgress?: (p: DownloadProgressInfo) => void
): DownloadHandle {
  const destination = localClipFile(meta.id);

  // A leftover partial or stale file would make the download fail outright.
  if (destination.exists) destination.delete();

  const task = new DownloadTask(url, destination, {
    onProgress: (p) => {
      const expected = p.totalBytes > 0 ? p.totalBytes : meta.bytes;
      onProgress?.({
        bytesReceived: p.bytesWritten,
        bytesExpected: expected,
        fraction: expected > 0 ? p.bytesWritten / expected : 0,
      });
    },
  });

  const promise = task.downloadAsync().then((file) => {
    if (!file) throw new Error('Download was paused before it finished');
    return file;
  });

  return {
    promise,
    cancel: () => task.cancel(),
    pause: () => task.pause(),
    resume: () => task.resumeAsync(),
  };
}

export function deleteLocalClip(id: string): void {
  const file = localClipFile(id);
  if (file.exists) file.delete();
}
