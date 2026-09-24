/**
 * ONE-OFF DIAGNOSTIC. Makes REAL, BILLED Anthropic API calls.
 *
 * Deliberately a script and not a test: the suite is keyless by design
 * and CI has no ANTHROPIC_API_KEY. Nothing here runs in CI, and nothing
 * here should ever be imported by code that does.
 *
 *   pnpm --filter @pps/features judge:probe
 *
 * Answers four things that can only be answered against the live API:
 *   1. does output_config.format accept a oneOf schema
 *   2. what the model actually writes in its evidence strings
 *   3. stop_reason, token counts, wall-clock latency
 *   4. whether effort "low" is accepted, and what it costs
 *
 * Then repeats the same image to see whether the axis scores move.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildRequest,
  EFFORT,
  MAX_TOKENS,
  MODEL,
  RubricWireResponse,
  toRubricResponse,
} from '../dist/index.js';
import { toJudgeImage } from '../dist/judge.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

// Load .env.local without printing anything from it.
const env = Object.fromEntries(
  readFileSync(`${root}.env.local`, 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const apiKey = env.ANTHROPIC_API_KEY;
if (!apiKey || !apiKey.startsWith('sk-ant-')) {
  console.error('No usable ANTHROPIC_API_KEY in .env.local');
  process.exit(1);
}

const RUNS = Number(process.argv[2] ?? 3);
const client = new Anthropic({ apiKey });
const fixture = readFileSync(`${root}packages/features/fixtures/portrait.jpg`);
const imageBase64 = await toJudgeImage(fixture);

console.log(`model    ${MODEL}`);
console.log(`effort   ${EFFORT}`);
console.log(`max_tok  ${MAX_TOKENS}`);
console.log(`image    ${(Buffer.from(imageBase64, 'base64').length / 1024).toFixed(1)} KB base64 JPEG`);
console.log(`runs     ${RUNS}\n`);

const results = [];

for (let run = 1; run <= RUNS; run += 1) {
  const request = buildRequest({ imageBase64 });
  const started = performance.now();
  let response;
  try {
    response = await client.messages.create(request);
  } catch (error) {
    console.error(`\nRUN ${run} REQUEST REJECTED`);
    console.error(`  name   : ${error?.name}`);
    console.error(`  status : ${error?.status}`);
    console.error(`  message: ${String(error?.message).slice(0, 600)}`);
    if (String(error?.message).toLowerCase().includes('oneof')) {
      console.error('\n  -> The oneOf schema is the rejection. Flatten OUTPUT_JSON_SCHEMA to a');
      console.error('     single object with a required `status` and nullable branches.');
    }
    process.exit(1);
  }
  const ms = performance.now() - started;

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  let parsed = null;
  let parseError = null;
  try {
    parsed = toRubricResponse(RubricWireResponse.parse(JSON.parse(text)));
  } catch (error) {
    parseError = error;
  }

  results.push({ run, ms, response, text, parsed, parseError });

  const u = response.usage;
  console.log(`--- run ${run} -------------------------------------------------`);
  console.log(`stop_reason  ${response.stop_reason}`);
  console.log(`tokens       in ${u.input_tokens}  out ${u.output_tokens}` +
    (u.cache_read_input_tokens ? `  cache_read ${u.cache_read_input_tokens}` : ''));
  console.log(`latency      ${ms.toFixed(0)}ms`);
  console.log(`raw parses   ${parseError === null ? 'yes (no fence, no preamble)' : 'NO'}`);
  if (parseError !== null) {
    console.log(`parse error  ${String(parseError).slice(0, 300)}`);
    console.log(`raw text     ${text.slice(0, 400)}`);
  }
  if (run === 1 && parsed?.status === 'assessed') {
    console.log('\nfull assessment:');
    console.log(JSON.stringify(parsed, null, 2));
  } else if (parsed?.status === 'declined') {
    console.log(`\nDECLINED: ${parsed.reason} - ${parsed.detail}`);
  }
  console.log();
}

// --- determinism ------------------------------------------------------
const AXES = ['background', 'attire', 'expression', 'solo'];
const assessed = results.filter((r) => r.parsed?.status === 'assessed');

console.log('=== axis scores across runs ===');
console.log(`run  ${AXES.map((a) => a.padEnd(11)).join('')}`);
for (const r of assessed) {
  console.log(
    `  ${r.run}  ${AXES.map((a) => String(r.parsed.assessment[a].score).padEnd(11)).join('')}`,
  );
}

const identical = AXES.every(
  (a) => new Set(assessed.map((r) => r.parsed.assessment[a].score)).size === 1,
);
console.log(`\nall four axes identical across ${assessed.length} runs: ${identical ? 'YES' : 'NO'}`);
if (!identical) {
  for (const a of AXES) {
    const values = assessed.map((r) => r.parsed.assessment[a].score);
    if (new Set(values).size > 1) console.log(`  ${a} varied: ${values.join(', ')}`);
  }
}

console.log('\n=== evidence strings, run to run ===');
for (const a of AXES) {
  console.log(`\n${a}:`);
  for (const r of assessed) {
    console.log(`  ${r.run}: "${r.parsed.assessment[a].evidence}"`);
  }
}

const totals = results.reduce(
  (acc, r) => ({
    in: acc.in + r.response.usage.input_tokens,
    out: acc.out + r.response.usage.output_tokens,
    ms: acc.ms + r.ms,
  }),
  { in: 0, out: 0, ms: 0 },
);
// Sonnet 5: $2/MTok in, $10/MTok out.
const cost = (totals.in / 1e6) * 2 + (totals.out / 1e6) * 10;
console.log(
  `\ntotals: ${totals.in} in, ${totals.out} out, ${(totals.ms / results.length).toFixed(0)}ms mean` +
    `  ~$${cost.toFixed(4)} for ${results.length} calls`,
);
