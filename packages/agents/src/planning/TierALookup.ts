// SPEC §5.3 — Tier A deterministic lookup table.
//
// Tier A constructs have a one-to-one mapping to a GHA primitive; no LLM call is
// required. The lookup produces a seed PlanItem (without `id` / `sequenceNumber`) that
// the PlanningAgent decorates with the matching KB snippet.

import type { CFConstructType, DetectedConstruct, ConfidenceTier } from '@cf-migrate/core';
import type { PlanItem } from '@cf-migrate/core';

export interface TierAResult {
  type: PlanItem['type'];
  ghaDescription: string;
  ghaActionOrPattern: string;
  ghaParameters: Record<string, string>;
  rationale: string;
  confidenceScore: number;
  complexity: PlanItem['complexity'];
  kbSnippetId?: string;
  requiresReview: boolean;
}

export function tierALookup(c: DetectedConstruct): TierAResult | null {
  switch (c.type) {
    case 'step.git-clone':
      return {
        type: 'construct-mapping',
        ghaDescription: 'Replace CF git-clone step with actions/checkout@v4 + optional dep cache',
        ghaActionOrPattern: 'actions/checkout@v4',
        ghaParameters: { 'fetch-depth': '1' },
        rationale: 'CF git-clone is the canonical equivalent of actions/checkout; deterministic mapping.',
        confidenceScore: 0.98,
        complexity: 'low',
        kbSnippetId: 'checkout-with-cache',
        requiresReview: false,
      };

    case 'step.push': {
      const raw = c.rawValue as { registry?: string; image_name?: string; tags?: string[] };
      return {
        type: 'docker',
        ghaDescription: 'Fold CF push into docker/build-push-action (set push: true)',
        ghaActionOrPattern: 'docker/build-push-action@v5',
        ghaParameters: {
          registry: raw?.registry ?? 'docker.io',
          image_name: raw?.image_name ?? '',
          tags: (raw?.tags ?? []).join(','),
          push: 'true',
        },
        rationale: 'CF push is redundant with build when using docker/build-push-action.',
        confidenceScore: 0.97,
        complexity: 'low',
        kbSnippetId: 'build-push-to-action',
        requiresReview: false,
      };
    }

    case 'step.retry': {
      const raw = c.rawValue as { maxAttempts?: number; delay?: number } | number;
      return {
        type: 'construct-mapping',
        ghaDescription: 'Wrap flaky step in nick-fields/retry@v3',
        ghaActionOrPattern: 'nick-fields/retry@v3',
        ghaParameters: {
          max_attempts: String((typeof raw === 'object' && raw?.maxAttempts) || 3),
          retry_wait_seconds: String((typeof raw === 'object' && raw?.delay) || 15),
          timeout_minutes: '10',
        },
        rationale: 'CF step.retry maps directly to the community retry action.',
        confidenceScore: 0.95,
        complexity: 'low',
        kbSnippetId: 'retry-wrapper',
        requiresReview: false,
      };
    }

    case 'step.hooks':
      return {
        type: 'construct-mapping',
        ghaDescription:
          'Replace CF hooks (on_success / on_fail / on_finish) with a trailing notify job using `if: always()` + `needs.<job>.result`.',
        ghaActionOrPattern: 'if: always()',
        ghaParameters: {},
        rationale: 'Deterministic mapping — CF hook semantics match GHA `if:` expressions.',
        confidenceScore: 0.95,
        complexity: 'medium',
        kbSnippetId: 'hooks-to-always-steps',
        requiresReview: false,
      };

    case 'fail_fast':
      return {
        type: 'construct-mapping',
        ghaDescription: 'Map CF fail_fast onto strategy.fail-fast (matrix) or rely on default job-failure propagation.',
        ghaActionOrPattern: 'strategy.fail-fast',
        ghaParameters: { value: String(c.rawValue ?? true) },
        rationale: 'Direct attribute mapping.',
        confidenceScore: 0.96,
        complexity: 'low',
        requiresReview: false,
      };

    case 'noCache':
      return {
        type: 'docker',
        ghaDescription: 'Translate CF no_cache to `no-cache: true` in docker/build-push-action',
        ghaActionOrPattern: 'docker/build-push-action@v5',
        ghaParameters: { 'no-cache': String(c.rawValue ?? true) },
        rationale: 'Direct attribute mapping.',
        confidenceScore: 0.96,
        complexity: 'low',
        requiresReview: false,
      };

    case 'triggers':
      return {
        type: 'construct-mapping',
        ghaDescription: 'Translate CF triggers into a top-level `on:` block (push / pull_request / schedule / workflow_dispatch).',
        ghaActionOrPattern: 'on',
        ghaParameters: {},
        rationale: 'Direct structural mapping; branch/tag filters transfer to on.push.branches/tags.',
        confidenceScore: 0.95,
        complexity: 'low',
        kbSnippetId: 'triggers-to-on-events',
        requiresReview: false,
      };

    default:
      return null;
  }
}

/** Quick predicate for code that needs to know whether a construct bypasses the LLM. */
export function isTierA(type: CFConstructType): boolean {
  const t = type as CFConstructType;
  return (
    t === 'step.git-clone' ||
    t === 'step.push' ||
    t === 'step.retry' ||
    t === 'step.hooks' ||
    t === 'fail_fast' ||
    t === 'noCache' ||
    t === 'triggers'
  );
}

export function tierLabelFor(type: CFConstructType): ConfidenceTier {
  return isTierA(type) ? 'A' : type === 'volumes.shared' || type === 'cf_export' || type === 'pipeline.stages' ? 'C' : 'B';
}
