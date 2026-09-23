import { basename } from 'node:path';
import { z } from 'zod';
import type { ActionExplanation } from './action-causality.js';

export const findingSchema = z.object({
  title: z.string().min(1).max(200),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  scope: z.enum(['first-party', 'third-party']).default('first-party'),
  steps: z.array(z.string().max(500)).max(20).default([]),
  expected: z.string().max(2_000).default(''),
  actual: z.string().max(2_000).default(''),
  actionIds: z.array(z.number().int().positive()).max(20).default([]),
  evidence: z.array(z.string().max(500)).max(20).default([])
    .describe('Request IDs with status, script file:line:column, or screenshot paths.'),
});

export const reportInputSchema = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().max(2_000).describe('What the QA session set out to test.'),
  summary: z.string().max(4_000).describe('The verdict and the most important results, in plain language.'),
  findings: z.array(findingSchema).max(50).default([]),
  githubIssue: z.object({
    repository: z.string().max(200).optional(),
    title: z.string().min(1).max(200),
    body: z.string().max(10_000),
    labels: z.array(z.string().max(50)).max(10).default([]),
  }).optional(),
  notes: z.array(z.string().max(1_000)).max(20).default([]).describe('Limits of the session, such as what was not tested.'),
}).strict();

export type ReportInput = z.infer<typeof reportInputSchema>;

export type ReportScreenshot = { path: string; actionId: number; timestamp: number; url: string };

export type ReportData = {
  runId: string;
  startedAt: number;
  finishedAt: number;
  launchMode: string;
  startUrl: string | null;
  actions: ActionExplanation[];
  screenshots: ReportScreenshot[];
  capture: { requests: number; droppedRequests: number; droppedEvents: number; captureHealth: string[] };
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

function escape(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function time(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function pathOf(url: string | null): string {
  if (!url) return '';
  try { return new URL(url).pathname; } catch { return ''; }
}

function host(url: string | null): string {
  if (!url) return 'unknown site';
  try { return new URL(url).host; } catch { return url; }
}

/** Render a self-contained report. Agent text and page text are escaped; screenshots are linked relatively. */
export function renderReport(input: ReportInput, data: ReportData): string {
  const site = host(data.startUrl);
  const findings = [...input.findings].sort((left, right) =>
    SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity));
  const counts = Object.fromEntries(SEVERITY_ORDER.map((level) => [level, findings.filter((item) => item.severity === level).length]));
  const firstParty = findings.filter((item) => item.scope === 'first-party');
  const thirdParty = findings.filter((item) => item.scope === 'third-party');
  const shotsByAction = new Map<number, ReportScreenshot[]>();
  for (const shot of data.screenshots) shotsByAction.set(shot.actionId, [...(shotsByAction.get(shot.actionId) ?? []), shot]);
  const totals = data.actions.reduce((sum, action) => ({
    failed: sum.failed + action.summary.failedRequests,
    console: sum.console + action.summary.consoleErrors,
    exceptions: sum.exceptions + action.summary.exceptions,
  }), { failed: 0, console: 0, exceptions: 0 });

  const findingCard = (finding: ReportInput['findings'][number], index: number) => `
    <article class="finding ${finding.severity}" id="finding-${index + 1}">
      <header><span class="sev ${finding.severity}">${escape(finding.severity)}</span><h3>${escape(finding.title)}</h3></header>
      ${finding.steps.length ? `<h4>Steps</h4><ol>${finding.steps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol>` : ''}
      <div class="compare">
        <div><h4>Expected</h4><p>${escape(finding.expected) || '<span class="muted">Not stated</span>'}</p></div>
        <div><h4>Actual</h4><p>${escape(finding.actual) || '<span class="muted">Not stated</span>'}</p></div>
      </div>
      ${finding.actionIds.length ? `<p class="refs">Actions: ${finding.actionIds.map((id) => `<a href="#action-${id}">#${id}</a>`).join(' ')}</p>` : ''}
      ${finding.evidence.length ? `<h4>Evidence</h4><ul class="evidence">${finding.evidence.map((item) => `<li><code>${escape(item)}</code></li>`).join('')}</ul>` : ''}
      ${finding.actionIds.flatMap((id) => shotsByAction.get(id) ?? []).slice(0, 3).map((shot) =>
        `<a class="thumb" href="${escape(basename(shot.path))}"><img src="${escape(basename(shot.path))}" alt="Screenshot after action ${shot.actionId}" loading="lazy"></a>`).join('')}
    </article>`;

  const actionRow = (action: ActionExplanation) => {
    const shots = shotsByAction.get(action.actionId) ?? [];
    const flagged = action.summary.failedRequests + action.summary.consoleErrors + action.summary.exceptions > 0;
    return `
    <details class="action${flagged ? ' flagged' : ''}" id="action-${action.actionId}"${flagged ? ' open' : ''}>
      <summary>
        <span class="aid">#${action.actionId}</span>
        <span class="what"><b>${escape(action.action?.kind ?? 'action')}</b> ${escape(action.action?.target ?? '')}</span>
        <span class="where">${escape(pathOf(action.action?.url ?? null))}</span>
        <span class="stats">${action.summary.requests} req${action.summary.failedRequests ? ` · <em>${action.summary.failedRequests} failed</em>` : ''}${action.summary.consoleErrors ? ` · <em>${action.summary.consoleErrors} console</em>` : ''}${action.summary.exceptions ? ` · <em>${action.summary.exceptions} exception</em>` : ''}</span>
      </summary>
      <pre>${escape(action.text)}</pre>
      ${shots.map((shot) => `<a class="thumb" href="${escape(basename(shot.path))}"><img src="${escape(basename(shot.path))}" alt="Screenshot after action ${shot.actionId}" loading="lazy"></a>`).join('')}
    </details>`;
  };

  const issue = input.githubIssue;
  const issueText = issue ? `${issue.title}\n\n${issue.body}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA report · ${escape(site)}</title>
<style>
  :root { --bg:#f7f6f2; --panel:#fff; --ink:#1d1d1b; --muted:#5f5e58; --line:#d9d6cc; --accent:#3b5bdb; --code:#f0eee7;
    --critical:#b3261e; --high:#c4521a; --medium:#9a6a00; --low:#2f6f9f; --info:#5f5e58; --ok:#0b7a5a; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#151514; --panel:#1f1f1d; --ink:#ecebe6; --muted:#a8a69e;
    --line:#3a3935; --accent:#8ea2f5; --code:#262623; --critical:#f28b82; --high:#f5a36b; --medium:#e3c15a; --low:#8ab4f8; --info:#a8a69e; --ok:#4fcf9f; } }
  :root[data-theme="dark"] { --bg:#151514; --panel:#1f1f1d; --ink:#ecebe6; --muted:#a8a69e; --line:#3a3935; --accent:#8ea2f5; --code:#262623;
    --critical:#f28b82; --high:#f5a36b; --medium:#e3c15a; --low:#8ab4f8; --info:#a8a69e; --ok:#4fcf9f; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width:1040px; margin:0 auto; padding:32px 16px 64px; }
  h1 { font-size:28px; margin:0 0 4px; } h2 { font-size:21px; margin:36px 0 10px; } h3 { font-size:17px; margin:0; } h4 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:14px 0 4px; }
  p, li { max-width:78ch; } .muted { color:var(--muted); } a { color:var(--accent); }
  .meta { color:var(--muted); font-size:14px; display:flex; flex-wrap:wrap; gap:4px 16px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin:18px 0; }
  .tile { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .tile b { display:block; font-size:26px; line-height:1.2; font-variant-numeric:tabular-nums; } .tile span { color:var(--muted); font-size:13px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 18px; }
  .finding { background:var(--panel); border:1px solid var(--line); border-left:5px solid var(--info); border-radius:12px; padding:14px 18px; margin:12px 0; }
  .finding.critical { border-left-color:var(--critical); } .finding.high { border-left-color:var(--high); } .finding.medium { border-left-color:var(--medium); } .finding.low { border-left-color:var(--low); }
  .finding header { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
  .sev { font-size:12px; font-weight:700; text-transform:uppercase; border:1px solid currentColor; border-radius:999px; padding:0 8px; }
  .sev.critical { color:var(--critical); } .sev.high { color:var(--high); } .sev.medium { color:var(--medium); } .sev.low { color:var(--low); } .sev.info { color:var(--info); }
  .compare { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:4px 20px; } .compare p { margin:0; }
  .refs { font-size:14px; } ul.evidence { padding-left:18px; margin:0; }
  code, pre { font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; } code { background:var(--code); border-radius:4px; padding:0 4px; overflow-wrap:anywhere; }
  pre { background:var(--code); border:1px solid var(--line); border-radius:10px; padding:10px 12px; overflow-x:auto; white-space:pre; }
  .action { background:var(--panel); border:1px solid var(--line); border-radius:10px; margin:6px 0; padding:0 12px; }
  .action.flagged { border-color:var(--high); }
  .action summary { cursor:pointer; display:grid; grid-template-columns:44px 1fr auto; gap:2px 10px; padding:9px 0; align-items:baseline; }
  .action .where { grid-column:2; color:var(--muted); font-size:13px; overflow-wrap:anywhere; } .action .stats { grid-column:3; grid-row:1; font-size:13px; color:var(--muted); white-space:nowrap; }
  .action .stats em { color:var(--high); font-style:normal; font-weight:600; } .aid { color:var(--muted); font-variant-numeric:tabular-nums; }
  .thumb img { max-width:280px; width:100%; border:1px solid var(--line); border-radius:8px; margin:0 8px 10px 0; }
  .gallery { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:10px; }
  .gallery figure { margin:0; } .gallery img { width:100%; border:1px solid var(--line); border-radius:8px; } .gallery figcaption { font-size:13px; color:var(--muted); }
  .issue pre { white-space:pre-wrap; } button { font:inherit; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:8px; padding:4px 12px; cursor:pointer; }
  .none { color:var(--ok); font-weight:600; }
  @media (max-width:560px) { .action summary { grid-template-columns:36px 1fr; } .action .stats { grid-column:2; grid-row:auto; } }
</style>
</head>
<body>
<main>
  <h1>${escape(input.title)}</h1>
  <div class="meta"><span>Site: <b>${escape(site)}</b></span><span>${escape(time(data.startedAt))}</span>
    <span>Duration ${escape(duration(data.finishedAt - data.startedAt))}</span><span>Browser: ${escape(data.launchMode)}</span><span>Run ${escape(data.runId)}</span></div>

  <div class="tiles">
    <div class="tile"><b>${data.actions.length}</b><span>browser actions</span></div>
    <div class="tile"><b>${firstParty.length}</b><span>first-party findings</span></div>
    <div class="tile"><b>${counts.critical! + counts.high!}</b><span>critical or high</span></div>
    <div class="tile"><b>${totals.exceptions}</b><span>uncaught exceptions</span></div>
    <div class="tile"><b>${totals.failed}</b><span>failed requests</span></div>
    <div class="tile"><b>${data.screenshots.length}</b><span>screenshots</span></div>
  </div>

  <h2>Goal</h2>
  <div class="panel"><p>${escape(input.goal)}</p></div>
  <h2>Summary</h2>
  <div class="panel"><p>${escape(input.summary).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p></div>

  <h2>Findings</h2>
  ${firstParty.length ? firstParty.map((finding) => findingCard(finding, findings.indexOf(finding))).join('') : '<p class="none">No first-party bugs were reported.</p>'}
  ${thirdParty.length ? `<h2>Third-party noise</h2><p class="muted">Errors from ads, analytics, and other sites. They are listed so they are not mistaken for bugs in the site under test.</p>${thirdParty.map((finding) => findingCard(finding, findings.indexOf(finding))).join('')}` : ''}

  ${issue ? `<h2>Draft GitHub issue</h2>
  <div class="panel issue">
    ${issue.repository ? `<p>Repository: <b>${escape(issue.repository)}</b></p>` : ''}
    <h3>${escape(issue.title)}</h3>
    ${issue.labels.length ? `<p class="muted">Labels: ${issue.labels.map(escape).join(', ')}</p>` : ''}
    <pre id="issue-text">${escape(issueText)}</pre>
    <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('issue-text').textContent).then(()=>{this.textContent='Copied'})">Copy issue text</button>
  </div>` : ''}

  <h2>What the QA session did</h2>
  <p class="muted">Every browser action in order. Actions that caused failed requests, console errors, or exceptions are open and outlined. Each one shows what it caused: requests with the script line that started them, messages, and navigations.</p>
  ${data.actions.map(actionRow).join('')}

  ${data.screenshots.length ? `<h2>Screenshots</h2><div class="gallery">${data.screenshots.map((shot) => `
    <figure><a href="${escape(basename(shot.path))}"><img src="${escape(basename(shot.path))}" alt="Screenshot after action ${shot.actionId}" loading="lazy"></a>
    <figcaption>After action <a href="#action-${shot.actionId}">#${shot.actionId}</a> · ${escape(host(shot.url))}${escape(pathOf(shot.url))}</figcaption></figure>`).join('')}</div>` : ''}

  <h2>Capture</h2>
  <div class="panel"><ul>
    <li>${data.capture.requests} requests retained; ${data.capture.droppedRequests} older requests were dropped from the bounded capture.</li>
    <li>${data.capture.droppedEvents} evidence events were dropped.</li>
    ${data.capture.captureHealth.map((item) => `<li>${escape(item)}</li>`).join('')}
    <li>Full record: <a href="evidence.json">evidence.json</a></li>
  </ul>
  ${input.notes.length ? `<h4>Limits noted by the tester</h4><ul>${input.notes.map((note) => `<li>${escape(note)}</li>`).join('')}</ul>` : ''}
  </div>
</main>
</body>
</html>
`;
}
