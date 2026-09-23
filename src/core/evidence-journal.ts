import type { EvidenceEvent } from './types.js';
import { redactKnownSecrets, redactUrl, redactValue } from './redaction.js';

const PROTECTED_METHODS = new Set([
  'Browser.action',
  'Browser.actionFailed',
  'Browser.login',
  'Browser.loginVerification',
  'Browser.verify',
  'Browser.sequence',
  'Browser.fault',
  'Browser.faultApplied',
  'Browser.challenge',
  'Browser.handoff',
]);

export function isProtectedEvidenceEvent(event: EvidenceEvent): boolean {
  return PROTECTED_METHODS.has(event.method);
}

export class EvidenceJournal {
  private events: EvidenceEvent[] = [];
  private nextSequence = 1;
  private protectedEventCount = 0;
  private readonly protectedEventReserve: number;

  constructor(
    private readonly maxEvents = 2_000,
    private readonly knownSecrets: readonly (string | undefined)[] = [],
    private readonly onChange?: () => void,
    private readonly currentAction: () => number = () => 0,
  ) {
    this.protectedEventReserve = Math.ceil(maxEvents / 4);
  }

  bookmark(): number {
    return this.nextSequence - 1;
  }

  clear(): void {
    this.events = [];
    this.nextSequence = 1;
    this.protectedEventCount = 0;
  }

  record(method: string, params: Record<string, unknown>): number {
    const normalized = this.normalize(params);
    const sequence = this.nextSequence++;
    const actionId = this.currentAction();
    this.events.push({
      sequence,
      timestamp: Date.now(),
      method,
      params: normalized,
      ...(actionId > 0 ? { actionId } : {}),
    });
    if (PROTECTED_METHODS.has(method)) this.protectedEventCount++;
    if (this.events.length > this.maxEvents) {
      // Reserve a quarter of capacity for outcomes that noisy page events must not evict.
      const ordinaryIndex = this.protectedEventCount <= this.protectedEventReserve
        ? this.events.findIndex((event) => !isProtectedEvidenceEvent(event))
        : 0;
      const [removed] = this.events.splice(Math.max(0, ordinaryIndex), 1);
      if (removed && PROTECTED_METHODS.has(removed.method)) this.protectedEventCount--;
    }
    this.onChange?.();
    return sequence;
  }

  get dropped(): number { return Math.max(0, this.nextSequence - 1 - this.events.length); }

  since(bookmark: number): EvidenceEvent[] {
    return this.events.filter((event) => event.sequence > bookmark);
  }

  all(): EvidenceEvent[] {
    return [...this.events];
  }

  private normalize(params: Record<string, unknown>): Record<string, unknown> {
    const redacted = redactValue(params) as Record<string, unknown>;
    const clean = this.scrubKnownSecrets(this.redactUrls(redacted));
    let remaining = 32_000;
    let truncated = false;
    const bound = (value: unknown, depth: number): unknown => {
      if (depth > 8 || remaining <= 0) { truncated = true; return '[Capture truncated]'; }
      if (typeof value === 'string') {
        const text = value.slice(0, Math.min(12_000, remaining));
        remaining -= text.length;
        if (text.length < value.length) truncated = true;
        return text;
      }
      if (Array.isArray(value)) {
        if (value.length > 100) truncated = true;
        return value.slice(0, 100).map((item) => bound(item, depth + 1));
      }
      if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length > 100) truncated = true;
        return Object.fromEntries(entries.slice(0, 100).map(([key, child]) => [key, bound(child, depth + 1)]));
      }
      return value;
    };
    const bounded = bound(clean, 0) as Record<string, unknown>;
    return truncated ? { ...bounded, captureTruncated: true } : bounded;
  }

  private scrubKnownSecrets(value: Record<string, unknown>): Record<string, unknown> {
    if (this.knownSecrets.length === 0) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (typeof child === 'string') return [key, redactKnownSecrets(child, this.knownSecrets)];
        if (Array.isArray(child)) {
          return [
            key,
            child.map((item) =>
              typeof item === 'string'
                ? redactKnownSecrets(item, this.knownSecrets)
                : item && typeof item === 'object'
                  ? this.scrubKnownSecrets(item as Record<string, unknown>)
                  : item,
            ),
          ];
        }
        if (child && typeof child === 'object') return [key, this.scrubKnownSecrets(child as Record<string, unknown>)];
        return [key, child];
      }),
    );
  }

  private redactUrls(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if ((key === 'url' || key.endsWith('Url')) && typeof child === 'string') return [key, redactUrl(child)];
        if (Array.isArray(child)) {
          return [key, child.map((item) => (item && typeof item === 'object' ? this.redactUrls(item as Record<string, unknown>) : item))];
        }
        if (child && typeof child === 'object') return [key, this.redactUrls(child as Record<string, unknown>)];
        return [key, child];
      }),
    );
  }
}
