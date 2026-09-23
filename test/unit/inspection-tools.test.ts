import { z } from 'zod';
import { inspectionTools } from '../../src/adapters/inspection-tools.js';
import { BrowserSession } from '../../src/core/browser-session.js';

it.each([
  ['browser_requests', 'requests', { status: 200.5 }],
  ['browser_request', 'request', {}],
  ['browser_response_body', 'responseBody', { requestId: 'request-1', offset: -1 }],
  ['browser_response_body', 'responseBody', { requestId: 'request-1', offset: 0.5 }],
  ['browser_response_body', 'responseBody', { requestId: 'request-1', limit: 16001 }],
  ['browser_frames', 'frames', null],
  ['browser_inspect', 'inspect', { selector: 'body', properties: Array(61).fill('color') }],
  ['browser_viewport', 'viewport', { width: 239, height: 844 }],
  ['browser_explain_action', 'explainAction', { actionId: 0 }],
  ['browser_explain_action', 'explainAction', { filter: 'errors' }],
] as const)('%s rejects invalid arguments before invoking %s', (name, method, args) => {
  const session = new BrowserSession();
  const operation = jest.spyOn(session, method);
  const tool = inspectionTools(session).find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  expect(() => tool.run(args)).toThrow(z.ZodError);
  expect(operation).not.toHaveBeenCalled();
});
