import { describe, expect, it } from 'vitest';
import type { LumaPlane } from './luma.js';
import { decodeBoxes } from './onnx-detector.js';

const plane: LumaPlane = { data: new Uint8Array(640 * 640), width: 640, height: 640 };

describe('decodeBoxes', () => {
  it('scales boxes from graph input coordinates back onto the analysis plane', () => {
    const boxes = decodeBoxes(
      { out: { data: [80, 80, 160, 160, 0.9] } },
      ['out'],
      plane,
      320,
      0.5,
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.x).toBeCloseTo(160);
    expect(boxes[0]?.width).toBeCloseTo(320);
    expect(boxes[0]?.confidence).toBeCloseTo(0.9);
  });

  it('drops detections below the confidence floor', () => {
    const boxes = decodeBoxes(
      { out: { data: [10, 10, 20, 20, 0.2, 30, 30, 40, 40, 0.8] } },
      ['out'],
      plane,
      320,
      0.5,
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.confidence).toBeCloseTo(0.8);
  });

  it('drops degenerate zero-area boxes', () => {
    expect(decodeBoxes({ out: { data: [10, 10, 0, 0, 0.99] } }, ['out'], plane, 320, 0.5)).toEqual(
      [],
    );
  });

  it('returns nothing when the graph produced no named output', () => {
    expect(decodeBoxes({}, [], plane, 320, 0.5)).toEqual([]);
  });
});
