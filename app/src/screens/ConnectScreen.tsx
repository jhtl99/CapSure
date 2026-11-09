import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';

import { DeviceClient } from '../device/client';
import type { DeviceStatus } from '../device/types';
import { normalizeBaseUrl } from '../device/validate';
import {
  AUTO_CONNECT_MS,
  CONNECT_TIMEOUT_MS,
  DEVICE_URL,
  HAT_NETWORK,
  HAT_PASSWORD,
  MOCK_URL,
  REQUEST_TIMEOUT_MS,
} from '../config';
import { Banner, Button, Card, Row } from '../ui/components';
import { describeError } from '../ui/messages';
import { colors, radius, space, type } from '../ui/theme';

/**
 * Getting the phone onto the hat. The steps are what a player does; the app
 * keeps looking for the hat in the background, so coming back from Wi-Fi
 * settings is enough. Addresses and the mock live under Developer options.
 */
export function ConnectScreen({
  baseUrl,
  onBaseUrlChange,
  onConnected,
  onOpenWifiTest,
  autoConnect = true,
}: {
  baseUrl: string;
  onBaseUrlChange: (url: string) => void;
  onConnected: (client: DeviceClient, status: DeviceStatus) => void;
  onOpenWifiTest: () => void;
  /** False right after the user disconnected on purpose. */
  autoConnect?: boolean;
}) {
  const [looking, setLooking] = useState(autoConnect);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [devOpen, setDevOpen] = useState(baseUrl !== DEVICE_URL);
  const [preview, setPreview] = useState<string | null>(null);
  const attempting = useRef(false);
  const done = useRef(false);

  async function attempt(quiet: boolean) {
    if (attempting.current || done.current) return;
    attempting.current = true;
    if (!quiet) {
      setBusy(true);
      setError(null);
    }
    try {
      const client = new DeviceClient({ baseUrl, timeoutMs: REQUEST_TIMEOUT_MS });
      const status = await client.getStatus({ timeoutMs: quiet ? 2500 : CONNECT_TIMEOUT_MS });
      // The hat has no battery-backed clock. Set it before anything else, or
      // every clip it saves is stamped with the wrong time.
      const synced = await client.setTime(Date.now());
      done.current = true;
      onConnected(client, synced ?? status);
    } catch (e) {
      setTries((n) => n + 1);
      if (!quiet) setError(describeError(e));
    } finally {
      attempting.current = false;
      if (!quiet) setBusy(false);
    }
  }

  // Keep looking while this screen is open and the app is in front. Coming
  // back from Wi-Fi settings triggers a try straight away.
  useEffect(() => {
    let valid = true;
    try {
      normalizeBaseUrl(baseUrl);
    } catch {
      valid = false;
    }
    if (!valid || !looking) return;
    void attempt(true);
    const t = setInterval(() => {
      if (AppState.currentState === 'active') void attempt(true);
    }, AUTO_CONNECT_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void attempt(true);
    });
    return () => {
      clearInterval(t);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, looking]);

  function checkCamera() {
    try {
      setPreview(`${normalizeBaseUrl(baseUrl)}/api/preview?t=${Date.now()}`);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }

  const steps = [
    { title: 'Turn on the Wi-Fi switch on the hat', body: 'The hat only broadcasts while the switch is on, to save battery.' },
    { title: `Join “${HAT_NETWORK}” in Wi-Fi settings`, body: `Password ${HAT_PASSWORD}. If your phone warns that the network has no internet, stay connected.` },
    { title: 'Come back here', body: 'CapSure connects on its own as soon as the hat answers.' },
  ];

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 4 }}>
        <Text style={styles.brand}>CapSure</Text>
        <Text style={type.dim}>Keep the shot you just played.</Text>
      </View>

      {looking ? (
        <View style={styles.searching}>
          <ActivityIndicator color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={type.body}>Looking for your hat…</Text>
            <Text style={type.dim}>
              {tries === 0 ? 'Checking now' : `Checked ${tries} ${tries === 1 ? 'time' : 'times'}, trying every few seconds`}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.searching}>
          <View style={{ flex: 1 }}>
            <Text style={type.body}>Disconnected</Text>
            <Text style={type.dim}>Tap Connect now when you want to reconnect.</Text>
          </View>
        </View>
      )}

      <Card>
        {steps.map((s, i) => (
          <View key={s.title} style={styles.step}>
            <View style={styles.stepNum}>
              <Text style={styles.stepNumText}>{i + 1}</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={type.heading}>{s.title}</Text>
              <Text style={type.dim}>{s.body}</Text>
            </View>
          </View>
        ))}
      </Card>

      {error ? <Banner tone="bad">{error}</Banner> : null}
      <Button
        title="Connect now"
        onPress={() => {
          setLooking(true); // keep trying in the background from here on
          void attempt(false);
        }}
        busy={busy}
      />

      <Pressable onPress={() => setDevOpen((o) => !o)} style={styles.devToggle} accessibilityRole="button">
        <Text style={type.dim}>{devOpen ? 'Developer options ▴' : 'Developer options ▾'}</Text>
      </Pressable>

      {devOpen ? (
        <Card>
          <Text style={type.heading}>Device address</Text>
          <TextInput
            value={baseUrl}
            onChangeText={onBaseUrlChange}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={DEVICE_URL}
            placeholderTextColor={colors.textDim}
            style={styles.input}
          />
          <View style={styles.presets}>
            <Text style={styles.preset} onPress={() => onBaseUrlChange(DEVICE_URL)}>
              hat (192.168.4.1)
            </Text>
            <Text style={styles.preset} onPress={() => onBaseUrlChange(MOCK_URL)}>
              mock server
            </Text>
          </View>
          <View style={{ gap: space.sm }}>
            <Button title="Check camera" variant="secondary" onPress={checkCamera} />
            <Button title="Wi-Fi test" variant="secondary" onPress={onOpenWifiTest} />
          </View>
          {preview ? (
            <Image
              source={{ uri: preview }}
              style={styles.preview}
              contentFit="cover"
              cachePolicy="none"
              onError={() => setError('No picture from the camera. It may still be starting up.')}
            />
          ) : null}
          <Row label="Mock" value="python3 mock-device/serve.py" />
          <Text style={type.dim}>
            On a real phone, point the address at your laptop's LAN IP (ipconfig getifaddr en0) on port
            8080 and keep both on the same Wi-Fi. localhost only works in a simulator.
          </Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.lg, paddingTop: space.xl, paddingBottom: space.xl, gap: space.md },
  brand: { fontSize: 30, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  searching: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  step: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start', paddingVertical: 4 },
  stepNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNumText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  devToggle: { alignSelf: 'center', paddingVertical: space.sm },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    padding: 12,
    fontSize: 15,
  },
  presets: { flexDirection: 'row', gap: space.md },
  preset: { color: colors.accent, fontSize: 13, paddingVertical: 2 },
  preview: { width: '100%', aspectRatio: 4 / 3, borderRadius: 6, backgroundColor: colors.surfaceAlt },
});
