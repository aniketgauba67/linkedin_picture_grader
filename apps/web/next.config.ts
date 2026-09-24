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
  transpilePackages: ['@pps/scoring', '@pps/schema', '@pps/db', '@pps/features'],
};

export default nextConfig;
