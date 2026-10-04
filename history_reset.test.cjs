/**
 * history_reset.test.cjs — a corrupt flight-history database recovers itself.
 *
 * Run with: npm test   (or: node history_reset.test.cjs)
 *
 * history.cjs decides whether to reset its file once, at require time, so each
 * case boots it in a child process against its own scratch DATA_DIR.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const dirs = [];

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-reset-test-'));
  dirs.push(dir);
  return dir;
}

// Boots history.cjs, records `record` flights (if any) and prints how many
// flights the table holds.
function boot(dir, record = 0) {
  const script = `
    const h = require(${JSON.stringify(path.join(__dirname, 'history.cjs'))});
    for (let i = 0; i < ${record}; i++) {
      h.updateBatch([{
        userId: 'u', flightId: 'F' + i, callsign: 'T' + i,
        position: { lat: 51 + i / 1000, lon: -0.4, alt_ft: 3000, gs_kt: 200, heading_deg: 90, lastReportMs: Date.now() },
        aircraft: { aircraftId: 'a', liveryId: 'l' }
      }]);
    }
    console.log('COUNT=' + h._db.prepare('SELECT COUNT(*) AS n FROM flight_history').get().n);
    process.exit(0); // history.cjs keeps maintenance timers alive
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, DATA_DIR: dir, HISTORY_MAX_DB_MB: '0' },
    encoding: 'utf8'
  });
  const m = /COUNT=(\d+)/.exec(r.stdout);
  return { status: r.status, count: m ? Number(m[1]) : null, stderr: r.stderr };
}

const dbFile = (dir) => path.join(dir, 'flight_history.db');

test('the one-time reset wipes an existing database once, and never again', () => {
  const dir = scratch();
  // A database left by the previous build, with no reset marker beside it.
  const legacy = new Database(dbFile(dir));
  legacy.prepare('CREATE TABLE leftover (x)').run();
  legacy.close();

  const first = boot(dir, 2);
  assert.strictEqual(first.status, 0, first.stderr);
  assert.match(first.stderr, /one-time reset/);
  assert.strictEqual(first.count, 2);
  const probe = new Database(dbFile(dir), { readonly: true });
  assert.strictEqual(probe.prepare("SELECT 1 FROM sqlite_master WHERE name = 'leftover'").get(), undefined);
  probe.close();

  const second = boot(dir);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /Resetting/);
  assert.strictEqual(second.count, 2, 'second boot must keep what the first recorded');
});

test('a fresh volume is not "reset" — there is nothing to delete', () => {
  const dir = scratch();
  const r = boot(dir, 1);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Resetting/);
  assert.strictEqual(r.count, 1);
});

test('a file that is not a database at all is replaced at startup', () => {
  const dir = scratch();
  boot(dir); // writes the one-time marker
  fs.writeFileSync(dbFile(dir), Buffer.alloc(8192, 0x5a));

  const r = boot(dir, 1);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /unreadable at startup/);
  assert.strictEqual(r.count, 1);
});

test('corruption hit by a write requests a reset, exits, and the next boot is clean', () => {
  const dir = scratch();
  assert.strictEqual(boot(dir, 400).count, 400);

  // Fold the WAL in, then trash everything past the schema page, so opening
  // and reading the schema still work and only the write path trips over it.
  const raw = new Database(dbFile(dir));
  raw.pragma('wal_checkpoint(TRUNCATE)');
  const pageSize = raw.pragma('page_size', { simple: true });
  raw.close();
  const fd = fs.openSync(dbFile(dir), 'r+');
  const size = fs.fstatSync(fd).size;
  fs.writeSync(fd, Buffer.alloc(size - pageSize, 0xff), 0, size - pageSize, pageSize);
  fs.closeSync(fd);

  const crashed = boot(dir, 1);
  assert.strictEqual(crashed.status, 1, `expected exit 1, got ${crashed.status}\n${crashed.stderr}`);
  assert.match(crashed.stderr, /requesting a reset/);
  assert.ok(fs.existsSync(dbFile(dir) + '.reset-requested'));

  const recovered = boot(dir, 1);
  assert.strictEqual(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stderr, /Resetting flight history \(requested/);
  assert.strictEqual(recovered.count, 1);
  assert.ok(!fs.existsSync(dbFile(dir) + '.reset-requested'));
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

  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(failed === 0 ? 0 : 1);
})();
