import test from 'node:test'
import assert from 'node:assert/strict'
import { noteUrl, parsePublicLink, readPublicNote, WEB_ORIGIN } from './note-links.js'
import { MAX_NOTE_BYTES } from './notes.js'

const owner = 'xnd6zy7oqmnb5dropo1eo4qqdkm57ogzyzhizd49xzm691f1q9ny'
const id = 'note-1'
const fixture = { id, title: 'A public note', content: '**Public text**', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' }

test('note links use stable web paths and accept browser public and legacy routes', () => {
  assert.equal(noteUrl(owner, id), `${WEB_ORIGIN}/pubky${owner}/priv/notes/${id}.json`)
  const address = `pubky${owner}/pub/notes/${id}.json`
  for (const url of [noteUrl(owner, id, 'public'), `https://custom.example/?owner=${owner}&note=${id}`, `pubky://${owner}/pub/notes/${id}.json`]) {
    assert.deepEqual(parsePublicLink(url), { owner, id, address })
  }
})

test('private, ambiguous, encoded, arbitrary and credential-bearing links fail before network access', async () => {
  for (const url of [
    noteUrl(owner, id), `https://example.com/?owner=${owner}&owner=${owner}&note=${id}`,
    `https://example.com/pubky${owner}/pub/notes/note%2D1.json`,
    `https://example.com/pubky${owner}/pub/notes/${id}.json?note=other`,
    `https://user:password@example.com/pubky${owner}/pub/notes/${id}.json`,
    `https://example.com/pubky${owner}/pub/notes/${id}.json#collaborate=secret`,
    `pubky://${owner}/priv/notes/${id}.json`, `file:///pubky${owner}/pub/notes/${id}.json`,
    'https://127.0.0.1/private', `https://example.com/?owner=${owner}&note=../escape`,
  ]) {
    await assert.rejects(readPublicNote(url, { get: async () => assert.fail('invalid link must not fetch') }), { code: 'INVALID_LINK' })
  }
})

test('public reading resolves the Pubky address and returns only public snapshot fields', async () => {
  const result = await readPublicNote(noteUrl(owner, id, 'public'), { get: async address => {
    assert.equal(address, `pubky${owner}/pub/notes/${id}.json`)
    return new Response(JSON.stringify({ ...fixture, folder: 'Private-looking metadata', deleted: true }))
  } })
  assert.deepEqual(result, { owner, url: noteUrl(owner, id, 'public'), note: fixture })
  await assert.rejects(readPublicNote(noteUrl(owner, id, 'public'), { get: async () => new Response(JSON.stringify({ ...fixture, id: 'other' })) }), { code: 'INVALID_NOTE' })
  await assert.rejects(readPublicNote(noteUrl(owner, id, 'public'), { get: async () => new Response('x'.repeat(MAX_NOTE_BYTES + 1)) }), { code: 'LIMIT_EXCEEDED' })
})
