import { StyleSheet, Text, View } from 'react-native';
import { isOnTable } from './geometry';
import type { Point } from './types';

export function OverheadView({ balls }: { balls: { id: number; position: Point }[] }) {
  return (
    <View style={styles.rail} accessibilityLabel="Overhead table with manually placed balls">
      <View style={styles.cloth}>
        {[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0.5 },
          { x: 1, y: 0.5 }, { x: 0, y: 1 }, { x: 1, y: 1 }].map((p, i) => (
          <View key={i} style={[styles.pocket, { left: `${p.x * 100}%`, top: `${p.y * 100}%` }]} />
        ))}
        {balls.filter((ball) => isOnTable(ball.position)).map(({ id, position }) => (
          <View key={id} style={[styles.ball, {
            left: `${position.x * 100}%`, top: `${position.y * 100}%`,
          }]}><Text style={styles.label}>{id}</Text></View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { width: '80%', maxWidth: 300, alignSelf: 'center', aspectRatio: 0.5,
    backgroundColor: '#503827', padding: 12, borderRadius: 12 },
  cloth: { flex: 1, backgroundColor: '#186d66' },
  pocket: { position: 'absolute', width: 18, height: 18, marginLeft: -9, marginTop: -9,
    borderRadius: 9, backgroundColor: '#090d0c' },
  ball: { position: 'absolute', width: 20, height: 20, marginLeft: -10, marginTop: -10,
    borderRadius: 10, backgroundColor: '#faf5e8', alignItems: 'center', justifyContent: 'center' },
  label: { color: '#151515', fontSize: 11, fontWeight: '700' },
});
