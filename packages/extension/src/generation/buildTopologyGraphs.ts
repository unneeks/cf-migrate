// Gathers the data behind the topology diagrams (see TopologyDiagram.ts) for one Map Run
// entry: where the pipeline is authored (git repo, if the YAML is tracked, vs. the
// Codefresh account/project it's registered under), whether it's part of a detected
// template group (TemplateGrouping.ts), and — on the GHA side — whether the suggested
// workflow has already been centralised as a reusable workflow (Generate Caller Workflows
// having been run) with concrete caller files referencing it.

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import type { MapRunEntry } from '../scanners/MapRunScanner';
import { MapRunScanner } from '../scanners/MapRunScanner';
import { groupByTemplate, type TemplateGroup } from '../utils/TemplateGrouping';
import type { TopoEdge, TopoGraph, TopoNode } from './TopologyDiagram';

const execFileAsync = promisify(execFile);

async function gitRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function findGroupFor(entry: MapRunEntry): Promise<TemplateGroup | null> {
  const all = await MapRunScanner.scan([entry.workspaceFolder]);
  const { groups } = groupByTemplate(all);
  return groups.find((g) => g.template.filePath === entry.filePath || g.instances.some((i) => i.filePath === entry.filePath)) ?? null;
}

/** Caller files are plain-text `uses: ./<workflow>` references (see ReusableCallerGenerator)
 *  — scanned textually rather than parsed, since we only need to know which caller files
 *  point at which template, not their full structure. */
async function findCallerFiles(dir: string, templateWorkflowBasename: string): Promise<string[]> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const found: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.caller.yml') && !name.endsWith('.caller.yaml')) continue;
    try {
      const content = await fs.readFile(path.join(dir, name), 'utf8');
      if (content.includes(`uses: ./${templateWorkflowBasename}`)) found.push(name);
    } catch { /* skip unreadable */ }
  }
  return found;
}

export async function buildTopologyGraphs(entry: MapRunEntry, root: string): Promise<{ cf: TopoGraph; gha: TopoGraph }> {
  const { meta } = entry.data;
  const remote = await gitRemote(root);
  const repoLabel = remote ? remote.replace(/\.git$/, '').replace(/^git@github\.com:/, 'github.com/').replace(/^https?:\/\//, '') : path.basename(root);

  const group = await findGroupFor(entry);
  const isTemplate = group ? group.template.filePath === entry.filePath : false;
  const sourceTracked = await exists(path.resolve(root, meta.source_file));

  // ── Codefresh topology ──────────────────────────────────────────────────────
  const cfNodes: TopoNode[] = [];
  const cfEdges: TopoEdge[] = [];

  cfNodes.push({ id: 'repo', label: repoLabel, sublabel: sourceTracked ? meta.source_file : '(source not in this repo)', kind: 'repo', rank: 0 });
  cfNodes.push({ id: 'project', label: `CF Project: ${meta.project}`, sublabel: sourceTracked ? 'GitOps — YAML authored in repo, registered to this project' : 'Authored directly in Codefresh (no tracked YAML found)', kind: 'account', rank: 1 });
  cfEdges.push({ from: 'repo', to: 'project', label: sourceTracked ? 'authored in' : 'not found in repo' });

  if (group) {
    const templateMark = isTemplate ? ' ← this pipeline' : '';
    cfNodes.push({ id: 'template', label: `Template: ${group.template.data.meta.pipeline_name}${templateMark}`, sublabel: `${group.instances.length + 1} pipelines share this structure`, kind: 'template', rank: 2 });
    cfEdges.push({ from: 'project', to: 'template', label: 'contains' });
    const allOthers = isTemplate ? group.instances : [group.template, ...group.instances.filter((i) => i.filePath !== entry.filePath)];
    for (const other of allOthers) {
      const id = `inst-${other.filePath}`;
      const mark = other.filePath === entry.filePath ? ' ← this pipeline' : '';
      cfNodes.push({ id, label: `${other.data.meta.pipeline_name}${mark}`, sublabel: `project: ${other.data.meta.project}`, kind: 'instance', rank: 3 });
      cfEdges.push({ from: 'template', to: id, label: 'shared structure' });
    }
  } else {
    cfNodes.push({ id: 'pipeline', label: meta.pipeline_name, sublabel: `${meta.total_steps} steps`, kind: 'pipeline', rank: 2 });
    cfEdges.push({ from: 'project', to: 'pipeline', label: 'contains' });
  }

  // ── GitHub Actions topology ─────────────────────────────────────────────────
  const ghaNodes: TopoNode[] = [];
  const ghaEdges: TopoEdge[] = [];

  const templateEntry = group ? group.template : entry;
  const templateWorkflowAbs = path.resolve(root, templateEntry.data.meta.target_workflow);
  const templateWorkflowBasename = path.basename(templateWorkflowAbs);
  const workflowExists = await exists(templateWorkflowAbs);
  let workflowCallDeclared = false;
  if (workflowExists) {
    const content = await fs.readFile(templateWorkflowAbs, 'utf8');
    workflowCallDeclared = /^\s*workflow_call\s*:/m.test(content);
  }

  ghaNodes.push({ id: 'gha-repo', label: repoLabel, sublabel: workflowExists ? templateEntry.data.meta.target_workflow : '(workflow not generated yet)', kind: 'repo', rank: 0 });

  if (group) {
    ghaNodes.push({
      id: 'reusable',
      label: templateWorkflowBasename,
      sublabel: workflowCallDeclared ? 'Reusable workflow (workflow_call) — centralised' : 'Suggested workflow — workflow_call not yet declared',
      kind: 'reusable',
      rank: 1,
      proposed: !workflowCallDeclared,
    });
    ghaEdges.push({ from: 'gha-repo', to: 'reusable', label: 'contains' });

    const callerFiles = workflowExists ? await findCallerFiles(path.dirname(templateWorkflowAbs), templateWorkflowBasename) : [];
    const instancesToShow = isTemplate ? group.instances : [group.template, ...group.instances.filter((i) => i.filePath !== entry.filePath)];

    for (const inst of instancesToShow) {
      const slug = inst.data.meta.pipeline_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const callerFile = callerFiles.find((f) => f.startsWith(slug));
      const id = `caller-${inst.filePath}`;
      ghaNodes.push({
        id,
        label: callerFile ?? `${slug}.caller.yml`,
        sublabel: `executes in this repo's Actions runs (workflow_call always runs in the CALLER's context)`,
        kind: 'caller',
        rank: 2,
        proposed: !callerFile,
      });
      ghaEdges.push({ from: 'reusable', to: id, label: callerFile ? 'uses:' : 'would use:', proposed: !callerFile });
    }
  } else {
    ghaNodes.push({ id: 'workflow', label: workflowExists ? templateWorkflowBasename : `${path.basename(meta.target_workflow)} (not generated)`, sublabel: 'executes in this repo', kind: 'workflow', rank: 1, proposed: !workflowExists });
    ghaEdges.push({ from: 'gha-repo', to: 'workflow', label: 'contains', proposed: !workflowExists });
  }

  return {
    cf: { title: 'Codefresh — Authoring & Execution', nodes: cfNodes, edges: cfEdges },
    gha: { title: 'GitHub Actions — Authoring & Execution', nodes: ghaNodes, edges: ghaEdges },
  };
}
