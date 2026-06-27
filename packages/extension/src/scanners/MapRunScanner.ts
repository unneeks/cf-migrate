import * as fs from 'fs/promises';
import * as vscode from 'vscode';

import type { MapRunFile } from '@cf-migrate/core';

export interface MapRunEntry {
  filePath: string;
  workspaceFolder: vscode.WorkspaceFolder;
  data: MapRunFile;
}

function isMapRunFile(v: unknown): v is MapRunFile {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['version'] === 'string' &&
    typeof obj['meta'] === 'object' &&
    obj['meta'] !== null &&
    Array.isArray(obj['mappings'])
  );
}

export class MapRunScanner {
  static async scan(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<MapRunEntry[]> {
    const results: MapRunEntry[] = [];

    for (const folder of workspaceFolders) {
      const seen = new Set<string>();
      const uris: vscode.Uri[] = [];
      for (const glob of ['**/*.map.json', '**/*-map.json']) {
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, glob),
          '**/node_modules/**',
        );
        for (const u of found) {
          if (!seen.has(u.fsPath)) { seen.add(u.fsPath); uris.push(u); }
        }
      }

      for (const uri of uris) {
        try {
          const raw = await fs.readFile(uri.fsPath, 'utf8');
          const parsed: unknown = JSON.parse(raw);
          if (isMapRunFile(parsed)) {
            results.push({ filePath: uri.fsPath, workspaceFolder: folder, data: parsed });
          }
        } catch {
          // skip unreadable or malformed files
        }
      }
    }

    results.sort((a, b) => {
      const dateDiff = b.data.meta.generated_at.localeCompare(a.data.meta.generated_at);
      if (dateDiff !== 0) return dateDiff;
      return a.data.meta.pipeline_name.localeCompare(b.data.meta.pipeline_name);
    });

    return results;
  }
}
