// SPEC §5.3 — Simple in-process event bus.

import type { MigrationPhase } from '../types/session';
import type { DetectedConstruct } from '../types/cf-constructs';
import type { PlanItem } from '../types/plan';
import type { GeneratedWorkflow, ValidationError } from '../types/generation';
import type { PatternCandidate } from '../types/kb';

export type MigrationEvent =
  | { type: 'phase.changed'; from: MigrationPhase; to: MigrationPhase; sessionId: string }
  | { type: 'construct.detected'; construct: DetectedConstruct; sessionId: string }
  | { type: 'plan.item.ready'; item: PlanItem; sessionId: string }
  | { type: 'approval.required'; planId: string; sessionId: string }
  | { type: 'file.generated'; workflow: GeneratedWorkflow; sessionId: string }
  | { type: 'validation.failed'; errors: ValidationError[]; sessionId: string }
  | { type: 'kb.candidate.proposed'; candidate: PatternCandidate; sessionId: string }
  | { type: 'progress'; message: string; percent: number; sessionId: string }
  | { type: 'error'; error: Error; phase: MigrationPhase; sessionId: string };

export type EventHandler = (event: MigrationEvent) => void;

export interface EventBus {
  emit(event: MigrationEvent): void;
  on(type: MigrationEvent['type'], handler: EventHandler): () => void;
  off(type: MigrationEvent['type'], handler: EventHandler): void;
}

export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Map<MigrationEvent['type'], Set<EventHandler>>();

  emit(event: MigrationEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[cf-migrate] event handler threw:', err);
      }
    }
  }

  on(type: MigrationEvent['type'], handler: EventHandler): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  off(type: MigrationEvent['type'], handler: EventHandler): void {
    this.listeners.get(type)?.delete(handler);
  }
}
