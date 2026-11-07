import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';

import { DeviceClient } from '../device/client';
import { avDriftMs, frameIndexAt } from '../device/clip';
import { isDownloaded, localClipFile, partialFraction, pullClip } from '../device/download';
import type { ClipMeta } from '../device/types';
import { prepareClip } from '../player/prepare';
import type { PreparedClip, PrepareProgress } from '../player/prepare';
import { Banner, Button, Card, Progress, Row } from '../ui/components';
import { ClipThumb } from '../ui/ClipThumb';
import { describeDownloadError } from '../ui/messages';
import { colors, formatDuration, formatWhen, space, type } from '../ui/theme';

const SWIPE_PX = 56;

export function PlayerScreen({
  client,
  clips,
  startId,
  onBack,
}: {
  client: DeviceClient;
  clips: ClipMeta[];
  startId: string;
  onBack: () => void;
}) {
  const initial = Math.max(0, clips.findIndex((c) => c.id === startId));
  const [index, setIndex] = useState(initial);
  const [dragX, setDragX] = useState(0);
  const indexRef = useRef(initial);
  const clipsRef = useRef(clips);
  indexRef.current = index;
  clipsRef.current = clips;

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) =>
        Math.abs(g.dx) > 18 && Math.abs(g.dx) > Math.abs(g.dy) * 1.3,
      onPanResponderMove: (_, g) => setDragX(g.dx),
      onPanResponderRelease: (_, g) => {
        const i = indexRef.current;
        const list = clipsRef.current;
        if (g.dx <= -SWIPE_PX && i < list.length - 1) setIndex(i + 1);
        else if (g.dx >= SWIPE_PX && i > 0) setIndex(i - 1);
        setDragX(0);
      },
      onPanResponderTerminate: () => setDragX(0),
    })
  ).current;

  const meta = clips[index];
  const prev = index > 0 ? clips[index - 1] : undefined;
  const next = index < clips.length - 1 ? clips[index + 1] : undefined;
  if (!meta) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={type.dim} onPress={onBack}>
          back to clips
        </Text>
      </View>
    );
  }

  const towardNext = dragX < 0;
  const pull = Math.min(1, Math.abs(dragX) / 180);

  return (
    <View style={styles.screen} {...pan.panHandlers}>
      <View style={{ flex: 1, transform: [{ translateX: dragX * 0.18 }] }}>
        <ClipStage key={meta.id} client={client} meta={meta} onBack={onBack} />
      </View>

      {prev || next ? (
        <View style={[styles.reel, { transform: [{ translateX: dragX * 0.35 }] }]}>
          <Neighbor
            client={client}
            meta={prev}
            emphasize={!towardNext ? pull : 0}
            onPress={prev ? () => setIndex(index - 1) : undefined}
          />
          <Neighbor
            client={client}
            meta={next}
            emphasize={towardNext ? pull : 0}
            onPress={next ? () => setIndex(index + 1) : undefined}
          />
        </View>
      ) : null}
    </View>
  );
}

function Neighbor({
  client,
  meta,
  emphasize,
  onPress,
}: {
  client: DeviceClient;
  meta?: ClipMeta;
  emphasize: number;
  onPress?: () => void;
}) {
  if (!meta || !onPress) {
    return <View style={styles.neighborSlot} />;
  }
  const scale = 0.94 + emphasize * 0.1;
  return (
    <Pressable onPress={onPress} style={styles.neighborSlot}>
      <View style={{ transform: [{ scale }], width: '100%' }}>
        <ClipThumb
          client={client}
          clipId={meta.id}
          durationMs={meta.duration_ms}
          style={styles.neighborThumb}
        />
      </View>
      <Text style={styles.neighborLabel} numberOfLines={1}>
        {formatWhen(meta.created_unix_ms)}
      </Text>
    </Pressable>
  );
}

function ClipStage({
  client,
  meta,
  onBack,
}: {
  client: DeviceClient;
  meta: ClipMeta;
  onBack: () => void;
}) {
  const [downloadedId, setDownloadedId] = useState<string | null>(null);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = downloadedId === meta.id || isDownloaded(meta);

  async function pull() {
    setBusy(true);
    setError(null);
    let reached = partialFraction(meta);
    setFraction(reached);
    try {
      await pullClip(client, meta, (p) => {
        reached = p.fraction;
        setFraction(p.fraction);
      });
      setDownloadedId(meta.id);
    } catch (e) {
      setError(describeDownloadError(e, reached));
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <View style={styles.container}>
        <Text style={type.dim} onPress={onBack}>
          back to clips
        </Text>
        <ClipThumb client={client} clipId={meta.id} style={styles.stage} />
        <Text style={type.heading}>{formatWhen(meta.created_unix_ms)}</Text>
        <Text style={type.dim}>This clip is still on the device.</Text>
        {busy ? <Progress fraction={fraction} /> : null}
        {error ? <Banner tone="bad">{error}</Banner> : null}
        <Button
          title={error || partialFraction(meta) > 0 ? 'Resume download' : 'Download'}
          onPress={pull}
          busy={busy}
        />
      </View>
    );
  }

  if (meta.format === 'mov') {
    return <MovPlayer meta={meta} onBack={onBack} />;
  }
  return <CapPlayer meta={meta} onBack={onBack} />;
}

/**
 * A QuickTime file downloaded from the mock. The phone already knows how to
 * play it, so this is the system player rather than the CAPS1 frame clock.
 */
function MovPlayer({ meta, onBack }: { meta: ClipMeta; onBack: () => void }) {
  const file = localClipFile(meta);
  const player = useVideoPlayer(file.uri, (p) => {
    p.loop = false;
  });

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {
      /* not fatal: audio just respects the ringer switch */
    });
  }, []);

  const aspect = meta.width > 0 && meta.height > 0 ? meta.width / meta.height : 16 / 9;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={type.dim} onPress={onBack}>
        back to clips
      </Text>

      <View style={[styles.stage, { aspectRatio: aspect }]}>
        <VideoView
          player={player}
          style={styles.frame}
          nativeControls
          contentFit="contain"
        />
      </View>

      <Card style={{ marginTop: space.md }}>
        <Text style={type.heading}>Clip detail</Text>
        <Row label="File" value={`${meta.id}.mov`} />
        <Row
          label="Resolution"
          value={meta.width && meta.height ? `${meta.width}x${meta.height}` : 'unknown'}
        />
        <Row label="Duration" value={formatDuration(meta.duration_ms)} />
        <Row
          label="Audio"
          value={meta.audio_sample_rate ? `${meta.audio_sample_rate} Hz` : 'none'}
        />
      </Card>
    </ScrollView>
  );
}

/**
 * Playback of a CAPS1 clip.
 *
 * The audio file is the clock. Frames carry a pts_us stamped against the same
 * device clock as the audio, so showing the right frame is a binary search into
 * the frame list for wherever the audio currently is. Nothing here tries to
 * keep two timelines in step by hand -- the firmware already did that work by
 * stamping both streams once.
 */
function CapPlayer({
  meta,
  onBack,
}: {
  meta: ClipMeta;
  onBack: () => void;
}) {
  const [prepared, setPrepared] = useState<PreparedClip | null>(null);
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const player = useAudioPlayer(prepared?.audioUri ?? null, {
    updateInterval: 100,
  });
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- unpack the clip ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {
      /* not fatal: audio just respects the ringer switch */
    });

    prepareClip(meta.id, localClipFile(meta), (p) => {
      if (!cancelled) setProgress(p);
    })
      .then((p) => {
        if (!cancelled) setPrepared(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [meta.id]);

  // --- drive the frames off the audio clock ---------------------------
  useEffect(() => {
    if (!prepared) return;

    function tick() {
      if (!prepared) return;
      const timeUs = player.currentTime * 1_000_000;
      const i = frameIndexAt(prepared.index.video, timeUs);
      setFrame((prev) => (i === prev ? prev : i));
      setElapsedMs(player.currentTime * 1000);

      if (player.currentTime * 1000 >= prepared.durationMs - 50) {
        setPlaying(false);
      }
    }

    // Twice the frame rate: fast enough that no frame is late, cheap enough
    // that it costs nothing at 480p15.
    tickRef.current = setInterval(tick, 1000 / (prepared.index.header.fps * 2));
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [prepared, player]);

  function toggle() {
    if (!prepared) return;
    if (playing) {
      player.pause();
      setPlaying(false);
    } else {
      if (player.currentTime * 1000 >= prepared.durationMs - 50) {
        void player.seekTo(0);
      }
      player.play();
      setPlaying(true);
    }
  }

  function scrub(fraction: number) {
    if (!prepared) return;
    const target = (prepared.durationMs / 1000) * fraction;
    void player.seekTo(target);
    setElapsedMs(target * 1000);
    setFrame(frameIndexAt(prepared.index.video, target * 1_000_000));
  }

  if (error) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={type.dim} onPress={onBack}>
          back
        </Text>
        <View style={{ marginTop: space.md }}>
          <Banner tone="bad">{error}</Banner>
        </View>
        <Text style={[type.dim, { marginTop: space.md }]}>
          A parse failure here usually means the transfer was cut short. Delete
          the local copy in the gallery and download it again.
        </Text>
      </ScrollView>
    );
  }

  if (!prepared) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={colors.accent} />
        <Text style={[type.dim, { marginTop: space.md }]}>
          {progress?.stage === 'frames'
            ? `Unpacking frames ${Math.round((progress.fraction ?? 0) * 100)}%`
            : progress?.stage === 'audio'
              ? 'Building audio'
              : 'Reading clip'}
        </Text>
      </View>
    );
  }

  const drift = avDriftMs(prepared.index);
  const fraction = prepared.durationMs ? elapsedMs / prepared.durationMs : 0;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={type.dim} onPress={onBack}>
        back to clips
      </Text>

      <View style={styles.stage}>
        {prepared.frameUris.length ? (
          <Image
            source={{ uri: prepared.frameUris[frame] }}
            style={styles.frame}
            contentFit="contain"
            cachePolicy="memory"
            transition={0}
          />
        ) : (
          <Text style={type.dim}>This clip has no video frames.</Text>
        )}
      </View>

      <Pressable onPress={(e) => scrub(e.nativeEvent.locationX / 320)}>
        <Progress fraction={fraction} />
      </Pressable>

      <View style={styles.timeRow}>
        <Text style={type.mono}>{formatDuration(elapsedMs)}</Text>
        <Text style={type.mono}>{formatDuration(prepared.durationMs)}</Text>
      </View>

      <Button title={playing ? 'Pause' : 'Play'} onPress={toggle} />

      <Card style={{ marginTop: space.md }}>
        <Text style={type.heading}>Clip detail</Text>
        <Row
          label="Resolution"
          value={`${prepared.index.header.width}x${prepared.index.header.height}`}
        />
        <Row
          label="Frames"
          value={`${prepared.index.video.length} @ ${prepared.index.header.fps}fps`}
        />
        <Row
          label="Audio"
          value={
            prepared.audioUri
              ? `${prepared.index.header.audioSampleRate} Hz mono`
              : 'none'
          }
        />
        <Row label="Frame shown" value={`#${frame}`} />
        <Row
          label="A/V drift"
          value={`${drift >= 0 ? '+' : ''}${drift.toFixed(1)} ms`}
          tone={Math.abs(drift) > 100 ? 'bad' : Math.abs(drift) > 40 ? 'warn' : 'good'}
        />
        <Text style={type.dim}>
          Drift is how far apart the two streams end. Past about 40 ms a person
          starts to notice; past 100 ms the clip looks broken.
        </Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  reel: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  neighborSlot: { flex: 1, gap: 4 },
  neighborThumb: { width: '100%', aspectRatio: 16 / 9 },
  neighborLabel: { fontSize: 11, color: colors.textDim },
  container: { padding: space.md, paddingTop: space.xl, gap: space.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stage: {
    width: '100%',
    aspectRatio: 4 / 3,
    backgroundColor: '#000',
    borderRadius: 8,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: { width: '100%', height: '100%' },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between' },
});
