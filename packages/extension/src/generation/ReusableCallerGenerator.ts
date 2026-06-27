// Generates a GHA reusable-workflow caller for each instance of a detected template group
// (see TemplateGrouping.ts). Two responsibilities, kept deliberately separate because their
// safety characteristics differ:
//
//   1. Declaring `on.workflow_call.inputs` on the TEMPLATE's suggested workflow — additive,
//      safe: we only ever insert a new trigger block, never touch existing job/step bodies.
//      Wiring those inputs into the step bodies (replacing the template's hardcoded values
//      with `${{ inputs.X }}`) is NOT attempted automatically — silently rewriting bodies
//      from a textual value match is exactly the kind of guess that goes wrong quietly, so
//      it's left as an explicit manual-review TODO, consistent with how the rest of this
//      tool flags low-confidence transforms.
//   2. Writing each INSTANCE's caller workflow — this is pure data (the instance's own CF
//      variable values passed as `with:` inputs), so it's fully deterministic and safe to
//      write outright.

import { parseYaml } from '@cf-migrate/core';

export interface RawVariableDiff {
  path: string;
  templateValue: unknown;
  instanceValue: unknown;
}

export interface VariableDiff extends RawVariableDiff {
  /** GHA input name, derived from the differing path (deduped against collisions). */
  name: string;
}

// `cf_export KEY=value` / bare `KEY=value` lines inside freestyle `commands:`/`environment:`/
// `set:` arrays are the other common place CF pipelines carry variables. Matched on both
// sides so e.g. "cf_export ECR_REPO=.../billing-app" vs "...​/notifications-app" surfaces as
// a clean ECR_REPO diff instead of a noisy raw-string diff.
const ASSIGNMENT_RE = /^(?:cf_export\s+)?([A-Za-z][A-Za-z0-9_.]*)=(.*)$/;

/** Recursively compares two parsed CF pipeline `spec` objects, collecting every leaf scalar
 *  that differs at the same structural path. This is the "passing different values to the
 *  variables" signal the user described — read straight from the CF source YAML, not from
 *  any GHA output.
 *
 *  Scoped to `spec` (skips `metadata` — name/project/tags are pipeline identity, not
 *  variables) and to object-keyed scalars (skips free-text array elements like `commands:`
 *  wholesale, except for the `KEY=value` assignment convention above) — anything else is a
 *  shell string where "what differs" can't be named without guessing.
 *
 *  Returns the raw {path, values} pairs WITHOUT assigning input names — when a template has
 *  more than one instance, names must be assigned once over the union of every instance's
 *  diffs (via `assignVariableNames`), otherwise the same path could collide-and-disambiguate
 *  differently per instance and end up with inconsistent input names across callers. */
export function diffPipelineVariablesRaw(templateYaml: string, instanceYaml: string): RawVariableDiff[] {
  const a = safeParse(templateYaml);
  const b = safeParse(instanceYaml);
  const raw: RawVariableDiff[] = [];
  walkDiff(asSpec(a), asSpec(b), [], raw);
  return raw;
}

/** Convenience for the single-instance case — equivalent to
 *  `assignVariableNames(diffPipelineVariablesRaw(...))` zipped back onto the raw diffs. */
export function diffPipelineVariables(templateYaml: string, instanceYaml: string): VariableDiff[] {
  const raw = diffPipelineVariablesRaw(templateYaml, instanceYaml);
  const names = assignVariableNames(raw);
  return raw.map((r) => ({ ...r, name: names.get(r.path) ?? sanitizeInputName(r.path) }));
}

function asSpec(parsed: unknown): unknown {
  return isPlainObject(parsed) ? parsed.spec ?? {} : {};
}

function safeParse(yaml: string): unknown {
  try { return parseYaml(yaml); } catch { return {}; }
}

function walkDiff(
  a: unknown, b: unknown, path: string[],
  out: RawVariableDiff[],
): void {
  if (isScalar(a) && isScalar(b)) {
    if (a !== b) out.push({ path: path.join('.'), templateValue: a, instanceValue: b });
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) walkDiff(a[key], b[key], [...path, key], out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i];
      const bv = b[i];
      if (typeof av === 'string' && typeof bv === 'string') {
        const am = av.match(ASSIGNMENT_RE);
        const bm = bv.match(ASSIGNMENT_RE);
        if (am && bm && am[1] === bm[1]) {
          if (am[2] !== bm[2]) out.push({ path: [...path, am[1]].join('.'), templateValue: am[2], instanceValue: bm[2] });
          continue;
        }
        // Free-text array element with no recognisable KEY=value shape — not nameable, skip.
        continue;
      }
      walkDiff(av, bv, [...path, String(i)], out);
    }
    return;
  }
  // Structural mismatch (e.g. a step present in one but not the other) — not a "variable",
  // skip it. The template-grouping signature already guarantees identical step structure;
  // this only fires for fields the signature doesn't cover (full step bodies).
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Array indices and the generic key that *holds* an array (set/commands/environment/steps/
// build_arguments) carry no useful disambiguating meaning on their own — when two diffs
// collide on name, walk past these to find the nearest real ancestor (typically the step name).
const STRUCTURAL_SEGMENTS = new Set(['steps', 'set', 'commands', 'environment', 'build_arguments', 'tags']);

/** Assigns one GHA input name per distinct path. Must be run over the union of every
 *  instance's raw diffs in a template group (not per-instance) so a given path always gets
 *  the same name regardless of which instance happened to surface it — see
 *  diffPipelineVariablesRaw's doc comment for why that matters. */
export function assignVariableNames(raw: { path: string }[]): Map<string, string> {
  const distinctPaths = [...new Set(raw.map((r) => r.path))];

  const baseNameOf = (path: string): string => {
    const segments = path.split('.');
    return sanitizeInputName(segments[segments.length - 1] ?? path);
  };
  const counts = new Map<string, number>();
  for (const path of distinctPaths) counts.set(baseNameOf(path), (counts.get(baseNameOf(path)) ?? 0) + 1);

  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const path of distinctPaths) {
    const segments = path.split('.');
    const base = baseNameOf(path);
    let name = base;

    if ((counts.get(base) ?? 0) > 1) {
      let ancestor = '';
      for (let i = segments.length - 2; i >= 0; i--) {
        if (/^\d+$/.test(segments[i]) || STRUCTURAL_SEGMENTS.has(segments[i])) continue;
        ancestor = segments[i];
        break;
      }
      name = sanitizeInputName(ancestor ? `${ancestor}_${base}` : base);
    }

    let finalName = name;
    let suffix = 1;
    while (used.has(finalName)) finalName = `${name}_${++suffix}`;
    used.add(finalName);
    result.set(path, finalName);
  }
  return result;
}

function sanitizeInputName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Inserts `workflow_call:` (with the given inputs) into the template's `on:` block if it
 *  isn't already there. Purely textual — finds the `on:` line and its indent level, then
 *  splices in a new sibling key, leaving everything else in the file untouched. */
export function ensureWorkflowCallTrigger(workflowYaml: string, variableNames: string[], defaults: Record<string, unknown>): string {
  if (/^\s*workflow_call\s*:/m.test(workflowYaml) || variableNames.length === 0) return workflowYaml;

  const lines = workflowYaml.split('\n');
  let onLine = -1;
  let onIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)on\s*:\s*$/);
    if (m) { onLine = i; onIndent = m[1].length; break; }
  }
  if (onLine === -1) return workflowYaml; // no `on:` block to extend — leave the file as-is.

  const childIndent = ' '.repeat(onIndent + 2);
  const grandchildIndent = ' '.repeat(onIndent + 4);
  const greatGrandchildIndent = ' '.repeat(onIndent + 6);

  const block = [
    `${childIndent}workflow_call:`,
    `${grandchildIndent}inputs:`,
    ...variableNames.flatMap((name) => [
      `${greatGrandchildIndent}${name}:`,
      `${' '.repeat(onIndent + 8)}description: 'Passed through from the calling instance workflow — TODO: wire into the step(s) below.'`,
      `${' '.repeat(onIndent + 8)}required: false`,
      `${' '.repeat(onIndent + 8)}type: string`,
      `${' '.repeat(onIndent + 8)}default: ${JSON.stringify(String(defaults[name] ?? ''))}`,
    ]),
  ];

  // Insert right after the `on:` line — workflow_call sits alongside push/workflow_dispatch.
  lines.splice(onLine + 1, 0, ...block);
  return lines.join('\n');
}

/** Builds the thin caller workflow for one instance: triggers it the same way the instance
 *  pipeline would be, then calls the template as a reusable workflow with that instance's
 *  own variable values as inputs. */
export function buildCallerWorkflow(opts: {
  instancePipelineName: string;
  templateWorkflowRelPath: string;
  variableValues: Record<string, unknown>;
}): string {
  const { instancePipelineName, templateWorkflowRelPath, variableValues } = opts;
  const lines: string[] = [
    `# Caller workflow for "${instancePipelineName}" — generated by CF Migrate.`,
    `# Calls the shared template as a reusable workflow; only variable values differ per instance.`,
    `name: ${instancePipelineName.split('/').pop() ?? instancePipelineName}`,
    '',
    'on:',
    '  workflow_dispatch: {}',
    '  push:',
    '    branches: [main]',
    '',
    'jobs:',
    '  call-template:',
    `    uses: ./${templateWorkflowRelPath}`,
  ];
  const names = Object.keys(variableValues);
  if (names.length > 0) {
    lines.push('    with:');
    for (const name of names) {
      lines.push(`      ${name}: ${JSON.stringify(String(variableValues[name]))}`);
    }
  }
  lines.push('    secrets: inherit');
  return lines.join('\n') + '\n';
}
