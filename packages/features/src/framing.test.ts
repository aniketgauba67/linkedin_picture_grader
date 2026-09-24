import { describe, expect, it } from 'vitest';
import { framingMetrics } from './framing.js';

describe('framingMetrics', () => {
  it('returns zeroes when no face was detected', () => {
    expect(framingMetrics(null, 800, 600)).toEqual({
      faceAreaRatio: 0,
      faceCenterOffsetX: 0,
      faceCenterOffsetY: 0,
    });
  });

  it('computes the face area as a fraction of the frame', () => {
    const metrics = framingMetrics({ x: 300, y: 200, width: 200, height: 200 }, 1000, 1000);
    expect(metrics.faceAreaRatio).toBeCloseTo(0.04);
  });

  it('reports a perfectly centred face as zero offset', () => {
    const metrics = framingMetrics({ x: 400, y: 400, width: 200, height: 200 }, 1000, 1000);
    expect(metrics.faceCenterOffsetX).toBeCloseTo(0);
    expect(metrics.faceCenterOffsetY).toBeCloseTo(0);
  });

  it('keeps the sign, so above centre is distinguishable from below', () => {
    const high = framingMetrics({ x: 400, y: 200, width: 200, height: 200 }, 1000, 1000);
    const low = framingMetrics({ x: 400, y: 600, width: 200, height: 200 }, 1000, 1000);
    expect(high.faceCenterOffsetY).toBeLessThan(0);
    expect(low.faceCenterOffsetY).toBeGreaterThan(0);
    expect(high.faceCenterOffsetY).toBeCloseTo(-low.faceCenterOffsetY);
  });

  it('normalises by the frame, not by pixels', () => {
    const small = framingMetrics({ x: 0, y: 0, width: 50, height: 50 }, 500, 500);
    const large = framingMetrics({ x: 0, y: 0, width: 100, height: 100 }, 1000, 1000);
    expect(small.faceCenterOffsetX).toBeCloseTo(large.faceCenterOffsetX, 6);
    expect(small.faceCenterOffsetY).toBeCloseTo(large.faceCenterOffsetY, 6);
  });

  it('bounds the offsets to the frame', () => {
    const metrics = framingMetrics({ x: 0, y: 0, width: 10, height: 10 }, 1000, 1000);
    expect(metrics.faceCenterOffsetX).toBeGreaterThanOrEqual(-1);
    expect(metrics.faceCenterOffsetY).toBeGreaterThanOrEqual(-1);
  });

  it('rejects a frame with no area', () => {
    expect(() => framingMetrics(null, 0, 600)).toThrow(RangeError);
  });
});
