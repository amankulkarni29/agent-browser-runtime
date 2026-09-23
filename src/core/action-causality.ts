import type { RequestRecord } from './network-recorder.js';
import type { EvidenceEvent } from './types.js';
import { matchInjectedFaults } from './network-faults.js';

type StackFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type StackTrace = { description?: string; callFrames: StackFrame[]; parent?: StackTrace };

export type CodeLocation = { url: string; line: number; column: number; functionName: string | null };

/** One hop in a JavaScript call path: the sync frame, then each async boundary (setTimeout, await…). */
export type CallOrigin = { via: string | null; location: CodeLocation };

export type CausalNode =
  | {
      kind: 'request'; requestId: string; timestamp: number; method: string; url: string; resourceType: string;
      hostClass: 'first-party' | 'third-party'; status: number; failure: string | null; bodyExcerpt: string | null;
      initiatorType: string; origin: CallOrigin[]; injectedFault: string | null; children: CausalNode[];
    }
  | { kind: 'console'; sequence: number; timestamp: number; level: string; text: string; origin: CallOrigin[] }
  | { kind: 'exception'; sequence: number; timestamp: number; message: string; origin: CallOrigin[] }
  | { kind: 'log'; sequence: number; timestamp: number; source: string; level: string; text: string; url: string | null }
  | { kind: 'navigation'; sequence: number; timestamp: number; url: string };

export type ActionExplanation = {
  runId: string;
  actionId: number;
  action: { kind: string; target: string | null; url: string | null; title: string | null;
    settled: { networkQuiet: boolean; domStable: boolean; waitedMs: number } | null; failure: string | null } | null;
  summary: { requests: number; failedRequests: number; consoleErrors: number; exceptions: number;
    navigations: number; omittedRequests: number; omittedMessages: number };
  chain: CausalNode[];
  text: string;
  captureLoss: string[];
  notes: string[];
};

export type CausalityInput = {
  runId: string;
  actionId: number;
  events: EvidenceEvent[];
  requests: RequestRecord[];
  droppedEvents: number;
  droppedRequests: number;
  /** False when the CDP Runtime domain is unavailable; Playwright console and page errors are used instead. */
  hasCdpRuntime?: boolean | undefined;
  filter?: 'relevant' | 'all' | undefined;
};

const MAX_STACK_LEVELS = 8;
const MAX_FRAMES = 10;
const MAX_REQUEST_NODES = 80;
const MAX_MESSAGE_NODES = 60;
const MAX_TEXT_CHARS = 300;
const MAX_BODY_CHARS = 160;
// Only the innermost frames of the code that started a request identify it. Framework
// dispatch frames lower in the stack would link unrelated messages in the same handler.
const LINK_FRAMES = 3;
const INTERACTIVE_TYPES = new Set(['Document', 'XHR', 'Fetch', 'EventSource', 'WebSocket']);
const NOISY_LOG_SOURCES = new Set(['network', 'javascript', 'deprecation', 'recommendation']);

/**
 * Bound a CDP `Network.Initiator` while keeping its protocol shape. Async stack tracking can
 * produce deep parent chains, and every retained request carries one.
 */
export function compactInitiator(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const { stack, ...rest } = raw;
  const compact: Record<string, unknown> = {};
  for (const key of ['type', 'url', 'lineNumber', 'columnNumber', 'requestId'] as const) {
    if (rest[key] !== undefined) compact[key] = rest[key];
  }
  const trace = readStack(stack);
  if (trace) compact.stack = trace;
  return compact;
}

function readStack(raw: unknown, depth = 0): StackTrace | undefined {
  if (!isRecord(raw) || depth >= MAX_STACK_LEVELS) return undefined;
  const callFrames = (Array.isArray(raw.callFrames) ? raw.callFrames : []).slice(0, MAX_FRAMES).flatMap((frame) => {
    if (!isRecord(frame)) return [];
    return [{ functionName: String(frame.functionName ?? ''), url: String(frame.url ?? ''),
      lineNumber: Number(frame.lineNumber ?? 0), columnNumber: Number(frame.columnNumber ?? 0) }];
  });
  const parent = readStack(raw.parent, depth + 1);
  return { ...(typeof raw.description === 'string' ? { description: raw.description } : {}), callFrames, ...(parent ? { parent } : {}) };
}

function stackLevels(stack: StackTrace | undefined): StackTrace[] {
  const levels: StackTrace[] = [];
  for (let level = stack; level && levels.length < MAX_STACK_LEVELS; level = level.parent) levels.push(level);
  return levels;
}

function toLocation(frame: StackFrame): CodeLocation {
  return { url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1, functionName: frame.functionName || null };
}

/** Top frame of the sync stack, then the top frame at each async boundary. */
function stackOrigin(stack: StackTrace | undefined): CallOrigin[] {
  const origin: CallOrigin[] = [];
  for (const [index, level] of stackLevels(stack).entries()) {
    const frame = level.callFrames.find((candidate) => candidate.url) ?? level.callFrames[0];
    if (!frame) continue;
    origin.push({ via: index === 0 ? null : level.description ?? 'async', location: toLocation(frame) });
  }
  return origin;
}

function frameKey(frame: StackFrame): string {
  return frame.functionName ? `${frame.url}#${frame.functionName}` : `${frame.url}:${frame.lineNumber}`;
}

function initiatorOrigin(initiator: unknown): { type: string; origin: CallOrigin[]; stack: StackTrace | undefined } {
  if (!isRecord(initiator)) return { type: 'other', origin: [], stack: undefined };
  const type = String(initiator.type ?? 'other');
  const stack = readStack(initiator.stack);
  const origin = stackOrigin(stack);
  if (origin.length === 0 && typeof initiator.url === 'string' && initiator.url) {
    origin.push({ via: null, location: { url: initiator.url, line: Number(initiator.lineNumber ?? 0) + 1,
      column: Number(initiator.columnNumber ?? 0) + 1, functionName: null } });
  }
  return { type, origin, stack };
}

type RequestNode = Extract<CausalNode, { kind: 'request' }>;
type MessageNode = Exclude<CausalNode, { kind: 'request' }>;
type Linkable = { node: MessageNode; frames: Set<string>; sourceUrl: string | null };

/** Build the cause-and-effect tree for one action from the bounded evidence already captured. */
export function explainAction(input: CausalityInput): ActionExplanation {
  const filter = input.filter ?? 'relevant';
  const events = input.events.filter((event) => event.actionId === input.actionId);
  const actionEvent = [...events].reverse().find((event) => event.method === 'Browser.action');
  const failureEvent = [...events].reverse().find((event) => event.method === 'Browser.actionFailed');
  const action = actionEvent || failureEvent ? {
    kind: String((actionEvent ?? failureEvent)!.params.kind ?? 'action'),
    target: typeof actionEvent?.params.target === 'string' ? actionEvent.params.target : null,
    url: typeof actionEvent?.params.url === 'string' ? actionEvent.params.url : null,
    title: typeof actionEvent?.params.title === 'string' ? actionEvent.params.title : null,
    settled: readSettled(actionEvent?.params.settled),
    failure: failureEvent ? String(failureEvent.params.message ?? failureEvent.params.reason ?? 'failed') : null,
  } : null;

  const requestNodes = input.requests
    .filter((record) => record.actionId === input.actionId)
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((record) => requestNode(record));
  const injected = matchInjectedFaults(input.events.filter((event) => event.method === 'Browser.faultApplied'), requestNodes);
  for (const node of requestNodes) node.injectedFault = injected.get(node) ?? null;
  const stacks = new Map(input.requests.map((record) => [record.id, initiatorOrigin(record.initiator).stack]));

  const linkables = messageNodes(events, filter, input.hasCdpRuntime ?? true);
  const roots: CausalNode[] = [];

  // A request is nested under the request that loaded the document or script that started it.
  for (const node of requestNodes) {
    const sourceUrl = node.origin[0]?.location.url;
    const parent = sourceUrl ? latestBefore(requestNodes, node.timestamp, (candidate) =>
      candidate !== node && candidate.url === sourceUrl) : undefined;
    (parent ? parent.children : roots).push(node);
  }

  for (const item of linkables) {
    const sharedStack = item.frames.size > 0 ? latestBefore(requestNodes, item.node.timestamp, (candidate) => {
      const frames = stackLevels(stacks.get(candidate.requestId))[0]?.callFrames.slice(0, LINK_FRAMES) ?? [];
      return frames.some((frame) => item.frames.has(frameKey(frame)));
    }) : undefined;
    const loader = !sharedStack && item.sourceUrl
      ? latestBefore(requestNodes, item.node.timestamp, (candidate) => candidate.url === item.sourceUrl)
      : undefined;
    const parent = sharedStack ?? loader;
    (parent ? parent.children : roots).push(item.node);
  }

  const omitted = { requests: 0, messages: 0 };
  const pruned = prune(sortNodes(roots), filter, omitted);
  const allRequests = requestNodes.length;
  const failedRequests = requestNodes.filter(isFailedRequest).length;
  const allMessages = linkables.map((item) => item.node);

  const captureLoss: string[] = [];
  const oldestEvent = input.events[0];
  if (input.droppedEvents > 0 && (!oldestEvent || (oldestEvent.actionId ?? 0) >= input.actionId)) {
    captureLoss.push('Older evidence events were evicted from the bounded journal; this action may be incomplete.');
  }
  const oldestRequestAction = Math.min(...input.requests.map((record) => record.actionId));
  if (input.droppedRequests > 0 && oldestRequestAction >= input.actionId) {
    captureLoss.push('Older requests were evicted from the bounded network capture; this action may be missing requests.');
  }

  const notes: string[] = [];
  if (action?.settled && !(action.settled.networkQuiet && action.settled.domStable)) {
    notes.push('The action did not settle before its deadline; later effects may be attributed to it.');
  }
  if (allMessages.some((node) => node.kind === 'console' || node.kind === 'exception')) {
    notes.push('Messages nested under a request share call-stack frames with the code that started it, or come from a file it loaded. These links are inferred.');
  }
  notes.push('Evidence is attributed to the most recent action started before it was captured.');

  const summary = {
    requests: allRequests,
    failedRequests,
    consoleErrors: allMessages.filter((node) => node.kind === 'console' && node.level === 'error').length,
    exceptions: allMessages.filter((node) => node.kind === 'exception').length,
    navigations: allMessages.filter((node) => node.kind === 'navigation').length,
    omittedRequests: omitted.requests,
    omittedMessages: omitted.messages,
  };
  const explanation = { runId: input.runId, actionId: input.actionId, action, summary, chain: pruned, captureLoss, notes };
  return { ...explanation, text: renderText(explanation, filter) };
}

function readSettled(value: unknown): NonNullable<ActionExplanation['action']>['settled'] {
  if (!isRecord(value)) return null;
  return { networkQuiet: value.networkQuiet === true, domStable: value.domStable === true, waitedMs: Number(value.waitedMs ?? 0) };
}

function requestNode(record: RequestRecord): RequestNode {
  const { type, origin } = initiatorOrigin(record.initiator);
  return {
    kind: 'request', requestId: record.id, timestamp: record.timestamp, method: record.method, url: record.url,
    resourceType: record.resourceType, hostClass: record.hostClass, status: record.status, failure: record.failure,
    bodyExcerpt: record.body === null ? null : collapse(record.body, MAX_BODY_CHARS),
    initiatorType: type, origin, injectedFault: null, children: [],
  };
}

function messageNodes(events: EvidenceEvent[], filter: 'relevant' | 'all', hasCdpRuntime: boolean): Linkable[] {
  const items: Linkable[] = [];
  // CDP events carry async stack traces. Playwright reports the same messages without them.
  for (const event of events) {
    const params = event.params;
    const base = { sequence: event.sequence, timestamp: event.timestamp };
    if (event.method === 'Runtime.consoleAPICalled' && hasCdpRuntime) {
      const level = consoleLevel(String(params.type ?? 'log'));
      if (filter === 'relevant' && !['error', 'warning', 'assert'].includes(level)) continue;
      const stack = readStack(params.stackTrace);
      items.push({ node: { kind: 'console', ...base, level, text: collapse(consoleText(params.args), MAX_TEXT_CHARS),
        origin: stackOrigin(stack) }, frames: allFrameKeys(stack), sourceUrl: stackOrigin(stack)[0]?.location.url ?? null });
    } else if (event.method === 'Browser.console' && !hasCdpRuntime) {
      const level = consoleLevel(String(params.level ?? 'log'));
      if (filter === 'relevant' && !['error', 'warning', 'assert'].includes(level)) continue;
      const location = isRecord(params.location) && typeof params.location.url === 'string' && params.location.url
        ? [{ via: null, location: { url: params.location.url, line: Number(params.location.lineNumber ?? 0) + 1,
          column: Number(params.location.columnNumber ?? 0) + 1, functionName: null } }]
        : [];
      items.push({ node: { kind: 'console', ...base, level, text: collapse(String(params.text ?? ''), MAX_TEXT_CHARS), origin: location },
        frames: new Set(), sourceUrl: location[0]?.location.url ?? null });
    } else if (event.method === 'Runtime.exceptionThrown' && hasCdpRuntime) {
      const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {};
      const stack = readStack(details.stackTrace);
      const origin = stackOrigin(stack);
      if (origin.length === 0 && typeof details.url === 'string' && details.url) {
        origin.push({ via: null, location: { url: details.url, line: Number(details.lineNumber ?? 0) + 1,
          column: Number(details.columnNumber ?? 0) + 1, functionName: null } });
      }
      const description = isRecord(details.exception) && typeof details.exception.description === 'string'
        ? details.exception.description.split('\n')[0] : undefined;
      items.push({ node: { kind: 'exception', ...base, message: collapse(description ?? String(details.text ?? 'Uncaught exception'), MAX_TEXT_CHARS), origin },
        frames: allFrameKeys(stack), sourceUrl: origin[0]?.location.url ?? null });
    } else if (event.method === 'Browser.pageError' && !hasCdpRuntime) {
      const origin = parseErrorStack(typeof params.stack === 'string' ? params.stack : '');
      items.push({ node: { kind: 'exception', ...base, message: collapse(String(params.message ?? 'Uncaught exception'), MAX_TEXT_CHARS), origin },
        frames: new Set(), sourceUrl: origin[0]?.location.url ?? null });
    } else if (event.method === 'Log.entryAdded') {
      const entry = isRecord(params.entry) ? params.entry : {};
      const source = String(entry.source ?? 'other');
      const level = String(entry.level ?? 'info');
      if (source === 'network' || (filter === 'relevant' && (NOISY_LOG_SOURCES.has(source) || !['error', 'warning'].includes(level)))) continue;
      const url = typeof entry.url === 'string' && entry.url ? entry.url : null;
      items.push({ node: { kind: 'log', ...base, source, level, text: collapse(String(entry.text ?? ''), MAX_TEXT_CHARS), url },
        frames: new Set(), sourceUrl: url });
    } else if (event.method === 'Page.frameNavigated') {
      const frame = isRecord(params.frame) ? params.frame : {};
      if (frame.parentId !== undefined || typeof frame.url !== 'string') continue;
      items.push({ node: { kind: 'navigation', ...base, url: frame.url }, frames: new Set(), sourceUrl: null });
    }
  }
  return items;
}

function allFrameKeys(stack: StackTrace | undefined): Set<string> {
  return new Set(stackLevels(stack).flatMap((level) => level.callFrames.map(frameKey)));
}

function consoleLevel(type: string): string {
  return type === 'warn' ? 'warning' : type;
}

function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return '';
  return args.map((arg) => {
    if (!isRecord(arg)) return String(arg);
    if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
    return String(arg.unserializableValue ?? arg.description ?? arg.type ?? '');
  }).join(' ');
}

function parseErrorStack(stack: string): CallOrigin[] {
  const match = /at (?:(.+?) \()?(\S+?):(\d+):(\d+)\)?$/m.exec(stack);
  if (!match) return [];
  return [{ via: null, location: { url: match[2]!, line: Number(match[3]), column: Number(match[4]), functionName: match[1] ?? null } }];
}

function latestBefore(nodes: RequestNode[], timestamp: number, predicate: (node: RequestNode) => boolean): RequestNode | undefined {
  let found: RequestNode | undefined;
  for (const node of nodes) if (node.timestamp <= timestamp && predicate(node)) found = node;
  return found;
}

function nodeTime(node: CausalNode): number {
  return node.timestamp;
}

function sortNodes(nodes: CausalNode[]): CausalNode[] {
  for (const node of nodes) if (node.kind === 'request') node.children = sortNodes(node.children);
  return [...nodes].sort((left, right) => nodeTime(left) - nodeTime(right));
}

function isFailedRequest(node: RequestNode): boolean {
  return node.status >= 400 || !!node.failure || !!node.injectedFault;
}

/** In relevant mode, keep failures, documents, API calls, first-party scripts, and anything with children. */
function prune(nodes: CausalNode[], filter: 'relevant' | 'all', omitted: { requests: number; messages: number },
  budget = { requests: MAX_REQUEST_NODES, messages: MAX_MESSAGE_NODES }): CausalNode[] {
  const kept: CausalNode[] = [];
  for (const node of nodes) {
    if (node.kind !== 'request') {
      if (budget.messages-- > 0) kept.push(node);
      else omitted.messages++;
      continue;
    }
    const children = prune(node.children, filter, omitted, budget);
    const relevant = filter === 'all' || children.length > 0 || isFailedRequest(node) || INTERACTIVE_TYPES.has(node.resourceType) ||
      (node.resourceType === 'Script' && node.hostClass === 'first-party');
    if (relevant && budget.requests-- > 0) kept.push({ ...node, children });
    else { omitted.requests++; kept.push(...children); }
  }
  return kept;
}

function renderText(explanation: Omit<ActionExplanation, 'text'>, filter: 'relevant' | 'all'): string {
  const { action, actionId } = explanation;
  const pageOrigin = originOf(action?.url ?? null) ?? originOf(firstRequestUrl(explanation.chain));
  const header = action
    ? `${action.kind}${action.target ? ` ${action.target}` : ''} (action ${actionId})` +
      (action.url ? ` → ${shortUrl(action.url, pageOrigin)}` : '') +
      (action.settled ? `, ${action.settled.networkQuiet && action.settled.domStable ? 'settled' : 'not settled'} after ${action.settled.waitedMs} ms` : '') +
      (action.failure ? `, failed: ${action.failure}` : '')
    : `action ${actionId} (no action receipt was captured)`;
  const lines = [header];
  const walk = (nodes: CausalNode[], prefix: string) => {
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      const branch = `${prefix}${last ? '└─ ' : '├─ '}`;
      const continuation = `${prefix}${last ? '    ' : '│   '}`;
      lines.push(branch + describe(node, pageOrigin));
      if (node.kind === 'request') {
        const detail = requestDetail(node);
        if (detail) lines.push(`${continuation}${node.children.length ? '│ ' : '  '}${detail}`);
        if (node.bodyExcerpt && (INTERACTIVE_TYPES.has(node.resourceType) && node.resourceType !== 'Document' || isFailedRequest(node))) {
          lines.push(`${continuation}${node.children.length ? '│ ' : '  '}body ${node.bodyExcerpt}`);
        }
        walk(node.children, continuation);
      }
    });
  };
  walk(explanation.chain, ' ');
  if (explanation.chain.length === 0) lines.push(' (no requests, console messages, exceptions or navigations were captured)');
  const { omittedRequests, omittedMessages } = explanation.summary;
  if (omittedRequests > 0) {
    lines.push(` + ${omittedRequests} successful static or third-party request(s) omitted${filter === 'relevant' ? ' (use filter "all")' : ''}`);
  }
  if (omittedMessages > 0) lines.push(` + ${omittedMessages} message(s) omitted`);
  return lines.join('\n');
}

function describe(node: CausalNode, pageOrigin: string | null): string {
  switch (node.kind) {
    case 'request': {
      const type = INTERACTIVE_TYPES.has(node.resourceType) && node.resourceType !== 'Document' ? '' : ` (${node.resourceType.toLowerCase()})`;
      const outcome = node.failure ? `failed: ${node.failure}` : node.status === 0 ? 'no response' : String(node.status);
      return `${node.method} ${shortUrl(node.url, pageOrigin)}${type} → ${outcome} [${node.requestId}]${node.injectedFault ? ` (injected by ${node.injectedFault})` : ''}`;
    }
    case 'console': return `console.${node.level} "${node.text}"${atLocation(node.origin)}`;
    case 'exception': return `uncaught ${node.message}${atLocation(node.origin)}`;
    case 'log': return `browser ${node.source} ${node.level} "${node.text}"`;
    case 'navigation': return `navigated to ${shortUrl(node.url, pageOrigin)}`;
  }
}

function requestDetail(node: RequestNode): string | null {
  if (node.origin.length === 0) return null;
  const verb = node.initiatorType === 'parser' ? 'loaded by' : node.initiatorType === 'script' ? 'started by' : `initiated (${node.initiatorType}) at`;
  return `${verb} ${originChain(node.origin)}`;
}

function atLocation(origin: CallOrigin[]): string {
  return origin.length ? ` at ${originChain(origin)}` : '';
}

function originChain(origin: CallOrigin[]): string {
  return origin.slice(0, 4).map((hop) => `${hop.via ? `${hop.via} ← ` : ''}${locationLabel(hop.location)}`).join(' ← ');
}

function locationLabel(location: CodeLocation): string {
  const file = fileName(location.url);
  // Columns matter: minified bundles put every function on one line.
  return `${file}:${location.line}:${location.column}${location.functionName ? ` (${location.functionName})` : ''}`;
}

function fileName(url: string): string {
  if (!url) return '<anonymous>';
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).pop();
    return segment ?? `${parsed.host}/`;
  } catch {
    return url.split('/').pop() || url;
  }
}

function shortUrl(url: string, pageOrigin: string | null): string {
  try {
    const parsed = new URL(url);
    const text = parsed.origin === pageOrigin ? `${parsed.pathname}${parsed.search}` : `${parsed.host}${parsed.pathname}${parsed.search}`;
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  } catch {
    return url.length > 120 ? `${url.slice(0, 117)}…` : url;
  }
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

function firstRequestUrl(nodes: CausalNode[]): string | null {
  const request = nodes.find((node): node is RequestNode => node.kind === 'request');
  return request?.url ?? null;
}

function collapse(value: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
