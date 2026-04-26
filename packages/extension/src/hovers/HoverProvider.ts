// Hovers over a CF construct reveal:
//   • Detected type + confidence tier
//   • Planned GHA mapping (if a plan is in place)
//   • Top KB snippet match with "Insert" action

import * as vscode from 'vscode';

import type { DetectedConstruct } from '@cf-migrate/core';

import type { ExtensionServices } from '../services/ExtensionServices';

export class CFMigrateHoverProvider implements vscode.HoverProvider {
  constructor(private readonly services: () => ExtensionServices | undefined) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const s = this.services();
    if (!s?.session.analysisResult || !s.session.activePipeline) return undefined;
    if (document.uri.fsPath !== s.session.activePipeline.path) return undefined;

    const line = position.line + 1;
    const hit = s.session.analysisResult.constructs.find(
      (c) => c.lineStart <= line && line <= c.lineEnd,
    );
    if (!hit) return undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**CF construct:** \`${hit.type}\` (tier **${hit.confidenceTier}**)\n\n`);
    if (hit.stepName) md.appendMarkdown(`_Step:_ \`${hit.stepName}\`\n\n`);

    const plan = s.session.migrationPlan;
    const planItem = plan?.items.find(
      (i) =>
        i.cfConstructRef.constructType === hit.type &&
        i.cfConstructRef.lineStart === hit.lineStart,
    );
    if (planItem) {
      md.appendMarkdown(
        `**Planned mapping:** ${planItem.ghaRecommendation.actionOrPattern}\n\n` +
          `${planItem.ghaRecommendation.description}\n\n` +
          `_Rationale:_ ${planItem.rationale}\n\n`,
      );
    }

    try {
      const matches = await s.agents.kbManager.query(hit.type + ' ' + (hit.stepName ?? ''), 1);
      if (matches.length > 0) {
        const top = matches[0];
        md.appendMarkdown(
          `**KB match:** [${top.item.title}](command:cf-migrate.openKB) _(score ${top.score.toFixed(2)})_\n\n` +
            (top.item.description ? `${top.item.description}\n\n` : ''),
        );
      }
    } catch {
      // KB not loaded — hover still useful without it.
    }

    md.appendMarkdown(
      `[Plan](command:cf-migrate.plan) · [Review](command:cf-migrate.openApproval) · [Knowledge Base](command:cf-migrate.openKB)`,
    );

    return new vscode.Hover(md, locationToRange(document, hit));
  }
}

function locationToRange(doc: vscode.TextDocument, c: DetectedConstruct): vscode.Range {
  const startLine = Math.max(0, Math.min(doc.lineCount - 1, c.lineStart - 1));
  const endLine = Math.max(startLine, Math.min(doc.lineCount - 1, c.lineEnd - 1));
  return new vscode.Range(doc.lineAt(startLine).range.start, doc.lineAt(endLine).range.end);
}
