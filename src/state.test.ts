import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, chmod, writeFile, symlink, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { SessionState, type StoredSession } from './state.js'

const saved: StoredSession = { version: 1, secret: 'sensitive-local-grant', owner: 'owner', grantId: 'grant', grantExpiresAt: '2030-01-01T00:00:00.000Z' }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pubky-state-test-'))
  return { root, state: new SessionState(join(root, 'state')), cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('atomic session writes use owner-only directory and files, with no leftover secrets', async () => {
  const { state, cleanup } = await fixture()
  try {
    await state.withLock(async () => {
      assert.equal(await state.read(), null)
      await state.write(saved)
      assert.deepEqual(await state.read(), saved)
      await state.write({ ...saved, secret: 'replacement' })
    })
    assert.equal((await stat(state.directory)).mode & 0o777, 0o700)
    for (const name of await readdir(state.directory)) assert.equal((await stat(join(state.directory, name))).mode & 0o777, 0o600)
    assert.deepEqual((await readdir(state.directory)).sort(), ['session.json', 'session.lock'])
    assert.equal(JSON.parse(await readFile(join(state.directory, 'session.json'), 'utf8')).secret, 'replacement')
  } finally { await cleanup() }
})

test('credential symlinks and permissive credential files are rejected without touching targets', async () => {
  const { root, state, cleanup } = await fixture()
  try {
    await state.withLock(async () => {
      const target = join(root, 'outside')
      await writeFile(target, 'keep-me', { mode: 0o600 })
      await symlink(target, join(state.directory, 'session.json'))
      await assert.rejects(state.read(), { code: 'UNSAFE_STATE' })
      await assert.rejects(state.write(saved), { code: 'UNSAFE_STATE' })
      assert.equal(await readFile(target, 'utf8'), 'keep-me')
      await rm(join(state.directory, 'session.json'))
      await state.write(saved)
      await chmod(join(state.directory, 'session.json'), 0o644)
      await assert.rejects(state.read(), { code: 'UNSAFE_STATE' })
    })
  } finally { await cleanup() }
})

test('symbolic links in state directory paths are rejected', async () => {
  const { root, state, cleanup } = await fixture()
  try {
    await state.withLock(async () => undefined)
    const alias = join(root, 'alias')
    await symlink(state.directory, alias)
    await assert.rejects(new SessionState(alias).withLock(async () => undefined), { code: 'UNSAFE_STATE' })
  } finally { await cleanup() }
})

test('canceled atomic save preserves previous session and cleans temporary credentials', async () => {
  const { state, cleanup } = await fixture()
  try {
    await state.withLock(async () => {
      await state.write(saved)
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(state.write({ ...saved, secret: 'canceled' }, controller.signal), { code: 'LOGIN_CANCELLED' })
      assert.deepEqual(await state.read(), saved)
      assert.deepEqual((await readdir(state.directory)).sort(), ['session.json', 'session.lock'])
    })
  } finally { await cleanup() }
})

test('kernel locks serialize commands and release immediately after a crashed owner', { timeout: 10000 }, async () => {
  const { state, cleanup } = await fixture()
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { SessionState } from ${JSON.stringify(new URL('./state.js', import.meta.url).href)};
    await new SessionState(process.argv[1]).withLock(async () => {
      process.send('locked');
      await new Promise(() => { setInterval(() => undefined, 1000); });
    });
  `, state.directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  try {
    await once(child, 'message')
    let entered = false
    const next = state.withLock(async () => { entered = true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(entered, false)
    child.kill('SIGKILL')
    await once(child, 'exit')
    await next
    assert.equal(entered, true)
  } finally { child.kill('SIGKILL'); await cleanup() }
})

test('lock waiting supports cancellation without taking over another process lock', async () => {
  const { state, cleanup } = await fixture()
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const holding = state.withLock(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
  await ready
  try {
    const controller = new AbortController()
    const waiting = state.withLock(async () => assert.fail('must not acquire'), controller.signal)
    controller.abort()
    await assert.rejects(waiting, { code: 'LOGIN_CANCELLED' })
  } finally { release(); await holding; await cleanup() }
})
