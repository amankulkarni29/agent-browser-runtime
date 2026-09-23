import type { BrowserContext, Page } from 'playwright';
import { ActionBudget } from '../../src/core/action-verification.js';
import { BrowserRuntimeError } from '../../src/core/errors.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('action budget owner cleanup', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it.each(['resolves', 'rejects'] as const)(
    'waits for owner termination when context close hangs and the action then %s',
    async (actionOutcome) => {
      const contextClosed = deferred<void>();
      const ownerTerminated = deferred<void>();
      const action = deferred<string>();
      const closeContext = jest.fn(() => contextClosed.promise);
      const closeOwner = jest.fn(async () => {
        await ownerTerminated.promise;
        if (actionOutcome === 'resolves') action.resolve('private-action-result');
        else action.reject(new Error('Browser closed while filling private-input-value'));
      });
      const page = { isClosed: () => false } as Page;
      const context = { close: closeContext } as unknown as BrowserContext;
      const budget = new ActionBudget(1, page, context, 100, () => {}, closeOwner);
      const finished = jest.fn();
      const completion = budget.run(() => action.promise).then(
        (value) => { finished(); return value; },
        (error: unknown) => { finished(); return error; },
      );

      await jest.advanceTimersByTimeAsync(99);
      expect(closeContext).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(closeContext).toHaveBeenCalledTimes(1);
      expect(closeOwner).not.toHaveBeenCalled();
      const cancellation = budget.cancel();
      expect(budget.cancel()).toBe(cancellation);

      await jest.advanceTimersByTimeAsync(499);
      expect(closeOwner).not.toHaveBeenCalled();
      expect(finished).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(closeOwner).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(finished).not.toHaveBeenCalled();

      ownerTerminated.resolve();
      const error = await completion;
      expect(finished).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(BrowserRuntimeError);
      expect(error).toMatchObject({
        code: 'ACTION_FAILED',
        message: 'The operation did not complete before its deadline.',
        metadata: { reason: 'action_timeout' },
      });
      expect(String(error)).not.toContain('private-');
      await cancellation;
      expect(budget.cancel()).toBe(cancellation);
      expect(closeContext).toHaveBeenCalledTimes(1);
      expect(closeOwner).toHaveBeenCalledTimes(1);
    },
  );
});
