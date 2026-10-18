import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import type { Session, StorageLock } from '@synonymdev/pubky'
import { CliError } from './errors.js'
import { checkpointNote, editNote, listNoteVersions, materializeSharedNote, newPersonalDocument, readNoteVersion } from './crdt.js'
import {
  createNote, deleteNote, getNote, getNoteHistory, getNoteVersion, listNotes, moveNoteFolder,
  publishNote, restoreNoteVersion, updateNote,
} from './notes.js'

const OWNER = 'xnd6zy7oqmnb5dropo1eo4qqdkm57ogzyzhizd49xzm691f1q9ny'
const privatePath = (id: string) => `/priv/notes/${id}.json`
const publicPath = (id: string) => `/pub/notes/${id}.json`
const hasCode = (code: string) => (error: unknown) => error instanceof CliError && error.code === code

function makeSession() {
  const files = new Map<string, unknown>()
  const held = new Map<string, StorageLock>()
  const writes: string[] = []
  const session = {
    info: { publicKey: { z32: () => OWNER } },
    storage: {
      lock: async (path: string) => {
        assert.equal(held.has(path), false)
        const lock = { path, free() {} } as StorageLock
        held.set(path, lock)
        return lock
      },
      unlock: async (lock: StorageLock) => { held.delete(lock.path) },
      refreshLock: async (lock: StorageLock) => { assert.equal(held.get(lock.path), lock) },
      putTextLocked: async (lock: StorageLock, body: string) => {
        assert.equal(held.get(lock.path), lock)
        files.set(lock.path, JSON.parse(body))
        writes.push(lock.path)
      },
      deleteLocked: async (lock: StorageLock) => {
        assert.equal(held.get(lock.path), lock)
        if (!files.delete(lock.path)) throw { data: { statusCode: 404 } }
      },
      get: async (path: string) => {
        if (!files.has(path)) throw { data: { statusCode: 404 } }
        return new Response(JSON.stringify(files.get(path)))
      },
      list: async (root: string, cursor: string | null, _reverse: boolean, limit: number) => {
        const entries = [...files.keys()].filter(path => path.startsWith(root)).sort().map(path => `pubky://${OWNER}${path}`)
        const start = cursor ? entries.indexOf(cursor) + 1 : 0
        return entries.slice(start, start + limit)
      },
    },
  } as unknown as Session
  return { session, files, held, writes }
}

test('history reads immutable version projections and optional attribution without exposing CRDT state', async () => {
  const { session, writes } = makeSession()
  const first = await createNote(session, { title: 'Before', content: 'Original private words' })
  const next = await updateNote(session, first.note.id, first.revision, { title: 'After', content: 'Original words' })
  const beforeReads = writes.length
  const history = await getNoteHistory(session, first.note.id)
  assert.equal(history.id, first.note.id)
  assert.equal(history.revision, next.revision)
  assert.equal(history.versions.length, 2)
  const original = await getNoteVersion(session, first.note.id, history.versions[0].id)
  assert.equal(original.title, 'Before')
  assert.equal(original.content, 'Original private words')
  assert.equal('changes' in original, false)
  assert.equal('crdt' in original, false)
  const edited = await getNoteVersion(session, first.note.id, history.versions[1].id, true)
  assert.equal(edited.changes?.edits[0].author?.id, `pubky:${OWNER}`)
  assert.ok(edited.changes?.edits[0].changes.some(change => change.deleted.includes('private')))
  assert.equal(writes.length, beforeReads)
})

test('restoring a version keeps later versions, unsaved checkpoints, folder, lineage, and public snapshot', async () => {
  const { session, files, writes } = makeSession()
  const first = await createNote(session, { title: 'Original', content: 'First text', folder: 'Personal/Nested' })
  const firstVersion = listNoteVersions(first.note)[0].id
  const second = await updateNote(session, first.note.id, first.revision, { title: 'Latest', content: 'Published text' })
  const published = await publishNote(session, first.note.id, second.revision)
  // A browser can persist raw edits before its idle checkpoint is recorded.
  const pending = editNote(published.note, { content: 'Current uncheckpointed text' })
  files.set(privatePath(first.note.id), pending)
  const current = await getNote(session, first.note.id)
  const publicBefore = structuredClone(files.get(publicPath(first.note.id)))
  const restored = await restoreNoteVersion(session, first.note.id, firstVersion, current.revision)
  assert.equal(restored.note.title, 'Original')
  assert.equal(restored.note.content, 'First text')
  assert.equal(restored.note.folder, 'Personal/Nested')
  assert.equal(restored.note.crdt?.lineage, first.note.crdt?.lineage)
  assert.deepEqual(restored.published, published.published)
  assert.deepEqual(files.get(publicPath(first.note.id)), publicBefore)
  const versions = listNoteVersions(restored.note)
  assert.equal(versions.length, 4)
  assert.equal(versions.at(-1)?.restoredFrom, firstVersion)
  assert.equal(readNoteVersion(restored.note, versions[1].id).content, 'Published text')
  assert.equal(readNoteVersion(restored.note, versions[2].id).content, 'Current uncheckpointed text')
  assert.equal(writes.at(-1), privatePath(first.note.id))
  const beforeNoop = writes.length
  assert.deepEqual(await restoreNoteVersion(session, first.note.id, firstVersion, restored.revision), restored)
  assert.equal(writes.length, beforeNoop)
})

test('version operations reject stale, invalid, absent, deleted, and missing notes without writes', async () => {
  const { session, held, writes } = makeSession()
  const first = await createNote(session, { content: 'First' })
  const version = listNoteVersions(first.note)[0].id
  const next = await updateNote(session, first.note.id, first.revision, { content: 'Next' })
  const before = writes.length
  await assert.rejects(restoreNoteVersion(session, first.note.id, version, first.revision), hasCode('REVISION_CONFLICT'))
  await assert.rejects(restoreNoteVersion(session, first.note.id, '../invalid', next.revision), hasCode('INVALID_VERSION'))
  const absent = '00000000-0000-0000-0000-000000000000'
  await assert.rejects(restoreNoteVersion(session, first.note.id, absent, next.revision), hasCode('VERSION_NOT_FOUND'))
  await assert.rejects(getNoteVersion(session, first.note.id, absent), hasCode('VERSION_NOT_FOUND'))
  await assert.rejects(getNoteVersion(session, first.note.id, 'bad'), hasCode('INVALID_VERSION'))
  await assert.rejects(getNoteHistory(session, 'missing'), hasCode('NOTE_NOT_FOUND'))
  await assert.rejects(restoreNoteVersion(session, 'missing', version, '0'.repeat(64)), hasCode('REVISION_CONFLICT'))
  assert.equal(writes.length, before)
  assert.equal(held.size, 0)
  await deleteNote(session, first.note.id, next.revision)
  const deleted = await getNote(session, first.note.id)
  const afterDelete = writes.length
  assert.equal((await getNoteHistory(session, first.note.id)).versions.length, 2)
  await assert.rejects(restoreNoteVersion(session, first.note.id, version, deleted.revision), hasCode('NOTE_DELETED'))
  assert.equal(writes.length, afterDelete)
  assert.equal(held.size, 0)
})

test('shared restores retain version two and private timeline; folder moves include Trash without text versions', async () => {
  const { session, files, writes } = makeSession()
  const doc = new Y.Doc({ gc: false }), personal = newPersonalDocument('Start')
  let shared
  try {
    doc.clientID = 0
    doc.getText('title').insert(0, 'Shared')
    doc.getText('content').insert(0, 'Original shared text')
    shared = checkpointNote(materializeSharedNote(doc, personal, {
      id: 'shared', title: '', content: '', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
    }, `shared:${crypto.randomUUID()}`))
  } finally { doc.destroy(); personal.destroy() }
  files.set(privatePath('shared'), shared)
  const original = await getNote(session, 'shared')
  const version = listNoteVersions(original.note)[0].id
  const edited = await updateNote(session, 'shared', original.revision, { content: 'Changed shared text' })
  const published = await publishNote(session, 'shared', edited.revision)
  const restored = await restoreNoteVersion(session, 'shared', version, published.revision)
  assert.equal(restored.note.crdt?.version, 2)
  assert.equal(restored.note.crdt?.lineage, shared.crdt?.lineage)
  assert.equal(listNoteVersions(restored.note).length, 3)
  const peer = new Y.Doc({ gc: false })
  try {
    Y.applyUpdate(peer, Buffer.from(restored.note.crdt!.update, 'base64'))
    assert.deepEqual([...peer.share.keys()].sort(), ['content', 'edits', 'title'])
  } finally { peer.destroy() }
  await deleteNote(session, 'shared', restored.revision)
  const deleted = await getNote(session, 'shared')
  const moved = await moveNoteFolder(session, 'shared', deleted.revision, ' / Archive / Shared / ')
  assert.equal(moved.note.deleted, true)
  assert.equal(moved.note.folder, 'Archive/Shared')
  assert.equal(moved.note.crdt?.update, deleted.note.crdt?.update)
  assert.deepEqual(listNoteVersions(moved.note), listNoteVersions(deleted.note))
  assert.equal(moved.published, null)
  assert.deepEqual((await listNotes(session, { all: true })).map(view => view.note.id), ['shared'])
  assert.deepEqual(await listNotes(session), [])
  assert.equal((await listNotes(session, { trash: true })).length, 1)
  const before = writes.length
  await assert.rejects(moveNoteFolder(session, 'shared', deleted.revision, 'Elsewhere'), hasCode('REVISION_CONFLICT'))
  await assert.rejects(moveNoteFolder(session, 'shared', moved.revision, '../bad'), hasCode('INVALID_FOLDER'))
  assert.equal(writes.length, before)
})
