import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
  partialFraction,
  pullClip,
} from '../device/download';
import type { ClipMeta, DeviceStatus } from '../device/types';
import { Banner } from '../ui/components';
import { ClipThumb } from '../ui/ClipThumb';
import { describeDownloadError, describeError } from '../ui/messages';
import { colors, formatBytes, radius, space, type } from '../ui/theme';

interface DownloadState {
  fraction: number;
  error?: string;
}

/** Presses more than this far apart start a new session in the list. */
const SESSION_GAP_MS = 30 * 60 * 1000;

type Item =
  | { kind: 'header'; key: string; title: string; sub: string }
  | { kind: 'row'; key: string; clips: ClipMeta[] };

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Newest first, grouped into sessions, two clips per row. */
function buildItems(clips: ClipMeta[]): Item[] {
  const sorted = [...clips].sort((a, b) => b.created_unix_ms - a.created_unix_ms || b.id.localeCompare(a.id));
  const sessions: ClipMeta[][] = [];
  for (const c of sorted) {
    const last = sessions[sessions.length - 1];
    const prev = last?.[last.length - 1];
    const sameSession =
      prev &&
      (prev.created_unix_ms === 0) === (c.created_unix_ms === 0) &&
      (c.created_unix_ms === 0 || prev.created_unix_ms - c.created_unix_ms < SESSION_GAP_MS);
    if (sameSession) last.push(c);
    else sessions.push([c]);
  }

  const items: Item[] = [];
  for (const s of sessions) {
    const first = s[s.length - 1].created_unix_ms; // oldest press in the session
    const title = first ? `${dayLabel(first)} · ${clockTime(first)}` : 'Time unknown';
    const sub = `${s.length} ${s.length === 1 ? 'shot' : 'shots'}`;
    items.push({ kind: 'header', key: `h-${s[0].id}`, title, sub });
    for (let i = 0; i < s.length; i += 2) items.push({ kind: 'row', key: `r-${s[i].id}`, clips: s.slice(i, i + 2) });
  }
  return items;
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
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const cancelBatch = useRef(false);

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

  const items = useMemo(() => buildItems(clips), [clips]);
  // Playback order matches what's on screen: newest first.
  const ordered = useMemo(
    () => items.flatMap((it) => (it.kind === 'row' ? it.clips : [])),
    [items]
  );
  const remaining = clips.filter((c) => !localIds.has(c.id));

  async function pull(meta: ClipMeta): Promise<boolean> {
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
      return true;
    } catch (e) {
      setDownloads((d) => {
        const fraction = d[meta.id]?.fraction ?? 0;
        return { ...d, [meta.id]: { fraction, error: describeDownloadError(e, fraction) } };
      });
      return false;
    }
  }

  async function downloadAll() {
    if (batch) {
      cancelBatch.current = true; // stops after the clip that's downloading now
      return;
    }
    const todo = ordered.filter((c) => !localIds.has(c.id));
    cancelBatch.current = false;
    setBatch({ done: 0, total: todo.length });
    for (let i = 0; i < todo.length && !cancelBatch.current; i++) {
      await pull(todo[i]);
      setBatch({ done: i + 1, total: todo.length });
    }
    setBatch(null);
  }

  function removeLocal(meta: ClipMeta) {
    deleteLocalClip(meta);
    setLocalIds((s) => {
      const next = new Set(s);
      next.delete(meta.id);
      return next;
    });
  }

  async function deleteFromHat(meta: ClipMeta) {
    try {
      await client.deleteClip(meta.id);
      setClips((cs) => cs.filter((c) => c.id !== meta.id));
    } catch (e) {
      setError(describeError(e));
    }
  }

  function options(meta: ClipMeta) {
    const here = localIds.has(meta.id);
    Alert.alert(
      meta.created_unix_ms ? `Shot at ${clockTime(meta.created_unix_ms)}` : `Clip ${meta.id}`,
      undefined,
      [
        ...(here ? [{ text: 'Remove from this phone', onPress: () => removeLocal(meta) }] : []),
        {
          text: 'Delete from the hat',
          style: 'destructive' as const,
          onPress: () =>
            Alert.alert('Delete this clip from the hat?', here ? 'The copy on this phone stays.' : 'It is not on this phone, so it will be gone.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => void deleteFromHat(meta) },
            ]),
        },
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  }

  // A plain render function, not a component: defining a component in here
  // would remount every thumbnail on each progress update.
  function renderTile(meta: ClipMeta) {
    const dl = downloads[meta.id];
    const here = localIds.has(meta.id);
    const busy = !!dl && !dl.error;
    const resume = !here && !busy ? partialFraction(meta) : 0;

    let state: string;
    let stateColor: string = colors.textDim;
    if (here) {
      state = 'Ready to play';
      stateColor = colors.good;
    } else if (busy) {
      state = `Downloading ${Math.round(dl.fraction * 100)}%`;
      stateColor = colors.accent;
    } else if (dl?.error) {
      state = 'Download stopped · tap to resume';
      stateColor = colors.bad;
    } else if (resume > 0) {
      state = `On the hat · tap to resume (${Math.round(resume * 100)}%)`;
    } else {
      state = `On the hat · ${formatBytes(meta.bytes)}`;
    }

    return (
      <Pressable
        key={meta.id}
        style={({ pressed }) => [styles.tile, pressed && { opacity: 0.8 }]}
        onPress={() => {
          if (here) onOpenClip(meta, ordered);
          else if (!busy) void pull(meta);
        }}
        onLongPress={() => options(meta)}
        accessibilityLabel={`${meta.created_unix_ms ? `Shot at ${clockTime(meta.created_unix_ms)}` : `Clip ${meta.id}`}, ${state}`}
      >
        <View>
          <ClipThumb client={client} clipId={meta.id} durationMs={meta.duration_ms} style={styles.thumb} />
          <View style={styles.timeChip}>
            <Text style={styles.timeText}>
              {meta.created_unix_ms ? clockTime(meta.created_unix_ms) : `#${meta.id}`}
            </Text>
          </View>
          {here ? (
            <View style={styles.readyDot} />
          ) : !busy ? (
            <View style={styles.dlBadge}>
              <Text style={styles.dlGlyph}>↓</Text>
            </View>
          ) : null}
          {busy || resume > 0 ? (
            <View style={styles.thumbTrack}>
              <View style={[styles.thumbFill, { width: `${Math.round((busy ? dl.fraction : resume) * 100)}%` }]} />
            </View>
          ) : null}
        </View>
        <Text style={[styles.state, { color: stateColor }]} numberOfLines={1}>
          {state}
        </Text>
        {dl?.error ? (
          <Text style={styles.err} numberOfLines={3}>
            {dl.error}
          </Text>
        ) : null}
      </Pressable>
    );
  }

  const onPhone = clips.length - remaining.length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.title}>Clips</Text>
          <Text style={type.dim}>
            {clips.length === 0
              ? 'Nothing saved yet'
              : `${clips.length} ${clips.length === 1 ? 'shot' : 'shots'} · ${onPhone} on this phone`}
          </Text>
        </View>
        {remaining.length > 0 || batch ? (
          <Pressable onPress={downloadAll} style={({ pressed }) => [styles.allBtn, pressed && { opacity: 0.75 }]}>
            {batch ? <ActivityIndicator size="small" color={colors.text} /> : null}
            <Text style={styles.allText}>
              {batch
                ? cancelBatch.current
                  ? 'Stopping…'
                  : `${batch.done} of ${batch.total} · Stop`
                : `Download all (${remaining.length})`}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {error ? (
        <View style={{ marginHorizontal: space.md, marginBottom: space.sm }}>
          <Banner tone="bad">{error}</Banner>
        </View>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(it) => it.key}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textDim} />}
        ListEmptyComponent={
          refreshing ? undefined : (
            <View style={styles.empty}>
              <Text style={type.heading}>No shots saved yet</Text>
              <Text style={type.dim}>
                Press the button on the hat right after a shot. It keeps the last 60 seconds of play
                at the table, and the shot shows up here. Pull down to refresh.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) =>
          item.kind === 'header' ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{item.title}</Text>
              <Text style={type.dim}>{item.sub}</Text>
            </View>
          ) : (
            <View style={styles.row}>
              {item.clips.map(renderTile)}
              {item.clips.length === 1 ? <View style={styles.tileSpacer} /> : null}
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  allBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  allText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  list: { paddingHorizontal: space.md, paddingBottom: space.xl, gap: space.md },
  section: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: space.sm },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', gap: space.sm + 4 },
  tile: { flex: 1, gap: 6 },
  tileSpacer: { flex: 1 },
  thumb: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.md },
  timeChip: {
    position: 'absolute',
    left: 6,
    top: 6,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  timeText: { color: '#fff', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readyDot: {
    position: 'absolute',
    right: 8,
    top: 8,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.good,
    borderWidth: 2,
    borderColor: 'rgba(0,0,0,0.5)',
  },
  dlBadge: {
    position: 'absolute',
    right: 6,
    top: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dlGlyph: { color: '#fff', fontSize: 14, fontWeight: '700', marginTop: -1 },
  thumbTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 4,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  thumbFill: { height: 4, backgroundColor: colors.accent },
  state: { fontSize: 12.5 },
  err: { color: colors.bad, fontSize: 12 },
  empty: { paddingVertical: space.lg, gap: space.sm },
});
