import { BrowserRuntimeError } from '../index.js';
import type { BrowserSessionOptions } from '../index.js';
import { loginOptionsFromFile } from './login-configuration.js';

function readBoolean(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = environment[name];
  if (value === undefined) return defaultValue;
  if (value === '0') return false;
  if (value === '1') return true;
  throw new BrowserRuntimeError(`${name} must be 0 or 1.`, 'INVALID_CONFIGURATION', { name });
}

function readList(value: string | undefined): string[] | undefined {
  const items = value?.split(',').map((item) => item.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

const NOTIFY_CHANNELS = ['mcp', 'desktop', 'webhook'] as const;

/** BROWSER_CHALLENGE_NOTIFY lists channels (default mcp). The MCP channel is handled by the adapter. */
export function challengeChannels(environment: NodeJS.ProcessEnv): (typeof NOTIFY_CHANNELS)[number][] {
  const channels = readList(environment.BROWSER_CHALLENGE_NOTIFY) ?? ['mcp'];
  const unknown = channels.filter((channel) => !(NOTIFY_CHANNELS as readonly string[]).includes(channel));
  if (unknown.length) throw new BrowserRuntimeError(`BROWSER_CHALLENGE_NOTIFY accepts ${NOTIFY_CHANNELS.join(', ')}; got ${unknown.join(', ')}.`, 'INVALID_CONFIGURATION');
  return channels as (typeof NOTIFY_CHANNELS)[number][];
}

function challengeOptions(environment: NodeJS.ProcessEnv): Pick<BrowserSessionOptions, 'challengeNotify' | 'challengeWebhookUrl' | 'handoffPatterns'> {
  const core = challengeChannels(environment).filter((channel): channel is 'desktop' | 'webhook' => channel !== 'mcp');
  if (core.includes('webhook') && !environment.BROWSER_CHALLENGE_WEBHOOK_URL) {
    throw new BrowserRuntimeError('BROWSER_CHALLENGE_NOTIFY includes webhook, so set BROWSER_CHALLENGE_WEBHOOK_URL.', 'INVALID_CONFIGURATION');
  }
  const patterns = readList(environment.BROWSER_HANDOFF_PATTERNS);
  return {
    ...(core.length ? { challengeNotify: core } : {}),
    ...(environment.BROWSER_CHALLENGE_WEBHOOK_URL ? { challengeWebhookUrl: environment.BROWSER_CHALLENGE_WEBHOOK_URL } : {}),
    ...(patterns ? { handoffPatterns: patterns } : {}),
  };
}

export function browserSessionOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): BrowserSessionOptions {
  const firstPartyHosts = readList(environment.BROWSER_FIRST_PARTY_HOSTS);
  const vercelBypassHosts = readList(environment.BROWSER_VERCEL_BYPASS_HOSTS);
  const launchMode = environment.BROWSER_LAUNCH_MODE;
  if (launchMode !== undefined && launchMode !== 'virtual-display' && launchMode !== 'headless') {
    throw new BrowserRuntimeError('BROWSER_LAUNCH_MODE must be virtual-display or headless.', 'INVALID_CONFIGURATION');
  }
  if (launchMode !== undefined && environment.HEADED !== undefined) {
    throw new BrowserRuntimeError('Use BROWSER_LAUNCH_MODE or HEADED, not both.', 'INVALID_CONFIGURATION');
  }
  return {
    ...loginOptionsFromFile(environment.BROWSER_LOGIN_CONFIG_FILE),
    ...(environment.BROWSER_ARTIFACTS_DIR
      ? { artifactsDir: environment.BROWSER_ARTIFACTS_DIR }
      : {}),
    ...(launchMode ? { launchMode } : { headless: !readBoolean(environment, 'HEADED', false) }),
    isTraceEnabled: readBoolean(environment, 'BROWSER_TRACE', false),
    isRawCdpEnabled: readBoolean(environment, 'BROWSER_RAW_CDP', false),
    ...challengeOptions(environment),
    ...(firstPartyHosts ? { firstPartyHosts } : {}),
    ...(environment.BROWSER_BYPASS_HEADER_NAME
      ? { bypassHeaderName: environment.BROWSER_BYPASS_HEADER_NAME }
      : {}),
    ...(environment.BROWSER_BYPASS_HEADER_TOKEN
      ? { bypassHeaderToken: environment.BROWSER_BYPASS_HEADER_TOKEN }
      : {}),
    ...(environment.BROWSER_VERCEL_BYPASS_SECRET
      ? { vercelBypassSecret: environment.BROWSER_VERCEL_BYPASS_SECRET }
      : {}),
    ...(vercelBypassHosts ? { vercelBypassHosts } : {}),
  };
}
