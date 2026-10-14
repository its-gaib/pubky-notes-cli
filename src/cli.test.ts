import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { json, readContent, readableView, run, summary } from './cli.js'
import { CliError } from './errors.js'

test('rejects ambiguous input and unsafe mutations before opening a session', async () => {
  for (const args of [
    ['update', 'id', '--title', 'Changed'],
    ['restore', 'id'],
    ['delete', '../escape', '--if-revision', 'a'.repeat(64)],
    ['move', 'id', '--if-revision', 'a'.repeat(64)],
    ['list', '--visibility', 'everything'],
    ['search', '   '],
    ['status', '--publish'],
    ['create', '--stdin', '--file', 'ignored.md'],
  ]) await assert.rejects(run(args), error => error instanceof CliError)
})

test('file input preserves Markdown and rejects invalid UTF-8 and oversized content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pubky-cli-input-'))
  try {
    const file = join(dir, 'note.md')
    const content = '# Title\n\n  **bold**\n\n`$(not-a-command)`\n'
    await writeFile(file, content)
    assert.equal(await readContent(file, false), content)
    await writeFile(file, Buffer.from([0xc3, 0x28]))
    await assert.rejects(readContent(file, false), { code: 'INPUT_ERROR' })
    await writeFile(file, Buffer.alloc(512 * 1024 + 1, 'x'))
    await assert.rejects(readContent(file, false), { code: 'LIMIT_EXCEEDED' })
    assert.equal(await readContent(undefined, false), undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('JSON output neutralizes terminal controls without altering parsed content', () => {
  const value = { title: '\u001b]52;clipboard\u0007\u009b31m', content: 'Markdown\n**bold**' }
  const output = json(value)
  assert.equal(/[\u001b\u0007\u009b]/.test(output), false)
  assert.deepEqual(JSON.parse(output), value)
})

test('list summaries omit note bodies and public snapshots', () => {
  const note = { id: 'id', title: 'Title', content: 'private body', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', folder: 'Work', crdt: { version: 1 as const, update: 'private history', lineage: 'test' } }
  const output = summary({ note, published: { ...note, content: 'public body' }, revision: 'a'.repeat(64) })
  assert.equal(output.published, true)
  assert.equal('content' in output, false)
  assert.equal(output.folder, 'Work')
  assert.equal('crdt' in output, false)
  assert.equal(json(output).includes('body'), false)
})


test('readable note output hides opaque history while preserving text and revision', () => {
  const note = { id: 'id', title: 'Title', content: 'Visible text', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', crdt: { version: 1 as const, update: 'large private history', lineage: 'test' } }
  const result = readableView({ note, published: null, revision: 'b'.repeat(64) })
  assert.equal(result.note.content, 'Visible text')
  assert.equal(result.revision, 'b'.repeat(64))
  assert.equal('crdt' in result.note, false)
  assert.ok(note.crdt)
})
