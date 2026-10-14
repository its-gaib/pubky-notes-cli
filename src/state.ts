import { constants, renameSync } from 'node:fs'
import { open, mkdir, lstat, realpath, chmod, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CliError } from './errors.js'

export interface StoredSession {
  version: 1
  secret: string
  owner: string
  grantId: string
  grantExpiresAt: string | null
}

export function stateDirectory(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  if (!isAbsolute(base)) throw new CliError('UNSAFE_STATE', 'XDG_STATE_HOME must be an absolute path.')
  return join(resolve(base), 'pubky-notes-cli')
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function stateError(): CliError {
  return new CliError('UNSAFE_STATE', 'The session storage must be owned by your user, private, and free of symbolic links.')
}

/** The lock file is permanent: unlinking it would permit two independent locks. */
export class SessionState {
  constructor(readonly directory = stateDirectory()) {}
  private get credentials(): string { return join(this.directory, 'session.json') }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || await realpath(this.directory) !== resolve(this.directory)) throw stateError()
    await chmod(this.directory, 0o700)
  }

  private async checkFile(file: FileHandle, privateMode = true): Promise<void> {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (privateMode && (stat.mode & 0o077) !== 0)) throw stateError()
  }

  async withLock<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (process.platform !== 'linux') throw new CliError('UNSUPPORTED_PLATFORM', 'Session locking currently requires Linux with util-linux flock installed.')
    await this.ensureDirectory()
    let file: FileHandle
    try {
      file = await open(join(this.directory, 'session.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw stateError()
      throw error
    }
    try {
      await this.checkFile(file)
      if (signal?.aborted) throw new CliError('LOGIN_CANCELLED', 'Login canceled.')
      // flock operates on the inherited open-file description. Node retains it
      // after the helper exits; close or process death releases the kernel lock.
      await new Promise<void>((accept, reject) => {
        const child = spawn('/usr/bin/flock', ['--exclusive', '--timeout', '30', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', file.fd], signal,
        })
        child.once('error', (error: NodeJS.ErrnoException) => {
          reject(error.name === 'AbortError'
            ? new CliError('LOGIN_CANCELLED', 'Login canceled.')
            : new CliError('LOCK_UNAVAILABLE', 'Install util-linux flock to protect the saved session across commands.'))
        })
        child.once('exit', (code) => {
          if (signal?.aborted) reject(new CliError('LOGIN_CANCELLED', 'Login canceled.'))
          else if (code === 0) accept()
          else reject(new CliError('LOCK_BUSY', 'Another Pubky Notes command is using the session. Wait for it to finish, then retry.'))
        })
      })
      return await work()
    } finally { await file.close() }
  }

  async read(): Promise<StoredSession | null> {
    let file: FileHandle
    try { file = await open(this.credentials, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (missing(error)) return null
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw stateError()
      throw error
    }
    try {
      await this.checkFile(file)
      if ((await file.stat()).size > 1024 * 1024) throw new CliError('INVALID_SESSION', 'The saved session is invalid. Run pubky-notes login --force.')
      let data: unknown
      try { data = JSON.parse(await file.readFile('utf8')) }
      catch { throw new CliError('INVALID_SESSION', 'The saved session is invalid. Run pubky-notes login --force.') }
      const value = data as Partial<StoredSession> | null
      if (!value || value.version !== 1 || typeof value.secret !== 'string' || !value.secret || typeof value.owner !== 'string' || typeof value.grantId !== 'string' || !(value.grantExpiresAt === null || typeof value.grantExpiresAt === 'string')) {
        throw new CliError('INVALID_SESSION', 'The saved session is invalid. Run pubky-notes login --force.')
      }
      return value as StoredSession
    } finally { await file.close() }
  }

  async write(value: StoredSession, signal?: AbortSignal, onCommitted?: () => void): Promise<void> {
    // Check the destination without parsing it: --force can repair malformed JSON.
    let existing: FileHandle | undefined
    try {
      existing = await open(this.credentials, constants.O_RDONLY | constants.O_NOFOLLOW)
      await this.checkFile(existing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw stateError()
      if (!missing(error)) throw error
    } finally { await existing?.close() }
    const temporary = join(this.directory, `.session-${randomUUID()}.tmp`)
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await file.writeFile(JSON.stringify(value) + '\n', 'utf8')
      await file.sync()
      await file.close()
      if (signal?.aborted) throw new CliError('LOGIN_CANCELLED', 'Login canceled.')
      // The final check and atomic commit cannot be interrupted by a JS signal handler.
      renameSync(temporary, this.credentials)
      onCommitted?.()
      try {
        const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await directory.sync() } finally { await directory.close() }
      } catch {
        throw new CliError('SESSION_SAVE_UNCERTAIN', 'The session was saved, but disk durability could not be confirmed. Run pubky-notes status before signing in again.')
      }
    } finally {
      await file.close().catch(() => undefined)
      await unlink(temporary).catch((error) => { if (!missing(error)) throw error })
    }
  }

  async remove(): Promise<void> {
    await this.read()
    await unlink(this.credentials).catch((error) => { if (!missing(error)) throw error })
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
  }
}
