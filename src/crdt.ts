import * as Y from 'yjs'
import diff from 'fast-diff'
import { normalizeFolder } from './folders.js'

export const MAX_NOTE_BYTES = 4 * 1024 * 1024
export const MAX_CONTENT_LENGTH = 250_000
export const MAX_TITLE_LENGTH = 200

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

export function editNote(note: CrdtNote, patch: NotePatch): CrdtNote {
  const current = validateCrdtNote(note)
  if (!current.crdt) throw new Error('Initialize this note before editing it.')
  const requested = validateFields({ ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() })
  if (current.crdt.version === 2) {
    const doc = sharedDocumentOf(current), personal = personalDocumentOf(current)
    try {
      doc.transact(() => { editText(doc.getText('title'), requested.title); editText(doc.getText('content'), requested.content) })
      editPersonal(personal, current, requested)
      return materializeSharedNote(doc, personal, requested, current.crdt.lineage)
    } finally { doc.destroy(); personal.destroy() }
  }
  const doc = documentOf(current)
  try {
    doc.transact(() => {
      editText(doc.getText('title'), requested.title)
      editText(doc.getText('content'), requested.content)
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
  if ([...doc.share.keys()].some(key => !['title', 'content', 'meta'].includes(key))) throw new Error('Unexpected note editing data.')
  const title = doc.getText('title'), content = doc.getText('content'), meta = doc.getMap('meta')
  if (title.length > MAX_TITLE_LENGTH || content.length > MAX_CONTENT_LENGTH ||
      [...title.toDelta(), ...content.toDelta()].some(operation => typeof operation.insert !== 'string')) throw new Error('Invalid note text in editing history.')
  if ([...meta.keys()].some(key => !['folder', 'deleted'].includes(key)) ||
      typeof meta.get('folder') !== 'string' || typeof meta.get('deleted') !== 'boolean') throw new Error('Invalid note metadata in editing history.')
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

/** Version two keeps the only peer-visible state in a plain-text Y.Doc. */
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
    if (!(item instanceof Y.Item) || !(item.content instanceof Y.ContentString) || item.parentSub !== null ||
        (item.parent !== null && !(typeof item.parent === 'string' && ['title', 'content'].includes(item.parent)))) {
      throw new Error('Shared updates may contain only plain title and content text.')
    }
  }
}

function validateSharedDocument(doc: Y.Doc): void {
  if ([...doc.share.keys()].some(key => !['title', 'content'].includes(key))) throw new Error('Unexpected shared editing data.')
  const title = doc.getText('title'), content = doc.getText('content')
  if (title.length > MAX_TITLE_LENGTH || content.length > MAX_CONTENT_LENGTH ||
      [...title.toDelta(), ...content.toDelta()].some(operation => typeof operation.insert !== 'string' || operation.attributes !== undefined)) throw new Error('Invalid shared note text.')
  validateSharedUpdate(Y.encodeStateAsUpdate(doc))
}

function validatePersonalDocument(doc: Y.Doc): void {
  if ([...doc.share.keys()].some(key => key !== 'meta')) throw new Error('Unexpected personal editing data.')
  const meta = doc.getMap('meta')
  if ([...meta.keys()].some(key => !['folder', 'deleted'].includes(key)) ||
      typeof meta.get('folder') !== 'string' || typeof meta.get('deleted') !== 'boolean') throw new Error('Invalid personal note metadata.')
  normalizeFolder(meta.get('folder') as string)
}

export function materializeSharedNote(doc: Y.Doc, personal: Y.Doc, note: CrdtNote, lineage: string): CrdtNote {
  if (!/^shared:[a-f0-9-]{36}$/.test(lineage)) throw new Error('Invalid shared note lineage.')
  validateSharedDocument(doc)
  validatePersonalDocument(personal)
  const meta = personal.getMap('meta')
  const clean = validateFields({ ...note, title: doc.getText('title').toString(), content: doc.getText('content').toString(), folder: meta.get('folder') as string, deleted: meta.get('deleted') as boolean })
  const result: CrdtNote = { ...clean, crdt: { version: 2, update: encode(Y.encodeStateAsUpdate(doc)), personal: encode(Y.encodeStateAsUpdate(personal)), lineage } }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_NOTE_BYTES) throw new Error('This note’s editing history is too large to save. Export the Markdown before continuing.')
  return result
}
