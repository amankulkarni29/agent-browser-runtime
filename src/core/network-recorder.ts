import type { CDPSession } from 'playwright';
import { BrowserRuntimeError } from './errors.js';
import { redactKnownSecrets, redactUrl, redactValue } from './redaction.js';
import { compactInitiator } from './action-causality.js';

type ResponseData = { status: number; headers: Record<string, string>; timing?: unknown };
type RequestEvent = { requestId: string; frameId?: string; type?: string; initiator: unknown;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  redirectResponse?: ResponseData };
type ResponseEvent = { requestId: string; response: ResponseData };
type FailureEvent = { requestId: string; errorText: string };
type FinishedEvent = { requestId: string; encodedDataLength: number };

const MAX_REQUESTS = 120;
const MAX_BODY = 64_000;
const READ_TIMEOUT_MS = 2_000;
const SAFE_HEADERS = /^(content-type|content-length|cache-control|etag|last-modified|server-timing|retry-after|x-request-id|x-correlation-id)$/i;

export type RequestRecord = {
  id: string; timestamp: number; actionId: number; url: string; method: string;
  frameId: string; resourceType: string; hostClass: 'first-party' | 'third-party';
  status: number; requestHeaders: Record<string, string>; responseHeaders: Record<string, string>;
  payload: string | null; initiator: unknown; timing: unknown; failure: string | null;
  payloadTruncated: boolean;
  body: string | null; bodyState: 'pending' | 'available' | 'truncated' | 'unavailable' | 'too-large' | 'timeout' | 'unsupported';
  bodyReason: string | null;
};

/** CDP buffers are bounded before body retrieval; the retained, redacted store is separately capped. */
export class NetworkRecorder {
  private records = new Map<string, RequestRecord>();
  private pending = new Set<Promise<void>>();
  private generation = 0;
  private counter = 0;
  dropped = 0;

  constructor(
    private readonly classify: (url: string) => 'first-party' | 'third-party',
    private readonly action: () => number,
    private readonly emit: (record: RequestRecord) => void,
    private readonly secrets: readonly (string | undefined)[],
  ) {}

  private text(value: string): string {
    let redacted: unknown;
    try { redacted = redactValue(JSON.parse(value)); }
    catch { redacted = redactValue(value); }
    return redactKnownSecrets(typeof redacted === 'string' ? redacted : JSON.stringify(redacted), this.secrets);
  }

  private headers(headers: Record<string, string | number>): Record<string, string> {
    return Object.fromEntries(Object.entries(headers).filter(([key]) => SAFE_HEADERS.test(key))
      .map(([key, value]) => [key.toLowerCase(), this.text(String(value)).slice(0, 2_000)]));
  }

  async attach(session: CDPSession): Promise<void> {
    await session.send('Network.enable', { maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 256_000, maxPostDataSize: 64_000 });
    const ids = new Map<string, string>();
    session.on('Network.requestWillBeSent', (event: RequestEvent) => {
      const previous = ids.get(event.requestId);
      if (previous && event.redirectResponse) {
        const record = this.records.get(previous);
        if (record) {
          record.status = event.redirectResponse.status;
          record.responseHeaders = this.headers(event.redirectResponse.headers);
          record.bodyState = 'unavailable';
          this.emit(record);
        }
      }
      const id = `request-${++this.counter}`;
      ids.set(event.requestId, id);
      this.records.set(id, {
        id, timestamp: Date.now(), actionId: this.action(), url: this.text(redactUrl(event.request.url)),
        method: event.request.method, frameId: event.frameId ?? '', resourceType: event.type ?? 'Other',
        hostClass: this.classify(event.request.url), status: 0,
        requestHeaders: this.headers(event.request.headers), responseHeaders: {},
        payload: event.request.postData ? this.payload(event.request.postData, event.request.headers).slice(0, MAX_BODY) : null,
        payloadTruncated: (event.request.postData?.length ?? 0) > MAX_BODY,
        initiator: JSON.parse(this.text(JSON.stringify(compactInitiator(event.initiator) ?? null))), timing: null, failure: null,
        body: null, bodyState: 'pending', bodyReason: null,
      });
      if (this.records.size > MAX_REQUESTS) {
        const oldest = this.records.keys().next().value;
        if (oldest) this.records.delete(oldest);
        this.dropped++;
      }
      // Completed IDs are removed below; bound IDs for streams that never complete too.
      if (ids.size > 500) { const oldest = ids.keys().next().value; if (oldest) ids.delete(oldest); }
    });
    session.on('Network.responseReceived', (event: ResponseEvent) => {
      const record = this.records.get(ids.get(event.requestId) ?? '');
      if (!record) return;
      record.status = event.response.status;
      record.responseHeaders = this.headers(event.response.headers);
      record.timing = event.response.timing ?? null;
    });
    session.on('Network.loadingFailed', (event: FailureEvent) => {
      const record = this.records.get(ids.get(event.requestId) ?? '');
      ids.delete(event.requestId);
      if (!record) return;
      record.failure = this.text(event.errorText);
      record.bodyState = 'unavailable';
      this.emit(record);
    });
    session.on('Network.loadingFinished', (event: FinishedEvent) => {
      const record = this.records.get(ids.get(event.requestId) ?? '');
      ids.delete(event.requestId);
      if (!record) return;
      if (this.pending.size >= 16) {
        record.bodyState = 'unavailable';
        record.bodyReason = 'Concurrent body capture limit reached';
        this.emit(record);
        return;
      }
      const generation = this.generation;
      const read = this.readBody(session, event, record).then(() => {
        if (generation === this.generation) this.emit(record);
      });
      this.pending.add(read);
      void read.finally(() => this.pending.delete(read));
    });
  }

  private payload(value: string, headers: Record<string, string>): string {
    const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
    if (/x-www-form-urlencoded/i.test(contentType)) return this.text(JSON.stringify(Object.fromEntries(new URLSearchParams(value))));
    if (/multipart/i.test(contentType)) return '[Multipart payload omitted]';
    return this.text(value);
  }

  private async readBody(session: CDPSession, event: FinishedEvent, record: RequestRecord): Promise<void> {
    const contentType = record.responseHeaders['content-type'] ?? '';
    if (!/(json|text|javascript|xml|html)/i.test(contentType) || /event-stream/i.test(contentType)) {
      record.bodyState = 'unsupported'; return;
    }
    if (event.encodedDataLength > 256_000 || Number(record.responseHeaders['content-length'] ?? 0) > 256_000) {
      record.bodyState = 'too-large'; return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        session.send('Network.getResponseBody', { requestId: event.requestId }),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS); }),
      ]);
      if (!result) { record.bodyState = 'timeout'; return; }
      // Transfer size can be much smaller than the decoded CDP result for compressed responses.
      if (Buffer.byteLength(result.body, result.base64Encoded ? 'base64' : 'utf8') > 256_000) {
        record.bodyState = 'too-large';
        record.bodyReason = 'Decoded response exceeds 256000 bytes';
        return;
      }
      const raw = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
      const body = this.text(raw);
      record.body = body.slice(0, MAX_BODY);
      record.bodyState = body.length > MAX_BODY ? 'truncated' : 'available';
    } catch {
      record.bodyState = 'unavailable';
    } finally { if (timer) clearTimeout(timer); }
  }

  list(query: { url?: string | undefined; status?: number | undefined; since?: number | undefined } = {}) {
    return { dropped: this.dropped, requests: [...this.records.values()]
      .filter((r) => (!query.url || r.url.includes(query.url)) && (query.status === undefined || r.status === query.status) &&
        (query.since === undefined || r.timestamp >= query.since))
      .map(({ body: _body, payload: _payload, ...record }) => record) };
  }

  get(id: string): RequestRecord {
    const record = this.records.get(id);
    if (!record) throw new BrowserRuntimeError('Request is unknown or was evicted from the bounded capture.', 'INVALID_STATE');
    return structuredClone(record);
  }

  body(id: string, offset = 0, limit = 8_000) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16_000) {
      throw new BrowserRuntimeError('Body offset must be nonnegative and limit must be 1–16000.', 'INVALID_CONFIGURATION');
    }
    const record = this.get(id);
    const body = record.body ?? '';
    return { requestId: id, state: record.bodyState, reason: record.bodyReason, offset, text: body.slice(offset, offset + limit),
      retainedChars: body.length, nextOffset: offset + limit < body.length ? offset + limit : null };
  }

  all(): RequestRecord[] { return [...this.records.values()].map((r) => structuredClone(r)); }
  async flush(): Promise<void> { await Promise.all([...this.pending]); }
  clear(): void { this.generation++; this.records.clear(); this.pending.clear(); this.counter = 0; this.dropped = 0; }
}
