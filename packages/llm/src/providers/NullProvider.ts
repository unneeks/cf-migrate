// Null provider used when Copilot is unavailable during tests or CI. Always throws with
// a helpful message on `complete()` and reports `isAvailable() === false`.

import { LLMProviderUnavailableError } from '@cf-migrate/core';

import type { LLMClient, LLMRequest, LLMResponse } from '../client/LLMClient';

export class NullProvider implements LLMClient {
  readonly providerName = 'null';

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async complete(_request: LLMRequest): Promise<LLMResponse> {
    throw new LLMProviderUnavailableError(
      'null',
      'no LLM provider configured — set cfMigrate.llmProvider=copilot and install GitHub Copilot, or configure OpenAI',
    );
  }
}
