import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Session, StorageLock } from '@synonymdev/pubky'
import { CliError } from './errors.js'
import { createFolder, deleteFolder, FOLDERS_PATH, listFolders, MAX_FOLDER_STORE_BYTES, renameFolder } from './folder-store.js'
import { getNote } from './notes.js'
import type { Note } from './notes.js'

const OWNER = 'xnd6zy7oqmnb5dropo1eo4qqdkm57ogzyzhizd49xzm691f1q9ny'
const notePath = (id: string) => `/priv/notes/${id}.json`
const fixture = (id: string, folder: string, deleted = false): Note => ({
  id, title: id, content: 'Original Markdown', folder, ...(deleted ? { deleted: true } : {}),
  createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z',
})
const httpError = (statusCode: number) => ({ data: { statusCode } })
const hasCode = (code: string) => (error: unknown) => error instanceof CliError && error.code === code

function makeSession(initial: Array<[string, unknown]> = []) {
  const files = new Map(initial)
  const events: string[] = []
  const held = new Map<string, StorageLock>()
  const storage = {
    lock: async (path: string, _seconds: number): Promise<StorageLock> => {
      events.push(`lock ${path}`)
      if (held.has(path)) throw httpError(423)
      const lock = { path, free: () => events.push(`free ${path}`) } as unknown as StorageLock
      held.set(path, lock)
      return lock
    },
    unlock: async (lock: StorageLock): Promise<void> => { held.delete(lock.path) },
    refreshLock: async (lock: StorageLock, _seconds: number): Promise<void> => {
      if (held.get(lock.path) !== lock) throw httpError(412)
    },
    putTextLocked: async (lock: StorageLock, text: string): Promise<void> => {
      assert.equal(held.get(lock.path), lock)
      events.push(`put ${lock.path}`)
      files.set(lock.path, JSON.parse(text))
    },
    get: async (path: string): Promise<Response> => {
      if (!files.has(path)) throw httpError(404)
      return new Response(JSON.stringify(files.get(path)))
    },
    list: async (folder: string, cursor: string | null, _reverse: boolean, limit: number): Promise<string[]> => {
      const paths = [...files.keys()].filter(path => path.startsWith(folder)).sort().map(path => `pubky://${OWNER}${path}`)
      return paths.slice(cursor ? paths.indexOf(cursor) + 1 : 0, (cursor ? paths.indexOf(cursor) + 1 : 0) + limit)
    },
  }
  const session = { storage, info: { publicKey: { z32: () => OWNER } } } as unknown as Session
  return { session, files, storage, held, events }
}

test('lists explicit empty folders and inferred live parents, excluding Trash-only directories', async () => {
  const { session } = makeSession([
    [FOLDERS_PATH, { version: 1, folders: ['Empty/Nested'] }],
    [notePath('live'), fixture('live', 'Work/Ideas')],
    [notePath('trash'), fixture('trash', 'Hidden', true)],
  ])
  const view = await listFolders(session)
  assert.deepEqual(view.folders, ['Empty', 'Empty/Nested', 'Work', 'Work/Ideas'])
  assert.deepEqual(view.explicitFolders, ['Empty/Nested'])
  assert.match(view.revision, /^[a-f0-9]{64}$/)
})

test('creates empty nested folders in the shared web registry and keeps inferred folders', async () => {
  const { session, files, events, held } = makeSession([[notePath('live'), fixture('live', 'Work/Ideas')]])
  const created = await createFolder(session, ' / Empty / Nested / ')
  assert.deepEqual(created.folders, ['Empty', 'Empty/Nested', 'Work', 'Work/Ideas'])
  assert.deepEqual(files.get(FOLDERS_PATH), { version: 1, folders: created.folders })
  assert.deepEqual(await listFolders(session), created)
  assert.deepEqual(events.filter(event => event.startsWith('lock ')), [`lock ${FOLDERS_PATH}`])
  assert.equal(held.size, 0)
  await assert.rejects(createFolder(session, 'Empty'), hasCode('FOLDER_EXISTS'))
  await assert.rejects(createFolder(session, '/'), hasCode('INVALID_FOLDER'))
})

test('renames whole trees with empty children, trashed notes and private history while preserving public files', async () => {
  const published = { ...fixture('live', ''), folder: undefined }
  const { session, files, held } = makeSession([
    [FOLDERS_PATH, { version: 1, folders: ['Work/Empty', 'Workshop'] }],
    [notePath('live'), fixture('live', 'Work/Ideas')],
    [notePath('trash'), fixture('trash', 'Work/Archive', true)],
    ['/pub/notes/live.json', published],
  ])
  const before = await listFolders(session)
  const moved = await renameFolder(session, 'Work', 'Projects', before.revision)
  assert.equal(moved.movedNotes, 2)
  assert.deepEqual(moved.folders, ['Projects', 'Projects/Empty', 'Projects/Ideas', 'Workshop'])
  assert.equal((await getNote(session, 'live')).note.folder, 'Projects/Ideas')
  const trash = (await getNote(session, 'trash')).note
  assert.equal(trash.folder, 'Projects/Archive')
  assert.equal(trash.deleted, true)
  assert.equal(trash.content, 'Original Markdown')
  assert.ok(trash.crdt)
  assert.deepEqual(files.get('/pub/notes/live.json'), published)
  const { movedNotes: _, ...view } = moved
  assert.deepEqual(await listFolders(session), view)
  assert.equal(held.size, 0)
})

test('moves into an existing parent and preserves the previous empty parent', async () => {
  const { session } = makeSession([[FOLDERS_PATH, { version: 1, folders: ['A/Child/Empty', 'B'] }]])
  const result = await renameFolder(session, 'A/Child', 'B/Child', (await listFolders(session)).revision)
  assert.deepEqual(result.folders, ['A', 'B', 'B/Child', 'B/Child/Empty'])
})

test('rejects stale metadata and note revisions before any writes', async () => {
  const { session, files, events } = makeSession([
    [FOLDERS_PATH, { version: 1, folders: ['Empty', 'Work'] }],
    [notePath('trash'), fixture('trash', 'Work', true)],
  ])
  let before = await listFolders(session)
  files.set(FOLDERS_PATH, { version: 1, folders: ['Empty', 'Other', 'Work'] })
  await assert.rejects(deleteFolder(session, 'Empty', before.revision), hasCode('REVISION_CONFLICT'))
  before = await listFolders(session)
  files.set(notePath('trash'), { ...fixture('trash', 'Work', true), content: 'Concurrent edit' })
  await assert.rejects(renameFolder(session, 'Work', 'Projects', before.revision), hasCode('REVISION_CONFLICT'))
  assert.equal(events.some(event => event.startsWith('put ')), false)
  await assert.rejects(deleteFolder(session, 'Empty', ''), hasCode('INVALID_REVISION'))
})

test('validates collisions, missing destinations and every descendant depth before staging', async () => {
  const { session, events } = makeSession([[FOLDERS_PATH, { version: 1, folders: ['A/B/C/D/E/F/G/H', 'Other'] }]])
  const revision = (await listFolders(session)).revision
  await assert.rejects(renameFolder(session, 'A', 'A/Child', revision), hasCode('INVALID_FOLDER_MOVE'))
  await assert.rejects(renameFolder(session, 'A', 'Other', revision), hasCode('FOLDER_EXISTS'))
  await assert.rejects(renameFolder(session, 'A', 'Missing/New', revision), hasCode('FOLDER_NOT_FOUND'))
  await assert.rejects(renameFolder(session, 'A', 'Other/New', revision), hasCode('INVALID_FOLDER'))
  assert.equal(events.some(event => event.startsWith('put ')), false)
})

test('deletion requires no live notes or children and allows Trash placement like the web app', async () => {
  const { session, files } = makeSession([
    [FOLDERS_PATH, { version: 1, folders: ['Work/Empty', 'TrashOnly'] }],
    [notePath('live'), fixture('live', 'Work')],
    [notePath('trash'), fixture('trash', 'TrashOnly', true)],
  ])
  await assert.rejects(deleteFolder(session, 'Work', (await listFolders(session)).revision), hasCode('FOLDER_NOT_EMPTY'))
  await deleteFolder(session, 'Work/Empty', (await listFolders(session)).revision)
  await deleteFolder(session, 'TrashOnly', (await listFolders(session)).revision)
  assert.deepEqual((await listFolders(session)).folders, ['Work'])
  assert.equal((files.get(notePath('trash')) as Note).folder, 'TrashOnly')
  await assert.rejects(deleteFolder(session, 'Missing', (await listFolders(session)).revision), hasCode('FOLDER_NOT_FOUND'))
})

test('deletion rejects empty directories that still contain a visible empty child', async () => {
  const { session } = makeSession([[FOLDERS_PATH, { version: 1, folders: ['Parent/Child'] }]])
  await assert.rejects(deleteFolder(session, 'Parent', (await listFolders(session)).revision), hasCode('FOLDER_NOT_EMPTY'))
})

test('partial multi-note failures retain staged folders and completed moves with an honest error', async () => {
  const { session, files, storage, held } = makeSession([
    [notePath('one'), fixture('one', 'Work')], [notePath('two'), fixture('two', 'Work')],
  ])
  const before = await listFolders(session)
  const put = storage.putTextLocked
  let savedNotes = 0
  storage.putTextLocked = async (lock, body) => {
    if (lock.path.endsWith('.json') && ++savedNotes === 2) throw httpError(500)
    await put(lock, body)
  }
  await assert.rejects(renameFolder(session, 'Work', 'Projects', before.revision), error =>
    hasCode('PARTIAL_FOLDER_OPERATION')(error) && (error as Error).message.includes('1 confirmed note moves'))
  assert.deepEqual(files.get(FOLDERS_PATH), { version: 1, folders: ['Projects', 'Work'] })
  assert.equal([...files.values()].filter(value => (value as Note).folder === 'Projects').length, 1)
  assert.equal([...files.values()].filter(value => (value as Note).folder === 'Work').length, 1)
  assert.equal(held.size, 0)
})

test('new notes arriving during a move keep their source folder and interrupt completion', async () => {
  const { session, files, storage } = makeSession([[notePath('one'), fixture('one', 'Work')]])
  const before = await listFolders(session)
  const put = storage.putTextLocked
  storage.putTextLocked = async (lock, body) => {
    await put(lock, body)
    if (lock.path === notePath('one')) files.set(notePath('new'), fixture('new', 'Work/New'))
  }
  await assert.rejects(renameFolder(session, 'Work', 'Projects', before.revision), hasCode('PARTIAL_FOLDER_OPERATION'))
  assert.deepEqual(files.get(FOLDERS_PATH), { version: 1, folders: ['Projects', 'Work'] })
  assert.equal((files.get(notePath('new')) as Note).folder, 'Work/New')
})

test('metadata size and schema checks fail closed without overwriting', async () => {
  const { session, files, storage, events } = makeSession()
  for (const value of [{ version: 2, folders: [] }, { version: 1, folders: [''] }, { version: 1, folders: [123] }, { version: 1, folders: Array(2001).fill('A') }]) {
    files.set(FOLDERS_PATH, value)
    await assert.rejects(createFolder(session, 'New'), error => error instanceof CliError)
  }
  const get = storage.get
  storage.get = async path => path === FOLDERS_PATH ? new Response('x'.repeat(MAX_FOLDER_STORE_BYTES + 1)) : get(path)
  await assert.rejects(listFolders(session), hasCode('LIMIT_EXCEEDED'))
  storage.get = async path => path === FOLDERS_PATH ? new Response('{}', { headers: { 'content-length': String(MAX_FOLDER_STORE_BYTES + 1) } }) : get(path)
  await assert.rejects(listFolders(session), hasCode('LIMIT_EXCEEDED'))
  assert.equal(events.some(event => event.startsWith('put ')), false)
})

test('locks must be supported, readback must confirm writes, and failures release locks', async () => {
  const { session, storage, held } = makeSession()
  const lock = storage.lock
  storage.lock = async () => { throw httpError(405) }
  await assert.rejects(createFolder(session, 'New'), hasCode('LOCKS_UNSUPPORTED'))
  storage.lock = lock
  storage.putTextLocked = async () => undefined
  await assert.rejects(createFolder(session, 'New'), hasCode('WRITE_NOT_CONFIRMED'))
  assert.equal(held.size, 0)
  storage.get = async () => { throw httpError(403) }
  await assert.rejects(listFolders(session), error => (error as { data: { statusCode: number } }).data.statusCode === 403)
})
