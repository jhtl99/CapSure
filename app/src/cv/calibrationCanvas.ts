import type { Point } from './types';

interface CanvasBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Cropped shots often need more space below the frame for the near corners.
export const CALIBRATION_BOUNDS = [0, 0.55, 1.8, 3.6].map((margin): CanvasBounds => ({
  left: -margin,
  top: -margin / 2,
  width: 1 + 2 * margin,
  height: 1 + 2 * margin,
}));

export const MAX_CALIBRATION_ZOOM = CALIBRATION_BOUNDS.length - 1;
export const FRAME_CENTER: Point = { x: 0.5, y: 0.5 };

export function frameZoomBounds(scale: number, center: Point): CanvasBounds {
  const span = 1 / scale;
  return {
    left: Math.max(0, Math.min(1 - span, center.x - span / 2)),
    top: Math.max(0, Math.min(1 - span, center.y - span / 2)),
    width: span,
    height: span,
  };
}

export function isInBounds(point: Point, bounds = CALIBRATION_BOUNDS[0]): boolean {
  return point.x >= bounds.left && point.x <= bounds.left + bounds.width
    && point.y >= bounds.top && point.y <= bounds.top + bounds.height;
}

export function imageToCanvas(point: Point, bounds: CanvasBounds): Point {
  return { x: (point.x - bounds.left) / bounds.width, y: (point.y - bounds.top) / bounds.height };
}

export function canvasToImage(point: Point, bounds: CanvasBounds): Point {
  return { x: bounds.left + point.x * bounds.width, y: bounds.top + point.y * bounds.height };
}

export function zoomToFitLandmarks(points: Point[]): number {
  return CALIBRATION_BOUNDS.findIndex((bounds) => points.every((point) => isInBounds(point, bounds)));
}
