import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pubky, Session } from '@synonymdev/pubky'
import { AuthManager } from './auth.js'
import { SessionState, type StoredSession } from './state.js'
import { CliError } from './errors.js'

const owner = 'y'.repeat(52)
const expires = Math.floor(Date.now() / 1000) + 86400 * 30
const stored: StoredSession = { version: 1, secret: 'old-secret', owner, grantId: 'old-grant', grantExpiresAt: new Date(expires * 1000).toISOString() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function session(grantId = 'old-grant', overrides: { capabilities?: string[]; signoutError?: Error; clientId?: string } = {}) {
  let revoked = 0
  let freed = 0
  const value = {
    free() { freed++ },
    async signout() { if (overrides.signoutError) throw overrides.signoutError; revoked++ },
    async exportLocalSecret() { return `${grantId}-secret` },
    get grant() { return {
      free() {},
      async sessionInfo() { return {
        capabilities: overrides.capabilities ?? ['/priv/notes/:rw', '/pub/notes/:rw'],
        clientId: overrides.clientId ?? 'pubky-notes-cli', grantExpiresAt: expires, grantId,
        publicKey: { z32() { return owner }, free() {} }, free() {},
      } },
    } },
  } as unknown as Session
  return { value, revoked: () => revoked, freed: () => freed }
}
async function fixture(client: object, initial: StoredSession | null = stored) {
  const root = await mkdtemp(join(tmpdir(), 'pubky-auth-test-'))
  const state = new SessionState(join(root, 'state'))
  if (initial) await state.withLock(() => state.write(initial))
  const auth = new AuthManager(state, () => client as Pubky)
  return { state, auth, cleanup: () => rm(root, { recursive: true, force: true }) }
}
function flow(approval: Promise<Session>) {
  return { authorizationUrl: 'pubkyauth://sensitive-link', async awaitApproval() { return approval }, free() {} }
}

test('login reuses durable grant without displaying another QR and status omits secrets', async () => {
  const active = session()
  const { auth, cleanup } = await fixture({ async restoreSession(secret: string) { assert.equal(secret, stored.secret); return active.value } })
  try {
    const result = await auth.login({ onQr: async () => assert.fail('unnecessary QR') })
    assert.deepEqual(result, { authenticated: true, owner, grantExpiresAt: stored.grantExpiresAt })
    assert.equal(active.revoked(), 0)
    assert.equal(active.freed(), 1)
  } finally { await cleanup() }
})

test('fresh login requests only Notes scopes and persists the approved durable grant', async () => {
  const candidate = session('new-grant')
  const { auth, state, cleanup } = await fixture({ async startGrantAuthFlow(caps: string, _kind: unknown, options: object) {
    assert.equal(caps, '/priv/notes/:rw,/pub/notes/:rw')
    assert.deepEqual(options, { clientId: 'pubky-notes-cli' })
    return flow(Promise.resolve(candidate.value))
  } }, null)
  try {
    let qr = false
    await auth.login({ onQr: async (url) => { assert.equal(url, 'pubkyauth://sensitive-link'); qr = true } })
    assert.equal(qr, true)
    assert.equal((await state.read())?.secret, 'new-grant-secret')
    assert.equal(candidate.revoked(), 0)
  } finally { await cleanup() }
})

test('temporary restore failures retain the durable secret and never trigger QR automatically', async () => {
  const outage = Object.assign(new Error('network outage'), { name: 'RequestError' })
  const { auth, state, cleanup } = await fixture({ async restoreSession() { throw outage } })
  try {
    await assert.rejects(auth.login({ onQr: async () => assert.fail('must not prompt for transient failure') }), (error) => error === outage)
    assert.deepEqual(await state.read(), stored)
  } finally { await cleanup() }
})

test('broader or insufficient grants are rejected and revoked without replacing previous credentials', async () => {
  for (const capabilities of [['/:rw'], ['/priv/notes/:r', '/pub/notes/:rw']]) {
    const candidate = session('bad-grant', { capabilities })
    const { auth, state, cleanup } = await fixture({ async startGrantAuthFlow() { return flow(Promise.resolve(candidate.value)) } })
    try {
      await assert.rejects(auth.login({ force: true, onQr: async () => undefined }), { code: 'PERMISSION_REQUIRED' })
      assert.deepEqual(await state.read(), stored)
      assert.equal(candidate.revoked(), 1)
    } finally { await cleanup() }
  }
})

test('a QR-render failure revokes approval that arrived while rendering and preserves old session', async () => {
  const candidate = session('candidate')
  const approval = deferred<Session>()
  const { auth, state, cleanup } = await fixture({ async startGrantAuthFlow() { return flow(approval.promise) } })
  try {
    await assert.rejects(auth.login({ force: true, onQr: async () => {
      approval.resolve(candidate.value)
      await new Promise((resolve) => setImmediate(resolve))
      throw new Error('renderer failed')
    } }), /renderer failed/)
    assert.equal(candidate.revoked(), 1)
    assert.deepEqual(await state.read(), stored)
  } finally { await cleanup() }
})

test('cancellation returns promptly and revokes late approval without replacing old credentials', async () => {
  const approval = deferred<Session>()
  const candidate = session('late-grant')
  const controller = new AbortController()
  const { auth, state, cleanup } = await fixture({ async startGrantAuthFlow() { return flow(approval.promise) } })
  try {
    await assert.rejects(auth.login({ force: true, signal: controller.signal, onQr: async () => { controller.abort() } }), { code: 'LOGIN_CANCELLED' })
    approval.resolve(candidate.value)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(candidate.revoked(), 1)
    assert.deepEqual(await state.read(), stored)
  } finally { await cleanup() }
})

test('force login does not revoke a candidate sharing the previous grant identifier', async () => {
  const candidate = session('old-grant')
  const { auth, state, cleanup } = await fixture({
    async restoreSession() { assert.fail('must not restore replaced copy of same grant') },
    async startGrantAuthFlow() { return flow(Promise.resolve(candidate.value)) },
  })
  try {
    await auth.login({ force: true, onQr: async () => undefined })
    assert.equal((await state.read())?.secret, 'old-grant-secret')
    assert.equal(candidate.revoked(), 0)
  } finally { await cleanup() }
})

test('force login can replace malformed private state without discarding it before approval', async () => {
  const candidate = session('new-grant')
  const { auth, state, cleanup } = await fixture({ async startGrantAuthFlow() { return flow(Promise.resolve(candidate.value)) } })
  try {
    await writeFile(join(state.directory, 'session.json'), 'broken json', { mode: 0o600 })
    await auth.login({ force: true, onQr: async () => undefined })
    assert.equal((await state.read())?.grantId, 'new-grant')
  } finally { await cleanup() }
})

test('a durability error after credential commit never revokes the persisted candidate', async () => {
  const candidate = session('new-grant')
  const { auth, state, cleanup } = await fixture({ async startGrantAuthFlow() { return flow(Promise.resolve(candidate.value)) } })
  const originalWrite = state.write.bind(state)
  state.write = async (...args) => { await originalWrite(...args); throw new CliError('SESSION_SAVE_UNCERTAIN', 'Injected directory sync failure') }
  try {
    await assert.rejects(auth.login({ force: true, onQr: async () => undefined }), { code: 'SESSION_SAVE_UNCERTAIN' })
    assert.equal((await state.read())?.grantId, 'new-grant')
    assert.equal(candidate.revoked(), 0)
  } finally { await cleanup() }
})

test('full operations stay serialized after session restore until work finishes', async () => {
  const active = session()
  const restoreCalls: number[] = []
  const work = deferred<void>()
  const entered = deferred<void>()
  const { auth, state, cleanup } = await fixture({ async restoreSession() { restoreCalls.push(Date.now()); return active.value } })
  try {
    const first = auth.withSession(async () => { entered.resolve(); await work.promise })
    await entered.promise
    const second = new AuthManager(state, () => ({ async restoreSession() { restoreCalls.push(Date.now()); return active.value } }) as unknown as Pubky).status()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(restoreCalls.length, 1)
    work.resolve()
    await Promise.all([first, second])
    assert.equal(restoreCalls.length, 2)
  } finally { work.resolve(); await cleanup() }
})

test('logout preserves credentials when server revocation fails and removes them on success', async () => {
  const broken = session('old-grant', { signoutError: new Error('offline') })
  const active = session()
  let current = broken
  const { auth, state, cleanup } = await fixture({ async restoreSession() { return current.value } })
  try {
    await assert.rejects(auth.logout(), /offline/)
    assert.deepEqual(await state.read(), stored)
    current = active
    await auth.logout()
    assert.equal(active.revoked(), 1)
    assert.equal(await state.read(), null)
  } finally { await cleanup() }
})
