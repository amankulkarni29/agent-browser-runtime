import { chromium, type Browser, type Page } from 'playwright';
import { waitForLoginSubmit } from '../../src/core/login-verification.js';

let browser: Browser;
let page: Page;
const provider = 'https://challenges.cloudflare.com';

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
afterEach(async () => { await page?.context().close(); });

async function fixture(mode = 'normal') {
  const context = await browser.newContext();
  page = await context.newPage();
  await page.route('https://login.example.test/**', route => route.fulfill({ contentType: 'text/html', body: `
    <button id="submit" disabled>Log in</button><div id="wrap" style="margin:80px">
      <div id="frame-host"></div><script>document.querySelector("#frame-host").attachShadow({mode:"closed"}).innerHTML='<iframe src="${mode === 'wrong-origin' ? 'https://untrusted.example.test' : provider}/turnstile/widget" style="width:320px;height:180px;border:4px solid"></iframe>';</script>
    </div><output id="clicks">0</output>
    <script>window.addEventListener('message',e=>{if(e.data==='verified'){document.querySelector('#clicks').textContent=String(Number(document.querySelector('#clicks').textContent)+1);${mode === 'no-success' ? '' : "document.querySelector('#submit').disabled=false;"}}});</script>
    ${mode === 'overlay' ? '<div style="position:fixed;inset:0;z-index:999;background:#aaa">Overlay</div>' : ''}
  ` }));
  await page.route('**/turnstile/widget', route => route.fulfill({ contentType: 'text/html', body: `
    <style>body{${mode === 'invisible-ancestor' ? 'opacity:0' : ''}}</style><div id="host"></div><script>
      const root=document.querySelector('#host').attachShadow({mode:'closed'});
      root.innerHTML='<style>input{width:28px;height:28px;margin:30px}${mode === 'hidden' ? 'input{visibility:hidden}' : ''}${['transparent', 'hidden-label-ancestor'].includes(mode) ? 'input{opacity:0}' : ''}${mode === 'invisible-label' ? 'label{opacity:0}' : ''}</style><label><input type="checkbox" ${mode === 'disabled' ? 'disabled' : ''} ${mode === 'checked' ? 'checked' : ''}>Verify you are human</label>${mode === 'ambiguous' ? '<input type="checkbox">' : ''}';
      ${mode === 'hidden-label-ancestor' ? "const control=root.querySelector('input');control.id='verification';root.append(control);const label=root.querySelector('label');label.htmlFor='verification';const hidden=document.createElement('div');hidden.style.opacity='0';root.append(hidden);hidden.append(label);" : ''}
      root.addEventListener('click',e=>{if(e.target instanceof HTMLInputElement){parent.postMessage('verified','*')}});
    </script>
  ` }));
  await page.goto('https://login.example.test/');
  return page.locator('#submit');
}

it('enables login through an actual visible checkbox in a closed-shadow provider iframe', async () => {
  const submit = await fixture();
  expect(await submit.isEnabled()).toBe(false);
  const result = await waitForLoginSubmit(page, submit, { timeoutMs: 1500, assertActive: () => {} });
  expect(result.clicks).toBe(1);
  expect(await submit.isEnabled()).toBe(true);
  expect(await page.locator('#clicks').textContent()).toBe('1');
});

it('handles a transparent native input backed by its visible verification label', async () => {
  const submit = await fixture('transparent');
  expect((await waitForLoginSubmit(page, submit, { timeoutMs: 1500, assertActive: () => {} })).clicks).toBe(1);
  expect(await submit.isEnabled()).toBe(true);
});

it.each(['hidden', 'ambiguous', 'wrong-origin', 'overlay', 'disabled', 'checked', 'invisible-label', 'invisible-ancestor', 'hidden-label-ancestor'])('does not activate %s verification controls', async (mode) => {
  const submit = await fixture(mode);
  await expect(waitForLoginSubmit(page, submit, { timeoutMs: 350, assertActive: () => {} })).rejects.toMatchObject({ metadata: { reason: 'target_disabled' } });
  expect(await page.locator('#clicks').textContent()).toBe('0');
});

it('does not repeat a click when the provider has not enabled submit', async () => {
  const submit = await fixture('no-success');
  await expect(waitForLoginSubmit(page, submit, { timeoutMs: 500, assertActive: () => {} })).rejects.toMatchObject({ metadata: { reason: 'target_disabled' } });
  expect(await page.locator('#clicks').textContent()).toBe('1');
});

it('does not inspect or activate verification when submit is already enabled', async () => {
  const submit = await fixture();
  await submit.evaluate(node => { (node as HTMLButtonElement).disabled = false; });
  const beforeClick = jest.fn();
  expect(await waitForLoginSubmit(page, submit, { timeoutMs: 500, assertActive: () => {}, beforeClick })).toEqual({ clicks: 0 });
  expect(beforeClick).not.toHaveBeenCalled();
  expect(await page.locator('#clicks').textContent()).toBe('0');
});

it('rechecks overlays immediately before clicking', async () => {
  const submit = await fixture();
  const beforeClick = async () => { await page.evaluate(() => {
    const overlay = document.createElement('div'); overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:black'; document.body.append(overlay);
  }); };
  await expect(waitForLoginSubmit(page, submit, { timeoutMs: 350, assertActive: () => {}, beforeClick })).rejects.toMatchObject({ metadata: { reason: 'target_disabled' } });
  expect(await page.locator('#clicks').textContent()).toBe('0');
});

it('honors session cancellation after inspection and before pointer input', async () => {
  const submit = await fixture();
  let cancelled = false;
  const assertActive = () => { if (cancelled) throw new Error('Session cancelled'); };
  await expect(waitForLoginSubmit(page, submit, { timeoutMs: 500, assertActive, beforeClick: async () => { cancelled = true; } })).rejects.toThrow('Session cancelled');
  expect(await page.locator('#clicks').textContent()).toBe('0');
});

it('does not click a frame detached during pre-click validation', async () => {
  const submit = await fixture();
  await expect(waitForLoginSubmit(page, submit, { timeoutMs: 350, assertActive: () => {}, beforeClick: async () => { await page.locator('#frame-host').evaluate(node => node.remove()); } })).rejects.toMatchObject({ metadata: { reason: 'target_disabled' } });
  expect(await page.locator('#clicks').textContent()).toBe('0');
});

it('does not use stale coordinates while the embedding frame keeps moving', async () => {
  const submit = await fixture();
  let offset = 80;
  await expect(waitForLoginSubmit(page, submit, { timeoutMs: 350, assertActive: () => {}, beforeClick: async () => { offset += 10; await page.locator('#wrap').evaluate((node, value) => { (node as HTMLElement).style.marginLeft = `${value}px`; }, offset); } })).rejects.toMatchObject({ metadata: { reason: 'target_disabled' } });
  expect(await page.locator('#clicks').textContent()).toBe('0');
});
