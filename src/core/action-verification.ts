import type { BrowserContext, Page } from 'playwright';
import { BrowserRuntimeError, diagnoseActionFailure } from './errors.js';
import type { OperationDiagnostic } from './action-contracts.js';

const DIAGNOSTICS = {
  condition_unmet: 'The requested condition was not observed before the deadline.',
  ambiguous_target: 'The target matches more than one element. Use a unique target or a current element reference.',
  sensitive_value: 'Password values cannot be verified.',
  target_not_editable: 'Value checks require an input, textarea, or select control.',
  action_blocked: 'The runtime refused this action. Read the error message for the cause.',
  url_blocked: 'The credential-origin check blocked this action.',
  session_closed: 'The browser session is unavailable or closed during this operation.',
  session_busy: 'Another browser operation owns this session. Wait for it to finish before retrying.',
  action_timeout: 'The operation did not complete before its deadline.',
  invalid_selector: 'The target selector is invalid. Correct its syntax before retrying.',
} as const;

export function operationDiagnostic(error: unknown): OperationDiagnostic {
  const invalidSelector = error instanceof Error && /while parsing (?:css )?selector|not a valid (?:selector|XPath expression)/i.test(error.message);
  const code = error instanceof BrowserRuntimeError ? error.code : invalidSelector ? 'INVALID_CONFIGURATION' : 'ACTION_FAILED';
  const supplied = error instanceof BrowserRuntimeError ? error.metadata.reason : undefined;
  const reason = typeof supplied === 'string' && Object.hasOwn(DIAGNOSTICS, supplied) ? supplied as keyof typeof DIAGNOSTICS
    : invalidSelector ? 'invalid_selector'
    : code === 'URL_BLOCKED' ? 'url_blocked'
    : code === 'ACTION_BLOCKED' ? 'action_blocked'
    : code === 'INVALID_STATE' && !/reference is stale/i.test(error instanceof Error ? error.message : '') ? 'session_closed'
    : undefined;
  return reason ? { reason, message: DIAGNOSTICS[reason], code } : { ...diagnoseActionFailure(error), code };
}

export function conditionUnmet(): OperationDiagnostic {
  return { reason: 'condition_unmet', message: DIAGNOSTICS.condition_unmet };
}

export function verificationError(reason: keyof typeof DIAGNOSTICS): BrowserRuntimeError {
  return new BrowserRuntimeError(DIAGNOSTICS[reason], 'ACTION_FAILED', { reason });
}

/** A timed-out browser call must terminate before another action can own the session. */
export class ActionBudget {
  readonly deadline: number;
  private cancellation: Promise<void> | undefined;
  private expired = false;

  constructor(
    readonly epoch: number,
    private readonly page: Page,
    private readonly context: BrowserContext,
    timeoutMs: number,
    private readonly assertEpoch: () => void,
    private readonly closeOwner: () => Promise<void>,
  ) {
    this.deadline = Date.now() + timeoutMs;
  }

  get isExpired(): boolean { return this.expired || Date.now() >= this.deadline; }

  remaining(): number {
    this.assertEpoch();
    if (this.isExpired) throw verificationError('action_timeout');
    if (this.page.isClosed()) throw new BrowserRuntimeError('The browser page is closed.', 'INVALID_STATE');
    return Math.max(1, this.deadline - Date.now());
  }

  cancel(): Promise<void> {
    this.cancellation ??= this.closeContext();
    return this.cancellation;
  }

  private async closeContext(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([
        this.context.close().then(() => true, () => false),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 500); }),
      ]);
      // The launcher owns process termination if graceful context shutdown stalls.
      if (!closed) await this.closeOwner();
    } finally { if (timer) clearTimeout(timer); }
  }

  async run<T>(operation: (timeoutMs: number) => Promise<T>): Promise<T> {
    const timeoutMs = this.remaining();
    const timer = setTimeout(() => {
      this.expired = true;
      void this.cancel().catch(() => console.error('BrowserSession: expired operation context cleanup failed.'));
    }, timeoutMs);
    try {
      const result = await operation(timeoutMs);
      this.remaining();
      return result;
    } catch (error) {
      if (this.expired) throw verificationError('action_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
      await this.cancellation;
    }
  }

  async pause(): Promise<void> {
    this.assertEpoch();
    const remaining = this.deadline - Date.now();
    if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    this.assertEpoch();
  }
}
