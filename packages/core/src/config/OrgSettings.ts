// SPEC §21 — Organisation settings schema and layered loader.

import * as os from 'os';
import * as path from 'path';

import { z } from 'zod';

import { readJson } from '../utils/files';

export const OrgSettingsSchema = z.object({
  llmProvider: z.enum(['openai', 'anthropic', 'copilot']).default('copilot'),
  llmModel: z.string().default('copilot'),
  llmApiKey: z.string().optional(),

  kbPath: z.string().default(''),
  kbGitUrl: z.string().optional(),
  promptTemplatesPath: z.string().optional(),

  ghaRepoPaths: z.array(z.string()).default([]),
  orgName: z.string().optional(),
  ghToken: z.string().optional(),

  runnerConventions: z
    .object({
      default: z.string().default('ubuntu-latest'),
      build: z.string().optional(),
      deploy: z.string().optional(),
    })
    .default({ default: 'ubuntu-latest' }),

  actionVersionPinning: z
    .enum(['latest-major', 'exact-version', 'sha-pinned'])
    .default('latest-major'),

  namingConventions: z
    .object({
      workflowPrefix: z.string().optional(),
      workflowSuffix: z.string().optional(),
      jobNaming: z.enum(['kebab-case', 'snake_case', 'camelCase']).default('kebab-case'),
    })
    .default({ jobNaming: 'kebab-case' }),

  secretNamingPattern: z.string().optional(),

  dashboard: z
    .object({
      port: z.number().int().default(3456),
      secret: z.string().optional(),
      bindHost: z.string().default('127.0.0.1'),
    })
    .optional(),

  enableHashChain: z.boolean().default(false),
  runActionlint: z.boolean().default(true),
  runSecurityScan: z.boolean().default(true),
  autoIndexOnActivation: z.boolean().default(true),
});

export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

/** Deep-merge that prefers values from `override` over `base` (arrays replaced, not concatenated). */
function merge<T>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  const out = Array.isArray(base) ? [...(base as unknown[])] : { ...(base as object) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v === undefined) continue;
    const current = (base as Record<string, unknown>)[k];
    if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      (out as Record<string, unknown>)[k] = merge(current, v as Record<string, unknown>);
    } else {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out as T;
}

export interface ConfigLoadInput {
  workspacePath: string;
  /** Settings coming from the VSCode workspace configuration; merged with highest priority
   *  short of CLI flags. */
  vscodeSettings?: Partial<OrgSettings>;
  /** Settings coming from CLI flags; highest priority. */
  cliFlags?: Partial<OrgSettings>;
}

export async function loadOrgSettings(input: ConfigLoadInput): Promise<OrgSettings> {
  const defaults = OrgSettingsSchema.parse({});

  const userGlobal =
    (await readJson<Partial<OrgSettings>>(path.join(os.homedir(), '.cf-migrate.json'))) ?? {};

  const workspace =
    (await readJson<Partial<OrgSettings>>(
      path.join(input.workspacePath, '.cf-migrate', 'config.json'),
    )) ?? {};

  const envOverrides: Partial<OrgSettings> = {};
  if (process.env.CF_MIGRATE_LLM_PROVIDER) {
    envOverrides.llmProvider = process.env.CF_MIGRATE_LLM_PROVIDER as OrgSettings['llmProvider'];
  }
  if (process.env.CF_MIGRATE_LLM_MODEL) envOverrides.llmModel = process.env.CF_MIGRATE_LLM_MODEL;
  if (process.env.CF_MIGRATE_LLM_API_KEY) envOverrides.llmApiKey = process.env.CF_MIGRATE_LLM_API_KEY;
  if (process.env.GITHUB_TOKEN) envOverrides.ghToken = process.env.GITHUB_TOKEN;
  if (process.env.CF_MIGRATE_KB_PATH) envOverrides.kbPath = process.env.CF_MIGRATE_KB_PATH;

  const merged = merge(
    merge(
      merge(merge(defaults, userGlobal), workspace),
      merge(envOverrides, input.vscodeSettings),
    ),
    input.cliFlags,
  );

  return OrgSettingsSchema.parse(merged);
}
