import { describe, expect, it } from 'vitest';

import { groupByTemplate } from './TemplateGrouping';
import type { MapRunEntry } from '../scanners/MapRunScanner';

function entry(opts: {
  filePath: string;
  pipeline_name: string;
  mapping_source?: string;
  steps?: { cf_step: string; action: string }[];
}): MapRunEntry {
  const steps = opts.steps ?? [
    { cf_step: 'git_clone', action: 'uses: actions/checkout@v4' },
    { cf_step: 'build', action: 'uses: docker/build-push-action@v5' },
  ];
  return {
    filePath: opts.filePath,
    workspaceFolder: { uri: { fsPath: '/repo' } } as MapRunEntry['workspaceFolder'],
    data: {
      version: '1',
      meta: {
        pipeline_name: opts.pipeline_name,
        pipeline_id: 'id-' + opts.pipeline_name,
        project: opts.pipeline_name.split('/')[0],
        source_file: `testdata/codefresh/${opts.pipeline_name.replace('/', '_')}.yml`,
        mapping_source: opts.mapping_source ?? 'mapping_data/cf_gha_mappings.yaml',
        target_workflow: `testdata/artifacts/mapperruns/${opts.pipeline_name.replace('/', '_')}.suggested.yml`,
        generated_at: '2026-06-27',
        total_steps: steps.length,
        stats: { mapped: steps.length, fallback: 0, manual_review: 0 },
      },
      mappings: steps.map((s, i) => ({
        seq: i + 1,
        cf_step: s.cf_step,
        cf_type: 'freestyle',
        cf_stage: 'build',
        cf_title: s.cf_step,
        gha_job: 'build',
        gha_step: s.cf_step,
        rule_id: 'some-rule',
        action: s.action,
        status: 'mapped' as const,
        confidence: 'high' as const,
        pattern_matched: null,
        rationale: 'because',
      })),
    },
  };
}

describe('groupByTemplate', () => {
  it('groups entries with identical mapping structure into one template + instances', () => {
    const a = entry({ filePath: '/a.map.json', pipeline_name: 'BILLING/billing-deployment' });
    const b = entry({ filePath: '/b.map.json', pipeline_name: 'NOTIFICATIONS/notifications-deployment' });
    const c = entry({ filePath: '/c.map.json', pipeline_name: 'PROD/crm-deployment' });

    const { groups, standalone } = groupByTemplate([c, a, b]);

    expect(standalone).toHaveLength(0);
    expect(groups).toHaveLength(1);
    // Template is picked deterministically by lowest source_file path, independent of input order.
    expect(groups[0].template.data.meta.pipeline_name).toBe('BILLING/billing-deployment');
    expect(groups[0].instances.map((i) => i.data.meta.pipeline_name)).toEqual([
      'NOTIFICATIONS/notifications-deployment',
      'PROD/crm-deployment',
    ]);
  });

  it('treats structurally different pipelines as standalone, not a group', () => {
    const a = entry({ filePath: '/a.map.json', pipeline_name: 'BILLING/billing-deployment' });
    const b = entry({
      filePath: '/b.map.json',
      pipeline_name: 'OTHER/unrelated-pipeline',
      steps: [{ cf_step: 'totally_different_step', action: 'run: echo hi' }],
    });

    const { groups, standalone } = groupByTemplate([a, b]);

    expect(groups).toHaveLength(0);
    expect(standalone).toHaveLength(2);
  });

  it('does not group entries that share steps but use a different mapping_source', () => {
    const a = entry({ filePath: '/a.map.json', pipeline_name: 'BILLING/billing-deployment', mapping_source: 'rules-a.yaml' });
    const b = entry({ filePath: '/b.map.json', pipeline_name: 'PROD/crm-deployment', mapping_source: 'rules-b.yaml' });

    const { groups, standalone } = groupByTemplate([a, b]);

    expect(groups).toHaveLength(0);
    expect(standalone).toHaveLength(2);
  });

  it('a single matching entry alone is standalone, not a one-entry group', () => {
    const a = entry({ filePath: '/a.map.json', pipeline_name: 'BILLING/billing-deployment' });
    const { groups, standalone } = groupByTemplate([a]);
    expect(groups).toHaveLength(0);
    expect(standalone).toEqual([a]);
  });

  it('three-or-more-way groups put every match except the template into instances', () => {
    const a = entry({ filePath: '/z.map.json', pipeline_name: 'Z/z' });
    const b = entry({ filePath: '/a.map.json', pipeline_name: 'A/a' });
    const c = entry({ filePath: '/m.map.json', pipeline_name: 'M/m' });

    const { groups } = groupByTemplate([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0].template.filePath).toBe('/a.map.json');
    expect(groups[0].instances.map((i) => i.filePath)).toEqual(['/m.map.json', '/z.map.json']);
  });
});
