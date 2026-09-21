/** Types mirroring docs/api.md. Keep them in step with that document. */

export interface DeviceStatus {
  api_version: number;
  device_id: string;
  fw_version: string;
  uptime_s: number;
  recording: boolean;
  buffer_healthy: boolean;
  buffer_seconds: number;
  battery_pct: number;
  battery_mv: number;
  storage_free_mb: number;
  storage_total_mb: number;
  dropped_frames: number;
  clock_unix_ms: number;
  clock_set: boolean;
}

export interface ClipMeta {
  id: string;
  created_unix_ms: number;
  duration_ms: number;
  bytes: number;
  width: number;
  height: number;
  fps: number;
  audio_sample_rate: number;
  acked: boolean;
  complete: boolean;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}

export const SUPPORTED_API_VERSION = 1;
