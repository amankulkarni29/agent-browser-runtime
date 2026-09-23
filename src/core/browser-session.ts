import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type BrowserContext,
  type CDPSession,
  type ElementHandle,
  type Locator,
  type Page,
  type Request,
  type Route,
} from 'playwright';
import { BrowserRuntimeError, getErrorMessage, actionFailure, diagnoseActionFailure } from './errors.js';
import { EvidenceJournal, isProtectedEvidenceEvent } from './evidence-journal.js';
import { redactKnownSecrets } from './redaction.js';
import {
  LOGIN_INTERFACE_VERSION,
  type ActionReceipt,
  type BrowserEvidence,
  type BrowserSessionOptions,
  type CloseResult,
  type ConsoleEvidence,
  type HandoffResult,
  type HumanAttention,
  type EvidenceQuery,
  type LocatorTarget,
  type LoginOutcome,
  type LoginFailureDiagnostic,
  type LoginSuccessSignal,
  type LoginTarget,
  type LoginBrandConfig,
  type NetworkEvidence,
  type OverlayDismissal,
  type PageErrorEvidence,
  type PageSnapshot,
  type ScreenshotArtifact,
  type SettledState,
} from './types.js';
import { VercelBypass } from './vercel-bypass.js';
import { NetworkRecorder } from './network-recorder.js';
import { ElementInspector, type InspectTarget } from './element-inspector.js';
import { launchBrowser } from './browser-launcher.js';
import { waitForLoginSubmit } from './login-verification.js';
import { redactUrl, redactValue } from './redaction.js';
import {
  browserConditionSchema, browserStepsSchema, browserTimeoutSchema,
  type BrowserCondition, type BrowserStep, type SequenceResult, type SequenceStepResult, type VerificationResult,
} from './action-contracts.js';
import { ActionBudget, conditionUnmet, operationDiagnostic, verificationError } from './action-verification.js';
import { explainAction, type ActionExplanation } from './action-causality.js';
import { renderReport, reportInputSchema, type ReportInput } from './run-report.js';
import { diffSnapshots, type SnapshotDiff } from './snapshot-diff.js';
import { MAX_RECORDED_STEPS, buildHar, portableCondition, renderSpec, type PortableTarget, type RecordedStep } from './test-export.js';
import { classifyFrameUrl, classifyPage, compilePatterns, humanCheckKey, type HumanCheck } from './human-checks.js';
import { watchForChallenges } from './challenge-monitor.js';
import { desktopNotifier, dispatchNotice, webhookNotifier, type ChallengeNotice, type ChallengeNotifier } from './challenge-notifier.js';
import { FaultBook, faultSchema, matchInjectedFaults, rewriteJson, type ActiveFault, type FaultRule } from './network-faults.js';

const DEFAULT_ACTION_TIMEOUT_MS = 8_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
const DEFAULT_SETTLE_QUIET_MS = 400;
const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;
const DEFAULT_SNAPSHOT_CHARS = 8_000;
const MAX_BODY_CHARS = 1_500;
const MAX_CONSOLE_CHARS = 600;
const DEFAULT_BYPASS_HEADER_NAME = 'x-agent-browser-bypass';
const ASYNC_STACK_DEPTH = 32;
const MAX_CDP_RESULT_CHARS = 50_000;
// The session owns the browser lifecycle; raw calls must not close or crash it underneath.
const BLOCKED_CDP_METHODS = new Set(['Browser.close', 'Browser.crash', 'Browser.crashGpuProcess', 'Target.closeTarget',
  'Target.disposeBrowserContext', 'Page.close', 'Page.crash']);

const CLOSE_SELECTORS = [
  '[aria-label*="close" i]',
  '[aria-label*="dismiss" i]',
  '[aria-label*="minimize" i]',
  'button:has-text("×")',
  'button:has-text("✕")',
  'button:has-text("−")',
  '[class*="close" i]',
  '[class*="minimize" i]',
  'text=/^(close|dismiss|got it|no,? thanks|not now|minimize|minimise|hide chat|close chat|end chat)$/i',
];

const CDP_EVENTS = [
  'Network.loadingFailed',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Log.entryAdded',
  'Page.frameNavigated',
  'Page.lifecycleEvent',
  'Audits.issueAdded',
] as const;

const CDP_DOMAINS = ['Network', 'Runtime', 'Log', 'Page', 'Audits'] as const;

export class BrowserSession {
  private browserResources: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  private pageStartup: Promise<Page> | undefined;
  private launchController: AbortController | undefined;
  private closing: Promise<CloseResult> | undefined;
  private authenticatedUrl: string | undefined;
  private sessionEpoch = 0;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private targetHost: string | undefined;
  private runId: string | undefined;
  private runDir: string | undefined;
  private runStartedAt = 0;
  private lastAria: string | undefined;
  private reportInput: ReportInput | undefined;
  private readonly faults = new FaultBook();
  private steps: RecordedStep[] = [];
  private readonly handoffPatterns: RegExp[];
  private readonly notifiers: ChallengeNotifier[];
  private readonly humanCheckListeners = new Set<(notice: ChallengeNotice) => void>();
  private seenHumanChecks = new Set<string>();
  private pendingAttention: HumanAttention['checks'] = [];
  private waitingForHuman = false;
  private finishHandoff: (() => void) | undefined;
  private tracePath: string | undefined;
  private traceStopped = false;
  private actionId = 0;
  private activeActionId = 0;
  private readonly journal: EvidenceJournal;
  private cdpSessions: CDPSession[] = [];
  private readonly pendingRequests = new Set<Request>();
  private lastNetworkActivityAt = 0;
  private readonly vercelBypass: VercelBypass | undefined;
  private readonly network: NetworkRecorder;
  private inspector: ElementInspector | undefined;
  private captureHealth: string[] = [];
  private artifacts: Record<string, unknown>[] = [];
  private manifestTimer: ReturnType<typeof setTimeout> | undefined;
  private manifestWrite: Promise<void> = Promise.resolve();
  private readonly baseSecrets: (string | undefined)[];
  private readonly knownSecrets: (string | undefined)[];
  // The bypass header's value is expected to appear in page content (a caller may want to see
  // that it arrived), so it is deliberately excluded here — only the Vercel secret and any
  // resolved login credential are scrubbed from the model-facing snapshot and action titles.
  private readonly baseSnapshotSecrets: (string | undefined)[];
  private readonly snapshotSecrets: (string | undefined)[];
  private hasAccountCredentials = false;
  private authentication: { status: 'success'; profile: string; brand: string; environment: string; timestamp: number } | undefined;
  private boundedOperation: ActionBudget | undefined;
  private legacyMutations = 0;

  constructor(private readonly options: BrowserSessionOptions = {}) {
    if (options.isTraceEnabled && options.accountCredentialProvider) {
      throw new BrowserRuntimeError('Tracing cannot be enabled with account login.', 'INVALID_CONFIGURATION');
    }
    this.baseSecrets = [options.vercelBypassSecret, options.bypassHeaderToken];
    this.knownSecrets = [...this.baseSecrets];
    this.baseSnapshotSecrets = [options.vercelBypassSecret];
    this.snapshotSecrets = [...this.baseSnapshotSecrets];
    this.journal = new EvidenceJournal(options.maxEvidenceEvents, this.knownSecrets, () => this.scheduleManifest(), () => this.activeActionId);
    this.network = new NetworkRecorder((url) => this.classifyHost(url), () => this.activeActionId, (record) => {
      this.journal.record('Browser.response', { requestId: record.id, actionId: record.actionId,
        url: record.url, method: record.method, status: record.status, hostClass: record.hostClass,
        failure: record.failure, bodyState: record.bodyState,
        contentType: record.responseHeaders['content-type'] ?? null,
        bodyExcerpt: record.body === null ? null : record.body.length > MAX_BODY_CHARS ? `${record.body.slice(0, MAX_BODY_CHARS)}…[truncated]` : record.body,
      });
    }, this.knownSecrets);
    this.vercelBypass = this.buildVercelBypass(options);
    this.handoffPatterns = compilePatterns(options.handoffPatterns);
    this.notifiers = [
      ...(options.challengeNotify?.includes('desktop') ? [desktopNotifier()] : []),
      ...(options.challengeNotify?.includes('webhook')
        ? [webhookNotifier(options.challengeWebhookUrl ?? '')] : []),
    ];
  }

  /** Subscribe to challenge and handoff notices (the MCP adapter forwards them as log messages). */
  onHumanCheck(listener: (notice: ChallengeNotice) => void): () => void {
    this.humanCheckListeners.add(listener);
    return () => this.humanCheckListeners.delete(listener);
  }

  private buildVercelBypass(options: BrowserSessionOptions): VercelBypass | undefined {
    const secret = options.vercelBypassSecret;
    const approvedHosts = options.vercelBypassHosts ?? [];
    if (!secret && approvedHosts.length === 0) return undefined;
    if (!secret || approvedHosts.length === 0) {
      throw new BrowserRuntimeError(
        'vercelBypassSecret and vercelBypassHosts must be configured together.',
        'INVALID_CONFIGURATION',
      );
    }
    if (options.isTraceEnabled) {
      // Playwright traces record raw request headers with no redaction hook, so tracing would
      // write the bypass secret to trace.zip on every bootstrap request.
      throw new BrowserRuntimeError(
        'Tracing cannot be enabled together with a Vercel bypass secret.',
        'INVALID_CONFIGURATION',
      );
    }
    return new VercelBypass({ secret, approvedHosts });
  }

  navigate(url: string): Promise<ActionReceipt> { return this.runLegacyMutation(() => this.navigateImpl(url)); }
  login(target: LoginTarget): Promise<LoginOutcome> { return this.runLegacyMutation(() => this.loginImpl(target)); }
  click(target: LocatorTarget): Promise<ActionReceipt> { return this.runLegacyMutation(() => this.clickImpl(target)); }
  type(target: LocatorTarget, value: string): Promise<ActionReceipt> { return this.runLegacyMutation(() => this.typeImpl(target, value)); }
  press(key: string): Promise<ActionReceipt> { return this.runLegacyMutation(() => this.pressImpl(key)); }
  hover(target: LocatorTarget): Promise<ActionReceipt> { return this.runLegacyMutation(() => this.hoverImpl(target)); }
  waitForSettled(): Promise<ActionReceipt> { return this.runLegacyMutation(() => this.waitForSettledImpl()); }
  dismissOverlay(): Promise<OverlayDismissal> { return this.runLegacyMutation(() => this.dismissOverlayImpl()); }
  viewport(width: number, height: number): Promise<ActionReceipt> { return this.runLegacyMutation(() => this.viewportImpl(width, height)); }

  private async navigateImpl(url: string): Promise<ActionReceipt> {
    await this.closing;
    const epoch = this.sessionEpoch;
    const parsed = parseNavigableUrl(url);
    this.targetHost ??= parsed.hostname;
    const page = await this.ensurePage();
    this.assertSessionEpoch(epoch);
    const bookmark = this.startAction();
    const startedAt = Date.now();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      throw new BrowserRuntimeError('Navigation failed.', 'ACTION_FAILED', {
        url,
        error: getErrorMessage(error),
      });
    }
    const settled = await this.settle(startedAt);
    await this.waitForEvidenceReads();
    this.recordStep({ kind: 'navigate', url: redactUrl(url) });
    return this.receipt('navigate', settled, bookmark);
  }

  /**
   * Sign in with a trusted account profile against an owner-configured brand/environment. The
   * Caller supplies only a profile and optional discovered DOM refs. Trusted origins and
   * credentials come from the owner. Never retries a rejected attempt automatically.
   */
  private async loginImpl(target: LoginTarget): Promise<LoginOutcome> {
    await this.closing;
    const epoch = this.sessionEpoch;
    this.authentication = undefined;
    const evidenceSince = this.checkpoint();
    const config = (this.options.loginBrandConfigs ?? []).find(
      (candidate) => candidate.brand === target.brand && candidate.environment === target.environment,
    );
    if (!config) return this.loginOutcome('unsupported_host', target, evidenceSince, { epoch });

    const controls = target.controls ? await this.discoveredLoginControls(target.controls, config) : undefined;
    this.assertSessionEpoch(epoch);
    if (!controls && (!config.usernameField || !config.passwordField || !config.submitField)) {
      throw new BrowserRuntimeError('Inspect the current login form and supply its username, password, and submit refs.', 'INVALID_CONFIGURATION');
    }

    let credentials;
    try {
      credentials = await this.options.accountCredentialProvider?.(target);
    } catch {
      this.assertSessionEpoch(epoch);
      return this.loginOutcome('missing_credentials', target, evidenceSince, { epoch });
    }
    this.assertSessionEpoch(epoch);
    if (!credentials) return this.loginOutcome('missing_credentials', target, evidenceSince, { epoch });

    this.targetHost ??= new URL(config.loginUrl).hostname;

    // Credentials are never stored on the instance; only their values are added to the shared
    // redaction list so any echo of them in a subsequent snapshot, evidence read, or exception is
    // scrubbed the same way the Vercel bypass secret already is.
    this.knownSecrets.push(credentials.email, credentials.password);
    this.snapshotSecrets.push(credentials.email, credentials.password);
    this.hasAccountCredentials = true;

    const page = await this.ensurePage();
    this.assertSessionEpoch(epoch);
    try {
      if (!controls) await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      this.assertSessionEpoch(epoch);
      const diagnostic = { phase: 'navigation', ...diagnoseActionFailure(error) } as const;
      console.error('BrowserSession: login navigation failed', {
        brand: target.brand,
        environment: target.environment,
        diagnostic,
      });
      return this.loginOutcome('timeout', target, evidenceSince, { cleanup: true, epoch, diagnostic });
    }
    this.assertSessionEpoch(epoch);
    await this.settle(Date.now());
    this.assertSessionEpoch(epoch);

    let phase: LoginFailureDiagnostic['phase'] = 'username';
    try {
      if (controls) {
        await controls.username.fill(credentials.email);
        this.assertSessionEpoch(epoch);
        phase = 'password';
        await controls.password.fill(credentials.password);
        this.assertSessionEpoch(epoch);
        phase = 'submit';
        // Refs preserve DOM identity. Recheck the live origin, form, and visibility after
        // filling, since input handlers may have changed them, then submit the checked node.
        const validated = await this.discoveredLoginControls(target.controls!, config);
        this.assertSessionEpoch(epoch);
        await this.waitForLoginVerification(page, validated.submit, config, target, epoch);
        const ready = await this.discoveredLoginControls(target.controls!, config);
        this.assertSessionEpoch(epoch);
        await ready.submit.click();
      } else {
        await this.locate(config.usernameField!).fill(credentials.email);
        this.assertSessionEpoch(epoch);
        phase = 'password';
        await this.locate(config.passwordField!).fill(credentials.password);
        this.assertSessionEpoch(epoch);
        phase = 'submit';
        const submit = this.locate(config.submitField!);
        await this.waitForLoginVerification(page, submit, config, target, epoch);
        await submit.click();
      }
    } catch (error) {
      this.assertSessionEpoch(epoch);
      const diagnostic = { phase, ...diagnoseActionFailure(error) };
      console.error('BrowserSession: login fill/submit failed', {
        brand: target.brand,
        environment: target.environment,
        diagnostic,
      });
      return this.loginOutcome('timeout', target, evidenceSince, { cleanup: true, epoch, diagnostic });
    }
    this.assertSessionEpoch(epoch);
    await this.settle(Date.now());
    this.assertSessionEpoch(epoch);

    const deadline = Date.now() + (config.loginTimeoutMs ?? 10_000);
    do {
      this.assertSessionEpoch(epoch);
      for (const challenge of config.challengeSignals ?? []) {
        if (await this.isVisible(challenge.target)) {
          this.assertSessionEpoch(epoch);
          this.journal.record('Browser.login', { brand: target.brand, environment: target.environment, status: 'interactive_challenge', challengeType: challenge.challengeType });
          await this.persistManifest();
          this.assertSessionEpoch(epoch);
          await this.close();
          return { version: LOGIN_INTERFACE_VERSION, status: 'interactive_challenge', brand: target.brand, environment: target.environment, evidenceSince, challengeType: challenge.challengeType };
        }
      }
      if (config.invalidCredentialsSignal && (await this.isVisible(config.invalidCredentialsSignal.target))) {
        return this.loginOutcome('invalid_credentials', target, evidenceSince, { cleanup: true, epoch });
      }
      if (await this.matchesSuccessSignal(config.successSignal)) {
        this.assertSessionEpoch(epoch);
        this.authenticatedUrl = page.url();
        this.authentication = { status: 'success', profile: target.profile, brand: target.brand, environment: target.environment, timestamp: Date.now() };
        this.journal.record('Browser.login', { brand: target.brand, environment: target.environment, status: 'success' });
        this.recordStep({ kind: 'note', text: `Signed in with account profile "${target.profile}" (${target.brand}/${target.environment}). Credentials are never exported; add your own login steps.` });
        await this.persistManifest();
        this.assertSessionEpoch(epoch);
        return {
          version: LOGIN_INTERFACE_VERSION,
          status: 'success',
          brand: target.brand,
          environment: target.environment,
          evidenceSince,
          runId: this.assertRunId(),
          url: redactUrl(this.assertPage().url()),
        };
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    } while (Date.now() < deadline);

    return this.loginOutcome('timeout', target, evidenceSince, { cleanup: true, epoch, diagnostic: {
      phase: 'success_signal', reason: 'success_signal_missing',
      message: 'The submit action completed, but the configured signed-in signal was not observed before the deadline. This does not establish whether the credentials were accepted.',
    } });
  }

  private async waitForLoginVerification(page: Page, submit: Parameters<typeof waitForLoginSubmit>[1], config: LoginBrandConfig, target: LoginTarget, epoch: number): Promise<void> {
    const result = await waitForLoginSubmit(page, submit, {
      timeoutMs: config.loginTimeoutMs ?? 30_000,
      assertActive: () => this.assertSessionEpoch(epoch),
      beforeClick: async () => {
        if (target.controls) await this.discoveredLoginControls(target.controls, config);
      },
    });
    this.assertSessionEpoch(epoch);
    if (result.clicks) this.journal.record('Browser.loginVerification', { method: 'visible-checkbox', clicks: result.clicks });
  }

  private async isVisible(target: LocatorTarget): Promise<boolean> {
    try {
      return await this.locate(target).isVisible({ timeout: 200 });
    } catch {
      return false;
    }
  }

  private async discoveredLoginControls(controls: NonNullable<LoginTarget['controls']>, config: LoginBrandConfig) {
    const inspector = this.assertInspector();
    const username = (await inspector.resolve({ ref: controls.usernameRef })).element;
    const password = (await inspector.resolve({ ref: controls.passwordRef })).element;
    const submit = (await inspector.resolve({ ref: controls.submitRef })).element;
    const origins = new Set((config.credentialOrigins ?? [config.loginUrl]).map((origin) => new URL(origin).origin));
    for (const element of [username, password, submit]) {
      const frame = await element.ownerFrame();
      if (!frame || !origins.has(new URL(frame.url()).origin)) {
        throw new BrowserRuntimeError('Login control is outside the approved credential origins.', 'URL_BLOCKED');
      }
      if (!isSecureCredentialOrigin(new URL(frame.url()))) {
        throw new BrowserRuntimeError('Credentials require an HTTPS or loopback login origin.', 'URL_BLOCKED');
      }
      if (!await element.isVisible()) throw new BrowserRuntimeError('Login control is not visible. Inspect the page again.', 'ACTION_BLOCKED');
    }
    const form = await username.evaluate((node, other) => {
      if (!(node instanceof HTMLInputElement) || !(other instanceof HTMLInputElement)) return null;
      if (!['text', 'email'].includes(node.type) || other.type !== 'password' || !node.form || node.form !== other.form) return null;
      return { action: node.form.action, origin: location.origin };
    }, password);
    const sameForm = await submit.evaluate((node, input) => {
      if (!(input instanceof HTMLInputElement)) return false;
      return (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) && node.form === input.form;
    }, username);
    const action = await submit.evaluate((node) => (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) && node.hasAttribute('formaction') ? node.formAction : null);
    if (!form || !sameForm || !origins.has(new URL(action || form.action).origin)) {
      throw new BrowserRuntimeError('The discovered controls do not form an approved login submission.', 'ACTION_BLOCKED');
    }
    return { username, password, submit };
  }

  private async matchesSuccessSignal(signal: LoginSuccessSignal): Promise<boolean> {
    if (signal.kind === 'url') return new RegExp(signal.pattern).test(this.assertPage().url());
    return this.isVisible(signal.target);
  }

  private async loginOutcome(
    status: 'missing_credentials' | 'invalid_credentials' | 'unsupported_host' | 'timeout',
    target: LoginTarget,
    evidenceSince: number,
    options: { cleanup?: boolean; epoch: number; diagnostic?: LoginFailureDiagnostic },
  ): Promise<LoginOutcome> {
    this.assertSessionEpoch(options.epoch);
    const diagnostic = options.diagnostic ? { diagnostic: options.diagnostic } : {};
    this.journal.record('Browser.login', { brand: target.brand, environment: target.environment, status, ...diagnostic });
    await this.persistManifest();
    this.assertSessionEpoch(options.epoch);
    if (options.cleanup) await this.close();
    return { version: LOGIN_INTERFACE_VERSION, status, brand: target.brand, environment: target.environment, evidenceSince, ...diagnostic };
  }

  private startAction(): number {
    // Failed actions keep their ID, so their evidence is never merged into the next action.
    this.activeActionId = ++this.actionId;
    return this.checkpoint();
  }

  checkpoint(): number {
    return this.journal.bookmark();
  }

  async verify(condition: BrowserCondition, timeoutMs?: number): Promise<VerificationResult> {
    const parsed = browserConditionSchema.safeParse(condition);
    const timeout = browserTimeoutSchema.safeParse(timeoutMs === undefined ? 10_000 : timeoutMs);
    if (!parsed.success || !timeout.success) {
      throw new BrowserRuntimeError('Supply a valid bounded browser condition and timeout.', 'INVALID_CONFIGURATION');
    }
    const evidenceSince = this.checkpoint();
    let budget: ActionBudget | undefined;
    try {
      budget = this.beginBoundedOperation(timeout.data);
      const result = await this.verifyWithin(parsed.data, budget, evidenceSince);
      if (budget.epoch === this.sessionEpoch && !this.closing) await this.persistManifest();
      return result;
    } catch (error) {
      return { status: 'error', kind: parsed.data.kind, evidenceSince, diagnostic: operationDiagnostic(error) };
    } finally {
      if (budget && this.boundedOperation === budget) this.boundedOperation = undefined;
    }
  }

  async sequence(steps: BrowserStep[], timeoutMs?: number): Promise<SequenceResult> {
    const parsed = browserStepsSchema.safeParse(steps);
    const timeout = browserTimeoutSchema.safeParse(timeoutMs === undefined ? 10_000 : timeoutMs);
    if (!parsed.success || !timeout.success) {
      throw new BrowserRuntimeError('Supply one to ten valid browser steps and a bounded timeout.', 'INVALID_CONFIGURATION');
    }
    const evidenceSince = this.checkpoint();
    const runId = this.runId;
    const results: SequenceStepResult[] = [];
    let evidence = this.getEvidence({ since: evidenceSince, filter: 'errors' });
    let budget: ActionBudget | undefined;
    let validatingIndex = 0;
    try {
      budget = this.beginBoundedOperation(timeout.data);
      // Parse every selector before the first action. Later steps may target elements not yet present.
      for (const [index, step] of parsed.data.entries()) {
        validatingIndex = index;
        const condition = step.kind === 'verify' ? step.condition : step.expect;
        const targets = [...('target' in step ? [step.target] : []),
          ...(condition && 'target' in condition ? [condition.target] : [])];
        for (const target of targets) if (target.kind !== 'ref') {
          await budget.run(() => this.conditionLocator(target).count());
        }
      }
      for (const [index, step] of parsed.data.entries()) {
        const since = this.checkpoint();
        try {
          budget.remaining();
          if (step.kind !== 'verify') await this.sequenceAction(step, budget);
          const condition = step.kind === 'verify' ? step.condition : step.expect;
          if (condition) {
            const verification = await this.verifyWithin(condition, budget, since);
            results.push({ index, kind: step.kind, evidenceSince: since,
              status: verification.status === 'matched' ? 'verified' : 'failed', verification });
            if (verification.status !== 'matched') break;
          } else {
            results.push({ index, kind: step.kind, status: 'completed', evidenceSince: since });
          }
        } catch (error) {
          const diagnostic = operationDiagnostic(error);
          results.push({ index, kind: step.kind, status: 'failed', evidenceSince: since, diagnostic });
          if (budget.epoch === this.sessionEpoch && !this.closing) {
            this.journal.record('Browser.actionFailed', { kind: step.kind, ...diagnostic });
          }
          break;
        }
      }
    } catch (error) {
      results.push({ index: validatingIndex, kind: parsed.data[validatingIndex]!.kind, status: 'failed', evidenceSince,
        diagnostic: operationDiagnostic(error) });
    }
    const status = results.length === parsed.data.length && results.every((step) => step.status !== 'failed')
      ? 'completed' : 'stopped';
    try {
      if (budget && budget.epoch === this.sessionEpoch && !this.closing) {
        this.journal.record('Browser.sequence', { status, evidenceSince, steps: results });
        evidence = this.getEvidence({ since: evidenceSince, filter: 'errors' });
        await this.persistManifest();
      }
      return { status, ...(runId ? { runId } : {}), evidenceSince, steps: results, evidence };
    } finally {
      if (budget && this.boundedOperation === budget) this.boundedOperation = undefined;
    }
  }

  private beginBoundedOperation(timeoutMs: number): ActionBudget {
    this.assertNotWaitingForHuman();
    if (this.boundedOperation || this.legacyMutations > 0 || this.closing) {
      throw new BrowserRuntimeError('Another browser operation owns this session.', 'INVALID_STATE', { reason: 'session_busy' });
    }
    const page = this.assertPage();
    const epoch = this.sessionEpoch;
    const owner = this.browserResources;
    const budget = new ActionBudget(epoch, page, page.context(), timeoutMs, () => this.assertSessionEpoch(epoch), async () => {
      if (!owner) throw new BrowserRuntimeError('Browser ownership is unavailable during cancellation.', 'INVALID_STATE');
      await owner.close();
    });
    this.boundedOperation = budget;
    return budget;
  }

  private async runLegacyMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertNotWaitingForHuman();
    if (this.boundedOperation) throw new BrowserRuntimeError('A bounded browser operation owns this session.', 'INVALID_STATE', { reason: 'session_busy' });
    this.legacyMutations++;
    try { return await operation(); }
    finally { this.legacyMutations--; }
  }

  private conditionLocator(target: Exclude<LocatorTarget, { kind: 'ref' }>): Locator {
    const page = this.assertPage();
    switch (target.kind) {
      case 'role': return page.getByRole(target.role as Parameters<Page['getByRole']>[0], { name: target.name, exact: true });
      case 'label': return page.getByLabel(target.label, { exact: true });
      case 'text': return page.getByText(target.text, { exact: true });
      case 'selector': return page.locator(target.selector);
    }
  }

  private async verifyWithin(condition: BrowserCondition, budget: ActionBudget, evidenceSince: number): Promise<VerificationResult> {
    let result: VerificationResult;
    try {
      let matched = false;
      while (!budget.isExpired) {
        budget.remaining();
        matched = await budget.run(() => this.matchesCondition(condition));
        if (matched) break;
        await budget.pause();
      }
      this.assertSessionEpoch(budget.epoch);
      result = { status: matched ? 'matched' : 'unmet', kind: condition.kind, evidenceSince,
        ...(!matched ? { diagnostic: conditionUnmet() } : {}) };
    } catch (error) {
      result = { status: 'error', kind: condition.kind, evidenceSince, diagnostic: operationDiagnostic(error) };
    }
    if (budget.epoch === this.sessionEpoch && !this.closing) {
      this.journal.record('Browser.verify', result);
      const target = 'target' in condition ? await this.portableTarget(condition.target) : undefined;
      this.recordStep({ kind: 'verify', condition: portableCondition(condition, target), matched: result.status === 'matched' });
    }
    return result;
  }

  private async matchesCondition(condition: BrowserCondition): Promise<boolean> {
    if (condition.kind === 'url') return this.assertPage().url() === condition.equals;
    const target = condition.target.kind === 'ref'
      ? (await this.assertInspector().resolve({ ref: condition.target.ref })).element
      : this.conditionLocator(condition.target);
    const count = 'count' in target ? await target.count() : 1;
    if (condition.kind === 'count') return count === condition.equals;
    if (count > 1) throw verificationError('ambiguous_target');
    if (count === 0) return condition.kind === 'state' && condition.state === 'hidden';
    if (condition.kind === 'state') {
      if (condition.state === 'visible' || condition.state === 'hidden') {
        const visible = await target.isVisible();
        return condition.state === 'visible' ? visible : !visible;
      }
      return condition.state === 'enabled' ? target.isEnabled() : target.isDisabled();
    }
    const compare = (node: Element, check: { kind: 'text' | 'value'; equals: string }): boolean | 'sensitive_value' | 'target_not_editable' => {
      if (check.kind === 'text') return (node instanceof HTMLElement ? node.innerText : node.textContent) === check.equals;
      if (node instanceof HTMLInputElement && node.type === 'password') return 'sensitive_value';
      if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) {
        return 'target_not_editable';
      }
      return node.value === check.equals;
    };
    const check = { kind: condition.kind, equals: condition.equals };
    const match = 'count' in target ? await target.evaluate(compare, check) : await target.evaluate(compare, check);
    if (typeof match === 'string') throw verificationError(match);
    return match;
  }

  private async sequenceAction(step: Exclude<BrowserStep, { kind: 'verify' }>, budget: ActionBudget): Promise<void> {
    this.startAction();
    const startedAt = Date.now();
    if (step.kind === 'press') {
      await budget.run(() => this.assertPage().keyboard.press(step.key));
      this.recordStep({ kind: 'press', key: step.key });
    } else {
      const resolved = step.target.kind === 'ref'
        ? { element: (await budget.run(() => this.assertInspector().resolve({ ref: step.target.kind === 'ref' ? step.target.ref : '' }))).element, owned: false }
        : { element: await this.sequenceElement(step, budget), owned: true };
      const portable = step.target.kind === 'ref' ? await this.portableElement(resolved.element) : step.target;
      const sensitive = step.kind === 'type' && await resolved.element.evaluate(isPasswordField).catch(() => false);
      try {
        if (step.kind === 'click') {
          await budget.run((timeout) => resolved.element.click({ timeout }));
        } else if (step.kind === 'type') {
          await budget.run((timeout) => resolved.element.fill(step.value, { timeout }));
        } else {
          await budget.run((timeout) => resolved.element.hover({ timeout }));
        }
        this.recordStep(step.kind === 'type' ? { kind: 'type', target: portable, value: step.value, sensitive } : { kind: step.kind, target: portable });
      } finally {
        if (resolved.owned) await resolved.element.dispose();
      }
    }
    const settled = await this.settle(startedAt, budget);
    budget.remaining();
    this.journal.record('Browser.action', { kind: step.kind, actionId: this.activeActionId, settled,
      ...(step.kind === 'press' ? { target: `key ${step.key}` } : { target: describeTarget(step.target) }) });
  }

  private async sequenceElement(step: Exclude<BrowserStep, { kind: 'verify' | 'press' }>, budget: ActionBudget): Promise<ElementHandle<SVGElement | HTMLElement>> {
    if (step.target.kind === 'ref') throw new BrowserRuntimeError('Element references require identity resolution.', 'INVALID_STATE');
    const locator = step.kind === 'type' ? await this.locateField(step.target, budget) : this.conditionLocator(step.target);
    await budget.run((timeout) => locator.waitFor({ state: 'attached', timeout }));
    const element = await budget.run((timeout) => locator.elementHandle({ timeout }));
    if (!element) throw verificationError('action_timeout');
    return element;
  }

  private async clickImpl(target: LocatorTarget): Promise<ActionReceipt> {
    if (target.kind === 'ref') return this.elementAction(target.ref, 'click');
    const bookmark = this.startAction();
    const startedAt = Date.now();
    try {
      await this.locate(target).click();
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error;
      throw new BrowserRuntimeError('Click failed.', 'ACTION_FAILED', {
        target,
        error: getErrorMessage(error),
      });
    }
    const settled = await this.settle(startedAt);
    await this.waitForEvidenceReads();
    this.recordStep({ kind: 'click', target });
    return this.receipt('click', settled, bookmark, describeTarget(target));
  }

  private async typeImpl(target: LocatorTarget, value: string): Promise<ActionReceipt> {
    try {
      if (target.kind === 'ref') return await this.elementAction(target.ref, 'fill', value);
      const bookmark = this.startAction();
      const startedAt = Date.now();
      const field = await this.locateField(target);
      const sensitive = await field.first().evaluate(isPasswordField).catch(() => false);
      await field.fill(value);
      this.recordStep({ kind: 'type', target, value, sensitive });
      return this.receipt('type', await this.settle(startedAt), bookmark, describeTarget(target));
    } catch (error) {
      if (error instanceof BrowserRuntimeError && error.code !== 'ACTION_FAILED') throw error;
      const diagnostic = diagnoseActionFailure(error);
      this.journal.record('Browser.actionFailed', { kind: 'type', ...diagnostic });
      throw new BrowserRuntimeError(`Typing failed: ${diagnostic.message}`, 'ACTION_FAILED', { reason: diagnostic.reason });
    }
  }

  private async pressImpl(key: string): Promise<ActionReceipt> {
    const bookmark = this.startAction();
    const startedAt = Date.now();
    try {
      await this.assertPage().keyboard.press(key);
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error;
      throw new BrowserRuntimeError('Key press failed.', 'ACTION_FAILED', {
        key,
        error: getErrorMessage(error),
      });
    }
    this.recordStep({ kind: 'press', key });
    return this.receipt('press', await this.settle(startedAt), bookmark, `key ${key}`);
  }

  private async hoverImpl(target: LocatorTarget): Promise<ActionReceipt> {
    if (target.kind === 'ref') return this.elementAction(target.ref, 'hover');
    const bookmark = this.startAction();
    const startedAt = Date.now();
    try {
      await this.locate(target).hover();
    } catch (error) {
      throw new BrowserRuntimeError('Hover failed.', 'ACTION_FAILED', {
        target,
        error: getErrorMessage(error),
      });
    }
    this.recordStep({ kind: 'hover', target });
    return this.receipt('hover', await this.settle(startedAt), bookmark, describeTarget(target));
  }

  private async waitForSettledImpl(): Promise<ActionReceipt> {
    const bookmark = this.startAction();
    return this.receipt('wait', await this.settle(Date.now()), bookmark);
  }

  private async dismissOverlayImpl(): Promise<OverlayDismissal> {
    const page = this.assertPage();
    const bookmark = this.startAction();
    const startedAt = Date.now();
    await page.keyboard.press('Escape').catch((error) => {
      console.warn('BrowserSession: Escape did not dismiss an overlay', { error: getErrorMessage(error) });
    });
    for (const frame of page.frames()) {
      for (const selector of CLOSE_SELECTORS) {
        const locator = frame.locator(selector).first();
        try {
          if (!(await locator.isVisible({ timeout: 300 }))) continue;
          await locator.click({ timeout: 2_000 });
          this.recordStep({ kind: 'note', text: `The agent dismissed an overlay here (${selector}). Add a click if the site shows it in your environment.` });
          return {
            dismissed: true,
            via: selector,
            receipt: await this.receipt('dismissOverlay', await this.settle(startedAt), bookmark),
          };
        } catch {
          // A selector that is absent, hidden, detached, or intercepted is an expected probe miss.
        }
      }
    }
    return {
      dismissed: false,
      via: null,
      receipt: await this.receipt('dismissOverlay', await this.settle(startedAt), bookmark),
    };
  }

  async screenshot(name = `screenshot-${Date.now()}`, options: { fullPage?: boolean | undefined; ref?: string | undefined } = {}): Promise<ScreenshotArtifact> {
    if (this.artifacts.length >= 100) throw new BrowserRuntimeError('Screenshot limit reached for this session.', 'ACTION_BLOCKED');
    if (options.fullPage && await this.assertPage().evaluate(() => document.documentElement.scrollHeight) > 16_000) {
      throw new BrowserRuntimeError('Page exceeds full-page screenshot height limit. Capture an element or viewport.', 'ACTION_BLOCKED');
    }
    const safeName = name.replace(/[^a-z0-9_-]+/gi, '-');
    const artifactId = randomUUID();
    const path = resolve(this.assertRunDir(), `${safeName}-${artifactId}.jpg`);
    const target = options.ref ? (await this.assertInspector().resolve({ ref: options.ref })).element : this.assertPage();
    const data = await target.screenshot({
      mask: this.assertPage().frames().flatMap((frame) => [
        frame.locator(this.hasAccountCredentials ? 'input, textarea' : 'input[type="password"]'),
        ...this.snapshotSecrets.filter((secret): secret is string => !!secret).map((secret) => frame.getByText(secret, { exact: false })),
        ...(this.options.loginBrandConfigs ?? []).flatMap((config) =>
          config.usernameField?.kind === 'selector' ? [frame.locator(config.usernameField.selector)] : []),
      ]),
      path,
      type: 'jpeg',
      quality: 70,
      ...(!options.ref ? { fullPage: options.fullPage ?? false } : {}),
    });
    const metadata = { artifactId, path, timestamp: Date.now(), url: redactUrl(this.assertPage().url()), actionId: this.actionId };
    this.artifacts.push(metadata);
    this.journal.record('Browser.screenshot', metadata);
    await this.persistManifest();
    return {
      ...metadata,
      runId: this.assertRunId(),
      path,
      mimeType: 'image/jpeg',
      dataBase64: data.toString('base64'),
    };
  }

  async evidence(query: EvidenceQuery = {}): Promise<BrowserEvidence> {
    await this.waitForEvidenceReads();
    await this.persistManifest();
    return this.getEvidence(query);
  }

  /** Return evidence captured so far without waiting for in-flight body reads. */
  getEvidence(query: EvidenceQuery = {}): BrowserEvidence {
    const since = Math.max(0, query.since ?? 0);
    const filter = query.filter ?? 'errors';
    const events = this.journal.since(since);
    const outcomes = events.filter(isProtectedEvidenceEvent);
    const allNetwork = events
      .filter((event) => event.method === 'Browser.response')
      .map((event) => this.networkEvidence(event));
    const allConsole = events
      .filter((event) => event.method === 'Browser.console')
      .map((event) => this.consoleEvidence(event));
    const pageErrors = events
      .filter((event) => event.method === 'Browser.pageError')
      .map((event) => this.pageErrorEvidence(event));
    const faultsApplied = events.filter((event) => event.method === 'Browser.faultApplied');
    const injected = matchInjectedFaults(faultsApplied, allNetwork);
    for (const item of allNetwork) {
      const faultId = injected.get(item);
      if (faultId) item.injectedFault = faultId;
    }

    const network = allNetwork.filter((item) => {
      if (filter === 'all') return true;
      if (filter === 'first-party') return item.hostClass === 'first-party';
      return item.status >= 400 || !!item.failure || item.hostClass === 'first-party' || item.bodyExcerpt !== null;
    });
    const console = allConsole.filter(
      (item) => filter === 'all' || item.level === 'error' || item.level === 'warning',
    );
    const cdp = events
      .filter((event) =>
        [...CDP_EVENTS].includes(
          event.method as typeof CDP_EVENTS[number],
        ),
      )
      .slice(-50);

    return {
      ...(this.runId ? { runId: this.runId } : {}),
      ...(this.runDir ? { manifestPath: join(this.runDir, 'evidence.json') } : {}),
      droppedEvents: this.journal.dropped,
      truncated: this.journal.dropped > 0 || outcomes.length > 100 || events.some((e) => e.params.captureTruncated === true) || events.filter((e) => e.method === 'Browser.response').length > 120 ||
        events.filter((e) => e.method === 'Browser.console').length > 120 || events.filter((e) => e.method === 'Browser.pageError').length > 50 ||
        events.filter((e) => [...CDP_EVENTS].includes(e.method as typeof CDP_EVENTS[number])).length > 50,
      captureHealth: [...this.captureHealth],
      since,
      bookmark: this.journal.bookmark(),
      summary: {
        totalRequests: allNetwork.length,
        firstPartyRequests: allNetwork.filter((item) => item.hostClass === 'first-party').length,
        failedRequests: allNetwork.filter((item) => item.status >= 400 || item.failure).length,
        injectedFaults: faultsApplied.length,
        consoleErrors: allConsole.filter((item) => item.level === 'error').length,
        pageErrors: pageErrors.length,
      },
      network: network.slice(-120),
      console: console.slice(-120),
      pageErrors: pageErrors.slice(-50),
      cdp,
      outcomes: outcomes.slice(-100),
    };
  }

  async snapshot(): Promise<PageSnapshot> {
    const page = this.assertPage();
    const aria = await page.locator('body').ariaSnapshot().catch((error) => {
      throw new BrowserRuntimeError('Could not read the page accessibility tree.', 'ACTION_FAILED', {
        error: getErrorMessage(error),
      });
    });
    const maxChars = this.options.maxSnapshotChars ?? DEFAULT_SNAPSHOT_CHARS;
    // A page could echo the Vercel bypass secret back into its own content (a misbehaving
    // deployment, or a value that collides with something else on the page) — scrub it from this
    // model-facing snapshot the same way it is scrubbed from evidence, on top of never sending it
    // anywhere the isolation in buildVercelBypass/VercelBypass wouldn't already prevent.
    const scrubbedAria = redactKnownSecrets(aria, this.snapshotSecrets);
    this.lastAria = scrubbedAria;
    const snapshot = {
      runId: this.assertRunId(),
      url: redactUrl(page.url()),
      title: redactKnownSecrets(await page.title(), this.snapshotSecrets),
      aria: scrubbedAria.length > maxChars ? `${scrubbedAria.slice(0, maxChars)}\n…[truncated]` : scrubbedAria,
    };
    this.journal.record('Browser.snapshot', snapshot);
    await this.persistManifest();
    return snapshot;
  }

  /**
   * Describe how the accessibility tree changed since the last snapshot or changes call, then make
   * the current tree the new baseline. The first call only captures a baseline.
   */
  async changes(): Promise<{ runId: string; url: string; title: string; baseline: boolean } & Partial<SnapshotDiff>> {
    const page = this.assertPage();
    const aria = await page.locator('body').ariaSnapshot().catch((error) => {
      throw new BrowserRuntimeError('Could not read the page accessibility tree.', 'ACTION_FAILED', { error: getErrorMessage(error) });
    });
    const current = redactKnownSecrets(aria, this.snapshotSecrets);
    const previous = this.lastAria;
    this.lastAria = current;
    const base = { runId: this.assertRunId(), url: redactUrl(page.url()), title: redactKnownSecrets(await page.title(), this.snapshotSecrets) };
    if (previous === undefined) {
      this.journal.record('Browser.changes', { baseline: true });
      return { ...base, baseline: true, text: 'Baseline captured. Call again after an action to see what changed.' };
    }
    const diff = diffSnapshots(previous, current);
    this.journal.record('Browser.changes', { baseline: false, summary: diff.summary, text: diff.text });
    await this.persistManifest();
    return { ...base, baseline: false, ...diff };
  }

  close(): Promise<CloseResult> {
    if (this.closing) return this.closing;
    this.sessionEpoch++;
    void this.boundedOperation?.cancel().catch(() => console.error('BrowserSession: active operation cancellation failed.'));
    this.launchController?.abort();
    const closing = this.closeSession();
    this.closing = closing;
    void closing.finally(() => { this.closing = undefined; }).catch(() => undefined);
    return closing;
  }

  private async closeSession(): Promise<CloseResult> {
    // A launch cancelled by shutdown still owns resources until it has unwound.
    await this.pageStartup?.catch(() => undefined);
    const runId = this.runId ?? null;
    const tracePath = this.tracePath ?? null;
    const manifestPath = this.runDir ? join(this.runDir, 'evidence.json') : null;
    if (this.manifestTimer) clearTimeout(this.manifestTimer);
    this.manifestTimer = undefined;
    const warnings: string[] = [];
    const attempt = async (stage: string, action: () => Promise<unknown>, timeoutMs = 3_000): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([action(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Cleanup deadline exceeded.')), timeoutMs);
        })]);
        return true;
      } catch {
        // Browser errors can contain page text or cookie values. Keep the stage, not raw data.
        warnings.push(stage);
        console.error('BrowserSession: cleanup stage failed', { stage, runId });
        return false;
      } finally { if (timer) clearTimeout(timer); }
    };
    await attempt('evidence-flush', () => this.network.flush());
    let reportPath: string | null = null;
    if (this.runDir && this.runId && this.actionId > 0) {
      await attempt('report', async () => { reportPath = await this.writeReport(this.reportInput ?? this.defaultReportInput()); });
    }
    await attempt('evidence-save', () => this.persistManifest());
    // Save test evidence before logout changes the page and starts more network requests.
    await attempt('trace-stop', () => this.stopTrace());
    let logout: NonNullable<CloseResult['cleanup']>['logout'] = 'not-needed';
    if (this.hasAccountCredentials && this.page) {
      logout = 'failed';
      await attempt('logout', async () => { logout = await this.logout(); }, 8_000);
    }
    if (this.context) {
      await attempt('cookies-clear', () => this.context!.clearCookies());
      await attempt('permissions-clear', () => this.context!.clearPermissions());
    }
    // The entire disposable profile is removed by the launcher, including storage for
    // origins no longer open in a tab. Clearing the current origin alone is insufficient.
    await attempt('inspector-close', async () => { await this.inspector?.close(); });
    this.inspector = undefined;
    for (const session of this.cdpSessions) {
      await attempt('cdp-detach', () => session.detach(), 1_000);
    }
    this.cdpSessions = [];
    const closed = await attempt('browser-close', async () => { await this.browserResources?.close(); }, 15_000);
    this.browserResources = undefined;
    this.context = undefined;
    this.page = undefined;
    if (this.manifestTimer) clearTimeout(this.manifestTimer);
    this.manifestTimer = undefined;
    // The manifest retains the test outcome and a cleanup receipt, without logout traffic.
    if (manifestPath) await attempt('cleanup-receipt', async () => {
      // A timed-out save may still complete. Serialize the receipt after that save.
      this.manifestWrite = this.manifestWrite.catch(() => undefined).then(async () => {
        const { readFile } = await import('node:fs/promises');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const temporary = `${manifestPath}.cleanup.tmp`;
        await writeFile(temporary, JSON.stringify({ ...manifest, cleanup: { logout, warnings } }, null, 2), { mode: 0o600 });
        await rename(temporary, manifestPath);
      });
      await this.manifestWrite;
    });
    this.targetHost = undefined;
    this.runId = undefined;
    this.runDir = undefined;
    this.lastAria = undefined;
    this.reportInput = undefined;
    this.faults.reset();
    this.steps = [];
    this.seenHumanChecks = new Set();
    this.pendingAttention = [];
    this.finishHandoff?.();
    this.tracePath = undefined;
    this.traceStopped = false;
    this.actionId = 0;
    this.activeActionId = 0;
    this.pendingRequests.clear();
    this.lastNetworkActivityAt = 0;
    this.vercelBypass?.reset();
    this.network.clear();
    this.captureHealth = [];
    this.artifacts = [];
    this.journal.clear();
    this.knownSecrets.length = 0;
    this.knownSecrets.push(...this.baseSecrets);
    this.snapshotSecrets.length = 0;
    this.snapshotSecrets.push(...this.baseSnapshotSecrets);
    this.hasAccountCredentials = false;
    this.authentication = undefined;
    this.authenticatedUrl = undefined;
    this.launchController = undefined;
    return { closed, runId, tracePath, manifestPath, reportPath, cleanup: { logout, warnings } };
  }

  private async logout(): Promise<'attempted' | 'unavailable'> {
    const page = this.page;
    if (!page || page.isClosed()) return 'unavailable';
    const deadline = Date.now() + 7_000;
    const timeout = (maximum: number): number => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new BrowserRuntimeError('Logout cleanup deadline exceeded.', 'ACTION_FAILED');
      return Math.min(maximum, remaining);
    };
    const name = /^(log\s*out|sign\s*out)$/i;
    const find = async (): Promise<Locator | undefined> => {
      // Some account UIs render Logout as clickable text without an ARIA role.
      for (const candidates of [page.getByRole('button', { name }), page.getByRole('link', { name }), page.getByText(name, { exact: true })]) {
        for (let index = 0; index < Math.min(await candidates.count(), 10); index++) {
          const candidate = candidates.nth(index);
          if (await candidate.isVisible()) return candidate;
        }
      }
      return undefined;
    };
    let control = await find();
    if (!control && this.authenticatedUrl && page.url() !== this.authenticatedUrl) {
      await page.goto(this.authenticatedUrl, { waitUntil: 'domcontentloaded', timeout: timeout(3_000) });
      control = await find();
    }
    if (!control) return 'unavailable';
    await page.keyboard.press('Escape');
    try {
      await control.click({ trial: true, timeout: timeout(250) });
    } catch {
      // A promotion can cover Logout. Only dismiss a visible dialog through its
      // normal close control; never force a click through the overlay.
      const closeName = /^(close|dismiss|no thanks|not now)(\s+(dialog|popup|modal))?$/i;
      let dismissed = false;
      for (const frame of page.frames().slice(0, 3)) {
        const dialogs = frame.locator('[role="dialog"], [aria-modal="true"]');
        for (let index = 0; index < Math.min(await dialogs.count(), 3); index++) {
          const dialog = dialogs.nth(index);
          if (!await dialog.isVisible()) continue;
          const close = dialog.getByRole('button', { name: closeName }).filter({ visible: true }).first();
          if (!await close.isVisible()) continue;
          await close.click({ timeout: timeout(750) });
          dismissed = true;
          break;
        }
        if (dismissed) break;
      }
    }
    await control.click({ timeout: timeout(5_000) });
    // A click is not proof of server-side revocation. The receipt says attempted.
    await page.waitForLoadState('domcontentloaded', { timeout: timeout(1_000) });
    return 'attempted';
  }

  private assertSessionEpoch(epoch: number): void {
    if (epoch !== this.sessionEpoch || this.closing) {
      throw new BrowserRuntimeError('The browser session closed during this operation.', 'INVALID_STATE');
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.closing) throw new BrowserRuntimeError('The browser session is closing.', 'INVALID_STATE');
    if (this.page) return this.assertPage();
    if (this.pageStartup) return this.pageStartup;
    const controller = new AbortController();
    this.launchController = controller;
    const startup = this.startPage(controller.signal);
    this.pageStartup = startup;
    void startup.finally(() => {
      this.pageStartup = undefined;
      this.launchController = undefined;
    }).catch(() => undefined);
    return startup;
  }

  private async startPage(signal: AbortSignal): Promise<Page> {
    this.runId = randomUUID();
    this.runStartedAt = Date.now();
    this.runDir = resolve(this.options.artifactsDir ?? 'artifacts', runFolderName(this.runStartedAt, this.targetHost, this.runId));
    this.tracePath = this.options.isTraceEnabled ? join(this.runDir, 'trace.zip') : undefined;
    this.traceStopped = false;
    await mkdir(this.runDir, { recursive: true });
    try {
      this.browserResources = await launchBrowser(this.options, signal);
      signal.throwIfAborted();
      this.context = this.browserResources.context;
      if (this.options.isTraceEnabled) {
        await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      }
      this.page = await this.context.newPage();
      await this.page.setViewportSize({ width: 1440, height: 900 });
      this.inspector = new ElementInspector(this.page);
      await this.context.exposeBinding('__agentBrowserHandoffDone', () => this.finishHandoff?.());
      this.page.setDefaultTimeout(this.options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);
      this.page.setDefaultNavigationTimeout(
        this.options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
      );
      await this.page.route('**/*', async (route) => {
        const request = route.request();
        const fault = this.faults.match(request.url(), request.method());
        if (fault) {
          await this.applyFault(route, fault).catch(async (error) => {
            console.error('BrowserSession: fault could not be applied', { faultId: fault.id, error: getErrorMessage(error) });
            this.captureHealth.push(`Fault ${fault.id} could not be applied`);
            await route.abort('failed').catch(() => undefined);
          });
          return;
        }
        const vercelHeaders = this.vercelBypass?.headersFor(request.url());
        if (vercelHeaders) {
          // route.continue()'s header overrides are replayed by the browser on any redirect the
          // request triggers, which would hand the secret to whatever host the redirect lands
          // on. Fetching it ourselves with redirects disabled and handing back the raw response
          // instead lets the browser perform any redirect as a brand-new, unheadered request.
          const response = await route.fetch({
            headers: { ...request.headers(), ...vercelHeaders },
            maxRedirects: 0,
          });
          await route.fulfill({ response });
          return;
        }
        if (this.options.bypassHeaderToken && this.classifyHost(request.url()) === 'first-party') {
          const headerName = this.options.bypassHeaderName ?? DEFAULT_BYPASS_HEADER_NAME;
          await route.continue({
            headers: { ...request.headers(), [headerName]: this.options.bypassHeaderToken },
          });
          return;
        }
        await route.continue();
      });
      await this.attachPage(this.page);
      signal.throwIfAborted();
      return this.page;
    } catch (error) {
      await this.browserResources?.close();
      this.browserResources = undefined;
      this.page = undefined;
      this.context = undefined;
      throw new BrowserRuntimeError('Chromium could not start.', 'BROWSER_UNAVAILABLE', {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Pause until a person finishes a step in the visible browser: they click Done in the banner
   * (or press Ctrl+Shift+Enter), a detected challenge disappears, or the timeout passes. Other
   * browser actions are refused while waiting. Read-only tools still work.
   */
  async requestHandoff(reason: string, timeoutMs = 120_000): Promise<HandoffResult> {
    if (!reason.trim() || reason.length > 300) throw new BrowserRuntimeError('Give a reason of 1 to 300 characters.', 'INVALID_CONFIGURATION');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
      throw new BrowserRuntimeError('timeoutMs must be 1000 to 600000.', 'INVALID_CONFIGURATION');
    }
    const page = this.assertPage();
    const visible = this.options.headless === false || (this.options.launchMode === 'virtual-display' && process.platform === 'darwin');
    if (!visible && !this.options.allowHeadlessHandoff) {
      return { status: 'unavailable', waitedMs: 0, url: redactUrl(page.url()),
        message: 'Nobody can see this browser. Run with HEADED=1 for a person to take over, and tell the user what is needed.' };
    }
    this.assertNotWaitingForHuman();
    if (this.boundedOperation || this.legacyMutations > 0) {
      throw new BrowserRuntimeError('Another browser operation owns this session.', 'INVALID_STATE', { reason: 'session_busy' });
    }
    const epoch = this.sessionEpoch;
    const startedAt = Date.now();
    const challengeOnPage = await this.humanChecksOnPage(page).then((checks) => checks.some((check) => check.category === 'challenge'));
    this.waitingForHuman = true;
    this.journal.record('Browser.handoff', { event: 'requested', reason });
    this.notify({ type: 'handoff-request', category: 'handoff', source: 'text', url: redactUrl(page.url()), detail: reason }, null);
    let status: HandoffResult['status'] = 'timeout';
    try {
      await this.showHandoffBanner(page, reason);
      status = await new Promise<HandoffResult['status']>((resolvePromise) => {
        let clearPolls = 0;
        const finish = (result: HandoffResult['status']) => { clearTimeout(deadline); clearInterval(poll); resolvePromise(result); };
        this.finishHandoff = () => finish(epoch === this.sessionEpoch && !this.closing ? 'completed' : 'cancelled');
        const deadline = setTimeout(() => finish('timeout'), timeoutMs);
        const poll = setInterval(() => {
          if (epoch !== this.sessionEpoch || this.closing || page.isClosed()) { finish('cancelled'); return; }
          if (!challengeOnPage) return;
          void this.humanChecksOnPage(page).then((checks) => {
            clearPolls = checks.some((check) => check.category === 'challenge') ? 0 : clearPolls + 1;
            if (clearPolls >= 2) finish('cleared');
          }).catch(() => undefined);
        }, 1_000);
      });
    } finally {
      this.finishHandoff = undefined;
      this.waitingForHuman = false;
      if (!page.isClosed()) await page.evaluate(() => document.getElementById('agent-browser-handoff')?.remove()).catch(() => undefined);
    }
    const waitedMs = Date.now() - startedAt;
    const url = page.isClosed() ? null : redactUrl(page.url());
    if (epoch === this.sessionEpoch && !this.closing) {
      this.journal.record('Browser.handoff', { event: 'finished', status, waitedMs });
      await this.persistManifest();
    }
    const message = { completed: 'The person clicked Done. Take a snapshot before continuing.',
      cleared: 'The challenge is no longer on the page. Take a snapshot before continuing.',
      timeout: 'Nobody finished the step before the timeout. Tell the user what is needed.',
      cancelled: 'The session closed while waiting.', unavailable: '' }[status];
    return { status, waitedMs, url, message };
  }

  private assertNotWaitingForHuman(): void {
    if (this.waitingForHuman) {
      throw new BrowserRuntimeError('Waiting for a person to finish a step in the browser.', 'INVALID_STATE', { reason: 'waiting_for_human' });
    }
  }

  private async showHandoffBanner(page: Page, reason?: string): Promise<void> {
    await page.evaluate((text) => {
      const existing = document.getElementById('agent-browser-handoff');
      const message = text ?? existing?.dataset.reason ?? 'The agent is waiting for you.';
      existing?.remove();
      const banner = document.createElement('div');
      banner.id = 'agent-browser-handoff';
      banner.dataset.reason = message;
      banner.setAttribute('role', 'alert');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;gap:12px;align-items:center;' +
        'padding:10px 16px;background:#1d2340;color:#fff;font:15px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
      const label = document.createElement('span');
      label.style.flex = '1';
      label.textContent = `Agent paused: ${message}`;
      const done = document.createElement('button');
      done.textContent = 'Done (Ctrl+Shift+Enter)';
      done.style.cssText = 'font:inherit;padding:4px 12px;border-radius:6px;border:0;background:#8ea2f5;color:#111;cursor:pointer';
      const signal = () => (window as unknown as { __agentBrowserHandoffDone?: () => void }).__agentBrowserHandoffDone?.();
      done.addEventListener('click', signal);
      banner.append(label, done);
      document.documentElement.append(banner);
      if (!(window as unknown as { __agentBrowserHandoffKeys?: boolean }).__agentBrowserHandoffKeys) {
        (window as unknown as { __agentBrowserHandoffKeys?: boolean }).__agentBrowserHandoffKeys = true;
        window.addEventListener('keydown', (event) => {
          if (event.ctrlKey && event.shiftKey && event.key === 'Enter' && document.getElementById('agent-browser-handoff')) signal();
        }, true);
      }
    }, reason);
  }

  private async humanChecksOnPage(page: Page): Promise<HumanCheck[]> {
    const { title, text } = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? '').slice(0, 20_000) }));
    const frames = page.frames().flatMap((frame) => { const check = classifyFrameUrl(frame.url()); return check ? [check] : []; });
    return [...classifyPage(page.url(), title, text, this.handoffPatterns), ...frames];
  }

  private async checkPageForHumans(page: Page): Promise<void> {
    try {
      for (const check of await this.humanChecksOnPage(page)) await this.handleHumanCheck(check);
    } catch (error) {
      // A navigation can destroy the context mid-read; the next action checks again.
      console.warn('BrowserSession: human check skipped', { error: getErrorMessage(error) });
    }
  }

  /** Record, capture, and announce each distinct check once per page. */
  private async handleHumanCheck(check: HumanCheck): Promise<void> {
    const page = this.page;
    if (!page || page.isClosed() || !this.runDir) return;
    // A challenge header arrives before its document commits, so key it by that document's URL.
    if (check.source === 'frame') await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
    const key = humanCheckKey(check, check.source === 'frame' ? page.url() : check.url);
    if (this.seenHumanChecks.has(key)) return;
    this.seenHumanChecks.add(key);
    const url = redactUrl(check.url);
    let screenshotPath: string | null = null;
    for (let attempt = 0; attempt < 3 && !screenshotPath; attempt++) {
      await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
      try { screenshotPath = (await this.screenshot(`challenge-${check.type}`)).path; }
      catch (error) {
        if (attempt === 2) console.warn('BrowserSession: challenge screenshot failed', { type: check.type, error: getErrorMessage(error) });
        else await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      }
    }
    this.journal.record('Browser.challenge', { ...check, url, pageUrl: redactUrl(page.url()), screenshotPath });
    this.pendingAttention.push({ ...check, url, screenshotPath });
    this.notify({ ...check, url }, screenshotPath);
  }

  private notify(check: Pick<HumanCheck, 'category' | 'url' | 'detail'> & { type: string; source: string }, screenshotPath: string | null): void {
    const notice: ChallengeNotice = { runId: this.runId ?? '', type: check.type, category: check.category, url: check.url,
      detail: check.detail, detectedAt: new Date().toISOString(), screenshotPath };
    for (const listener of this.humanCheckListeners) {
      try { listener(notice); } catch (error) { console.error('BrowserSession: challenge listener failed', { error: getErrorMessage(error) }); }
    }
    dispatchNotice(this.notifiers, notice, (channel) => {
      const health = `Challenge notification via ${channel} failed`;
      if (!this.captureHealth.includes(health)) this.captureHealth.push(health);
    });
  }

  private takeAttention(): HumanAttention | undefined {
    if (this.pendingAttention.length === 0) return undefined;
    const checks = this.pendingAttention;
    this.pendingAttention = [];
    const challenge = checks.some((check) => check.category === 'challenge');
    return {
      status: challenge ? 'challenge_detected' : 'handoff_required',
      checks,
      message: challenge
        ? 'A bot challenge appeared. Do not try to solve it. Stop and tell the user; in a visible browser, call browser_request_handoff so a person can clear it.'
        : 'This step needs a person. Tell the user, then call browser_request_handoff and wait.',
    };
  }

  /**
   * Write <name>.spec.ts (and <name>.har when responses were retained) into the run folder from the
   * steps this session performed. Checks that matched become assertions.
   */
  async exportTest(name: string): Promise<{ runId: string; specPath: string; harPath: string | null; steps: number; assertions: number; harEntries: number }> {
    if (!/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(name)) {
      throw new BrowserRuntimeError('Use a test name of letters, digits, hyphens, and underscores (up to 61 characters).', 'INVALID_CONFIGURATION');
    }
    const runId = this.assertRunId();
    const runDir = this.assertRunDir();
    if (this.steps.length === 0) throw new BrowserRuntimeError('No steps were recorded in this session.', 'INVALID_STATE');
    await this.waitForEvidenceReads();
    const { har, entries } = buildHar(this.network.all());
    const harFile = entries > 0 ? `${name}.har` : null;
    const startUrl = this.steps.find((step): step is Extract<RecordedStep, { kind: 'navigate' }> => step.kind === 'navigate')?.url ?? null;
    const specPath = join(runDir, `${name}.spec.ts`);
    await writeFile(specPath, redactKnownSecrets(renderSpec(name, this.steps, { harFile, startUrl }), this.knownSecrets), { mode: 0o600 });
    const harPath = harFile ? join(runDir, harFile) : null;
    if (harPath) await writeFile(harPath, redactKnownSecrets(JSON.stringify(har, null, 2), this.knownSecrets), { mode: 0o600 });
    const assertions = this.steps.filter((step) => step.kind === 'verify' && step.matched).length;
    this.journal.record('Browser.export', { specPath, harPath, steps: this.steps.length, assertions });
    await this.persistManifest();
    return { runId, specPath, harPath, steps: this.steps.length, assertions, harEntries: entries };
  }

  private recordStep(step: RecordedStep): void {
    if (this.steps.length < MAX_RECORDED_STEPS) this.steps.push(step);
  }

  private async portableTarget(target: LocatorTarget): Promise<PortableTarget> {
    if (target.kind !== 'ref') return target;
    try {
      return await this.portableElement((await this.assertInspector().resolve({ ref: target.ref })).element);
    } catch (error) {
      return { kind: 'unportable', reason: `element ${target.ref} could not be resolved (${getErrorMessage(error).slice(0, 80)})` };
    }
  }

  /** Turn an inspected element into a unique CSS selector the exported test can use. */
  private async portableElement(element: ElementHandle<SVGElement | HTMLElement>): Promise<PortableTarget> {
    try {
      const frame = await element.ownerFrame();
      if (frame && frame !== this.assertPage().mainFrame()) return { kind: 'unportable', reason: 'the element is inside a child frame' };
      const selector = await element.evaluate((node) => {
        const unique = (candidate: string) => { try { return document.querySelectorAll(candidate).length === 1; } catch { return false; } };
        const tag = node.tagName.toLowerCase();
        for (const attribute of ['data-testid', 'data-test', 'data-cy', 'id', 'name', 'aria-label', 'placeholder']) {
          const value = node.getAttribute(attribute);
          if (!value) continue;
          const candidate = attribute === 'id' ? `#${CSS.escape(value)}` : `${tag}[${attribute}="${value.replace(/["\\]/g, '\\$&')}"]`;
          if (unique(candidate)) return candidate;
        }
        const parts: string[] = [];
        let current: Element | null = node;
        while (current && current !== document.body && parts.length < 8) {
          const parent: Element | null = current.parentElement;
          if (!parent) break;
          const same = [...parent.children].filter((child) => child.tagName === current!.tagName);
          const name = current.tagName.toLowerCase();
          parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(current) + 1})` : name);
          if (current.id) { parts[0] = `#${CSS.escape(current.id)}`; break; }
          current = parent;
        }
        const path = parts.join(' > ');
        return unique(path) ? path : null;
      });
      return selector ? { kind: 'selector', selector } : { kind: 'unportable', reason: 'no unique selector was found' };
    } catch (error) {
      return { kind: 'unportable', reason: `selector could not be computed (${getErrorMessage(error).slice(0, 80)})` };
    }
  }

  get isRawCdpEnabled(): boolean { return this.options.isRawCdpEnabled === true; }

  /** Advanced: send one CDP command on the page's session. Requires isRawCdpEnabled. */
  async cdp(method: string, params: Record<string, unknown> = {}): Promise<{ runId: string; method: string; result: unknown; truncated: boolean }> {
    const session = this.rawCdpSession(method);
    let result: unknown;
    try {
      result = await session.send(method as Parameters<CDPSession['send']>[0], params as never);
    } catch (error) {
      this.journal.record('Browser.cdp', { method, params, error: getErrorMessage(error) });
      throw new BrowserRuntimeError(`CDP ${method} failed: ${getErrorMessage(error)}`, 'ACTION_FAILED');
    }
    this.journal.record('Browser.cdp', { method, params, result });
    const bounded = this.boundedCdpValue(result);
    return { runId: this.assertRunId(), method, result: bounded.value, truncated: bounded.truncated };
  }

  /** Advanced: wait for the next CDP event of one name, up to timeoutMs. Enable its domain first. */
  async cdpWait(event: string, timeoutMs = 10_000): Promise<{ runId: string; event: string; status: 'received' | 'timeout'; params?: unknown; truncated?: boolean }> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new BrowserRuntimeError('timeoutMs must be 1 to 30000.', 'INVALID_CONFIGURATION');
    }
    const session = this.rawCdpSession(event);
    const runId = this.assertRunId();
    const received = await new Promise<unknown>((resolvePromise) => {
      const listener = (params: unknown) => { clearTimeout(timer); resolvePromise({ params }); };
      const timer = setTimeout(() => { session.off(event as never, listener); resolvePromise(undefined); }, timeoutMs);
      session.once(event as never, listener);
    });
    if (!received) return { runId, event, status: 'timeout' };
    const { params } = received as { params: unknown };
    this.journal.record('Browser.cdpEvent', { event, params });
    const bounded = this.boundedCdpValue(params);
    return { runId, event, status: 'received', params: bounded.value, truncated: bounded.truncated };
  }

  private rawCdpSession(name: string): CDPSession {
    if (!this.isRawCdpEnabled) throw new BrowserRuntimeError('Raw CDP is disabled. Set BROWSER_RAW_CDP=1 to enable it.', 'ACTION_BLOCKED');
    if (!/^[A-Z][A-Za-z]+\.[a-zA-Z]+$/.test(name)) throw new BrowserRuntimeError('Use a CDP name such as Performance.getMetrics.', 'INVALID_CONFIGURATION');
    if (BLOCKED_CDP_METHODS.has(name)) throw new BrowserRuntimeError(`${name} is blocked: the session owns the browser lifecycle.`, 'ACTION_BLOCKED');
    this.assertPage();
    const session = this.cdpSessions[0];
    if (!session) throw new BrowserRuntimeError('No CDP session is active.', 'INVALID_STATE');
    return session;
  }

  private boundedCdpValue(value: unknown): { value: unknown; truncated: boolean } {
    const scrubbed = this.scrub(value ?? null);
    const text = JSON.stringify(scrubbed);
    if (text.length <= MAX_CDP_RESULT_CHARS) return { value: scrubbed, truncated: false };
    return { value: `${text.slice(0, MAX_CDP_RESULT_CHARS)}…[truncated]`, truncated: true };
  }

  /** Add a fault rule. Faults run inside this browser only; the site's server never sees them. */
  addFault(rule: FaultRule): { runId: string | null; fault: ActiveFault; active: ActiveFault[] } {
    const parsed = faultSchema.parse(rule);
    let fault: ActiveFault;
    try { fault = this.faults.add(parsed); }
    catch (error) { throw new BrowserRuntimeError(getErrorMessage(error), 'ACTION_BLOCKED'); }
    this.journal.record('Browser.fault', { event: 'added', ...fault });
    return { runId: this.runId ?? null, fault, active: this.faults.list() };
  }

  clearFaults(): { cleared: number } {
    const cleared = this.faults.clear();
    this.journal.record('Browser.fault', { event: 'cleared', cleared });
    return { cleared };
  }

  private async applyFault(route: Route, fault: ActiveFault): Promise<void> {
    const request = route.request();
    const applied = (extra: Record<string, unknown> = {}) => this.journal.record('Browser.faultApplied', {
      faultId: fault.id, action: fault.action, url: request.url(), method: request.method(), ...extra });
    if (fault.action === 'fail') {
      applied({ errorCode: fault.errorCode ?? 'failed' });
      await route.abort(fault.errorCode ?? 'failed');
    } else if (fault.action === 'status') {
      const status = fault.status ?? 500;
      applied({ status });
      await route.fulfill({ status, body: fault.body ?? '', contentType: fault.contentType ?? 'text/plain' });
    } else if (fault.action === 'delay') {
      const delayMs = fault.delayMs ?? 3_000;
      applied({ delayMs });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
      // A delayed request was not modified, so it keeps the normal first-party header rules.
      if (this.options.bypassHeaderToken && this.classifyHost(request.url()) === 'first-party') {
        await route.continue({ headers: { ...request.headers(), [this.options.bypassHeaderName ?? DEFAULT_BYPASS_HEADER_NAME]: this.options.bypassHeaderToken } });
      } else await route.continue();
    } else {
      const response = await route.fetch({ maxRedirects: 0 });
      const original = await response.text();
      const result = fault.body !== undefined ? { body: fault.body, rewritten: true } : rewriteJson(original, fault.json ?? {});
      const status = fault.status ?? response.status();
      applied({ status, rewritten: result.rewritten });
      await route.fulfill({ response, status, body: result.body });
    }
  }

  private async settle(startedAt: number, budget?: ActionBudget): Promise<SettledState> {
    const page = this.assertPage();
    const quietMs = this.options.settleQuietMs ?? DEFAULT_SETTLE_QUIET_MS;
    const timeoutMs = this.options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const deadline = Math.min(Date.now() + timeoutMs, budget?.deadline ?? Infinity);
    let lastSignature = '';
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      budget?.remaining();
      let signature = lastSignature;
      try {
        const readSignature = () => page.evaluate(() => {
          const html = document.body?.outerHTML ?? '';
          let hash = 0;
          for (let i = 0; i < html.length; i++) hash = ((hash << 5) - hash + html.charCodeAt(i)) | 0;
          const running = document.getAnimations().some((animation) => animation.playState === 'running');
          return `${hash}:${running ? performance.now() : 'stable'}:${document.body?.scrollHeight}`;
        });
        signature = budget ? await budget.run(readSignature) : await readSignature();
      } catch (error) {
        budget?.remaining();
        // A navigation mid-settle destroys the execution context. The page is still
        // moving, so this is not a failure to report — reset the stability clock and
        // read the new document on the next pass.
        //
        // A closed page is a different thing: no new document is coming, so retrying to
        // the deadline would only delay the real error until receipt() reads page.url().
        // Fail fast, and as a typed error rather than a raw Playwright one.
        if (page.isClosed()) {
          throw new BrowserRuntimeError(
            'The page closed while waiting for it to settle.',
            'BROWSER_UNAVAILABLE',
            { error: getErrorMessage(error) },
          );
        }
        stableSince = Date.now();
      }
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      }
      const domStable = Date.now() - stableSince >= quietMs;
      const networkQuiet =
        this.pendingRequests.size === 0 && Date.now() - this.lastNetworkActivityAt >= quietMs;
      if (domStable && networkQuiet) {
        return { networkQuiet, domStable, waitedMs: Date.now() - startedAt };
      }
      if (budget) await budget.pause();
      else await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    return {
      networkQuiet:
        this.pendingRequests.size === 0 && Date.now() - this.lastNetworkActivityAt >= quietMs,
      domStable: Date.now() - stableSince >= quietMs,
      waitedMs: Date.now() - startedAt,
    };
  }

  private async attachPage(page: Page): Promise<void> {
    page.on('request', (request) => {
      this.pendingRequests.add(request);
      this.lastNetworkActivityAt = Date.now();
    });
    const finishRequest = (request: Request) => {
      this.pendingRequests.delete(request);
      this.lastNetworkActivityAt = Date.now();
    };
    page.on('requestfinished', finishRequest);
    page.on('requestfailed', finishRequest);
    page.on('console', (message) => {
      this.journal.record('Browser.console', {
        level: message.type(),
        text: message.text().slice(0, MAX_CONSOLE_CHARS),
        location: message.location(),
      });
    });
    page.on('pageerror', (error) => {
      this.journal.record('Browser.pageError', {
        message: error.message,
        stack: error.stack ?? null,
      });
    });
    const context = this.context;
    if (!context) return;
    const session = await context.newCDPSession(page);
    this.cdpSessions.push(session);
    await this.inspector?.attach(session).catch((error) => {
      this.captureHealth.push('DOM/CSS source inspection unavailable');
      console.warn('BrowserSession: DOM/CSS inspection unavailable', { error: getErrorMessage(error) });
    });
    await this.network.attach(session).catch((error) => {
      this.captureHealth.push('Network capture unavailable');
      console.warn('BrowserSession: network capture unavailable', { error: getErrorMessage(error) });
    });
    for (const domain of CDP_DOMAINS) {
      if (domain === 'Network') continue;
      await session.send(`${domain}.enable`).catch((error) => {
        console.warn('BrowserSession: CDP domain unavailable', { domain, error: getErrorMessage(error) });
        this.captureHealth.push(`${domain} capture unavailable`);
      });
    }
    // Lets request initiators and console stacks follow timers and promises back to the handler.
    await session.send('Runtime.setAsyncCallStackDepth', { maxDepth: ASYNC_STACK_DEPTH }).catch((error) => {
      this.captureHealth.push('Async stack capture unavailable');
      console.warn('BrowserSession: async stack capture unavailable', { error: getErrorMessage(error) });
    });
    await session.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch((error) => {
      this.captureHealth.push('Lifecycle capture unavailable');
      console.warn('BrowserSession: lifecycle capture unavailable', { error: getErrorMessage(error) });
    });
    for (const event of CDP_EVENTS) {
      session.on(event, (params: Record<string, unknown>) => this.journal.record(event, params));
    }
    watchForChallenges(session, (check) => void this.handleHumanCheck(check));
    page.on('framenavigated', (frame) => {
      if (this.waitingForHuman && frame === page.mainFrame()) void this.showHandoffBanner(page).catch(() => undefined);
    });
  }

  private classifyHost(rawUrl: string): 'first-party' | 'third-party' {
    try {
      const host = new URL(rawUrl).hostname;
      const configured = this.options.firstPartyHosts ?? [];
      if (configured.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
        return 'first-party';
      }
      if (!this.targetHost) return 'third-party';
      return this.registrableDomain(host) === this.registrableDomain(this.targetHost)
        ? 'first-party'
        : 'third-party';
    } catch {
      // Browser-internal and malformed URLs are not first-party web requests.
      return 'third-party';
    }
  }

  private registrableDomain(host: string): string {
    const labels = host.split('.');
    return labels.length <= 2 ? host : labels.slice(-2).join('.');
  }

  private async waitForEvidenceReads(): Promise<void> {
    await this.network.flush();
  }

  private async stopTrace(): Promise<void> {
    if (!this.context || !this.tracePath || this.traceStopped) return;
    await this.context.tracing.stop({ path: this.tracePath });
    this.traceStopped = true;
  }

  private async locateField(target: Exclude<LocatorTarget, { kind: 'ref' }>, budget?: ActionBudget): Promise<Locator> {
    const page = this.assertPage();
    let locator: Locator;
    switch (target.kind) {
      case 'label': {
        const name = target.label;
        locator = page.getByLabel(name, { exact: true }).or(page.getByPlaceholder(name, { exact: true }));
        for (const role of ['textbox', 'searchbox', 'combobox', 'spinbutton'] as const) {
          locator = locator.or(page.getByRole(role, { name, exact: true }));
        }
        break;
      }
      case 'role': locator = page.getByRole(target.role as Parameters<Page['getByRole']>[0], { name: target.name, exact: true }); break;
      case 'text': locator = page.getByText(target.text, { exact: true }); break;
      case 'selector': locator = page.locator(target.selector); break;
    }
    locator = locator.filter({ visible: true });
    try {
      if (budget) await budget.run((timeout) => locator.waitFor({ state: 'visible', timeout }));
      else await locator.waitFor({ state: 'visible' });
    } catch (error) {
      budget?.remaining();
      if ((budget ? await budget.run(() => locator.count()) : await locator.count()) === 0) {
        const diagnostic = actionFailure('target_not_found');
        throw new BrowserRuntimeError(diagnostic.message, 'ACTION_FAILED', { reason: diagnostic.reason });
      }
      throw error;
    }
    return locator;
  }

  private locate(target: LocatorTarget): Locator {
    const page = this.assertPage();
    switch (target.kind) {
      case 'ref': throw new BrowserRuntimeError('Reference actions use the element inspector.', 'INVALID_STATE');
      case 'role':
        return page.getByRole(target.role as Parameters<Page['getByRole']>[0], { name: target.name }).first();
      case 'label':
        return page.getByLabel(target.label).first();
      case 'text':
        return page.getByText(target.text).first();
      case 'selector':
        return page.locator(target.selector).first();
    }
  }


  private networkEvidence(event: ReturnType<EvidenceJournal['all']>[number]): NetworkEvidence {
    return {
      requestId: String(event.params.requestId ?? ''),
      failure: typeof event.params.failure === 'string' ? event.params.failure : null,
      bodyState: String(event.params.bodyState ?? 'unavailable'),
      sequence: event.sequence,
      timestamp: event.timestamp,
      url: String(event.params.url ?? ''),
      method: String(event.params.method ?? ''),
      status: Number(event.params.status ?? 0),
      hostClass: event.params.hostClass === 'first-party' ? 'first-party' : 'third-party',
      contentType: typeof event.params.contentType === 'string' ? event.params.contentType : null,
      bodyExcerpt: typeof event.params.bodyExcerpt === 'string' ? event.params.bodyExcerpt : null,
    };
  }

  private consoleEvidence(event: ReturnType<EvidenceJournal['all']>[number]): ConsoleEvidence {
    return {
      sequence: event.sequence,
      timestamp: event.timestamp,
      level: String(event.params.level ?? ''),
      text: String(event.params.text ?? ''),
      location: event.params.location,
    };
  }

  private pageErrorEvidence(event: ReturnType<EvidenceJournal['all']>[number]): PageErrorEvidence {
    return {
      sequence: event.sequence,
      timestamp: event.timestamp,
      message: String(event.params.message ?? ''),
      stack: typeof event.params.stack === 'string' ? event.params.stack : null,
    };
  }

  private async receipt(kind: string, settled: SettledState, evidenceSince: number, target?: string): Promise<ActionReceipt> {
    const page = this.assertPage();
    await this.checkPageForHumans(page);
    const attention = this.takeAttention();
    const receipt: ActionReceipt = {
      runId: this.assertRunId(),
      actionId: this.activeActionId,
      kind,
      url: redactUrl(page.url()),
      title: redactKnownSecrets(await page.title(), this.snapshotSecrets),
      settled,
      evidenceSince,
      ...(attention ? { attention } : {}),
    };
    this.journal.record('Browser.action', target ? { ...receipt, target } : receipt);
    await this.persistManifest();
    return receipt;
  }

  requests(query?: { url?: string | undefined; status?: number | undefined; since?: number | undefined }) {
    this.assertPage();
    return { runId: this.assertRunId(), ...this.network.list(query) };
  }

  request(id: string) {
    this.assertPage();
    const { body: _body, ...record } = this.network.get(id);
    return { runId: this.assertRunId(), ...record };
  }

  responseBody(id: string, offset?: number, limit?: number) {
    this.assertPage();
    return { runId: this.assertRunId(), ...this.network.body(id, offset, limit) };
  }

  /** Explain what one action caused. Defaults to the most recent action. */
  async explainAction(actionId?: number, filter: 'relevant' | 'all' = 'relevant'): Promise<ActionExplanation> {
    const runId = this.assertRunId();
    const latest = this.actionId;
    const target = actionId ?? latest;
    if (!Number.isInteger(target) || target < 1 || target > latest) {
      throw new BrowserRuntimeError(latest === 0 ? 'No action has run in this session.' : `Action IDs in this session are 1 to ${latest}.`,
        'INVALID_CONFIGURATION');
    }
    await this.waitForEvidenceReads();
    return this.scrub(explainAction({ runId, actionId: target, events: this.journal.all(), requests: this.network.all(),
      droppedEvents: this.journal.dropped, droppedRequests: this.network.dropped,
      hasCdpRuntime: !this.captureHealth.includes('Runtime capture unavailable'), filter }));
  }

  /**
   * Write report.html into the run folder. The caller supplies its goal, verdict and findings;
   * the session adds the action timeline, what each action caused, and screenshots.
   */
  async report(input: ReportInput): Promise<{ runId: string; path: string; actions: number; findings: number }> {
    const parsed = reportInputSchema.parse(input);
    const runId = this.assertRunId();
    this.assertRunDir();
    await this.waitForEvidenceReads();
    this.reportInput = parsed;
    const path = await this.writeReport(parsed);
    this.journal.record('Browser.report', { path, findings: parsed.findings.length });
    await this.persistManifest();
    return { runId, path, actions: this.actionId, findings: parsed.findings.length };
  }

  /** Render report.html from the current journal. close() calls it again so the timeline is complete. */
  private async writeReport(input: ReportInput): Promise<string> {
    const runId = this.assertRunId();
    const runDir = this.assertRunDir();
    const events = this.journal.all();
    const requests = this.network.all();
    const hasCdpRuntime = !this.captureHealth.includes('Runtime capture unavailable');
    const actions = Array.from({ length: this.actionId }, (_, index) => explainAction({ runId, actionId: index + 1, events, requests,
      droppedEvents: this.journal.dropped, droppedRequests: this.network.dropped, hasCdpRuntime }));
    const startUrl = actions.find((action) => action.action?.kind === 'navigate')?.action?.url
      ?? requests.find((request) => request.resourceType === 'Document')?.url ?? null;
    const html = renderReport(input, {
      runId, startedAt: this.runStartedAt, finishedAt: Date.now(),
      launchMode: this.options.launchMode ?? (this.options.headless === false ? 'headed' : 'headless'), startUrl, actions,
      screenshots: this.artifacts.map((artifact) => ({ path: String(artifact.path), actionId: Number(artifact.actionId ?? 0),
        timestamp: Number(artifact.timestamp ?? 0), url: String(artifact.url ?? '') })),
      capture: { requests: requests.length, droppedRequests: this.network.dropped, droppedEvents: this.journal.dropped,
        captureHealth: [...this.captureHealth] },
    });
    const path = join(runDir, 'report.html');
    await writeFile(path, redactKnownSecrets(html, this.knownSecrets), { mode: 0o600 });
    return path;
  }

  /** Used when the agent closes without browser_report: the timeline and captured errors, no verdict. */
  private defaultReportInput(): ReportInput {
    let site = 'the site';
    try { site = new URL(String(this.journal.all().find((event) => event.method === 'Browser.action' && event.params.url)?.params.url)).host; }
    catch { /* no navigation was recorded */ }
    return reportInputSchema.parse({
      title: `Browser session on ${site}`,
      goal: 'Not stated. The agent closed the session without calling browser_report.',
      summary: `${this.actionId} browser actions were recorded. No findings or verdict were reported by the agent; the timeline below shows what each action caused.`,
    });
  }

  frames() { return this.scrub(this.assertInspector().listFrames()); }

  async inspect(target: InspectTarget, properties?: string[]) {
    const result = this.scrub(await this.assertInspector().inspect(target, properties));
    const eventId = this.journal.record('Browser.inspection', result);
    await this.persistManifest();
    return { runId: this.assertRunId(), eventId, ...result };
  }

  private async viewportImpl(width: number, height: number): Promise<ActionReceipt> {
    if (![width, height].every((n) => Number.isInteger(n) && n >= 240 && n <= 2560)) {
      throw new BrowserRuntimeError('Viewport dimensions must be integers from 240 to 2560.', 'INVALID_CONFIGURATION');
    }
    const since = this.startAction();
    await this.assertPage().setViewportSize({ width, height });
    return this.receipt('viewport', await this.settle(Date.now()), since);
  }

  private assertInspector(): ElementInspector {
    if (!this.inspector) throw new BrowserRuntimeError('Navigate before inspecting elements.', 'INVALID_STATE');
    return this.inspector;
  }

  private async elementAction(ref: string, action: 'click' | 'fill' | 'hover', value = ''): Promise<ActionReceipt> {
    const { element } = await this.assertInspector().resolve({ ref });
    const portable = await this.portableElement(element);
    const sensitive = action === 'fill' && await element.evaluate(isPasswordField).catch(() => false);
    const since = this.startAction();
    if (action === 'click') {
      await element.click();
    } else if (action === 'fill') await element.fill(value);
    else await element.hover();
    this.recordStep(action === 'fill' ? { kind: 'type', target: portable, value, sensitive } : { kind: action, target: portable });
    return this.receipt(action, await this.settle(Date.now()), since, describeTarget({ kind: 'ref', ref }));
  }

  private scrub<T>(value: T): T {
    return JSON.parse(redactKnownSecrets(JSON.stringify(redactValue(value)), this.knownSecrets)) as T;
  }

  private scheduleManifest(): void {
    if (!this.runDir || this.manifestTimer || this.closing) return;
    this.manifestTimer = setTimeout(() => {
      this.manifestTimer = undefined;
      void this.persistManifest().catch((error) => {
        if (!this.captureHealth.includes('Evidence persistence failed')) this.captureHealth.push('Evidence persistence failed');
        console.error('BrowserSession: evidence persistence failed', { error: getErrorMessage(error) });
      });
    }, 100);
    this.manifestTimer.unref();
  }

  private async persistManifest(): Promise<void> {
    if (!this.runDir) return;
    const path = join(this.runDir, 'evidence.json');
    const content = JSON.stringify(this.scrub({ version: 1, runId: this.runId, timestamp: Date.now(),
      url: this.page ? redactUrl(this.page.url()) : null, droppedEvents: this.journal.dropped,
      droppedRequests: this.network.dropped, captureHealth: this.captureHealth, authentication: this.authentication,
      launchMode: this.options.launchMode ?? (this.options.headless === false ? 'headed' : 'headless'),
      events: this.journal.all(), requests: this.network.all(), artifacts: this.artifacts }), null, 2);
    this.manifestWrite = this.manifestWrite.catch(() => undefined).then(async () => {
      await writeFile(`${path}.tmp`, content, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    await this.manifestWrite;
  }

  private assertPage(): Page {
    if (!this.page) throw new BrowserRuntimeError('No browser page is active.', 'INVALID_STATE');
    if (this.page.isClosed()) {
      throw new BrowserRuntimeError('The browser page is closed. Close the session, then navigate to start a new run.', 'INVALID_STATE');
    }
    return this.page;
  }

  private assertRunId(): string {
    if (!this.runId) throw new BrowserRuntimeError('No browser session is active.', 'INVALID_STATE');
    return this.runId;
  }

  private assertRunDir(): string {
    if (!this.runDir) throw new BrowserRuntimeError('No artifact directory is active.', 'INVALID_STATE');
    return this.runDir;
  }
}

function parseNavigableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserRuntimeError(`Invalid URL: ${raw}`, 'INVALID_CONFIGURATION');
  }
  if (!['http:', 'https:', 'file:', 'data:', 'about:'].includes(url.protocol)) {
    throw new BrowserRuntimeError(`Unsupported URL protocol: ${url.protocol}`, 'INVALID_CONFIGURATION');
  }
  return url;
}

function isSecureCredentialOrigin(url: URL): boolean {
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function describeTarget(target: LocatorTarget): string {
  switch (target.kind) {
    case 'role': return `${target.role} "${target.name}"`;
    case 'label': return `field "${target.label}"`;
    case 'text': return `"${target.text}"`;
    case 'selector': return target.selector;
    case 'ref': return target.ref;
  }
}

/** A readable, unique run folder: local start time, site host, and the start of the run ID. */
export function runFolderName(startedAt: number, host: string | undefined, runId: string): string {
  const date = new Date(startedAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const site = (host ?? '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'local';
  return `${stamp}_${site}_${runId.slice(0, 8)}`;
}

function isPasswordField(node: Element): boolean {
  return node instanceof HTMLInputElement && node.type === 'password';
}
