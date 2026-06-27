// "Generate Caller Workflows" — invoked on a template-group node in the Map Run tree.
// For the detected template + its instances (see TemplateGrouping.ts):
//   1. Declares `on.workflow_call.inputs` on the template's suggested workflow (additive,
//      safe — see ReusableCallerGenerator.ts for why body-rewriting isn't attempted).
//   2. Writes one thin caller workflow per instance, each `uses:`-ing the template and
//      passing that instance's own CF variable values as `with:` inputs.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

import type { TemplateGroup } from '../utils/TemplateGrouping';
import {
  assignVariableNames,
  buildCallerWorkflow,
  diffPipelineVariablesRaw,
  ensureWorkflowCallTrigger,
  type RawVariableDiff,
} from '../generation/ReusableCallerGenerator';
import { logger } from '../services/Logger';

export async function runGenerateCallerWorkflows(group: TemplateGroup): Promise<void> {
  const root = group.template.workspaceFolder.uri.fsPath;
  const templateMeta = group.template.data.meta;

  const templateSourcePath = path.resolve(root, templateMeta.source_file);
  const templateWorkflowPath = path.resolve(root, templateMeta.target_workflow);

  let templateSourceYaml: string;
  let templateWorkflowYaml: string;
  try {
    [templateSourceYaml, templateWorkflowYaml] = await Promise.all([
      fs.readFile(templateSourcePath, 'utf8'),
      fs.readFile(templateWorkflowPath, 'utf8'),
    ]);
  } catch (err) {
    logger.error(`Generate Caller Workflows: could not read template files for "${templateMeta.pipeline_name}"`, err);
    void vscode.window.showErrorMessage(`Generate Caller Workflows: could not read template files: ${String(err)}`, 'Show Logs').then((c) => { if (c) logger.show(); });
    return;
  }

  // Diff each instance's CF source against the template's to find which variables it
  // overrides — this is read straight from the pipeline YAML, not guessed from GHA output.
  // Names are assigned once over the union of every instance's diffs (not per-instance) so
  // the same path always gets the same input name across all callers — see
  // diffPipelineVariablesRaw's doc comment.
  const perInstanceDiffs = new Map<string, RawVariableDiff[]>();
  for (const instance of group.instances) {
    const instanceSourcePath = path.resolve(root, instance.data.meta.source_file);
    try {
      const instanceSourceYaml = await fs.readFile(instanceSourcePath, 'utf8');
      perInstanceDiffs.set(instance.filePath, diffPipelineVariablesRaw(templateSourceYaml, instanceSourceYaml));
    } catch (err) {
      logger.warn(`Generate Caller Workflows: skipping ${instance.data.meta.pipeline_name} — could not read its source file`, err);
      void vscode.window.showWarningMessage(
        `Generate Caller Workflows: skipping ${instance.data.meta.pipeline_name} — could not read its source file: ${String(err)}`,
      );
    }
  }

  const allDiffs = [...perInstanceDiffs.values()].flat();
  const namesByPath = assignVariableNames(allDiffs);
  const variableNames = [...new Set(namesByPath.values())];
  if (variableNames.length === 0) {
    logger.warn(
      `Generate Caller Workflows: detected 0 differing variables between "${templateMeta.pipeline_name}" and its instances — ` +
      `callers will have no with: inputs. This usually means the instances' CF YAML differs only in free-text shell ` +
      `commands or array elements, which diffPipelineVariables intentionally doesn't surface as named inputs.`,
    );
  }
  const defaults: Record<string, unknown> = {};
  for (const d of allDiffs) {
    const name = namesByPath.get(d.path)!;
    if (!(name in defaults)) defaults[name] = d.templateValue;
  }

  const updatedTemplateWorkflow = ensureWorkflowCallTrigger(templateWorkflowYaml, variableNames, defaults);
  let templateChanged = false;
  if (updatedTemplateWorkflow !== templateWorkflowYaml) {
    await fs.writeFile(templateWorkflowPath, updatedTemplateWorkflow, 'utf8');
    templateChanged = true;
  }

  const callerDir = path.dirname(templateWorkflowPath);
  const written: string[] = [];
  for (const instance of group.instances) {
    const diffs = perInstanceDiffs.get(instance.filePath) ?? [];
    const variableValues: Record<string, unknown> = {};
    for (const d of diffs) variableValues[namesByPath.get(d.path)!] = d.instanceValue;

    const callerFilename = `${slug(instance.data.meta.pipeline_name)}.caller.yml`;
    const callerPath = path.join(callerDir, callerFilename);
    const callerYaml = buildCallerWorkflow({
      instancePipelineName: instance.data.meta.pipeline_name,
      templateWorkflowRelPath: path.basename(templateWorkflowPath),
      variableValues,
    });
    await fs.writeFile(callerPath, callerYaml, 'utf8');
    written.push(path.relative(root, callerPath));
  }

  const summary = [
    templateChanged
      ? `Added a workflow_call trigger with ${variableNames.length} input(s) to ${path.relative(root, templateWorkflowPath)}.`
      : `Template workflow already had a workflow_call trigger — left it as-is.`,
    `Wrote ${written.length} caller workflow(s): ${written.join(', ')}.`,
  ].join(' ');
  void vscode.window.showInformationMessage(`CF Migrate: ${summary}`);
}

function slug(pipelineName: string): string {
  return pipelineName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
