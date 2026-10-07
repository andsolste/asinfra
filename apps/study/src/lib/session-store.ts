import type { SessionCommand, SessionSnapshot, createSessionApi } from './study-sessions.ts'
import { sessionStatus } from './study-sessions.ts'

type Api = ReturnType<typeof createSessionApi>
type State = {
  current: SessionSnapshot | null; saved: SessionSnapshot | null
  loaded: boolean; busy: boolean; error: string | null; pending: SessionCommand | null
  clockOffset: number
}
const failure = { start: 'starte', pause: 'pause', resume: 'fortsette', stop: 'stoppe' }

// Shared by the hook and tests. State changes only after a confirmed server reply.
// Keep an uncertain command's UUIDs for safe retries; never persist a local timer.
export function createSessionStore(api: Api) {
  let state: State = { current: null, saved: null, loaded: false, busy: false, error: null, pending: null, clockOffset: 0 }
  let request: AbortController | null = null
  let connected = false
  const listeners = new Set<() => void>()
  function update(values: Partial<State>) { state = { ...state, ...values }; listeners.forEach(listener => listener()) }
  function accept(snapshot: SessionSnapshot | null) {
    update({ current: snapshot && sessionStatus(snapshot) !== 'finished' ? snapshot : null,
      ...(snapshot && sessionStatus(snapshot) === 'finished' ? { saved: snapshot } : {}),
      clockOffset: snapshot ? Date.parse(snapshot.server_time) - Date.now() : 0,
      loaded: true, error: null, pending: null })
  }
  async function run(operation: (signal: AbortSignal) => Promise<SessionSnapshot | null>, error: string) {
    if (!connected || request) return
    const controller = new AbortController()
    request = controller
    const timeout = setTimeout(() => controller.abort(), 15000)
    update({ busy: true, error: null })
    try {
      const result = await operation(controller.signal)
      if (request === controller) accept(result)
    } catch {
      if (request === controller) update({ error })
    } finally {
      clearTimeout(timeout)
      if (request === controller) { request = null; update({ busy: false }) }
    }
  }
  async function refresh() {
    const pending = state.pending
    await run(async signal => {
      // A lost Stop response may mean there is no active session anymore.
      // Confirm and show its saved totals before discarding the pending request.
      if (pending?.action === 'stop') {
        const stopped = await api.load(signal, pending.sessionId)
        if (stopped && sessionStatus(stopped) === 'finished') update({ saved: stopped })
      }
      return api.load(signal)
    }, 'Kunne ikke hente økten. Prøv igjen.')
  }
  async function dispatch(command: SessionCommand) {
    if (request || !connected || !state.loaded || state.pending) return
    update({ pending: command })
    await run(signal => api.transition(command, signal), `Kunne ikke ${failure[command.action]} økten. Prøv igjen.`)
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    connect() { connected = true; void refresh() },
    disconnect() { connected = false; request?.abort(); request = null },
    refresh, dispatch,
    async retry() {
      const command = state.pending
      if (command) await run(signal => api.transition(command, signal), `Kunne ikke ${failure[command.action]} økten. Prøv igjen.`)
      else await refresh()
    },
  }
}
