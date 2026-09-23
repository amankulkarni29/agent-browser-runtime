import type { BrowserEvidence } from '../index.js';

/** Preserve the stable browser_evidence wire contract. */
export function formatBrowserEvidence(evidence: BrowserEvidence) {
  return {
    runId: evidence.runId, manifestPath: evidence.manifestPath, droppedEvents: evidence.droppedEvents,
    truncated: evidence.truncated, captureHealth: evidence.captureHealth,
    since: evidence.since,
    bookmark: evidence.bookmark,
    summary: {
      total_requests: evidence.summary.totalRequests,
      first_party: evidence.summary.firstPartyRequests,
      failed_requests: evidence.summary.failedRequests,
      injected_faults: evidence.summary.injectedFaults ?? 0,
      console_errors: evidence.summary.consoleErrors,
      page_errors: evidence.summary.pageErrors,
    },
    page_errors: evidence.pageErrors.map((item) => item),
    console: evidence.console.map((item) => item),
    network: evidence.network.map(({ method, status, hostClass, url, bodyExcerpt, ...metadata }) => ({
      ...metadata,
      method,
      status,
      host: hostClass,
      url,
      body: bodyExcerpt,
    })),
    cdp: evidence.cdp,
    outcomes: evidence.outcomes ?? [],
  };
}
