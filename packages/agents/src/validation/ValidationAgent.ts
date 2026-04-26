// SPEC §5.5 — Validation phase.
//
// Runs four passes over a GeneratedWorkflow:
//   1. YAML parse / GHA schema (structural)     — `validateSchema`
//   2. actionlint pass (if binary available)     — `validateLint`
//   3. Security heuristics (permissions, OIDC,   — `validateSecurity`
//      action pinning, shell injection)
//   4. Semantic completeness vs. the CF plan     — `validateSemantic`
//
// actionlint is invoked via child_process if present. When it's missing, its errors
// are reported but don't fail the overall validation — security and semantic checks
// stay authoritative.

import { spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  AnalysisResult,
  GeneratedWorkflow,
  GenerationManifest,
  LedgerWriter,
  MigrationPlan,
  OrgSettings,
  SecurityIssue,
  ValidationError,
  ValidationResult,
  parseYaml,
  ensureDir,
} from '@cf-migrate/core';

export interface ValidationAgentOptions {
  ledger?: LedgerWriter;
  orgSettings?: OrgSettings;
  /** Skip actionlint (useful in test environments). */
  skipActionlint?: boolean;
}

export class ValidationAgent {
  private readonly ledger?: LedgerWriter;
  private readonly orgSettings?: OrgSettings;
  private readonly skipActionlint: boolean;

  constructor(opts: ValidationAgentOptions = {}) {
    this.ledger = opts.ledger;
    this.orgSettings = opts.orgSettings;
    this.skipActionlint = opts.skipActionlint ?? false;
  }

  async validateAll(
    manifest: GenerationManifest,
    analysis: AnalysisResult,
    plan: MigrationPlan,
  ): Promise<GenerationManifest> {
    const validated: GeneratedWorkflow[] = [];
    for (const wf of manifest.workflows) {
      validated.push({ ...wf, validationResult: await this.validate(wf, analysis, plan) });
    }
    await this.ledger?.append('validation.completed', {
      workflowCount: validated.length,
      passed: validated.every((w) => w.validationResult?.passed),
    });
    return { ...manifest, workflows: validated };
  }

  async validate(
    workflow: GeneratedWorkflow,
    analysis: AnalysisResult,
    plan: MigrationPlan,
  ): Promise<ValidationResult> {
    const schemaErrors = this.validateSchema(workflow);
    const lintErrors = await this.validateLint(workflow);
    const securityIssues = this.validateSecurity(workflow);
    const missingCFConstructs = this.validateSemantic(workflow, analysis, plan);

    const passed =
      schemaErrors.filter((e) => e.severity === 'error').length === 0 &&
      lintErrors.filter((e) => e.severity === 'error').length === 0 &&
      securityIssues.filter((i) => i.severity === 'critical' || i.severity === 'high').length === 0 &&
      missingCFConstructs.length === 0;

    await this.ledger?.append('validation.completed', {
      filename: workflow.filename,
      schemaErrors: schemaErrors.length,
      lintErrors: lintErrors.length,
      securityIssues: securityIssues.length,
      missingCFConstructs: missingCFConstructs.length,
      passed,
    });

    return { passed, schemaErrors, lintErrors, securityIssues, missingCFConstructs };
  }

  // ── Pass 1: structural schema ─────────────────────────────────────────────────

  private validateSchema(workflow: GeneratedWorkflow): ValidationError[] {
    const errors: ValidationError[] = [];
    let parsed: unknown;
    try {
      parsed = parseYaml(workflow.yamlContent);
    } catch (err) {
      errors.push({
        file: workflow.filename,
        message: `YAML parse error: ${(err as Error).message}`,
        severity: 'error',
        ruleId: 'yaml-parse',
      });
      return errors;
    }

    if (!parsed || typeof parsed !== 'object') {
      errors.push({ file: workflow.filename, message: 'Workflow root is not a mapping.', severity: 'error', ruleId: 'root-shape' });
      return errors;
    }

    const root = parsed as Record<string, unknown>;

    // `on:` can sometimes be parsed as the boolean `true` key if unquoted — accept either.
    const hasOnKey = Object.keys(root).some((k) => k === 'on') || 'true' in root || (true as unknown as PropertyKey) in root;
    if (!('on' in root) && !hasOnKey) {
      errors.push({ file: workflow.filename, message: "Missing top-level `on:` block.", severity: 'error', ruleId: 'missing-on' });
    }
    if (!('jobs' in root)) {
      errors.push({ file: workflow.filename, message: "Missing top-level `jobs:` block.", severity: 'error', ruleId: 'missing-jobs' });
      return errors;
    }

    const jobs = root.jobs;
    if (!jobs || typeof jobs !== 'object') {
      errors.push({ file: workflow.filename, message: '`jobs:` is not a mapping.', severity: 'error', ruleId: 'jobs-shape' });
      return errors;
    }

    for (const [id, job] of Object.entries(jobs as Record<string, unknown>)) {
      if (!job || typeof job !== 'object') {
        errors.push({ file: workflow.filename, message: `Job ${id} is not a mapping.`, severity: 'error', ruleId: 'job-shape' });
        continue;
      }
      const jobAny = job as Record<string, unknown>;
      if (!('runs-on' in jobAny) && !('uses' in jobAny)) {
        errors.push({
          file: workflow.filename,
          message: `Job ${id} is missing both 'runs-on' and 'uses'.`,
          severity: 'error',
          ruleId: 'job-missing-runs-on',
        });
      }
      if ('steps' in jobAny) {
        if (!Array.isArray(jobAny.steps)) {
          errors.push({
            file: workflow.filename,
            message: `Job ${id}.steps must be an array.`,
            severity: 'error',
            ruleId: 'steps-shape',
          });
        }
      }
    }
    return errors;
  }

  // ── Pass 2: actionlint ────────────────────────────────────────────────────────

  private async validateLint(workflow: GeneratedWorkflow): Promise<ValidationError[]> {
    if (this.skipActionlint || this.orgSettings?.runActionlint === false) return [];

    try {
      const tmp = path.join(os.tmpdir(), 'cf-migrate-lint-' + Date.now());
      await ensureDir(tmp);
      const file = path.join(tmp, workflow.filename);
      await fsp.writeFile(file, workflow.yamlContent, 'utf8');

      const output = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const proc = spawn('actionlint', ['-no-color', file], { stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('error', () => resolve({ code: -1, stdout: '', stderr: 'spawn-error' }));
        proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });

      await fsp.rm(tmp, { recursive: true, force: true });

      if (output.code === -1) return []; // actionlint not installed — non-fatal
      return parseActionlintOutput(output.stdout, workflow.filename);
    } catch {
      return [];
    }
  }

  // ── Pass 3: security heuristics ───────────────────────────────────────────────

  private validateSecurity(workflow: GeneratedWorkflow): SecurityIssue[] {
    const issues: SecurityIssue[] = [];
    const src = workflow.yamlContent;
    const lines = src.split('\n');

    // 1. Permissions hygiene
    const hasTopLevelPerms = /^permissions\s*:/m.test(src);
    const hasWriteAll = /^permissions\s*:\s*(write-all|\bwrite\b)\s*$/m.test(src);
    if (!hasTopLevelPerms) {
      issues.push({
        type: 'excessive-permissions',
        file: workflow.filename,
        description:
          'No `permissions:` block found. Default GITHUB_TOKEN scope depends on repo settings — explicit least-privilege is strongly preferred.',
        severity: 'medium',
        suggestedFix: 'Add a top-level `permissions: { contents: read }` and widen per-job only as needed.',
      });
    }
    if (hasWriteAll) {
      issues.push({
        type: 'excessive-permissions',
        file: workflow.filename,
        description: '`permissions: write-all` grants the default token full scope. Narrow to the specific scopes used.',
        severity: 'high',
        suggestedFix: 'Replace with an explicit mapping (e.g. `contents: read`, `packages: write`).',
      });
    }

    // 2. Unpinned marketplace actions (uses: owner/name without @sha or @vN)
    const usesRe = /uses:\s*([^\s#@]+)(@([^\s#]+))?/g;
    let m: RegExpExecArray | null;
    while ((m = usesRe.exec(src))) {
      const action = m[1];
      const ref = m[3];
      if (!action.includes('/')) continue; // local (./.github/actions/foo) or reusable (./.github/workflows/foo.yml)
      if (action.startsWith('./')) continue;
      if (!ref) {
        issues.push({
          type: 'unpinned-action',
          file: workflow.filename,
          line: lineOf(lines, m.index),
          description: `Action ${action} is unpinned.`,
          severity: 'high',
          suggestedFix: `Pin ${action} to @vN or a full SHA.`,
        });
      }
    }

    // 3. Shell injection via ${{ github.event.*.* }} in run:
    const injRe = /run\s*:\s*[^\n]*\$\{\{\s*(github\.event\.(?:issue|pull_request|comment)\.[a-z_.]+|github\.head_ref)\s*\}\}/gi;
    while ((m = injRe.exec(src))) {
      issues.push({
        type: 'injection',
        file: workflow.filename,
        line: lineOf(lines, m.index),
        description: `Shell injection risk: interpolating ${m[1]} directly into a \`run:\` body.`,
        severity: 'critical',
        suggestedFix: 'Pass the value through `env:` and reference it as `"$VAR"` inside the shell.',
      });
    }

    // 4. Missing OIDC where cloud creds are used via secrets
    const usesCloudCreds = /\$\{\{\s*secrets\.(AWS_ACCESS_KEY_ID|GOOGLE_CREDENTIALS|AZURE_CREDENTIALS)\s*\}\}/.test(src);
    const hasIdTokenPerm = /id-token\s*:\s*write/.test(src);
    if (usesCloudCreds && !hasIdTokenPerm) {
      issues.push({
        type: 'missing-oidc',
        file: workflow.filename,
        description: 'Workflow uses long-lived cloud credentials but does not request an OIDC id-token.',
        severity: 'high',
        suggestedFix:
          'Add `permissions: { id-token: write }` and replace secret-based auth with `aws-actions/configure-aws-credentials@v4` (or GCP/Azure equivalents).',
      });
    }

    // 5. Secret echo
    if (/echo.*\$\{\{\s*secrets\./.test(src)) {
      issues.push({
        type: 'secret-exposure',
        file: workflow.filename,
        description: 'A `run:` step appears to echo a secret value. GitHub masks secrets but this pattern risks leaking via logs.',
        severity: 'high',
        suggestedFix: 'Never echo secrets. Pass them via `env:` and consume directly without logging.',
      });
    }

    return issues;
  }

  // ── Pass 4: semantic completeness ─────────────────────────────────────────────

  private validateSemantic(workflow: GeneratedWorkflow, analysis: AnalysisResult, plan: MigrationPlan): string[] {
    // Every CF step in the bucket's sourceItems MUST be represented somewhere in the YAML.
    const missing: string[] = [];
    const lower = workflow.yamlContent.toLowerCase();
    const stepNames = plan.items
      .filter((i) => workflow.sourceItems.includes(i.id))
      .map((i) => i.cfConstructRef.constructName)
      .filter(Boolean);

    for (const name of stepNames) {
      const needle = name.toLowerCase();
      // Accept if the step name appears as a job/step name, comment, or `id:`/`name:` match.
      if (!lower.includes(needle)) {
        missing.push(name);
      }
    }

    // Every data-flow edge terminating in a step we emitted must be expressible.
    // Non-strict check: we only flag when a cf_export key is clearly dropped.
    for (const edge of analysis.dataFlowGraph) {
      if (edge.dataType !== 'cf_export') continue;
      if (!stepNames.includes(edge.producerStep)) continue;
      const keyToken = edge.key.toLowerCase();
      if (!lower.includes(keyToken)) {
        missing.push(`cf_export:${edge.key}`);
      }
    }

    return dedupe(missing);
  }
}

function parseActionlintOutput(out: string, filename: string): ValidationError[] {
  const errors: ValidationError[] = [];
  // actionlint emits: <file>:<line>:<col>: <message> [<rule>]
  const re = /^([^:]+):(\d+):(\d+):\s*(.*?)(?:\s+\[([^\]]+)\])?$/;
  for (const raw of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = raw.match(re);
    if (!m) continue;
    errors.push({
      file: filename,
      line: Number(m[2]),
      column: Number(m[3]),
      message: m[4],
      severity: 'error',
      ruleId: m[5],
    });
  }
  return errors;
}

function lineOf(lines: string[], byteOffset: number): number {
  // Approximate: walk lines until we consume byteOffset characters.
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    consumed += lines[i].length + 1; // +1 for newline
    if (consumed > byteOffset) return i + 1;
  }
  return lines.length;
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
