import { diffSnapshots } from '../../src/core/snapshot-diff.js';

const BEFORE = `- heading "Dynamic Controls" [level=1]
- checkbox "A checkbox"
- button "Remove"
- textbox "Note" [disabled]
- button "Enable"
- status: Idle
- navigation:
  - list:
    - listitem:
      - link "Home":
        - /url: /
    - listitem:
      - link "Gallery":
        - /url: /gallery`;

it('reports removed, added, enabled, and changed-text nodes without repeating unchanged ones', () => {
  const after = BEFORE.replace('- checkbox "A checkbox"\n- button "Remove"', '- button "Add"')
    .replace('- textbox "Note" [disabled]', '- textbox "Note"').replace('button "Enable"', 'button "Disable"')
    .replace('status: Idle', 'status: Saved');
  const diff = diffSnapshots(BEFORE, after);
  expect(diff.text.split('\n')).toEqual(expect.arrayContaining([
    'removed checkbox "A checkbox"', 'removed button "Remove"', 'added button "Add"',
    'changed textbox "Note": now enabled', 'changed status: "Idle" → "Saved"',
    'removed button "Enable"', 'added button "Disable"',
  ]));
  expect(diff.text).not.toContain('Dynamic Controls');
  expect(diff.summary).toEqual({ added: 2, removed: 3, changed: 2, omitted: 0 });
});

it('names an unnamed container by its first named descendant and reports only the top-most node', () => {
  const after = BEFORE.replace(`    - listitem:
      - link "Gallery":
        - /url: /gallery`, '');
  expect(diffSnapshots(BEFORE, after).text).toBe('removed listitem (link "Gallery")');
});

it('matches repeated siblings by text before position and reports checked state', () => {
  const before = '- listitem: Apples\n- listitem: Pears\n- checkbox "Agree"';
  const after = '- listitem: Figs\n- listitem: Apples\n- listitem: Pears\n- checkbox "Agree" [checked]';
  expect(diffSnapshots(before, after).text).toBe('added listitem "Figs"\nchanged checkbox "Agree": now checked');
});

it('caps long diffs and reports no change explicitly', () => {
  const many = Array.from({ length: 80 }, (_, index) => `- button "Item ${index}"`).join('\n');
  const diff = diffSnapshots('', many);
  expect(diff.changes).toHaveLength(60);
  expect(diff.summary.omitted).toBe(20);
  expect(diff.text).toContain('+ 20 more change(s) omitted');
  expect(diffSnapshots(BEFORE, BEFORE).text).toBe('No accessibility changes.');
});
