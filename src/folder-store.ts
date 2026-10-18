import { createHash } from 'node:crypto'
import type { Path, Session, StorageLock } from '@synonymdev/pubky'
import { CliError } from './errors.js'
import { folderContains, normalizeFolder } from './folders.js'
import { listNotes, moveNoteFolder } from './notes.js'
import type { NoteView } from './notes.js'

// Match the web app's private metadata file; note readers skip its lack of suffix.
export const FOLDERS_PATH: Path = '/priv/notes/folders'
export const MAX_FOLDERS = 2_000
export const MAX_FOLDER_STORE_BYTES = 256 * 1024
const LOCK_SECONDS = 60

export interface FolderView {
  folders: string[]
  explicitFolders: string[]
  /** Includes registry presence and every active and trashed note revision. */
  revision: string
}
interface Registry { exists: boolean; folders: string[] }
interface Snapshot { registry: Registry; notes: NoteView[]; view: FolderView }

export async function listFolders(session: Session): Promise<FolderView> {
  return (await snapshot(session)).view
}

export async function createFolder(session: Session, path: string): Promise<FolderView> {
  const folder = requireFolder(path)
  return withRegistryLock(session, async lock => {
    const current = await snapshot(session)
    if (current.view.folders.includes(folder)) throw new CliError('FOLDER_EXISTS', 'A folder with that name already exists.')
    // mkdir accepts a full path and keeps all its empty ancestors visible.
    const folders = normalizeFolderPaths(folderPaths([], [...current.view.folders, folder]))
    await writeRegistry(session, lock, folders)
    return makeView({ exists: true, folders }, current.notes)
  })
}

/** Destination is the full new path; moving into a parent is expressed by appending the folder name. */
export async function renameFolder(session: Session, source: string, destination: string, ifRevision: string): Promise<FolderView & { movedNotes: number }> {
  const from = requireFolder(source), to = requireFolder(destination)
  requireRevision(ifRevision)
  if (from === to) throw new CliError('INVALID_FOLDER_MOVE', 'The folder is already there.')
  if (folderContains(from, to)) throw new CliError('INVALID_FOLDER_MOVE', 'A folder cannot be moved into itself or its subfolders.')
  return withRegistryLock(session, async lock => {
    const current = await snapshot(session)
    assertRevision(current, ifRevision)
    if (!current.view.folders.includes(from)) throw new CliError('FOLDER_NOT_FOUND', 'The source folder does not exist.')
    const parent = to.split('/').slice(0, -1).join('/')
    if (parent && !current.view.folders.includes(parent)) throw new CliError('FOLDER_NOT_FOUND', 'The destination parent folder does not exist.')
    if (current.view.folders.includes(to)) throw new CliError('FOLDER_EXISTS', 'The destination folder already exists. Folder trees cannot be merged.')
    // Validate the complete tree, including deeper paths and Trash, before writing.
    const folders = normalizeFolderPaths(current.view.folders.map(path => relocate(path, from, to)))
    const staged = normalizeFolderPaths([...current.view.folders, ...folders])
    const moves = current.notes.filter(row => folderContains(from, row.note.folder ?? ''))
      .map(row => ({ row, folder: relocate(row.note.folder ?? '', from, to) }))
    let attempted = false
    const completed: string[] = []
    try {
      attempted = true
      await writeRegistry(session, lock, staged)
      for (const { row, folder } of moves) {
        await session.storage.refreshLock(lock, LOCK_SECONDS)
        await moveNoteFolder(session, row.note.id, row.revision, folder)
        completed.push(row.note.id)
      }
      const latest = await snapshot(session)
      // New notes can arrive without touching registry metadata. Never discard
      // their old directory when completing a non-atomic multi-note operation.
      if (latest.notes.some(row => folderContains(from, row.note.folder ?? ''))) {
        throw new CliError('REVISION_CONFLICT', 'A note arrived in the source folder during the move.')
      }
      const remaining = latest.view.folders.filter(path => !folderContains(from, path) && !staged.includes(path))
      const finalFolders = normalizeFolderPaths([...folders, ...remaining])
      await writeRegistry(session, lock, finalFolders)
      return { ...makeView({ exists: true, folders: finalFolders }, latest.notes), movedNotes: completed.length }
    } catch (error) {
      if (!attempted) throw error
      const reason = error instanceof Error ? error.message : 'The homeserver did not complete the operation.'
      throw new CliError('PARTIAL_FOLDER_OPERATION', `Folder change stopped after ${completed.length} confirmed note moves${completed.length ? ` (${completed.join(', ')})` : ''}. ${reason} Changes may already be saved; staged folders and completed moves are kept. List folders and notes before retrying.`)
    }
  })
}

export async function deleteFolder(session: Session, path: string, ifRevision: string): Promise<FolderView> {
  const folder = requireFolder(path)
  requireRevision(ifRevision)
  return withRegistryLock(session, async lock => {
    const current = await snapshot(session)
    assertRevision(current, ifRevision)
    if (!current.view.folders.includes(folder)) throw new CliError('FOLDER_NOT_FOUND', 'The folder does not exist.')
    if (current.notes.some(row => !row.note.deleted && folderContains(folder, row.note.folder ?? '')) ||
        current.view.folders.some(path => path !== folder && folderContains(folder, path))) {
      throw new CliError('FOLDER_NOT_EMPTY', 'Only empty folders can be deleted. Move their notes and subfolders first.')
    }
    // Trash does not make a directory visible or prevent deleting an empty one,
    // matching the web app. Restoring a trashed note can recreate its directory.
    const folders = normalizeFolderPaths(current.view.folders.filter(path => path !== folder))
    await writeRegistry(session, lock, folders)
    return makeView({ exists: true, folders }, current.notes)
  })
}

export function normalizeFolderPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_FOLDERS) throw new CliError('LIMIT_EXCEEDED', `Folder metadata allows at most ${MAX_FOLDERS} folder names.`)
  const folders = value.map((entry: unknown) => {
    if (typeof entry !== 'string') throw new CliError('INVALID_FOLDER_STORE', 'Invalid folder name in folder metadata.')
    return requireFolder(entry)
  })
  const saved = [...new Set(folders)].sort((a, b) => a.localeCompare(b))
  if (Buffer.byteLength(JSON.stringify({ version: 1, folders: saved }), 'utf8') > MAX_FOLDER_STORE_BYTES) {
    throw new CliError('LIMIT_EXCEEDED', 'The folder list is too large to save.')
  }
  return saved
}

async function snapshot(session: Session): Promise<Snapshot> {
  const [registry, notes] = await Promise.all([readRegistry(session), listNotes(session, { all: true })])
  return { registry, notes, view: makeView(registry, notes) }
}

function makeView(registry: Registry, notes: readonly NoteView[]): FolderView {
  return {
    folders: folderPaths(notes.filter(row => !row.note.deleted), registry.folders),
    explicitFolders: registry.folders,
    revision: createHash('sha256').update(JSON.stringify([
      registry.exists, registry.folders,
      notes.map(row => [row.note.id, row.revision]).sort((a, b) => a[0].localeCompare(b[0])),
    ])).digest('hex'),
  }
}

function folderPaths(notes: readonly NoteView[], explicit: readonly string[]): string[] {
  const paths = new Set<string>()
  for (const input of [...explicit, ...notes.map(row => row.note.folder ?? '')]) {
    const folder = normalizeFolder(input)
    if (!folder) continue
    const segments = folder.split('/')
    for (let depth = 1; depth <= segments.length; depth++) paths.add(segments.slice(0, depth).join('/'))
  }
  return [...paths].sort((a, b) => a.localeCompare(b))
}

function relocate(path: string, source: string, target: string): string {
  return folderContains(source, path) ? requireFolder(`${target}${path.slice(source.length)}`) : path
}

function requireFolder(input: string): string {
  const folder = normalizeFolder(input)
  if (!folder) throw new CliError('INVALID_FOLDER', 'Choose a named folder; the notebook root is not a folder.')
  return folder
}

function requireRevision(revision: string): void {
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new CliError('INVALID_REVISION', 'Supply the revision returned by the latest folders read.')
}

function assertRevision(current: Snapshot, revision: string): void {
  if (current.view.revision !== revision) throw new CliError('REVISION_CONFLICT', 'The folders or notebook notes changed. List folders again before retrying.')
}

async function withRegistryLock<T>(session: Session, action: (lock: StorageLock) => Promise<T>): Promise<T> {
  let lock: StorageLock | undefined
  try {
    lock = await session.storage.lock(FOLDERS_PATH, LOCK_SECONDS)
    return await action(lock)
  } catch (error) {
    if (hasStatus(error, 405)) throw new CliError('LOCKS_UNSUPPORTED', 'This homeserver does not support the storage locks required for safe CLI changes. No unlocked write was attempted.')
    if (hasStatus(error, 423) || hasStatus(error, 412)) throw new CliError('REVISION_CONFLICT', 'The folders are being changed or their lock expired. List folders again before retrying.')
    throw error
  } finally {
    if (lock) {
      try { await session.storage.unlock(lock) } catch { /* Storage locks expire. */ }
      lock.free()
    }
  }
}

async function writeRegistry(session: Session, lock: StorageLock, folders: readonly string[]): Promise<void> {
  const saved = normalizeFolderPaths(folders)
  await session.storage.refreshLock(lock, LOCK_SECONDS)
  await session.storage.putTextLocked(lock, JSON.stringify({ version: 1, folders: saved }))
  const actual = await readRegistry(session)
  if (!actual.exists || JSON.stringify(actual.folders) !== JSON.stringify(saved)) {
    throw new CliError('WRITE_NOT_CONFIRMED', 'The homeserver did not confirm the folder list. Read it again before retrying.')
  }
}

async function readRegistry(session: Session): Promise<Registry> {
  try {
    const value = await readBoundedJson(await session.storage.get(FOLDERS_PATH))
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        !('version' in value) || value.version !== 1 || !('folders' in value)) {
      throw new CliError('INVALID_FOLDER_STORE', 'The homeserver returned invalid folder metadata.')
    }
    return { exists: true, folders: normalizeFolderPaths(value.folders) }
  } catch (error) {
    if (hasStatus(error, 404) || hasStatus(error, 410)) return { exists: false, folders: [] }
    throw error
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel()
    throw { data: { statusCode: response.status } }
  }
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > MAX_FOLDER_STORE_BYTES) {
    await response.body?.cancel()
    throw new CliError('LIMIT_EXCEEDED', 'The folder list is too large to open.')
  }
  if (!response.body) throw new CliError('INVALID_FOLDER_STORE', 'The homeserver returned empty folder metadata.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_FOLDER_STORE_BYTES) throw new CliError('LIMIT_EXCEEDED', 'The folder list is too large to open.')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof TypeError) throw new CliError('INVALID_FOLDER_STORE', 'The homeserver returned invalid folder metadata encoding.')
    throw error
  } finally { reader.releaseLock() }
  try { return JSON.parse(text) } catch { throw new CliError('INVALID_FOLDER_STORE', 'The homeserver returned invalid folder metadata.') }
}

function hasStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false
  const data = error.data
  return typeof data === 'object' && data !== null && 'statusCode' in data && data.statusCode === status
}
