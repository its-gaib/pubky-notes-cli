import { CliError } from './errors.js'

export function normalizeFolder(input: string): string {
  if (typeof input !== 'string' || /[\\\u0000-\u001f\u007f-\u009f]/u.test(input)) {
    throw new CliError('INVALID_FOLDER', 'Folder names cannot contain backslashes or control characters.')
  }
  const trimmed = input.trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed) return ''
  const segments = trimmed.split('/').map((segment) => segment.trim())
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new CliError('INVALID_FOLDER', 'Folder names cannot be empty, ".", or "..". Separate names with a single slash.')
  }
  const path = segments.join('/')
  if (path.length > 512 || segments.length > 8 || segments.some((segment) => segment.length > 80)) {
    throw new CliError('INVALID_FOLDER', 'Folder paths allow 8 levels, 80 characters per name, and 512 characters total.')
  }
  return path
}

export function folderContains(parent: string, path: string): boolean {
  const normalizedParent = normalizeFolder(parent)
  const normalizedPath = normalizeFolder(path)
  return normalizedPath === normalizedParent ||
    (normalizedParent !== '' && normalizedPath.startsWith(`${normalizedParent}/`))
}

