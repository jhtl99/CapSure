/**
 * Clip thumbnails, fetched through the client's queue and kept on disk.
 *
 * Letting <Image> load `/thumb` URLs directly would open one connection per
 * gallery row at once, and the device serves one client at a time. Here each
 * thumbnail is one queued request, made once per device address.
 */

import { Directory, File, Paths } from 'expo-file-system';

import type { DeviceClient } from './client';
import { assertClipId } from './validate';

const inflight = new Map<string, Promise<string>>();

function thumbFile(client: DeviceClient, id: string): File {
  const host = client.baseUrl.replace(/^http:\/\//, '').replace(/[^A-Za-z0-9.-]/g, '_');
  const dir = new Directory(Paths.cache, 'thumbs', host);
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, `${assertClipId(id)}.jpg`);
}

/** file:// URI of the clip's first frame, downloading it if needed. */
export function thumbUri(client: DeviceClient, id: string): Promise<string> {
  const file = thumbFile(client, id);
  if (file.exists && file.size > 0) return Promise.resolve(file.uri);

  const key = file.uri;
  let pending = inflight.get(key);
  if (!pending) {
    pending = client
      .getThumb(id)
      .then((bytes) => {
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('thumbnail is not a JPEG');
        if (file.exists) file.delete();
        file.create();
        file.write(bytes);
        return file.uri;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}
