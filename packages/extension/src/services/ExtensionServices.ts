// Dependency-injection container for the extension.
//
// Holds one set of long-lived services per workspace:
//   • LedgerWriter (append-only audit log)
//   • FileKBStore + LexicalSearch (knowledge base)
//   • VSCodeLMProvider (Copilot wrapper) + NullProvider fallback
//   • PromptRenderer
//   • All agents (Discovery, Analysis, Planning, Recommendation, Generation, Validation, KBManager)
//   • In-memory SessionContext
//
// The container is rebuilt whenever the workspace folder changes or settings change.

import * as path from 'path';
import * as vscode from 'vscode';

import {
  LedgerWriter,
  OrgSettings,
  OrgWorkflowIndex,
  SessionContext,
  emptyIndex,
  loadOrgSettings,
  uuid,
} from '@cf-migrate/core';

import { FileKBStore, LexicalSearch, SnippetRenderer } from '@cf-migrate/kb';

import {
  LLMClient,
  NullProvider,
  PromptRenderer,
  VSCodeLMProvider,
} from '@cf-migrate/llm';

import {
  AnalysisAgent,
  DeterministicGenerationAgent,
  DiscoveryAgent,
  GenerationAgent,
  KBManagerAgent,
  PlanningAgent,
  RecommendationAgent,
  ValidationAgent,
} from '@cf-migrate/agents';

export interface ExtensionServices {
  workspaceFolder: vscode.WorkspaceFolder;
  orgSettings: OrgSettings;
  orgIndex: OrgWorkflowIndex;
  ledger: LedgerWriter;
  kbStore: FileKBStore;
  kbSearch: LexicalSearch;
  promptRenderer: PromptRenderer;
  llm: LLMClient;
  /** Becomes true once the VSCode LM API returns at least one model. */
  llmAvailable: boolean;
  /** True when cfMigrate.deterministicOnly is enabled in settings. */
  deterministicOnly: boolean;
  agents: {
    discovery: DiscoveryAgent;
    analysis: AnalysisAgent;
    planning: PlanningAgent;
    recommendation: RecommendationAgent;
    generation: GenerationAgent | DeterministicGenerationAgent;
    validation: ValidationAgent;
    kbManager: KBManagerAgent;
  };
  session: SessionContext;
  dispose(): void;
}

export async function createServices(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
): Promise<ExtensionServices> {
  const workspacePath = folder.uri.fsPath;
  const vscodeSettings = readVscodeSettings();

  const orgSettings = await loadOrgSettings({
    workspacePath,
    vscodeSettings,
  });

  // Default KB path to the bundled kb-default (sits alongside the extension).
  if (!orgSettings.kbPath) {
    orgSettings.kbPath = path.join(context.extensionPath, 'kb-default');
  }

  const promptTemplatesRoot =
    orgSettings.promptTemplatesPath ?? path.join(context.extensionPath, 'prompt-templates');

  const ledger = new LedgerWriter(workspacePath, { enableHashChain: orgSettings.enableHashChain });
  const kbStore = new FileKBStore(orgSettings.kbPath);
  const kbSearch = new LexicalSearch();
  const promptRenderer = new PromptRenderer(promptTemplatesRoot);

  // Wrap `vscode.lm` — falls back to NullProvider if Copilot isn't available.
  let llm: LLMClient = new NullProvider();
  let llmAvailable = false;
  try {
    const provider = new VSCodeLMProvider(
      vscode as unknown as import('@cf-migrate/llm').VSCodeLMApi,
    );
    llmAvailable = await provider.isAvailable();
    if (llmAvailable) {
      llm = provider;
    }
  } catch {
    // VSCode LM API not ready — will retry on first user-initiated LLM call.
  }

  const deterministicOnly =
    vscode.workspace.getConfiguration('cfMigrate').get<boolean>('deterministicOnly', false) ||
    !llmAvailable;

  const orgIndex = await loadOrgIndex(workspacePath);

  const discovery = new DiscoveryAgent({ ledger });
  const analysis = new AnalysisAgent({
    llm,
    ledger,
    promptRenderer,
    deterministicOnly,
  });
  const kbManager = new KBManagerAgent({
    store: kbStore,
    search: kbSearch,
    ledger,
    editor: 'vscode-user',
  });
  const planning = new PlanningAgent({
    llm,
    ledger,
    promptRenderer,
    kbSearch,
    deterministicOnly,
  });
  const recommendation = new RecommendationAgent({
    llm,
    ledger,
    promptRenderer,
    ghaIndex: orgIndex,
    deterministicOnly,
  });
  const generation = deterministicOnly
    ? new DeterministicGenerationAgent({
        ledger,
        kbStore,
        orgSettings,
        orgIndex,
        snippetRenderer: new SnippetRenderer(),
      })
    : new GenerationAgent({
        llm,
        ledger,
        promptRenderer,
        kbStore,
        kbSearch,
        orgSettings,
        orgIndex,
        snippetRenderer: new SnippetRenderer(),
      });
  const validation = new ValidationAgent({
    ledger,
    orgSettings,
    skipActionlint: !orgSettings.runActionlint,
  });

  const now = new Date();
  const session: SessionContext = {
    id: uuid(),
    workspacePath,
    phase: 'idle',
    chatHistory: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
  };

  return {
    workspaceFolder: folder,
    orgSettings,
    orgIndex,
    ledger,
    kbStore,
    kbSearch,
    promptRenderer,
    llm,
    llmAvailable,
    deterministicOnly,
    agents: { discovery, analysis, planning, recommendation, generation, validation, kbManager },
    session,
    dispose() {
      // Nothing to dispose yet — LedgerWriter is fire-and-forget append-only.
    },
  };
}

function readVscodeSettings(): Partial<OrgSettings> {
  const config = vscode.workspace.getConfiguration('cfMigrate');
  const out: Partial<OrgSettings> = {};
  const kbPath = config.get<string>('kbPath');
  if (kbPath) out.kbPath = kbPath;
  const orgName = config.get<string>('orgName');
  if (orgName) out.orgName = orgName;
  const ghaRepoPaths = config.get<string[]>('ghaRepoPaths');
  if (ghaRepoPaths) out.ghaRepoPaths = ghaRepoPaths;
  out.runActionlint = config.get<boolean>('runActionlint') ?? true;
  out.enableHashChain = config.get<boolean>('enableHashChain') ?? false;
  out.autoIndexOnActivation = config.get<boolean>('autoIndexOnActivation') ?? true;
  return out;
}

async function loadOrgIndex(workspacePath: string): Promise<OrgWorkflowIndex> {
  // SPEC §5.2.c — org index cached at `.cf-migrate/org-index.json`.
  const indexPath = path.join(workspacePath, '.cf-migrate', 'org-index.json');
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(indexPath));
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as OrgWorkflowIndex;
    return parsed;
  } catch {
    return emptyIndex();
  }
}
