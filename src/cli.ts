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
import { getNoteHistory, getNoteVersion, restoreNoteVersion } from './notes.js'
import { createFolder, deleteFolder, listFolders, renameFolder } from './folder-store.js'
import { exportMarkdown, importMarkdown, writeMarkdownFile } from './markdown.js'
import { noteUrl, parsePublicLink, readPublicNote } from './note-links.js'
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
  pubky-notes folders
  pubky-notes mkdir PATH
  pubky-notes rename-folder SOURCE DESTINATION --if-revision HASH
  pubky-notes move-folder PATH --folder PARENT --if-revision HASH
  pubky-notes rmdir PATH --if-revision HASH
  pubky-notes history ID
  pubky-notes version ID VERSION [--changes|--markdown]
  pubky-notes restore-version ID VERSION --if-revision HASH
  pubky-notes import [FILE|--stdin] [--title TITLE] [--folder PATH]
  pubky-notes export ID [--output FILE]
  pubky-notes link ID [--visibility private|public]
  pubky-notes read-public URL [--markdown]

Output is JSON unless --markdown is requested. New notes are private.
Get a note first and pass its revision when modifying an existing note.
Search covers all titles and Markdown content. Folder paths use /.
Use the revision from folders for rename-folder, move-folder, and rmdir.
Directory moves include descendants. Only empty directories can be removed.
Exports go to stdout, or exclusively create --output FILE (never overwrite).
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
  folders: {}, mkdir: {}, 'rename-folder': revisionOption,
  'move-folder': { folder: textOption, ...revisionOption }, rmdir: revisionOption,
  history: {}, version: { changes: boolOption, markdown: boolOption }, 'restore-version': revisionOption,
  import: { stdin: boolOption, title: textOption, folder: textOption }, export: { output: textOption },
  link: { visibility: textOption }, 'read-public': { markdown: boolOption },
}

export function json(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function summary(view: NoteView) {
  const { content: _content, crdt: _crdt, ...note } = view.note
  return { ...note, published: !!view.published,
    publicChanged: !!view.published && (view.published.title !== view.note.title || view.published.content !== view.note.content),
    revision: view.revision }
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

export async function run(args: string[], sessionRunner: typeof withSession = withSession): Promise<void> {
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
  const needsId = ['get', 'update', 'move', 'publish', 'unpublish', 'delete', 'restore', 'history', 'version', 'restore-version', 'export', 'link'].includes(command)
  const folderCommand = ['mkdir', 'rename-folder', 'move-folder', 'rmdir'].includes(command)
  const count = ['version', 'restore-version', 'rename-folder'].includes(command) ? 2
    : command === 'import' ? (flag('stdin') ? 0 : 1)
    : needsId || folderCommand || ['search', 'read-public'].includes(command) ? 1 : 0
  if (positionals.length !== count) throw new CliError('USAGE', `This command expects ${count} positional argument${count === 1 ? '' : 's'}. Run pubky-notes --help.`)
  const id = positionals[0]
  if (needsId && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new CliError('INVALID_ID', 'Use a note ID returned by list or search.')
  const revision = string('if-revision')
  if (['update', 'move', 'publish', 'unpublish', 'delete', 'restore', 'restore-version', 'rename-folder', 'move-folder', 'rmdir'].includes(command) && !/^[a-f0-9]{64}$/.test(revision ?? '')) {
    throw new CliError('INVALID_REVISION', folderCommand ? 'Run folders, then supply its revision with --if-revision.' : 'Read the note with get, then supply its revision with --if-revision.')
  }
  if (['move', 'move-folder'].includes(command) && string('folder') === undefined) throw new CliError('USAGE', 'Move requires --folder; use an empty value for the top level.')
  const folder = string('folder') === undefined ? undefined : normalizeFolder(string('folder')!)
  const visibility = string('visibility') ?? (command === 'link' ? 'private' : 'all')
  if (!(command === 'link' ? ['private', 'public'] : ['all', 'private', 'public']).includes(visibility)) throw new CliError('USAGE', command === 'link' ? 'Link visibility must be private or public.' : 'Visibility must be all, private, or public.')
  if (command === 'search' && !id.trim()) throw new CliError('USAGE', 'Enter a nonempty search query.')
  if (folderCommand && !normalizeFolder(id)) throw new CliError('INVALID_FOLDER', 'Choose a named folder.')
  if (command === 'rename-folder' && !normalizeFolder(positionals[1])) throw new CliError('INVALID_FOLDER', 'Choose a named destination folder.')
  if (['version', 'restore-version'].includes(command) && !/^(?:initial|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(positionals[1])) throw new CliError('INVALID_VERSION', 'Use a version ID returned by history.')
  if (command === 'version' && flag('changes') && flag('markdown')) throw new CliError('USAGE', 'Choose either --changes or --markdown.')
  if (command === 'read-public') parsePublicLink(id)
  if (command === 'export' && string('output') === '') throw new CliError('USAGE', 'Choose a nonempty export filename.')
  const content = await readContent(command === 'import' ? (flag('stdin') ? undefined : id) : string('file'), flag('stdin'))
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
  else if (command === 'read-public') result = await readPublicNote(id)
  else result = await sessionRunner(async session => {
    if (command === 'folders') return listFolders(session)
    if (command === 'mkdir') return createFolder(session, id)
    if (command === 'rename-folder') return renameFolder(session, id, positionals[1], revision!)
    if (command === 'move-folder') {
      const source = normalizeFolder(id)
      return renameFolder(session, source, [folder, source.split('/').at(-1)].filter(Boolean).join('/'), revision!)
    }
    if (command === 'rmdir') return deleteFolder(session, id, revision!)
    if (command === 'list' || command === 'search') {
      let notes = await listNotes(session, { trash: command === 'list' && flag('trash') })
      if (command === 'search') {
        const terms = id.trim().toLowerCase().split(/\s+/)
        notes = notes.filter(({ note }) => terms.every(term => `${note.title}\n${note.content}`.toLowerCase().includes(term)))
      } else notes = notes.filter(view => (folder === undefined || folderContains(folder, view.note.folder ?? '')) && (visibility === 'all' || (visibility === 'public' ? !!view.published : !view.published)))
      return notes.map(summary)
    }
    if (command === 'get') return getNote(session, id)
    if (command === 'history') return getNoteHistory(session, id)
    if (command === 'version') return getNoteVersion(session, id, positionals[1], flag('changes'))
    if (command === 'restore-version') return restoreNoteVersion(session, id, positionals[1], revision!)
    if (command === 'import') return createNote(session, { ...importMarkdown(content!, flag('stdin') ? undefined : id, string('title')), folder })
    if (command === 'export') {
      const view = await getNote(session, id)
      const markdown = exportMarkdown(view.note)
      return string('output') === undefined ? { markdown } : { id, ...await writeMarkdownFile(string('output')!, markdown) }
    }
    if (command === 'link') {
      const view = await getNote(session, id)
      if (visibility === 'public' && !view.published) throw new CliError('NOT_PUBLISHED', 'This note has no public snapshot. Publish it explicitly before requesting a public link.')
      return { id, visibility, url: noteUrl(session.info.publicKey.z32(), id, visibility as 'private' | 'public') }
    }
    if (command === 'create') return createNote(session, { title: string('title'), content, folder })
    if (command === 'update') return updateNote(session, id, revision!, { title: string('title'), content })
    if (command === 'move') return updateNote(session, id, revision!, { folder })
    if (command === 'publish') return publishNote(session, id, revision!)
    if (command === 'unpublish') return unpublishNote(session, id, revision!)
    if (command === 'restore') return restoreNote(session, id, revision!)
    await deleteNote(session, id, revision!)
    return { deleted: id, recoverable: true }
  })
  if (['get', 'create', 'update', 'move', 'publish', 'unpublish', 'restore', 'restore-version', 'import'].includes(command)) result = readableView(result as NoteView)
  if ((['get', 'read-public', 'version'].includes(command) && flag('markdown')) || (command === 'export' && string('output') === undefined)) {
    let markdown = command === 'export' ? (result as { markdown: string }).markdown
      : command === 'version' ? exportMarkdown(result as { title: string; content: string })
      : exportMarkdown((result as { note: { title: string; content: string } }).note)
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
