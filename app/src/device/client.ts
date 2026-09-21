/**
 * Typed client for the device API in docs/api.md.
 *
 * Everything that talks to the device goes through here, so there is exactly one
 * place that knows about URLs, timeouts, and what the device does when it is
 * asleep. No React in this file -- it is testable on its own.
 */

import type { ApiErrorBody, ClipMeta, DeviceStatus } from './types';
import { SUPPORTED_API_VERSION } from './types';

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

export interface ClientOptions {
  /** Base URL, e.g. http://192.168.4.1 or http://10.0.0.5:8080 for the mock. */
  baseUrl: string;
  /** Per-request timeout. Short: the device is on the same Wi-Fi or it is gone. */
  timeoutMs?: number;
}

export class DeviceClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (e) {
      // fetch rejects for DNS failure, connection refused, and our own abort.
      // From the user's point of view these are one thing: it is not there.
      throw new DeviceUnreachableError(
        e instanceof Error && e.name === 'AbortError'
          ? `Device did not answer within ${this.timeoutMs}ms`
          : 'Could not reach the device'
      );
    } finally {
      clearTimeout(timer);
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

    return res;
  }

  async getStatus(): Promise<DeviceStatus> {
    const status = (await (await this.request('/api/status')).json()) as DeviceStatus;
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
    const res = await this.request('/api/time', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unix_ms: unixMs }),
    });
    return (await res.json()) as DeviceStatus;
  }

  async listClips(): Promise<ClipMeta[]> {
    const res = await this.request('/api/clips');
    const body = (await res.json()) as { clips: ClipMeta[] };
    return body.clips.filter((c) => c.complete);
  }

  /** Confirm a clip arrived intact, so the device may reclaim its space. */
  async ackClip(id: string): Promise<ClipMeta> {
    const res = await this.request(`/api/clips/${id}/ack`, { method: 'POST' });
    return (await res.json()) as ClipMeta;
  }

  async deleteClip(id: string): Promise<void> {
    await this.request(`/api/clips/${id}`, { method: 'DELETE' });
  }

  clipUrl(id: string): string {
    return `${this.baseUrl}/api/clips/${id}`;
  }

  previewUrl(): string {
    return `${this.baseUrl}/api/preview`;
  }
}
