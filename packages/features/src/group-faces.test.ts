/**
 * Extractor v8 regression: small faces, and the difference between a
 * measurement that is missing and one that is zero.
 *
 * Two real photographs triggered this. A six-person group photo was
 * detected perfectly - six faces at confidence 0.61 to 0.87 - and then
 * every one of them was discarded by a selection gate that required 1%
 * of the frame. With no primary face the extractor wrote faceAreaRatio
 * 0, which is not "no face was found" but "the face occupies none of
 * the frame": a measurement, and a false one. It floored framing to 1
 * and told the user their face filled 0% of a photograph containing six
 * faces.
 *
 * The fixture is synthetic on purpose. It is six copies of the same
 * public-domain portrait already in this directory, each sized to land
 * between the old 1% gate and the new 0.25% one, so the regression can
 * live in the repository without a photograph of identifiable people.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { extractAll } from './index.js';
import { MIN_FACE_AREA_RATIO } from './face.js';
import type { ComputedFeatures } from '@pps/schema';

/** Resolved from this file, never from cwd: the runners differ. */
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const read = async (name: string): Promise<Buffer> => readFile(fixture(name));

describe('v8 small-face selection', () => {
  let group: ComputedFeatures;
  let single: ComputedFeatures;

  beforeAll(async () => {
    group = await extractAll(await read('group-small-faces.jpg'));
    single = await extractAll(await read('portrait.jpg'));
  }, 60_000);

  it('the gate is the documented 0.25%', () => {
    expect(MIN_FACE_AREA_RATIO).toBe(0.0025);
  });

  it('keeps a group of small faces instead of discarding every one', () => {
    // The v7 failure was faceCount 6 with no primary face at all.
    expect(group.faceCount).toBeGreaterThanOrEqual(2);
    expect(group.faceAreaRatio).not.toBeNull();
    expect(group.primaryFaceConfidence).not.toBeNull();
  });

  it('selects faces that are small but genuinely above the gate', () => {
    // Each face here is around 0.5% of frame: under the old 1% gate,
    // over the new one. If this stops holding the fixture has drifted
    // and the test is no longer measuring what it claims to.
    const ratio = group.faceAreaRatio;
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThanOrEqual(MIN_FACE_AREA_RATIO);
    expect(ratio as number).toBeLessThan(0.01);
  });

  it('still measures a single clear face', () => {
    expect(single.faceCount).toBe(1);
    expect(single.faceAreaRatio).not.toBeNull();
    expect(single.faceCenterOffsetX).not.toBeNull();
    expect(single.faceCenterOffsetY).not.toBeNull();
  });

  it('reports every detection in faceCount, not just the selected one', () => {
    // faceCount and primary-face availability are different questions.
    // Collapsing them is what a future Solo axis must not inherit.
    expect(group.faceCount).toBeGreaterThan(1);
    expect(group.primaryFaceConfidence).not.toBeNull();
  });
});
