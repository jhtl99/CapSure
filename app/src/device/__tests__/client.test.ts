import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceApiError, DeviceClient, TransferError } from '../client';
import { InvalidAddressError } from '../validate';

const status = { api_version: 1, device_id: 'x' };

function jsonResponse(code: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeviceClient', () => {
  it('never has two requests in flight, like the device needs', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal('fetch', async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return jsonResponse(200, status);
    });

    const c = new DeviceClient({ baseUrl: 'http://192.168.4.1' });
    await Promise.all([c.getStatus(), c.getStatus(), c.getStatus(), c.getStatus()]);
    expect(peak).toBe(1);
  });

  it('keeps the queue going after a failed request', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () =>
      n++ === 0
        ? jsonResponse(404, { error: 'clip_not_found', message: 'no' })
        : jsonResponse(200, status)
    );
    const c = new DeviceClient({ baseUrl: 'http://192.168.4.1' });
    const [a, b] = await Promise.allSettled([c.ackClip('0042'), c.getStatus()]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('fulfilled');
  });

  it('retries 503 busy with backoff, then succeeds', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () =>
      n++ < 2 ? jsonResponse(503, { error: 'busy', message: 'busy' }) : jsonResponse(200, status)
    );
    const c = new DeviceClient({ baseUrl: 'http://192.168.4.1', busyBackoffMs: 1 });
    await expect(c.getStatus()).resolves.toMatchObject({ api_version: 1 });
    expect(n).toBe(3);
  });

  it('reports busy once retries run out', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(503, { error: 'busy', message: 'busy' }));
    const c = new DeviceClient({
      baseUrl: 'http://192.168.4.1',
      busyBackoffMs: 1,
      busyRetries: 2,
    });
    await expect(c.getStatus()).rejects.toMatchObject({ status: 503, code: 'busy' });
  });

  it('does not retry 503 not_ready', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      return jsonResponse(503, { error: 'not_ready', message: 'no frame' });
    });
    const c = new DeviceClient({ baseUrl: 'http://192.168.4.1', busyBackoffMs: 1 });
    await expect(c.getThumb('0042')).rejects.toBeInstanceOf(DeviceApiError);
    expect(n).toBe(1);
  });

  it('drops listing entries with unsafe ids or sizes', async () => {
    const good = { id: '0042', bytes: 10, complete: true };
    vi.stubGlobal('fetch', async () =>
      jsonResponse(200, {
        clips: [
          good,
          { id: '../evil', bytes: 10, complete: true },
          { id: '0043', bytes: -1, complete: true },
          { id: '0044', bytes: 10, complete: false },
        ],
      })
    );
    const c = new DeviceClient({ baseUrl: 'http://192.168.4.1' });
    expect(await c.listClips()).toEqual([good]);
  });

  it('refuses to build a URL from a malformed id', async () => {
    const c = new DeviceClient({ baseUrl: 'http://192.168.4.1' });
    expect(() => c.clipUrl('../x')).toThrow();
    await expect(c.deleteClip('a/b')).rejects.toThrow();
  });

  it('refuses a non-local address', () => {
    expect(() => new DeviceClient({ baseUrl: 'http://example.com' })).toThrow(
      InvalidAddressError
    );
  });

  it('rejects a ranged read that comes back as the wrong range', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array(4), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-3/10' },
        })
    );
    const c = new DeviceClient({ baseUrl: 'http://192.168.4.1' });
    await expect(c.getClipRange('0042', 4, 7, 10)).rejects.toBeInstanceOf(TransferError);
  });

  it('rejects a device that ignores Range and sends the whole clip', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(10), { status: 200 }));
    const c = new DeviceClient({ baseUrl: 'http://192.168.4.1' });
    await expect(c.getClipRange('0042', 4, 7, 10)).rejects.toBeInstanceOf(TransferError);
  });

  it('rejects a short body', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array(2), {
          status: 206,
          headers: { 'Content-Range': 'bytes 4-7/10' },
        })
    );
    const c = new DeviceClient({ baseUrl: 'http://192.168.4.1' });
    await expect(c.getClipRange('0042', 4, 7, 10)).rejects.toBeInstanceOf(TransferError);
  });
});
