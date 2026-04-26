// SPEC §4.6 — Knowledge Base.

import type { CFConstructType } from './cf-constructs';

export type KBItemType = 'snippet' | 'pattern' | 'template';

export interface KBVariable {
  name: string;
  description: string;
  type: 'string' | 'boolean' | 'gha-expression' | 'runner-label' | 'env-name';
  required: boolean;
  default?: string;
  example: string;
}

export interface KBItem {
  id: string;
  title: string;
  type: KBItemType;
  cfConstructs: CFConstructType[];
  ghaConstructs: string[];
  tags: string[];
  confidence: number;
  usageCount: number;
  lastUpdated: Date;
  authors: string[];
  description: string;
  content: string;
  variables?: KBVariable[];
  relatedItems?: string[];
  edgeNotes?: string;
  cfExample?: string;
  ghaExample?: string;
}

export interface KBSearchResult {
  item: KBItem;
  score: number;
  matchedFields: string[];
}

export interface PatternCandidate {
  id: string;
  proposedTitle: string;
  proposedType: KBItemType;
  cfConstructType: CFConstructType;
  sourcePipelinePath: string;
  generatedContent: string;
  proposedAt: Date;
  status: 'pending-review' | 'promoted' | 'dismissed';
}
