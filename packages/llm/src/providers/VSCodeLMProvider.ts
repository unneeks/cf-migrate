// VSCode Language Model adapter. Wraps `vscode.lm` — the API backed by the user's
// GitHub Copilot subscription. No API keys required; auth is inherited from the user's
// VSCode session.
//
// The vscode module is imported dynamically via the injected `vscodeApi` so this package
// stays publishable outside an extension host context (e.g. for tests).

import { LLMProviderUnavailableError } from '@cf-migrate/core';

import type { LLMClient, LLMRequest, LLMResponse } from '../client/LLMClient';

/** Minimal subset of the `vscode` namespace we use. Typed here so we can accept a stub. */
export interface VSCodeLMApi {
  LanguageModelChatMessage: {
    User: (content: string) => unknown;
    Assistant?: (content: string) => unknown;
  };
  lm: {
    selectChatModels: (selector?: {
      vendor?: string;
      family?: string;
      version?: string;
      id?: string;
    }) => Promise<VSCodeChatModel[]>;
  };
  CancellationTokenSource?: new () => { token: unknown; cancel(): void; dispose(): void };
}

export interface VSCodeChatModel {
  id: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number;
  countTokens?(text: string): Promise<number> | number;
  sendRequest(
    messages: unknown[],
    options?: { justification?: string; modelOptions?: Record<string, unknown> },
    token?: unknown,
  ): Promise<VSCodeChatResponse>;
}

export interface VSCodeChatResponse {
  text: AsyncIterable<string>;
  stream?: AsyncIterable<unknown>;
}

export interface VSCodeLMProviderOptions {
  /** Preferred Copilot family. `copilot` picks whatever family the user has access to. */
  family?: string;
  vendor?: string;
  /** Rationale string surfaced to the user when Copilot prompts for authorisation. */
  justification?: string;
}

export class VSCodeLMProvider implements LLMClient {
  readonly providerName = 'copilot';

  constructor(
    private readonly vscode: VSCodeLMApi,
    private readonly options: VSCodeLMProviderOptions = {},
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const models = await this.vscode.lm.selectChatModels(this.selector());
      return models.length > 0;
    } catch {
      return false;
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const models = await this.vscode.lm.selectChatModels(this.selector(request.model));
    if (models.length === 0) {
      throw new LLMProviderUnavailableError(
        this.providerName,
        'no Copilot chat models available — ensure the GitHub Copilot Chat extension is installed and signed in',
      );
    }
    const model = pickBestModel(models);

    // Blend the system prompt into the first user turn because Copilot's chat endpoint
    // surfaces only the role hierarchy `user|assistant`; the system prompt is conveyed as
    // a strongly-worded prelude.
    const prelude = request.jsonMode
      ? 'You MUST respond with a single JSON value and no prose, no markdown fences, no preamble.'
      : 'Respond exactly as instructed.';

    const content = [
      '# Instructions',
      request.systemPrompt.trim(),
      '',
      `# Output contract`,
      prelude,
      '',
      '# Request',
      request.userMessage.trim(),
    ].join('\n');

    const userMessage = this.vscode.LanguageModelChatMessage.User(content);

    const started = Date.now();
    const response = await model.sendRequest(
      [userMessage],
      {
        justification: this.options.justification ?? 'Codefresh → GitHub Actions migration assistant',
        modelOptions: {
          temperature: request.temperature,
          // Copilot ignores unknown options; include them so better models respect them.
          max_tokens: request.maxTokens,
        },
      },
      request.signal as unknown,
    );

    let text = '';
    try {
      for await (const chunk of response.text) {
        text += chunk;
      }
    } catch (err) {
      throw new LLMProviderUnavailableError(
        this.providerName,
        `stream read failed after ${Date.now() - started}ms: ${(err as Error).message}`,
      );
    }

    // Token counts aren't directly exposed; approximate with countTokens if available.
    let tokensPrompt = 0;
    let tokensCompletion = 0;
    if (typeof model.countTokens === 'function') {
      try {
        tokensPrompt = Number(await model.countTokens(content));
        tokensCompletion = Number(await model.countTokens(text));
      } catch {
        /* ignore — metrics only */
      }
    }

    return {
      content: text,
      tokensPrompt,
      tokensCompletion,
      model: `${model.vendor}/${model.family}@${model.version}`,
      finishReason: 'stop',
    };
  }

  private selector(model?: string): { vendor?: string; family?: string } {
    // If caller passes a model like "copilot/gpt-4o" or "gpt-4o" we use that family.
    const parts = (model ?? '').split('/');
    const family = this.options.family ?? (parts[1] ?? (parts[0] || undefined));
    const selector: { vendor?: string; family?: string } = {};
    if (this.options.vendor) selector.vendor = this.options.vendor;
    else selector.vendor = 'copilot';
    if (family && family !== 'copilot') selector.family = family;
    return selector;
  }
}

function pickBestModel(models: VSCodeChatModel[]): VSCodeChatModel {
  // Heuristic: prefer largest context window, then newest family (gpt-4o > gpt-4 > gpt-3.5).
  const priority: Record<string, number> = {
    'gpt-5': 100,
    'gpt-4o': 90,
    'claude-3.5-sonnet': 85,
    'claude-sonnet-4': 95,
    'gpt-4': 70,
    'o1': 80,
    'gpt-3.5-turbo': 40,
  };
  return [...models].sort((a, b) => {
    const pa = priority[a.family] ?? 0;
    const pb = priority[b.family] ?? 0;
    if (pb !== pa) return pb - pa;
    return (b.maxInputTokens ?? 0) - (a.maxInputTokens ?? 0);
  })[0];
}
