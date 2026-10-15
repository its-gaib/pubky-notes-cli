import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const secret = 'fixture-only-persistent-grant-secret'
const owner = 'y'.repeat(52)
const expires = 4102444800
const summary = { authenticated: true, owner, grantExpiresAt: new Date(expires * 1000).toISOString() }

// Every invocation loads fresh modules and restores from disk; no in-memory
// AuthManager or SDK state can survive between these simulated CLI commands.
const childScript = `
import assert from 'node:assert/strict';
import { AuthManager } from ${JSON.stringify(new URL('./auth.js', import.meta.url).href)};
import { SessionState } from ${JSON.stringify(new URL('./state.js', import.meta.url).href)};
const [phase, directory] = process.argv.slice(1);
const secret = ${JSON.stringify(secret)};
const owner = ${JSON.stringify(owner)};
const expected = ${JSON.stringify(summary)};
const events = [];
const session = {
  free() { events.push('free'); },
  async signout() { assert.fail('ordinary commands must never revoke the grant'); },
  async exportLocalSecret() { events.push('export'); return secret; },
  get grant() { return {
    free() {},
    async grantId() { return 'fixture-grant'; },
    async sessionInfo() { return {
      capabilities: ['/priv/notes/:rw', '/pub/notes/:rw'],
      clientId: 'pubky-notes-cli', grantId: 'fixture-grant',
      grantExpiresAt: ${expires},
      publicKey: { z32() { return owner; }, free() {} }, free() {},
    }; },
  }; },
};
const client = {
  async startGrantAuthFlow(capabilities, _kind, options) {
    assert.equal(phase, 'approve', 'restoring a saved session must never start a new login');
    assert.equal(capabilities, '/priv/notes/:rw,/pub/notes/:rw');
    assert.deepEqual(options, { clientId: 'pubky-notes-cli' });
    events.push('approval');
    return {
      authorizationUrl: 'pubkyauth://fixture-only',
      async awaitApproval() { return session; }, free() {},
    };
  },
  async restoreSession(savedSecret) {
    assert.notEqual(phase, 'approve');
    assert.equal(savedSecret, secret, 'restore must receive the exact persisted grant');
    events.push('restore');
    if (phase === 'outage') throw Object.assign(new Error('fixture outage'), { name: 'RequestError' });
    return session;
  },
};
const state = new SessionState(directory);
const auth = new AuthManager(state, () => client);
const onQr = async (url) => {
  assert.equal(phase, 'approve', 'saved sessions must not request another QR scan');
  assert.equal(url, 'pubkyauth://fixture-only'); events.push('qr');
};
if (phase === 'approve') {
  assert.deepEqual(await auth.login({ onQr }), expected);
  assert.equal((await state.read()).secret, secret);
  assert.deepEqual(events, ['approval', 'qr', 'export', 'free']);
} else if (phase === 'outage') {
  const before = await state.read();
  await assert.rejects(auth.login({ onQr }), { name: 'RequestError' });
  assert.deepEqual(await state.read(), before);
  assert.deepEqual(events, ['restore']);
} else {
  assert.equal(phase, 'reuse');
  assert.equal(await auth.withSession(async (restored) => {
    assert.equal(restored, session); events.push('operation'); return 'operation completed';
  }), 'operation completed');
  assert.deepEqual(await auth.login({ onQr }), expected);
  assert.deepEqual(await auth.status(), expected);
  assert.deepEqual(events, ['restore', 'operation', 'free', 'restore', 'free', 'restore', 'free']);
}
console.log(JSON.stringify({ phase, events, ...(phase === 'outage' ? {} : { status: expected }) }));
`

async function runCommand(directory: string, phase: 'approve' | 'reuse' | 'outage') {
  const result = await execute(process.execPath, ['--input-type=module', '-e', childScript, phase, directory], {
    timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  })
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.includes(secret), false, 'command output must not expose the saved secret')
  return JSON.parse(result.stdout) as { phase: string; events: string[]; status?: typeof summary }
}

async function withState(work: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pubky-session-process-test-'))
  try { await work(join(root, 'state')) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test('a fresh process reuses a QR-approved durable grant for operations, login, and status', { timeout: 15000 }, async () => {
  await withState(async (directory) => {
    await runCommand(directory, 'approve')
    const file = join(directory, 'session.json')
    const saved = await readFile(file, 'utf8')
    assert.equal(JSON.parse(saved).secret, secret)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.deepEqual((await runCommand(directory, 'reuse')).status, summary)
    assert.equal(await readFile(file, 'utf8'), saved, 'ordinary commands retain the durable grant')
  })
})

test('a temporary restore failure preserves the grant for the next process without another QR scan', { timeout: 20000 }, async () => {
  await withState(async (directory) => {
    await runCommand(directory, 'approve')
    const file = join(directory, 'session.json')
    const saved = await readFile(file, 'utf8')
    await runCommand(directory, 'outage')
    assert.equal(await readFile(file, 'utf8'), saved)
    assert.deepEqual((await runCommand(directory, 'reuse')).status, summary)
    assert.equal(await readFile(file, 'utf8'), saved)
  })
})
