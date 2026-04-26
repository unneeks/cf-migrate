// Lightweight lexical similarity — no model download, works offline, deterministic.
//
// Scoring: TF-IDF over tokens (title + description + tags + cfConstructs + ghaConstructs)
// with a construct-type boost: if the query mentions a construct that's in the item's
// `cfConstructs`, we add +0.4 to the score. Scores are normalised to [0, 1].
//
// This is intentionally a drop-in replacement for the embedding search described in
// §12.3. The `KBSearch` interface exported here is the same one the agents consume;
// swapping to `@xenova/transformers` later is a local change to this file.

import type { KBItem, KBSearchResult, CFConstructType } from '@cf-migrate/core';

export interface KBSearch {
  index(items: KBItem[]): Promise<void>;
  search(query: string, topK: number): Promise<KBSearchResult[]>;
  searchByConstructTypes(types: CFConstructType[], topK: number): Promise<KBSearchResult[]>;
}

interface IndexedItem {
  item: KBItem;
  tokens: Map<string, number>; // token → tf
  cfTypes: Set<string>;
  norm: number; // Euclidean norm of tf-idf vector (recomputed in rebuild)
}

export class LexicalSearch implements KBSearch {
  private items: IndexedItem[] = [];
  private docFreq: Map<string, number> = new Map();

  async index(items: KBItem[]): Promise<void> {
    this.items = items.map((item) => ({
      item,
      tokens: tokenise(textFor(item)),
      cfTypes: new Set(item.cfConstructs),
      norm: 0,
    }));

    this.docFreq = new Map();
    for (const idx of this.items) {
      for (const token of idx.tokens.keys()) {
        this.docFreq.set(token, (this.docFreq.get(token) ?? 0) + 1);
      }
    }

    const N = Math.max(1, this.items.length);
    for (const idx of this.items) {
      let sumSq = 0;
      for (const [token, tf] of idx.tokens) {
        const df = this.docFreq.get(token) ?? 1;
        const idf = Math.log(1 + N / df);
        sumSq += (tf * idf) ** 2;
      }
      idx.norm = Math.sqrt(sumSq) || 1;
    }
  }

  async search(query: string, topK: number): Promise<KBSearchResult[]> {
    if (this.items.length === 0) return [];
    const qTokens = tokenise(query);
    const N = this.items.length;

    let qNormSq = 0;
    for (const [token, tf] of qTokens) {
      const df = this.docFreq.get(token) ?? 0.5;
      const idf = Math.log(1 + N / df);
      qNormSq += (tf * idf) ** 2;
    }
    const qNorm = Math.sqrt(qNormSq) || 1;

    const constructsMentioned = extractConstructMentions(query);

    const results: KBSearchResult[] = [];
    for (const idx of this.items) {
      let dot = 0;
      const matchedFields: string[] = [];
      for (const [token, qtf] of qTokens) {
        const dtf = idx.tokens.get(token);
        if (!dtf) continue;
        const df = this.docFreq.get(token) ?? 1;
        const idf = Math.log(1 + N / df);
        dot += qtf * idf * dtf * idf;
        matchedFields.push(token);
      }
      let score = dot / (qNorm * idx.norm);
      if (constructsMentioned.some((c) => idx.cfTypes.has(c))) {
        score += 0.4;
        matchedFields.push('cfConstruct');
      }
      score = Math.min(1, score);
      if (score > 0) results.push({ item: idx.item, score, matchedFields });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async searchByConstructTypes(
    types: CFConstructType[],
    topK: number,
  ): Promise<KBSearchResult[]> {
    const set = new Set(types);
    const results: KBSearchResult[] = [];
    for (const idx of this.items) {
      const overlap = idx.item.cfConstructs.filter((c) => set.has(c));
      if (overlap.length === 0) continue;
      const score = Math.min(1, 0.5 + 0.1 * overlap.length + 0.05 * idx.item.confidence);
      results.push({ item: idx.item, score, matchedFields: ['cfConstruct', ...overlap] });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

function textFor(item: KBItem): string {
  return [
    item.title,
    item.description,
    item.tags.join(' '),
    item.cfConstructs.join(' '),
    item.ghaConstructs.join(' '),
  ].join(' ');
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'with',
]);

function tokenise(text: string): Map<string, number> {
  const tokens = new Map<string, number>();
  const normalised = text.toLowerCase().replace(/[^a-z0-9._/@\s-]/g, ' ');
  for (const raw of normalised.split(/\s+/)) {
    if (!raw) continue;
    if (STOP_WORDS.has(raw)) continue;
    tokens.set(raw, (tokens.get(raw) ?? 0) + 1);
  }
  return tokens;
}

function extractConstructMentions(query: string): string[] {
  const known = [
    'step.freestyle', 'step.build', 'step.push', 'step.deploy', 'step.git-clone',
    'step.composition', 'step.parallel', 'volumes.shared', 'cf_export',
    'step.when', 'triggers', 'step.retry', 'step.hooks', 'spec.contexts', 'plugin',
    'fail_fast', 'noCache', 'pipeline.stages',
  ];
  const q = query.toLowerCase();
  return known.filter((k) => q.includes(k.toLowerCase()));
}
