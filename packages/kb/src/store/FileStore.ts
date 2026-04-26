// SPEC §12.1 — KB file storage.
//
// Layout:
//   {kbPath}/snippets/{id}.md
//   {kbPath}/patterns/{id}.md
//   {kbPath}/templates/{id}.md
//   {kbPath}/manifest.json
//   {kbPath}/embeddings.json     (optional; lazily populated)
//
// Each markdown file has YAML frontmatter (all KBItem fields except `content`) and the
// body (i.e. `content`). We re-index the manifest on every write.

import * as path from 'path';
import * as fsp from 'fs/promises';

import {
  ensureDir,
  exists,
  readJson,
  writeJson,
  uuid,
  KBItemNotFoundError,
  type KBItem,
  type KBItemType,
} from '@cf-migrate/core';

import { parseFrontmatter, stringifyFrontmatter } from './Frontmatter';

export interface Manifest {
  version: number;
  updatedAt: string;
  items: Array<Omit<KBItem, 'content'>>;
}

export class FileKBStore {
  constructor(private readonly root: string) {}

  get rootDir(): string {
    return this.root;
  }

  async list(): Promise<KBItem[]> {
    const out: KBItem[] = [];
    for (const type of ['snippet', 'pattern', 'template'] as const) {
      const dir = path.join(this.root, `${type}s`);
      if (!(await exists(dir))) continue;
      const entries = await fsp.readdir(dir);
      for (const file of entries) {
        if (!file.endsWith('.md')) continue;
        const item = await this.readFile(path.join(dir, file));
        if (item) out.push(item);
      }
    }
    return out;
  }

  async get(id: string): Promise<KBItem | null> {
    for (const type of ['snippet', 'pattern', 'template'] as const) {
      const file = path.join(this.root, `${type}s`, `${id}.md`);
      if (await exists(file)) return this.readFile(file);
    }
    return null;
  }

  async create(input: Omit<KBItem, 'id' | 'usageCount' | 'lastUpdated'>): Promise<KBItem> {
    const id = uuid();
    const item: KBItem = {
      ...input,
      id,
      usageCount: 0,
      lastUpdated: new Date(),
    };
    await this.writeItem(item);
    await this.rebuildManifest();
    return item;
  }

  async upsertWithId(item: KBItem): Promise<KBItem> {
    await this.writeItem(item);
    await this.rebuildManifest();
    return item;
  }

  async update(id: string, updates: Partial<KBItem>): Promise<KBItem> {
    const existing = await this.get(id);
    if (!existing) throw new KBItemNotFoundError(id);
    const next: KBItem = { ...existing, ...updates, id, lastUpdated: new Date() };
    // Type change → move files.
    if (updates.type && updates.type !== existing.type) {
      await this.delete(id);
    }
    await this.writeItem(next);
    await this.rebuildManifest();
    return next;
  }

  async delete(id: string): Promise<void> {
    for (const type of ['snippet', 'pattern', 'template'] as const) {
      const file = path.join(this.root, `${type}s`, `${id}.md`);
      try {
        await fsp.rm(file);
      } catch {
        /* ignore */
      }
    }
    await this.rebuildManifest();
  }

  async recordUsage(id: string): Promise<void> {
    const item = await this.get(id);
    if (!item) return;
    item.usageCount += 1;
    await this.writeItem(item);
  }

  async rebuildManifest(): Promise<Manifest> {
    const items = (await this.list()).map(({ content: _content, ...rest }) => rest);
    const manifest: Manifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      items,
    };
    await writeJson(path.join(this.root, 'manifest.json'), manifest);
    return manifest;
  }

  async readManifest(): Promise<Manifest | null> {
    return readJson<Manifest>(path.join(this.root, 'manifest.json'));
  }

  private fileFor(item: Pick<KBItem, 'id' | 'type'>): string {
    return path.join(this.root, `${item.type}s`, `${item.id}.md`);
  }

  private async writeItem(item: KBItem): Promise<void> {
    const file = this.fileFor(item);
    await ensureDir(path.dirname(file));
    const { content, ...frontmatter } = item;
    const serialisable = {
      ...frontmatter,
      lastUpdated:
        frontmatter.lastUpdated instanceof Date
          ? frontmatter.lastUpdated.toISOString()
          : frontmatter.lastUpdated,
    };
    const raw = stringifyFrontmatter(serialisable, content);
    await fsp.writeFile(file, raw, 'utf8');
  }

  private async readFile(file: string): Promise<KBItem | null> {
    const raw = await fsp.readFile(file, 'utf8');
    const { data, body } = parseFrontmatter<Omit<KBItem, 'content'> & { lastUpdated: string | Date }>(raw);
    if (!data || !data.id || !data.type) return null;
    return {
      ...data,
      lastUpdated: new Date(data.lastUpdated),
      content: body.trim(),
    } as KBItem;
  }

  /** Filter all KB items by construct type — used during planning for pre-selection. */
  async filterByConstructTypes(types: string[]): Promise<KBItem[]> {
    const set = new Set(types);
    const all = await this.list();
    return all.filter((item) => item.cfConstructs.some((c) => set.has(c)));
  }

  /** Filter by KB item type (snippet/pattern/template). */
  async filterByItemType(type: KBItemType): Promise<KBItem[]> {
    const all = await this.list();
    return all.filter((i) => i.type === type);
  }
}
