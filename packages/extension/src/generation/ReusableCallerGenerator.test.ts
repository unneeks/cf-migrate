import { describe, expect, it } from 'vitest';

import {
  assignVariableNames,
  buildCallerWorkflow,
  diffPipelineVariables,
  diffPipelineVariablesRaw,
  ensureWorkflowCallTrigger,
} from './ReusableCallerGenerator';

const TEMPLATE_YAML = `
version: "1.0"
kind: pipeline
metadata:
  name: BILLING/billing-deployment
  project: BILLING
spec:
  steps:
    set_default_variables:
      type: freestyle
      commands:
        - cf_export ECR_REPO=123.dkr.ecr.amazonaws.com/billing-app
        - cf_export HELM_RELEASE_NAME=billing
    build_docker_image:
      type: build
      image_name: billing-app
    deploy_to_staging:
      type: deploy
      chart_name: charts/billing-app
      release_name: billing-staging
      set:
        - image.tag=\${{IMAGE_TAG}}
        - replicaCount=3
    deploy_to_production:
      type: deploy
      chart_name: charts/billing-app
      release_name: billing-production
      set:
        - image.tag=\${{IMAGE_TAG}}
        - replicaCount=6
`;

const INSTANCE_YAML = `
version: "1.0"
kind: pipeline
metadata:
  name: NOTIFICATIONS/notifications-deployment
  project: NOTIFICATIONS
spec:
  steps:
    set_default_variables:
      type: freestyle
      commands:
        - cf_export ECR_REPO=123.dkr.ecr.amazonaws.com/notifications-app
        - cf_export HELM_RELEASE_NAME=notifications
    build_docker_image:
      type: build
      image_name: notifications-app
    deploy_to_staging:
      type: deploy
      chart_name: charts/notifications-app
      release_name: notifications-staging
      set:
        - image.tag=\${{IMAGE_TAG}}
        - replicaCount=1
    deploy_to_production:
      type: deploy
      chart_name: charts/notifications-app
      release_name: notifications-production
      set:
        - image.tag=\${{IMAGE_TAG}}
        - replicaCount=3
`;

describe('diffPipelineVariables', () => {
  it('finds structured field differences with clean, meaningful names', () => {
    const diffs = diffPipelineVariables(TEMPLATE_YAML, INSTANCE_YAML);
    const byName = Object.fromEntries(diffs.map((d) => [d.name, d]));

    expect(byName.image_name).toMatchObject({ templateValue: 'billing-app', instanceValue: 'notifications-app' });
    expect(byName.ECR_REPO.instanceValue).toBe('123.dkr.ecr.amazonaws.com/notifications-app');
    expect(byName.HELM_RELEASE_NAME).toMatchObject({ templateValue: 'billing', instanceValue: 'notifications' });
  });

  it('disambiguates same-named fields under different steps (staging vs production)', () => {
    const diffs = diffPipelineVariables(TEMPLATE_YAML, INSTANCE_YAML);
    const names = diffs.map((d) => d.name);

    // Bare "chart_name"/"release_name"/"replicaCount" must not appear twice — each
    // occurrence under a different step needs its own disambiguated name.
    expect(names.filter((n) => n === 'chart_name')).toHaveLength(0);
    expect(names).toContain('deploy_to_staging_chart_name');
    expect(names).toContain('deploy_to_production_chart_name');
    expect(names).toContain('deploy_to_staging_release_name');
    expect(names).toContain('deploy_to_production_release_name');
    expect(names).toContain('deploy_to_staging_replicaCount');
    expect(names).toContain('deploy_to_production_replicaCount');

    // No two diffs should ever collide on the final assigned name.
    expect(new Set(names).size).toBe(names.length);
  });

  it('ignores pipeline identity fields (metadata.name/project) — not variables', () => {
    const diffs = diffPipelineVariables(TEMPLATE_YAML, INSTANCE_YAML);
    expect(diffs.some((d) => d.path === 'name' || d.path === 'project')).toBe(false);
  });

  it('does not lose a value to a name collision (regression: replicaCount overwrite bug)', () => {
    const diffs = diffPipelineVariables(TEMPLATE_YAML, INSTANCE_YAML);
    const staging = diffs.find((d) => d.name === 'deploy_to_staging_replicaCount');
    const production = diffs.find((d) => d.name === 'deploy_to_production_replicaCount');
    expect(staging?.instanceValue).toBe('1');
    expect(production?.instanceValue).toBe('3');
  });

  it('returns no diffs for identical input', () => {
    expect(diffPipelineVariables(TEMPLATE_YAML, TEMPLATE_YAML)).toHaveLength(0);
  });
});

describe('assignVariableNames', () => {
  it('assigns the same name to the same path across multiple instances', () => {
    const ravenInstanceYaml = INSTANCE_YAML.replace(/notifications/g, 'raven');
    const rawA = diffPipelineVariablesRaw(TEMPLATE_YAML, INSTANCE_YAML);
    const rawB = diffPipelineVariablesRaw(TEMPLATE_YAML, ravenInstanceYaml);

    // Naming must be computed once over the UNION of every instance's diffs — otherwise the
    // same path could be assigned different names depending on which other paths happened
    // to collide within a single instance's diff list.
    const names = assignVariableNames([...rawA, ...rawB]);

    const stagingReplicaPath = rawA.find((d) => d.path.includes('deploy_to_staging') && d.path.endsWith('replicaCount'))!.path;
    const productionReplicaPath = rawA.find((d) => d.path.includes('deploy_to_production') && d.path.endsWith('replicaCount'))!.path;
    expect(names.get(stagingReplicaPath)).toBe('deploy_to_staging_replicaCount');
    expect(names.get(productionReplicaPath)).toBe('deploy_to_production_replicaCount');
  });
});

describe('ensureWorkflowCallTrigger', () => {
  const baseWorkflow = [
    'name: Service Deployment Template',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo hi',
    '',
  ].join('\n');

  it('inserts a workflow_call trigger with one input per variable name', () => {
    const updated = ensureWorkflowCallTrigger(baseWorkflow, ['IMAGE_TAG', 'NAMESPACE'], {
      IMAGE_TAG: 'latest',
      NAMESPACE: 'staging',
    });
    expect(updated).toContain('workflow_call:');
    expect(updated).toContain('IMAGE_TAG:');
    expect(updated).toContain("default: \"latest\"");
    expect(updated).toContain('NAMESPACE:');
  });

  it('leaves everything below the on: block untouched', () => {
    const updated = ensureWorkflowCallTrigger(baseWorkflow, ['IMAGE_TAG'], { IMAGE_TAG: 'latest' });
    expect(updated).toContain('jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi');
  });

  it('is idempotent — running twice does not duplicate the trigger', () => {
    const once = ensureWorkflowCallTrigger(baseWorkflow, ['IMAGE_TAG'], { IMAGE_TAG: 'latest' });
    const twice = ensureWorkflowCallTrigger(once, ['IMAGE_TAG'], { IMAGE_TAG: 'latest' });
    expect(twice).toBe(once);
    expect(twice.match(/workflow_call:/g)).toHaveLength(1);
  });

  it('does nothing when there are no variables to declare', () => {
    expect(ensureWorkflowCallTrigger(baseWorkflow, [], {})).toBe(baseWorkflow);
  });

  it('leaves the file unchanged when there is no on: block to extend', () => {
    const noTriggers = 'name: weird\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
    expect(ensureWorkflowCallTrigger(noTriggers, ['X'], { X: '1' })).toBe(noTriggers);
  });
});

describe('buildCallerWorkflow', () => {
  it('produces a uses: + with: caller referencing the template path', () => {
    const yaml = buildCallerWorkflow({
      instancePipelineName: 'NOTIFICATIONS/notifications-deployment',
      templateWorkflowRelPath: 'BILLING_billing-deployment.suggested.yml',
      variableValues: { ECR_REPO: '123.dkr.ecr.amazonaws.com/notifications-app' },
    });
    expect(yaml).toContain('uses: ./BILLING_billing-deployment.suggested.yml');
    expect(yaml).toContain('ECR_REPO: "123.dkr.ecr.amazonaws.com/notifications-app"');
    expect(yaml).toContain('secrets: inherit');
  });

  it('omits the with: block entirely when there are no variables', () => {
    const yaml = buildCallerWorkflow({
      instancePipelineName: 'A/a',
      templateWorkflowRelPath: 'template.yml',
      variableValues: {},
    });
    expect(yaml).not.toContain('with:');
  });
});
