/** Offline eight-axis request. It does not change the production judge or scoring path. */
import Anthropic from '@anthropic-ai/sdk';

import { BASE_BACKOFF_MS, MAX_ATTEMPTS, MAX_TOKENS, toJudgeImage } from '@pps/features';

import {
  OFFLINE_MODEL, OFFLINE_OUTPUT_JSON_SCHEMA, OFFLINE_SYSTEM_PROMPT, OFFLINE_USER_PROMPT,
  parseOfflineReply, type OfflineResult,
} from './offline-rubric.js';

export interface OfflineReply {
  readonly stop_reason: string | null;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

export function buildOfflineRequest(imageBase64: string, width: number, height: number,
  maxTokens = MAX_TOKENS) {
  return {
    model: OFFLINE_MODEL,
    max_tokens: maxTokens,
    system: OFFLINE_SYSTEM_PROMPT,
    output_config: { effort: 'low' as const,
      format: { type: 'json_schema' as const, schema: OFFLINE_OUTPUT_JSON_SCHEMA } },
    messages: [{ role: 'user' as const, content: [
      { type: 'image' as const, source: { type: 'base64' as const,
        media_type: 'image/jpeg' as const, data: imageBase64 } },
      { type: 'text' as const, text: OFFLINE_USER_PROMPT(width, height) },
    ] }],
  };
}

export interface OfflineJudgeOptions {
  readonly send?: (request: ReturnType<typeof buildOfflineRequest>) => Promise<OfflineReply>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
}

function retryable(error: unknown): boolean {
  return error instanceof Anthropic.RateLimitError || error instanceof Anthropic.APIConnectionError ||
    (error instanceof Anthropic.APIError && typeof error.status === 'number' && error.status >= 500);
}

export async function judgeOfflineEight(image: Buffer, width: number, height: number,
  options: OfflineJudgeOptions = {}): Promise<OfflineResult> {
  const client = options.send === undefined ? new Anthropic() : null;
  const send = options.send ?? (async (request: ReturnType<typeof buildOfflineRequest>): Promise<OfflineReply> => {
    if (client === null) throw new Error('offline judge transport unavailable');
    return client.messages.create(request);
  });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new RangeError('invalid offline judge attempt count');
  }
  const encoded = await toJudgeImage(image);
  let maxTokens = MAX_TOKENS;
  let truncationRetried = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: OfflineReply;
    try {
      response = await send(buildOfflineRequest(encoded, width, height, maxTokens));
    } catch (error) {
      if (!retryable(error) || attempt === maxAttempts) throw error;
      lastError = error;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }
    if (response.stop_reason === 'refusal') {
      return { status: 'declined', reason: 'model_refusal', detail: '' };
    }
    if (response.stop_reason === 'max_tokens' && !truncationRetried && attempt < maxAttempts) {
      maxTokens *= 2;
      truncationRetried = true;
      continue;
    }
    try {
      const text = response.content.filter((block) => block.type === 'text')
        .map((block) => block.text ?? '').join('').trim();
      return parseOfflineReply(text);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  throw new Error('offline judge returned no valid structured assessment', { cause: lastError });
}
