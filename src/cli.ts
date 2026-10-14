#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createReadStream, realpathSync } from 'node:fs'
import { open, lstat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import QRCode from 'qrcode'
import { login, logout, status, withSession } from './auth.js'
import { createNote, deleteNote, folderContains, getNote, listNotes } from './notes.js'
import { normalizeFolder, publishNote, restoreNote, unpublishNote, updateNote } from './notes.js'
import type { NoteView } from './notes.js'
import { CliError } from './errors.js'

const HELP = `Pubky Notes CLI

  pubky-notes login [--force] [--qr-file PATH]
  pubky-notes status
  pubky-notes logout
  pubky-notes list [--folder PATH] [--visibility all|private|public] [--trash]
  pubky-notes get ID [--markdown]
  pubky-notes search QUERY
  pubky-notes create [--title TITLE] [--file FILE|--stdin] [--folder PATH]
  pubky-notes update ID --if-revision HASH [--title TITLE] [--file FILE|--stdin]
  pubky-notes move ID --folder PATH --if-revision HASH
  pubky-notes publish ID --if-revision HASH
  pubky-notes unpublish ID --if-revision HASH
  pubky-notes delete ID --if-revision HASH
  pubky-notes restore ID --if-revision HASH

Output is JSON unless --markdown is requested. New notes are private.
Get a note first and pass its revision when modifying an existing note.
Search covers all titles and Markdown content. Folder paths use /.
Login reuses saved access until its grant expires or is revoked.
`

type Option = { type: 'string' | 'boolean' }
const textOption: Option = { type: 'string' }
const boolOption: Option = { type: 'boolean' }
const inputs = { file: textOption, stdin: boolOption }
const revisionOption = { 'if-revision': textOption }
const specs: Record<string, Record<string, Option>> = {
  login: { force: boolOption, 'qr-file': textOption }, status: {}, logout: {},
  list: { folder: textOption, visibility: textOption, trash: boolOption }, get: { markdown: boolOption }, search: {},
  create: { title: textOption, folder: textOption, ...inputs },
  update: { title: textOption, ...inputs, ...revisionOption },
  move: { folder: textOption, ...revisionOption },
  publish: revisionOption, unpublish: revisionOption, delete: revisionOption, restore: revisionOption,
}

export function json(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function summary(view: NoteView) {
  const { content: _content, crdt: _crdt, ...note } = view.note
  return { ...note, published: !!view.published, revision: view.revision }
}

export function readableView(view: NoteView) {
  const { crdt: _crdt, ...note } = view.note
  return { ...view, note }
}

export async function readContent(file: string | undefined, stdin: boolean): Promise<string | undefined> {
  if (file !== undefined && stdin) throw new CliError('USAGE', 'Choose either --file or --stdin.')
  if (file === undefined && !stdin) return undefined
  const stream = stdin ? process.stdin : createReadStream(file!)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > 512 * 1024) throw new CliError('LIMIT_EXCEEDED', 'Markdown input exceeds 512 KiB.')
      chunks.push(bytes)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('INPUT_ERROR', 'Could not read the Markdown input as UTF-8.')
  }
}

async function renderQr(url: string, file?: string) {
  process.stderr.write('Scan this QR code with Pubky Ring to approve access to your notes.\n')
  process.stderr.write(await QRCode.toString(url, { type: 'terminal', small: true }))
  process.stderr.write(`\nPubky Ring link: ${url}\nWaiting for approval…\n`)
  if (file) {
    const path = resolve(file)
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (existing) throw new CliError('QR_FILE_EXISTS', 'The QR output file already exists. Choose a new filename.')
    const png = await QRCode.toBuffer(url, { type: 'png', width: 600, margin: 4, errorCorrectionLevel: 'M' })
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(png); await handle.sync() } finally { await handle.close() }
    process.stderr.write(`QR image: ${path}\n`)
  }
}

export async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args
  if (!command || command === 'help' || command === '--help' || command === '-h') { process.stdout.write(HELP); return }
  if (!Object.hasOwn(specs, command)) throw new CliError('USAGE', 'Unknown command. Run pubky-notes --help.')
  let parsed: ReturnType<typeof parseArgs>
  try { parsed = parseArgs({ args: rest, options: { ...specs[command], help: boolOption }, allowPositionals: true, strict: true }) }
  catch { throw new CliError('USAGE', 'Invalid command options. Run pubky-notes --help.') }
  const { values, positionals } = parsed
  if (values.help) { process.stdout.write(HELP); return }
  const string = (key: string) => typeof values[key] === 'string' ? values[key] as string : undefined
  const flag = (key: string) => values[key] === true
  const needsId = ['get', 'update', 'move', 'publish', 'unpublish', 'delete', 'restore'].includes(command)
  const count = needsId || command === 'search' ? 1 : 0
  if (positionals.length !== count) throw new CliError('USAGE', `This command expects ${count} positional argument${count === 1 ? '' : 's'}. Run pubky-notes --help.`)
  const id = positionals[0]
  if (needsId && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new CliError('INVALID_ID', 'Use a note ID returned by list or search.')
  const revision = string('if-revision')
  if (['update', 'move', 'publish', 'unpublish', 'delete', 'restore'].includes(command) && !/^[a-f0-9]{64}$/.test(revision ?? '')) {
    throw new CliError('INVALID_REVISION', 'Read the note with get, then supply its revision with --if-revision.')
  }
  if (command === 'move' && string('folder') === undefined) throw new CliError('USAGE', 'Move requires --folder; use an empty value for Unfiled.')
  const folder = string('folder') === undefined ? undefined : normalizeFolder(string('folder')!)
  const visibility = string('visibility') ?? 'all'
  if (!['all', 'private', 'public'].includes(visibility)) throw new CliError('USAGE', 'Visibility must be all, private, or public.')
  if (command === 'search' && !id.trim()) throw new CliError('USAGE', 'Enter a nonempty search query.')
  const content = await readContent(string('file'), flag('stdin'))
  if (command === 'update' && string('title') === undefined && content === undefined) throw new CliError('USAGE', 'Update requires --title, --file, or --stdin.')
  let result: unknown
  if (command === 'login') {
    const controller = new AbortController()
    const abort = () => controller.abort()
    process.once('SIGINT', abort); process.once('SIGTERM', abort)
    let qrWritten = false
    try {
      result = await login({ force: flag('force'), signal: controller.signal, onQr: async url => { await renderQr(url, string('qr-file')); qrWritten = !!string('qr-file') } })
    } finally {
      process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort)
      if (qrWritten) await unlink(resolve(string('qr-file')!)).catch(() => undefined)
    }
  } else if (command === 'status') result = await status()
  else if (command === 'logout') { await logout(); result = { authenticated: false } }
  else result = await withSession(async session => {
    if (command === 'list' || command === 'search') {
      let notes = await listNotes(session, { trash: command === 'list' && flag('trash') })
      if (command === 'search') {
        const terms = id.trim().toLowerCase().split(/\s+/)
        notes = notes.filter(({ note }) => terms.every(term => `${note.title}\n${note.content}`.toLowerCase().includes(term)))
      } else notes = notes.filter(view => (folder === undefined || folderContains(folder, view.note.folder ?? '')) && (visibility === 'all' || (visibility === 'public' ? !!view.published : !view.published)))
      return notes.map(summary)
    }
    if (command === 'get') return getNote(session, id)
    if (command === 'create') return createNote(session, { title: string('title'), content, folder })
    if (command === 'update') return updateNote(session, id, revision!, { title: string('title'), content })
    if (command === 'move') return updateNote(session, id, revision!, { folder })
    if (command === 'publish') return publishNote(session, id, revision!)
    if (command === 'unpublish') return unpublishNote(session, id, revision!)
    if (command === 'restore') return restoreNote(session, id, revision!)
    await deleteNote(session, id, revision!)
    return { deleted: id, recoverable: true }
  })
  if (['get', 'create', 'update', 'move', 'publish', 'unpublish', 'restore'].includes(command)) result = readableView(result as NoteView)
  if (command === 'get' && flag('markdown')) {
    const note = (result as NoteView).note
    let markdown = `# ${note.title}\n\n${note.content}`
    if (process.stdout.isTTY) markdown = markdown.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    process.stdout.write(markdown)
  } else process.stdout.write(`${json(result)}\n`)
}

export function reportError(error: unknown): void {
  const safe = error instanceof CliError ? error : new CliError('OPERATION_FAILED', 'The operation failed. Check your network and retry; saved credentials have been retained.')
  process.stderr.write(`${json({ error: { code: safe.code, message: safe.message } })}\n`)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) run(process.argv.slice(2)).catch(reportError)
