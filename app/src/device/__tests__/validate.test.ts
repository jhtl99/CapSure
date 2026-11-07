import { describe, expect, it } from 'vitest';

import {
  InvalidAddressError,
  MAX_CLIP_BYTES,
  isSaneClipMeta,
  isValidClipId,
  normalizeBaseUrl,
} from '../validate';

const clip = (over: Record<string, unknown> = {}) => ({
  id: '0042',
  created_unix_ms: 0,
  duration_ms: 60000,
  bytes: 21_400_000,
  width: 640,
  height: 480,
  fps: 15,
  audio_sample_rate: 16000,
  acked: false,
  complete: true,
  ...over,
});

describe('clip ids', () => {
  it('accepts the documented alphabet', () => {
    expect(isValidClipId('0042')).toBe(true);
    expect(isValidClipId('clip_a-1')).toBe(true);
    expect(isValidClipId('x'.repeat(32))).toBe(true);
  });

  it('rejects anything that could escape a path or a URL', () => {
    for (const bad of ['', '../x', 'a/b', 'a.b', 'a%2F', 'x'.repeat(33), 'a b', '..']) {
      expect(isValidClipId(bad)).toBe(false);
    }
    expect(isValidClipId(42)).toBe(false);
  });
});

describe('clip metadata from the device', () => {
  it('accepts a normal listing entry', () => {
    expect(isSaneClipMeta(clip())).toBe(true);
    expect(isSaneClipMeta(clip({ format: 'mov' }))).toBe(true);
  });

  it('rejects sizes that are missing, fractional, zero, or absurd', () => {
    expect(isSaneClipMeta(clip({ bytes: 0 }))).toBe(false);
    expect(isSaneClipMeta(clip({ bytes: 1.5 }))).toBe(false);
    expect(isSaneClipMeta(clip({ bytes: '100' }))).toBe(false);
    expect(isSaneClipMeta(clip({ bytes: MAX_CLIP_BYTES + 1 }))).toBe(false);
  });

  it('rejects a bad id or unknown format', () => {
    expect(isSaneClipMeta(clip({ id: '../../Documents/x' }))).toBe(false);
    expect(isSaneClipMeta(clip({ format: 'exe' }))).toBe(false);
    expect(isSaneClipMeta(null)).toBe(false);
  });
});

describe('device address', () => {
  it('accepts the device, the mock, and private LAN addresses', () => {
    expect(normalizeBaseUrl('http://192.168.4.1')).toBe('http://192.168.4.1');
    expect(normalizeBaseUrl(' http://192.168.4.1/ ')).toBe('http://192.168.4.1');
    expect(normalizeBaseUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeBaseUrl('http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080');
    expect(normalizeBaseUrl('http://172.20.1.2')).toBe('http://172.20.1.2');
    expect(normalizeBaseUrl('HTTP://127.0.0.1:9')).toBe('http://127.0.0.1:9');
  });

  it('rejects public hosts, other schemes, paths, and credentials', () => {
    for (const bad of [
      'http://8.8.8.8',
      'http://example.com',
      'http://172.32.0.1',
      'https://192.168.4.1',
      'ftp://192.168.4.1',
      'http://192.168.4.1/api',
      'http://user@192.168.4.1',
      'http://192.168.4.256',
      'http://192.168.4.1:99999',
      '192.168.4.1',
    ]) {
      expect(() => normalizeBaseUrl(bad), bad).toThrow(InvalidAddressError);
    }
  });
});
