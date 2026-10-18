import { basename, resolve } from 'node:path'
import { open } from 'node:fs/promises'
import { CliError } from './errors.js'

/** Match the browser importer without changing create --file's verbatim input. */
export function importMarkdown(content: string, filename?: string, title?: string): { title: string; content: string } {
  const heading = content.match(/^# (.+)\r?\n/)
  return {
    title: (title ?? heading?.[1] ?? (filename ? basename(filename).replace(/\.(md|markdown|txt)$/i, '') : 'Untitled note')).slice(0, 200),
    content: heading ? content.slice(heading[0].length).replace(/^\r?\n/, '') : content,
  }
}

export function exportMarkdown(note: { title: string; content: string }): string {
  return `# ${note.title || 'Untitled note'}\n\n${note.content}`
}

/** An explicit destination is exclusive: never follow a symlink or overwrite a file. */
export async function writeMarkdownFile(destination: string, markdown: string): Promise<{ file: string }> {
  const file = resolve(destination)
  try {
    const handle = await open(file, 'wx', 0o600)
    try { await handle.writeFile(markdown, 'utf8'); await handle.sync() }
    finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('OUTPUT_EXISTS', 'The export destination already exists. Choose a new filename.')
    throw new CliError('OUTPUT_ERROR', 'Could not write the Markdown export. Inspect the destination before retrying.')
  }
  return { file }
}
