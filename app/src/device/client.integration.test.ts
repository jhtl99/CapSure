/**
 * The app's client layer against the real mock server.
 *
 * The unit tests prove the parser is correct about bytes we made up here. This
 * one proves the app and the mock agree about the actual wire format -- which
 * is the thing that breaks when docs/api.md changes and only one side notices.
 *
 * Skipped unless a mock is running:
 *
 *     python3 mock-device/serve.py --port 8080
 *     npm test
 */

import { describe, expect, it, beforeAll } from 'vitest';

import { DeviceClient, DeviceApiError, DeviceUnreachableError } from './client';
import { indexClip, avDriftMs } from './clip';

const BASE_URL = process.env.CAPSURE_MOCK_URL ?? 'http://localhost:8080';

let reachable = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/api/status`, {
      signal: AbortSignal.timeout(1000),
    });
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.log(`  (mock not running at ${BASE_URL}; integration tests skipped)`);
  }
});

describe('DeviceClient against the mock', () => {
  const client = () => new DeviceClient({ baseUrl: BASE_URL, timeoutMs: 3000 });

  it('reads status and finds the fields the gallery renders', async () => {
    if (!reachable) return;
    const s = await client().getStatus();
    expect(s.api_version).toBe(1);
    expect(typeof s.battery_pct).toBe('number');
    expect(typeof s.recording).toBe('boolean');
    expect(typeof s.buffer_healthy).toBe('boolean');
    expect(typeof s.storage_free_mb).toBe('number');
  });

  it('sets the device clock', async () => {
    if (!reachable) return;
    const now = Date.now();
    const s = await client().setTime(now);
    expect(s.clock_set).toBe(true);
    expect(Math.abs(s.clock_unix_ms - now)).toBeLessThan(2000);
  });

  it('lists clips with a byte count the download can trust', async () => {
    if (!reachable) return;
    const clips = await client().listClips();
    expect(clips.length).toBeGreaterThan(0);
    for (const c of clips) {
      expect(c.bytes).toBeGreaterThan(0);
      expect(c.complete).toBe(true);
      expect(c.id).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    }
  });

  it('serves a clip whose Content-Length matches the listing', async () => {
    if (!reachable) return;
    const c = client();
    const [clip] = await c.listClips();
    const res = await fetch(c.clipUrl(clip.id));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-capsure-clip');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Number(res.headers.get('content-length'))).toBe(clip.bytes);

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(clip.bytes);

    const idx = indexClip(bytes);
    expect(idx.video.length).toBeGreaterThan(0);
    expect(idx.header.fps).toBe(clip.fps);
    expect(Math.abs(avDriftMs(idx))).toBeLessThan(40);
  });

  // Range support is what makes a 28 MB transfer survivable, so it is worth a
  // test rather than a line in a document.
  it('supports Range requests so an interrupted download can resume', async () => {
    if (!reachable) return;
    const c = client();
    const [clip] = await c.listClips();
    const from = Math.floor(clip.bytes / 2);

    const res = await fetch(c.clipUrl(clip.id), {
      headers: { Range: `bytes=${from}-` },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes ${from}-${clip.bytes - 1}/${clip.bytes}`
    );
    expect(Number(res.headers.get('content-length'))).toBe(clip.bytes - from);
  });

  it('reassembles a clip from two ranged halves', async () => {
    if (!reachable) return;
    const c = client();
    const [clip] = await c.listClips();
    const mid = Math.floor(clip.bytes / 2);

    const [a, b] = await Promise.all([
      fetch(c.clipUrl(clip.id), { headers: { Range: `bytes=0-${mid - 1}` } }),
      fetch(c.clipUrl(clip.id), { headers: { Range: `bytes=${mid}-` } }),
    ]);

    const joined = new Uint8Array(clip.bytes);
    joined.set(new Uint8Array(await a.arrayBuffer()), 0);
    joined.set(new Uint8Array(await b.arrayBuffer()), mid);

    // The real test: a clip stitched from two transfers still parses.
    expect(() => indexClip(joined)).not.toThrow();
  });

  it('reports a missing clip as an error the UI can show', async () => {
    if (!reachable) return;
    await expect(client().ackClip('nope')).rejects.toBeInstanceOf(DeviceApiError);
    await expect(client().ackClip('nope')).rejects.toMatchObject({
      code: 'clip_not_found',
    });
  });

  it('reports an unreachable device distinctly from an API error', async () => {
    const dead = new DeviceClient({
      baseUrl: 'http://127.0.0.1:9',
      timeoutMs: 500,
    });
    await expect(dead.getStatus()).rejects.toBeInstanceOf(DeviceUnreachableError);
  });
});
