// SPEC §18.1 — Append-only audit ledger (JSONL).
//
// One file: `{workspacePath}/.cf-migrate/ledger.jsonl`. Each line is a LedgerEvent JSON
// object. When hash chaining is enabled we set `previousHash` to the hash of the prior
// entry and `hash = sha256(previousHash + JSON.stringify(rest))`.
//
// Design notes:
//   • Writes are synchronous-append with fsync-on-close semantics (fs.appendFile).
//   • Ledger writes never throw to callers — resilience rule in §22.2.
//   • Secrets values must never appear in a payload; callers are responsible for redaction.

import * as fsp from 'fs/promises';
import * as path from 'path';

import { sha256 } from '../utils/hash';
import { uuid } from '../utils/uuid';
import { ensureDir } from '../utils/files';
import type { LedgerEvent, LedgerEventType } from '../types/ledger';

export interface LedgerOptions {
  enableHashChain: boolean;
}

export class LedgerWriter {
  private readonly file: string;
  private lastHash: string | undefined;
  private ready: Promise<void>;

  constructor(
    private readonly workspacePath: string,
    private readonly options: LedgerOptions = { enableHashChain: false },
  ) {
    this.file = path.join(workspacePath, '.cf-migrate', 'ledger.jsonl');
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await ensureDir(path.dirname(this.file));
    // Warm the hash tail for chain continuity.
    if (this.options.enableHashChain) {
      try {
        const raw = await fsp.readFile(this.file, 'utf8');
        const lines = raw.trimEnd().split('\n');
        const last = lines[lines.length - 1];
        if (last) {
          const parsed = JSON.parse(last) as LedgerEvent;
          this.lastHash = parsed.hash;
        }
      } catch {
        // File doesn't exist — fine, we're starting fresh.
      }
    }
  }

  async append(
    type: LedgerEventType,
    payload: Record<string, unknown>,
    opts: { actor?: string; pipelinePath?: string } = {},
  ): Promise<LedgerEvent> {
    try {
      await this.ready;
      const event: LedgerEvent = {
        id: uuid(),
        timestamp: new Date(),
        type,
        pipelinePath: opts.pipelinePath,
        actor: opts.actor ?? 'system',
        payload,
      };
      if (this.options.enableHashChain) {
        event.previousHash = this.lastHash;
        const body = {
          id: event.id,
          timestamp: event.timestamp.toISOString(),
          type: event.type,
          pipelinePath: event.pipelinePath,
          actor: event.actor,
          payload: event.payload,
          previousHash: event.previousHash,
        };
        event.hash = sha256((event.previousHash ?? '') + JSON.stringify(body));
        this.lastHash = event.hash;
      }
      const line = JSON.stringify(event) + '\n';
      await fsp.appendFile(this.file, line, 'utf8');
      return event;
    } catch (err) {
      // Never propagate — per §22.2. Surface via stderr so operators notice.
      // eslint-disable-next-line no-console
      console.error('[cf-migrate] ledger append failed:', err);
      return {
        id: uuid(),
        timestamp: new Date(),
        type,
        actor: opts.actor ?? 'system',
        pipelinePath: opts.pipelinePath,
        payload,
      };
    }
  }
}

export class LedgerReader {
  private readonly file: string;

  constructor(workspacePath: string) {
    this.file = path.join(workspacePath, '.cf-migrate', 'ledger.jsonl');
  }

  async all(): Promise<LedgerEvent[]> {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      return raw
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parsed = JSON.parse(line) as LedgerEvent;
          parsed.timestamp = new Date(parsed.timestamp);
          return parsed;
        });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async query(filter: {
    type?: LedgerEventType;
    pipelinePath?: string;
    sinceIso?: string;
  }): Promise<LedgerEvent[]> {
    const all = await this.all();
    const since = filter.sinceIso ? new Date(filter.sinceIso).getTime() : 0;
    return all.filter((e) => {
      if (filter.type && e.type !== filter.type) return false;
      if (filter.pipelinePath && e.pipelinePath !== filter.pipelinePath) return false;
      if (since && e.timestamp.getTime() < since) return false;
      return true;
    });
  }

  /** Verify the hash chain is intact. Returns the first broken event ID or null. */
  async verifyChain(): Promise<string | null> {
    const events = await this.all();
    let prev: string | undefined;
    for (const event of events) {
      if (!event.hash) continue; // chain not enabled for this row
      const body = {
        id: event.id,
        timestamp: event.timestamp.toISOString(),
        type: event.type,
        pipelinePath: event.pipelinePath,
        actor: event.actor,
        payload: event.payload,
        previousHash: prev,
      };
      const expected = sha256((prev ?? '') + JSON.stringify(body));
      if (expected !== event.hash) return event.id;
      prev = event.hash;
    }
    return null;
  }
}
