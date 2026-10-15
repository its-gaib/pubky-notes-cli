import * as Y from 'yjs'
import diff from 'fast-diff'
import { normalizeFolder } from './folders.js'

export const MAX_NOTE_BYTES = 4 * 1024 * 1024
export const MAX_CONTENT_LENGTH = 250_000
export const MAX_TITLE_LENGTH = 200
export const MAX_NOTE_VERSIONS = 5_000
export const MAX_VERSION_SNAPSHOT_BYTES = 128 * 1024
export const MAX_NOTE_EDITS = 20_000
export const MAX_VERSION_CHANGE_TEXT_LENGTH = 1024 * 1024
const MAX_EDIT_RANGES = 2_048

/** Editor-supplied attribution, not an independently authenticated identity. */
export interface NoteEditor { id: string; label: string }
interface EditRange { field: 'title' | 'content'; client: number; clock: number; length: number }
interface NoteEditEntry { recordedAt: string; author?: NoteEditor; inserted: EditRange[]; deleted: EditRange[] }
export interface NoteVersionChanges {
  baseline: boolean
  edits: Array<{ id: string; recordedAt: string; author?: NoteEditor; changes: Array<{ field: 'title' | 'content'; inserted: string; deleted: string }> }>
}

export interface NoteVersionInfo { id: string; recordedAt: string; restoredFrom?: string }
interface NoteVersionEntry { recordedAt: string; snapshot: string; restoredFrom?: string }

export type NoteHistory =
  | { version: 1; update: string; lineage: string }
  | { version: 2; update: string; lineage: string; personal: string }

export interface CrdtNote {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  folder?: string
  deleted?: boolean
  crdt?: NoteHistory
}
export type NotePatch = Partial<Pick<CrdtNote, 'title' | 'content' | 'folder' | 'deleted' | 'updatedAt'>>

export class LineageConflictError extends Error {
  constructor() { super('These versions have different editing histories. Keep a recovery copy before continuing.'); this.name = 'LineageConflictError' }
}

/** New notes receive an independent history. Legacy notes use ensureCrdt instead. */
export function initializeNote(note: CrdtNote): CrdtNote {
  if (note.crdt !== undefined) return validateCrdtNote(note)
  return seed(note, `new:${crypto.randomUUID()}`)
}

export async function ensureCrdt(note: CrdtNote): Promise<CrdtNote> {
  if (note.crdt !== undefined) return validateCrdtNote(note)
  const clean = validateFields(note)
  const canonical = JSON.stringify([clean.id, clean.title, clean.content, clean.createdAt, clean.updatedAt, clean.folder ?? '', clean.deleted === true])
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  return seed(clean, `legacy:${hex}`)
}

export function editNote(note: CrdtNote, patch: NotePatch, editor?: NoteEditor): CrdtNote {
  const current = validateCrdtNote(note)
  if (!current.crdt) throw new Error('Initialize this note before editing it.')
  const requested = validateFields({ ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() })
  if (current.crdt.version === 2) {
    const doc = sharedDocumentOf(current), personal = personalDocumentOf(current)
    try {
      editAttributedText(doc, requested, editor)
      editPersonal(personal, current, requested)
      return materializeSharedNote(doc, personal, requested, current.crdt.lineage)
    } finally { doc.destroy(); personal.destroy() }
  }
  const doc = documentOf(current)
  try {
    editAttributedText(doc, requested, editor)
    doc.transact(() => {
      const meta = doc.getMap('meta')
      if ((current.folder ?? '') !== (requested.folder ?? '')) meta.set('folder', requested.folder ?? '')
      if ((current.deleted === true) !== (requested.deleted === true)) meta.set('deleted', requested.deleted === true)
    })
    return materialize(doc, requested, current.crdt.lineage)
  } finally { doc.destroy() }
}

export function mergeNotes(left: CrdtNote, right: CrdtNote): CrdtNote {
  const a = validateCrdtNote(left), b = validateCrdtNote(right)
  if (!a.crdt || !b.crdt) throw new Error('Initialize both notes before merging them.')
  if (a.id !== b.id || a.createdAt !== b.createdAt || a.crdt.lineage !== b.crdt.lineage || a.crdt.version !== b.crdt.version) throw new LineageConflictError()
  if (a.crdt.version === 2 && b.crdt.version === 2) {
    const doc = sharedDocumentOf(a), personal = personalDocumentOf(a)
    try {
      Y.applyUpdate(doc, decode(b.crdt.update))
      Y.applyUpdate(personal, decode(b.crdt.personal))
      return materializeSharedNote(doc, personal, { ...a, updatedAt: [a.updatedAt, b.updatedAt].sort().at(-1)! }, a.crdt.lineage)
    } finally { doc.destroy(); personal.destroy() }
  }
  const doc = documentOf(a)
  try {
    Y.applyUpdate(doc, decode(b.crdt.update))
    return materialize(doc, { ...a, updatedAt: [a.updatedAt, b.updatedAt].sort().at(-1)! }, a.crdt.lineage)
  } finally { doc.destroy() }
}

/** Reject remote JSON whose readable snapshot does not match its editing history. */
export function validateCrdtNote(note: CrdtNote): CrdtNote {
  const clean = validateFields(note)
  if (note.crdt === undefined) return clean
  const value: unknown = note.crdt
  if (typeof value === 'object' && value !== null && 'version' in value && value.version === 2) {
    if (!('lineage' in value) || typeof value.lineage !== 'string' || !/^shared:[a-f0-9-]{36}$/.test(value.lineage) ||
        !('update' in value) || typeof value.update !== 'string' || !('personal' in value) || typeof value.personal !== 'string') throw new Error('Invalid shared note editing history.')
    const shared = { ...clean, crdt: { version: 2 as const, lineage: value.lineage, update: value.update, personal: value.personal } }
    const doc = sharedDocumentOf(shared), personal = personalDocumentOf(shared)
    try {
      const decoded = materializeSharedNote(doc, personal, clean, value.lineage)
      if (decoded.title !== clean.title || decoded.content !== clean.content ||
          (decoded.folder ?? '') !== (clean.folder ?? '') || (decoded.deleted === true) !== (clean.deleted === true)) throw new Error('The note snapshot does not match its editing history.')
      return decoded
    } finally { doc.destroy(); personal.destroy() }
  }
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 ||
      !('lineage' in value) || typeof value.lineage !== 'string' ||
      !/^(?:legacy:[a-f0-9]{64}|new:[a-f0-9-]{36})$/.test(value.lineage) ||
      !('update' in value) || typeof value.update !== 'string') throw new Error('Invalid note editing history.')
  const doc = documentOf({ ...clean, crdt: { version: 1, lineage: value.lineage, update: value.update } })
  try {
    const decoded = materialize(doc, clean, value.lineage)
    if (decoded.title !== clean.title || decoded.content !== clean.content ||
        (decoded.folder ?? '') !== (clean.folder ?? '') || (decoded.deleted === true) !== (clean.deleted === true)) {
      throw new Error('The note snapshot does not match its editing history.')
    }
    return decoded
  } finally { doc.destroy() }
}

/** Compare full editing state, including operations hidden by a deletion. */
export function noteRevision(note: CrdtNote): string {
  return note.crdt ? `${note.crdt.lineage}:${note.crdt.update}${note.crdt.version === 2 ? `:${note.crdt.personal}` : ''}` : JSON.stringify(note)
}

/** Save a compact checkpoint in the owner's private document, never in peer-visible state. */
export function checkpointNote(note: CrdtNote, options: { recordedAt?: string; restoredFrom?: string } = {}): CrdtNote {
  const current = validateCrdtNote(note)
  if (!current.crdt) throw new Error('Initialize this note before saving a version.')
  const recordedAt = options.recordedAt ?? new Date().toISOString()
  if (!timestamp(recordedAt)) throw new Error('Invalid note version date.')
  const doc = current.crdt.version === 2 ? sharedDocumentOf(current) : documentOf(current)
  const personal = current.crdt.version === 2 ? personalDocumentOf(current) : doc
  try {
    const history = personal.getMap<NoteVersionEntry>('history')
    if (options.restoredFrom !== undefined && !history.has(options.restoredFrom)) throw new Error('The restored note version no longer exists.')
    const latest = versionEntries(history).at(-1)
    if (latest) {
      const previous = snapshotText(doc, history.get(latest.id)!.snapshot)
      if (previous.title === current.title && previous.content === current.content) return current
    }
    const orderedAt = latest && Date.parse(recordedAt) <= Date.parse(latest.recordedAt)
      ? new Date(Date.parse(latest.recordedAt) + 1).toISOString() : recordedAt
    addCheckpoint(doc, personal, orderedAt, history.size === 0 && current.crdt.version === 1 ? 'initial' : crypto.randomUUID(), options.restoredFrom)
    return current.crdt.version === 2
      ? materializeSharedNote(doc, personal, current, current.crdt.lineage)
      : materialize(doc, current, current.crdt.lineage)
  } finally { doc.destroy(); if (personal !== doc) personal.destroy() }
}

/** The timeline is private and ordered by the time each browser saved a version. */
export function listNoteVersions(note: CrdtNote): NoteVersionInfo[] {
  const current = validateCrdtNote(note)
  if (!current.crdt) return []
  const doc = current.crdt.version === 2 ? personalDocumentOf(current) : documentOf(current)
  try { return versionEntries(doc.getMap<NoteVersionEntry>('history')) }
  finally { doc.destroy() }
}

/** Read an immutable projection. Viewing history never edits or replaces the live CRDT. */
export function readNoteVersion(note: CrdtNote, id: string): { title: string; content: string } {
  const current = validateCrdtNote(note)
  if (!current.crdt || !versionId(id)) throw new Error('Invalid note version.')
  const doc = current.crdt.version === 2 ? sharedDocumentOf(current) : documentOf(current)
  const personal = current.crdt.version === 2 ? personalDocumentOf(current) : doc
  try {
    const entry = personal.getMap<NoteVersionEntry>('history').get(id)
    if (!entry) throw new Error('This note version does not exist.')
    return snapshotText(doc, entry.snapshot)
  } finally { doc.destroy(); if (personal !== doc) personal.destroy() }
}

/** Actual edits first observed in this checkpoint, including concurrent contributors. */
export function readNoteVersionChanges(note: CrdtNote, id: string): NoteVersionChanges {
  const current = validateCrdtNote(note)
  if (!current.crdt || !versionId(id)) throw new Error('Invalid note version.')
  const doc = current.crdt.version === 2 ? sharedDocumentOf(current) : documentOf(current)
  const personal = current.crdt.version === 2 ? personalDocumentOf(current) : doc
  try {
    const history = personal.getMap<NoteVersionEntry>('history')
    const versions = versionEntries(history), index = versions.findIndex(version => version.id === id)
    if (index < 0) throw new Error('This note version does not exist.')
    if (index === 0) return { baseline: true, edits: [] }
    const selected = validatedSnapshot(history.get(id)!.snapshot)
    // Earlier checkpoints can be concurrent branches. Their union prevents an
    // edit from being attributed twice when a later checkpoint reunites them.
    const seen = new Map<number, number>()
    for (const previous of versions.slice(0, index)) {
      for (const [client, clock] of validatedSnapshot(history.get(previous.id)!.snapshot).sv) seen.set(client, Math.max(clock, seen.get(client) ?? 0))
    }
    const journal = doc.getMap<NoteEditEntry>('edits')
    const edits: NoteVersionChanges['edits'] = []
    const included: Array<[string, NoteEditEntry]> = []
    let outputLength = 0
    for (const [editId, entry] of journal.entries()) {
      const item = journal._map.get(editId)!
      if (item.id.clock >= (selected.sv.get(item.id.client) ?? 0) || item.id.clock < (seen.get(item.id.client) ?? 0)) continue
      outputLength += [...entry.inserted, ...entry.deleted].reduce((sum, range) => sum + range.length, 0)
      if (outputLength > MAX_VERSION_CHANGE_TEXT_LENGTH) throw new Error('This version has too many changes to display at once.')
      included.push([editId, entry])
    }
    for (const [editId, entry] of included) {
      const changes = (['title', 'content'] as const).map(field => ({
        field,
        inserted: entry.inserted.filter(range => range.field === field).map(range => rangeText(doc, range)).join(''),
        deleted: entry.deleted.filter(range => range.field === field).map(range => rangeText(doc, range)).join(''),
      })).filter(change => change.inserted.length > 0 || change.deleted.length > 0)
      edits.push({ id: editId, recordedAt: entry.recordedAt, ...(entry.author ? { author: { ...entry.author } } : {}), changes })
    }
    edits.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.id.localeCompare(b.id))
    return { baseline: false, edits }
  } finally { doc.destroy(); if (personal !== doc) personal.destroy() }
}

/** Convert a trusted UI snapshot spread into operations; never use on remote input. */
export async function prepareLocalNote(note: CrdtNote): Promise<CrdtNote> {
  if (note.crdt === undefined) return ensureCrdt(note)
  const fields = validateFields(note)
  if (note.crdt.version === 2) {
    const doc = sharedDocumentOf(note), personal = personalDocumentOf(note)
    try {
      const base = materializeSharedNote(doc, personal, fields, note.crdt.lineage)
      return editNote(base, { title: fields.title, content: fields.content, folder: fields.folder ?? '',
        deleted: note.deleted === undefined ? base.deleted === true : fields.deleted === true, updatedAt: fields.updatedAt })
    } finally { doc.destroy(); personal.destroy() }
  }
  const doc = documentOf(note)
  try {
    const base = materialize(doc, fields, note.crdt.lineage)
    return editNote(base, { title: fields.title, content: fields.content, folder: fields.folder ?? '',
      deleted: note.deleted === undefined ? base.deleted === true : fields.deleted === true, updatedAt: fields.updatedAt })
  } finally { doc.destroy() }
}

function seed(note: CrdtNote, lineage: string): CrdtNote {
  const clean = validateFields(note)
  const doc = new Y.Doc({ gc: false })
  // Only the immutable baseline uses client zero. Every actual edit gets a new ID.
  doc.clientID = 0
  try {
    doc.transact(() => {
      doc.getText('title').insert(0, clean.title)
      doc.getText('content').insert(0, clean.content)
      doc.getMap('meta').set('folder', clean.folder ?? '')
      doc.getMap('meta').set('deleted', clean.deleted === true)
    })
    addCheckpoint(doc, doc, clean.updatedAt, 'initial')
    return materialize(doc, clean, lineage)
  } finally { doc.destroy() }
}

function documentOf(note: CrdtNote): Y.Doc {
  const doc = new Y.Doc({ gc: false })
  if (doc.clientID === 0) doc.clientID = 1
  try {
    if (!note.crdt) throw new Error('Missing note editing history.')
    Y.applyUpdate(doc, decode(note.crdt.update))
    return doc
  } catch (error) { doc.destroy(); throw error }
}

function materialize(doc: Y.Doc, note: CrdtNote, lineage: string): CrdtNote {
  if ([...doc.share.keys()].some(key => !['title', 'content', 'meta', 'history', 'edits'].includes(key))) throw new Error('Unexpected note editing data.')
  const title = doc.getText('title'), content = doc.getText('content'), meta = doc.getMap('meta')
  if (title.length > MAX_TITLE_LENGTH || content.length > MAX_CONTENT_LENGTH ||
      [...title.toDelta(), ...content.toDelta()].some(operation => typeof operation.insert !== 'string')) throw new Error('Invalid note text in editing history.')
  if ([...meta.keys()].some(key => !['folder', 'deleted'].includes(key)) ||
      typeof meta.get('folder') !== 'string' || typeof meta.get('deleted') !== 'boolean') throw new Error('Invalid note metadata in editing history.')
  validateVersionHistory(doc, doc)
  validateEditHistory(doc)
  const clean = validateFields({ ...note, title: title.toString(), content: content.toString(), folder: meta.get('folder') as string, deleted: meta.get('deleted') as boolean })
  const result: CrdtNote = { ...clean, crdt: { version: 1, update: encode(Y.encodeStateAsUpdate(doc)), lineage } }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_NOTE_BYTES) throw new Error('This note’s editing history is too large to save. Export the Markdown before continuing.')
  return result
}

export function editText(text: Y.Text, value: string): void {
  let index = 0
  for (const [operation, chunk] of diff(text.toString(), value)) {
    if (operation === -1) text.delete(index, chunk.length)
    else if (operation === 1) { text.insert(index, chunk); index += chunk.length }
    else index += chunk.length
  }
}

/** Record authorship with the text operation, including who removed old text. */
export function editAttributedText(doc: Y.Doc, requested: Pick<CrdtNote, 'title' | 'content' | 'updatedAt'>, editor?: NoteEditor): void {
  const author = editor === undefined ? undefined : normalizeNoteEditor(editor)
  if (doc.getText('title').toString() === requested.title && doc.getText('content').toString() === requested.content) return
  const journal = doc.getMap<NoteEditEntry>('edits')
  if (journal.size >= MAX_NOTE_EDITS) throw new Error('This note has too many recorded edits. Export the Markdown before continuing.')
  const inserted: EditRange[] = [], deleted: EditRange[] = []
  const append = (ranges: EditRange[], range: EditRange) => {
    const previous = ranges.at(-1)
    if (previous && previous.field === range.field && previous.client === range.client && previous.clock + previous.length === range.clock) previous.length += range.length
    else ranges.push(range)
    if (inserted.length + deleted.length > MAX_EDIT_RANGES) throw new Error('This edit has too many text changes. Make a smaller edit before continuing.')
  }
  doc.transact(() => {
    for (const field of ['title', 'content'] as const) {
      const text = doc.getText(field)
      let index = 0
      for (const [operation, chunk] of diff(text.toString(), requested[field])) {
        if (operation === -1) {
          let position = 0, remaining = chunk.length
          for (let item = text._start; item && remaining > 0; item = item.right) {
            if (item.deleted || !item.countable) continue
            const offset = Math.max(0, index - position)
            if (offset < item.length) {
              const length = Math.min(item.length - offset, remaining)
              append(deleted, { field, client: item.id.client, clock: item.id.clock + offset, length })
              remaining -= length
            }
            position += item.length
          }
          if (remaining !== 0) throw new Error('Invalid edit deletion range.')
          text.delete(index, chunk.length)
        } else if (operation === 1) {
          const previous = doc.store.clients.get(doc.clientID)?.at(-1)
          const clock = previous ? previous.id.clock + previous.length : 0
          text.insert(index, chunk)
          append(inserted, { field, client: doc.clientID, clock, length: chunk.length })
          index += chunk.length
        } else index += chunk.length
      }
    }
    journal.set(crypto.randomUUID(), { recordedAt: requested.updatedAt, ...(author ? { author } : {}), inserted, deleted })
  })
}

const EDITOR_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const editorLabel = (label: string): string => Array.from(label.replace(EDITOR_CONTROLS, '').trim()).slice(0, 64).join('') || 'Editor'

/** Normalize display names on local writes; remote records must already be canonical. */
export function normalizeNoteEditor(editor: NoteEditor): NoteEditor {
  return validatedEditor({ id: editor?.id, label: typeof editor?.label === 'string' ? editorLabel(editor.label) : editor?.label })
}

function validatedEditor(value: unknown): NoteEditor {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,label' ||
      !('id' in value) || typeof value.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(value.id) ||
      !('label' in value) || typeof value.label !== 'string' || value.label.length > 128 || editorLabel(value.label) !== value.label) throw new Error('Invalid editor attribution.')
  return { id: value.id, label: value.label }
}

function validateEditEntry(value: unknown): asserts value is NoteEditEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).some(key => !['recordedAt', 'author', 'inserted', 'deleted'].includes(key)) ||
      !('recordedAt' in value) || !timestamp(value.recordedAt) || !('inserted' in value) || !Array.isArray(value.inserted) ||
      !('deleted' in value) || !Array.isArray(value.deleted) || value.inserted.length + value.deleted.length === 0 ||
      value.inserted.length + value.deleted.length > MAX_EDIT_RANGES) throw new Error('Invalid recorded note edit.')
  if ('author' in value) validatedEditor(value.author)
  for (const range of [...value.inserted, ...value.deleted]) {
    if (typeof range !== 'object' || range === null || Array.isArray(range) || Object.keys(range).sort().join(',') !== 'client,clock,field,length' ||
        !['title', 'content'].includes(range.field) || !Number.isInteger(range.client) || range.client < 0 || range.client > 0xffffffff ||
        !Number.isSafeInteger(range.clock) || range.clock < 0 || !Number.isSafeInteger(range.length) || range.length <= 0 ||
        range.length > (range.field === 'title' ? MAX_TITLE_LENGTH : MAX_CONTENT_LENGTH) || !Number.isSafeInteger(range.clock + range.length)) throw new Error('Invalid recorded edit range.')
  }
  for (const ranges of [value.inserted, value.deleted]) {
    for (const field of ['title', 'content'] as const) {
      if (ranges.filter(range => range.field === field).reduce((sum, range) => sum + range.length, 0) > (field === 'title' ? MAX_TITLE_LENGTH : MAX_CONTENT_LENGTH)) throw new Error('Recorded edit text exceeds the field limit.')
    }
    const sorted = [...ranges].sort((a, b) => a.client - b.client || a.clock - b.clock)
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index]!.client === sorted[index - 1]!.client && sorted[index]!.clock < sorted[index - 1]!.clock + sorted[index - 1]!.length) throw new Error('Recorded edit ranges overlap.')
    }
  }
}

/** Resolve IDs directly so adjacent deletions by different editors stay separate. */
function rangeText(doc: Y.Doc, range: EditRange, requireDeleted = false, read = true): string {
  const text = doc.getText(range.field)
  const structs = doc.store.clients.get(range.client)
  if (!structs?.length) throw new Error('A recorded edit refers to unavailable text.')
  let low = 0, high = structs.length - 1
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2)
    if (structs[middle]!.id.clock <= range.clock) low = middle
    else high = middle - 1
  }
  let cursor = range.clock, result = ''
  const end = cursor + range.length
  for (let index = low; cursor < end; index++) {
    const item = structs[index]
    if (!(item instanceof Y.Item) || !(item.content instanceof Y.ContentString) || item.parent !== text ||
        item.id.clock > cursor || item.id.clock + item.length <= cursor || (requireDeleted && !item.deleted)) throw new Error('A recorded edit refers to unavailable text.')
    const length = Math.min(end, item.id.clock + item.length) - cursor
    if (read) result += item.content.str.slice(cursor - item.id.clock, cursor - item.id.clock + length)
    cursor += length
  }
  return result
}

function validateEditHistory(doc: Y.Doc): void {
  const journal = doc.getMap<NoteEditEntry>('edits')
  if (journal.size > MAX_NOTE_EDITS) throw new Error('This note has too many recorded edits. Export the Markdown before continuing.')
  let referencedText = 0
  for (const [id, entry] of journal.entries()) {
    if (!versionId(id) || id === 'initial') throw new Error('Invalid recorded edit ID.')
    validateEditEntry(entry)
    const item = journal._map.get(id)!
    for (const range of entry.inserted) {
      if (range.client !== item.id.client || range.clock + range.length > item.id.clock) throw new Error('Invalid recorded insertion ownership.')
    }
    referencedText += [...entry.inserted, ...entry.deleted].reduce((sum, range) => sum + range.length, 0)
    if (referencedText > MAX_NOTE_BYTES) throw new Error('This note’s edit attribution is too large to save. Export the Markdown before continuing.')
    for (const range of entry.inserted) rangeText(doc, range, false, false)
    for (const range of entry.deleted) rangeText(doc, range, true, false)
  }
  for (const structs of doc.store.clients.values()) {
    for (const item of structs) {
      if (item instanceof Y.Item && item.parent === journal && (item.deleted || item.parentSub === null || !(item.content instanceof Y.ContentAny))) throw new Error('Recorded edits cannot be changed or deleted.')
    }
  }
}

export function validateFields(note: CrdtNote): CrdtNote {
  if (typeof note !== 'object' || note === null || typeof note.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(note.id) ||
      typeof note.title !== 'string' || note.title.length > MAX_TITLE_LENGTH ||
      typeof note.content !== 'string' || note.content.length > MAX_CONTENT_LENGTH ||
      !timestamp(note.createdAt) || !timestamp(note.updatedAt) ||
      (note.folder !== undefined && typeof note.folder !== 'string') ||
      (note.deleted !== undefined && typeof note.deleted !== 'boolean')) throw new Error('Invalid note data.')
  const result: CrdtNote = { id: note.id, title: note.title, content: note.content, createdAt: note.createdAt, updatedAt: note.updatedAt }
  const folder = normalizeFolder(note.folder ?? '')
  if (folder) result.folder = folder
  if (note.deleted === true) result.deleted = true
  return result
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
}

export function encode(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8_192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192))
  return btoa(binary)
}

export function decode(value: string): Uint8Array {
  if (typeof value !== 'string' || !value.length || value.length > MAX_NOTE_BYTES || value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid or oversized note editing history.')
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  if (encode(bytes) !== value) throw new Error('Invalid note editing history encoding.')
  return bytes
}

/** Version two shares text and reported edit attribution; checkpoints remain private. */
export function sharedDocumentOf(note: CrdtNote): Y.Doc {
  if (note.crdt?.version !== 2) throw new Error('This note is not a shared document.')
  const update = decode(note.crdt.update)
  validateSharedUpdate(update)
  const doc = new Y.Doc({ gc: false })
  try { Y.applyUpdate(doc, update); validateSharedDocument(doc); return doc }
  catch (error) { doc.destroy(); throw error }
}

export function personalDocumentOf(note: CrdtNote): Y.Doc {
  if (note.crdt?.version !== 2) throw new Error('This note is not a shared document.')
  const doc = new Y.Doc({ gc: false })
  try { Y.applyUpdate(doc, decode(note.crdt.personal)); validatePersonalDocument(doc); return doc }
  catch (error) { doc.destroy(); throw error }
}

export function newPersonalDocument(folder = ''): Y.Doc {
  const doc = new Y.Doc({ gc: false })
  const client = doc.clientID || 1
  doc.clientID = 0
  doc.transact(() => { doc.getMap('meta').set('folder', ''); doc.getMap('meta').set('deleted', false) })
  doc.clientID = client
  if (folder) doc.getMap('meta').set('folder', normalizeFolder(folder))
  return doc
}

export function editPersonal(doc: Y.Doc, current: CrdtNote, requested: CrdtNote): void {
  doc.transact(() => {
    const meta = doc.getMap('meta')
    if ((current.folder ?? '') !== (requested.folder ?? '')) meta.set('folder', requested.folder ?? '')
    if ((current.deleted === true) !== (requested.deleted === true)) meta.set('deleted', requested.deleted === true)
  })
}

/** Inspect even deleted/pending structs: hidden formatting or metadata is not a valid shared update. */
export function validateSharedUpdate(update: Uint8Array): void {
  if (!(update instanceof Uint8Array) || update.byteLength < 2 || update.byteLength > MAX_NOTE_BYTES) throw new Error('Invalid or oversized shared update.')
  const decoded = Y.decodeUpdate(update)
  if (decoded.structs.length > 100_000) throw new Error('Shared editing history has too many operations.')
  for (const item of decoded.structs) {
    if (item instanceof Y.Skip) continue
    if (!(item instanceof Y.Item)) throw new Error('Invalid shared editing operation.')
    if (item.content instanceof Y.ContentString && item.parentSub === null &&
        (item.parent === null || (typeof item.parent === 'string' && ['title', 'content'].includes(item.parent)))) continue
    if (item.content instanceof Y.ContentAny && typeof item.parentSub === 'string' && versionId(item.parentSub) && item.parentSub !== 'initial' &&
        (item.parent === null || (typeof item.parent === 'string' && item.parent === 'edits'))) {
      const entries = item.content.getContent()
      if (entries.length !== 1) throw new Error('Invalid shared attribution operation.')
      validateEditEntry(entries[0])
      continue
    }
    throw new Error('Shared updates may contain only plain text and edit attribution.')
  }
}

function validateSharedDocument(doc: Y.Doc): void {
  if ([...doc.share.keys()].some(key => !['title', 'content', 'edits'].includes(key))) throw new Error('Unexpected shared editing data.')
  const title = doc.getText('title'), content = doc.getText('content')
  if (title.length > MAX_TITLE_LENGTH || content.length > MAX_CONTENT_LENGTH ||
      [...title.toDelta(), ...content.toDelta()].some(operation => typeof operation.insert !== 'string' || operation.attributes !== undefined)) throw new Error('Invalid shared note text.')
  validateSharedUpdate(Y.encodeStateAsUpdate(doc))
  validateEditHistory(doc)
}

function validatePersonalDocument(doc: Y.Doc): void {
  if ([...doc.share.keys()].some(key => !['meta', 'history'].includes(key))) throw new Error('Unexpected personal editing data.')
  const meta = doc.getMap('meta')
  if ([...meta.keys()].some(key => !['folder', 'deleted'].includes(key)) ||
      typeof meta.get('folder') !== 'string' || typeof meta.get('deleted') !== 'boolean') throw new Error('Invalid personal note metadata.')
  normalizeFolder(meta.get('folder') as string)
  validateVersionHistory(doc)
}

export function materializeSharedNote(doc: Y.Doc, personal: Y.Doc, note: CrdtNote, lineage: string): CrdtNote {
  if (!/^shared:[a-f0-9-]{36}$/.test(lineage)) throw new Error('Invalid shared note lineage.')
  validateSharedDocument(doc)
  validatePersonalDocument(personal)
  validateVersionHistory(personal, doc)
  const meta = personal.getMap('meta')
  const clean = validateFields({ ...note, title: doc.getText('title').toString(), content: doc.getText('content').toString(), folder: meta.get('folder') as string, deleted: meta.get('deleted') as boolean })
  const result: CrdtNote = { ...clean, crdt: { version: 2, update: encode(Y.encodeStateAsUpdate(doc)), personal: encode(Y.encodeStateAsUpdate(personal)), lineage } }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_NOTE_BYTES) throw new Error('This note’s editing history is too large to save. Export the Markdown before continuing.')
  return result
}

function versionId(value: unknown): value is string {
  return typeof value === 'string' && (value === 'initial' || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
}

function versionEntries(history: Y.Map<NoteVersionEntry>): NoteVersionInfo[] {
  return Array.from(history.entries(), ([id, entry]) => ({ id, recordedAt: entry.recordedAt, ...(entry.restoredFrom === undefined ? {} : { restoredFrom: entry.restoredFrom }) }))
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || (a.id === 'initial' ? -1 : b.id === 'initial' ? 1 : a.id.localeCompare(b.id)))
}

function addCheckpoint(doc: Y.Doc, personal: Y.Doc, recordedAt: string, id: string, restoredFrom?: string): void {
  const history = personal.getMap<NoteVersionEntry>('history')
  if (history.size >= MAX_NOTE_VERSIONS) throw new Error('This note has too many saved versions. Export the Markdown before continuing.')
  const bytes = Y.encodeSnapshot(Y.snapshot(doc))
  if (bytes.byteLength > MAX_VERSION_SNAPSHOT_BYTES) throw new Error('This note’s version checkpoint is too large to save. Export the Markdown before continuing.')
  history.set(id, { recordedAt: new Date(recordedAt).toISOString(), snapshot: encode(bytes), ...(restoredFrom === undefined ? {} : { restoredFrom }) })
}

interface SnapshotSource { end: number; discardedFrom?: number }

function snapshotSource(doc: Y.Doc): Map<number, SnapshotSource> {
  const result = new Map<number, SnapshotSource>()
  for (const [client, structs] of doc.store.clients) {
    const last = structs.at(-1)
    if (!last) continue
    const discarded = structs.find(item => item instanceof Y.GC || (item instanceof Y.Item && item.content instanceof Y.ContentDeleted))
    result.set(client, { end: last.id.clock + last.length, ...(discarded === undefined ? {} : { discardedFrom: discarded.id.clock }) })
  }
  return result
}

/** Bound every snapshot before Yjs walks it, including references to absent clocks. */
function validatedSnapshot(value: string, source?: Map<number, SnapshotSource>): Y.Snapshot {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_VERSION_SNAPSHOT_BYTES / 3) * 4) throw new Error('Invalid or oversized note version checkpoint.')
  const bytes = decode(value)
  if (bytes.byteLength > MAX_VERSION_SNAPSHOT_BYTES) throw new Error('Invalid or oversized note version checkpoint.')
  let snapshot: Y.Snapshot
  try { snapshot = Y.decodeSnapshot(bytes) }
  catch { throw new Error('Invalid note version checkpoint.') }
  if (encode(Y.encodeSnapshot(snapshot)) !== value) throw new Error('Invalid note version checkpoint encoding.')
  const validClient = (client: number) => Number.isInteger(client) && client >= 0 && client <= 0xffffffff
  for (const [client, clock] of snapshot.sv) {
    const available = source?.get(client)
    if (!validClient(client) || !Number.isSafeInteger(clock) || clock <= 0 || (source && (!available || clock > available.end))) throw new Error('A note version refers to unavailable editing history.')
    if (available?.discardedFrom !== undefined && available.discardedFrom < clock) throw new Error('A note version refers to discarded editing history.')
  }
  for (const [client, ranges] of snapshot.ds.clients) {
    let end = -1
    if (!validClient(client) || !ranges.length) throw new Error('Invalid note version deletion history.')
    for (const range of ranges) {
      if (!Number.isSafeInteger(range.clock) || !Number.isSafeInteger(range.len) || range.clock < 0 || range.len <= 0 || range.clock <= end ||
          range.clock + range.len > (snapshot.sv.get(client) ?? 0)) throw new Error('Invalid note version deletion history.')
      end = range.clock + range.len - 1
    }
  }
  return snapshot
}

function validateVersionHistory(personal: Y.Doc, source?: Y.Doc): void {
  const history = personal.getMap<NoteVersionEntry>('history')
  if (history.size > MAX_NOTE_VERSIONS) throw new Error('This note has too many saved versions. Export the Markdown before continuing.')
  const available = source && snapshotSource(source)
  const validated = new Set<string>()
  for (const [id, entry] of history.entries()) {
    if (!versionId(id) || typeof entry !== 'object' || entry === null || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['recordedAt', 'snapshot', 'restoredFrom'].includes(key)) ||
        !timestamp(entry.recordedAt) || typeof entry.snapshot !== 'string' ||
        (entry.restoredFrom !== undefined && (!versionId(entry.restoredFrom) || !history.has(entry.restoredFrom) || entry.restoredFrom === id))) throw new Error('Invalid saved note version.')
    if (!validated.has(entry.snapshot)) { validatedSnapshot(entry.snapshot, available); validated.add(entry.snapshot) }
  }
  // Entries are append-only: a deleted/overwritten entry would silently erase the timeline.
  for (const structs of personal.store.clients.values()) {
    for (const item of structs) {
      if (item instanceof Y.Item && item.parent === history && (item.deleted || item.parentSub === null)) throw new Error('Saved note versions cannot be changed or deleted.')
    }
  }
}

function snapshotText(doc: Y.Doc, encoded: string): { title: string; content: string } {
  const snapshot = validatedSnapshot(encoded, snapshotSource(doc))
  const text = (name: 'title' | 'content', limit: number): string => {
    const delta: Array<{ insert: unknown; attributes?: unknown }> = doc.getText(name).toDelta(snapshot)
    if (delta.some(operation => typeof operation.insert !== 'string' || operation.attributes !== undefined)) throw new Error('Invalid text in saved note version.')
    const result = delta.map(operation => operation.insert as string).join('')
    if (result.length > limit) throw new Error('The saved note version exceeds the text limit.')
    return result
  }
  return { title: text('title', MAX_TITLE_LENGTH), content: text('content', MAX_CONTENT_LENGTH) }
}
