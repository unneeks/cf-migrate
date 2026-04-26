// SPEC §5.1 — Discovery phase.
// Scans the workspace for Codefresh pipeline files (codefresh.yml, *.cf.yml,
// .codefresh/**/*.yml), reads them, and builds a PipelineInventory with a dependency
// graph of step-template references and shared-library includes.

import * as fsp from 'fs/promises';
import * as path from 'path';

import {
  LedgerWriter,
  PipelineFile,
  PipelineInventory,
  DependencyEdge,
  walkFiles,
  matchSuffix,
  matchAnyPrefix,
  parseYaml,
  uuid,
} from '@cf-migrate/core';

export interface DiscoveryAgentOptions {
  ledger?: LedgerWriter;
  /** Include glob patterns relative to workspace. */
  include?: string[];
  /** Exclude glob patterns relative to workspace. */
  exclude?: string[];
  /** Maximum files to scan — guards against accidentally loading a monorepo. */
  maxFiles?: number;
}

const DEFAULT_INCLUDE = [
  '**/codefresh.yml',
  '**/codefresh.yaml',
  '**/*.cf.yml',
  '**/*.cf.yaml',
  '.codefresh/**/*.yml',
  '.codefresh/**/*.yaml',
];

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/vendor/**',
  '**/.cf-migrate/**',
];

export class DiscoveryAgent {
  private readonly ledger?: LedgerWriter;
  private readonly include: string[];
  private readonly exclude: string[];
  private readonly maxFiles: number;

  constructor(opts: DiscoveryAgentOptions = {}) {
    this.ledger = opts.ledger;
    this.include = opts.include ?? DEFAULT_INCLUDE;
    this.exclude = opts.exclude ?? DEFAULT_EXCLUDE;
    this.maxFiles = opts.maxFiles ?? 500;
  }

  async discover(workspacePath: string): Promise<PipelineInventory> {
    const started = Date.now();

    const includeFn = matchSuffix(this.include);
    const excludeFn = matchAnyPrefix(this.exclude);

    const found: string[] = [];
    for await (const file of walkFiles(workspacePath, includeFn, excludeFn)) {
      found.push(file);
      if (found.length >= this.maxFiles) break;
    }

    const pipelines: PipelineFile[] = [];
    for (const abs of found) {
      try {
        const raw = await fsp.readFile(abs, 'utf8');
        const stat = await fsp.stat(abs);
        if (!looksLikeCodefreshPipeline(raw)) continue;
        pipelines.push({
          path: abs,
          relativePath: path.relative(workspacePath, abs).replace(/\\/g, '/'),
          name: path.basename(abs),
          rawYaml: raw,
          lastModified: stat.mtime,
        });
      } catch {
        // Unreadable — skip.
      }
    }

    const dependencyGraph = buildDependencyGraph(pipelines);
    const totalStepCount = pipelines.reduce((acc, p) => acc + countSteps(p.rawYaml), 0);

    const inventory: PipelineInventory = {
      workspacePath,
      discoveredAt: new Date(),
      pipelines,
      dependencyGraph,
      totalStepCount,
      estimatedComplexity:
        totalStepCount < 20 ? 'low' : totalStepCount < 60 ? 'medium' : 'high',
    };

    await this.ledger?.append('discovery.scan', {
      pipelineCount: pipelines.length,
      totalStepCount,
      durationMs: Date.now() - started,
      discoveryId: uuid(),
    });

    return inventory;
  }
}

function looksLikeCodefreshPipeline(raw: string): boolean {
  // Cheap heuristic — CF pipelines have `version:` + `steps:` at the root. Accept either
  // string match or a successful YAML parse that yields an object with `steps`.
  if (!/\bversion\s*:/.test(raw)) return false;
  if (!/\bsteps\s*:/.test(raw) && !/\bstages\s*:/.test(raw)) return false;
  try {
    const parsed = parseYaml<Record<string, unknown>>(raw);
    if (!parsed || typeof parsed !== 'object') return false;
    return 'steps' in parsed || 'stages' in parsed;
  } catch {
    return false;
  }
}

function countSteps(raw: string): number {
  try {
    const parsed = parseYaml<{ steps?: Record<string, unknown> }>(raw);
    if (!parsed?.steps || typeof parsed.steps !== 'object') return 0;
    return Object.keys(parsed.steps).length;
  } catch {
    return 0;
  }
}

/** Scan pipelines for `template:` / `import:` / `use:` cross-references. Emit dependency
 *  edges where `from` references `to` by filename or template name. */
function buildDependencyGraph(pipelines: PipelineFile[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const byFilename = new Map<string, string>(); // basename → relativePath
  for (const p of pipelines) byFilename.set(p.name.toLowerCase(), p.relativePath);

  const templateRef = /\btemplate\s*:\s*["']?([^\s"'{},]+)/g;
  const importRef = /\bimport\s*:\s*["']?([^\s"'{},]+)/g;

  for (const p of pipelines) {
    const matches = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = templateRef.exec(p.rawYaml))) matches.add(m[1]);
    while ((m = importRef.exec(p.rawYaml))) matches.add(m[1]);

    for (const ref of matches) {
      const target = byFilename.get(path.basename(ref).toLowerCase());
      if (!target || target === p.relativePath) continue;
      edges.push({ from: p.relativePath, to: target, type: 'step-template' });
    }
  }

  return edges;
}
