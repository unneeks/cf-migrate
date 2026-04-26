// SPEC §5.1 — PhaseCoordinator. Agents are injected so this package stays
// dependency-free; the extension/CLI wires up concrete agent implementations.

import type { MigrationPhase, SessionContext } from '../types/session';
import { InvalidTransitionError } from '../types/errors';
import type { SessionManager } from './SessionManager';
import type { EventBus } from './EventBus';
import { isTransitionAllowed } from './transitions';
import type { LedgerWriter } from '../ledger/Ledger';

export interface PhaseExecutor {
  runDiscovery(session: SessionContext): Promise<SessionContext>;
  runAnalysis(session: SessionContext): Promise<SessionContext>;
  runPlanning(session: SessionContext): Promise<SessionContext>;
  runGeneration(session: SessionContext): Promise<SessionContext>;
  runValidation(session: SessionContext): Promise<SessionContext>;
}

export class PhaseCoordinator {
  constructor(
    private readonly sessions: SessionManager,
    private readonly bus: EventBus,
    private readonly ledger: LedgerWriter,
    private readonly executor: PhaseExecutor,
  ) {}

  canTransition(session: SessionContext, to: MigrationPhase): boolean {
    return isTransitionAllowed(session, to).ok;
  }

  async transition(session: SessionContext, to: MigrationPhase): Promise<SessionContext> {
    const { ok, reason } = isTransitionAllowed(session, to);
    if (!ok) {
      await this.ledger.append('error', { reason, from: session.phase, to });
      throw new InvalidTransitionError(session.phase, to);
    }
    const from = session.phase;
    session.phase = to;
    await this.sessions.save(session);
    this.bus.emit({ type: 'phase.changed', from, to, sessionId: session.id });
    return session;
  }

  /** Run the work for the current phase. Caller transitions via `transition()` first. */
  async executePhase(session: SessionContext): Promise<SessionContext> {
    switch (session.phase) {
      case 'discovered':
        return session; // discovery itself runs *into* this phase
      case 'analysing':
        return this.executor.runAnalysis(session);
      case 'planning':
        return this.executor.runPlanning(session);
      case 'generating':
        return this.executor.runGeneration(session);
      case 'validating':
        return this.executor.runValidation(session);
      default:
        return session;
    }
  }
}
