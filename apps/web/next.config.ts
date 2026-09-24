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
  outputFileTracingIncludes: {
    '/api/health-onnx': [
      '../../models/det_500m.onnx',
      '../../packages/features/fixtures/portrait.jpg',
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
