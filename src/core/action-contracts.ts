import { z } from 'zod';
import type { BrowserErrorCode } from './errors.js';
import type { BrowserEvidence } from './types.js';

const targetText = z.string().min(1).max(2_000);
const locatorTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ref'), ref: targetText }).strict(),
  z.object({ kind: z.literal('role'), role: z.string().min(1).max(100), name: targetText }).strict(),
  z.object({ kind: z.literal('label'), label: targetText }).strict(),
  z.object({ kind: z.literal('text'), text: targetText }).strict(),
  z.object({ kind: z.literal('selector'), selector: targetText }).strict(),
]);

export const browserTimeoutSchema = z.number().int().min(1).max(30_000);
export const browserConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), equals: z.string().url().max(2_000) }).strict(),
  z.object({ kind: z.literal('count'), target: locatorTargetSchema, equals: z.number().int().min(0).max(100_000) }).strict(),
  z.object({ kind: z.literal('state'), target: locatorTargetSchema,
    state: z.enum(['visible', 'hidden', 'enabled', 'disabled']) }).strict(),
  z.object({ kind: z.literal('text'), target: locatorTargetSchema, equals: z.string().max(10_000) }).strict(),
  z.object({ kind: z.literal('value'), target: locatorTargetSchema, equals: z.string().max(10_000) }).strict(),
]);

export const browserStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), target: locatorTargetSchema, expect: browserConditionSchema.optional() }).strict(),
  z.object({ kind: z.literal('type'), target: locatorTargetSchema, value: z.string().max(10_000), expect: browserConditionSchema.optional() }).strict(),
  z.object({ kind: z.literal('press'), key: z.string().min(1).max(100), expect: browserConditionSchema.optional() }).strict(),
  z.object({ kind: z.literal('hover'), target: locatorTargetSchema, expect: browserConditionSchema.optional() }).strict(),
  z.object({ kind: z.literal('verify'), condition: browserConditionSchema }).strict(),
]);
export const browserStepsSchema = z.array(browserStepSchema).min(1).max(10);

export type BrowserCondition = z.infer<typeof browserConditionSchema>;
export type BrowserStep = z.infer<typeof browserStepSchema>;
export type OperationDiagnostic = { reason: string; message: string; code?: BrowserErrorCode };
export type VerificationResult = {
  status: 'matched' | 'unmet' | 'error';
  kind: BrowserCondition['kind'];
  evidenceSince: number;
  diagnostic?: OperationDiagnostic;
};
export type SequenceStepResult = {
  index: number;
  kind: BrowserStep['kind'];
  status: 'completed' | 'verified' | 'failed';
  evidenceSince: number;
  verification?: VerificationResult;
  diagnostic?: OperationDiagnostic;
};
export type SequenceResult = {
  status: 'completed' | 'stopped';
  runId?: string;
  evidenceSince: number;
  steps: SequenceStepResult[];
  evidence: BrowserEvidence;
};
