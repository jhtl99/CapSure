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
import { transferRemaining, verifyClip } from './transfer';
import type { ClipMeta } from './types';

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

  async function capsClips(): Promise<ClipMeta[]> {
    const clips = await client().listClips();
    return clips.filter((clip) => clip.format !== 'mov');
  }

  async function capsClip(): Promise<ClipMeta | undefined> {
    return (await capsClips())[0];
  }

  it('serves a clip whose Content-Length matches the listing', async () => {
    if (!reachable) return;
    const c = client();
    const clip = await capsClip();
    if (!clip) return;

    // `serve.py --fail-after` drops each clip once; the second read is clean.
    let res!: Response;
    let bytes!: Uint8Array;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(c.clipUrl(clip.id));
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
        break;
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-capsure-clip');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Number(res.headers.get('content-length'))).toBe(clip.bytes);

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
    const clip = await capsClip();
    if (!clip) return;
    const from = Math.floor(clip.bytes / 2);

    const res = await fetch(c.clipUrl(clip.id), {
      headers: { Range: `bytes=${from}-` },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes ${from}-${clip.bytes - 1}/${clip.bytes}`
    );
    expect(Number(res.headers.get('content-length'))).toBe(clip.bytes - from);
    // An unread body keeps the device's one client slot busy.
    await res.body?.cancel();
  });

  it('reassembles a clip from two ranged halves', async () => {
    if (!reachable) return;
    const c = client();
    const clip = await capsClip();
    if (!clip) return;
    const mid = Math.floor(clip.bytes / 2);

    // One after the other: the device has one client slot.
    const a = await c.getClipRange(clip.id, 0, mid - 1, clip.bytes);
    const b = await c.getClipRange(clip.id, mid, clip.bytes - 1, clip.bytes);

    const joined = new Uint8Array(clip.bytes);
    joined.set(a, 0);
    joined.set(b, mid);

    // The real test: a clip stitched from two transfers still parses.
    expect(() => indexClip(joined)).not.toThrow();
  });

  it('downloads a clip in chunks and it verifies, even through a dropped socket', async () => {
    if (!reachable) return;
    const c = client();
    // A clip the other tests leave alone, so a --fail-after drop lands here.
    const clip = (await capsClips()).at(-1);
    if (!clip) return;

    const parts: Uint8Array[] = [];
    await transferRemaining(
      clip.bytes,
      0,
      {
        fetchRange: (s, e) => c.getClipRange(clip.id, s, e, clip.bytes, { timeoutMs: 15000 }),
        append: (b) => parts.push(b),
      },
      undefined,
      { chunkBytes: 256 * 1024 }
    );

    const joined = new Uint8Array(clip.bytes);
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.byteLength;
    }
    expect(() => verifyClip(clip, joined)).not.toThrow();
  }, 60000);

  it('serves overlapping requests from one client without a busy error', async () => {
    if (!reachable) return;
    const c = client();
    const results = await Promise.all([
      c.getStatus(),
      c.listClips(),
      c.getStatus(),
      c.listClips(),
    ]);
    expect(results).toHaveLength(4);
  });

  it('answers a second, unqueued client with 503 busy while one is served', async () => {
    if (!reachable) return;
    const clip = await capsClip();
    if (!clip) return;
    const url = client().clipUrl(clip.id);

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => fetch(url).then(async (r) => {
        await r.arrayBuffer();
        return r.status;
      }))
    );
    // Either the mock is in --multi-client mode (all 200) or it refused the overlap.
    expect(responses.every((s) => s === 200 || s === 503)).toBe(true);
    if (responses.includes(503)) expect(responses).toContain(200);
  }, 30000);

  it('serves a jpeg of each clip\'s first frame', async () => {
    if (!reachable) return;
    const c = client();
    const clips = await c.listClips();
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) {
      const bytes = await c.getThumb(clip.id);
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
    }
  }, 30000);

  it('serves a QuickTime file when one is in the clips folder', async () => {
    if (!reachable) return;
    const c = client();
    const mov = (await c.listClips()).find((clip) => clip.format === 'mov');
    if (!mov) return;

    expect(mov.bytes).toBeGreaterThan(0);
    const res = await fetch(c.clipUrl(mov.id));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/quicktime');
    expect(Number(res.headers.get('content-length'))).toBe(mov.bytes);
    await res.body?.cancel();
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
