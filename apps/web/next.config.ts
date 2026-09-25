import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin tracing to the monorepo root. Without this Next walks up and finds
  // an unrelated lockfile in the home directory.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  typescript: {
    // A type error must fail the build, never be skipped.
    ignoreBuildErrors: false,
  },
  eslint: {
    // Linting is a separate turbo task, so `next build` does not repeat it.
    ignoreDuringBuilds: true,
  },
  /**
   * @pps/features is external too, not just its native dependencies.
   *
   * Listing only sharp and onnxruntime-node is not enough: webpack
   * follows the import chain from the route into the workspace package
   * and on into sharp's loader, and bundles it before the external rule
   * is ever consulted. Externalising the package that owns the native
   * code stops the walk at its edge, and it is then required from
   * node_modules at runtime where the platform binaries resolve
   * normally. File tracing is a separate pass and still collects it.
   *
   * REMOVING @pps/features FROM THIS LIST BREAKS THE BUILD by dragging
   * sharp into the bundle - and if a future Next version bundles it
   * without erroring, it breaks at FIRST INVOCATION, NOT AT BUILD TIME.
   * Verify with /api/health-onnx on a preview, never with a green build.
   */
  serverExternalPackages: ['sharp', 'onnxruntime-node', '@pps/features'],

  /**
   * onnxruntime-node ships prebuilt binaries for EVERY platform in one
   * npm package - 287MB on disk, of which a Vercel function needs only
   * linux/x64 (~46MB). Windows alone is 133MB of DirectML and dxcompiler
   * DLLs that can never execute here.
   *
   * Without this the function bundle carries all of it and blows the
   * 250MB limit on its own, before the GPU execution providers the
   * .npmrc already declines to download.
   *
   * File tracing only affects the deployed bundle, so local dev on macOS
   * still resolves its own darwin binaries normally.
   */
  /**
   * The tracer follows imports, not paths built at runtime. The model is
   * loaded by a string this code computes and the fixture is read by the
   * health probe, so neither is reachable by static analysis - without
   * naming them here they are simply absent from the bundle and the
   * first invocation fails on a build that went green.
   */
  /**
   * onnxruntime-node is loaded through a webpackIgnore-annotated dynamic
   * import in scrfd.ts and onnx-detector.ts. That annotation is
   * load-bearing and must stay - but it hides the specifier from the
   * OUTPUT FILE TRACER as well as from webpack, and the tracer is what
   * decides which node_modules files ship in the function.
   *
   * There is no other reference to the package anywhere in the server
   * graph, so tracing found nothing and the package was simply absent
   * from the deployed function. sharp survives only because it is a
   * PLAIN STATIC IMPORT that the tracer can see; serverExternalPackages
   * keeps it out of the webpack bundle but does not add anything to the
   * trace on its own.
   *
   * The build stays green either way - it fails on FIRST CACHE-MISS
   * INVOCATION with ERR_MODULE_NOT_FOUND, which is what production did.
   * A cache HIT never reaches the native extractor and looks healthy,
   * so a cache hit is not evidence that this works.
   *
   * The globs are relative to this directory and resolve through the
   * pnpm symlinks, so the files land under apps/web/node_modules/ - the
   * path Node actually resolves from .next/server/chunks.
   * outputFileTracingExcludes below still strips the platforms that can
   * never run here; only linux/x64 survives.
   *
   * onnxruntime-common is listed separately and is NOT redundant. An
   * explicit include is a filesystem glob, not a trace: it copies the
   * directory it is pointed at and never walks that package's own
   * dependencies. onnxruntime-node/dist/index.js requires
   * onnxruntime-common at runtime, so including only onnxruntime-node
   * moved production from "Cannot find package 'onnxruntime-node'" to
   * "Cannot find module 'onnxruntime-common'" - the same class of
   * failure, one level deeper.
   *
   * It is also a direct dependency of this app in package.json, which is
   * what puts it at apps/web/node_modules/onnxruntime-common rather than
   * inside pnpm's virtual store, where nothing could resolve it. Its
   * version must stay equal to onnxruntime-node's own pin; check-trace
   * asserts that so a future bump cannot silently load two copies.
   */
  outputFileTracingIncludes: {
    '/api/extract': [
      '../../models/det_500m.onnx',
      'node_modules/onnxruntime-node/**/*',
      'node_modules/onnxruntime-common/**/*',
    ],
    '/api/health-onnx': [
      '../../models/det_500m.onnx',
      '../../packages/features/fixtures/portrait.jpg',
      'node_modules/onnxruntime-node/**/*',
      'node_modules/onnxruntime-common/**/*',
    ],
  },

  outputFileTracingExcludes: {
    '*': [
      '**/onnxruntime-node/bin/napi-v6/win32/**',
      '**/onnxruntime-node/bin/napi-v6/darwin/**',
      '**/onnxruntime-node/bin/napi-v6/linux/arm64/**',
      // The GPU execution providers, if a stale install ever has them.
      '**/libonnxruntime_providers_cuda.so',
      '**/libonnxruntime_providers_tensorrt.so',
    ],
  },
  /**
   * @pps/features is deliberately NOT here.
   *
   * transpilePackages makes Next compile a workspace package, and a
   * compiled package's imports get bundled rather than honouring
   * serverExternalPackages - so sharp and onnxruntime-node were pulled
   * in and the build died parsing a native .node addon as JavaScript.
   *
   * These packages already ship compiled ESM with proper exports, so
   * there is nothing to transpile. The remaining three are listed only
   * because they are pure TypeScript output with no native deps.
   */
  transpilePackages: ['@pps/scoring', '@pps/schema', '@pps/db'],
};

export default nextConfig;
