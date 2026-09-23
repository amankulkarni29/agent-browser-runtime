import type { CDPSession } from 'playwright';
import { classifyFrameUrl, classifyResponseHeaders, type HumanCheck } from './human-checks.js';

type RequestEvent = { type?: string; request: { url: string } };
type ResponseEvent = { response: { url: string; headers: Record<string, string> } };

/** Watch frame documents and response headers for bot challenges as they load. */
export function watchForChallenges(session: CDPSession, onDetect: (check: HumanCheck) => void): void {
  session.on('Network.requestWillBeSent', (event: RequestEvent) => {
    if (event.type !== 'Document') return;
    const check = classifyFrameUrl(event.request.url);
    if (check) onDetect(check);
  });
  session.on('Network.responseReceived', (event: ResponseEvent) => {
    const check = classifyResponseHeaders(event.response.url, event.response.headers);
    if (check) onDetect(check);
  });
}
