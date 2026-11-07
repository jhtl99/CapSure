import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CONNECT_TIMEOUT_MS, DEVICE_URL, MOCK_URL, REQUEST_TIMEOUT_MS } from '../config';
import { DeviceClient } from '../device/client';
import type { DeviceStatus } from '../device/types';
import { Banner, Button, Card, Row } from '../ui/components';
import { describeError } from '../ui/messages';
import { colors, space, type } from '../ui/theme';

export function SettingsScreen({
  client,
  status,
  onConnected,
  onDisconnect,
}: {
  client: DeviceClient;
  status: DeviceStatus;
  onConnected: (client: DeviceClient, status: DeviceStatus) => void;
  onDisconnect: () => void;
}) {
  const [draft, setDraft] = useState(client.baseUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const batteryTone =
    status.battery_pct > 40 ? 'good' : status.battery_pct > 15 ? 'warn' : 'bad';

  async function applyAddress() {
    setBusy(true);
    setError(null);
    try {
      const next = new DeviceClient({
        baseUrl: draft,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      await next.getStatus({ timeoutMs: CONNECT_TIMEOUT_MS });
      const synced = await next.setTime(Date.now());
      setDraft(next.baseUrl);
      onConnected(next, synced);
    } catch (e) {
      setError(`${describeError(e)} The current device is still connected.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={type.title}>Settings</Text>
      <Text style={type.dim}>The device, and where the app looks for it.</Text>

      <Card style={{ marginTop: space.lg }}>
        <Text style={type.heading}>Host address</Text>
        <TextInput
          value={draft}
          onChangeText={setDraft}
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
            <Text style={styles.preset} onPress={() => setDraft(DEVICE_URL)}>
              device
            </Text>
            <Text style={styles.preset} onPress={() => setDraft(MOCK_URL)}>
              mock
            </Text>
          </View>
        </View>
        {error ? <Banner tone="bad">{error}</Banner> : null}
        <Button title="Use this address" onPress={applyAddress} busy={busy} />
        <Text style={type.dim}>
          On a phone, use your laptop's LAN address and stay on the same Wi-Fi.
          localhost only works in a simulator.
        </Text>
      </Card>

      <Card>
        <View style={styles.headerRow}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View
              style={[
                styles.dot,
                { backgroundColor: status.recording ? colors.recording : colors.textDim },
              ]}
            />
            <Text style={type.heading}>{status.recording ? 'Buffering' : 'Idle'}</Text>
          </View>
          <Text style={type.dim}>{status.device_id}</Text>
        </View>

        <Row label="Battery" value={`${status.battery_pct}%`} tone={batteryTone} />
        <Row label="Buffer" value={`${status.buffer_seconds}s rolling`} />
        <Row label="Storage free" value={`${status.storage_free_mb} MB`} />
        <Row label="Firmware" value={status.fw_version} />
        <Row label="Uptime" value={`${status.uptime_s}s`} />

        {!status.buffer_healthy || status.dropped_frames > 0 ? (
          <Banner tone="warn">
            {`Buffer is dropping frames (${status.dropped_frames} so far). A press ` +
              `right now might not capture cleanly.`}
          </Banner>
        ) : null}
      </Card>

      <Button title="Disconnect" variant="secondary" onPress={onDisconnect} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.lg, paddingTop: space.xl, paddingBottom: space.xl, gap: space.md },
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
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
});
