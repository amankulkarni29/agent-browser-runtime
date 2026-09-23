import { EvidenceJournal } from '../../src/core/evidence-journal.js';

describe('EvidenceJournal', () => {
  it('keeps a bounded event window without reusing sequence numbers', () => {
    const journal = new EvidenceJournal(2);

    journal.record('one', {});
    journal.record('two', {});
    journal.record('three', {});

    expect(journal.all().map((event) => event.sequence)).toEqual([2, 3]);
    expect(journal.since(1).map((event) => event.sequence)).toEqual([2, 3]);
    expect(journal.bookmark()).toBe(3);
  });

  it('retains login, action and verification outcomes across a noisy event flood', () => {
    const journal = new EvidenceJournal(32);
    const outcomes = [
      ['Browser.login', { status: 'success' }],
      ['Browser.login', { status: 'timeout', phase: 'submit' }],
      ['Browser.loginVerification', { clicks: 1 }],
      ['Browser.action', { actionId: 1, kind: 'click' }],
      ['Browser.actionFailed', { kind: 'type', reason: 'not-editable' }],
      ['Browser.verify', { status: 'failed' }],
      ['Browser.sequence', { status: 'failed', completedSteps: 1 }],
    ] satisfies [string, Record<string, unknown>][];
    const outcomeIds = outcomes.map(([method, params]) => journal.record(method, params));

    for (let index = 0; index < 100; index++) {
      journal.record('Network.loadingFailed', { requestId: `request-${index}` });
      journal.record('Browser.response', { status: 500 });
      journal.record('Browser.console', { level: 'error', text: 'request failed' });
    }

    expect(journal.all().slice(0, outcomes.length).map((event) => [event.method, event.params])).toEqual(outcomes);
    expect(journal.all().slice(0, outcomes.length).map((event) => event.sequence)).toEqual(outcomeIds);
    expect(journal.all()).toHaveLength(32);
    expect(journal.dropped).toBe(275);
    expect(journal.bookmark()).toBe(307);
  });

  it('keeps retained events chronological and bookmarks exclusive after selective eviction', () => {
    const journal = new EvidenceJournal(8);
    journal.record('Browser.login', { status: 'success' });
    journal.record('Browser.response', {});
    const bookmark = journal.bookmark();
    journal.record('Browser.action', { kind: 'click' });
    for (let index = 0; index < 20; index++) journal.record('Network.requestWillBeSent', {});

    expect(journal.all().map((event) => event.sequence)).toEqual([1, 3, 18, 19, 20, 21, 22, 23]);
    expect(journal.since(bookmark).map((event) => event.sequence)).toEqual([3, 18, 19, 20, 21, 22, 23]);
    expect(journal.since(3).map((event) => event.sequence)).toEqual([18, 19, 20, 21, 22, 23]);
    expect(journal.since(journal.bookmark())).toEqual([]);
    expect(journal.record('Browser.actionFailed', {})).toBe(24);
    expect(journal.all().map((event) => event.sequence)).toEqual([3, 18, 19, 20, 21, 22, 23, 24]);
    expect(journal.dropped).toBe(16);
  });

  it('bounds protected evidence while allowing every event category to use spare capacity', () => {
    const journal = new EvidenceJournal(8);
    for (let index = 0; index < 20; index++) journal.record('Browser.action', { actionId: index });

    expect(journal.all().map((event) => event.sequence)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);

    for (let index = 0; index < 20; index++) journal.record('Browser.response', {});

    expect(journal.all().map((event) => event.sequence)).toEqual([19, 20, 35, 36, 37, 38, 39, 40]);
    expect(journal.dropped).toBe(32);
  });

  it('clears protected retention state and resets sequence numbers', () => {
    const journal = new EvidenceJournal(4);
    journal.record('Browser.action', {});
    journal.record('Browser.login', {});
    journal.clear();

    expect(journal.all()).toEqual([]);
    expect(journal.bookmark()).toBe(0);
    expect(journal.dropped).toBe(0);
    expect(journal.record('Browser.login', { status: 'success' })).toBe(1);
    for (let index = 0; index < 10; index++) journal.record('Browser.response', {});
    expect(journal.all().map((event) => event.sequence)).toEqual([1, 9, 10, 11]);
    expect(journal.dropped).toBe(7);
  });

  it('honors a zero event capacity while advancing bookmarks and reporting changes', () => {
    const onChange = jest.fn();
    const journal = new EvidenceJournal(0, [], onChange);
    journal.record('Browser.login', {});
    journal.record('Browser.response', {});

    expect(journal.all()).toEqual([]);
    expect(journal.bookmark()).toBe(2);
    expect(journal.dropped).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('redacts and bounds protected evidence before retaining it', () => {
    const journal = new EvidenceJournal(4, ['shh-secret']);
    journal.record('Browser.login', {
      status: 'failed',
      password: 'entered-password',
      detail: 'echo: shh-secret received',
      url: 'https://example.test/login?token=url-secret',
      diagnostic: 'x'.repeat(15_000),
    });
    for (let index = 0; index < 10; index++) journal.record('Browser.response', {});

    const login = journal.all()[0]!;
    expect(login.method).toBe('Browser.login');
    expect(login.params.password).toBe('[REDACTED]');
    expect(login.params.detail).toBe('echo: [REDACTED] received');
    expect(new URL(String(login.params.url)).searchParams.get('token')).toBe('[REDACTED]');
    expect(login.params.diagnostic).toBe('x'.repeat(12_000));
    expect(login.params.captureTruncated).toBe(true);
  });

  it('scrubs a configured known secret out of recorded event text', () => {
    const journal = new EvidenceJournal(2_000, ['shh-secret']);

    journal.record('Browser.response', { bodyExcerpt: 'echo: shh-secret received' });
    journal.record('Browser.console', { text: 'value was shh-secret' });

    const [response, consoleEvent] = journal.all();
    expect(response!.params.bodyExcerpt).toBe('echo: [REDACTED] received');
    expect(consoleEvent!.params.text).toBe('value was [REDACTED]');
  });

  it('does not alter recorded text when no known secret is configured', () => {
    const journal = new EvidenceJournal();

    journal.record('Browser.response', { bodyExcerpt: 'plain body' });

    expect(journal.all()[0]!.params.bodyExcerpt).toBe('plain body');
  });
});
