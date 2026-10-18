import { createHash, randomUUID } from 'node:crypto'
import { PubkyResource } from '@synonymdev/pubky'
import type { Path, Session, StorageLock } from '@synonymdev/pubky'
import { CliError } from './errors.js'
import { normalizeFolder } from './folders.js'
export { normalizeFolder, folderContains } from './folders.js'
import { checkpointNote, editNote, ensureCrdt, initializeNote, listNoteVersions, readNoteVersion, readNoteVersionChanges, validateCrdtNote } from './crdt.js'
import type { CrdtNote, NoteVersionInfo } from './crdt.js'

export interface Note extends CrdtNote {}

export interface NoteView {
  note: Note
  published: Note | null
  revision: string
}

export type NotePatch = { title?: string; content?: string; folder?: string }

export const MAX_NOTE_BYTES = 4 * 1024 * 1024
export const MAX_CONTENT_LENGTH = 250_000
export const SAMPLE_MARKDOWN = [
  '## Heading',
  '**Bold**, *italic*, and `code`.',
  '[Link](https://pubky.org)',
  '',
  '- Bullet item',
  '- [ ] Task',
  '1. Numbered item',
  '',
  '> Quote',
].join('\n')

const ROOTS = { private: '/priv/notes/', public: '/pub/notes/' } as const
const MAX_NOTES = 2_000
const PAGE_SIZE = 100
const LOCK_SECONDS = 60
type Space = keyof typeof ROOTS
type Pair = { private: Note | null; public: Note | null }
type Locks = Record<Space, StorageLock>

export async function listNotes(session: Session, options: { trash?: boolean; all?: boolean } = {}): Promise<NoteView[]> {
  const [privateIds, publicIds] = await Promise.all([
    listIds(session, 'private'), listIds(session, 'public'),
  ])
  const ids = [...new Set([...privateIds, ...publicIds])]
  if (ids.length > MAX_NOTES) throw new CliError('LIMIT_EXCEEDED', `This notebook exceeds the ${MAX_NOTES} note limit.`)
  const results: (NoteView | null)[] = new Array(ids.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(5, ids.length) }, async () => {
    while (index < ids.length) {
      const position = index++
      const pair = await readPair(session, ids[position])
      results[position] = pair.private || pair.public ? toView(pair) : null
    }
  }))
  return results.filter((note): note is NoteView => note !== null && (options.all === true || !!note.note.deleted === !!options.trash))
    .sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt) || a.note.id.localeCompare(b.note.id))
}

export async function getNote(session: Session, id: string): Promise<NoteView> {
  return toView(await readPair(session, id))
}

export async function getNoteHistory(session: Session, id: string) {
  const view = await getNote(session, id)
  return { id, revision: view.revision, versions: listNoteVersions(view.note) }
}

export async function getNoteVersion(session: Session, id: string, version: string, changes = false) {
  const view = await getNote(session, id)
  const metadata = requireVersion(view.note, version)
  return {
    id, version: metadata, ...readNoteVersion(view.note, version), revision: view.revision,
    ...(changes ? { changes: readNoteVersionChanges(view.note, version) } : {}),
  }
}

export async function restoreNoteVersion(session: Session, id: string, version: string, revision: string): Promise<NoteView> {
  return mutate(session, id, revision, async (pair, locks) => {
    const original = canonical(pair)
    if (original.deleted) throw new CliError('NOTE_DELETED', 'Restore this note from Trash before restoring a version.')
    requireVersion(original, version)
    const text = readNoteVersion(original, version)
    if (text.title === original.title && text.content === original.content) return toView(pair)
    // Preserve any text not yet checkpointed before applying the selected version.
    const current = checkpointNote(await ensureCrdt(original))
    const editorId = session.info.publicKey.z32()
    const edited = editNote(current, {
      ...text, updatedAt: new Date(Math.max(Date.now(), Date.parse(original.updatedAt) + 1)).toISOString(),
    }, { id: `pubky:${editorId}`, label: `Editor ${editorId.slice(-12)} (CLI)` })
    const restored = validateNote(checkpointNote(edited, { recordedAt: edited.updatedAt, restoredFrom: version }), id)
    await writeVerifiedNote(session, locks, 'private', restored)
    return toView({ private: restored, public: pair.public })
  })
}

function requireVersion(note: Note, version: string): NoteVersionInfo {
  if (typeof version !== 'string' || (version !== 'initial' && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(version))) {
    throw new CliError('INVALID_VERSION', 'Use a version ID returned by history.')
  }
  const metadata = listNoteVersions(note).find(entry => entry.id === version)
  if (!metadata) throw new CliError('VERSION_NOT_FOUND', 'This note version does not exist. Read its history again.')
  return metadata
}

export async function createNote(session: Session, input: NotePatch = {}): Promise<NoteView> {
  const now = new Date().toISOString()
  const note = validateNote(initializeNote(validateNote({
    id: randomUUID(), title: input.title ?? 'Untitled note', content: input.content ?? SAMPLE_MARKDOWN,
    createdAt: now, updatedAt: now, folder: input.folder,
  })))
  return withLocks(session, note.id, async (locks) => {
    const existing = await readPair(session, note.id)
    if (existing.private || existing.public) throw new CliError('NOTE_COLLISION', 'A note already occupies this ID. Retry creating the note.')
    await writeVerifiedNote(session, locks, 'private', note)
    return toView({ private: note, public: null })
  })
}

export async function updateNote(session: Session, id: string, revision: string, patch: NotePatch): Promise<NoteView> {
  return mutate(session, id, revision, async (pair, locks) => {
    const original = canonical(pair)
    if (original.deleted) throw new CliError('NOTE_DELETED', 'Restore this note before editing it.')
    const editorId = session.info.publicKey.z32()
    const edited = editNote(await ensureCrdt(original), {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.folder !== undefined ? { folder: normalizeFolder(patch.folder) } : {}),
      updatedAt: new Date(Math.max(Date.now(), Date.parse(original.updatedAt) + 1)).toISOString(),
    }, { id: `pubky:${editorId}`, label: `Editor ${editorId.slice(-12)} (CLI)` })
    // One terminal command is one saved text version. Personal organization
    // changes preserve the timeline without adding an identical text entry.
    const updated = validateNote(edited.title !== original.title || edited.content !== original.content
      ? checkpointNote(edited, { recordedAt: edited.updatedAt })
      : edited, id)
    await writeVerifiedNote(session, locks, 'private', updated)
    return toView({ private: updated, public: pair.public })
  })
}

export async function moveNoteFolder(session: Session, id: string, revision: string, folder: string): Promise<NoteView> {
  return mutate(session, id, revision, async (pair, locks) => {
    const original = canonical(pair)
    const normalized = normalizeFolder(folder)
    if ((original.folder ?? '') === normalized) return toView(pair)
    const moved = validateNote(editNote(await ensureCrdt(original), {
      folder: normalized, updatedAt: new Date(Math.max(Date.now(), Date.parse(original.updatedAt) + 1)).toISOString(),
    }), id)
    await writeVerifiedNote(session, locks, 'private', moved)
    return toView({ private: moved, public: pair.public })
  })
}

export async function publishNote(session: Session, id: string, revision: string): Promise<NoteView> {
  return mutate(session, id, revision, async (pair, locks) => {
    const original = canonical(pair)
    if (original.deleted) throw new CliError('NOTE_DELETED', 'Restore this note before publishing it.')
    const note = validateNote(await ensureCrdt(original))
    const snapshot = publicSnapshot(note)
    // Persist and verify the private original before exposing a public snapshot.
    await writeVerifiedNote(session, locks, 'private', note)
    await writeVerifiedNote(session, locks, 'public', snapshot)
    return toView({ private: note, public: snapshot })
  })
}

export async function unpublishNote(session: Session, id: string, revision: string): Promise<NoteView> {
  return mutate(session, id, revision, async (pair, locks) => {
    const note = pair.private ?? validateNote(await ensureCrdt(canonical(pair)))
    if (!pair.private) await writeVerifiedNote(session, locks, 'private', note)
    if (pair.public) {
      await renew(session, locks)
      await deleteLockedIfPresent(session, locks.public)
    }
    return toView({ private: note, public: null })
  })
}

export async function deleteNote(session: Session, id: string, revision: string): Promise<void> {
  await mutate(session, id, revision, async (pair, locks) => {
    const note = validateNote(await ensureCrdt(canonical(pair)))
    // Preserve an orphan privately before its only public copy is removed.
    if (!pair.private) await writeVerifiedNote(session, locks, 'private', note)
    if (pair.public) {
      await renew(session, locks)
      await deleteLockedIfPresent(session, locks.public)
    }
    const deleted = validateNote(editNote(note, { deleted: true, updatedAt: new Date(Math.max(Date.now(), Date.parse(note.updatedAt) + 1)).toISOString() }))
    await writeVerifiedNote(session, locks, 'private', deleted)
  })
}

export async function restoreNote(session: Session, id: string, revision: string): Promise<NoteView> {
  return mutate(session, id, revision, async (pair, locks) => {
    const original = canonical(pair)
    if (!original.deleted) throw new CliError('NOTE_NOT_DELETED', 'This note is already active.')
    const restored = validateNote(editNote(await ensureCrdt(original), { deleted: false, updatedAt: new Date(Math.max(Date.now(), Date.parse(original.updatedAt) + 1)).toISOString() }))
    await writeVerifiedNote(session, locks, 'private', restored)
    return toView({ private: restored, public: pair.public })
  })
}

async function writeVerifiedNote(session: Session, locks: Locks, space: Space, note: Note): Promise<void> {
  const validated = validateNote(note)
  await renew(session, locks)
  await session.storage.putTextLocked(locks[space], JSON.stringify(validated))
  const actual = await readOptional(session, notePath(space, note.id), note.id)
  if (!actual || JSON.stringify(actual) !== JSON.stringify(validated)) {
    throw new CliError('WRITE_NOT_CONFIRMED', 'The homeserver did not confirm the saved note. Read it again before retrying.')
  }
}

async function mutate<T>(session: Session, id: string, revision: string, action: (pair: Pair, locks: Locks) => Promise<T>): Promise<T> {
  requireId(id)
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new CliError('INVALID_REVISION', 'Supply the revision returned by the latest note read.')
  }
  return withLocks(session, id, async (locks) => {
    const pair = await readPair(session, id)
    // Missing is a conflict too: an old read must never recreate a deleted note.
    if (revisionOf(pair) !== revision) {
      throw new CliError('REVISION_CONFLICT', 'The note or its public snapshot changed. Read it again before retrying.')
    }
    canonical(pair)
    return action(pair, locks)
  })
}

async function withLocks<T>(session: Session, id: string, action: (locks: Locks) => Promise<T>): Promise<T> {
  requireId(id)
  const acquired: StorageLock[] = []
  const locks = {} as Locks
  try {
    // Every mutation reserves both paths in the same order, including create.
    // This also blocks ordinary web-app writes during the revision check.
    for (const space of ['private', 'public'] as const) {
      const lock = await session.storage.lock(notePath(space, id), LOCK_SECONDS)
      acquired.push(lock)
      locks[space] = lock
    }
    await renew(session, locks)
    return await action(locks)
  } catch (error) {
    if (hasStatus(error, 405)) {
      throw new CliError('LOCKS_UNSUPPORTED', 'This homeserver does not support the storage locks required for safe CLI changes. No unlocked write was attempted.')
    }
    if (hasStatus(error, 423) || hasStatus(error, 412)) {
      throw new CliError('REVISION_CONFLICT', 'The note is being changed or its lock expired. Read it again before retrying.')
    }
    throw error
  } finally {
    for (const lock of acquired.reverse()) {
      try { await session.storage.unlock(lock) } catch { /* The homeserver expires unreleased locks. */ }
      lock.free()
    }
  }
}

async function renew(session: Session, locks: Locks): Promise<void> {
  await session.storage.refreshLock(locks.private, LOCK_SECONDS)
  await session.storage.refreshLock(locks.public, LOCK_SECONDS)
}

function notePath(space: Space, id: string): Path {
  requireId(id)
  return `${ROOTS[space]}${id}.json`
}

async function readPair(session: Session, id: string): Promise<Pair> {
  requireId(id)
  const [privateNote, publicNote] = await Promise.all([
    readOptional(session, notePath('private', id), id),
    readOptional(session, notePath('public', id), id),
  ])
  return { private: privateNote, public: publicNote }
}

async function readOptional(session: Session, path: Path, id: string): Promise<Note | null> {
  try { return validateNote(await readBoundedJson(await session.storage.get(path)), id) } catch (error) {
    if (hasStatus(error, 404) || hasStatus(error, 410)) return null
    throw error
  }
}

function canonical(pair: Pair): Note {
  const note = pair.private ?? (pair.public ? publicSnapshot(pair.public) : null)
  if (!note) throw new CliError('NOTE_NOT_FOUND', 'The note does not exist.')
  return note
}

function toView(pair: Pair): NoteView {
  return { note: canonical(pair), published: pair.public ? publicSnapshot(pair.public) : null, revision: revisionOf(pair) }
}

function revisionOf(pair: Pair): string {
  // Property order is canonicalized by validateNote. Hash private absence as well
  // as public state; an orphan must not compare equal to a saved private original.
  return createHash('sha256').update(JSON.stringify([pair.private, pair.public])).digest('hex')
}

function publicSnapshot(note: Note): Note {
  return { id: note.id, title: note.title, content: note.content, createdAt: note.createdAt, updatedAt: note.updatedAt }
}

async function deleteLockedIfPresent(session: Session, lock: StorageLock): Promise<void> {
  try { await session.storage.deleteLocked(lock) } catch (error) {
    if (!hasStatus(error, 404) && !hasStatus(error, 410)) throw error
  }
}

async function listIds(session: Session, space: Space): Promise<string[]> {
  const folder = ROOTS[space]
  const owner = session.info.publicKey.z32()
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  let entries = 0
  for (;;) {
    let batch: string[]
    try { batch = await session.storage.list(folder, cursor, false, PAGE_SIZE, true) } catch (error) {
      if (cursor === null && (hasStatus(error, 404) || hasStatus(error, 410))) return []
      throw error
    }
    if (batch.length === 0) break
    entries += batch.length
    if (entries > MAX_NOTES) throw new CliError('LIMIT_EXCEEDED', `This notebook exceeds the ${MAX_NOTES} note limit.`)
    for (const entry of batch) {
      const resource = PubkyResource.parse(entry)
      try {
        if (resource.owner.z32() !== owner || !resource.path.startsWith(folder)) {
          throw new CliError('INVALID_LIST', 'The homeserver returned a note outside this account’s Notes folder.')
        }
        const filename = resource.path.slice(folder.length)
        if (!filename.endsWith('.json') || filename.includes('/')) continue
        const id = filename.slice(0, -5)
        requireId(id)
        if (resource.path !== `${folder}${id}.json`) throw new CliError('INVALID_LIST', 'Invalid note path.')
        ids.add(id)
      } finally { resource.free() }
    }
    const next = batch[batch.length - 1]
    if (cursors.has(next)) throw new CliError('INVALID_LIST', 'The homeserver repeated a page of notes.')
    cursors.add(next)
    if (batch.length < PAGE_SIZE) break
    cursor = next
  }
  return [...ids]
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw { data: { statusCode: response.status } }
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > MAX_NOTE_BYTES) {
    await response.body?.cancel()
    throw new CliError('LIMIT_EXCEEDED', 'This note is too large to open.')
  }
  if (!response.body) throw new CliError('INVALID_NOTE', 'The homeserver returned an empty note response.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_NOTE_BYTES) throw new CliError('LIMIT_EXCEEDED', 'This note is too large to open.')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
  try { return JSON.parse(text) } catch { throw new CliError('INVALID_NOTE', 'The homeserver returned an invalid note file.') }
}

export function validateNote(value: unknown, expectedId?: string): Note {
  if (typeof value !== 'object' || value === null) throw new CliError('INVALID_NOTE', 'Invalid note data.')
  const record = value as Record<string, unknown>
  requireId(record.id)
  if ((expectedId !== undefined && record.id !== expectedId) || typeof record.title !== 'string' ||
      record.title.length > 200 || typeof record.content !== 'string' || record.content.length > MAX_CONTENT_LENGTH ||
      !isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt)) {
    throw new CliError('INVALID_NOTE', 'A note requires a title of up to 200 characters, Markdown of up to 250000 characters, and valid timestamps.')
  }
  const note: Note = {
    id: record.id, title: record.title, content: record.content,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  }
  if (record.folder !== undefined) {
    if (typeof record.folder !== 'string') throw new CliError('INVALID_FOLDER', 'Invalid note folder.')
    const folder = normalizeFolder(record.folder)
    if (folder) note.folder = folder
  }
  if (record.deleted !== undefined) {
    if (typeof record.deleted !== 'boolean') throw new CliError('INVALID_NOTE', 'Invalid deleted state.')
    if (record.deleted) note.deleted = true
  }
  if (record.crdt !== undefined) {
    if (typeof record.crdt !== 'object' || record.crdt === null) throw new CliError('INVALID_NOTE', 'Invalid CRDT editing history.')
    note.crdt = record.crdt as Note['crdt']
    try { note.crdt = validateCrdtNote(note).crdt } catch { throw new CliError('INVALID_NOTE', 'Invalid or inconsistent CRDT note data.') }
  }
  if (Buffer.byteLength(JSON.stringify(note), 'utf8') > MAX_NOTE_BYTES) {
    throw new CliError('LIMIT_EXCEEDED', 'This note is too large to save.')
  }
  return note
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
}

function requireId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new CliError('INVALID_ID', 'Invalid note ID.')
}

function hasStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false
  const data = error.data
  return typeof data === 'object' && data !== null && 'statusCode' in data && data.statusCode === status
}
