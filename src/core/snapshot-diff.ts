/**
 * Compare two Playwright ARIA snapshots (the YAML-like text from `locator.ariaSnapshot()`) as
 * trees, and describe what changed in plain lines.
 */
type AriaNode = { role: string; name: string | null; attributes: Set<string>; value: string | null; children: AriaNode[] };

export type SnapshotChange =
  | { kind: 'added' | 'removed'; node: string }
  | { kind: 'changed'; node: string; detail: string };

export type SnapshotDiff = {
  changes: SnapshotChange[];
  summary: { added: number; removed: number; changed: number; omitted: number };
  text: string;
  fullSnapshotChars: number;
  diffChars: number;
};

const MAX_CHANGES = 60;
const LINE = /^(\s*)- (?:"([^"]*)"|([\w-]+))(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)(?::\s*(.*))?$/;

function parse(snapshot: string): AriaNode[] {
  const root: AriaNode = { role: 'root', name: null, attributes: new Set(), value: null, children: [] };
  const stack: { indent: number; node: AriaNode }[] = [{ indent: -1, node: root }];
  for (const line of snapshot.split('\n')) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, indentText = '', quotedText, roleText, name, attributeText = '', rawValue] = match;
    // `- /url: "…"` and similar lines are properties of the parent node.
    if (roleText?.startsWith('/')) continue;
    const indent = indentText.length;
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const value = quotedText !== undefined ? quotedText : rawValue?.trim() ? rawValue.trim().replace(/^"|"$/g, '') : null;
    const node: AriaNode = {
      role: quotedText !== undefined ? 'text' : roleText!,
      name: name ?? null,
      attributes: new Set([...attributeText.matchAll(/\[([^\]]+)\]/g)].map((item) => item[1]!)),
      value,
      children: [],
    };
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ indent, node });
  }
  return root.children;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function firstNamed(node: AriaNode): AriaNode | undefined {
  for (const child of node.children) {
    if (child.name !== null || child.value) return child;
    const found = firstNamed(child);
    if (found) return found;
  }
  return undefined;
}

/** Named nodes show their name; unnamed nodes show their text or first named descendant. */
function label(node: AriaNode, detailed: boolean): string {
  if (node.name !== null) return `${node.role} "${node.name}"`;
  if (!detailed) return node.role;
  if (node.value) return `${node.role} "${truncate(node.value, 60)}"`;
  const inner = firstNamed(node);
  return inner ? `${node.role} (${label(inner, true)})` : node.role;
}

function identity(node: AriaNode): string {
  return node.name !== null ? `${node.role}\u0000${node.name}` : node.role;
}

function describeAttributes(before: Set<string>, after: Set<string>): string[] {
  const details: string[] = [];
  const names = new Set([...before, ...after].map((attribute) => attribute.split('=')[0]!));
  for (const name of names) {
    const was = [...before].find((attribute) => attribute.split('=')[0] === name);
    const now = [...after].find((attribute) => attribute.split('=')[0] === name);
    if (was === now) continue;
    if (name === 'disabled') details.push(now ? 'now disabled' : 'now enabled');
    else if (['checked', 'pressed', 'expanded', 'selected'].includes(name)) {
      details.push(now && now !== `${name}=false` ? `now ${name}` : `no longer ${name}`);
    } else details.push(`${name}: ${was ?? 'unset'} → ${now ?? 'unset'}`);
  }
  return details;
}

/** Pair siblings with the same role and name: equal text first, then in document order. */
function compare(before: AriaNode[], after: AriaNode[], changes: SnapshotChange[]): void {
  const unmatchedBefore = new Set(before);
  const pairs = new Map<AriaNode, AriaNode>();
  for (const pass of ['value', 'order'] as const) {
    for (const node of after) {
      if (pairs.has(node)) continue;
      const partner = [...unmatchedBefore].find((candidate) => identity(candidate) === identity(node) &&
        (pass === 'order' || candidate.value === node.value));
      if (partner) { pairs.set(node, partner); unmatchedBefore.delete(partner); }
    }
  }
  for (const node of before) if (unmatchedBefore.has(node)) changes.push({ kind: 'removed', node: label(node, true) });
  for (const node of after) {
    const old = pairs.get(node);
    if (!old) { changes.push({ kind: 'added', node: label(node, true) }); continue; }
    const details = describeAttributes(old.attributes, node.attributes);
    if (old.value !== node.value) details.push(`"${truncate(old.value ?? '', 80)}" → "${truncate(node.value ?? '', 80)}"`);
    if (details.length) changes.push({ kind: 'changed', node: label(old, false), detail: details.join(', ') });
    compare(old.children, node.children, changes);
  }
}

export function diffSnapshots(before: string, after: string): SnapshotDiff {
  const all: SnapshotChange[] = [];
  compare(parse(before), parse(after), all);
  const changes = all.slice(0, MAX_CHANGES);
  const summary = {
    added: all.filter((change) => change.kind === 'added').length,
    removed: all.filter((change) => change.kind === 'removed').length,
    changed: all.filter((change) => change.kind === 'changed').length,
    omitted: Math.max(0, all.length - MAX_CHANGES),
  };
  const lines = changes.map((change) => change.kind === 'changed' ? `changed ${change.node}: ${change.detail}` : `${change.kind} ${change.node}`);
  if (summary.omitted) lines.push(`+ ${summary.omitted} more change(s) omitted; take a full snapshot`);
  const text = lines.length ? lines.join('\n') : 'No accessibility changes.';
  return { changes, summary, text, fullSnapshotChars: after.length, diffChars: text.length };
}
