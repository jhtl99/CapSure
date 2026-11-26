import type { ImageProps } from 'expo-image';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import type { Point } from './types';

export interface AnalysisFrame {
  source: ImageProps['source'];
  width: number;
  height: number;
  timeMs: number;
}

export function CalibrationView({ frame, markers, onPoint }: {
  frame: AnalysisFrame;
  markers: { point: Point; label: string; color: string }[];
  onPoint: (point: Point) => void;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  return (
    <Pressable
      accessibilityLabel="Video frame. Tap to place the selected landmark or a ball."
      style={{ width: '100%', aspectRatio: frame.width / frame.height, backgroundColor: '#000' }}
      onLayout={(event) => setSize(event.nativeEvent.layout)}
      onPress={(event) => {
        if (!size.width || !size.height) return;
        onPoint({ x: Math.max(0, Math.min(1, event.nativeEvent.locationX / size.width)),
          y: Math.max(0, Math.min(1, event.nativeEvent.locationY / size.height)) });
      }}
    >
      <Image source={frame.source} style={StyleSheet.absoluteFill} contentFit="fill" />
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {markers.map(({ point, label, color }) => (
          <View key={label} style={[styles.marker, {
            left: `${point.x * 100}%`, top: `${point.y * 100}%`, borderColor: color,
          }]}><Text style={styles.label}>{label}</Text></View>
        ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  marker: { position: 'absolute', width: 26, height: 26, marginLeft: -13, marginTop: -13,
    borderRadius: 13, borderWidth: 2, backgroundColor: '#0009', alignItems: 'center', justifyContent: 'center' },
  label: { color: '#fff', fontWeight: '700', fontSize: 11 },
});
