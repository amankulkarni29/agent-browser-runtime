const VERCEL_PROTECTION_BYPASS_HEADER = 'x-vercel-protection-bypass';
const VERCEL_SET_BYPASS_COOKIE_HEADER = 'x-vercel-set-bypass-cookie';

export type VercelBypassConfig = {
  secret: string;
  approvedHosts: string[];
};

/**
 * Sends Vercel's Protection Bypass for Automation header to an exact, explicitly approved
 * deployment host only, and only on that host's first request in the session. Vercel returns a
 * deployment-scoped cookie on that response, so every later request on the same host — including
 * the model's own navigation — continues through the protected deployment on the cookie alone.
 *
 * Matching is always exact-hostname equality, never a suffix or registrable-domain check. A
 * suffix check would treat sibling deployments on a shared public suffix (`a.vercel.app` and
 * `b.vercel.app`) as the same site and leak the secret to a host nobody approved.
 */
export class VercelBypass {
  private readonly approvedHosts: Set<string>;
  private readonly bootstrappedHosts = new Set<string>();

  constructor(private readonly config: VercelBypassConfig) {
    this.approvedHosts = new Set(config.approvedHosts.map((host) => host.toLowerCase()));
  }

  /** Extra headers for this request, or undefined when it must not receive the bypass secret. */
  headersFor(rawUrl: string): Record<string, string> | undefined {
    let host: string;
    try {
      host = new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    if (!this.approvedHosts.has(host) || this.bootstrappedHosts.has(host)) return undefined;
    this.bootstrappedHosts.add(host);
    return {
      [VERCEL_PROTECTION_BYPASS_HEADER]: this.config.secret,
      [VERCEL_SET_BYPASS_COOKIE_HEADER]: 'true',
    };
  }

  /** Forget which hosts were already bootstrapped, so a fresh browser context re-bootstraps. */
  reset(): void {
    this.bootstrappedHosts.clear();
  }
}
