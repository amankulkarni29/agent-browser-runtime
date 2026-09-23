import { VercelBypass } from '../../src/core/vercel-bypass.js';

describe('Vercel Protection Bypass header selection', () => {
  it('sends both bypass headers on the first request to an approved host', () => {
    const bypass = new VercelBypass({ secret: 'shh', approvedHosts: ['preview.vercel.app'] });
    expect(bypass.headersFor('https://preview.vercel.app/')).toEqual({
      'x-vercel-protection-bypass': 'shh',
      'x-vercel-set-bypass-cookie': 'true',
    });
  });

  it('sends the headers only on the bootstrap request, not on later requests to the same host', () => {
    const bypass = new VercelBypass({ secret: 'shh', approvedHosts: ['preview.vercel.app'] });
    expect(bypass.headersFor('https://preview.vercel.app/')).toBeDefined();
    expect(bypass.headersFor('https://preview.vercel.app/api/data')).toBeUndefined();
  });

  it('re-bootstraps after reset, for a fresh browser context with no cookie', () => {
    const bypass = new VercelBypass({ secret: 'shh', approvedHosts: ['preview.vercel.app'] });
    expect(bypass.headersFor('https://preview.vercel.app/')).toBeDefined();
    expect(bypass.headersFor('https://preview.vercel.app/')).toBeUndefined();

    bypass.reset();

    expect(bypass.headersFor('https://preview.vercel.app/')).toBeDefined();
  });

  it('never sends headers to a host that is not exactly on the approved list', () => {
    const bypass = new VercelBypass({ secret: 'shh', approvedHosts: ['preview.vercel.app'] });
    expect(bypass.headersFor('https://other.example.com/')).toBeUndefined();
  });

  it('never sends headers to a subdomain of an approved host', () => {
    const bypass = new VercelBypass({ secret: 'shh', approvedHosts: ['preview.vercel.app'] });
    expect(bypass.headersFor('https://api.preview.vercel.app/')).toBeUndefined();
  });

  it('never sends headers to a public-suffix sibling deployment, such as another *.vercel.app host', () => {
    // A naive registrable-domain check would treat these two hosts as the same site, because
    // vercel.app is a public suffix. Matching must be exact-hostname only.
    const bypass = new VercelBypass({ secret: 'shh', approvedHosts: ['approved-deploy.vercel.app'] });
    expect(bypass.headersFor('https://sibling-deploy.vercel.app/')).toBeUndefined();
  });

  it('is case-insensitive on the approved host', () => {
    const bypass = new VercelBypass({ secret: 'shh', approvedHosts: ['Preview.Vercel.App'] });
    expect(bypass.headersFor('https://preview.vercel.app/')).toBeDefined();
  });

  it('ignores an unparseable URL rather than throwing', () => {
    const bypass = new VercelBypass({ secret: 'shh', approvedHosts: ['preview.vercel.app'] });
    expect(bypass.headersFor('not-a-url')).toBeUndefined();
  });
});
