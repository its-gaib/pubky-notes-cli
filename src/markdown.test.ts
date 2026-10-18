import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportMarkdown, importMarkdown, writeMarkdownFile } from './markdown.js'

test('Markdown import/export matches browser title extraction without duplicate headings', () => {
  const note = { title: 'Meeting notes', content: '**Decisions**\n\n- [ ] Follow up\n' }
  assert.deepEqual(importMarkdown(exportMarkdown(note), 'export.md'), note)
  assert.deepEqual(importMarkdown('# Windows heading\r\n\r\nBody', 'export.md'), { title: 'Windows heading', content: 'Body' })
  assert.deepEqual(importMarkdown('Body\n# Later heading', '/tmp/Vault/Idea.MARKDOWN'), { title: 'Idea', content: 'Body\n# Later heading' })
  assert.deepEqual(importMarkdown('# Original\n\nBody', undefined, 'Override'), { title: 'Override', content: 'Body' })
  assert.deepEqual(importMarkdown('Body'), { title: 'Untitled note', content: 'Body' })
  assert.equal(importMarkdown('Body', 'x'.repeat(201)).title.length, 200)
  assert.equal(exportMarkdown({ title: '', content: '' }), '# Untitled note\n\n')
})

test('explicit export preserves bytes privately and refuses existing files or symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pubky-markdown-export-'))
  try {
    const output = join(directory, 'note.md')
    const markdown = '# Private\n\n$(literal)\n\u001b[31m'
    assert.deepEqual(await writeMarkdownFile(output, markdown), { file: output })
    assert.equal(await readFile(output, 'utf8'), markdown)
    assert.equal((await stat(output)).mode & 0o777, 0o600)
    await assert.rejects(writeMarkdownFile(output, 'replace'), { code: 'OUTPUT_EXISTS' })
    assert.equal(await readFile(output, 'utf8'), markdown)
    const target = join(directory, 'target')
    await writeFile(target, 'untouched')
    const link = join(directory, 'link.md')
    await symlink(target, link)
    await assert.rejects(writeMarkdownFile(link, 'replace'), { code: 'OUTPUT_EXISTS' })
    assert.equal(await readFile(target, 'utf8'), 'untouched')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
