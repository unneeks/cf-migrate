// SPEC §8.1 — Session persistence. Sessions live in
// `{workspacePath}/.cf-migrate/session.json` and expire 7 days after `updatedAt`.

import * as path from 'path';
import * as fsp from 'fs/promises';

import { ensureDir, exists, readJson } from '../utils/files';
import { uuid } from '../utils/uuid';
import type { SessionContext, MigrationPhase } from '../types/session';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionManager {
  create(workspacePath: string): Promise<SessionContext>;
  load(workspacePath: string): Promise<SessionContext | null>;
  save(session: SessionContext): Promise<void>;
  clear(workspacePath: string): Promise<void>;
  isExpired(session: SessionContext): boolean;
}

export class FileSessionManager implements SessionManager {
  private filePath(workspace: string): string {
    return path.join(workspace, '.cf-migrate', 'session.json');
  }

  async create(workspacePath: string): Promise<SessionContext> {
    const now = new Date();
    const session: SessionContext = {
      id: uuid(),
      workspacePath,
      phase: 'idle',
      chatHistory: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + SEVEN_DAYS_MS),
    };
    await this.save(session);
    await this.ensureGitignore(workspacePath);
    return session;
  }

  async load(workspacePath: string): Promise<SessionContext | null> {
    const file = this.filePath(workspacePath);
    if (!(await exists(file))) return null;
    const raw = await readJson<SessionRaw>(file);
    if (!raw) return null;
    const session = rehydrate(raw);
    if (this.isExpired(session)) return null;
    return session;
  }

  async save(session: SessionContext): Promise<void> {
    session.updatedAt = new Date();
    session.expiresAt = new Date(session.updatedAt.getTime() + SEVEN_DAYS_MS);
    const file = this.filePath(session.workspacePath);
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, JSON.stringify(session, null, 2), 'utf8');
  }

  async clear(workspacePath: string): Promise<void> {
    const file = this.filePath(workspacePath);
    try {
      await fsp.rm(file);
    } catch {
      /* ignore */
    }
  }

  isExpired(session: SessionContext): boolean {
    return new Date(session.expiresAt).getTime() < Date.now();
  }

  /** Best-effort add of `.cf-migrate/` to the workspace `.gitignore`. Silent on error. */
  private async ensureGitignore(workspacePath: string): Promise<void> {
    const file = path.join(workspacePath, '.gitignore');
    try {
      let content = '';
      try {
        content = await fsp.readFile(file, 'utf8');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (!content.split('\n').some((l) => l.trim() === '.cf-migrate/' || l.trim() === '.cf-migrate')) {
        const appended = content.endsWith('\n') || content.length === 0 ? content : content + '\n';
        await fsp.writeFile(file, appended + '.cf-migrate/\n', 'utf8');
      }
    } catch {
      /* not a git repo / no write permission — ignore */
    }
  }
}

/** Shape on disk — dates come back as ISO strings. */
interface SessionRaw extends Omit<SessionContext, 'createdAt' | 'updatedAt' | 'expiresAt' | 'chatHistory' | 'activePipeline' | 'inventory' | 'analysisResult' | 'migrationPlan' | 'generationManifest'> {
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  chatHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
  activePipeline?: unknown;
  inventory?: unknown;
  analysisResult?: unknown;
  migrationPlan?: unknown;
  generationManifest?: unknown;
}

function rehydrate(raw: SessionRaw): SessionContext {
  const chatHistory = raw.chatHistory.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    expiresAt: new Date(raw.expiresAt),
    chatHistory,
    // Nested date fields (e.g. inventory.discoveredAt) are rehydrated lazily at usage sites —
    // the planning/generation agents parse them via their own Zod schemas.
    activePipeline: raw.activePipeline as SessionContext['activePipeline'],
    inventory: raw.inventory as SessionContext['inventory'],
    analysisResult: raw.analysisResult as SessionContext['analysisResult'],
    migrationPlan: raw.migrationPlan as SessionContext['migrationPlan'],
    generationManifest: raw.generationManifest as SessionContext['generationManifest'],
    phase: raw.phase as MigrationPhase,
  };
}
