export type BrowserErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_STATE'
  | 'URL_BLOCKED'
  | 'ACTION_BLOCKED'
  | 'ACTION_FAILED'
  | 'BROWSER_UNAVAILABLE';

export class BrowserRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: BrowserErrorCode,
    public readonly metadata: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BrowserRuntimeError';
    Error.captureStackTrace?.(this, BrowserRuntimeError);
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ACTION_FAILURE_MESSAGES = {
  target_not_found: 'No matching visible field was found. Inspect the current page and use the field\'s element ref.',
  ambiguous_target: 'More than one visible field matches. Inspect the intended field and use its element ref.',
  target_disabled: 'The control remained disabled. Wait for it to become enabled before retrying.',
  target_not_editable: 'The field is read-only or is not an editable control. Inspect the intended input before retrying.',
  target_hidden: 'The control was not visible. Inspect the current page before retrying.',
  target_detached: 'The control was replaced or detached. Inspect the current page to obtain a fresh element ref.',
  page_closed: 'The browser page closed before the action completed.',
  action_timeout: 'The action did not complete before its deadline. Inspect the current page before retrying.',
  action_failed: 'The browser could not complete the action. Inspect the current control before retrying.',
} as const;

export type ActionFailureReason = keyof typeof ACTION_FAILURE_MESSAGES;

export function actionFailure(reason: ActionFailureReason): { reason: ActionFailureReason; message: string } {
  return { reason, message: ACTION_FAILURE_MESSAGES[reason] };
}

/** Only fixed messages cross the tool boundary; Playwright errors can contain input values and page HTML. */
export function diagnoseActionFailure(error: unknown): ReturnType<typeof actionFailure> {
  const reason = error instanceof BrowserRuntimeError ? error.metadata.reason : undefined;
  if (typeof reason === 'string' && Object.hasOwn(ACTION_FAILURE_MESSAGES, reason)) {
    return actionFailure(reason as ActionFailureReason);
  }
  const message = getErrorMessage(error);
  if (/strict mode violation/i.test(message)) return actionFailure('ambiguous_target');
  if (/element is not enabled/i.test(message)) return actionFailure('target_disabled');
  if (/element is not editable|readonly|read-only|not an <input>/i.test(message)) return actionFailure('target_not_editable');
  if (/element is not visible/i.test(message)) return actionFailure('target_hidden');
  if (/not attached|detached|reference is stale/i.test(message)) return actionFailure('target_detached');
  if (/page.*closed|context.*closed|browser.*closed/i.test(message)) return actionFailure('page_closed');
  if (/timeout .* exceeded|timed out/i.test(message)) return actionFailure('action_timeout');
  return actionFailure('action_failed');
}
