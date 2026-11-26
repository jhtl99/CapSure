import type { ImageProps } from 'expo-image';
import { Image } from 'expo-image';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { useMemo, useRef, useState } from 'react';
import { colors } from '../ui/theme';
import { frameZoomBounds, CALIBRATION_BOUNDS, canvasToImage, imageToCanvas, isInBounds } from './calibrationCanvas';
import type { Point } from './types';

export interface AnalysisFrame {
  source: ImageProps['source'];
  width: number;
  height: number;
  timeMs: number;
}

export function CalibrationView({ frame, zoom, frameScale, frameCenter, onFrameCenter, onPanning, markers, corners, onPoint }: {
  frame: AnalysisFrame;
  zoom: number;
  frameScale: number;
  frameCenter: Point;
  onFrameCenter: (center: Point) => void;
  onPanning: (panning: boolean) => void;
  markers: { point: Point; label: string; color: string }[];
  corners?: Point[];
  onPoint: (point: Point) => void;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const bounds = frameScale > 1 ? frameZoomBounds(frameScale, frameCenter) : CALIBRATION_BOUNDS[zoom];
  const currentBounds = useRef(bounds);
  currentBounds.current = bounds;
  const pan = useMemo(() => {
    let start: Point;
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, gesture) => frameScale > 1 && size.width > 0 && size.height > 0
        && Math.hypot(gesture.dx, gesture.dy) > 6,
      onPanResponderGrant: () => {
        start = canvasToImage({ x: 0.5, y: 0.5 }, currentBounds.current);
        onPanning(true);
      },
      onPanResponderMove: (_, { dx, dy }) => {
        const next = frameZoomBounds(frameScale, {
          x: start.x - dx / (size.width * frameScale),
          y: start.y - dy / (size.height * frameScale),
        });
        onFrameCenter(canvasToImage({ x: 0.5, y: 0.5 }, next));
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: () => onPanning(false),
      onPanResponderTerminate: () => onPanning(false),
    });
  }, [frameScale, onFrameCenter, onPanning, size.height, size.width]);
  const frameOrigin = imageToCanvas({ x: 0, y: 0 }, bounds);
  const frameEnd = imageToCanvas({ x: 1, y: 1 }, bounds);
  const framePosition = {
    position: 'absolute',
    left: `${frameOrigin.x * 100}%`, top: `${frameOrigin.y * 100}%`,
    width: `${(frameEnd.x - frameOrigin.x) * 100}%`, height: `${(frameEnd.y - frameOrigin.y) * 100}%`,
  } satisfies ViewStyle;
  const outline = corners?.map((corner) => {
    const point = imageToCanvas(corner, bounds);
    return { x: point.x * size.width, y: point.y * size.height };
  });
  return (
    <View {...pan.panHandlers}>
    <Pressable
      accessibilityLabel={zoom ? 'Video frame and surrounding space' : 'Video frame'}
      style={[styles.canvas, { aspectRatio: frame.width / frame.height }]}
      onLayout={(event) => setSize(event.nativeEvent.layout)}
      onPress={(event) => {
        if (!size.width || !size.height) return;
        const point = { x: event.nativeEvent.locationX / size.width, y: event.nativeEvent.locationY / size.height };
        if (isInBounds(point)) onPoint(canvasToImage(point, bounds));
      }}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Image source={frame.source} contentFit="fill" style={framePosition} />
        {zoom > 0 ? <View style={[framePosition, styles.frameBoundary]} /> : null}
        {outline?.map((start, index) => {
          const end = outline[(index + 1) % outline.length];
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const length = Math.hypot(dx, dy);
          return <View key={index} style={[styles.edge, {
            left: (start.x + end.x - length) / 2,
            top: (start.y + end.y) / 2 - 1,
            width: length,
            transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
          }]} />;
        })}
        {markers.filter(({ point }) => isInBounds(point, bounds)).map(({ point, label, color }) => {
          const position = imageToCanvas(point, bounds);
          return (
            <View key={label} style={[styles.marker, {
              left: `${position.x * 100}%`, top: `${position.y * 100}%`, borderColor: color,
              borderStyle: isInBounds(point) ? 'solid' : 'dashed',
            }]}><Text style={styles.label}>{label}</Text></View>
          );
        })}
      </View>
    </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { width: '100%', backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  frameBoundary: { borderWidth: 1, borderColor: colors.textDim },
  edge: { position: 'absolute', height: 2, backgroundColor: colors.accent },
  marker: { position: 'absolute', width: 26, height: 26, marginLeft: -13, marginTop: -13,
    borderRadius: 13, borderWidth: 2, backgroundColor: '#0009', alignItems: 'center', justifyContent: 'center' },
  label: { color: '#fff', fontWeight: '700', fontSize: 11 },
});
