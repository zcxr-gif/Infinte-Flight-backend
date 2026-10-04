/* =========================
 * Infinite Flight API rate gate
 * =========================
 *
 * One API key serves everything this process asks Infinite Flight for: the
 * flight poll that records every trail, and every on-demand lookup a user's
 * click triggers (plans, routes, ATIS, grades, logbooks...). The poll is a
 * steady ~13 requests a minute; the lookups are whatever traffic brings.
 *
 * Before this, a burst of lookups tripping a 429 cost the poll far more than
 * the lookups: every caller retried four times on its own backoff (each retry
 * another request against the same limit, keeping it tripped), the poll's own
 * retries ran ~30 s, and then it paused a flat 60 s — about a minute and a half
 * of no positions recorded for anyone, because somebody opened a few logbooks.
 *
 * Now a 429 starts one shared cooldown, for as long as Infinite Flight's
 * Retry-After asks. During it:
 *
 *   - nothing is sent. Poll requests wait for the cooldown to end and go first;
 *     on-demand requests fail at once with a 429 of their own, so a user gets
 *     an answer immediately rather than after half a minute of retries, and no
 *     request is spent finding out the limit is still in force.
 *   - only the poll retries a 429. On-demand callers already have caches and
 *     error paths; retrying them is what amplified one 429 into many.
 *
 * Optionally, IF_API_ONDEMAND_PER_MIN caps on-demand requests per minute so the
 * limit is not reached at all. Leave headroom for the poll's share (~13/min
 * with all three servers polled every 15 s). 0, the default, means no cap —
 * the cooldown alone still keeps a 429 from stalling the poll.
 */

'use strict';

const POLL = 'poll';

const intEnv = (name, dflt) => {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : dflt;
};

// A 429 without Retry-After still has to stop traffic for a moment.
const DEFAULT_COOLDOWN_MS = 5000;
// A broken or hostile header must not silence the API for an hour.
const MAX_COOLDOWN_MS = 60000;

/** Retry-After as milliseconds: delta-seconds or an HTTP date. Null if absent or unreadable. */
function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function rateLimitedError(config, retryMs, reason) {
  const err = new Error(`Infinite Flight API rate limited (${reason}); retry in ${Math.ceil(retryMs / 1000)}s`);
  err.isRateGate = true;
  err.config = config;
  // Shaped like an axios 429 so existing `e.response.status` handling applies.
  err.response = { status: 429, headers: { 'retry-after': String(Math.ceil(retryMs / 1000)) }, data: null };
  return err;
}

function createRateGate({
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onDemandPerMin = intEnv('IF_API_ONDEMAND_PER_MIN', 0),
} = {}) {
  let blockedUntil = 0;
  let tokens = onDemandPerMin;
  let refilledAt = now();

  const remainingMs = () => Math.max(0, blockedUntil - now());

  /**
   * Records a 429. Returns true when this started a cooldown (rather than
   * landing inside one already running), so the caller logs once per episode.
   */
  function noteRateLimited(retryAfterMs) {
    const ms = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, MAX_COOLDOWN_MS)
      : DEFAULT_COOLDOWN_MS;
    const wasBlocked = remainingMs() > 0;
    blockedUntil = Math.max(blockedUntil, now() + ms);
    return !wasBlocked;
  }

  function takeToken() {
    if (!onDemandPerMin) return true;
    const t = now();
    tokens = Math.min(onDemandPerMin, tokens + ((t - refilledAt) * onDemandPerMin) / 60000);
    refilledAt = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  /** Resolves when `config` may be sent; rejects an on-demand request that may not. */
  async function acquire(config) {
    if (config && config.ifPriority === POLL) {
      // Loop: another 429 can extend the cooldown while this one waits.
      for (let wait = remainingMs(); wait > 0; wait = remainingMs()) await sleep(wait);
      return;
    }
    const wait = remainingMs();
    if (wait > 0) throw rateLimitedError(config, wait, 'cooling down');
    if (!takeToken()) throw rateLimitedError(config, 60000 / onDemandPerMin, 'on-demand budget spent');
  }

  return { acquire, noteRateLimited, remainingMs };
}

const POLL_MAX_429_RETRIES = 2;

/**
 * Puts `client` (an axios instance) behind a gate and returns the gate.
 *
 * Install after any timing interceptor: axios runs request interceptors
 * last-in, first-out, so this runs first and time spent waiting out a cooldown
 * is not counted as API latency.
 */
function installRateGate(client, gate = createRateGate()) {
  client.interceptors.request.use(async (config) => {
    await gate.acquire(config);
    return config;
  });
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config;
      // A refusal from the gate itself is already the answer; it was never sent.
      if (error?.response?.status === 429 && !error.isRateGate) {
        const retryAfterMs = parseRetryAfter(error.response.headers?.['retry-after']);
        if (gate.noteRateLimited(retryAfterMs)) {
          console.warn(`[if-api] ⏳ 429 Too Many Requests — holding all API calls for ${Math.ceil(gate.remainingMs() / 1000)}s; the flight poll goes first after.`);
        }
        // Only the poll retries: its next attempt waits in the gate for the
        // cooldown, so it costs no extra request while the limit is in force.
        if (config && config.ifPriority === POLL) {
          config._retryCount = (config._retryCount || 0) + 1;
          if (config._retryCount <= POLL_MAX_429_RETRIES) return client(config);
          console.error(`[if-api] 🛑 Flight poll still rate limited after ${POLL_MAX_429_RETRIES} retries.`);
        }
      }
      return Promise.reject(error);
    }
  );
  return gate;
}

module.exports = { createRateGate, installRateGate, parseRetryAfter, POLL, DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS };
