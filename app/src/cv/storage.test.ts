import { beforeEach, expect, it, vi } from 'vitest';
import type { ShotAnalysis } from './types';

const disk = vi.hoisted(() => ({ files: new Map<string, string>(), failWrite: false }));
vi.mock('expo-file-system', () => ({
  Paths: { document: 'documents' },
  Directory: class {
    path: string;
    exists = true;
    constructor(...parts: string[]) { this.path = parts.join('/'); }
    create() {}
  },
  File: class {
    path: string;
    parentDirectory: { path: string };
    constructor(parent: { path: string }, name: string) {
      this.parentDirectory = parent;
      this.path = `${parent.path}/${name}`;
    }
    get exists() { return disk.files.has(this.path); }
    async text() { return disk.files.get(this.path); }
    async write(content: string) {
      await Promise.resolve();
      if (disk.failWrite) throw new Error('Disk full');
      disk.files.set(this.path, content);
    }
    async move(destination: { path: string }, options: { overwrite: boolean }) {
      if (!disk.files.has(this.path)) throw new Error('Write has not completed');
      if (disk.files.has(destination.path) && !options.overwrite) throw new Error('File exists');
      disk.files.set(destination.path, disk.files.get(this.path)!);
      disk.files.delete(this.path);
    }
  },
}));

import { loadAnalysis, saveAnalysis } from './storage';

const analysis: ShotAnalysis = {
  version: 1, clipId: 'clip_0017', timeMs: 24000,
  references: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
    .map((point) => ({ image: point, table: point })),
  balls: [{ id: 1, image: { x: 0.4, y: 0.6 } }],
};

beforeEach(() => { disk.files.clear(); disk.failWrite = false; });

it('waits for the write and restores the saved analysis', async () => {
  expect(await loadAnalysis(analysis.clipId)).toBeNull();
  await saveAnalysis(analysis);
  expect(await loadAnalysis(analysis.clipId)).toEqual(analysis);
});

it('restores estimated landmarks beyond the frame', async () => {
  const estimated: ShotAnalysis = {
    ...analysis,
    references: [
      ...analysis.references.slice(0, 2),
      { image: { x: 2.7, y: 2.2 }, table: { x: 1, y: 1 } },
      { image: { x: -1.8, y: 2.1 }, table: { x: 0, y: 1 } },
    ],
  };
  await saveAnalysis(estimated);
  expect(await loadAnalysis(estimated.clipId)).toEqual(estimated);
});

it('rejects off-frame balls and landmarks with out-of-table positions', async () => {
  await expect(saveAnalysis({ ...analysis, balls: [{ id: 1, image: { x: 0.4, y: 1.1 } }] }))
    .rejects.toThrow('Saved analysis is invalid');
  const references = [{ image: { x: -0.1, y: 0 }, table: { x: -0.1, y: 0 } }, ...analysis.references.slice(1)];
  await expect(saveAnalysis({ ...analysis, references })).rejects.toThrow('Saved analysis is invalid');
});

it('replaces an existing analysis when saved again', async () => {
  await saveAnalysis(analysis);
  await saveAnalysis({ ...analysis, timeMs: 24500 });
  expect((await loadAnalysis(analysis.clipId))?.timeMs).toBe(24500);
  expect(disk.files.size).toBe(1);
});

it('preserves the previous analysis if writing fails', async () => {
  await saveAnalysis(analysis);
  disk.failWrite = true;
  await expect(saveAnalysis({ ...analysis, timeMs: 24500 })).rejects.toThrow('Disk full');
  expect(await loadAnalysis(analysis.clipId)).toEqual(analysis);
});

it('rejects malformed saved annotations', async () => {
  disk.files.set('documents/shot-analysis/clip_0017.json', JSON.stringify({ ...analysis, references: [] }));
  await expect(loadAnalysis(analysis.clipId)).rejects.toThrow('Saved analysis is invalid');
});
