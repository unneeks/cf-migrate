// SPEC §13.2 — Fill `{{VARIABLE}}` placeholders in KB snippet bodies.
//
// Resolution order per SPEC:
//   1. Derive from `cfConstructValue` (e.g. image name from build step).
//   2. Org settings (runner labels, environment names).
//   3. Org index (action versions, secret naming patterns).
//   4. Variable's `default` if defined.
//   5. Fall back to literal `{{NAME}}` + report as unresolved — generation LLM fills.

import type { KBItem, KBVariable, OrgWorkflowIndex, OrgSettings } from '@cf-migrate/core';

export interface SnippetRenderContext {
  planItemParameters: Record<string, string>;
  orgSettings: OrgSettings;
  orgIndex: OrgWorkflowIndex;
  cfConstructValue?: unknown;
  /** Additional user-supplied overrides (e.g. from the approval panel). */
  overrides?: Record<string, string>;
}

export interface SnippetRenderResult {
  rendered: string;
  unresolved: string[];
  resolved: Record<string, string>;
}

export class SnippetRenderer {
  render(snippet: KBItem, context: SnippetRenderContext): SnippetRenderResult {
    const values: Record<string, string> = {};
    for (const variable of snippet.variables ?? []) {
      const resolved = this.resolveVariable(variable, context);
      if (resolved !== undefined) values[variable.name] = resolved;
    }

    let body = extractYamlFromMarkdown(snippet.content);
    const unresolved: string[] = [];

    body = body.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name: string) => {
      if (name in values) return values[name];
      unresolved.push(name);
      return match;
    });

    return { rendered: body, unresolved, resolved: values };
  }

  getUnresolved(snippet: KBItem, context: SnippetRenderContext): string[] {
    return this.render(snippet, context).unresolved;
  }

  private resolveVariable(
    v: KBVariable,
    ctx: SnippetRenderContext,
  ): string | undefined {
    if (ctx.overrides?.[v.name]) return ctx.overrides[v.name];
    if (ctx.planItemParameters[v.name]) return ctx.planItemParameters[v.name];

    // 1. Derive from cfConstructValue for well-known variables.
    const derived = deriveFromCFValue(v.name, ctx.cfConstructValue);
    if (derived !== undefined) return derived;

    // 2. Org settings.
    const orgValue = deriveFromOrgSettings(v.name, ctx.orgSettings);
    if (orgValue !== undefined) return orgValue;

    // 3. Org index.
    const indexValue = deriveFromOrgIndex(v.name, ctx.orgIndex);
    if (indexValue !== undefined) return indexValue;

    // 4. Default.
    if (v.default !== undefined) return v.default;

    return undefined;
  }
}

/**
 * Extract the YAML block from a KB markdown body. If there's a fenced ```yaml block,
 * return its contents. Otherwise return the raw body trimmed.
 */
function extractYamlFromMarkdown(body: string): string {
  const fence = body.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/);
  if (fence) return fence[1].trimEnd();
  return body.trim();
}

function deriveFromCFValue(name: string, value: unknown): string | undefined {
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;

  switch (name) {
    case 'IMAGE_NAME':
      return (obj['image_name'] as string) ?? (obj['image'] as string) ?? undefined;
    case 'DOCKERFILE':
      return (obj['dockerfile'] as string) ?? undefined;
    case 'BUILD_CONTEXT':
      return (obj['working_directory'] as string) ?? '.';
    case 'REGISTRY':
      return (obj['registry'] as string) ?? undefined;
    case 'TAG':
      return (obj['tag'] as string) ?? undefined;
  }
  return undefined;
}

function deriveFromOrgSettings(name: string, org: OrgSettings): string | undefined {
  switch (name) {
    case 'RUNNER_LABEL':
    case 'RUNNER':
      return org.runnerConventions.default;
    case 'BUILD_RUNNER':
      return org.runnerConventions.build ?? org.runnerConventions.default;
    case 'DEPLOY_RUNNER':
      return org.runnerConventions.deploy ?? org.runnerConventions.default;
    case 'AWS_REGION':
      return 'us-east-1';
  }
  return undefined;
}

function deriveFromOrgIndex(name: string, index: OrgWorkflowIndex): string | undefined {
  const versionMap = index.actionVersions;
  const versionLookups: Record<string, string> = {
    CHECKOUT_VERSION: 'actions/checkout',
    UPLOAD_ARTIFACT_VERSION: 'actions/upload-artifact',
    DOWNLOAD_ARTIFACT_VERSION: 'actions/download-artifact',
    BUILD_PUSH_VERSION: 'docker/build-push-action',
    SETUP_BUILDX_VERSION: 'docker/setup-buildx-action',
    LOGIN_ACTION_VERSION: 'docker/login-action',
    AWS_CREDS_VERSION: 'aws-actions/configure-aws-credentials',
    GCP_AUTH_VERSION: 'google-github-actions/auth',
  };
  const action = versionLookups[name];
  if (action && versionMap[action]) return versionMap[action];
  return undefined;
}
