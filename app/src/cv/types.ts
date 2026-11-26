export interface Point {
  x: number;
  y: number;
}

/** Coordinates are fractions of image size or table width and length. */
export interface ReferencePoint {
  image: Point;
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
