import { useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';

import { DeviceClient, DeviceUnreachableError } from '../device/client';
import type { DeviceStatus } from '../device/types';
import { DEVICE_URL, MOCK_URL, REQUEST_TIMEOUT_MS } from '../config';
import { Banner, Button, Card, Row } from '../ui/components';
import { colors, space, type } from '../ui/theme';

export function ConnectScreen({
  baseUrl,
  onBaseUrlChange,
  onConnected,
}: {
  baseUrl: string;
  onBaseUrlChange: (url: string) => void;
  onConnected: (client: DeviceClient, status: DeviceStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const client = new DeviceClient({
        baseUrl,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      const status = await client.getStatus();
      // The device has no battery-backed clock. Set it before anything else,
      // or every clip it saves from here on is stamped with nonsense.
      const synced = await client.setTime(Date.now());
      onConnected(client, synced ?? status);
    } catch (e) {
      setError(
        e instanceof DeviceUnreachableError
          ? 'No answer. Is the device awake, and is your phone on its Wi-Fi?'
          : e instanceof Error
            ? e.message
            : String(e)
      );
    } finally {
      setBusy(false);
    }
  }

  function checkCamera() {
    // Cache-bust so we get a fresh frame rather than a remembered one.
    setPreview(`${baseUrl.replace(/\/+$/, '')}/api/preview?t=${Date.now()}`);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={type.title}>CapSure</Text>
      <Text style={type.dim}>The minute before you pressed the button.</Text>

      <Card style={{ marginTop: space.lg }}>
        <Text style={type.heading}>Device address</Text>
        <TextInput
          value={baseUrl}
          onChangeText={onBaseUrlChange}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.4.1"
          placeholderTextColor={colors.textDim}
          style={styles.input}
        />
        <View style={styles.presets}>
          <Text style={type.dim}>Presets</Text>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Text style={styles.preset} onPress={() => onBaseUrlChange(DEVICE_URL)}>
              device
            </Text>
            <Text style={styles.preset} onPress={() => onBaseUrlChange(MOCK_URL)}>
              mock
            </Text>
          </View>
        </View>
      </Card>

      {error ? (
        <View style={{ marginTop: space.md }}>
          <Banner tone="bad">{error}</Banner>
        </View>
      ) : null}

      <View style={{ marginTop: space.md, gap: space.sm }}>
        <Button title="Connect" onPress={connect} busy={busy} />
        <Button title="Check camera" variant="secondary" onPress={checkCamera} />
      </View>

      {preview ? (
        <Card style={{ marginTop: space.md }}>
          <Text style={type.heading}>Live frame</Text>
          <Image
            source={{ uri: preview }}
            style={styles.preview}
            contentFit="cover"
            cachePolicy="none"
            onError={() => setError('Preview failed. The camera may not be ready.')}
          />
          <Text style={type.dim}>
            One frame, pulled just now. This is the fastest way to tell whether
            the sensor and the radio are both alive.
          </Text>
        </Card>
      ) : null}

      <Card style={{ marginTop: space.lg }}>
        <Text style={type.heading}>Working against the mock</Text>
        <Row label="1" value="python3 mock-device/serve.py" />
        <Row label="2" value="ipconfig getifaddr en0" />
        <Row label="3" value="http://THAT-IP:8080" />
        <Text style={type.dim}>
          On a simulator, localhost works. On a real phone, use your laptop's
          LAN address and stay on the same Wi-Fi.
        </Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.lg, paddingTop: space.xl, paddingBottom: space.xl },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    padding: 12,
    fontSize: 15,
  },
  presets: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  preset: {
    color: colors.accent,
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  preview: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 6,
    backgroundColor: colors.surfaceAlt,
  },
});
