// SPEC §7.6 — Prompt template renderer.
//
// Templates live as plain markdown files under `prompt-templates/{phase}/{system|user}.md`.
// Variables are `{{UPPER_SNAKE}}`. Unresolved variables are left literal and logged.

import * as path from 'path';
import * as fsp from 'fs/promises';

export type PromptPhase = 'analysis' | 'planning' | 'generation' | 'recommendation';

export interface RenderedPrompt {
  systemPrompt: string;
  userMessage: string;
}

export class PromptRenderer {
  /** Cache rendered source files per absolute path so we only hit the disk once per session. */
  private cache = new Map<string, string>();

  constructor(private readonly templatesRoot: string) {}

  async render(phase: PromptPhase, variables: Record<string, string>): Promise<RenderedPrompt> {
    const [systemRaw, userRaw] = await Promise.all([
      this.load(path.join(this.templatesRoot, phase, 'system.md')),
      this.load(path.join(this.templatesRoot, phase, 'user.md')),
    ]);
    return {
      systemPrompt: substitute(systemRaw, variables),
      userMessage: substitute(userRaw, variables),
    };
  }

  private async load(filePath: string): Promise<string> {
    let cached = this.cache.get(filePath);
    if (cached !== undefined) return cached;
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      this.cache.set(filePath, raw);
      return raw;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Missing user.md is fine — the system prompt is enough for some phases.
        if (filePath.endsWith('user.md')) {
          this.cache.set(filePath, '{{USER_MESSAGE}}');
          return '{{USER_MESSAGE}}';
        }
      }
      throw err;
    }
  }
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name: string) => {
    if (name in vars) return vars[name];
    return match;
  });
}
