import { Directory, File, Paths } from 'expo-file-system';
import { assertClipId } from '../device/validate';
import type { Point, ShotAnalysis } from './types';

function analysisFile(clipId: string): File {
  const directory = new Directory(Paths.document, 'shot-analysis');
  if (!directory.exists) directory.create({ intermediates: true });
  return new File(directory, `${assertClipId(clipId)}.json`);
}

function isPoint(value: unknown): value is Point {
  if (!value || typeof value !== 'object') return false;
  const point = value as Point;
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

function validate(value: unknown, clipId: string): ShotAnalysis {
  const data = value as ShotAnalysis | null;
  if (!data || data.version !== 1 || data.clipId !== clipId || !Number.isFinite(data.timeMs)
    || data.timeMs < 0 || !Array.isArray(data.references) || data.references.length !== 4
    || !data.references.every((r) => r && isPoint(r.image) && isPoint(r.table))
    || !Array.isArray(data.balls) || data.balls.length > 16
    || !data.balls.every((b) => b && Number.isInteger(b.id) && b.id > 0 && isPoint(b.image))
    || new Set(data.balls.map((b) => b.id)).size !== data.balls.length) {
    throw new Error('Saved analysis is invalid. Create a new calibration and save it again.');
  }
  return data;
}

export async function loadAnalysis(clipId: string): Promise<ShotAnalysis | null> {
  const file = analysisFile(clipId);
  if (!file.exists) return null;
  return validate(JSON.parse(await file.text()), clipId);
}

export async function saveAnalysis(analysis: ShotAnalysis): Promise<void> {
  validate(analysis, analysis.clipId);
  const file = analysisFile(analysis.clipId);
  const temporary = new File(file.parentDirectory, `${analysis.clipId}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await temporary.write(JSON.stringify(analysis));
  await temporary.move(file, { overwrite: true });
}
