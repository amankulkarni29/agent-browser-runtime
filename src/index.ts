import './core/bundled-browser.js';

export { BrowserSession } from './core/browser-session.js';
export type { InspectTarget } from './core/element-inspector.js';
export type { BrowserCondition, BrowserStep, VerificationResult, SequenceResult } from './core/action-contracts.js';
export type { RequestRecord } from './core/network-recorder.js';
export { BrowserRuntimeError, getErrorMessage } from './core/errors.js';
export { LOGIN_INTERFACE_VERSION } from './core/types.js';
export const LOGIN_CONFIGURATION_VERSION = 1;
export const BROWSER_LAUNCH_INTERFACE_VERSION = 1;
export type {
  AccountCredentialProvider,
  AccountCredentials,
  ActionReceipt,
  BrowserEvidence,
  BrowserSessionOptions,
  CloseResult,
  ConsoleEvidence,
  EvidenceEvent,
  EvidenceFilter,
  EvidenceQuery,
  LocatorTarget,
  LoginBrandConfig,
  LoginChallengeSignal,
  LoginElementSignal,
  LoginOutcome,
  LoginFailureDiagnostic,
  LoginSuccessSignal,
  LoginTarget,
  NetworkEvidence,
  OverlayDismissal,
  PageErrorEvidence,
  PageSnapshot,
  ScreenshotArtifact,
  SettledState,
} from './core/types.js';
