export const colors = {
  bg: '#0E1013',
  surface: '#181B21',
  surfaceAlt: '#20242C',
  border: '#2C313B',
  text: '#F2F4F8',
  textDim: '#9AA3B2',
  accent: '#4C8DFF',
  good: '#3DD68C',
  warn: '#F2B441',
  bad: '#FF5C5C',
  recording: '#FF3B30',
};

export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };

export const radius = { sm: 6, md: 10, lg: 16 };

export const type = {
  title: { fontSize: 24, fontWeight: '700' as const, color: colors.text },
  heading: { fontSize: 17, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 15, color: colors.text },
  dim: { fontSize: 13, color: colors.textDim },
  mono: { fontSize: 13, color: colors.textDim, fontFamily: 'Menlo' },
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatWhen(unixMs: number): string {
  if (!unixMs) return 'time unknown';
  const d = new Date(unixMs);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString()} ${time}`;
}
