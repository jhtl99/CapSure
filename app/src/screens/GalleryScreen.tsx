import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { DeviceClient } from '../device/client';
import {
  deleteLocalClip,
  isDownloaded,
  localClipFile,
  partialFraction,
  pullClip,
} from '../device/download';
import type { ClipMeta, DeviceStatus } from '../device/types';
import { Banner, Progress } from '../ui/components';
import { ClipThumb } from '../ui/ClipThumb';
import { describeDownloadError, describeError } from '../ui/messages';
import {
  colors,
  formatBytes,
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
  onStatus,
  onOpenClip,
}: {
  client: DeviceClient;
  onStatus: (s: DeviceStatus) => void;
  onOpenClip: (meta: ClipMeta, clips: ClipMeta[]) => void;
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
      setError(describeError(e));
    } finally {
      setRefreshing(false);
    }
  }, [client, onStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function pull(meta: ClipMeta) {
    setDownloads((d) => ({ ...d, [meta.id]: { fraction: partialFraction(meta) } }));

    try {
      await pullClip(client, meta, (p) => {
        setDownloads((d) => ({ ...d, [meta.id]: { fraction: p.fraction } }));
      });
      setLocalIds((s) => new Set(s).add(meta.id));
      setDownloads((d) => {
        const next = { ...d };
        delete next[meta.id];
        return next;
      });
    } catch (e) {
      setDownloads((d) => {
        const fraction = d[meta.id]?.fraction ?? 0;
        return {
          ...d,
          [meta.id]: { fraction, error: describeDownloadError(e, fraction) },
        };
      });
    }
  }

  function removeLocal(meta: ClipMeta) {
    deleteLocalClip(meta);
    setLocalIds((s) => {
      const next = new Set(s);
      next.delete(meta.id);
      return next;
    });
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={type.title}>Clips</Text>
        <Text style={type.dim}>
          {clips.length === 1 ? '1 clip' : `${clips.length} clips`}
        </Text>
      </View>

      {error ? (
        <View style={{ marginHorizontal: space.md, marginBottom: space.sm }}>
          <Banner tone="bad">{error}</Banner>
        </View>
      ) : null}

      <FlatList
        data={clips}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.textDim}
          />
        }
        ListEmptyComponent={
          refreshing ? undefined : (
            <View style={styles.empty}>
              <Text style={type.heading}>No clips yet</Text>
              <Text style={type.dim}>
                Press the button on the device to save the last 60 seconds, then
                pull down to refresh.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const dl = downloads[item.id];
          const here = localIds.has(item.id);
          const busy = !!dl && !dl.error;

          return (
            <View style={styles.row}>
              <Pressable
                onPress={() => {
                  if (here) onOpenClip(item, clips);
                  else if (!busy) void pull(item);
                }}
                style={({ pressed }) => [styles.rowMain, pressed && styles.rowPressed]}
              >
                <ClipThumb
                  client={client}
                  clipId={item.id}
                  durationMs={item.duration_ms}
                  style={styles.thumb}
                />

                <View style={styles.meta}>
                  <Text style={type.heading} numberOfLines={1}>
                    {formatWhen(item.created_unix_ms)}
                  </Text>
                  <Text style={type.dim} numberOfLines={1}>
                    {item.width && item.height
                      ? `${item.width}×${item.height} · ${formatBytes(item.bytes)}`
                      : formatBytes(item.bytes)}
                  </Text>

                  {dl && !dl.error ? (
                    <View style={{ gap: 4 }}>
                      <Progress fraction={dl.fraction} />
                      <Text style={type.dim}>{`${Math.round(dl.fraction * 100)}%`}</Text>
                    </View>
                  ) : (
                    <Text style={[type.dim, here && { color: colors.good }]}>
                      {here
                        ? `On this phone · ${formatBytes(localClipFile(item).size)}`
                        : partialFraction(item) > 0
                          ? `On device · tap to resume (${Math.round(partialFraction(item) * 100)}%)`
                          : 'On device · tap to download'}
                    </Text>
                  )}

                  {dl?.error ? (
                    <Text style={{ color: colors.bad, fontSize: 13 }}>{dl.error}</Text>
                  ) : null}
                </View>
              </Pressable>

              {here ? (
                <Text style={styles.remove} onPress={() => removeLocal(item)}>
                  Remove
                </Text>
              ) : null}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: space.md,
    paddingTop: space.lg,
    paddingBottom: space.sm,
    gap: 2,
  },
  list: { paddingHorizontal: space.sm, paddingBottom: space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: 12,
  },
  rowPressed: { backgroundColor: colors.surface },
  thumb: { width: 132, height: 84 },
  meta: { flex: 1, gap: 3 },
  remove: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  empty: { padding: space.lg, gap: space.sm },
});
