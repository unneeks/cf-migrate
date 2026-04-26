// SPEC §5.6 — KB Manager Agent.
//
// Thin facade over @cf-migrate/kb that the extension's KB commands call into.
// Responsibilities:
//   • Load / index the KB on demand via the LexicalSearch (or any injected KBSearch).
//   • Expose list, get, create, update, delete — preserving frontmatter shape.
//   • Refresh the manifest.json and bump `lastUpdated` / `authors` on write.
//   • Emit ledger events for every mutation so KB changes are auditable.

import {
  CFConstructType,
  KBItem,
  KBSearchResult,
  KBVariable,
  LedgerWriter,
} from '@cf-migrate/core';

import { FileKBStore, KBSearch, LexicalSearch } from '@cf-migrate/kb';

export interface KBManagerAgentOptions {
  store: FileKBStore;
  search?: KBSearch;
  ledger?: LedgerWriter;
  /** Identity to record as the last editor when the user modifies an item. */
  editor?: string;
}

export class KBManagerAgent {
  private readonly store: FileKBStore;
  private readonly search: KBSearch;
  private readonly ledger?: LedgerWriter;
  private readonly editor: string;
  private indexReady = false;

  constructor(opts: KBManagerAgentOptions) {
    this.store = opts.store;
    this.search = opts.search ?? new LexicalSearch();
    this.ledger = opts.ledger;
    this.editor = opts.editor ?? 'user';
  }

  async ensureIndexed(): Promise<void> {
    if (this.indexReady) return;
    const all = await this.store.list();
    await this.search.index(all);
    this.indexReady = true;
  }

  async list(): Promise<KBItem[]> {
    return this.store.list();
  }

  async get(id: string): Promise<KBItem | null> {
    return this.store.get(id);
  }

  async query(text: string, topK = 5): Promise<KBSearchResult[]> {
    await this.ensureIndexed();
    return this.search.search(text, topK);
  }

  async queryByConstructs(types: CFConstructType[], topK = 5): Promise<KBSearchResult[]> {
    await this.ensureIndexed();
    return this.search.searchByConstructTypes(types, topK);
  }

  async create(partial: Omit<KBItem, 'id' | 'lastUpdated'> & { id?: string }): Promise<KBItem> {
    const id = partial.id ?? slugify(partial.title);
    const item: KBItem = {
      ...partial,
      id,
      lastUpdated: new Date(),
      authors: mergeAuthors(partial.authors ?? [], this.editor),
      usageCount: partial.usageCount ?? 0,
      confidence: clampConfidence(partial.confidence ?? 0.75),
      variables: partial.variables ?? [],
    };
    const created = await this.store.upsertWithId(item);
    this.indexReady = false; // force re-index on next query
    await this.ledger?.append('kb.item.created', { id: created.id, type: created.type, editor: this.editor });
    return created;
  }

  async update(id: string, patch: Partial<KBItem>): Promise<KBItem> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error(`KB item not found: ${id}`);
    const merged: KBItem = {
      ...existing,
      ...patch,
      id: existing.id,
      lastUpdated: new Date(),
      authors: mergeAuthors(existing.authors ?? [], this.editor),
    };
    const updated = await this.store.update(merged.id, merged);
    this.indexReady = false;
    await this.ledger?.append('kb.item.updated', { id: updated.id, type: updated.type, editor: this.editor });
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.store.delete(id);
    this.indexReady = false;
    // Deletion is modelled as the final 'update' in the canonical ledger vocabulary.
    await this.ledger?.append('kb.item.updated', { id, editor: this.editor, deleted: true });
  }

  async recordUsage(id: string): Promise<void> {
    await this.store.recordUsage(id);
    // Usage count is a local file-level counter; not recorded as a ledger event to keep
    // the ledger focused on migration-auditable mutations.
  }

  async rebuildManifest(): Promise<void> {
    await this.store.rebuildManifest();
    // Manifest rebuild is a derived-index operation, not a KB mutation — no ledger event.
  }

  /** Validate that every variable declared on a snippet has a default or example so the
   *  generator has a fallback when the SnippetRenderer cannot resolve it. */
  validateVariables(item: KBItem): { name: string; issue: string }[] {
    const issues: { name: string; issue: string }[] = [];
    for (const v of item.variables ?? []) {
      if (!v.required && !('default' in v)) {
        issues.push({ name: v.name, issue: 'Optional variable is missing a default.' });
      }
      if (!v.example && !v.default) {
        issues.push({ name: v.name, issue: 'Variable has neither default nor example — renderer may silently insert {{NAME}}.' });
      }
      if (v.type === 'gha-expression' && !v.example) {
        issues.push({ name: v.name, issue: 'GHA-expression variable should include an example to anchor the renderer.' });
      }
    }
    return issues;
  }
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

function mergeAuthors(existing: string[], editor: string): string[] {
  if (!editor) return existing;
  if (existing.includes(editor)) return existing;
  return [...existing, editor];
}

function clampConfidence(c: number): number {
  if (!Number.isFinite(c)) return 0.5;
  return Math.max(0, Math.min(1, c));
}
