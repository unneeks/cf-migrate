// CF Migrate — VSCode extension entry point.
//
// Lifecycle:
//   activate(context) → for the (first) workspace folder, build the ExtensionServices
//   container, register commands / views / providers / chat participant. If the user
//   has `cfMigrate.autoIndexOnActivation` set, kick off discovery in the background.
//
//   deactivate() is a no-op — the LedgerWriter is fire-and-forget and all VSCode
//   resources we registered are tracked in `context.subscriptions`.
//
// Multi-root workspaces are supported in single-root mode for now: we attach to the
// first folder. Switching folders rebuilds the container.

import * as vscode from 'vscode';

import { registerCommands } from './commands/registerCommands';
import { CFMigrateCodeLensProvider } from './codelens/CodeLensProvider';
import { registerCopilotParticipant } from './chat/CopilotParticipant';
import { DecorationProvider } from './decorations/DecorationProvider';
import { CFMigrateHoverProvider } from './hovers/HoverProvider';
import { KBTreeProvider } from './views/KBTreeProvider';
import { MapRunTreeProvider } from './views/MapRunTreeProvider';
import { PipelineTreeProvider } from './views/PipelineTreeProvider';
import { StatusBarManager } from './statusbar/StatusBarManager';
import { MapRunDiffPanel } from './webviews/MapRunDiffPanel';
import { createServices, type ExtensionServices } from './services/ExtensionServices';
import type { MapRunEntry } from './scanners/MapRunScanner';
import { runGenerateCallerWorkflows } from './commands/generateCallerWorkflows';
import type { TemplateGroup } from './utils/TemplateGrouping';
import { logger } from './services/Logger';

let currentServices: ExtensionServices | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];

  // ── Lazy services factory ─────────────────────────────────────────────────
  const servicesGetter = (): ExtensionServices | undefined => currentServices;

  // ── Views (always registered so the activity-bar icon is functional) ─────
  const pipelineProvider = new PipelineTreeProvider(servicesGetter);
  const kbProvider = new KBTreeProvider(servicesGetter);
  const mapRunProvider = new MapRunTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('cf-migrate.pipelines', pipelineProvider),
    vscode.window.registerTreeDataProvider('cf-migrate.kb', kbProvider),
    vscode.window.registerTreeDataProvider('cf-migrate.mapRuns', mapRunProvider),
  );

  // ── Map Run commands ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('cf-migrate.refreshMapRuns', () => {
      void mapRunProvider.refresh();
    }),
    vscode.commands.registerCommand('cf-migrate.openMapRun', (entry: MapRunEntry) => {
      void MapRunDiffPanel.show(context, entry, servicesGetter);
    }),
    vscode.commands.registerCommand('cf-migrate.explainInstance', (entry: MapRunEntry, group: TemplateGroup) => {
      void vscode.window.showInformationMessage(
        `"${entry.data.meta.pipeline_name}" is an instance of template "${group.template.data.meta.pipeline_name}" — ` +
          `mapping is defined once on the template. Right-click the template group and choose ` +
          `"Generate Caller Workflows" to emit this instance's reusable-workflow caller.`,
        'Open Template Map Run',
      ).then((choice) => {
        if (choice) void MapRunDiffPanel.show(context, group.template, servicesGetter);
      });
    }),
    vscode.commands.registerCommand('cf-migrate.generateCallerWorkflows', (group: TemplateGroup) => {
      void runGenerateCallerWorkflows(group);
    }),
  );

  // Eagerly populate the map-run tree on activation.
  void mapRunProvider.refresh();

  // ── Editor providers ──────────────────────────────────────────────────────
  const codeLens = new CFMigrateCodeLensProvider(servicesGetter);
  const hover = new CFMigrateHoverProvider(servicesGetter);
  const yamlSelector: vscode.DocumentSelector = [
    { language: 'yaml', scheme: 'file' },
    { pattern: '**/codefresh.{yml,yaml}' },
    { pattern: '**/*.cf.{yml,yaml}' },
    { pattern: '**/.codefresh/**/*.{yml,yaml}' },
  ];
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(yamlSelector, codeLens),
    vscode.languages.registerHoverProvider(yamlSelector, hover),
  );

  const decorations = new DecorationProvider(servicesGetter);
  context.subscriptions.push(decorations);

  const statusBar = new StatusBarManager(servicesGetter);
  context.subscriptions.push(statusBar);

  // ── Onchange callback used by commands / panels ───────────────────────────
  const onChange = (): void => {
    pipelineProvider.refresh();
    void kbProvider.refresh();
    decorations.refresh();
    statusBar.refresh();
    codeLens.refresh();
  };

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    ...registerCommands({ context, services: servicesGetter, onChange }),
  );

  // ── Chat participant (only if the chat API exists in this VSCode build) ──
  const participant = registerCopilotParticipant(context, servicesGetter);
  if (participant) context.subscriptions.push(participant);

  // ── Build services for the active folder ─────────────────────────────────
  if (folder) {
    try {
      currentServices = await createServices(context, folder);
      context.subscriptions.push({ dispose: () => currentServices?.dispose() });
      onChange();

      if (currentServices.orgSettings.autoIndexOnActivation) {
        // Fire-and-forget — discovery surfaces a notification on completion.
        void vscode.commands.executeCommand('cf-migrate.discover');
      }

      // KB tree population happens after services exist.
      void kbProvider.refresh();
    } catch (err) {
      logger.error('CF Migrate failed to initialise', err);
      void vscode.window.showErrorMessage(
        `CF Migrate failed to initialise: ${(err as Error).message}`,
        'Show Logs',
      ).then((choice) => { if (choice) logger.show(); });
    }
  } else {
    statusBar.refresh();
  }

  // ── Rebuild services when the workspace folder list changes ──────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      const next = vscode.workspace.workspaceFolders?.[0];
      if (!next) {
        currentServices?.dispose();
        currentServices = undefined;
      } else if (!currentServices || currentServices.workspaceFolder.uri.fsPath !== next.uri.fsPath) {
        currentServices?.dispose();
        currentServices = await createServices(context, next);
      }
      onChange();
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('cfMigrate')) return;
      const next = vscode.workspace.workspaceFolders?.[0];
      if (!next) return;
      currentServices?.dispose();
      currentServices = await createServices(context, next);
      onChange();
    }),
  );
}

export function deactivate(): void {
  currentServices?.dispose();
  currentServices = undefined;
}
