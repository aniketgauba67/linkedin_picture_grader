/**
 * A single-channel 8-bit luma plane. Every measurement in this package
 * works on one of these, so the arithmetic stays testable without sharp.
 */
export interface LumaPlane {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export function assertPlane(plane: LumaPlane): void {
  if (plane.width <= 0 || plane.height <= 0) {
    throw new RangeError(`Luma plane must have positive dimensions, got ${plane.width}x${plane.height}`);
  }
  if (plane.data.length !== plane.width * plane.height) {
    throw new RangeError(
      `Luma plane data length ${plane.data.length} does not match ${plane.width}x${plane.height}`,
    );
  }
}

export function sampleAt(plane: LumaPlane, x: number, y: number): number {
  const value = plane.data[y * plane.width + x];
  // Callers are bounds-checked by the loops that use this; the guard is
  // here because noUncheckedIndexedAccess widens the element type.
  return value ?? 0;
}

export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Copies a sub-rectangle out of a plane, clamped to its bounds. Returns
 * null when the rectangle has no overlap with the plane at all, so callers
 * fall back rather than measure an empty buffer.
 */
export function cropPlane(plane: LumaPlane, region: Region): LumaPlane | null {
  assertPlane(plane);

  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(plane.width, Math.ceil(region.x + region.width));
  const bottom = Math.min(plane.height, Math.ceil(region.y + region.height));

  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = (top + y) * plane.width + left;
    data.set(plane.data.subarray(sourceStart, sourceStart + width), y * width);
  }
  return { data, width, height };
}
