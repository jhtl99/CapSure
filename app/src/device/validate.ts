/**
 * Checks on everything the device tells us and everything the user types.
 *
 * Anyone who joins the hat's network can answer as the device, so its replies
 * are input, not truth. Clip IDs end up in file paths and URLs; byte counts
 * decide how much we write to the phone. No React Native imports.
 */

import type { ClipMeta } from './types';

/** docs/api.md section 2. */
export const CLIP_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Far above a real 60 s clip (~24 MB), far below what would fill a phone. */
export const MAX_CLIP_BYTES = 256 * 1024 * 1024;

export class InvalidAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAddressError';
  }
}

export function isValidClipId(id: unknown): id is string {
  return typeof id === 'string' && CLIP_ID_RE.test(id);
}

export function assertClipId(id: string): string {
  if (!isValidClipId(id)) throw new Error(`refusing malformed clip id ${JSON.stringify(id)}`);
  return id;
}

/** True when a listing entry is safe to show and download. */
export function isSaneClipMeta(c: unknown): c is ClipMeta {
  if (!c || typeof c !== 'object') return false;
  const m = c as Record<string, unknown>;
  return (
    isValidClipId(m.id) &&
    Number.isSafeInteger(m.bytes) &&
    (m.bytes as number) > 0 &&
    (m.bytes as number) <= MAX_CLIP_BYTES &&
    typeof m.complete === 'boolean' &&
    (m.format === undefined || m.format === 'mov')
  );
}

function isLocalIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * `http://host[:port]` with a private or loopback host, trailing slashes
 * removed. The device and the mock both live on the local network; anything
 * else is a typo or someone trying to point the app somewhere it should not go.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  const m = trimmed.match(/^http:\/\/([^/:?#@\s]+)(?::(\d{1,5}))?$/i);
  if (!m) {
    throw new InvalidAddressError(
      'Address must look like http://192.168.4.1 or http://10.0.0.5:8080, with no path.'
    );
  }
  const host = m[1].toLowerCase();
  const port = m[2] ? Number(m[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw new InvalidAddressError(`Port ${port} is out of range.`);
  }
  if (host !== 'localhost' && !isLocalIPv4(host)) {
    throw new InvalidAddressError(
      `${host} is not a local network address. The device is always on your local Wi-Fi.`
    );
  }
  return port !== undefined ? `http://${host}:${port}` : `http://${host}`;
}
