import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Image } from 'expo-image';

import type { DeviceClient } from '../device/client';
import { thumbUri } from '../device/thumbs';
import { colors, formatDuration } from './theme';

/**
 * A clip's first frame, with the duration sitting on the picture.
 * Comes from the device's `/thumb` endpoint through the client's queue, so
 * this works before the clip has been downloaded.
 */
export function ClipThumb({
  client,
  clipId,
  durationMs,
  style,
}: {
  client: DeviceClient;
  clipId: string;
  durationMs?: number;
  style?: ViewStyle;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUri(null);
    setFailed(false);
    thumbUri(client, clipId)
      .then((u) => {
        if (!cancelled) setUri(u);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, clipId]);

  return (
    <View style={[styles.frame, style]}>
      {failed || !uri ? (
        <View style={[StyleSheet.absoluteFill, styles.fallback]} />
      ) : (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory"
          transition={150}
          onError={() => setFailed(true)}
        />
      )}
      {durationMs != null ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{formatDuration(durationMs)}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: '#000',
    overflow: 'hidden',
    borderRadius: 8,
  },
  fallback: { backgroundColor: colors.surfaceAlt },
  badge: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  badgeText: { color: '#fff', fontSize: 11, fontVariant: ['tabular-nums'] },
});
