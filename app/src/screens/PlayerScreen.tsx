import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';

import { avDriftMs, frameIndexAt } from '../device/clip';
import { localClipFile } from '../device/download';
import type { ClipMeta } from '../device/types';
import { prepareClip } from '../player/prepare';
import type { PreparedClip, PrepareProgress } from '../player/prepare';
import { Banner, Button, Card, Progress, Row } from '../ui/components';
import { colors, formatDuration, space, type } from '../ui/theme';

export function PlayerScreen({
  meta,
  onBack,
}: {
  meta: ClipMeta;
  onBack: () => void;
}) {
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
