import { EventEmitter } from 'node:events';
import type { CDPSession } from 'playwright';
import { NetworkRecorder, type RequestRecord } from '../../src/core/network-recorder.js';

function fixture() {
  const events = new EventEmitter();
  const send = jest.fn().mockResolvedValue({});
  const session = Object.assign(events, { send }) as unknown as CDPSession;
  const emitted: RequestRecord[] = [];
  const recorder = new NetworkRecorder(() => 'first-party', () => 3, (record) => emitted.push(record), []);
  const request = (id: string, postData?: string) => events.emit('Network.requestWillBeSent', { requestId: id, initiator: {},
    request: { url: 'https://example.com/api', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, postData } });
  return { events, send, session, recorder, emitted, request };
}

it('reports capture eviction and redacts form payloads', async () => {
  const f = fixture();
  await f.recorder.attach(f.session);
  for (let i = 0; i < 121; i++) f.request(String(i), 'password=private&cart=3');
  expect(f.recorder.list().dropped).toBe(1);
  expect(f.recorder.list().requests).toHaveLength(120);
  expect(() => f.recorder.get('request-1')).toThrow('evicted');
  expect(f.recorder.get('request-121').payload).not.toContain('private');
});

it('bounds a body read that never completes and reports a timeout', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    await f.recorder.attach(f.session);
    f.send.mockImplementation((method) => method === 'Network.getResponseBody' ? new Promise(() => {}) : Promise.resolve({}));
    f.request('pending');
    f.events.emit('Network.responseReceived', { requestId: 'pending', response: { status: 200, headers: { 'content-type': 'application/json' } } });
    f.events.emit('Network.loadingFinished', { requestId: 'pending', encodedDataLength: 20 });
    const flushed = f.recorder.flush();
    await jest.advanceTimersByTimeAsync(2001);
    await flushed;
    expect(f.recorder.body('request-1').state).toBe('timeout');
    expect(f.emitted).toHaveLength(1);
  } finally { jest.useRealTimers(); }
});

it('redacts before paging and reports retained truncation separately from paging', async () => {
  const f = fixture();
  await f.recorder.attach(f.session);
  f.send.mockResolvedValue({ body: JSON.stringify({ token: 'private', padding: 'x'.repeat(70000) }), base64Encoded: false });
  f.request('large');
  f.events.emit('Network.responseReceived', { requestId: 'large', response: { status: 200, headers: { 'content-type': 'application/json' } } });
  f.events.emit('Network.loadingFinished', { requestId: 'large', encodedDataLength: 20000 });
  await f.recorder.flush();
  expect(f.recorder.body('request-1', 0, 50)).toMatchObject({ state: 'truncated', nextOffset: 50, retainedChars: 64000 });
  expect(f.recorder.body('request-1').text).not.toContain('private');
});

it('caps concurrent body reads and reports skipped capture explicitly', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    await f.recorder.attach(f.session);
    f.send.mockImplementation((method) => method === 'Network.getResponseBody' ? new Promise(() => {}) : Promise.resolve({}));
    for (let i = 0; i < 20; i++) {
      const id = String(i);
      f.request(id);
      f.events.emit('Network.responseReceived', { requestId: id, response: { status: 200, headers: { 'content-type': 'application/json' } } });
      f.events.emit('Network.loadingFinished', { requestId: id, encodedDataLength: 20 });
    }
    expect(f.recorder.body('request-20')).toMatchObject({ state: 'unavailable', reason: 'Concurrent body capture limit reached' });
    await jest.advanceTimersByTimeAsync(2001);
    await f.recorder.flush();
  } finally { jest.useRealTimers(); }
});

it.each([false, true])('rejects oversized decoded bodies with base64Encoded=%s despite a small wire size', async (base64Encoded) => {
  const f = fixture();
  await f.recorder.attach(f.session);
  const decoded = 'é'.repeat(128001);
  f.send.mockResolvedValue({ body: base64Encoded ? Buffer.from(decoded).toString('base64') : decoded, base64Encoded });
  f.request('compressed');
  f.events.emit('Network.responseReceived', { requestId: 'compressed', response: { status: 200,
    headers: { 'content-type': 'text/plain', 'content-length': '1000' } } });
  f.events.emit('Network.loadingFinished', { requestId: 'compressed', encodedDataLength: 1000 });
  await f.recorder.flush();
  expect(f.recorder.body('request-1')).toMatchObject({ state: 'too-large', retainedChars: 0,
    reason: 'Decoded response exceeds 256000 bytes' });
  expect(f.recorder.get('request-1').body).toBeNull();
});
