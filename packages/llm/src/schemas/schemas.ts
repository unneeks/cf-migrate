// Zod schemas for all structured LLM outputs. These are the "truth gates" for every
// JSON-mode call — the generation layer never writes a file whose upstream artefacts
// haven't passed these schemas.

import { z } from 'zod';

const CF_CONSTRUCT_TYPES = z.enum([
  'pipeline.stages',
  'step.freestyle',
  'step.build',
  'step.push',
  'step.deploy',
  'step.git-clone',
  'step.composition',
  'step.parallel',
  'volumes.shared',
  'cf_export',
  'step.when',
  'triggers',
  'step.retry',
  'step.hooks',
  'spec.contexts',
  'plugin',
  'fail_fast',
  'noCache',
]);

export const AnalysisResultLLMSchema = z.object({
  intent: z.string().min(1),
  nonObviousObservations: z.array(z.string()).default([]),
  proposedWorkflows: z
    .array(
      z.object({
        name: z.string().min(1),
        filename: z.string().regex(/\.ya?ml$/),
        cfSourceSteps: z.array(z.string()),
        trigger: z.array(z.string()),
        estimatedJobCount: z.number().int().min(1).default(1),
        rationale: z.string().default(''),
      }),
    )
    .min(1),
  rationale: z.string().min(1),
  crossCuttingConcerns: z.array(z.string()).default([]),
  complexityScore: z.number().min(0).max(1),
  constructsRequiringRestructure: z
    .array(
      z.object({
        constructType: CF_CONSTRUCT_TYPES,
        stepName: z.string().optional(),
        reason: z.string(),
      }),
    )
    .default([]),
});

export type AnalysisResultLLM = z.infer<typeof AnalysisResultLLMSchema>;

export const PlanItemLLMSchema = z.object({
  type: z.enum(['structural', 'construct-mapping', 'security', 'docker', 'deploy', 'plugin', 'secret-migration']),
  cfConstructType: CF_CONSTRUCT_TYPES,
  // NOTE: optional rather than .default() because z.ZodSchema<T> in callWithRetry
  // collapses input/output types — defaults would surface as `T | undefined` to callers.
  cfStepName: z.string().optional(),
  targetWorkflow: z.string().optional(),
  ghaDescription: z.string().min(1),
  ghaActionOrPattern: z.string().min(1),
  ghaParameters: z.record(z.string()).optional(),
  rationale: z.string().min(1),
  confidenceScore: z.number().min(0).max(1),
  complexity: z.enum(['low', 'medium', 'high']),
  kbSnippetId: z.string().optional(),
  requiresReview: z.boolean(),
});

export const PlanItemArraySchema = z.object({
  items: z.array(PlanItemLLMSchema).min(1),
});

export type PlanItemLLM = z.infer<typeof PlanItemLLMSchema>;
export type PlanItemArray = z.infer<typeof PlanItemArraySchema>;

export const RecommendationLLMSchema = z.object({
  type: z.enum([
    'structural-dedup',
    'security-oidc',
    'plugin-gap',
    'org-standardisation',
    'action-version',
    'runner-optimisation',
    'reusable-workflow-exists',
  ]),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(['info', 'suggestion', 'warning']),
  actionable: z.boolean(),
});

export const RecommendationArraySchema = z.object({
  recommendations: z.array(RecommendationLLMSchema).default([]),
});

export type RecommendationLLM = z.infer<typeof RecommendationLLMSchema>;

/**
 * The Generation call is YAML-out (not JSON), but we still validate that the post-processed
 * YAML has the shape of a GitHub Actions workflow. Schema check is performed by the
 * ValidationAgent using Ajv against the schemastore JSON Schema.
 */
