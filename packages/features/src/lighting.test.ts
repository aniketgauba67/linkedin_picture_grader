import { describe, expect, it } from 'vitest';
import type { LumaPlane } from './luma.js';
import { lightingStats } from './lighting.js';

function uniform(value: number, size = 32): LumaPlane {
  return { data: new Uint8Array(size * size).fill(value), width: size, height: size };
}

function ramp(size = 16): LumaPlane {
  const data = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.round((i / (data.length - 1)) * 255);
  }
  return { data, width: size, height: size };
}

describe('lightingStats', () => {
  it('reports a flat image as having no dynamic range', () => {
    const stats = lightingStats(uniform(128));
    expect(stats.meanLuma).toBe(128);
    expect(stats.dynamicRange).toBe(0);
    expect(stats.clippedHighlightRatio).toBe(0);
    expect(stats.clippedShadowRatio).toBe(0);
  });

  it('reports near-full range on a black-to-white ramp', () => {
    expect(lightingStats(ramp()).dynamicRange).toBeGreaterThan(230);
  });

  it('counts blown highlights', () => {
    const stats = lightingStats(uniform(255));
    expect(stats.clippedHighlightRatio).toBe(1);
    expect(stats.clippedShadowRatio).toBe(0);
  });

  it('counts crushed shadows', () => {
    const stats = lightingStats(uniform(0));
    expect(stats.clippedShadowRatio).toBe(1);
    expect(stats.clippedHighlightRatio).toBe(0);
  });

  it('uses percentiles, so a handful of stuck pixels does not define the range', () => {
    const size = 100;
    const data = new Uint8Array(size * size).fill(120);
    data[0] = 0;
    data[1] = 255;
    const stats = lightingStats({ data, width: size, height: size });
    expect(stats.dynamicRange).toBe(0);
  });

  it('builds a 256-bin histogram that totals the pixel count', () => {
    const stats = lightingStats(uniform(77, 20));
    expect(stats.histogram).toHaveLength(256);
    expect(stats.histogram.reduce((a, b) => a + b, 0)).toBe(400);
    expect(stats.histogram[77]).toBe(400);
  });
});
