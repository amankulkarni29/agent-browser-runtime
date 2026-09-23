import type { BrowserSession } from '../core/browser-session.js';
import { z } from 'zod';
import { reportInputSchema } from '../core/run-report.js';

const exportSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,60}$/i)
  .describe('Test name: letters, digits, hyphens, underscores.') }).strict();

/** Both transports share the report schema; the session renders and stores the file. */
export function reportTools(session: BrowserSession) {
  return [
    {
      name: 'browser_report',
      description: 'Write an HTML QA report (report.html) into the run folder before browser_close. Supply the goal, a plain-language summary, each finding (severity, first- or third-party, steps, expected, actual, action IDs, evidence) and an optional draft GitHub issue. The runtime adds the full action timeline, what each action caused, and screenshots. It does not judge findings; the caller owns the verdict.',
      schema: reportInputSchema,
      run: (args: unknown) => session.report(reportInputSchema.parse(args)),
    },
    {
      name: 'browser_export_test',
      description: 'Export this session as a Playwright test: writes <name>.spec.ts and a <name>.har of retained responses into the run folder. Clicks, typing, key presses and navigation become steps; browser_verify and sequence checks that matched become expect() assertions. Element refs are converted to unique CSS selectors. Password values are never exported. Run it with npx playwright test; REPLAY=har replays recorded responses.',
      schema: exportSchema,
      run: (args: unknown) => session.exportTest(exportSchema.parse(args).name),
    },
  ];
}

export const REPORT_TOOL_NAMES = ['browser_report', 'browser_export_test'];
