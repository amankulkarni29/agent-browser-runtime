import { createServer, type Server } from 'node:http';

const VERCEL_BYPASS_COOKIE = 'vercel_bypass=granted';
export const TEST_ACCOUNT_EMAIL = 'qa-dummy@example.com';
export const TEST_ACCOUNT_PASSWORD = 'correct-horse-battery-staple';
const SESSION_COOKIE = 'abr_session=authenticated';

function readFormBody(request: import('node:http').IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    request.on('data', (chunk) => (data += chunk));
    request.on('error', reject);
    request.on('end', () => resolvePromise(new URLSearchParams(data)));
  });
}

function loginPage(actionPath: string, alert?: string, debugEcho?: string): string {
  return `<!doctype html>
    <html>
      <head><title>Login fixture</title></head>
      <body>
        <main>
          <h1>Sign in</h1>
          ${alert ? `<p role="alert">${alert}</p>` : ''}
          ${debugEcho ? `<p role="status">${debugEcho}</p>` : ''}
          <form method="post" action="${actionPath}">
            <label>Email <input type="email" name="email" aria-label="Email"></label>
            <label>Password <input type="password" name="password" aria-label="Password"></label>
            <button type="submit">Sign in</button>
          </form>
        </main>
      </body>
    </html>`;
}

function mfaChallengePage(): string {
  return `<!doctype html>
    <html>
      <head><title>Two-factor fixture</title></head>
      <body><main><h1>Verify it's you</h1><p>Enter your verification code</p></main></body>
    </html>`;
}

function accountPage(): string {
  return `<!doctype html>
    <html>
      <head><title>Account fixture</title></head>
      <body><main><h1>Welcome back</h1><p role="status">Signed in</p></main></body>
    </html>`;
}

export async function startFixtureSite(): Promise<{
  server: Server;
  url: string;
  requestCount: () => number;
}> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    if (request.url === '/login' || request.url === '/idp-login' || request.url === '/login-mfa') {
      if (request.method !== 'POST') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(loginPage(request.url));
        return;
      }
      void readFormBody(request).then((form) => {
        const email = form.get('email') ?? '';
        const password = form.get('password') ?? '';
        const valid = email === TEST_ACCOUNT_EMAIL && password === TEST_ACCOUNT_PASSWORD;
        if (!valid) {
          response.writeHead(200, { 'content-type': 'text/html' });
          // A deliberately broken echo of the submitted credentials, so tests can prove the
          // runtime still redacts a value a misbehaving page leaks back into its own content.
          response.end(loginPage(request.url!, 'Invalid email or password', `debug: ${email} / ${password}`));
          return;
        }
        if (request.url === '/login-mfa') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(mfaChallengePage());
          return;
        }
        if (request.url === '/idp-login') {
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Fixture server has no port.');
          response.writeHead(302, { location: `http://127.0.0.1:${address.port}/account?sso=granted` });
          response.end();
          return;
        }
        response.writeHead(302, { location: '/account', 'set-cookie': `${SESSION_COOKIE}; Path=/` });
        response.end();
      });
      return;
    }
    if (request.url === '/login-sso') {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture server has no port.');
      response.writeHead(302, { location: `http://localhost:${address.port}/idp-login` });
      response.end();
      return;
    }
    if (request.url?.startsWith('/account')) {
      const cookies = request.headers.cookie ?? '';
      const authenticated = cookies.includes(SESSION_COOKIE) || request.url.includes('sso=granted');
      if (!authenticated) {
        response.writeHead(302, { location: '/login' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(accountPage());
      return;
    }
    if (request.url === '/vercel-protected') {
      const cookies = request.headers.cookie ?? '';
      const bypassHeader = request.headers['x-vercel-protection-bypass'];
      const setCookieRequested = request.headers['x-vercel-set-bypass-cookie'] === 'true';
      if (cookies.includes(VERCEL_BYPASS_COOKIE)) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(protectedPage('cookie-authorized:null'));
        return;
      }
      if (typeof bypassHeader === 'string' && setCookieRequested) {
        response.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': `${VERCEL_BYPASS_COOKIE}; Path=/`,
        });
        response.end(protectedPage(`header-authorized:${bypassHeader}`));
        return;
      }
      response.writeHead(401, { 'content-type': 'text/html' });
      response.end(protectedPage('bypass-required:null'));
      return;
    }
    if (request.url === '/vercel-redirect-to-localhost') {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture server has no port.');
      response.writeHead(302, { location: `http://localhost:${address.port}/vercel-protected` });
      response.end();
      return;
    }
    if (request.url === '/vercel-subresource-probe') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><title>Vercel subresource probe</title></head>
          <body>
            <main><h1>Subresource probe</h1><p role="status">Loading</p></main>
            <script>
              fetch('/api/vercel-header-echo')
                .then((response) => response.json())
                .then((body) => {
                  document.querySelector('[role=status]').textContent = JSON.stringify(body);
                });
            </script>
          </body>
        </html>`);
      return;
    }
    if (request.url === '/api/vercel-header-echo') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ header: request.headers['x-vercel-protection-bypass'] ?? null }));
      return;
    }
    if (request.url === '/api/header') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      response.end(
        JSON.stringify({
          host: request.headers.host,
          bypass: request.headers['x-test-bypass'] ?? null,
        }),
      );
      return;
    }
    if (request.url === '/api/order') {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'order-123', status: 'created' }));
      return;
    }
    if (request.url === '/overlay') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><title>Overlay fixture</title></head>
          <body>
            <main><h1>Product page</h1></main>
            <dialog open aria-label="Promotion">
              <p>Claim your sample</p>
              <button aria-label="Close promotion">Close</button>
            </dialog>
            <script>
              document.querySelector('[aria-label="Close promotion"]').addEventListener('click', () => {
                document.querySelector('dialog').remove();
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (request.url === '/header-probe') {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture server has no port.');
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><title>Header fixture</title></head>
          <body><main><h1>Header probe</h1><p role="status">Loading</p></main>
          <script>
            Promise.all([
              fetch('/api/header').then((response) => response.json()),
              fetch('http://localhost:${address.port}/api/header').then((response) => response.json()),
            ]).then(([firstParty, thirdParty]) => {
              document.querySelector('[role=status]').textContent = JSON.stringify({ firstParty, thirdParty });
            });
          </script>
        </html>`);
      return;
    }
    // A document that replaces itself shortly after load. The old execution context
    // is destroyed mid-settle, which is what `settle()` has to survive.
    if (request.url === '/renavigates') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><title>Renavigating fixture</title></head>
          <body>
            <main><h1>First document</h1></main>
            <script>
              setTimeout(() => location.replace('/renavigated'), 120);
            </script>
          </body>
        </html>`);
      return;
    }
    if (request.url === '/renavigated') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><title>Renavigated fixture</title></head>
          <body><main><h1>Final document</h1></main></body>
        </html>`);
      return;
    }
    if (request.url === '/external-link') {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture server has no port.');
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><title>Navigation policy fixture</title></head>
          <body><main><h1>Allowed page</h1><a href="http://localhost:${address.port}/target">Leave host</a></main></body>
        </html>`);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html>
      <html>
        <head><title>Browser runtime fixture</title></head>
        <body>
          <main>
            <h1>Loading</h1>
            <button disabled>Create order</button>
            <label>Name <input aria-label="Name"></label>
            <a href="#details">Product details</a>
            <p id="hover-result"></p>
            <button>Place order</button>
            <p role="status"></p>
          </main>
          <script>
            setTimeout(() => {
              document.querySelector('h1').textContent = 'Ready';
              document.querySelector('button').disabled = false;
              console.info('fixture ready');
            }, 150);
            document.querySelector('button').addEventListener('click', async () => {
              const response = await fetch('/api/order', { method: 'POST' });
              const order = await response.json();
              document.querySelector('[role=status]').textContent = 'Created ' + order.id;
              console.info('order created');
            });
            document.querySelector('a').addEventListener('mouseenter', () => {
              document.querySelector('#hover-result').textContent = 'Hover details visible';
            });
          </script>
        </body>
      </html>`);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind to a TCP port.');
  return { server, url: `http://127.0.0.1:${address.port}`, requestCount: () => requestCount };
}

function protectedPage(status: string): string {
  return `<!doctype html>
    <html>
      <head><title>Vercel-protected fixture</title></head>
      <body><main><h1>Protected content</h1><p role="status">${status}</p></main></body>
    </html>`;
}
