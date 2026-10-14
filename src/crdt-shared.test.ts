import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { editNote, materializeSharedNote, mergeNotes, newPersonalDocument, noteRevision, validateCrdtNote } from './crdt.js'

function shared() {
  const doc = new Y.Doc({ gc: false }), personal = newPersonalDocument('Work')
  doc.clientID = 0
  doc.getText('title').insert(0, 'Shared note')
  doc.getText('content').insert(0, 'First\nLast')
  try { return materializeSharedNote(doc, personal, { id: 'shared-test', title: '', content: '', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' }, `shared:${crypto.randomUUID()}`) }
  finally { doc.destroy(); personal.destroy() }
}

test('CLI edits shared version two without mixing personal metadata into peer state', () => {
  const original = shared()
  const moved = editNote(original, { folder: 'Personal/Folder', deleted: true })
  assert.equal(moved.crdt!.update, original.crdt!.update)
  assert.notEqual(noteRevision(moved), noteRevision(original))
  const edited = editNote(moved, { content: 'First edited\nLast' })
  assert.equal(edited.deleted, true)
  assert.equal(edited.folder, 'Personal/Folder')
  assert.equal(edited.crdt!.version, 2)
  assert.deepEqual(validateCrdtNote(edited), edited)
})

test('CLI merges shared content and same-account personal updates from serialized replicas', () => {
  const original = shared()
  const browser = editNote(original, { content: 'First browser\nLast', folder: 'Browser' })
  const terminal = editNote(JSON.parse(JSON.stringify(original)), { content: 'First\nLast CLI', deleted: true })
  const merged = mergeNotes(browser, terminal)
  assert.deepEqual(merged, mergeNotes(terminal, browser))
  assert.equal(merged.content, 'First browser\nLast CLI')
  assert.equal(merged.folder, 'Browser')
  assert.equal(merged.deleted, true)
  assert.throws(() => validateCrdtNote({ ...merged, content: 'Forged' }), /does not match/)
})
