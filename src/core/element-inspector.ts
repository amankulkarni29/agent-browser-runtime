import type { CDPSession, ElementHandle, Frame, Page } from 'playwright';
import { BrowserRuntimeError } from './errors.js';

export type InspectTarget = { selector?: string | undefined; name?: string | undefined; role?: string | undefined;
  frameId?: string | undefined; ref?: string | undefined; index?: number | undefined };

/** References retain DOM identity rather than silently following a selector to a replacement node. */
export class ElementInspector {
  private frames = new Map<string, Frame>();
  private elements = new Map<string, ElementHandle<SVGElement | HTMLElement>>();
  private nextFrame = 0;
  private nextElement = 0;
  private cdp: CDPSession | undefined;
  private stylesheets = new Map<string, { sourceURL: string; startLine: number }>();

  constructor(private readonly page: Page) {}

  async attach(session: CDPSession): Promise<void> {
    session.on('CSS.styleSheetAdded', ({ header }: { header: { styleSheetId: string; sourceURL: string; startLine: number } }) => {
      this.stylesheets.set(header.styleSheetId, header);
      if (this.stylesheets.size > 1000) { const first = this.stylesheets.keys().next().value; if (first) this.stylesheets.delete(first); }
    });
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    this.cdp = session;
  }

  listFrames() {
    for (const frame of this.page.frames()) {
      if (![...this.frames.values()].includes(frame)) this.frames.set(`frame-${++this.nextFrame}`, frame);
    }
    for (const [id, frame] of this.frames) if (frame.isDetached()) this.frames.delete(id);
    return [...this.frames].map(([id, frame]) => ({ id, url: frame.url(), name: frame.name(), main: frame === this.page.mainFrame() }));
  }

  async resolve(target: InspectTarget): Promise<{ ref: string; element: ElementHandle<SVGElement | HTMLElement> }> {
    if (target.ref) {
      const element = this.elements.get(target.ref);
      if (!element || !await element.evaluate((node) => node.isConnected).catch(() => false)) {
        throw new BrowserRuntimeError('Element reference is stale. Inspect the current page again.', 'INVALID_STATE');
      }
      return { ref: target.ref, element };
    }
    this.listFrames();
    const frame = target.frameId ? this.frames.get(target.frameId) : this.page.mainFrame();
    if (!frame) throw new BrowserRuntimeError('Frame is unknown or detached.', 'INVALID_STATE');
    if (!target.selector && !target.name && !target.role) throw new BrowserRuntimeError('Supply a selector, accessible name, role, or element ref.', 'INVALID_CONFIGURATION');
    const locator = target.selector ? frame.locator(target.selector) : target.role
      ? frame.getByRole(target.role as Parameters<Frame['getByRole']>[0], target.name === undefined ? {} : { name: target.name, exact: true })
      : frame.getByText(target.name ?? '', { exact: true });
    const count = await locator.count();
    if (count !== 1 && target.index === undefined) {
      throw new BrowserRuntimeError(`Target matched ${count} elements. Supply a more specific target or explicit index.`, 'ACTION_FAILED');
    }
    const index = target.index ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new BrowserRuntimeError('Element index is out of range.', 'ACTION_FAILED');
    const element = await locator.nth(index).elementHandle();
    if (!element) throw new BrowserRuntimeError('Element disappeared during inspection.', 'ACTION_FAILED');
    const ref = `element-${++this.nextElement}`;
    this.elements.set(ref, element);
    if (this.elements.size > 100) {
      const oldest = this.elements.entries().next().value;
      if (oldest) { this.elements.delete(oldest[0]); await oldest[1].dispose(); }
    }
    return { ref, element };
  }

  async inspect(target: InspectTarget, properties?: string[]) {
    const { ref, element } = await this.resolve(target);
    const requested = properties ?? ['display', 'visibility', 'opacity', 'color', 'background-color', 'font-size',
      'position', 'z-index', 'width', 'height', 'padding', 'margin', 'overflow', 'transform', 'pointer-events'];
    if (requested.length > 60 || requested.some((p) => !/^[-a-zA-Z0-9]+$/.test(p))) {
      throw new BrowserRuntimeError('Supply at most 60 CSS property names.', 'INVALID_CONFIGURATION');
    }
    const detail = await element.evaluate((node, props) => {
      const styles = (pseudo: string | null) => {
        const computed = getComputedStyle(node, pseudo);
        return Object.fromEntries(props.map((key) => [key, computed.getPropertyValue(key)]));
      };
      const rect = node.getBoundingClientRect();
      const cloned = node.cloneNode(true) as Element;
      const secret = /(authorization|cookie|token|secret|password|api[-_]?key|value)/i;
      for (const child of [cloned, ...cloned.querySelectorAll('*')]) {
        for (const attr of [...child.attributes]) if (secret.test(attr.name) || /^on/i.test(attr.name)) child.removeAttribute(attr.name);
        if (child.matches('input,textarea,script')) child.textContent = '';
      }
      const rules: Array<{ selector: string; css: string; sourceUrl: string; rulePath: string; active: boolean }> = [];
      const unavailable: string[] = [];
      let visited = 0;
      const walk = (list: CSSRuleList, sourceUrl: string, parent: string, active: boolean) => {
        for (let index = 0; index < list.length && visited < 5_000 && rules.length < 100; index++) {
          visited++;
          const rule = list[index];
          if (!rule) continue;
          const rulePath = parent ? `${parent}.${index}` : String(index);
          if (rule instanceof CSSStyleRule) {
            // Pseudo-element rules apply to a pseudo box, not the element itself.
            const selector = rule.selectorText.replace(/::(before|after)/g, '');
            try {
              if (node.matches(selector)) rules.push({ selector: rule.selectorText, css: rule.style.cssText.slice(0, 4_000), sourceUrl, rulePath, active });
            } catch { unavailable.push(`Unsupported selector: ${rule.selectorText}`); }
          } else if ('cssRules' in rule) {
            const enabled = rule instanceof CSSMediaRule ? active && matchMedia(rule.conditionText).matches
              : rule instanceof CSSSupportsRule ? active && CSS.supports(rule.conditionText) : active;
            walk((rule as CSSGroupingRule).cssRules, sourceUrl, rulePath, enabled);
          }
        }
      };
      const root = node.getRootNode();
      const sheets = root instanceof ShadowRoot ? [...root.querySelectorAll('style')].flatMap((style) => style.sheet ? [style.sheet] : [])
        : [...document.styleSheets];
      if ('adoptedStyleSheets' in root) sheets.push(...(root as Document | ShadowRoot).adoptedStyleSheets);
      for (const sheet of props.length ? sheets : []) {
        const source = sheet.href ?? document.URL;
        try { walk(sheet.cssRules, source, '', !sheet.disabled); }
        catch { unavailable.push(source); }
      }
      return {
        url: document.URL, tag: node.tagName.toLowerCase(),
        attributes: Object.fromEntries([...node.attributes].map((attr) => [attr.name, secret.test(attr.name) ? '[REDACTED]' : attr.value.slice(0, 2_000)])),
        html: cloned.outerHTML.slice(0, 12_000), htmlTruncated: cloned.outerHTML.length > 12_000,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computed: styles(null), pseudo: { before: styles('::before'), after: styles('::after') },
        matchedRules: rules, stylesUnavailable: unavailable.slice(0, 20), rulesTruncated: visited >= 5_000 || rules.length >= 100,
        styleScope: props.length ? 'CSSOM candidates; rulePath is a stylesheet rule index, not a source line. Cross-origin sheets and inherited rules may be unavailable.' : 'Styles omitted: properties was empty.',
      };
    }, requested);
    const sourceRules = requested.length ? await this.sourceRules(element)
      : { sourceRules: [], sourceRulesUnavailable: 'Styles omitted: properties was empty.' };
    return { ref, ...detail, ...sourceRules };
  }

  private async sourceRules(element: ElementHandle<SVGElement | HTMLElement>) {
    const unavailable = (reason: string) => ({ sourceRules: [], sourceRulesUnavailable: reason });
    if (!this.cdp) return unavailable('CDP CSS inspection is unavailable.');
    if (await element.ownerFrame() !== this.page.mainFrame()) return unavailable('Child frame source rules are not attached; use computed styles and CSSOM candidates.');
    const selector = await element.evaluate((node) => {
      if (node.getRootNode() instanceof ShadowRoot) return null;
      const parts: string[] = [];
      let current: Element | null = node;
      while (current) {
        const tag = CSS.escape(current.localName);
        const siblings: Element[] = current.parentElement ? [...current.parentElement.children].filter((e) => e.localName === current?.localName) : [current];
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    });
    if (!selector) return unavailable('Shadow root source rules require a separate DOM target; computed styles remain available.');
    try {
      const { root } = await this.cdp.send('DOM.getDocument');
      const { nodeId } = await this.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) return unavailable('Element changed while source rules were read.');
      const matched = await this.cdp.send('CSS.getMatchedStylesForNode', { nodeId });
      const format = (matches: typeof matched.matchedCSSRules, inherited: boolean, pseudo: string | null) => (matches ?? []).slice(0, 100).map(({ rule, matchingSelectors }) => {
        const header = rule.styleSheetId ? this.stylesheets.get(rule.styleSheetId) : undefined;
        const range = rule.style.range;
        return { selector: rule.selectorList.text, matchingSelectors, origin: String(rule.origin), inherited, pseudo,
          sourceUrl: header?.sourceURL ?? this.page.url(),
          line: range ? (header?.startLine ?? 0) + range.startLine + 1 : null,
          properties: rule.style.cssProperties.slice(0, 100).map(({ name, value, important, disabled }) => ({ name, value, important: important ?? false, disabled: disabled ?? false })) };
      });
      return { sourceRules: [...format(matched.matchedCSSRules, false, null),
        ...(matched.inherited ?? []).slice(0, 10).flatMap((entry) => format(entry.matchedCSSRules, true, null)),
        ...(matched.pseudoElements ?? []).flatMap((entry) => format(entry.matches, false, entry.pseudoType))].slice(0, 200),
        sourceRulesUnavailable: null };
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : 'CDP CSS inspection failed.');
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.elements.values()].map((element) => element.dispose().catch(() => undefined)));
    this.elements.clear(); this.frames.clear();
  }
}
