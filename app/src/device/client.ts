/**
 * Typed client for the device API in docs/api.md.
 *
 * Everything that talks to the device goes through here, so there is exactly one
 * place that knows about URLs, timeouts, and what the device does when it is
 * asleep. No React in this file -- it is testable on its own.
 *
 * The ESP32 serves one HTTP client at a time and answers a second with 503, so
 * this client never has two requests in flight: every request, body included,
 * waits its turn in a queue, and a 503 `busy` is retried with backoff before it
 * is reported.
 */

import type { ApiErrorBody, ClipMeta, DeviceStatus } from './types';
import { SUPPORTED_API_VERSION } from './types';
import { assertClipId, isSaneClipMeta, normalizeBaseUrl } from './validate';

/** The device is not answering: asleep, out of range, or phone on another network. */
export class DeviceUnreachableError extends Error {
  constructor(message = 'Device is not responding') {
    super(message);
    this.name = 'DeviceUnreachableError';
  }
}

/** The device answered, but with an error. */
export class DeviceApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message || body.error);
    this.name = 'DeviceApiError';
    this.status = status;
    this.code = body.error;
  }
}

/** A ranged read came back with the wrong range or the wrong length. */
export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferError';
  }
}

export interface ClientOptions {
  /** Base URL, e.g. http://192.168.4.1 or http://10.0.0.5:8080 for the mock. */
  baseUrl: string;
  /** Per-request timeout. Short: the device is on the same Wi-Fi or it is gone. */
  timeoutMs?: number;
  /** How many times a 503 `busy` is retried before it reaches the caller. */
  busyRetries?: number;
  /** First backoff after a 503; doubles each retry. */
  busyBackoffMs?: number;
}

export interface RequestOptions {
  timeoutMs?: number;
  /**
   * Skip the one-at-a-time queue. Only for clip chunk downloads, which the
   * firmware serves from parallel workers; everything else stays serialized.
   */
  concurrent?: boolean;
}

/** Listing can index clips on the device the first time; see listClips. */
export const LIST_TIMEOUT_MS = 20000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const json = <T>(res: Response) => res.json() as Promise<T>;

export class DeviceClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly busyRetries: number;
  private readonly busyBackoffMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private transfers = 0;

  constructor(opts: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.busyRetries = opts.busyRetries ?? 3;
    this.busyBackoffMs = opts.busyBackoffMs ?? 300;
  }

  /** True while a clip download is running. Status polling backs off. */
  get transferring(): boolean {
    return this.transfers > 0;
  }

  /** Mark a clip transfer as running. Call the returned function when it ends. */
  beginTransfer(): () => void {
    this.transfers++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.transfers--;
    };
  }

  /** Run `fn` once every earlier request has settled. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * One request, read to completion by `read`, holding the queue the whole
   * time. A 503 that is not `not_ready` means another client has the device.
   */
  private request<T>(
    path: string,
    init: RequestInit,
    read: (res: Response) => Promise<T>,
    opts: RequestOptions = {}
  ): Promise<T> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.requestOnce(path, init, read, opts);
        } catch (e) {
          const busy =
            e instanceof DeviceApiError && e.status === 503 && e.code !== 'not_ready';
          if (!busy || attempt >= this.busyRetries) throw e;
          await sleep(this.busyBackoffMs * 2 ** attempt);
        }
      }
    };
    return opts.concurrent ? run() : this.serialized(run);
  }

  private async requestOnce<T>(
    path: string,
    init: RequestInit,
    read: (res: Response) => Promise<T>,
    opts: RequestOptions
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // fetch rejects for DNS failure, connection refused, a dropped socket, and
    // our own abort. From the user's point of view these are one thing: it is
    // not there.
    const unreachable = (e: unknown) =>
      new DeviceUnreachableError(
        // Expo's fetch does not always name its abort error AbortError, so ask
        // the signal: if we aborted, it was our timeout.
        controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')
          ? `Device did not answer within ${timeoutMs}ms`
          : `Could not reach the device${e instanceof Error ? ` (${e.name}: ${e.message})` : ''}`
      );

    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      } catch (e) {
        throw unreachable(e);
      }

      if (!res.ok) {
        let body: ApiErrorBody = { error: 'unknown', message: res.statusText };
        try {
          body = (await res.json()) as ApiErrorBody;
        } catch {
          /* device returned a non-JSON error; keep the status text */
        }
        throw new DeviceApiError(res.status, body);
      }

      try {
        return await read(res);
      } catch (e) {
        if (e instanceof TransferError || e instanceof DeviceApiError) throw e;
        throw unreachable(e);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async getStatus(opts: RequestOptions = {}): Promise<DeviceStatus> {
    const status = await this.request('/api/status', {}, json<DeviceStatus>, opts);
    if (status.api_version !== SUPPORTED_API_VERSION) {
      throw new DeviceApiError(200, {
        error: 'version_mismatch',
        message:
          `Device speaks API v${status.api_version}, app speaks ` +
          `v${SUPPORTED_API_VERSION}. Update one of them.`,
      });
    }
    return status;
  }

  /**
   * Push the phone's wall clock to the device. The ESP32 has no battery-backed
   * RTC, so until this lands its timestamps are meaningless. Call it on every
   * successful connection.
   */
  async setTime(unixMs: number = Date.now()): Promise<DeviceStatus> {
    return this.request(
      '/api/time',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unix_ms: unixMs }),
      },
      json<DeviceStatus>
    );
  }

  /** Complete clips only. Entries with a malformed id or size are dropped. */
  async listClips(opts: RequestOptions = {}): Promise<ClipMeta[]> {
    // The first listing after the hat boots indexes clips it has not summarized
    // yet, a few hundred ms each, so allow longer than an ordinary request.
    const body = await this.request('/api/clips', {}, json<{ clips?: unknown }>, {
      timeoutMs: LIST_TIMEOUT_MS,
      ...opts,
    });
    const clips = Array.isArray(body.clips) ? body.clips : [];
    return clips.filter(isSaneClipMeta).filter((c) => c.complete);
  }

  /** Confirm a clip arrived intact, so the device may reclaim its space. */
  async ackClip(id: string): Promise<ClipMeta> {
    return this.request(
      `/api/clips/${assertClipId(id)}/ack`,
      { method: 'POST' },
      json<ClipMeta>
    );
  }

  async deleteClip(id: string): Promise<void> {
    await this.request(`/api/clips/${assertClipId(id)}`, { method: 'DELETE' }, json);
  }

  /**
   * Bytes `start` through `end` inclusive of one clip. Fails unless the device
   * returns exactly that range, so a wrong or short answer is never written
   * into a clip file.
   */
  async getClipRange(
    id: string,
    start: number,
    end: number,
    totalBytes: number,
    opts: RequestOptions = {}
  ): Promise<Uint8Array> {
    const want = end - start + 1;
    return this.request(
      `/api/clips/${assertClipId(id)}`,
      { headers: { Range: `bytes=${start}-${end}` } },
      async (res) => {
        if (res.status === 206) {
          const expected = `bytes ${start}-${end}/${totalBytes}`;
          const got = res.headers.get('content-range');
          if (got !== expected) {
            throw new TransferError(`device sent range "${got}", asked for "${expected}"`);
          }
        } else if (!(res.status === 200 && start === 0 && want === totalBytes)) {
          throw new TransferError(`device ignored the Range request (HTTP ${res.status})`);
        }

        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength !== want) {
          throw new TransferError(`expected ${want} bytes, got ${bytes.byteLength}`);
        }
        return bytes;
      },
      opts
    );
  }

  async getThumb(id: string): Promise<Uint8Array> {
    return this.request(
      `/api/clips/${assertClipId(id)}/thumb`,
      {},
      async (res) => new Uint8Array(await res.arrayBuffer())
    );
  }

  clipUrl(id: string): string {
    return `${this.baseUrl}/api/clips/${assertClipId(id)}`;
  }

  previewUrl(): string {
    return `${this.baseUrl}/api/preview`;
  }
}
