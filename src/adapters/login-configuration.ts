import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { BrowserRuntimeError } from '../core/errors.js';
import type { BrowserSessionOptions } from '../core/types.js';

const locator = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), role: z.string().min(1), name: z.string().min(1) }),
  z.object({ kind: z.literal('label'), label: z.string().min(1) }),
  z.object({ kind: z.literal('text'), text: z.string().min(1) }),
  z.object({ kind: z.literal('selector'), selector: z.string().min(1) }),
]);
const brand = z.object({
  brand: z.string().min(1), environment: z.string().min(1),
  loginUrl: z.string().url(),
  usernameField: locator.optional(), passwordField: locator.optional(), submitField: locator.optional(),
  credentialOrigins: z.array(z.string().url()).optional(),
  successSignal: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('url'), pattern: z.string().min(1) }),
    z.object({ kind: z.literal('element'), target: locator }),
  ]),
  invalidCredentialsSignal: z.object({ target: locator }).optional(),
  challengeSignals: z.array(z.object({ target: locator, challengeType: z.enum(['mfa', 'captcha']) })).optional(),
  loginTimeoutMs: z.number().int().positive().max(60_000).optional(),
});
const credentials = z.object({ email: z.string().min(1), password: z.string().min(1) });
const account = z.object({ profile: z.string().min(1), credentials });
/** One account (`profile` + `credentials`) or several (`accounts`), sharing one list of brands. */
const configuration = z.union([
  z.object({ profile: z.string().min(1), credentials, brands: z.array(brand).min(1) }),
  z.object({ accounts: z.array(account).min(1), brands: z.array(brand).min(1) }),
]);

/** The orchestrator owns this private file; its contents never enter tool arguments. */
export function loginOptionsFromFile(file: string | undefined): Pick<BrowserSessionOptions, 'loginBrandConfigs' | 'accountCredentialProvider'> {
  if (!file) return {};
  try {
    const value = configuration.parse(JSON.parse(readFileSync(file, 'utf8')));
    for (const brand of value.brands) {
      if (brand.successSignal.kind === 'url') new RegExp(brand.successSignal.pattern);
      if (!['https:', 'http:'].includes(new URL(brand.loginUrl).protocol)) throw new Error('Invalid protocol');
    }
    const accounts = 'accounts' in value ? value.accounts : [{ profile: value.profile, credentials: value.credentials }];
    return {
      loginBrandConfigs: value.brands,
      accountCredentialProvider: (target) => value.brands.some(
        (candidate) => candidate.brand === target.brand && candidate.environment === target.environment,
      ) ? accounts.find((candidate) => candidate.profile === target.profile)?.credentials : undefined,
    };
  } catch {
    throw new BrowserRuntimeError('Could not load the private browser login configuration.', 'INVALID_CONFIGURATION');
  }
}
