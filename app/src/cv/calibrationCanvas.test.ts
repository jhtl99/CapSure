import { expect, it } from 'vitest';
import { frameZoomBounds, CALIBRATION_BOUNDS, canvasToImage, imageToCanvas, isInBounds, zoomToFitLandmarks } from './calibrationCanvas';

it('maps zoomed annotation taps back to the frame and stops panning at the image edges', () => {
  const bounds = frameZoomBounds(3, { x: 2, y: -1 });
  expect(bounds.left + bounds.width).toBeCloseTo(1);
  expect(bounds.top).toBe(0);
  const ball = { x: 0.9, y: 0.2 };
  const tap = canvasToImage(imageToCanvas(ball, bounds), bounds);
  expect(tap.x).toBeCloseTo(ball.x);
  expect(tap.y).toBeCloseTo(ball.y);
});

it('keeps the same image coordinates when the canvas zoom changes', () => {
  const ball = { x: 0.42, y: 0.63 };
  const corner = { x: -0.4, y: 1.3 };
  for (const bounds of CALIBRATION_BOUNDS.slice(1)) {
    for (const point of [ball, corner]) {
      const position = imageToCanvas(point, bounds);
      expect(isInBounds(position)).toBe(true);
      const tap = canvasToImage(position, bounds);
      expect(tap.x).toBeCloseTo(point.x);
      expect(tap.y).toBeCloseTo(point.y);
    }
  }
  expect(isInBounds(corner)).toBe(false);
});

it('fits estimated landmarks in the smallest expanded canvas that contains them', () => {
  const visible = { x: 0.5, y: 0.4 };
  expect(zoomToFitLandmarks([visible])).toBe(0);
  expect(zoomToFitLandmarks([visible, { x: -0.3, y: 1.4 }])).toBe(1);
  expect(zoomToFitLandmarks([visible, { x: -2, y: 2.5 }, { x: 3, y: 2.5 }])).toBe(3);
});
