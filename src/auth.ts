import { AuthFlowKind, Pubky } from '@synonymdev/pubky'
import type { Capabilities, Session } from '@synonymdev/pubky'
import { CliError } from './errors.js'
import { SessionState } from './state.js'
import type { StoredSession } from './state.js'

const CLIENT_ID = 'pubky-notes-cli'
const ROOTS = ['/priv/notes/', '/pub/notes/']
const CAPABILITIES = ROOTS.map((path) => `${path}:rw`).join(',') as Capabilities

export interface SessionSummary {
  authenticated: true
  owner: string
  grantExpiresAt: string | null
}
export interface LoginOptions {
  force?: boolean
  onQr: (url: string) => Promise<void>
  signal?: AbortSignal
}

function canceled(): CliError { return new CliError('LOGIN_CANCELLED', 'Login canceled.') }
function invalidSession(error: unknown): boolean {
  const value = error as { name?: string; code?: string; data?: { statusCode?: number } }
  return ['AuthenticationError', 'InvalidInput', 'ClientStateError'].includes(value?.name ?? '') ||
    ['LOGIN_REQUIRED', 'INVALID_SESSION', 'PERMISSION_REQUIRED'].includes(value?.code ?? '') ||
    value?.data?.statusCode === 401 || value?.data?.statusCode === 403
}

function requireCapabilities(capabilities: string[]): void {
  const scopes = capabilities.map((entry) => {
    const separator = entry.lastIndexOf(':')
    return { path: entry.slice(0, separator), actions: entry.slice(separator + 1) }
  })
  // A CLI grant must be separate and limited to the two Notes roots.
  if (scopes.some(({ path, actions }) => !ROOTS.includes(path) || !/^[rw]+$/.test(actions)) ||
      ROOTS.some((root) => ['r', 'w'].some((action) => !scopes.some(({ path, actions }) => path === root && actions.includes(action))))) {
    throw new CliError('PERMISSION_REQUIRED', 'Approve read and write access to /priv/notes/ and /pub/notes/ only. Run pubky-notes login --force.')
  }
}

/** Injectable SDK/state boundary keeps tests independent of a real Ring account. */
export class AuthManager {
  private instance?: Pubky
  constructor(private readonly state = new SessionState(), private readonly makeClient: () => Pubky = () => new Pubky()) {}
  private get client(): Pubky { return this.instance ??= this.makeClient() }

  private async describe(session: Session): Promise<{ summary: SessionSummary; grantId: string }> {
    const grant = session.grant
    if (!grant) throw new CliError('INVALID_SESSION', 'A Pubky Ring grant is required. Run pubky-notes login --force.')
    try {
      const info = await grant.sessionInfo()
      try {
        requireCapabilities(info.capabilities)
        if (info.clientId !== CLIENT_ID) throw new CliError('INVALID_SESSION', 'This session belongs to another application. Run pubky-notes login --force.')
        const expires = info.grantExpiresAt
        if (!Number.isFinite(expires) || expires * 1000 <= Date.now()) throw new CliError('LOGIN_REQUIRED', 'Your Pubky Ring grant expired. Run pubky-notes login.')
        const ownerKey = info.publicKey
        let owner: string
        try { owner = ownerKey.z32() } finally { ownerKey.free() }
        return { summary: { authenticated: true, owner, grantExpiresAt: new Date(expires * 1000).toISOString() }, grantId: info.grantId }
      } finally { info.free() }
    } finally { grant.free() }
  }

  private async restore(saved: StoredSession): Promise<Session> {
    let session: Session
    try { session = await this.client.restoreSession(saved.secret) }
    catch (error) {
      if (invalidSession(error)) throw new CliError('LOGIN_REQUIRED', 'The saved Pubky Ring grant expired or was revoked. Run pubky-notes login.')
      throw error // A network failure must retain the durable secret.
    }
    try {
      const details = await this.describe(session)
      if (details.summary.owner !== saved.owner || details.grantId !== saved.grantId) throw new CliError('INVALID_SESSION', 'The saved session identity does not match. Run pubky-notes login --force.')
      return session
    } catch (error) { session.free(); throw error }
  }

  async withSession<T>(work: (session: Session) => Promise<T>): Promise<T> {
    return this.state.withLock(async () => {
      const saved = await this.state.read()
      if (!saved) throw new CliError('LOGIN_REQUIRED', 'Run pubky-notes login and scan the QR code with Pubky Ring.')
      const session = await this.restore(saved)
      try { return await work(session) } finally { session.free() }
    })
  }

  async status(): Promise<SessionSummary> {
    return this.withSession(async (session) => (await this.describe(session)).summary)
  }

  async login(options: LoginOptions): Promise<SessionSummary> {
    return this.state.withLock(async () => {
      if (options.signal?.aborted) throw canceled()
      let saved: StoredSession | null
      try { saved = await this.state.read() }
      catch (error) {
        if (!options.force || !(error instanceof CliError) || error.code !== 'INVALID_SESSION') throw error
        saved = null
      }
      if (saved && !options.force) {
        let session: Session | undefined
        try {
          session = await this.restore(saved)
          return (await this.describe(session)).summary
        } catch (error) { if (!invalidSession(error)) throw error }
        finally { session?.free() }
      }
      const flow = await this.client.startGrantAuthFlow(CAPABILITIES, AuthFlowKind.signin(), { clientId: CLIENT_ID })
      let wasCanceled = false
      let freed = false
      let candidate: Session | undefined
      let committed = false
      const freeFlow = () => {
        if (!freed) { freed = true; try { flow.free() } catch { /* The SDK may consume this handle. */ } }
      }
      let rejectAbort: (reason: Error) => void = () => undefined
      const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject })
      void abortPromise.catch(() => undefined)
      const abort = () => { wasCanceled = true; freeFlow(); rejectAbort(canceled()) }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      // Observe approval before displaying the QR, including late approval after cancellation.
      const approval = (async () => {
        const approved = await flow.awaitApproval()
        if (wasCanceled) {
          await approved.signout().catch(() => undefined)
          approved.free()
          throw canceled()
        }
        candidate = approved
        return approved
      })()
      void approval.catch(() => undefined)
      try {
        if (wasCanceled) throw canceled()
        await Promise.race([options.onQr(flow.authorizationUrl), abortPromise])
        candidate = await Promise.race([approval, abortPromise])
        const details = await this.describe(candidate)
        const secret = await candidate.exportLocalSecret()
        if (wasCanceled || options.signal?.aborted) throw canceled()
        await this.state.write({ version: 1, secret, owner: details.summary.owner, grantId: details.grantId, grantExpiresAt: details.summary.grantExpiresAt }, options.signal, () => { committed = true })
        committed = true
        // Restoring another grant is safe only when its identifier differs.
        if (saved && saved.grantId !== details.grantId) {
          let previous: Session | undefined
          try { previous = await this.restore(saved); await previous.signout() }
          catch { /* The newly saved grant remains usable if retiring an old grant fails. */ }
          finally { previous?.free() }
        }
        return details.summary
      } catch (error) {
        wasCanceled = true
        if (candidate && !committed) await candidate.signout().catch(() => undefined)
        throw error
      } finally {
        options.signal?.removeEventListener('abort', abort)
        freeFlow()
        candidate?.free()
      }
    }, options.signal)
  }

  async logout(): Promise<void> {
    return this.state.withLock(async () => {
      const saved = await this.state.read()
      if (!saved) return
      let session: Session | undefined
      try {
        session = await this.restore(saved)
        await session.signout()
        await this.state.remove()
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== 'LOGIN_REQUIRED') throw error
        await this.state.remove()
      } finally { session?.free() }
    })
  }
}

const auth = new AuthManager()
export const withSession = <T>(work: (session: Session) => Promise<T>): Promise<T> => auth.withSession(work)
export const login = (options: LoginOptions): Promise<SessionSummary> => auth.login(options)
export const status = (): Promise<SessionSummary> => auth.status()
export const logout = (): Promise<void> => auth.logout()
