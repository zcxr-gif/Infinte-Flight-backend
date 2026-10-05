/**
 * if_rate_gate.test.cjs — a 429 must not stall the flight poll.
 *
 * Run with: npm test   (or: node if_rate_gate.test.cjs)
 *
 * Uses a real axios client against a local HTTP server, so what is asserted is
 * what goes over the wire: how many requests a 429 costs, and which ones wait.
 */

const assert = require('assert');
const http = require('http');
const axios = require('axios');
const { createRateGate, installRateGate, parseRetryAfter, POLL } = require('./if_rate_gate.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A server that answers 429 (Retry-After: retryAfter) to the first `limited` requests. */
async function startServer({ limited = 0, retryAfter = '1' } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, at: Date.now() });
    if (hits.length <= limited) {
      res.writeHead(429, { 'Retry-After': retryAfter });
      return res.end('{}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}` });
  return { client, hits, close: () => new Promise((r) => server.close(r)) };
}

const quiet = (fn) => async () => {
  const { warn, error } = console;
  console.warn = console.error = () => {};
  try { await fn(); } finally { console.warn = warn; console.error = error; }
};

test('Retry-After is read as seconds or as a date', () => {
  assert.strictEqual(parseRetryAfter('3'), 3000);
  assert.strictEqual(parseRetryAfter(new Date(10000).toUTCString(), 4000), 6000);
  assert.strictEqual(parseRetryAfter(undefined), null);
  assert.strictEqual(parseRetryAfter('soon'), null);
});

test('a poll request that hits a 429 waits out Retry-After and succeeds', quiet(async () => {
  const s = await startServer({ limited: 1, retryAfter: '1' });
  try {
    installRateGate(s.client);
    const res = await s.client.get('/sessions/x/flights', { ifPriority: POLL });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(s.hits.length, 2, 'one 429, one retry — nothing in between');
    const gap = s.hits[1].at - s.hits[0].at;
    assert.ok(gap >= 900 && gap < 3000, `retry should follow Retry-After (1s), waited ${gap}ms`);
  } finally { await s.close(); }
}));

test('during a cooldown on-demand requests are refused without being sent', quiet(async () => {
  const s = await startServer({ limited: 1, retryAfter: '2' });
  try {
    installRateGate(s.client);
    await assert.rejects(s.client.get('/user/grade'), (e) => e.response.status === 429 && !e.isRateGate);
    const started = Date.now();
    await assert.rejects(s.client.get('/user/logbook'), (e) => e.response.status === 429 && e.isRateGate);
    assert.ok(Date.now() - started < 200, 'refused at once, not after retries');
    assert.strictEqual(s.hits.length, 1, 'only the first request reached the API');
  } finally { await s.close(); }
}));

test('on-demand 429s are not retried', quiet(async () => {
  const s = await startServer({ limited: 5, retryAfter: '0' });
  try {
    installRateGate(s.client);
    await assert.rejects(s.client.get('/flights/abc/route'));
    assert.strictEqual(s.hits.length, 1, 'retrying is what kept the limit tripped');
  } finally { await s.close(); }
}));

test('a poll that is still limited gives up after two retries', quiet(async () => {
  const s = await startServer({ limited: 10, retryAfter: '0' });
  // Zero Retry-After falls back to the default cooldown; shrink time instead of waiting it.
  let t = 0;
  const gate = createRateGate({ now: () => t, sleep: async (ms) => { t += ms; } });
  try {
    installRateGate(s.client, gate);
    await assert.rejects(s.client.get('/sessions', { ifPriority: POLL }), (e) => e.response.status === 429);
    assert.strictEqual(s.hits.length, 3);
  } finally { await s.close(); }
}));

test('a cooldown is capped, whatever Retry-After says', () => {
  let t = 0;
  const gate = createRateGate({ now: () => t });
  gate.noteRateLimited(3600 * 1000);
  assert.strictEqual(gate.remainingMs(), 60000);
});

test('the optional on-demand budget refuses past its rate and refills', async () => {
  let t = 0;
  const gate = createRateGate({ now: () => t, onDemandPerMin: 2 });
  await gate.acquire({});
  await gate.acquire({});
  await assert.rejects(gate.acquire({}), (e) => e.isRateGate);
  await gate.acquire({ ifPriority: POLL }); // the poll is never budgeted
  t += 30000;
  await gate.acquire({});
});

/* =========================
 * Runner
 * ========================= */
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n    ${e.message}`);
    }
  }
  console.log(failed === 0 ? `\n${tests.length} passing` : `\n${failed} of ${tests.length} failing`);
  process.exit(failed === 0 ? 0 : 1);
})();
