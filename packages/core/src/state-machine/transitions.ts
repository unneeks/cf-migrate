// SPEC §5.2 — Phase transition rules.

import type { MigrationPhase, SessionContext } from '../types/session';

export const TRANSITIONS: Record<MigrationPhase, MigrationPhase[]> = {
  idle: ['discovered', 'failed'],
  discovered: ['analysing', 'failed'],
  analysing: ['analysed', 'failed'],
  analysed: ['planning', 'analysing', 'failed'],
  planning: ['planned', 'failed'],
  planned: ['awaiting-approval', 'planning', 'failed'],
  'awaiting-approval': ['approved', 'planned', 'analysed', 'failed'],
  approved: ['generating', 'failed'],
  generating: ['generated', 'failed'],
  generated: ['validating', 'failed'],
  validating: ['complete', 'generated', 'failed'],
  complete: ['analysed', 'failed'],
  failed: ['idle'],
};

export function isTransitionAllowed(
  session: SessionContext,
  to: MigrationPhase,
): { ok: boolean; reason?: string } {
  const allowed = TRANSITIONS[session.phase] ?? [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: `${session.phase} → ${to} is not a permitted transition`,
    };
  }
  // Guard: awaiting-approval → approved requires an explicit approved plan state.
  if (to === 'approved') {
    const state = session.migrationPlan?.approvalState;
    if (!state) return { ok: false, reason: 'No migration plan present' };
    if (state.status !== 'approved') {
      return {
        ok: false,
        reason: `Approval gate not cleared (status=${state.status}, pending=${state.pendingCount})`,
      };
    }
  }
  // Guard: approved → generating requires a plan with status=approved.
  if (to === 'generating') {
    const state = session.migrationPlan?.approvalState;
    if (state?.status !== 'approved') {
      return { ok: false, reason: 'Plan is not in approved state' };
    }
  }
  return { ok: true };
}
