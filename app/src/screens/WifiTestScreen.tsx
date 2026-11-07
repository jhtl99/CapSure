import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';

import { DEVICE_URL, DOWNLOAD_PARALLEL } from '../config';
import { DeviceClient } from '../device/client';
import { CHUNK_TIMEOUT_MS, transferRemaining } from '../device/transfer';
import { Button, Card, Row } from '../ui/components';
import { colors, space, type } from '../ui/theme';

/**
 * Raw link test against the hat, no DeviceClient involved.
 *
 *   /status     the wifibroadcasttest sketch's own endpoint
 *   /api/status the app contract (docs/api.md); Connect needs this one
 *   /bench      N MB streamed from the ESP32's RAM, so the number is Wi-Fi
 *               alone, with no SD card in the way
 *   /api/clips/{id}  a real clip read off the SD card (capsure_fw)
 */

const BASE = DEVICE_URL;
const BENCH_MB = 8;

async function fetchWithTimeout(url: string, ms = 4000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.name === 'AbortError' ? 'timed out' : e.message;
  return String(e);
}

export function WifiTestScreen({ onBack }: { onBack: () => void }) {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [best, setBest] = useState<number | null>(null);

  const add = (s: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${s}`, ...l].slice(0, 50));

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  const ping = (path: string) =>
    run(path, async () => {
      const t0 = Date.now();
      try {
        const r = await fetchWithTimeout(`${BASE}${path}`);
        const body = (await r.text()).slice(0, 300);
        add(`${path} -> HTTP ${r.status} in ${Date.now() - t0} ms: ${body}`);
      } catch (e) {
        add(`${path} failed after ${Date.now() - t0} ms: ${errText(e)}`);
      }
    });

  const speed = () =>
    run('bench', async () => {
      // Straight to a file, so 8 MB never passes through JS memory.
      const dest = new File(Paths.cache, 'bench.bin');
      const t0 = Date.now();
      try {
        const file = await File.downloadFileAsync(`${BASE}/bench?mb=${BENCH_MB}`, dest, {
          idempotent: true,
        });
        const secs = (Date.now() - t0) / 1000;
        const mb = file.size / 1e6;
        const rate = mb / secs;
        add(`bench: ${mb.toFixed(1)} MB in ${secs.toFixed(2)} s = ${rate.toFixed(2)} MB/s`);
        setBest((b) => (b === null || rate > b ? rate : b));
        file.delete();
      } catch (e) {
        add(`bench failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${errText(e)}`);
      }
    });

  // A real clip off the SD card, through the same endpoint the gallery uses.
  const clipSpeed = () =>
    run('clip', async () => {
      try {
        const r = await fetchWithTimeout(`${BASE}/api/clips`, 20000);
        const { clips } = (await r.json()) as { clips: { id: string; bytes: number }[] };
        if (!clips?.length) {
          add('clip test: no clips on the hat yet (press the button, wait 3 s)');
          return;
        }
        const c = clips[0];
        const dest = new File(Paths.cache, 'clip-bench.cap');
        const t0 = Date.now();
        const file = await File.downloadFileAsync(`${BASE}/api/clips/${c.id}`, dest, {
          idempotent: true,
        });
        const secs = (Date.now() - t0) / 1000;
        const mb = file.size / 1e6;
        const rate = mb / secs;
        const whole = file.size === c.bytes ? '' : `  !! expected ${c.bytes} bytes`;
        add(`clip ${c.id} (SD): ${mb.toFixed(1)} MB in ${secs.toFixed(1)} s = ${rate.toFixed(2)} MB/s${whole}`);
        setBest((b) => (b === null || rate > b ? rate : b));
        file.delete();
      } catch (e) {
        add(`clip test failed: ${errText(e)}`);
      }
    });

  // Same chunked Range download the gallery uses, with 1 and then N connections.
  // Logs each step separately so a failure says where it happened.
  const compareParallel = () =>
    run('parallel', async () => {
      const client = new DeviceClient({ baseUrl: BASE, timeoutMs: 5000 });
      let clips;
      const tl = Date.now();
      try {
        clips = await client.listClips();     // first listing after a boot can be slow
      } catch (e) {
        add(`parallel test: listing clips failed after ${Date.now() - tl} ms: ${errText(e)}`);
        return;
      }
      add(`parallel test: listed ${clips.length} clip(s) in ${Date.now() - tl} ms`);
      if (!clips.length) {
        add('parallel test: no clips on the hat yet (press the button, wait 3 s)');
        return;
      }
      const c = clips[0];
      const want = Math.min(16 * 1024 * 1024, c.bytes);
      for (const parallel of [1, DOWNLOAD_PARALLEL]) {
        const dest = new File(Paths.cache, 'parallel-bench.cap');
        if (dest.exists) dest.delete();
        dest.create();
        let chunks = 0;
        const t0 = Date.now();
        try {
          await transferRemaining(
            want,
            0,
            {
              fetchRange: async (start, end) => {
                try {
                  const b = await client.getClipRange(c.id, start, end, c.bytes, {
                    timeoutMs: CHUNK_TIMEOUT_MS,
                    concurrent: parallel > 1,
                  });
                  chunks++;
                  return b;
                } catch (e) {
                  add(`  ${parallel}x: chunk ${start}-${end} failed: ${errText(e)}`);
                  throw e;
                }
              },
              append: (bytes) => dest.write(bytes, { append: true }),
            },
            undefined,
            { parallel }
          );
          const secs = (Date.now() - t0) / 1000;
          const mb = dest.size / 1e6;
          const rate = mb / secs;
          add(`clip ${c.id}, ${parallel} connection${parallel > 1 ? 's' : ''}: ${mb.toFixed(1)} MB in ${secs.toFixed(1)} s = ${rate.toFixed(2)} MB/s`);
          setBest((b) => (b === null || rate > b ? rate : b));
        } catch (e) {
          add(`${parallel}x download failed after ${chunks} good chunk(s), ${((Date.now() - t0) / 1000).toFixed(1)} s: ${errText(e)}`);
        } finally {
          if (dest.exists) dest.delete();
        }
      }
    });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={type.title}>Wi-Fi test</Text>
      <Text style={type.dim}>Join the CapSure Wi-Fi network first, then run these in order.</Text>

      <Card>
        <Row label="Target" value={BASE} />
        <Row
          label="Best throughput"
          value={best === null ? '-' : `${best.toFixed(2)} MB/s`}
          tone={best === null ? undefined : best >= 2.5 ? 'good' : best >= 1 ? 'warn' : 'bad'}
        />
        <Text style={type.dim}>Requirement: 2.5 MB/s.</Text>
      </Card>

      <View style={{ gap: space.sm }}>
        <Button title="1. Ping /status" onPress={() => ping('/status')} busy={busy === '/status'} disabled={!!busy} />
        <Button
          title="2. Check /api/status"
          variant="secondary"
          onPress={() => ping('/api/status')}
          busy={busy === '/api/status'}
          disabled={!!busy}
        />
        <Button
          title={`3. Speed test (${BENCH_MB} MB)`}
          variant="secondary"
          onPress={speed}
          busy={busy === 'bench'}
          disabled={!!busy}
        />
        <Button
          title="4. Download newest clip (SD)"
          variant="secondary"
          onPress={clipSpeed}
          busy={busy === 'clip'}
          disabled={!!busy}
        />
        <Button
          title={`5. Compare 1 vs ${DOWNLOAD_PARALLEL} connections (16 MB)`}
          variant="secondary"
          onPress={compareParallel}
          busy={busy === 'parallel'}
          disabled={!!busy}
        />
      </View>

      <Card>
        <Text style={type.heading}>Log</Text>
        {log.length === 0 ? <Text style={type.dim}>Nothing yet.</Text> : null}
        {log.map((l, i) => (
          <Text key={i} style={type.mono} selectable>
            {l}
          </Text>
        ))}
      </Card>

      <Button title="Back" variant="secondary" onPress={onBack} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.xl,
    gap: space.md,
    backgroundColor: colors.bg,
  },
});
