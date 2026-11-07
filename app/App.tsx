import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';

import { DEFAULT_BASE_URL, STATUS_MISSES_BEFORE_LOST, STATUS_POLL_MS } from './src/config';
import { DeviceClient } from './src/device/client';
import type { ClipMeta, DeviceStatus } from './src/device/types';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { GalleryScreen } from './src/screens/GalleryScreen';
import { PlayerScreen } from './src/screens/PlayerScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { WifiTestScreen } from './src/screens/WifiTestScreen';
import { Banner } from './src/ui/components';
import { SWITCH_HINT } from './src/ui/messages';
import { colors, space, type } from './src/ui/theme';

type Tab = 'clips' | 'settings';

/**
 * Connect, then two tabs. The player covers both while a clip is open.
 * Status polling lives here so Settings stays current without the gallery
 * having to know about the battery.
 */
export default function App() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [client, setClient] = useState<DeviceClient | null>(null);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [tab, setTab] = useState<Tab>('clips');
  const [player, setPlayer] = useState<{ clips: ClipMeta[]; id: string } | null>(null);

  const [linkLost, setLinkLost] = useState(false);
  const [wifiTest, setWifiTest] = useState(false);

  useEffect(() => {
    if (!client) return;
    let misses = 0;
    let polling = false;
    setLinkLost(false);
    const t = setInterval(() => {
      // A download already proves the link and owns the device's one client slot.
      if (polling || client.transferring) return;
      polling = true;
      client
        .getStatus()
        .then((s) => {
          misses = 0;
          setLinkLost(false);
          setStatus(s);
        })
        .catch(() => {
          // Settings still shows the last reading.
          misses++;
          if (misses >= STATUS_MISSES_BEFORE_LOST) setLinkLost(true);
        })
        .finally(() => {
          polling = false;
        });
    }, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [client]);

  function disconnect() {
    setClient(null);
    setStatus(null);
    setPlayer(null);
    setLinkLost(false);
    setTab('clips');
  }

  const connected = client && status;

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />

      {wifiTest ? (
        <WifiTestScreen onBack={() => setWifiTest(false)} />
      ) : player && client ? (
        <PlayerScreen
          client={client}
          clips={player.clips}
          startId={player.id}
          onBack={() => setPlayer(null)}
        />
      ) : connected ? (
        <View style={styles.shell}>
          {linkLost ? (
            <View style={styles.lost}>
              <Banner tone="warn">{`Lost contact with the hat. ${SWITCH_HINT}`}</Banner>
            </View>
          ) : null}
          <View style={styles.body}>
            {tab === 'clips' ? (
              <GalleryScreen
                client={client}
                onStatus={setStatus}
                onOpenClip={(meta, clips) => setPlayer({ clips, id: meta.id })}
              />
            ) : (
              <SettingsScreen
                client={client}
                status={status}
                onConnected={(c, s) => {
                  setClient(c);
                  setStatus(s);
                  setBaseUrl(c.baseUrl);
                }}
                onDisconnect={disconnect}
              />
            )}
          </View>
          <TabBar tab={tab} onChange={setTab} />
        </View>
      ) : (
        <ConnectScreen
          baseUrl={baseUrl}
          onBaseUrlChange={setBaseUrl}
          onOpenWifiTest={() => setWifiTest(true)}
          onConnected={(c, s) => {
            setClient(c);
            setStatus(s);
            setBaseUrl(c.baseUrl);
          }}
        />
      )}
    </SafeAreaView>
  );
}

function TabBar({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  return (
    <View style={styles.tabs}>
      <TabButton label="Clips" active={tab === 'clips'} onPress={() => onChange('clips')} />
      <TabButton
        label="Settings"
        active={tab === 'settings'}
        onPress={() => onChange('settings')}
      />
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.tab}>
      <Text style={[type.body, styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
      <View style={[styles.tabMark, active && styles.tabMarkActive]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  shell: { flex: 1 },
  body: { flex: 1 },
  lost: { paddingHorizontal: space.md, paddingTop: space.sm },
  tabs: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingBottom: space.xs,
  },
  tab: { flex: 1, alignItems: 'center', paddingTop: 10, gap: 6 },
  tabLabel: { color: colors.textDim, fontWeight: '600' },
  tabLabelActive: { color: colors.text },
  tabMark: { width: 18, height: 3, borderRadius: 2, backgroundColor: 'transparent' },
  tabMarkActive: { backgroundColor: colors.accent },
});
