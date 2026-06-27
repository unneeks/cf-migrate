// On-disk cache for Analyse/Plan results, keyed by a content hash of the pipeline's raw
// YAML. Re-running Analyse/Plan on an unchanged pipeline reuses the cached result instead
// of re-invoking the LLM; a `force` flag bypasses the cache and overwrites it.
//
// Lives at `.cf-migrate/analysis-plan-cache.json`, alongside the existing org-index and
// ledger artefacts (see ExtensionServices.loadOrgIndex for the established pattern).

import * as path from 'path';
import * as fs from 'fs/promises';

import { sha256 } from '@cf-migrate/core';
import type { AnalysisResult, MigrationPlan } from '@cf-migrate/core';

interface CacheEntry {
  contentHash: string;
  analysis?: { result: AnalysisResult; at: string };
  plan?: { analysisHash: string; result: MigrationPlan; at: string };
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export function hashPipeline(rawYaml: string): string {
  return sha256(rawYaml);
}

export function hashAnalysis(analysis: AnalysisResult): string {
  return sha256(JSON.stringify(analysis));
}

function cachePath(workspacePath: string): string {
  return path.join(workspacePath, '.cf-migrate', 'analysis-plan-cache.json');
}

async function load(workspacePath: string): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(cachePath(workspacePath), 'utf8');
    return JSON.parse(raw) as CacheFile;
  } catch {
    return { version: 1, entries: {} };
  }
}

async function save(workspacePath: string, cache: CacheFile): Promise<void> {
  const p = cachePath(workspacePath);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cache, null, 2), 'utf8');
}

/** Restore Date fields lost to the JSON round-trip (see analysis.ts / plan.ts for the source of truth). */
function reviveAnalysis(result: AnalysisResult): AnalysisResult {
  return { ...result, analysedAt: new Date(result.analysedAt) };
}

function revivePlan(plan: MigrationPlan): MigrationPlan {
  return {
    ...plan,
    generatedAt: new Date(plan.generatedAt),
    approvalState: {
      ...plan.approvalState,
      approvedAt: plan.approvalState.approvedAt ? new Date(plan.approvalState.approvedAt) : undefined,
    },
    items: plan.items.map((item) => ({
      ...item,
      reviewedAt: item.reviewedAt ? new Date(item.reviewedAt) : undefined,
    })),
  };
}

export interface CachedAnalysis { result: AnalysisResult; at: string }
export interface CachedPlan { result: MigrationPlan; at: string }

export async function getCachedAnalysis(
  workspacePath: string,
  relativePath: string,
  contentHash: string,
): Promise<CachedAnalysis | undefined> {
  const cache = await load(workspacePath);
  const entry = cache.entries[relativePath];
  if (entry?.contentHash !== contentHash || !entry.analysis) return undefined;
  return { result: reviveAnalysis(entry.analysis.result), at: entry.analysis.at };
}

export async function setCachedAnalysis(
  workspacePath: string,
  relativePath: string,
  contentHash: string,
  result: AnalysisResult,
): Promise<void> {
  const cache = await load(workspacePath);
  // A new analysis invalidates any plan cached against the previous one.
  cache.entries[relativePath] = {
    contentHash,
    analysis: { result, at: new Date().toISOString() },
  };
  await save(workspacePath, cache);
}

export async function getCachedPlan(
  workspacePath: string,
  relativePath: string,
  contentHash: string,
  analysisHash: string,
): Promise<CachedPlan | undefined> {
  const cache = await load(workspacePath);
  const entry = cache.entries[relativePath];
  if (entry?.contentHash !== contentHash || entry.plan?.analysisHash !== analysisHash) return undefined;
  return { result: revivePlan(entry.plan.result), at: entry.plan.at };
}

export async function setCachedPlan(
  workspacePath: string,
  relativePath: string,
  contentHash: string,
  analysisHash: string,
  result: MigrationPlan,
): Promise<void> {
  const cache = await load(workspacePath);
  const entry = cache.entries[relativePath] ?? { contentHash };
  entry.contentHash = contentHash;
  entry.plan = { analysisHash, result, at: new Date().toISOString() };
  cache.entries[relativePath] = entry;
  await save(workspacePath, cache);
}
