/**
 * Fails the build when a server function would ship without the native
 * pieces it needs at runtime.
 *
 * This exists because of a production failure that a green build could
 * not have caught. onnxruntime-node is reached only through a
 * webpackIgnore-annotated dynamic import, which hides the specifier from
 * the output file tracer. Nothing else in the server graph named the
 * package, so tracing shipped a function without it and `next build`
 * still exited zero. The deployed /api/extract then died on its first
 * CACHE MISS with ERR_MODULE_NOT_FOUND - and only on a cache miss, since
 * a cache hit returns before the native extractor is ever loaded.
 *
 * The .nft.json files are what Vercel actually reads to assemble each
 * function, so they - not the build's exit code - are the thing worth
 * asserting on. Read them after `next build` and check that the runtime,
 * its linux/x64 binary and the model are all present, at a path Node can
 * resolve from .next/server/chunks.
 *
 * This is a packaging check, not a proof that the native stack loads.
 * Only invoking /api/extract on a genuine cache miss proves that.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, never from cwd: the same check has to behave
// identically under `pnpm build` at the root and under `next build` in
// apps/web, and a cwd-relative path silently passes when it resolves to
// nothing.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const appDir = join(repoRoot, 'apps/web');

/** Platforms that cannot execute on Vercel and must never be shipped. */
const FORBIDDEN_PLATFORMS = ['napi-v6/win32', 'napi-v6/darwin', 'napi-v6/linux/arm64'];

const ROUTES = [
  {
    route: '/api/extract',
    // The production scoring path. A miss here is the exact failure this
    // script was written for.
    requires: ['runtime', 'model'],
  },
  {
    route: '/api/health-onnx',
    // The probe that is supposed to prove the native stack. It was
    // missing the runtime too, so it could not have proved anything.
    requires: ['runtime', 'model'],
  },
];

const failures = [];

/**
 * Two copies of onnxruntime-common load two copies of the ORT type
 * registry, and the backend registered by the native binding is then
 * invisible to the one the caller holds. The app declares the package
 * directly so it lands where Node can resolve it, which means a bump of
 * onnxruntime-node can drift away from it without anything complaining.
 */
function checkRuntimeVersionLockstep() {
  const read = (pkg) => {
    const path = join(appDir, 'node_modules', pkg, 'package.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  };
  const node = read('onnxruntime-node');
  const common = read('onnxruntime-common');
  if (node === null || common === null) return; // absence is reported per route
  const required = node.dependencies?.['onnxruntime-common'];
  if (required !== undefined && required !== common.version) {
    failures.push(
      `onnxruntime-common ${common.version} is installed but onnxruntime-node ${node.version} ` +
        `requires ${required}. Update the pin in apps/web/package.json to match.`,
    );
  }
}

checkRuntimeVersionLockstep();

for (const { route, requires } of ROUTES) {
  const traceFile = join(appDir, '.next/server/app', route, 'route.js.nft.json');
  if (!existsSync(traceFile)) {
    failures.push(`${route}: no trace metadata at ${traceFile} - did next build run?`);
    continue;
  }

  const traceDir = dirname(traceFile);
  const files = JSON.parse(readFileSync(traceFile, 'utf8')).files;
  // The trace records paths relative to the .nft.json; normalising them
  // against the repo root gives the layout the function is deployed with,
  // which is what module resolution will see.
  const deployed = files.map((f) => normalize(join(traceDir, f)).slice(repoRoot.length));

  if (requires.includes('runtime')) {
    // Resolution from .next/server/chunks walks up to apps/web/node_modules.
    // Files traced anywhere else exist in the bundle but cannot be imported.
    const resolvable = deployed.filter((f) => f.startsWith('apps/web/node_modules/onnxruntime-node/'));
    if (resolvable.length === 0) {
      failures.push(
        `${route}: onnxruntime-node is absent from the traced function. ` +
          'The webpackIgnore dynamic import is invisible to the tracer; ' +
          'outputFileTracingIncludes in apps/web/next.config.ts must name it.',
      );
    } else {
      const binding = resolvable.some((f) => f.endsWith('bin/napi-v6/linux/x64/onnxruntime_binding.node'));
      const sharedLib = resolvable.some((f) => f.includes('bin/napi-v6/linux/x64/libonnxruntime.so'));
      if (!binding) failures.push(`${route}: onnxruntime-node ships without its linux/x64 onnxruntime_binding.node`);
      if (!sharedLib) failures.push(`${route}: onnxruntime-node ships without its linux/x64 libonnxruntime.so`);

      // An explicit include copies a directory; it does not walk that
      // package's dependencies. onnxruntime-node/dist/index.js requires
      // onnxruntime-common, and shipping without it fails at the same
      // point for the same reason, one level deeper.
      if (!deployed.some((f) => f.startsWith('apps/web/node_modules/onnxruntime-common/'))) {
        failures.push(
          `${route}: onnxruntime-common is absent. onnxruntime-node requires it at runtime, ` +
            'and an explicit tracing include does not follow dependencies.',
        );
      }
    }

    // Size, not just correctness: all platforms together are 287MB
    // against a 250MB function limit.
    for (const platform of FORBIDDEN_PLATFORMS) {
      if (deployed.some((f) => f.includes(platform))) {
        failures.push(`${route}: ships ${platform} binaries, which cannot run on Vercel`);
      }
    }
  }

  if (requires.includes('model') && !deployed.some((f) => f.endsWith('models/det_500m.onnx'))) {
    failures.push(`${route}: models/det_500m.onnx is absent from the traced function`);
  }
}

if (failures.length > 0) {
  console.error('check-trace: the deployed function would fail at first invocation.\n');
  for (const failure of failures) console.error(`  x ${failure}`);
  console.error('');
  process.exit(1);
}

console.error(`check-trace: ${ROUTES.length} function traces carry the native runtime and model.`);
