import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { createScrfdDetector, prepareImage, resolveModelPath, toRgbPlane } from '@pps/features';

/**
 * Proves the native stack actually works on Vercel's runtime.
 *
 * Every other check on this dependency is a BUILD-time check - Git LFS
 * resolved, model hash matched, CUDA skipped, tracing globs applied -
 * and all of them pass without a single native symbol being loaded. The
 * failure mode they cannot see is `outputFileTracingExcludes` dropping
 * the linux/x64 binary, or glibc rejecting the addon: both surface at
 * FIRST INVOCATION, on a build that went green.
 *
 * So this imports onnxruntime-node for real, builds the SCRFD session,
 * and runs one inference on the pinned fixture.
 *
 * Gated behind ENABLE_ONNX_HEALTH. Remove it before Prompt 12.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FIXTURE = 'packages/features/fixtures/portrait.jpg';

/**
 * The working directory differs between `next start` from the app
 * directory and a traced serverless function rooted at the monorepo
 * root, so candidates are tried in order rather than assuming either.
 *
 * Next's tracer cannot follow a path computed at runtime, which is why
 * this file and the model are named in `outputFileTracingIncludes`.
 */
function resolveFixture(): string {
  const candidates = [
    join(process.cwd(), FIXTURE),
    join(process.cwd(), '..', '..', FIXTURE),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  // Fall back to the first so the error names a path a human recognises.
  return found ?? candidates[0] ?? FIXTURE;
}

export async function GET(): Promise<NextResponse> {
  if (process.env['ENABLE_ONNX_HEALTH'] !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const started = Date.now();
  try {
    const fixturePath = resolveFixture();
    const fixture = await readFile(fixturePath);
    const { decodable } = await prepareImage(fixture);
    const rgb = await toRgbPlane(decodable);

    const detector = createScrfdDetector();

    // First call pays the graph load; the second is a warm inference.
    const loadStart = Date.now();
    const first = await detector.detect(rgb);
    const loadMs = Date.now() - loadStart;

    const inferStart = Date.now();
    const second = await detector.detect(rgb);
    const inferMs = Date.now() - inferStart;

    const face = second[0];
    return NextResponse.json({
      ok: true,
      loadMs,
      inferMs,
      totalMs: Date.now() - started,
      faces: second.length,
      // If tracing dropped the model or the addon, we never reach here -
      // but a wrong-shaped decode would still show up as nonsense boxes.
      confidence: face?.box.confidence ?? null,
      deterministic: first.length === second.length,
      plane: { width: rgb.width, height: rgb.height },
      modelPath: resolveModelPath(),
      runtime: {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        region: process.env['VERCEL_REGION'] ?? null,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        totalMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        // The two failures worth telling apart at a glance.
        hint:
          error instanceof Error && /\.onnx|ENOENT|no such file/i.test(error.message)
            ? 'Model or fixture missing from the function bundle - check outputFileTracingIncludes.'
            : 'Native addon failed to load - check the linux/x64 binary survived outputFileTracingExcludes.',
        runtime: {
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          region: process.env['VERCEL_REGION'] ?? null,
        },
      },
      { status: 500 },
    );
  }
}
