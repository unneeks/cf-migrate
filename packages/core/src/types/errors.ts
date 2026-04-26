// SPEC §22.1 — Error hierarchy.

import type { MigrationPhase } from './session';

export class CFMigrateError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'CFMigrateError';
  }
}

export class ApprovalRequiredError extends CFMigrateError {
  constructor() {
    super('Plan must be approved before generation', 'APPROVAL_REQUIRED');
    this.name = 'ApprovalRequiredError';
  }
}

export class LLMSchemaValidationError extends CFMigrateError {
  constructor(public rawResponse: string, public issues: unknown) {
    super('LLM output failed schema validation', 'LLM_SCHEMA_INVALID');
    this.name = 'LLMSchemaValidationError';
  }
}

export class ToolNotAvailableError extends CFMigrateError {
  constructor(tool: string) {
    super(`External tool not available: ${tool}`, 'TOOL_NOT_AVAILABLE');
    this.name = 'ToolNotAvailableError';
  }
}

export class KBItemNotFoundError extends CFMigrateError {
  constructor(id: string) {
    super(`KB item not found: ${id}`, 'KB_ITEM_NOT_FOUND');
    this.name = 'KBItemNotFoundError';
  }
}

export class InvalidTransitionError extends CFMigrateError {
  constructor(from: MigrationPhase, to: MigrationPhase) {
    super(`Cannot transition from ${from} to ${to}`, 'INVALID_TRANSITION');
    this.name = 'InvalidTransitionError';
  }
}

export class LLMProviderUnavailableError extends CFMigrateError {
  constructor(provider: string, reason: string) {
    super(`LLM provider unavailable (${provider}): ${reason}`, 'LLM_PROVIDER_UNAVAILABLE');
    this.name = 'LLMProviderUnavailableError';
  }
}
