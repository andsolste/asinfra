import { useEffect, useState, useSyncExternalStore } from 'react'
import { supabase } from '../lib/supabase'
import { createSessionApi } from '../lib/study-sessions'
import { createSessionStore } from '../lib/session-store'

export function useStudySession() {
  const [store] = useState(() => createSessionStore(createSessionApi(supabase!)))
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => {
    store.connect()
    const refresh = () => { if (document.visibilityState === 'visible') void store.refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      store.disconnect()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [store])
  return { ...state, dispatch: store.dispatch, retry: store.retry, reload: store.refresh }
}
