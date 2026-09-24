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
  // sharp and onnxruntime-node are native; they must stay external and run
  // in the Node runtime, never be bundled or pushed to an edge runtime.
  serverExternalPackages: ['sharp', 'onnxruntime-node'],

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
  transpilePackages: ['@pps/scoring', '@pps/schema', '@pps/db', '@pps/features'],
};

export default nextConfig;
