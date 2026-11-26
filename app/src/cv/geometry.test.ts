import { describe, expect, it } from 'vitest';
import { calibrate, isOnTable, project } from './geometry';
import type { Point } from './types';

const corners: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

describe('manual table calibration', () => {
  it('maps a perspective image back to table coordinates', () => {
    const camera = [0.6, 0.1, 0.1, 0.05, 0.5, 0.2, 0.2, 0.1, 1];
    const matrix = calibrate(corners.map((table) => ({ image: project(table, camera), table })));
    const ball = { x: 0.35, y: 0.72 };
    const restored = project(project(ball, camera), matrix);
    expect(restored.x).toBeCloseTo(ball.x, 8);
    expect(restored.y).toBeCloseTo(ball.y, 8);
  });

  it('supports known landmarks inside a cropped table', () => {
    const image = [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 }, { x: 0.9, y: 0.8 }, { x: 0.1, y: 0.8 }];
    const table = [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 }];
    const matrix = calibrate(image.map((point, i) => ({ image: point, table: table[i] })));
    const center = project({ x: 0.5, y: 0.5 }, matrix);
    expect(center.x).toBeCloseTo(0.5, 8);
    expect(center.y).toBeCloseTo(0.5, 8);
  });

  it('rejects duplicate or collinear landmarks', () => {
    expect(() => calibrate(corners.map((table) => ({ image: { x: 0.5, y: 0.5 }, table })))).toThrow();
    expect(() => calibrate(corners.map((table, i) => ({ image: { x: i / 4, y: i / 4 }, table })))).toThrow();
  });

  it('rejects crossed correspondences that put a horizon through the table', () => {
    expect(() => calibrate(corners.map((image, i) => ({ image, table: corners[[0, 2, 1, 3][i]] })))).toThrow();
  });

  it('keeps out-of-table positions available for validation', () => {
    const matrix = calibrate(corners.map((point) => ({ image: point, table: point })));
    const outside = project({ x: -0.1, y: 0.5 }, matrix);
    expect(outside.x).toBeCloseTo(-0.1);
    expect(isOnTable(outside)).toBe(false);
  });
});
