// Detects when multiple map runs are structurally identical — i.e. the pipelines they came
// from are instances of the same shared Codefresh template, differing only in variable
// values (image names, namespaces, replica counts, etc.), not in step structure.
//
// Detection works purely from data already in *.map.json: two map runs sharing the same
// mapping_source and the same ordered sequence of (cf_step, cf_type, cf_stage, gha_job,
// gha_step, rule_id, action) are the same template applied twice. No changes to discovery,
// the core MapRunFile schema, or the agents pipeline are needed for this — it's a read-only
// view computed over what's already on disk.

import type { MapRunEntry } from '../scanners/MapRunScanner';

export interface TemplateGroup {
  signature: string;
  /** The representative entry whose mapping defines the shared structure. Picked
   *  deterministically (lowest source_file path) so re-scans don't reshuffle the tree. */
  template: MapRunEntry;
  /** Other entries sharing the same structural signature — variable-value instances. */
  instances: MapRunEntry[];
}

export interface GroupedEntries {
  groups: TemplateGroup[];
  standalone: MapRunEntry[];
}

export function groupByTemplate(entries: MapRunEntry[]): GroupedEntries {
  const bySignature = new Map<string, MapRunEntry[]>();
  for (const entry of entries) {
    const sig = structuralSignature(entry);
    const arr = bySignature.get(sig) ?? [];
    arr.push(entry);
    bySignature.set(sig, arr);
  }

  const groups: TemplateGroup[] = [];
  const standalone: MapRunEntry[] = [];

  for (const [signature, group] of bySignature) {
    if (group.length < 2) {
      standalone.push(...group);
      continue;
    }
    const sorted = [...group].sort((a, b) =>
      a.data.meta.source_file.localeCompare(b.data.meta.source_file),
    );
    groups.push({ signature, template: sorted[0], instances: sorted.slice(1) });
  }

  return { groups, standalone };
}

function structuralSignature(entry: MapRunEntry): string {
  const { meta, mappings } = entry.data;
  const steps = mappings.map((m) => [
    m.cf_step, m.cf_type, m.cf_stage, m.gha_job, m.gha_step, m.rule_id, m.action,
  ]);
  return JSON.stringify({ mapping_source: meta.mapping_source, steps });
}
