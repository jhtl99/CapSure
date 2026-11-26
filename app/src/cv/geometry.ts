import type { Point, ReferencePoint } from './types';

export type Homography = number[];

/** Solve the eight coefficients of a planar projective transformation. */
export function calibrate(references: ReferencePoint[]): Homography {
  if (references.length !== 4) throw new Error('Place all four reference points.');
  const rows: number[][] = [];
  for (const { image: { x, y }, table: { x: u, y: v } } of references) {
    if (![x, y, u, v].every(Number.isFinite)) throw new Error('Reference coordinates must be numbers.');
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column + 1; row < 8; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-9) {
      throw new Error('Use four distinct landmarks with no three on one straight line.');
    }
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const scale = rows[column][column];
    rows[column] = rows[column].map((value) => value / scale);
    for (let row = 0; row < 8; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      rows[row] = rows[row].map((value, index) => value - factor * rows[column][index]);
    }
  }
  const matrix = [...rows.map((row) => row[8]), 1];
  // A horizon crossing the reference region indicates inconsistent point pairs.
  const denominators = references.map(({ image }) => matrix[6] * image.x + matrix[7] * image.y + 1);
  if (denominators.some((d) => Math.abs(d) < 1e-8 || Math.sign(d) !== Math.sign(denominators[0]))) {
    throw new Error('The point pairs cross the perspective horizon. Check their table positions.');
  }
  return matrix;
}

export function project(point: Point, matrix: Homography): Point {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < 1e-8) throw new Error('This point is too close to the perspective horizon.');
  const x = (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator;
  const y = (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator;
  if (![x, y].every(Number.isFinite)) throw new Error('Could not map this point onto the table.');
  return { x, y };
}

export function isOnTable(point: Point): boolean {
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}
