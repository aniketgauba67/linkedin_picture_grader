import { describe, expect, it } from 'vitest';
import type { LumaPlane } from './luma.js';
import { cropPlane } from './luma.js';

function build(width: number, height: number): LumaPlane {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = i % 256;
  }
  return { data, width, height };
}

describe('cropPlane', () => {
  it('copies the requested rectangle', () => {
    const cropped = cropPlane(build(10, 10), { x: 2, y: 3, width: 4, height: 2 });
    expect(cropped?.width).toBe(4);
    expect(cropped?.height).toBe(2);
    expect(cropped?.data[0]).toBe(3 * 10 + 2);
  });

  it('clamps a rectangle that runs past the edge', () => {
    const cropped = cropPlane(build(10, 10), { x: 8, y: 8, width: 100, height: 100 });
    expect(cropped?.width).toBe(2);
    expect(cropped?.height).toBe(2);
  });

  it('returns null when the rectangle misses the plane entirely', () => {
    expect(cropPlane(build(10, 10), { x: 50, y: 50, width: 4, height: 4 })).toBeNull();
    expect(cropPlane(build(10, 10), { x: 0, y: 0, width: 0, height: 4 })).toBeNull();
  });

  it('rejects a plane whose data disagrees with its dimensions', () => {
    expect(() =>
      cropPlane({ data: new Uint8Array(3), width: 4, height: 4 }, { x: 0, y: 0, width: 1, height: 1 }),
    ).toThrow(RangeError);
  });
});
