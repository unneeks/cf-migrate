// SPEC §4.8 — Append-only ledger.

export type LedgerEventType =
  | 'discovery.scan'
  | 'analysis.started'
  | 'analysis.completed'
  | 'plan.generated'
  | 'plan.item.approved'
  | 'plan.item.modified'
  | 'plan.item.rejected'
  | 'plan.approved'
  | 'plan.rejected'
  | 'generation.started'
  | 'generation.completed'
  | 'file.written'
  | 'validation.completed'
  | 'llm.call'
  | 'kb.item.created'
  | 'kb.item.updated'
  | 'kb.pattern.candidate.proposed'
  | 'kb.pattern.candidate.promoted'
  | 'error';

export interface LedgerEvent {
  id: string;
  timestamp: Date;
  type: LedgerEventType;
  pipelinePath?: string;
  actor: string;
  payload: Record<string, unknown>;
  previousHash?: string;
  hash?: string;
}
