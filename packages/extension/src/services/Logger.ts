// Central diagnostic log for the extension — a "CF Migrate" Output channel, visible the
// same way as any other extension's output (Output panel → channel dropdown), plus a
// command to jump straight to it. Exists because several failure modes in this extension
// are silent by design (best-effort YAML parsing, optional file reads, fuzzy step-name
// matching) — when one of those "best effort"s actually fails, this is where to look instead
// of it just looking broken with no explanation.

import * as vscode from 'vscode';

class Logger {
  private channel: vscode.OutputChannel | null = null;

  private get ch(): vscode.OutputChannel {
    if (!this.channel) this.channel = vscode.window.createOutputChannel('CF Migrate');
    return this.channel;
  }

  private write(level: 'INFO' | 'WARN' | 'ERROR', message: string, detail?: unknown): void {
    const ts = new Date().toISOString();
    let line = `[${ts}] [${level}] ${message}`;
    if (detail !== undefined) {
      const detailStr =
        detail instanceof Error ? (detail.stack ?? detail.message) :
        typeof detail === 'string' ? detail :
        safeStringify(detail);
      line += '\n' + detailStr.split('\n').map((l) => '    ' + l).join('\n');
    }
    this.ch.appendLine(line);
  }

  info(message: string, detail?: unknown): void { this.write('INFO', message, detail); }
  warn(message: string, detail?: unknown): void { this.write('WARN', message, detail); }
  error(message: string, detail?: unknown): void { this.write('ERROR', message, detail); }

  /** Reveals the Output channel — call this alongside showErrorMessage for failures the
   *  user should be able to dig into immediately, not just be told "something failed". */
  show(): void { this.ch.show(true); }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export const logger = new Logger();
