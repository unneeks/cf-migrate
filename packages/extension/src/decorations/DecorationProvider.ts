// Underlines CF constructs on the active editor by confidence tier.
//   Tier A (deterministic)  → subtle green underline
//   Tier B (contextual)     → amber dotted underline
//   Tier C (complex)        → red wavy underline + margin icon
//
// Runs after AnalysisAgent populates `session.analysisResult.constructs`.

import * as path from 'path';
import * as vscode from 'vscode';

import type { DetectedConstruct } from '@cf-migrate/core';

import type { ExtensionServices } from '../services/ExtensionServices';

export class DecorationProvider implements vscode.Disposable {
  private readonly tierA: vscode.TextEditorDecorationType;
  private readonly tierB: vscode.TextEditorDecorationType;
  private readonly tierC: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly services: () => ExtensionServices | undefined) {
    this.tierA = vscode.window.createTextEditorDecorationType({
      textDecoration: 'underline dotted rgba(60, 200, 120, 0.6)',
      overviewRulerColor: 'rgba(60, 200, 120, 0.4)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.tierB = vscode.window.createTextEditorDecorationType({
      textDecoration: 'underline dotted rgba(230, 180, 60, 0.8)',
      overviewRulerColor: 'rgba(230, 180, 60, 0.5)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.tierC = vscode.window.createTextEditorDecorationType({
      textDecoration: 'underline wavy rgba(220, 80, 80, 0.9)',
      overviewRulerColor: 'rgba(220, 80, 80, 0.6)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      gutterIconPath: undefined,
    });

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor?.document === e.document) this.refresh();
      }),
    );
  }

  refresh(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const s = this.services();
    if (!s?.session.activePipeline || !s.session.analysisResult) {
      this.clear(editor);
      return;
    }
    const pipelinePath = s.session.activePipeline.path;
    if (path.resolve(editor.document.uri.fsPath) !== path.resolve(pipelinePath)) {
      this.clear(editor);
      return;
    }

    const a: vscode.DecorationOptions[] = [];
    const b: vscode.DecorationOptions[] = [];
    const c: vscode.DecorationOptions[] = [];

    for (const construct of s.session.analysisResult.constructs) {
      const range = toRange(editor.document, construct);
      const bucket = construct.confidenceTier === 'A' ? a : construct.confidenceTier === 'B' ? b : c;
      bucket.push({
        range,
        hoverMessage: hoverFor(construct),
      });
    }

    editor.setDecorations(this.tierA, a);
    editor.setDecorations(this.tierB, b);
    editor.setDecorations(this.tierC, c);
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.tierA, []);
    editor.setDecorations(this.tierB, []);
    editor.setDecorations(this.tierC, []);
  }

  dispose(): void {
    this.tierA.dispose();
    this.tierB.dispose();
    this.tierC.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function toRange(doc: vscode.TextDocument, c: DetectedConstruct): vscode.Range {
  const startLine = Math.max(0, Math.min(doc.lineCount - 1, c.lineStart - 1));
  const endLine = Math.max(startLine, Math.min(doc.lineCount - 1, c.lineEnd - 1));
  const start = doc.lineAt(startLine).range.start;
  const end = doc.lineAt(endLine).range.end;
  return new vscode.Range(start, end);
}

function hoverFor(c: DetectedConstruct): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(
    `**CF construct:** \`${c.type}\` — confidence tier **${c.confidenceTier}**\n\n` +
      (c.stepName ? `_Step:_ \`${c.stepName}\`\n\n` : '') +
      `[Plan this construct](command:cf-migrate.plan) · [Explain](command:cf-migrate.openKB)`,
  );
  return md;
}
