import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { DeviceClient } from '../device/client';
import {
  deleteLocalClip,
  downloadClip,
  isDownloaded,
  localClipFile,
} from '../device/download';
import type { ClipMeta, DeviceStatus } from '../device/types';
import { STATUS_POLL_MS } from '../config';
import { Banner, Button, Card, Progress, Row } from '../ui/components';
import {
  colors,
  formatBytes,
  formatDuration,
  formatWhen,
  space,
  type,
} from '../ui/theme';

interface DownloadState {
  fraction: number;
  error?: string;
}

export function GalleryScreen({
  client,
  status,
  onStatus,
  onOpenClip,
  onDisconnect,
}: {
  client: DeviceClient;
  status: DeviceStatus;
  onStatus: (s: DeviceStatus) => void;
  onOpenClip: (meta: ClipMeta) => void;
  onDisconnect: () => void;
}) {
  const [clips, setClips] = useState<ClipMeta[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  const [localIds, setLocalIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, list] = await Promise.all([client.getStatus(), client.listClips()]);
      onStatus(s);
      setClips(list);
      setLocalIds(new Set(list.filter(isDownloaded).map((c) => c.id)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [client, onStatus]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      // Status only: re-listing clips on a timer would fight the pull-to-refresh.
      client
        .getStatus()
        .then(onStatus)
        .catch(() => {
          /* the device sleeps; the banner already says so */
        });
    }, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [client, onStatus, refresh]);

  async function pull(meta: ClipMeta) {
    setDownloads((d) => ({ ...d, [meta.id]: { fraction: 0 } }));
    const handle = downloadClip(client.clipUrl(meta.id), meta, (p) => {
      setDownloads((d) => ({ ...d, [meta.id]: { fraction: p.fraction } }));
    });

    try {
      await handle.promise;
      // Only ack once the bytes are all here. The device keeps the clip
      // protected until we do, which is the whole point of the handshake.
      await client.ackClip(meta.id);
      setLocalIds((s) => new Set(s).add(meta.id));
      setDownloads((d) => {
        const next = { ...d };
        delete next[meta.id];
        return next;
      });
    } catch (e) {
      setDownloads((d) => ({
        ...d,
        [meta.id]: {
          fraction: d[meta.id]?.fraction ?? 0,
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  }

  function removeLocal(meta: ClipMeta) {
    deleteLocalClip(meta.id);
    setLocalIds((s) => {
      const next = new Set(s);
      next.delete(meta.id);
      return next;
    });
  }

  const batteryTone =
    status.battery_pct > 40 ? 'good' : status.battery_pct > 15 ? 'warn' : 'bad';

  return (
    <View style={styles.container}>
      <Card style={{ margin: space.md }}>
        <View style={styles.headerRow}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View
              style={[
                styles.dot,
                { backgroundColor: status.recording ? colors.recording : colors.textDim },
              ]}
            />
            <Text style={type.heading}>
              {status.recording ? 'Buffering' : 'Idle'}
            </Text>
          </View>
          <Text style={type.dim} onPress={onDisconnect}>
            disconnect
          </Text>
        </View>

        <Row label="Battery" value={`${status.battery_pct}%`} tone={batteryTone} />
        <Row label="Buffer" value={`${status.buffer_seconds}s rolling`} />
        <Row label="Storage free" value={`${status.storage_free_mb} MB`} />
        <Row label="Firmware" value={status.fw_version} />

        {!status.buffer_healthy || status.dropped_frames > 0 ? (
          <Banner tone="warn">
            {`Buffer is dropping frames (${status.dropped_frames} so far). A press ` +
              `right now might not capture cleanly.`}
          </Banner>
        ) : null}
      </Card>

      {error ? (
        <View style={{ marginHorizontal: space.md }}>
          <Banner tone="bad">{error}</Banner>
        </View>
      ) : null}

      <FlatList
        data={clips}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ padding: space.md, paddingTop: 0, gap: space.sm }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.textDim}
          />
        }
        ListEmptyComponent={
          refreshing ? null : (
            <Card>
              <Text style={type.heading}>No clips yet</Text>
              <Text style={type.dim}>
                Press the button on the device to save the last 60 seconds, then
                pull down to refresh.
              </Text>
            </Card>
          )
        }
        renderItem={({ item }) => {
          const dl = downloads[item.id];
          const here = localIds.has(item.id);

          return (
            <Card>
              <View style={styles.headerRow}>
                <Text style={type.heading}>{formatWhen(item.created_unix_ms)}</Text>
                <Text style={type.dim}>{formatDuration(item.duration_ms)}</Text>
              </View>

              <Row
                label={`${item.width}x${item.height} @ ${item.fps}fps`}
                value={formatBytes(item.bytes)}
              />

              {dl && !dl.error ? (
                <View style={{ gap: 6, marginTop: 4 }}>
                  <Progress fraction={dl.fraction} />
                  <Text style={type.dim}>
                    {`${Math.round(dl.fraction * 100)}% - ` +
                      `${formatBytes(Math.round(dl.fraction * item.bytes))} of ` +
                      `${formatBytes(item.bytes)}`}
                  </Text>
                </View>
              ) : null}

              {dl?.error ? <Banner tone="bad">{dl.error}</Banner> : null}

              <View style={{ flexDirection: 'row', gap: space.sm, marginTop: 4 }}>
                {here ? (
                  <>
                    <View style={{ flex: 1 }}>
                      <Button title="Play" onPress={() => onOpenClip(item)} />
                    </View>
                    <Button
                      title="Remove"
                      variant="secondary"
                      onPress={() => removeLocal(item)}
                    />
                  </>
                ) : (
                  <View style={{ flex: 1 }}>
                    <Button
                      title={dl?.error ? 'Retry download' : 'Download'}
                      onPress={() => pull(item)}
                      busy={!!dl && !dl.error}
                    />
                  </View>
                )}
              </View>

              {here ? (
                <Text style={type.dim}>
                  {`On this phone - ${localClipFile(item.id).size ? formatBytes(localClipFile(item.id).size) : ''}` +
                    (item.acked ? ' - device may reuse the space' : '')}
                </Text>
              ) : null}
            </Card>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
});
