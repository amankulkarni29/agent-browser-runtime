import type { ActionFailureReason } from './errors.js';

export type LocatorTarget =
  | { kind: 'ref'; ref: string }
  | { kind: 'role'; role: string; name: string }
  | { kind: 'label'; label: string }
  | { kind: 'text'; text: string }
  | { kind: 'selector'; selector: string };

export type EvidenceEvent = {
  sequence: number;
  timestamp: number;
  method: string;
  params: Record<string, unknown>;
  /** The most recent action started before this event was captured. */
  actionId?: number;
};

export type BrowserSessionOptions = {
  artifactsDir?: string | undefined;
  /** Owner-selected launch strategy. Omit to retain the legacy Playwright launcher. */
  launchMode?: 'virtual-display' | 'headless' | undefined;
  headless?: boolean | undefined;
  firstPartyHosts?: string[] | undefined;
  maxSnapshotChars?: number | undefined;
  actionTimeoutMs?: number | undefined;
  navigationTimeoutMs?: number | undefined;
  settleQuietMs?: number | undefined;
  settleTimeoutMs?: number | undefined;
  bypassHeaderName?: string | undefined;
  bypassHeaderToken?: string | undefined;
  vercelBypassSecret?: string | undefined;
  vercelBypassHosts?: string[] | undefined;
  userAgent?: string | undefined;
  locale?: string | undefined;
  launchArgs?: string[] | undefined;
  maxEvidenceEvents?: number | undefined;
  isTraceEnabled?: boolean | undefined;
  /** Expose browser_cdp and browser_cdp_wait. Off by default: raw CDP bypasses the high-level tools. */
  isRawCdpEnabled?: boolean | undefined;
  /** Extra visible-text patterns that mean a person must act (for example "Approve on your phone"). */
  handoffPatterns?: string[] | undefined;
  /** Allow browser_request_handoff when nobody can see a local window, e.g. a person watching a remote screencast. */
  allowHeadlessHandoff?: boolean | undefined;
  /** Channels that tell a person about challenges, besides the action receipt: desktop, webhook. */
  challengeNotify?: ('desktop' | 'webhook')[] | undefined;
  challengeWebhookUrl?: string | undefined;
  loginBrandConfigs?: LoginBrandConfig[] | undefined;
  accountCredentialProvider?: AccountCredentialProvider | undefined;
};

/**
 * Trusted account profile plus the approved brand/environment to sign in on. The caller (an
 * investigating agent, through an adapter) only ever sees these three opaque strings — never a
 * credential value.
 */
export type LoginTarget = {
  profile: string;
  brand: string;
  environment: string;
  /** Current DOM references obtained through browser_inspect, never credential values. */
  controls?: { usernameRef: string; passwordRef: string; submitRef: string } | undefined;
};

export type AccountCredentials = {
  email: string;
  password: string;
};

/**
 * Owner-controlled secret delivery: resolves a `LoginTarget` to real credentials outside of any
 * model-visible call. SDK callers supply this function; the MCP adapter can construct it
 * from an orchestrator-owned private configuration file.
 */
export type AccountCredentialProvider = (
  target: LoginTarget,
) => Promise<AccountCredentials | undefined> | AccountCredentials | undefined;

export type LoginSuccessSignal =
  | { kind: 'url'; pattern: string }
  | { kind: 'element'; target: LocatorTarget };

export type LoginElementSignal = {
  target: LocatorTarget;
};

export type LoginChallengeSignal = LoginElementSignal & {
  challengeType: 'mfa' | 'captcha';
};

/**
 * Owner-configured shape of one brand/environment's login flow. The model never supplies any of
 * these fields directly — it only names the `brand` and `environment` from a `LoginTarget`.
 */
export type LoginBrandConfig = {
  brand: string;
  environment: string;
  loginUrl: string;
  usernameField?: LocatorTarget | undefined;
  passwordField?: LocatorTarget | undefined;
  submitField?: LocatorTarget | undefined;
  /** Exact origins permitted to receive credentials in discovered-control mode. */
  credentialOrigins?: string[] | undefined;
  successSignal: LoginSuccessSignal;
  invalidCredentialsSignal?: LoginElementSignal | undefined;
  challengeSignals?: LoginChallengeSignal[] | undefined;
  loginTimeoutMs?: number | undefined;
};

export const LOGIN_INTERFACE_VERSION = 1;

export type LoginFailureDiagnostic = {
  phase: 'navigation' | 'username' | 'password' | 'submit' | 'success_signal';
  reason: ActionFailureReason | 'success_signal_missing';
  message: string;
};

export type LoginOutcomeBase = {
  version: typeof LOGIN_INTERFACE_VERSION;
  brand: string;
  environment: string;
  evidenceSince: number;
  diagnostic?: LoginFailureDiagnostic;
};

export type LoginOutcome =
  | (LoginOutcomeBase & { status: 'success'; runId: string; url: string })
  | (LoginOutcomeBase & {
      status: 'missing_credentials' | 'invalid_credentials' | 'unsupported_host' | 'timeout';
    })
  | (LoginOutcomeBase & { status: 'interactive_challenge'; challengeType: 'mfa' | 'captcha' });

export type SettledState = {
  networkQuiet: boolean;
  domStable: boolean;
  waitedMs: number;
};

export type HumanAttention = {
  /** challenge_detected: stop and tell the user. handoff_required: ask the user to act, then call browser_request_handoff. */
  status: 'challenge_detected' | 'handoff_required';
  checks: { type: string; category: 'challenge' | 'handoff'; source: string; url: string; detail: string; screenshotPath: string | null }[];
  message: string;
};

export type ActionReceipt = {
  runId: string;
  actionId: number;
  kind: string;
  url: string;
  title: string;
  settled: SettledState;
  evidenceSince: number;
  attention?: HumanAttention;
};

export type HandoffResult = {
  status: 'completed' | 'cleared' | 'timeout' | 'cancelled' | 'unavailable';
  waitedMs: number;
  url: string | null;
  message: string;
};

export type PageSnapshot = {
  runId: string;
  url: string;
  title: string;
  aria: string;
};

export type CloseResult = {
  closed: boolean;
  runId: string | null;
  tracePath: string | null;
  manifestPath?: string | null;
  /** report.html in the run folder, written on close with the agent's findings or a timeline only. */
  reportPath?: string | null;
  cleanup?: {
    logout: 'not-needed' | 'attempted' | 'unavailable' | 'failed';
    warnings: string[];
  };
};

export type EvidenceFilter = 'errors' | 'first-party' | 'all';

export type NetworkEvidence = {
  requestId?: string;
  /** Set when a browser_fault rule produced this response; the site's server did not. */
  injectedFault?: string;
  failure?: string | null;
  bodyState?: string;
  sequence: number;
  timestamp: number;
  url: string;
  method: string;
  status: number;
  hostClass: 'first-party' | 'third-party';
  contentType: string | null;
  bodyExcerpt: string | null;
};

export type ConsoleEvidence = {
  sequence: number;
  timestamp: number;
  level: string;
  text: string;
  location?: unknown;
  args?: unknown;
};

export type PageErrorEvidence = {
  sequence: number;
  timestamp: number;
  message: string;
  stack: string | null;
};

export type BrowserEvidence = {
  runId?: string;
  manifestPath?: string;
  droppedEvents?: number;
  truncated?: boolean;
  captureHealth?: string[];
  since: number;
  bookmark: number;
  summary: {
    totalRequests: number;
    firstPartyRequests: number;
    failedRequests: number;
    injectedFaults?: number;
    consoleErrors: number;
    pageErrors: number;
  };
  network: NetworkEvidence[];
  console: ConsoleEvidence[];
  pageErrors: PageErrorEvidence[];
  cdp: EvidenceEvent[];
  /** Recent action, verification, sequence and login outcomes, independent of noisy CDP traffic. */
  outcomes?: EvidenceEvent[];
};

export type EvidenceQuery = {
  filter?: EvidenceFilter | undefined;
  since?: number | undefined;
};

export type OverlayDismissal = {
  dismissed: boolean;
  via: string | null;
  receipt: ActionReceipt;
};

export type ScreenshotArtifact = {
  artifactId?: string;
  timestamp?: number;
  url?: string;
  actionId?: number;
  runId: string;
  path: string;
  mimeType: 'image/jpeg';
  dataBase64: string;
};
