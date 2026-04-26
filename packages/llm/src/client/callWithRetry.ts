// SPEC §7.5 — Schema-validated LLM call with retry + correction injection.

import type { z } from 'zod';

import { LLMSchemaValidationError, type LedgerWriter } from '@cf-migrate/core';
import { sha256 } from '@cf-migrate/core';

import type { LLMClient, LLMRequest } from './LLMClient';

export interface CallWithRetryOptions<T> {
  client: LLMClient;
  request: LLMRequest;
  schema: z.ZodSchema<T>;
  maxRetries?: number;
  /** Optional ledger for `llm.call` events. */
  ledger?: LedgerWriter;
  /** Phase label written to the ledger. */
  phase: 'analysis' | 'planning' | 'generation' | 'recommendation';
}

export async function callWithRetry<T>(opts: CallWithRetryOptions<T>): Promise<T> {
  const { client, schema, ledger, phase } = opts;
  const maxRetries = opts.maxRetries ?? 2;
  const request = { ...opts.request };

  let lastRaw = '';
  let lastIssues: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const started = Date.now();
    const response = await client.complete(request);
    const latencyMs = Date.now() - started;

    lastRaw = response.content;
    const parsed = tryParseJSON(response.content);
    const result = schema.safeParse(parsed);

    await ledger?.append('llm.call', {
      model: response.model,
      provider: client.providerName,
      promptHash: sha256(request.systemPrompt + '\n' + request.userMessage),
      responseHash: sha256(response.content),
      tokensPrompt: response.tokensPrompt,
      tokensCompletion: response.tokensCompletion,
      latencyMs,
      phase,
      schemaValid: result.success,
      retryCount: attempt,
      finishReason: response.finishReason,
    });

    if (result.success) return result.data;
    lastIssues = result.error.issues;

    if (attempt < maxRetries) {
      request.userMessage +=
        '\n\nYour previous response failed schema validation. Issues:\n' +
        JSON.stringify(result.error.issues, null, 2) +
        '\n\nPlease correct and resubmit as a single JSON value with no preamble.';
    }
  }

  throw new LLMSchemaValidationError(lastRaw, lastIssues);
}

/**
 * Tolerant JSON extraction — LLMs like to wrap responses in markdown fences or add a
 * sentence of preamble despite instructions. Try plain parse first; then fall back to
 * extracting the first balanced `{…}` or `[…]` span.
 */
export function tryParseJSON(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }

  const span = extractBalanced(trimmed);
  if (span) {
    try {
      return JSON.parse(span);
    } catch {
      /* fall through */
    }
  }

  return null;
}

function extractBalanced(src: string): string | null {
  const openers = ['{', '['];
  const closers: Record<string, string> = { '{': '}', '[': ']' };
  let start = -1;
  let open = '';
  for (let i = 0; i < src.length; i++) {
    if (openers.includes(src[i])) {
      start = i;
      open = src[i];
      break;
    }
  }
  if (start === -1) return null;
  const close = closers[open];

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
