import { BrowserRuntimeError, diagnoseActionFailure } from '../../src/core/errors.js';

it('returns a fixed reason instead of a Playwright call log containing entered and existing values', () => {
  const error = new Error(`locator.fill: Timeout 8000ms exceeded.
Call log:
  - fill("private-entered-value")
  - locator resolved to <input value="private-existing-value" disabled/>
  - element is not enabled`);
  const diagnostic = diagnoseActionFailure(error);
  expect(diagnostic.reason).toBe('target_disabled');
  expect(diagnostic.message).toMatch(/disabled/);
  expect(JSON.stringify(diagnostic)).not.toContain('private-');
  expect(JSON.stringify(diagnostic)).not.toContain('<input');
});

it('does not expose unexpected errors or arbitrary metadata', () => {
  for (const error of [
    new Error('private-error-message'),
    new BrowserRuntimeError('private-error-message', 'ACTION_FAILED', { reason: 'private-reason', error: 'private-metadata' }),
    new BrowserRuntimeError('private-error-message', 'ACTION_FAILED', { reason: '__proto__' }),
  ]) {
    const diagnostic = diagnoseActionFailure(error);
    expect(diagnostic.reason).toBe('action_failed');
    expect(JSON.stringify(diagnostic)).not.toContain('private-');
  }
});
