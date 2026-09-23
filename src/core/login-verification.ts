import type { CDPSession, ElementHandle, Frame, Locator, Page } from 'playwright';
import { BrowserRuntimeError, actionFailure } from './errors.js';

const PROVIDER_ORIGIN = 'https://challenges.cloudflare.com';
const MAX_WAIT_MS = 45_000;
type SubmitControl = Locator | ElementHandle<HTMLElement | SVGElement>;
type DomNode = { nodeName: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode; documentURL?: string };
type Point = { x: number; y: number };
type Candidate = { frame: Frame; cdp: CDPSession; backendNodeId: number; point: Point };
type WaitOptions = { timeoutMs: number; assertActive(): void; beforeClick?(): Promise<void> };

function providerFrame(frame: Frame, page: Page): boolean {
  // Direct child frames let us verify both coordinate spaces without guessing offsets through
  // nested/transformed frames. A frame URL alone never authorizes a credential submission.
  if (frame.parentFrame() !== page.mainFrame() || frame.isDetached()) return false;
  try { return new URL(frame.url()).origin === PROVIDER_ORIGIN; } catch { return false; }
}

function providerDocuments(root: DomNode, url: string): DomNode[] {
  const found: DomNode[] = [];
  const pending = [root];
  for (let visited = 0; pending.length && visited < 10_000; visited++) {
    const node = pending.pop()!;
    if (node.documentURL === url) found.push(node);
    pending.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    if (node.contentDocument) pending.push(node.contentDocument);
  }
  return found;
}

function checkboxes(root: DomNode): number[] {
  const result: number[] = [];
  const queue = [root];
  for (let visited = 0; queue.length && visited < 10_000; visited++) {
    const node = queue.pop()!;
    const attrs = node.attributes ?? [];
    const typeIndex = attrs.indexOf('type');
    if (node.nodeName === 'INPUT' && typeIndex >= 0 && attrs[typeIndex + 1]?.toLowerCase() === 'checkbox') result.push(node.backendNodeId);
    // Do not enter another iframe's contentDocument: its origin is a separate trust boundary.
    queue.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
  }
  return result;
}

/** Runs read-only against the actual input, including a provider-owned closed shadow root. */
function checkboxPoint(this: HTMLInputElement): Point | null {
  if (!(this instanceof HTMLInputElement) || this.type !== 'checkbox' || this.checked || this.disabled || !this.isConnected) return null;
  const bounds = this.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const style = getComputedStyle(this);
  if (style.visibility !== 'visible' || style.display === 'none' || style.pointerEvents === 'none') return null;
  function painted(element: Element, transparentInput = false): boolean {
    for (let ancestor: Element | null = element; ancestor;) {
      const s = getComputedStyle(ancestor);
      if (s.visibility !== 'visible' || s.display === 'none' || s.pointerEvents === 'none'
        || (!(transparentInput && ancestor === element) && Number(s.opacity) === 0)) return false;
      const root = ancestor.getRootNode();
      ancestor = ancestor.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return true;
  }
  if (!painted(this, true)) return null;
  // Turnstile uses a transparent input over a visible label. Permit that native pattern only
  // when a real associated label is painted; never activate a wholly invisible checkbox.
  if (Number(style.opacity) === 0 && !Array.from(this.labels ?? []).some(label => {
    const b = label.getBoundingClientRect();
    return painted(label) && b.width > 0 && b.height > 0;
  })) return null;
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  let current: Element = this;
  for (;;) {
    const s = getComputedStyle(current);
    if (s.visibility !== 'visible' || s.display === 'none' || (current !== this && Number(s.opacity) === 0)) return null;
    const root = current.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot)) return null;
    const hit = root.elementFromPoint(x, y);
    if (hit !== current && !current.contains(hit)) return null;
    if (root instanceof Document) break;
    current = root.host;
  }
  return { x, y };
}

async function inputPoint(cdp: CDPSession, backendNodeId: number): Promise<Point | null> {
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
  if (!object.objectId) return null;
  try {
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: checkboxPoint.toString(), returnByValue: true,
    });
    const point = result.value;
    return !exceptionDetails && point && typeof point.x === 'number' && typeof point.y === 'number'
      && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
  } finally { await cdp.send('Runtime.releaseObject', { objectId: object.objectId }); }
}

async function viewportPoint(frame: Frame, point: Point): Promise<Point | null> {
  const element = await frame.frameElement();
  try {
    const box = await element.boundingBox();
    if (!box) return null;
    const geometry = await element.evaluate((node, local) => {
      if (!(node instanceof HTMLIFrameElement) || !node.isConnected) return null;
      // Reject transformed embedding trees rather than guessing a pointer location.
      for (let parent: Element | null = node; parent;) {
        const style = getComputedStyle(parent);
        if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0 || style.transform !== 'none' || Number(style.zoom) !== 1) return null;
        parent = parent.parentElement ?? (parent.getRootNode() instanceof ShadowRoot ? (parent.getRootNode() as ShadowRoot).host : null);
      }
      const rect = node.getBoundingClientRect();
      const x = rect.x + node.clientLeft + local.x, y = rect.y + node.clientTop + local.y;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
      let current: Element = node;
      for (;;) {
        const root = current.getRootNode();
        if (!(root instanceof Document || root instanceof ShadowRoot)) return null;
        const hit = root.elementFromPoint(x, y);
        if (hit !== current && !current.contains(hit)) return null;
        if (root instanceof Document) break;
        current = root.host;
      }
      return { left: node.clientLeft, top: node.clientTop, width: rect.width, height: rect.height };
    }, point);
    if (!geometry || Math.abs(geometry.width - box.width) > 1 || Math.abs(geometry.height - box.height) > 1) return null;
    return { x: box.x + geometry.left + point.x, y: box.y + geometry.top + point.y };
  } finally { await element.dispose(); }
}

/** Completes only a visible native verification checkbox using ordinary pointer input. */
export async function waitForLoginSubmit(page: Page, submit: SubmitControl, options: WaitOptions): Promise<{ clicks: number }> {
  options.assertActive();
  if (await submit.isEnabled()) return { clicks: 0 };
  const deadline = Date.now() + Math.max(0, Math.min(options.timeoutMs, MAX_WAIT_MS));
  let clicks = 0;
  let inspectionFailed = false;
  const sessions = new Map<Frame, CDPSession>();
  let mainSession: CDPSession | undefined;
  try {
    do {
      options.assertActive();
      if (await submit.isEnabled()) return { clicks };
      if (!clicks) {
        const candidates: Candidate[] = [];
        for (const frame of page.frames().filter(frame => providerFrame(frame, page))) {
          try {
            let cdp = sessions.get(frame);
            if (!cdp) {
              try { cdp = await page.context().newCDPSession(frame); }
              catch (error) {
                if (!(error instanceof Error) || !error.message.includes('part of the parent frame')) throw error;
                // Chromium can keep the provider in the parent's renderer. Read only that
                // provider's document below; never treat the top login form as verification.
                mainSession ??= await page.context().newCDPSession(page);
                cdp = mainSession;
              }
              sessions.set(frame, cdp);
            }
            const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
            const documents = providerDocuments(root, frame.url());
            if (documents.length !== 1) continue;
            for (const backendNodeId of checkboxes(documents[0]!)) {
              const local = await inputPoint(cdp, backendNodeId);
              const point = local && await viewportPoint(frame, local);
              if (point) candidates.push({ frame, cdp, backendNodeId, point });
            }
          } catch (error) {
            options.assertActive();
            // Frame reload/detachment is expected while verification loads. Other inspection
            // failures remain observable without exposing provider page content or values.
            if (!frame.isDetached() && !inspectionFailed) {
              inspectionFailed = true;
              console.warn('BrowserSession: login verification inspection unavailable', { errorType: error instanceof Error ? error.name : 'UnknownError' });
            }
          }
        }
        if (candidates.length === 1) {
          const candidate = candidates[0]!;
          options.assertActive();
          await options.beforeClick?.();
          options.assertActive();
          if (await submit.isEnabled()) return { clicks };
          // Re-resolve geometry and hit testing after all async work. Stale or moved controls
          // are observed again next iteration, never clicked at an old screenshot coordinate.
          if (providerFrame(candidate.frame, page)) {
            const local = await inputPoint(candidate.cdp, candidate.backendNodeId);
            const point = local && await viewportPoint(candidate.frame, local);
            options.assertActive();
            if (Date.now() < deadline && point && Math.abs(point.x - candidate.point.x) < 1 && Math.abs(point.y - candidate.point.y) < 1) {
              clicks++;
              await page.mouse.click(point.x, point.y);
            }
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new BrowserRuntimeError('Login submit remained disabled after verification readiness wait.', 'ACTION_FAILED', actionFailure('target_disabled'));
  } finally {
    await Promise.all([...new Set(sessions.values())].map(session => session.detach().catch(() => {
      // A detached/closed browser has already released its debugging session.
      if (!page.isClosed()) console.warn('BrowserSession: login verification inspection cleanup unavailable');
    })));
  }
}
