// SPEC §7.1 — Provider-agnostic LLM interface.

export interface LLMRequest {
  /** Model identifier — interpreted by the provider. For Copilot this is the model family
   *  (e.g. `gpt-4o`, `claude-sonnet`). */
  model: string;
  systemPrompt: string;
  userMessage: string;
  temperature: number;
  maxTokens: number;
  /** Request JSON output. Providers that can enforce JSON mode do so; others wrap the
   *  request with `<OUTPUT>{json}</OUTPUT>` and rely on the caller's Zod schema + retry. */
  jsonMode: boolean;
  /** Optional JSON Schema for strict function-calling style providers (OpenAI). Copilot
   *  via `vscode.lm` doesn't expose this; it's a hint only. */
  responseSchema?: object;
  /** Abort signal from the caller (e.g. vscode.CancellationToken). */
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: string;
  tokensPrompt: number;
  tokensCompletion: number;
  model: string;
  finishReason: 'stop' | 'length' | 'error';
  /** Non-fatal provider notes — e.g. "Copilot returned a partial response and was
   *  completed with fallback model." */
  notes?: string[];
}

export interface LLMClient {
  readonly providerName: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
  /** Report whether the provider is available in this runtime (Copilot: chat models
   *  available; OpenAI: API key configured; etc.). Used to fail-fast with a human-readable
   *  error rather than a generic exception mid-flow. */
  isAvailable(): Promise<boolean>;
}
