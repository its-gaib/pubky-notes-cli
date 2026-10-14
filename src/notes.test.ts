import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Session, StorageLock } from '@synonymdev/pubky'
import { CliError } from './errors.js'
import {
  createNote, deleteNote, folderContains, getNote, listNotes, MAX_CONTENT_LENGTH, MAX_NOTE_BYTES,
  normalizeFolder, publishNote, SAMPLE_MARKDOWN, unpublishNote, updateNote,
} from './notes.js'
import type { Note } from './notes.js'

const OWNER = 'xnd6zy7oqmnb5dropo1eo4qqdkm57ogzyzhizd49xzm691f1q9ny'
const privatePath = (id = 'note-1') => `/priv/notes/${id}.json`
const publicPath = (id = 'note-1') => `/pub/notes/${id}.json`
const fixture = (id = 'note-1', content = 'Private draft'): Note => ({
  id, title: 'A note', content,
  createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z',
})
const httpError = (statusCode: number) => ({ data: { statusCode } })
const hasCode = (code: string) => (error: unknown) => error instanceof CliError && error.code === code

function makeSession(initial: Array<[string, unknown]> = []) {
  const files = new Map<string, unknown>(initial)
  const events: string[] = []
  const held = new Map<string, StorageLock>()
  const storage = {
    lock: async (path: string, _seconds: number): Promise<StorageLock> => {
      events.push(`lock ${path}`)
      if (held.has(path)) throw httpError(423)
      const lock = { path, timeoutSeconds: 60, free: () => events.push(`free ${path}`) } as unknown as StorageLock
      held.set(path, lock)
      return lock
    },
    unlock: async (lock: StorageLock): Promise<void> => {
      events.push(`unlock ${lock.path}`)
      held.delete(lock.path)
    },
    refreshLock: async (lock: StorageLock, _seconds: number): Promise<void> => {
      events.push(`renew ${lock.path}`)
      if (held.get(lock.path) !== lock) throw httpError(412)
    },
    putTextLocked: async (lock: StorageLock, body: string): Promise<void> => {
      events.push(`put ${lock.path}`)
      assert.equal(held.get(lock.path), lock)
      files.set(lock.path, JSON.parse(body))
    },
    deleteLocked: async (lock: StorageLock): Promise<void> => {
      events.push(`delete ${lock.path}`)
      assert.equal(held.get(lock.path), lock)
      if (!files.delete(lock.path)) throw httpError(404)
    },
    get: async (path: string): Promise<Response> => {
      events.push(`get ${path}`)
      if (!files.has(path)) throw httpError(404)
      return new Response(JSON.stringify(files.get(path)))
    },
    list: async (folder: string, cursor: string | null, _reverse: boolean, limit: number, shallow: boolean): Promise<string[]> => {
      events.push(`list ${folder}`)
      assert.equal(shallow, true)
      const entries = [...files.keys()].filter((path) => path.startsWith(folder)).sort().map((path) => `pubky://${OWNER}${path}`)
      const start = cursor ? entries.indexOf(cursor) + 1 : 0
      return entries.slice(start, start + limit)
    },
  }
  const session = { storage, info: { publicKey: { z32: () => OWNER } } } as unknown as Session
  return { session, storage, files, events, held }
}

test('creates privately with the web sample and normalized private folder metadata', async () => {
  const { session, files, events, held } = makeSession()
  const created = await createNote(session, { folder: ' / Work / Project / ' })
  assert.equal(created.note.title, 'Untitled note')
  assert.equal(created.note.content, SAMPLE_MARKDOWN)
  assert.equal(created.note.folder, 'Work/Project')
  assert.equal(created.published, null)
  assert.match(created.revision, /^[a-f0-9]{64}$/)
  assert.deepEqual([...files.keys()], [privatePath(created.note.id)])
  assert.deepEqual(events.filter((event) => event.startsWith('lock ')), [
    `lock ${privatePath(created.note.id)}`, `lock ${publicPath(created.note.id)}`,
  ])
  assert.equal(held.size, 0)
  assert.equal(events.filter((event) => event.startsWith('free ')).length, 2)
  assert.deepEqual(await getNote(session, created.note.id), created)
})

test('explicitly empty Markdown and title stay empty', async () => {
  const { session } = makeSession()
  const created = await createNote(session, { title: '', content: '' })
  assert.equal(created.note.title, '')
  assert.equal(created.note.content, '')
})

test('create checks collisions under both locks without overwriting', async () => {
  const { session, storage, events } = makeSession()
  storage.get = async (path) => new Response(JSON.stringify(fixture(path.split('/').at(-1)!.slice(0, -5))))
  await assert.rejects(createNote(session), hasCode('NOTE_COLLISION'))
  assert.equal(events.some((event) => event.startsWith('put ')), false)
})

test('private edits preserve the public snapshot and omitted patch fields', async () => {
  const original = { ...fixture(), folder: 'Work/Project' }
  const snapshot = fixture('note-1', 'Published copy')
  const { session, files } = makeSession([[privatePath(), original], [publicPath(), snapshot]])
  const before = await getNote(session, 'note-1')
  const updated = await updateNote(session, 'note-1', before.revision, { title: undefined, content: 'New private draft' })
  assert.equal(updated.note.title, original.title)
  assert.equal(updated.note.folder, 'Work/Project')
  assert.equal(updated.note.content, 'New private draft')
  assert.deepEqual(files.get(publicPath()), snapshot)
  assert.notEqual(updated.revision, before.revision)
  assert.ok(updated.note.updatedAt > original.updatedAt)
  assert.deepEqual(await getNote(session, 'note-1'), updated)
  const moved = await updateNote(session, 'note-1', updated.revision, { folder: '' })
  assert.equal(moved.note.folder, undefined)
  assert.equal(moved.note.content, updated.note.content)
})

test('revisions include independent public changes and private absence', async () => {
  const { session, files } = makeSession([[privatePath(), fixture()]])
  const privateOnly = await getNote(session, 'note-1')
  files.set(publicPath(), fixture('note-1', 'Public copy'))
  const withPublic = await getNote(session, 'note-1')
  assert.notEqual(privateOnly.revision, withPublic.revision)
  await assert.rejects(updateNote(session, 'note-1', privateOnly.revision, { content: 'Stale edit' }), hasCode('REVISION_CONFLICT'))
  files.delete(privatePath())
  const orphan = await getNote(session, 'note-1')
  files.set(privatePath(), fixture('note-1', 'Public copy'))
  assert.notEqual(orphan.revision, (await getNote(session, 'note-1')).revision)
})

test('semantically identical property ordering has the same revision', async () => {
  const original = fixture()
  const { session, files } = makeSession([[privatePath(), original]])
  const before = await getNote(session, 'note-1')
  files.set(privatePath(), { content: original.content, updatedAt: original.updatedAt, id: original.id, title: original.title, createdAt: original.createdAt })
  assert.equal((await getNote(session, 'note-1')).revision, before.revision)
})

test('stale or missing revisions never mutate files, and locks are released', async () => {
  const { session, files, events, held } = makeSession([[privatePath(), fixture()]])
  const before = await getNote(session, 'note-1')
  files.set(privatePath(), fixture('note-1', 'Other device edit'))
  await assert.rejects(deleteNote(session, 'note-1', before.revision), hasCode('REVISION_CONFLICT'))
  await assert.rejects(publishNote(session, 'note-1', ''), hasCode('INVALID_REVISION'))
  await assert.rejects(unpublishNote(session, 'note-1', 'bad'), hasCode('INVALID_REVISION'))
  assert.equal(events.some((event) => /^(put|delete) /.test(event)), false)
  assert.equal(held.size, 0)
  files.delete(privatePath())
  await assert.rejects(updateNote(session, 'note-1', before.revision, { content: 'Resurrect' }), hasCode('REVISION_CONFLICT'))
})

test('mutations reread after locking and detect changes made since the caller read', async () => {
  const { session, files, storage, events } = makeSession([[privatePath(), fixture()]])
  const before = await getNote(session, 'note-1')
  const lock = storage.lock
  storage.lock = async (path, seconds) => {
    files.set(publicPath(), fixture('note-1', 'Just published elsewhere'))
    return lock(path, seconds)
  }
  await assert.rejects(publishNote(session, 'note-1', before.revision), hasCode('REVISION_CONFLICT'))
  assert.equal(events.some((event) => event.startsWith('put ')), false)
})

test('unsupported locks and expired locks fail closed', async () => {
  const { session, storage, events, held } = makeSession([[privatePath(), fixture()]])
  const before = await getNote(session, 'note-1')
  const lock = storage.lock
  storage.lock = async () => { throw httpError(405) }
  await assert.rejects(updateNote(session, 'note-1', before.revision, { content: 'New' }), hasCode('LOCKS_UNSUPPORTED'))
  storage.lock = lock
  let renews = 0
  storage.refreshLock = async () => { if (++renews === 3) throw httpError(412) }
  await assert.rejects(updateNote(session, 'note-1', before.revision, { content: 'New' }), hasCode('REVISION_CONFLICT'))
  assert.equal(events.some((event) => event.startsWith('put ')), false)
  assert.equal(held.size, 0)
})

test('second lock acquisition failure releases the first lock', async () => {
  const { session, storage, held, events } = makeSession()
  const lock = storage.lock
  storage.lock = async (path, seconds) => {
    if (path.startsWith('/pub/')) throw httpError(423)
    return lock(path, seconds)
  }
  await assert.rejects(createNote(session), hasCode('REVISION_CONFLICT'))
  assert.equal(held.size, 0)
  assert.equal(events.filter((event) => event.startsWith('free ')).length, 1)
})

test('publishing writes private first and strips private folder metadata', async () => {
  const { session, files, events } = makeSession([[privatePath(), { ...fixture(), folder: 'Secret/Plans' }]])
  const before = await getNote(session, 'note-1')
  const published = await publishNote(session, 'note-1', before.revision)
  assert.equal(published.note.folder, 'Secret/Plans')
  assert.equal(published.published!.folder, undefined)
  assert.equal((files.get(publicPath()) as Note).folder, undefined)
  assert.deepEqual(events.filter((event) => event.startsWith('put ')), [`put ${privatePath()}`, `put ${publicPath()}`])
  assert.deepEqual(await getNote(session, 'note-1'), published)
})

test('private-save failure prevents publishing; public-save failure preserves the original', async () => {
  const { session, files, storage } = makeSession([[privatePath(), fixture()]])
  const before = await getNote(session, 'note-1')
  const put = storage.putTextLocked
  storage.putTextLocked = async () => { throw httpError(500) }
  await assert.rejects(publishNote(session, 'note-1', before.revision))
  assert.equal(files.has(publicPath()), false)
  storage.putTextLocked = async (lock, body) => {
    if (lock.path.startsWith('/pub/')) throw httpError(500)
    await put(lock, body)
  }
  await assert.rejects(publishNote(session, 'note-1', before.revision))
  assert.deepEqual(files.get(privatePath()), fixture())
  assert.equal(files.has(publicPath()), false)
})

test('unpublishing an orphan first preserves a private original', async () => {
  const { session, files, events } = makeSession([[publicPath(), { ...fixture(), folder: 'Unexpected public folder' }]])
  const before = await getNote(session, 'note-1')
  assert.equal(before.note.folder, undefined)
  assert.equal(before.published!.folder, undefined)
  const after = await unpublishNote(session, 'note-1', before.revision)
  assert.equal(after.published, null)
  assert.deepEqual(files.get(privatePath()), fixture())
  assert.equal(files.has(publicPath()), false)
  assert.deepEqual(events.filter((event) => /^(put|delete) /.test(event)), [`put ${privatePath()}`, `delete ${publicPath()}`])
  assert.deepEqual(await getNote(session, 'note-1'), after)
})

test('orphan private-save failure preserves its public file', async () => {
  const { session, files, storage, events } = makeSession([[publicPath(), fixture()]])
  const before = await getNote(session, 'note-1')
  storage.putTextLocked = async () => { throw httpError(403) }
  await assert.rejects(unpublishNote(session, 'note-1', before.revision))
  assert.deepEqual(files.get(publicPath()), fixture())
  assert.equal(events.some((event) => event.startsWith('delete ')), false)
})

test('deletion removes public first and keeps private when public removal fails', async () => {
  const { session, files, storage, events } = makeSession([[privatePath(), fixture()], [publicPath(), fixture()]])
  const before = await getNote(session, 'note-1')
  const remove = storage.deleteLocked
  storage.deleteLocked = async () => { throw httpError(403) }
  await assert.rejects(deleteNote(session, 'note-1', before.revision))
  assert.equal(files.size, 2)
  storage.deleteLocked = remove
  await deleteNote(session, 'note-1', before.revision)
  assert.equal(files.size, 0)
  assert.deepEqual(events.filter((event) => event.startsWith('delete ')), [`delete ${publicPath()}`, `delete ${privatePath()}`])
})

test('private deletion failure reports failure after safe public removal', async () => {
  const { session, files, storage } = makeSession([[privatePath(), fixture()], [publicPath(), fixture()]])
  const before = await getNote(session, 'note-1')
  const remove = storage.deleteLocked
  storage.deleteLocked = async (lock) => {
    if (lock.path.startsWith('/priv/')) throw httpError(500)
    return remove(lock)
  }
  await assert.rejects(deleteNote(session, 'note-1', before.revision))
  assert.equal(files.has(privatePath()), true)
  assert.equal(files.has(publicPath()), false)
})

test('missing-only reads never hide authorization or server failures', async () => {
  const { session, storage } = makeSession()
  await assert.rejects(getNote(session, 'missing'), hasCode('NOTE_NOT_FOUND'))
  storage.get = async () => { throw httpError(403) }
  await assert.rejects(getNote(session, 'note-1'), (error) => (error as {data:{statusCode:number}}).data.statusCode === 403)
})

test('validates IDs, size, timestamps, matching embedded IDs and private folders', async () => {
  const { session, files, events } = makeSession()
  for (const id of ['../other', 'bad/path', 'a'.repeat(81), '']) await assert.rejects(getNote(session, id), hasCode('INVALID_ID'))
  assert.equal(events.length, 0)
  await assert.rejects(createNote(session, { title: 'x'.repeat(201) }), hasCode('INVALID_NOTE'))
  await assert.rejects(createNote(session, { content: 'x'.repeat(MAX_CONTENT_LENGTH + 1) }), hasCode('INVALID_NOTE'))
  await assert.rejects(createNote(session, { content: '漢'.repeat(200_000) }), hasCode('LIMIT_EXCEEDED'))
  for (const invalid of [{ ...fixture(), id: 'other' }, { ...fixture(), updatedAt: 'yesterday' }, { ...fixture(), folder: 2 }]) {
    files.set(privatePath(), invalid)
    await assert.rejects(getNote(session, 'note-1'), (error) => error instanceof CliError)
  }
})

test('bounded response reading enforces actual bytes even without content-length', async () => {
  const { session, storage } = makeSession()
  storage.get = async () => new Response('x'.repeat(MAX_NOTE_BYTES + 1))
  await assert.rejects(getNote(session, 'note-1'), hasCode('LIMIT_EXCEEDED'))
  storage.get = async () => new Response('{}', { headers: { 'content-length': String(MAX_NOTE_BYTES + 1) } })
  await assert.rejects(getNote(session, 'note-1'), hasCode('LIMIT_EXCEEDED'))
  storage.get = async () => new Response(new Uint8Array([0xff]))
  await assert.rejects(getNote(session, 'note-1'))
  storage.get = async () => new Response('not json')
  await assert.rejects(getNote(session, 'note-1'), hasCode('INVALID_NOTE'))
})

test('folder validation matches the web app and uses segment boundaries', () => {
  assert.equal(normalizeFolder(' / Work / Project / '), 'Work/Project')
  assert.equal(normalizeFolder('///'), '')
  assert.equal(folderContains('Work', 'Work/Project'), true)
  assert.equal(folderContains('Work', 'Workshop'), false)
  assert.equal(folderContains('', 'Work'), false)
  for (const input of ['a//b', 'a/../b', './a', 'a\\b', 'a\nb', 'x'.repeat(81), Array(9).fill('a').join('/')]) {
    assert.throws(() => normalizeFolder(input), hasCode('INVALID_FOLDER'))
  }
})

test('listing paginates and includes orphaned public notes, with private drafts preferred', async () => {
  const entries: Array<[string, unknown]> = Array.from({ length: 101 }, (_, index) => {
    const id = `note-${String(index).padStart(3, '0')}`
    return [privatePath(id), fixture(id)]
  })
  entries.push([publicPath('note-000'), fixture('note-000', 'Public snapshot')], [publicPath('orphan'), fixture('orphan')])
  const { session, events } = makeSession(entries)
  const notes = await listNotes(session)
  assert.equal(notes.length, 102)
  assert.equal(notes.find(({ note }) => note.id === 'note-000')!.note.content, 'Private draft')
  assert.equal(notes.find(({ note }) => note.id === 'note-000')!.published!.content, 'Public snapshot')
  assert.ok(notes.find(({ note }) => note.id === 'orphan')!.published)
  assert.equal(events.filter((event) => event === 'list /priv/notes/').length, 2)
  assert.equal(events.some((event) => event.includes('notes.pubky.app')), false)
})

test('listing skips non-note and nested files, rejects unrelated paths and unsafe IDs', async () => {
  const { session, storage, events } = makeSession([
    [privatePath(), fixture()], ['/priv/notes/readme.md', {}], ['/priv/notes/folder/child.json', {}],
  ])
  assert.equal((await listNotes(session)).length, 1)
  assert.equal(events.some((event) => event === 'get /priv/notes/folder/child.json'), false)
  storage.list = async () => [`pubky://${OWNER}/priv/other/note.json`]
  await assert.rejects(listNotes(session), hasCode('INVALID_LIST'))
  storage.list = async (folder) => [`pubky://${OWNER}${folder}bad%20id.json`]
  await assert.rejects(listNotes(session))
})

test('listing rejects another account and repeated pages', async () => {
  const { session, storage } = makeSession()
  const otherOwner = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'
  storage.list = async (folder) => [`pubky://${otherOwner}${folder}note-1.json`]
  await assert.rejects(listNotes(session))
  storage.list = async (folder) => Array.from({ length: 100 }, (_, index) => `pubky://${OWNER}${folder}note-${index}.json`)
  await assert.rejects(listNotes(session), hasCode('INVALID_LIST'))
})

test('listing bounds total entries and does not hide non-missing directory errors', async () => {
  const { session, storage } = makeSession()
  let page = 0
  storage.list = async (folder) => Array.from({ length: 100 }, (_, index) => `pubky://${OWNER}${folder}note-${page++}-${index}.json`)
  await assert.rejects(listNotes(session), hasCode('LIMIT_EXCEEDED'))
  storage.list = async () => { throw httpError(403) }
  await assert.rejects(listNotes(session))
  storage.list = async () => { throw httpError(404) }
  assert.deepEqual(await listNotes(session), [])
})
