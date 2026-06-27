// SPEC §5.1 — Discovery phase.
//
// Scans the workspace for Codefresh pipeline definitions in two formats:
//
//   YAML  — codefresh.yml, *.cf.yml, .codefresh/**/*.yml  (existing behaviour)
//   JSON  — Codefresh REST API exports: GET /api/pipelines/{name_or_id}
//           Matched by path convention (see JSON_INCLUDE) and validated by
//           schema (must have kind:"pipeline" + spec.steps).
//           Both single-pipeline objects and arrays of pipeline objects are
//           supported — one PipelineFile per pipeline found in the file.
//
// For JSON sources the rawYaml field is populated from:
//   1. metadata.originalYamlString  (verbatim YAML as authored — preferred)
//   2. A re-serialisation of spec.steps / spec.stages / spec.triggers
//      using the yaml library (fallback when originalYamlString is absent)

import * as fsp from 'fs/promises';
import * as path from 'path';

import {
  CfApiMetadata,
  CfApiPipeline,
  DependencyEdge,
  LedgerWriter,
  PipelineFile,
  PipelineInventory,
  matchAnyPrefix,
  matchSuffix,
  parseYaml,
  stringify,
  uuid,
  walkFiles,
} from '@cf-migrate/core';

export interface DiscoveryAgentOptions {
  ledger?: LedgerWriter;
  /** Include glob patterns relative to workspace (YAML). */
  include?: string[];
  /** Include glob patterns relative to workspace (JSON API exports). */
  includeJson?: string[];
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

// JSON globs specific enough to avoid false-positives on arbitrary project JSON.
const DEFAULT_JSON_INCLUDE = [
  '**/*.pipeline.json',
  '**/codefresh/**/*.json',
  '**/cf-exports/**/*.json',
  '**/cf-pipelines/**/*.json',
  '**/pipeline-exports/**/*.json',
  '**/workflow-imports/**/*.json',
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
  private readonly includeJson: string[];
  private readonly exclude: string[];
  private readonly maxFiles: number;

  constructor(opts: DiscoveryAgentOptions = {}) {
    this.ledger      = opts.ledger;
    this.include     = opts.include     ?? DEFAULT_INCLUDE;
    this.includeJson = opts.includeJson ?? DEFAULT_JSON_INCLUDE;
    this.exclude     = opts.exclude     ?? DEFAULT_EXCLUDE;
    this.maxFiles    = opts.maxFiles    ?? 500;
  }

  async discover(workspacePath: string): Promise<PipelineInventory> {
    const started = Date.now();

    const yamlFn    = matchSuffix(this.include);
    const jsonFn    = matchSuffix(this.includeJson);
    const excludeFn = matchAnyPrefix(this.exclude);

    // Walk once; bucket by format.
    const seen      = new Set<string>();
    const yamlFiles: string[] = [];
    const jsonFiles: string[] = [];

    for await (const abs of walkFiles(workspacePath, (r) => yamlFn(r) || jsonFn(r), excludeFn)) {
      if (seen.has(abs)) continue;
      seen.add(abs);
      const rel = path.relative(workspacePath, abs).replace(/\\/g, '/');
      (yamlFn(rel) ? yamlFiles : jsonFiles).push(abs);
      if (seen.size >= this.maxFiles) break;
    }

    const pipelines: PipelineFile[] = [];

    // ── YAML files ────────────────────────────────────────────────────────────
    for (const abs of yamlFiles) {
      try {
        const raw  = await fsp.readFile(abs, 'utf8');
        const stat = await fsp.stat(abs);
        if (!looksLikeCFYaml(raw)) continue;
        pipelines.push({
          path:         abs,
          relativePath: path.relative(workspacePath, abs).replace(/\\/g, '/'),
          name:         path.basename(abs),
          rawYaml:      raw,
          lastModified: stat.mtime,
          sourceFormat: 'yaml',
        });
      } catch {
        // Unreadable — skip.
      }
    }

    // ── JSON files (CF API exports) ───────────────────────────────────────────
    for (const abs of jsonFiles) {
      try {
        const raw  = await fsp.readFile(abs, 'utf8');
        const stat = await fsp.stat(abs);
        const found = parseCFApiJson(raw);
        if (!found) continue;

        for (const pipeline of found) {
          const yamlStr = cfApiToYaml(pipeline);
          if (!yamlStr) continue;

          const leafName = pipeline.metadata.name?.split('/').pop()
            ?? path.basename(abs, '.json');

          pipelines.push({
            path:         abs,
            relativePath: path.relative(workspacePath, abs).replace(/\\/g, '/'),
            name:         `${leafName} (api)`,
            rawYaml:      yamlStr,
            lastModified: stat.mtime,
            sourceFormat: 'json',
            apiMeta:      pipeline.metadata,
          });
        }
      } catch {
        // Unreadable or malformed — skip.
      }
    }

    const dependencyGraph = buildDependencyGraph(pipelines);
    const totalStepCount  = pipelines.reduce((n, p) => n + countSteps(p.rawYaml), 0);

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
      yamlCount:     yamlFiles.length,
      jsonCount:     jsonFiles.length,
      totalStepCount,
      durationMs:    Date.now() - started,
      discoveryId:   uuid(),
    });

    return inventory;
  }
}

// ── YAML validation ───────────────────────────────────────────────────────────

function looksLikeCFYaml(raw: string): boolean {
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

// ── CF API JSON parsing ───────────────────────────────────────────────────────

function isCFApiPipeline(obj: unknown): obj is CfApiPipeline {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    o['kind'] === 'pipeline' &&
    typeof o['version'] === 'string' &&
    typeof o['metadata'] === 'object' && o['metadata'] !== null &&
    typeof o['spec'] === 'object'     && o['spec']     !== null
  );
}

/** Parse raw JSON. Returns an array of valid CfApiPipelines (handles both
 *  single-object and array exports), or null if nothing valid is found. */
function parseCFApiJson(raw: string): CfApiPipeline[] | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }

  if (Array.isArray(obj)) {
    const valid = obj.filter(isCFApiPipeline);
    return valid.length > 0 ? valid : null;
  }
  return isCFApiPipeline(obj) ? [obj] : null;
}

/** Convert a CfApiPipeline to a YAML string for the analysis chain.
 *
 *  Priority:
 *  1. metadata.originalYamlString — verbatim as authored (most faithful).
 *  2. Re-serialise spec           — loses comments/formatting but works when
 *                                   originalYamlString is absent.
 */
function cfApiToYaml(pipeline: CfApiPipeline): string | null {
  if (pipeline.metadata.originalYamlString?.trim()) {
    return pipeline.metadata.originalYamlString;
  }

  const { spec, metadata, version } = pipeline;
  if (!spec.steps || Object.keys(spec.steps).length === 0) return null;

  const doc: Record<string, unknown> = { version };
  if (spec.stages?.length)                           doc['stages']    = spec.stages;
  if (spec.triggers?.length)                         doc['triggers']  = spec.triggers;
  if (spec.variables?.length)                        doc['variables'] = spec.variables;
  if (spec.contexts?.length)                         doc['contexts']  = spec.contexts;
  if (spec.mode)                                     doc['mode']      = spec.mode;
  if (spec.failFast != null)                         doc['fail_fast'] = spec.failFast;
  if (spec.hooks && Object.keys(spec.hooks).length)  doc['hooks']     = spec.hooks;
  doc['steps'] = spec.steps;

  const header = `# Reconstructed from CF API export — pipeline: ${metadata.name ?? 'unknown'}\n`;
  return header + stringify(doc);
}

// ── Step counting ─────────────────────────────────────────────────────────────

function countSteps(raw: string): number {
  try {
    const parsed = parseYaml<{ steps?: Record<string, unknown> }>(raw);
    if (!parsed?.steps || typeof parsed.steps !== 'object') return 0;
    return Object.keys(parsed.steps).length;
  } catch {
    return 0;
  }
}

// ── Dependency graph ──────────────────────────────────────────────────────────

function buildDependencyGraph(pipelines: PipelineFile[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const byFilename = new Map<string, string>();
  for (const p of pipelines) byFilename.set(p.name.toLowerCase(), p.relativePath);

  const templateRef = /\btemplate\s*:\s*["']?([^\s"'{},]+)/g;
  const importRef   = /\bimport\s*:\s*["']?([^\s"'{},]+)/g;

  for (const p of pipelines) {
    const matches = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = templateRef.exec(p.rawYaml))) matches.add(m[1]);
    while ((m = importRef.exec(p.rawYaml)))   matches.add(m[1]);

    for (const ref of matches) {
      const target = byFilename.get(path.basename(ref).toLowerCase());
      if (!target || target === p.relativePath) continue;
      edges.push({ from: p.relativePath, to: target, type: 'step-template' });
    }
  }

  return edges;
}
