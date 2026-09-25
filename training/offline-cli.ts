#!/usr/bin/env node
/** Explicit offline-only Gate A commands. No production API route imports this. */
import { gateAReport } from './offline-eval.js';
import { labelOfflineEight } from './offline-label.js';

function value(args: readonly string[], flag: string, fallback?: string): string {
  const at = args.indexOf(flag);
  const found = at < 0 ? fallback : args[at + 1];
  if (found === undefined || found.startsWith('--')) throw new Error(`${flag} requires a value`);
  return found;
}

async function main(args: readonly string[]): Promise<number> {
  const command = args[0];
  const root = value(args, '--out', 'data/dataset-v1');
  if (command === 'run') {
    const cohort = value(args, '--cohort');
    const summary = await labelOfflineEight(root, {
      cohort,
      concurrency: Number(value(args, '--concurrency', '1')),
      ...(args.includes('--max-new') ? { maxNewCalls: Number(value(args, '--max-new')) } : {}),
      onProgress: (imageId, state) => { process.stderr.write(`${imageId}: ${state}\n`); },
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.failed === 0 ? 0 : 1;
  }
  if (command === 'validate') {
    process.stdout.write(`${JSON.stringify(gateAReport(root), null, 2)}\n`);
    return 0;
  }
  process.stderr.write('usage: offline-label <run --cohort NAME [--max-new N] [--concurrency 1..8] | validate> --out DATASET_DIR\n');
  return 2;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
