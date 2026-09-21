import { useState } from 'react';
import { SafeAreaView, StatusBar, StyleSheet } from 'react-native';

import { DEFAULT_BASE_URL } from './src/config';
import { DeviceClient } from './src/device/client';
import type { ClipMeta, DeviceStatus } from './src/device/types';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { GalleryScreen } from './src/screens/GalleryScreen';
import { PlayerScreen } from './src/screens/PlayerScreen';
import { colors } from './src/ui/theme';

/**
 * Three screens and a state variable. No navigation library on purpose -- the
 * app has exactly one path through it, and a router would be more machinery
 * than the whole flow deserves. Revisit if we add settings or sharing.
 */
export default function App() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [client, setClient] = useState<DeviceClient | null>(null);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [clip, setClip] = useState<ClipMeta | null>(null);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />

      {clip ? (
        <PlayerScreen meta={clip} onBack={() => setClip(null)} />
      ) : client && status ? (
        <GalleryScreen
          client={client}
          status={status}
          onStatus={setStatus}
          onOpenClip={setClip}
          onDisconnect={() => {
            setClient(null);
            setStatus(null);
          }}
        />
      ) : (
        <ConnectScreen
          baseUrl={baseUrl}
          onBaseUrlChange={setBaseUrl}
          onConnected={(c, s) => {
            setClient(c);
            setStatus(s);
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
