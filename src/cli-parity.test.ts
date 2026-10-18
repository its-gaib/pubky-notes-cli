import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, StorageLock } from '@synonymdev/pubky'
import type { withSession } from './auth.js'
import { run } from './cli.js'
import { CliError } from './errors.js'

const OWNER = 'xnd6zy7oqmnb5dropo1eo4qqdkm57ogzyzhizd49xzm691f1q9ny'
const hasCode = (code: string) => (error: unknown) => error instanceof CliError && error.code === code

function notebook() {
  const files = new Map<string, unknown>()
  const locks = new Map<string, StorageLock>()
  const session = {
    info: { publicKey: { z32: () => OWNER } },
    storage: {
      lock: async (path: string) => {
        assert.equal(locks.has(path), false)
        const lock = { path, free() {} } as StorageLock
        locks.set(path, lock)
        return lock
      },
      unlock: async (lock: StorageLock) => { locks.delete(lock.path) },
      refreshLock: async (lock: StorageLock) => { assert.equal(locks.get(lock.path), lock) },
      putTextLocked: async (lock: StorageLock, body: string) => {
        assert.equal(locks.get(lock.path), lock)
        files.set(lock.path, JSON.parse(body))
      },
      deleteLocked: async (lock: StorageLock) => {
        assert.equal(locks.get(lock.path), lock)
        if (!files.delete(lock.path)) throw { data: { statusCode: 404 } }
      },
      get: async (path: string) => {
        if (!files.has(path)) throw { data: { statusCode: 404 } }
        return new Response(JSON.stringify(files.get(path)))
      },
      list: async (root: string, cursor: string | null, _reverse: boolean, limit: number) => {
        const paths = [...files.keys()].filter(path => path.startsWith(root)).sort().map(path => `pubky://${OWNER}${path}`)
        const start = cursor ? paths.indexOf(cursor) + 1 : 0
        return paths.slice(start, start + limit)
      },
    },
  } as unknown as Session
  const sessionRunner: typeof withSession = async action => action(session)
  async function text(args: string[]) {
    const original = process.stdout.write
    let output = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    }) as typeof process.stdout.write
    try { await run(args, sessionRunner); return output }
    finally { process.stdout.write = original }
  }
  async function json(args: string[]): Promise<any> { return JSON.parse(await text(args)) }
  return { text, json, files, locks }
}

test('CLI folder commands create, rename and move whole nested trees with revision guards', async () => {
  const cli = notebook()
  await cli.json(['mkdir', 'Work/Ideas'])
  const note = await cli.json(['create', '--title', 'Nested note', '--folder', 'Work/Ideas'])
  assert.equal(note.note.folder, 'Work/Ideas')
  const stale = await cli.json(['folders'])
  await cli.json(['mkdir', 'Other'])
  await assert.rejects(cli.text(['rename-folder', 'Work', 'Projects', '--if-revision', stale.revision]), hasCode('REVISION_CONFLICT'))
  let folders = await cli.json(['folders'])
  assert.ok(folders.folders.includes('Work/Ideas'))
  const renamed = await cli.json(['rename-folder', 'Work', 'Projects', '--if-revision', folders.revision])
  assert.equal(renamed.movedNotes, 1)
  assert.ok(renamed.folders.includes('Projects/Ideas'))
  const moved = await cli.json(['move-folder', 'Projects', '--folder', 'Other', '--if-revision', renamed.revision])
  assert.equal(moved.movedNotes, 1)
  const current = await cli.json(['get', note.note.id])
  assert.equal(current.note.folder, 'Other/Projects/Ideas')
  await assert.rejects(cli.text(['rmdir', 'Other/Projects/Ideas', '--if-revision', moved.revision]), hasCode('FOLDER_NOT_EMPTY'))
  await cli.json(['move', note.note.id, '--folder', '', '--if-revision', current.revision])
  folders = await cli.json(['folders'])
  await assert.rejects(cli.text(['rmdir', 'Other/Projects/Ideas', '--if-revision', moved.revision]), hasCode('REVISION_CONFLICT'))
  const removed = await cli.json(['rmdir', 'Other/Projects/Ideas', '--if-revision', folders.revision])
  assert.equal(removed.folders.includes('Other/Projects/Ideas'), false)
  assert.ok(removed.folders.includes('Other/Projects'))
  assert.equal(cli.locks.size, 0)
})

test('CLI import/export round trip, exclusive file output, and private/public links', async () => {
  const cli = notebook()
  const directory = await mkdtemp(join(tmpdir(), 'pubky-cli-parity-'))
  try {
    const source = join(directory, 'source.md'), destination = join(directory, 'export.md')
    const markdown = '# Imported title\n\nA **Markdown** body.\n'
    await writeFile(source, markdown)
    const raw = await cli.json(['create', '--title', 'Raw', '--file', source])
    assert.equal(raw.note.content, markdown)
    const imported = await cli.json(['import', source, '--folder', 'Imported/Nested'])
    assert.equal(imported.note.title, 'Imported title')
    assert.equal(imported.note.content, 'A **Markdown** body.\n')
    assert.equal(imported.note.folder, 'Imported/Nested')
    assert.equal('crdt' in imported.note, false)
    assert.equal(await cli.text(['export', imported.note.id]), markdown)
    assert.equal(await cli.text(['get', imported.note.id, '--markdown']), markdown)
    const saved = await cli.json(['export', imported.note.id, '--output', destination])
    assert.equal(saved.file, destination)
    assert.equal(await readFile(destination, 'utf8'), markdown)
    await assert.rejects(cli.text(['export', raw.note.id, '--output', destination]), hasCode('OUTPUT_EXISTS'))
    assert.equal(await readFile(destination, 'utf8'), markdown)
    const privateLink = await cli.json(['link', imported.note.id])
    assert.equal(privateLink.visibility, 'private')
    assert.equal(privateLink.url, `https://pubky-notes.vercel.app/pubky${OWNER}/priv/notes/${imported.note.id}.json`)
    await assert.rejects(cli.text(['link', imported.note.id, '--visibility', 'public']), hasCode('NOT_PUBLISHED'))
    await cli.json(['publish', imported.note.id, '--if-revision', imported.revision])
    const publicLink = await cli.json(['link', imported.note.id, '--visibility', 'public'])
    assert.equal(publicLink.url, privateLink.url.replace('/priv/', '/pub/'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('CLI history/version changes and historical restore preserve later versions and reject stale writes', async () => {
  const cli = notebook()
  const directory = await mkdtemp(join(tmpdir(), 'pubky-cli-history-'))
  try {
    const source = join(directory, 'body.md')
    await writeFile(source, 'First private text')
    const first = await cli.json(['create', '--title', 'First title', '--file', source])
    await writeFile(source, 'First text')
    const second = await cli.json(['update', first.note.id, '--title', 'Second title', '--file', source, '--if-revision', first.revision])
    const history = await cli.json(['history', first.note.id])
    assert.equal(history.versions.length, 2)
    assert.equal(history.revision, second.revision)
    const initial = history.versions[0].id, latest = history.versions[1].id
    const version = await cli.json(['version', first.note.id, initial])
    assert.equal(version.title, 'First title')
    assert.equal(version.content, 'First private text')
    assert.equal('changes' in version, false)
    assert.equal('crdt' in version, false)
    assert.equal(await cli.text(['version', first.note.id, initial, '--markdown']), '# First title\n\nFirst private text')
    const changes = await cli.json(['version', first.note.id, latest, '--changes'])
    assert.equal(changes.changes.baseline, false)
    assert.equal(changes.changes.edits[0].author.id, `pubky:${OWNER}`)
    assert.ok(changes.changes.edits[0].changes.some((change: { deleted: string }) => change.deleted.includes('private')))
    await assert.rejects(cli.text(['restore-version', first.note.id, initial, '--if-revision', first.revision]), hasCode('REVISION_CONFLICT'))
    const restored = await cli.json(['restore-version', first.note.id, initial, '--if-revision', second.revision])
    assert.equal(restored.note.title, 'First title')
    assert.equal(restored.note.content, 'First private text')
    const after = await cli.json(['history', first.note.id])
    assert.equal(after.versions.length, 3)
    assert.equal(after.versions[2].restoredFrom, initial)
    assert.equal((await cli.json(['version', first.note.id, latest])).title, 'Second title')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('CLI rejects malformed parity command arguments before opening a saved session', async () => {
  let sessions = 0
  const noSession: typeof withSession = async () => { sessions++; throw new Error('Unexpected authentication') }
  for (const [args, code] of [
    [['mkdir', '/'], 'INVALID_FOLDER'],
    [['rename-folder', 'A', 'B'], 'INVALID_REVISION'],
    [['move-folder', 'A', '--if-revision', '0'.repeat(64)], 'USAGE'],
    [['rmdir', 'A', '--if-revision', 'bad'], 'INVALID_REVISION'],
    [['history', '../bad'], 'INVALID_ID'],
    [['version', 'note', 'bad'], 'INVALID_VERSION'],
    [['version', 'note', 'initial', '--changes', '--markdown'], 'USAGE'],
    [['restore-version', 'note', 'initial'], 'INVALID_REVISION'],
    [['import'], 'USAGE'],
    [['import', 'file.md', '--stdin'], 'USAGE'],
    [['export', 'note', '--output', ''], 'USAGE'],
    [['link', 'note', '--visibility', 'all'], 'USAGE'],
    [['read-public', 'https://example.com/arbitrary'], 'INVALID_LINK'],
  ] as Array<[string[], string]>) {
    await assert.rejects(run(args, noSession), hasCode(code), args.join(' '))
  }
  assert.equal(sessions, 0)
})
