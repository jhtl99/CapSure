import { useEffect, useRef, useState } from 'react';
import { Modal, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Banner, Button, Card } from '../ui/components';
import { colors, space, type } from '../ui/theme';
import { CalibrationView } from './CalibrationView';
import type { AnalysisFrame } from './CalibrationView';
import { calibrate, isOnTable, project } from './geometry';
import { OverheadView } from './OverheadView';
import { loadAnalysis, saveAnalysis } from './storage';
import type { MarkedBall, Point, ReferencePoint } from './types';

const DEFAULT_TABLE = [
  { x: '0', y: '0' }, { x: '100', y: '0' }, { x: '100', y: '100' }, { x: '0', y: '100' },
];

export function AnalysisScreen({ clipId, initialTimeMs, durationMs, getFrame, onBack }: {
  clipId: string;
  initialTimeMs: number;
  durationMs: number;
  getFrame: (timeMs: number) => Promise<AnalysisFrame>;
  onBack: () => void;
}) {
  const [seconds, setSeconds] = useState((initialTimeMs / 1000).toFixed(2));
  const [frame, setFrame] = useState<AnalysisFrame | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [table, setTable] = useState(DEFAULT_TABLE);
  const [selected, setSelected] = useState(0);
  const [balls, setBalls] = useState<MarkedBall[]>([]);
  const [mode, setMode] = useState<'calibrate' | 'balls'>('calibrate');
  const [mapped, setMapped] = useState<{ id: number; position: Point }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(true);
  const mounted = useRef(true);
  const frameLoader = useRef(getFrame);
  frameLoader.current = getFrame;

  useEffect(() => {
    mounted.current = true;
    async function open() {
      let timeMs = initialTimeMs;
      try {
        const previous = await loadAnalysis(clipId);
        if (!mounted.current) return;
        if (previous && previous.timeMs < durationMs) {
          timeMs = previous.timeMs;
          setPoints(previous.references.map((r) => r.image));
          setTable(previous.references.map((r) => ({ x: String(r.table.x * 100), y: String(r.table.y * 100) })));
          setBalls(previous.balls);
        }
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      }
      if (!mounted.current) return;
      try {
        const next = await frameLoader.current(timeMs);
        if (!mounted.current) return;
        setFrame(next);
        setSeconds((next.timeMs / 1000).toFixed(3));
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted.current) setBusy(false);
      }
    }
    void open();
    return () => { mounted.current = false; };
  }, [clipId, initialTimeMs, durationMs]);

  function changed() {
    setMapped(null);
    setSaved(false);
    setError(null);
  }

  async function selectFrame() {
    const requested = Number(seconds.trim());
    if (!seconds.trim() || !Number.isFinite(requested) || requested < 0 || requested * 1000 >= durationMs) {
      setError('Enter a time within the clip, before its end.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await getFrame(requested * 1000);
      if (!mounted.current) return;
      setFrame(next);
      setSeconds((next.timeMs / 1000).toFixed(3));
      if (next.timeMs !== frame?.timeMs) {
        setPoints([]);
        setTable(DEFAULT_TABLE);
        setSelected(0);
        setBalls([]);
        setMode('calibrate');
        changed();
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function references(): ReferencePoint[] {
    if (points.length !== 4) throw new Error('Place four landmarks in the image.');
    return points.map((image, index) => {
      const coordinate = table[index];
      if (!coordinate.x.trim() || !coordinate.y.trim()) throw new Error('Enter both table coordinates for every landmark.');
      const position = { x: Number(coordinate.x) / 100, y: Number(coordinate.y) / 100 };
      if (![position.x, position.y].every(Number.isFinite) || !isOnTable(position)) {
        throw new Error('Table coordinates must be between 0 and 100 percent.');
      }
      return { image, table: position };
    });
  }

  function preview() {
    setError(null);
    try {
      const matrix = calibrate(references());
      if (!balls.length) throw new Error('Mark at least one ball first.');
      setMapped(balls.map((ball) => ({ id: ball.id, position: project(ball.image, matrix) })));
    } catch (e) {
      setMapped(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    if (!frame) return;
    setBusy(true);
    setSaved(false);
    try {
      const refs = references();
      const matrix = calibrate(refs);
      if (!balls.length) throw new Error('Mark at least one ball first.');
      const positions = balls.map((ball) => project(ball.image, matrix));
      if (positions.some((point) => !isOnTable(point))) {
        throw new Error('A ball maps outside the table. Check the landmarks or remove that ball before saving.');
      }
      await saveAnalysis({ version: 1, clipId, timeMs: frame.timeMs, references: refs, balls });
      if (!mounted.current) return;
      setError(null);
      setSaved(true);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function mark(point: Point) {
    changed();
    if (mode === 'calibrate') {
      setPoints((current) => {
        const next = [...current];
        next[selected] = point;
        return next;
      });
      setSelected(Math.min(3, selected + 1));
    } else if (balls.length < 16) {
      setBalls([...balls, { id: balls.length + 1, image: point }]);
    }
  }

  return (
    <Modal onRequestClose={onBack} animationType="slide">
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Button title="Back to clip" variant="secondary" onPress={onBack} />
      <Text style={type.title}>Shot analysis</Text>
      <Text style={type.dim}>Choose a clear frame. Calibration and ball marks apply to this frame.</Text>
      <View style={styles.row}>
        <Text style={type.body}>Time in seconds</Text>
        <TextInput accessibilityLabel="Frame time in seconds" value={seconds} onChangeText={setSeconds}
          keyboardType="decimal-pad" style={styles.input} editable={!busy} />
      </View>
      <Button title="Use this frame" onPress={() => void selectFrame()} busy={busy} />
      {frame && !busy ? <>
        <Text style={type.dim}>{`Selected frame at ${(frame.timeMs / 1000).toFixed(3)} s`}</Text>
        <CalibrationView frame={frame} onPoint={mark} markers={[
          ...points.map((point, index) => ({ point, label: `L${index + 1}`, color: '#4C8DFF' })),
          ...balls.map((ball) => ({ point: ball.image, label: `B${ball.id}`, color: '#F2B441' })),
        ]} />
        <View style={styles.row}>
          <Button title="Landmarks" variant={mode === 'calibrate' ? 'primary' : 'secondary'} onPress={() => setMode('calibrate')} />
          <Button title="Mark balls" variant={mode === 'balls' ? 'primary' : 'secondary'} onPress={() => setMode('balls')} />
        </View>
        <Card>
          <Text style={type.heading}>Table landmarks</Text>
          <Text style={type.dim}>Tap four known points on the cloth plane. X runs left to right and Y runs top to bottom in the overhead view. Enter each point's position as a percentage of table width and length.</Text>
          <Text style={type.dim}>Defaults represent top-left, top-right, bottom-right, bottom-left corners. For cropped views, use visible landmarks with known positions. Keep every group of three points off a single straight line.</Text>
          <Text style={type.dim}>Each row contains the landmark selector, X percent, then Y percent. Select a landmark and tap the image again to adjust it.</Text>
          {table.map((coordinate, index) => (
            <View key={index} style={styles.row}>
              <Button title={`L${index + 1}${points[index] ? ' ✓' : ''}`} disabled={index > points.length}
                variant={mode === 'calibrate' && selected === index ? 'primary' : 'secondary'}
                onPress={() => { setSelected(index); setMode('calibrate'); }} />
              {(['x', 'y'] as const).map((axis) => (
                <TextInput key={axis} accessibilityLabel={`Landmark ${index + 1} table ${axis} percent`}
                  value={coordinate[axis]} keyboardType="decimal-pad" style={styles.input}
                  onChangeText={(value) => {
                    changed();
                    setTable(table.map((entry, i) => i === index ? { ...entry, [axis]: value } : entry));
                  }} />
              ))}
            </View>
          ))}
          <Text style={type.dim}>{mode === 'calibrate' ? `Tap the image to place or replace L${selected + 1}.` : `Tap the cloth contact point under each ball. ${balls.length} of 16 marked. Labels identify your marks.`}</Text>
          <Button title="Undo last ball" variant="secondary" disabled={!balls.length}
            onPress={() => { changed(); setBalls(balls.slice(0, -1)); }} />
        </Card>
        <Button title="Show overhead view" onPress={preview} />
        {mapped ? <Card>
          <Text style={type.heading}>Overhead snapshot</Text>
          <OverheadView balls={mapped} />
          {mapped.some((ball) => !isOnTable(ball.position)) ? <Banner tone="warn">Some balls map outside the table and are omitted. Check the calibration and ball marks.</Banner> : null}
          <Text style={type.dim}>Table uses a 2-to-1 playing surface. Ball markers show approximate positions.</Text>
        </Card> : null}
        <Button title="Save analysis" onPress={() => void save()} />
      </> : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {saved ? <Banner tone="good">Analysis saved on this phone.</Banner> : null}
    </ScrollView>
    </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.md, gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  input: { minWidth: 65, flexGrow: 1, color: colors.text, backgroundColor: colors.surfaceAlt,
    borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 10 },
});
