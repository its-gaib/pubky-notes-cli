import { PublicKey, PublicStorage } from '@synonymdev/pubky'
import type { Address } from '@synonymdev/pubky'
import { CliError } from './errors.js'
import { readBoundedJson, validateNote } from './notes.js'

export const WEB_ORIGIN = 'https://pubky-notes.vercel.app'
const ID = /^[a-zA-Z0-9_-]{1,80}$/
const OWNER = /^(?:pubky)?[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/

function canonicalOwner(owner: string): string {
  if (!OWNER.test(owner)) throw new CliError('INVALID_LINK', 'Use a valid Pubky Notes owner identifier.')
  try {
    const key = PublicKey.from(owner)
    try { return key.z32() } finally { key.free() }
  } catch { throw new CliError('INVALID_LINK', 'Use a valid Pubky Notes owner identifier.') }
}

export function noteUrl(owner: string, id: string, visibility: 'private' | 'public' = 'private'): string {
  if (!ID.test(id)) throw new CliError('INVALID_ID', 'Invalid note ID.')
  return `${WEB_ORIGIN}/pubky${canonicalOwner(owner)}/${visibility === 'public' ? 'pub' : 'priv'}/notes/${id}.json`
}

/** Parse a known route; never fetch an arbitrary HTTP URL supplied as a note link. */
export function parsePublicLink(value: string): { owner: string; id: string; address: Address } {
  let owner: string | undefined, id: string | undefined
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) throw new Error()
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      const match = /^\/([^/]+)\/pub\/notes\/([a-zA-Z0-9_-]{1,80})\.json$/.exec(url.pathname)
      if (match && !url.searchParams.has('owner') && !url.searchParams.has('note')) [, owner, id] = match
      else if (url.pathname === '/' && url.searchParams.getAll('owner').length === 1 && url.searchParams.getAll('note').length === 1) {
        owner = url.searchParams.get('owner')!; id = url.searchParams.get('note')!
      }
    } else if (url.protocol === 'pubky:' && !url.search) {
      const match = /^\/pub\/notes\/([a-zA-Z0-9_-]{1,80})\.json$/.exec(url.pathname)
      if (match) { owner = url.hostname; id = match[1] }
    }
  } catch { /* Return the same error for every invalid route. */ }
  if (!owner || !id || !ID.test(id)) throw new CliError('INVALID_LINK', 'Use a public Pubky Notes link; private and arbitrary storage paths are not supported.')
  owner = canonicalOwner(owner)
  return { owner, id, address: `pubky${owner}/pub/notes/${id}.json` as Address }
}

export async function readPublicNote(value: string, storage?: Pick<PublicStorage, 'get'>) {
  const link = parsePublicLink(value)
  const client = storage ?? new PublicStorage()
  try {
    const note = validateNote(await readBoundedJson(await client.get(link.address)), link.id)
    // Public output is always the public snapshot, never server-supplied private metadata.
    return { owner: link.owner, url: noteUrl(link.owner, link.id, 'public'), note: {
      id: note.id, title: note.title, content: note.content, createdAt: note.createdAt, updatedAt: note.updatedAt,
    } }
  } finally { if (!storage) (client as PublicStorage).free() }
}
