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
import { colors, formatDuration, formatWhen, radius, space, type } from '../ui/theme';

const SWIPE_PX = 56;

/** True while a finger is on the seek bar, so the clip swiper leaves the drag alone. */
const scrubbing = { active: false };

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
        !scrubbing.active && Math.abs(g.dx) > 18 && Math.abs(g.dx) > Math.abs(g.dy) * 1.3,
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
        <TopBar meta={meta} onBack={onBack} />
        <ClipThumb client={client} clipId={meta.id} style={styles.stage} />
        <Text style={type.dim}>This shot is still on the hat. The picture above is the moment you pressed the button.</Text>
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
      <TopBar meta={meta} onBack={onBack} />

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

/** "‹ Clips" plus the shot's time, at the top of every player state. */
function TopBar({ meta, onBack }: { meta: ClipMeta; onBack: () => void }) {
  return (
    <View style={styles.topBar}>
      <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back to clips">
        <Text style={styles.back}>‹ Clips</Text>
      </Pressable>
      <Text style={styles.topTitle} numberOfLines={1}>
        {meta.created_unix_ms ? formatWhen(meta.created_unix_ms) : `Clip ${meta.id}`}
      </Text>
      <View style={{ width: 56 }} />
    </View>
  );
}

const SPEEDS = [1, 0.5, 0.25] as const;
type Speed = (typeof SPEEDS)[number];

/** A seek bar you can tap or drag, sized from its own layout. */
function Scrubber({ fraction, onSeek }: { fraction: number; onSeek: (f: number, done: boolean) => void }) {
  const width = useRef(1);
  const startX = useRef(0);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const at = (x: number) => Math.max(0, Math.min(1, x / width.current));
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,      // don't hand the drag to the clip swiper
      // The children ignore touches, so locationX is always relative to the
      // bar; after that, follow the drag distance rather than locationX.
      onPanResponderGrant: (e) => {
        scrubbing.active = true;
        startX.current = e.nativeEvent.locationX;
        onSeekRef.current(at(startX.current), false);
      },
      onPanResponderMove: (_, g) => onSeekRef.current(at(startX.current + g.dx), false),
      onPanResponderRelease: (_, g) => {
        scrubbing.active = false;
        onSeekRef.current(at(startX.current + g.dx), true);
      },
      onPanResponderTerminate: () => {
        scrubbing.active = false;
      },
    })
  ).current;
  const pct = `${Math.max(0, Math.min(1, fraction)) * 100}%` as const;
  return (
    <View
      style={styles.scrub}
      onLayout={(e) => (width.current = Math.max(1, e.nativeEvent.layout.width))}
      {...pan.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel="Seek"
    >
      <View style={styles.scrubTrack} pointerEvents="none">
        <View style={[styles.scrubFill, { width: pct }]} />
      </View>
      <View style={[styles.scrubKnob, { left: pct }]} pointerEvents="none" />
    </View>
  );
}

/**
 * Playback of a CAPS1 clip, built for reviewing a shot.
 *
 * At 1x the audio file is the clock: frames carry pts_us from the same device
 * clock as the audio, so the right frame is a binary search for wherever the
 * audio is. Slow motion (0.5x, 0.25x) drives the frames from a timer instead
 * and plays silently; stroke review is about the picture, and pitched-down
 * audio helps no one. Frame steps pause and move exactly one frame.
 */
function CapPlayer({ meta, onBack }: { meta: ClipMeta; onBack: () => void }) {
  const [prepared, setPrepared] = useState<PreparedClip | null>(null);
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [showDetail, setShowDetail] = useState(false);

  const player = useAudioPlayer(prepared?.audioUri ?? null, { updateInterval: 100 });
  const elapsedRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef<Speed>(1);
  const lastTick = useRef(0);

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

  const showAt = (ms: number) => {
    if (!prepared) return;
    elapsedRef.current = ms;
    setElapsedMs(ms);
    const i = frameIndexAt(prepared.index.video, ms * 1000);
    setFrame((prev) => (i === prev ? prev : i));
  };

  // --- one clock for every speed ---------------------------------------
  useEffect(() => {
    if (!prepared) return;
    const hasAudio = !!prepared.audioUri;
    const tick = () => {
      const now = Date.now();
      const dt = now - lastTick.current;
      lastTick.current = now;
      if (!playingRef.current) return;
      let ms: number;
      if (speedRef.current === 1 && hasAudio) ms = player.currentTime * 1000;
      else ms = elapsedRef.current + dt * speedRef.current;
      if (ms >= prepared.durationMs - 30) {
        ms = prepared.durationMs;
        playingRef.current = false;
        setPlaying(false);
        player.pause();
      }
      showAt(ms);
    };
    lastTick.current = Date.now();
    const t = setInterval(tick, 1000 / (prepared.index.header.fps * 2));
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepared, player]);

  function startAudioAt(ms: number) {
    if (!prepared?.audioUri) return;
    void player.seekTo(ms / 1000);
    player.play();
  }

  function play() {
    if (!prepared) return;
    let from = elapsedRef.current;
    if (from >= prepared.durationMs - 30) from = 0;
    showAt(from);
    lastTick.current = Date.now();
    playingRef.current = true;
    setPlaying(true);
    if (speedRef.current === 1) startAudioAt(from);
  }

  function pause() {
    playingRef.current = false;
    setPlaying(false);
    player.pause();
  }

  const toggle = () => (playingRef.current ? pause() : play());

  function changeSpeed(next: Speed) {
    speedRef.current = next;
    setSpeed(next);
    lastTick.current = Date.now();
    if (!playingRef.current) return;
    if (next === 1) startAudioAt(elapsedRef.current);
    else player.pause();
  }

  function step(dir: -1 | 1) {
    if (!prepared || !prepared.index.video.length) return;
    pause();
    const i = Math.max(0, Math.min(prepared.index.video.length - 1, frame + dir));
    const ms = prepared.index.video[i].ptsUs / 1000;
    elapsedRef.current = ms;
    setElapsedMs(ms);
    setFrame(i);
    if (prepared.audioUri) void player.seekTo(ms / 1000);
  }

  function seek(f: number, done: boolean) {
    if (!prepared) return;
    const ms = prepared.durationMs * f;
    showAt(ms);
    lastTick.current = Date.now();
    if (done && playingRef.current && speedRef.current === 1) startAudioAt(ms);
    else if (prepared.audioUri && done) void player.seekTo(ms / 1000);
  }

  if (error) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <TopBar meta={meta} onBack={onBack} />
        <Banner tone="bad">{error}</Banner>
        <Text style={type.dim}>
          This usually means the transfer was cut short. Long-press the clip in the gallery, remove it
          from this phone, and download it again.
        </Text>
      </ScrollView>
    );
  }

  if (!prepared) {
    return (
      <View style={[styles.container, { flex: 1 }]}>
        <TopBar meta={meta} onBack={onBack} />
        <View style={[styles.center, { gap: space.md }]}>
          <ActivityIndicator color={colors.accent} />
          <Text style={type.dim}>
            {progress?.stage === 'frames'
              ? `Unpacking frames ${Math.round((progress.fraction ?? 0) * 100)}%`
              : progress?.stage === 'audio'
                ? 'Building audio'
                : 'Opening clip'}
          </Text>
        </View>
      </View>
    );
  }

  const fps = prepared.index.header.fps;
  const nFrames = prepared.index.video.length;
  const drift = avDriftMs(prepared.index);
  const fraction = prepared.durationMs ? elapsedMs / prepared.durationMs : 0;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <TopBar meta={meta} onBack={onBack} />

      <Pressable
        onPress={toggle}
        style={[styles.stage, { aspectRatio: prepared.index.header.width / Math.max(1, prepared.index.header.height) }]}
        accessibilityLabel={playing ? 'Pause' : 'Play'}
      >
        {nFrames ? (
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
        {!playing ? (
          <View style={styles.playOverlay} pointerEvents="none">
            <Text style={styles.playGlyph}>▶</Text>
          </View>
        ) : null}
        {speed !== 1 ? (
          <View style={styles.speedTag} pointerEvents="none">
            <Text style={styles.speedTagText}>{`${speed}× · no sound`}</Text>
          </View>
        ) : null}
      </Pressable>

      <Scrubber fraction={fraction} onSeek={seek} />
      <View style={styles.timeRow}>
        <Text style={type.mono}>{formatDuration(elapsedMs)}</Text>
        <Text style={type.mono}>{`frame ${frame + 1} / ${nFrames}`}</Text>
        <Text style={type.mono}>{formatDuration(prepared.durationMs)}</Text>
      </View>

      <View style={styles.controls}>
        <Pressable onPress={() => step(-1)} style={styles.stepBtn} accessibilityLabel="Previous frame">
          <Text style={styles.stepText}>‹ 1 frame</Text>
        </Pressable>
        <Pressable onPress={toggle} style={styles.playBtn} accessibilityLabel={playing ? 'Pause' : 'Play'}>
          <Text style={styles.playBtnText}>{playing ? 'Pause' : 'Play'}</Text>
        </Pressable>
        <Pressable onPress={() => step(1)} style={styles.stepBtn} accessibilityLabel="Next frame">
          <Text style={styles.stepText}>1 frame ›</Text>
        </Pressable>
      </View>

      <View style={styles.speeds} accessibilityRole="radiogroup">
        {SPEEDS.map((v) => (
          <Pressable
            key={v}
            onPress={() => changeSpeed(v)}
            style={[styles.speedChip, speed === v && styles.speedChipOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: speed === v }}
          >
            <Text style={[styles.speedText, speed === v && styles.speedTextOn]}>{v === 1 ? 'Normal' : `${v}×`}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable onPress={() => setShowDetail((d) => !d)} style={styles.detailToggle}>
        <Text style={type.dim}>{showDetail ? 'Hide clip details ▴' : 'Clip details ▾'}</Text>
      </Pressable>
      {showDetail ? (
        <Card>
          <Row label="Resolution" value={`${prepared.index.header.width}×${prepared.index.header.height}`} />
          <Row label="Frames" value={`${nFrames} at ${fps} fps`} />
          <Row
            label="Audio"
            value={prepared.audioUri ? `${prepared.index.header.audioSampleRate} Hz mono` : 'none'}
          />
          <Row
            label="A/V drift"
            value={`${drift >= 0 ? '+' : ''}${drift.toFixed(1)} ms`}
            tone={Math.abs(drift) > 100 ? 'bad' : Math.abs(drift) > 40 ? 'warn' : 'good'}
          />
          <Text style={type.dim}>
            Drift is how far apart the picture and sound end. Under 40 ms is unnoticeable.
          </Text>
        </Card>
      ) : null}
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
  container: { padding: space.md, paddingTop: space.md, gap: space.sm },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.xs, minHeight: 36 },
  back: { color: colors.accent, fontSize: 16, fontWeight: '600', width: 56 },
  topTitle: { flex: 1, textAlign: 'center', color: colors.text, fontSize: 15, fontWeight: '600' },
  playOverlay: {
    position: 'absolute', width: 64, height: 64, borderRadius: 32,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  playGlyph: { color: '#fff', fontSize: 26, marginLeft: 4 },
  speedTag: {
    position: 'absolute', left: 8, top: 8, backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2,
  },
  speedTagText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  scrub: { height: 28, justifyContent: 'center' },
  scrubTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  scrubFill: { height: 6, backgroundColor: colors.accent },
  scrubKnob: {
    position: 'absolute', width: 16, height: 16, borderRadius: 8, marginLeft: -8,
    backgroundColor: colors.text, top: 6,
  },
  controls: { flexDirection: 'row', gap: space.sm, alignItems: 'stretch' },
  stepBtn: {
    flex: 1, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt,
    alignItems: 'center', justifyContent: 'center', minHeight: 46,
  },
  stepText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  playBtn: {
    flex: 1.3, borderRadius: radius.sm, backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center', minHeight: 46,
  },
  playBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  speeds: { flexDirection: 'row', gap: space.sm, justifyContent: 'center', marginTop: space.xs },
  speedChip: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  speedChipOn: { backgroundColor: colors.surfaceAlt, borderColor: colors.accent },
  speedText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  speedTextOn: { color: colors.text },
  detailToggle: { alignSelf: 'center', paddingVertical: space.sm },
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
