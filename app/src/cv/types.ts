export interface Point {
  x: number;
  y: number;
}

export interface ReferencePoint {
  /** Fraction of image size. Estimates beyond the frame can fall outside [0, 1]. */
  image: Point;
  /** Fraction of table width and length. */
  table: Point;
}

export interface MarkedBall {
  id: number;
  image: Point;
}

export interface ShotAnalysis {
  version: 1;
  clipId: string;
  timeMs: number;
  references: ReferencePoint[];
  balls: MarkedBall[];
}
