// SPEC §4.9 — Session context.

import type { PipelineFile, PipelineInventory } from './inventory';
import type { AnalysisResult } from './analysis';
import type { MigrationPlan } from './plan';
import type { GenerationManifest } from './generation';

export type MigrationPhase =
  | 'idle'
  | 'discovered'
  | 'analysing'
  | 'analysed'
  | 'planning'
  | 'planned'
  | 'awaiting-approval'
  | 'approved'
  | 'generating'
  | 'generated'
  | 'validating'
  | 'complete'
  | 'failed';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface SessionContext {
  id: string;
  workspacePath: string;
  activePipeline?: PipelineFile;
  phase: MigrationPhase;
  inventory?: PipelineInventory;
  analysisResult?: AnalysisResult;
  migrationPlan?: MigrationPlan;
  generationManifest?: GenerationManifest;
  chatHistory: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  lastError?: { message: string; phase: MigrationPhase; stack?: string };
}
