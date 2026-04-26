// 18 Codefresh construct detectors. Each detector walks the parsed YAML doc and emits
// `DetectedConstruct` records with line positions. Detectors are pure functions of the
// parsed pipeline — they never call the LLM and never touch the filesystem. The
// DiscoveryAgent and AnalysisAgent compose all detectors together.
//
// Convention: detectors operate on the *parsed* YAML doc (via `parsePipeline`) rather
// than the raw string, so they have access to source positions. The parser is forgiving:
// if a construct is expressed in an unusual form, the detector returns an empty list
// rather than throwing.
import {
  DetectedConstruct,
  CFConstructType,
  tierForConstruct,
  parsePipeline,
  positionOfNode,
  walkPairs,
  scalarKey,
  asMap,
  asSeq,
} from '@cf-migrate/core';
import { isMap, isPair, isScalar, isSeq, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';

export interface DetectorContext {
  /** Absolute pipeline file path — preserved on each DetectedConstruct. */
  filePath: string;
  /** Raw YAML source. */
  source: string;
}

export type DetectorFn = (ctx: DetectorContext) => DetectedConstruct[];

// ────────────────────────────────────────────────────────────────────────────────
// Helpers

function stepsMapFromDoc(doc: ReturnType<typeof parsePipeline>['doc']): YAMLMap | undefined {
  const root = doc.contents;
  if (!isMap(root)) return undefined;
  const steps = root.get('steps', true);
  return isMap(steps) ? steps : undefined;
}

function forEachStep(
  doc: ReturnType<typeof parsePipeline>['doc'],
  visit: (stepName: string, stepNode: YAMLMap, pair: Pair) => void,
): void {
  const steps = stepsMapFromDoc(doc);
  if (!steps) return;
  for (const item of steps.items) {
    if (!isPair(item)) continue;
    const name = scalarKey(item.key);
    const node = asMap(item.value);
    if (!name || !node) continue;
    visit(name, node, item);
  }
}

function getScalarString(map: YAMLMap, key: string): string | undefined {
  const v = map.get(key, true);
  if (isScalar(v) && typeof (v as Scalar).value === 'string') {
    return (v as Scalar).value as string;
  }
  if (typeof v === 'string') return v;
  return undefined;
}

function emit(
  type: CFConstructType,
  ctx: DetectorContext,
  node: unknown,
  lc: ReturnType<typeof parsePipeline>['lineCounter'],
  rawValue: unknown,
  stepName?: string,
): DetectedConstruct {
  const { lineStart, lineEnd } = positionOfNode(node, lc);
  return {
    type,
    filePath: ctx.filePath,
    lineStart,
    lineEnd,
    rawValue,
    stepName,
    confidenceTier: tierForConstruct(type),
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// Individual detectors

/** pipeline.stages — top-level `stages:` list. */
export const detectStages: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const root = doc.contents;
  if (!isMap(root)) return [];
  const stages = root.get('stages', true);
  if (!isSeq(stages)) return [];
  const raw = (stages as YAMLSeq).toJSON();
  return [emit('pipeline.stages', ctx, stages, lineCounter, raw)];
};

/** step.freestyle — step without `type:` or `type: freestyle`. */
export const detectFreestyle: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    const type = getScalarString(node, 'type');
    if (type === undefined || type === 'freestyle') {
      out.push(emit('step.freestyle', ctx, node, lineCounter, node.toJSON(), name));
    }
  });
  return out;
};

/** step.build — `type: build` with image_name/dockerfile/etc. */
export const detectBuild: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    if (getScalarString(node, 'type') === 'build') {
      out.push(emit('step.build', ctx, node, lineCounter, node.toJSON(), name));
    }
  });
  return out;
};

/** step.push — `type: push`. */
export const detectPush: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    if (getScalarString(node, 'type') === 'push') {
      out.push(emit('step.push', ctx, node, lineCounter, node.toJSON(), name));
    }
  });
  return out;
};

/** step.deploy — `type: deploy` or any step with image matching kubectl/helm/aws-cli. */
export const detectDeploy: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    const type = getScalarString(node, 'type');
    const image = getScalarString(node, 'image') ?? '';
    const isDeployType = type === 'deploy' || type === 'helm';
    const isDeployImage = /kubectl|helm|alpine\/k8s|argocd|eksctl|gcloud|aws-cli/.test(image);
    if (isDeployType || (type === undefined && isDeployImage)) {
      out.push(emit('step.deploy', ctx, node, lineCounter, node.toJSON(), name));
    }
  });
  return out;
};

/** step.git-clone — `type: git-clone` or implicit CF clone. */
export const detectGitClone: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    if (getScalarString(node, 'type') === 'git-clone') {
      out.push(emit('step.git-clone', ctx, node, lineCounter, node.toJSON(), name));
    }
  });
  return out;
};

/** step.composition — `type: composition` (docker-compose-style). */
export const detectComposition: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    if (getScalarString(node, 'type') === 'composition') {
      out.push(emit('step.composition', ctx, node, lineCounter, node.toJSON(), name));
    }
  });
  return out;
};

/** step.parallel — `type: parallel` blocks. */
export const detectParallel: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    if (getScalarString(node, 'type') === 'parallel') {
      out.push(emit('step.parallel', ctx, node, lineCounter, node.toJSON(), name));
    }
  });
  return out;
};

/** volumes.shared — usage of `/codefresh/volume` path or `volumes:` shared mount. */
export const detectVolumesShared: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];

  // Explicit `volumes:` declarations on pipeline or step level
  walkPairs(doc, (pair, path) => {
    const key = scalarKey(pair.key);
    if (key === 'volumes' && isSeq(pair.value)) {
      out.push(emit('volumes.shared', ctx, pair.value, lineCounter, (pair.value as YAMLSeq).toJSON()));
    }
  });

  // Scan raw source for /codefresh/volume references (fast text pass)
  const lines = ctx.source.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('/codefresh/volume') || line.includes('${{CF_VOLUME_PATH}}')) {
      out.push({
        type: 'volumes.shared',
        filePath: ctx.filePath,
        lineStart: idx + 1,
        lineEnd: idx + 1,
        rawValue: line.trim(),
        confidenceTier: tierForConstruct('volumes.shared'),
      });
    }
  });

  return dedupeByLine(out);
};

/** cf_export — any occurrence of `cf_export VAR=...` in a commands block. */
export const detectCfExport: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    const commands = node.get('commands', true);
    if (!isSeq(commands)) return;
    for (const cmd of (commands as YAMLSeq).items) {
      if (!isScalar(cmd)) continue;
      const val = (cmd as Scalar).value;
      if (typeof val !== 'string') continue;
      if (/\bcf_export\b/.test(val)) {
        out.push(emit('cf_export', ctx, cmd, lineCounter, val, name));
      }
    }
  });
  return out;
};

/** step.when — any `when:` clause on a step. */
export const detectWhen: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    const when = node.get('when', true);
    if (when !== undefined && isMap(when)) {
      out.push(emit('step.when', ctx, when, lineCounter, (when as YAMLMap).toJSON(), name));
    }
  });
  return out;
};

/** triggers — references to `${{CF_BRANCH}}`, `${{CF_BUILD_TRIGGER}}` etc. Trigger defs
 *  themselves usually live in the Pipeline spec (not codefresh.yml), so detection here
 *  is best-effort via variable usage. */
export const detectTriggers: DetectorFn = (ctx) => {
  const out: DetectedConstruct[] = [];
  const lines = ctx.source.split('\n');
  const pattern = /\$\{\{\s*CF_(BRANCH|BUILD_TRIGGER|BUILD_INITIATOR|COMMIT|PULL_REQUEST|TAG)\s*\}\}/;
  lines.forEach((line, idx) => {
    if (pattern.test(line)) {
      out.push({
        type: 'triggers',
        filePath: ctx.filePath,
        lineStart: idx + 1,
        lineEnd: idx + 1,
        rawValue: line.trim(),
        confidenceTier: tierForConstruct('triggers'),
      });
    }
  });
  return out;
};

/** step.retry — step-level `retry:` block. */
export const detectRetry: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    const retry = node.get('retry', true);
    if (retry !== undefined && (isMap(retry) || isScalar(retry))) {
      const raw = isMap(retry) ? (retry as YAMLMap).toJSON() : (retry as Scalar).value;
      out.push(emit('step.retry', ctx, retry, lineCounter, raw, name));
    }
  });
  return out;
};

/** step.hooks — top-level `hooks:` or step-level `hooks:` (on_success/on_fail/on_finish). */
export const detectHooks: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];

  const root = doc.contents;
  if (isMap(root)) {
    const hooks = root.get('hooks', true);
    if (isMap(hooks)) {
      out.push(emit('step.hooks', ctx, hooks, lineCounter, (hooks as YAMLMap).toJSON()));
    }
  }
  forEachStep(doc, (name, node) => {
    const hooks = node.get('hooks', true);
    if (isMap(hooks)) {
      out.push(emit('step.hooks', ctx, hooks, lineCounter, (hooks as YAMLMap).toJSON(), name));
    }
  });
  return out;
};

/** spec.contexts — references to CF contexts. Most often lives outside codefresh.yml,
 *  but sometimes `contexts:` is declared in the file. Also flags any `${{secrets.*}}`
 *  reference as a secret-bearing context mentioned in-file. */
export const detectSpecContexts: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];

  const root = doc.contents;
  if (isMap(root)) {
    const contexts = root.get('contexts', true);
    if (isSeq(contexts)) {
      out.push(emit('spec.contexts', ctx, contexts, lineCounter, (contexts as YAMLSeq).toJSON()));
    }
  }
  // Inline references — AWS_ACCESS_KEY_ID / DOCKER_PASSWORD / SA_JSON etc.
  const lines = ctx.source.split('\n');
  const secretHint = /\b(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|DOCKER_PASSWORD|GCLOUD_SA_JSON|SA_JSON|KUBECONFIG|NPM_TOKEN|SLACK_WEBHOOK)\b/;
  lines.forEach((line, idx) => {
    if (secretHint.test(line)) {
      out.push({
        type: 'spec.contexts',
        filePath: ctx.filePath,
        lineStart: idx + 1,
        lineEnd: idx + 1,
        rawValue: line.trim(),
        confidenceTier: tierForConstruct('spec.contexts'),
      });
    }
  });

  return dedupeByLine(out);
};

/** plugin — step using a CF plugin image (codefresh/cfstep-* or codefreshplugins/*). */
export const detectPlugin: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  forEachStep(doc, (name, node) => {
    const image = getScalarString(node, 'image') ?? '';
    const type = getScalarString(node, 'type') ?? '';
    if (/^(codefresh\/cfstep-|codefreshplugins\/|codefresh-contrib\/)/.test(image) || /^[a-z]+$/.test(type) && type.length > 0 && !['freestyle','build','push','deploy','git-clone','composition','parallel','helm','approval'].includes(type)) {
      out.push(emit('plugin', ctx, node, lineCounter, { image, type }, name));
    }
  });
  return out;
};

/** fail_fast — any `fail_fast:` on step or pipeline. */
export const detectFailFast: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  walkPairs(doc, (pair) => {
    if (scalarKey(pair.key) === 'fail_fast') {
      const raw = isScalar(pair.value) ? (pair.value as Scalar).value : pair.value;
      out.push(emit('fail_fast', ctx, pair.value, lineCounter, raw));
    }
  });
  return out;
};

/** noCache — build step with `no_cache: true`. */
export const detectNoCache: DetectorFn = (ctx) => {
  const { doc, lineCounter } = parsePipeline(ctx.source);
  const out: DetectedConstruct[] = [];
  walkPairs(doc, (pair) => {
    const k = scalarKey(pair.key);
    if ((k === 'no_cache' || k === 'no_cf_cache') && isScalar(pair.value)) {
      out.push(emit('noCache', ctx, pair.value, lineCounter, (pair.value as Scalar).value));
    }
  });
  return out;
};

// ────────────────────────────────────────────────────────────────────────────────

function dedupeByLine(list: DetectedConstruct[]): DetectedConstruct[] {
  const seen = new Set<string>();
  const out: DetectedConstruct[] = [];
  for (const c of list) {
    const k = `${c.type}:${c.filePath}:${c.lineStart}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** All 18 detectors, keyed by construct type. */
export const ALL_DETECTORS: Record<CFConstructType, DetectorFn> = {
  'pipeline.stages': detectStages,
  'step.freestyle': detectFreestyle,
  'step.build': detectBuild,
  'step.push': detectPush,
  'step.deploy': detectDeploy,
  'step.git-clone': detectGitClone,
  'step.composition': detectComposition,
  'step.parallel': detectParallel,
  'volumes.shared': detectVolumesShared,
  'cf_export': detectCfExport,
  'step.when': detectWhen,
  'triggers': detectTriggers,
  'step.retry': detectRetry,
  'step.hooks': detectHooks,
  'spec.contexts': detectSpecContexts,
  'plugin': detectPlugin,
  'fail_fast': detectFailFast,
  'noCache': detectNoCache,
};

/** Run every detector and return all constructs found. */
export function detectAllConstructs(ctx: DetectorContext): DetectedConstruct[] {
  const out: DetectedConstruct[] = [];
  for (const type of Object.keys(ALL_DETECTORS) as CFConstructType[]) {
    try {
      out.push(...ALL_DETECTORS[type](ctx));
    } catch {
      // A faulty detector must not break the rest of the analysis.
    }
  }
  return out;
}
