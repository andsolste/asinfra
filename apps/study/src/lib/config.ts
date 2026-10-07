export function readSupabaseConfig(url?: string, key?: string) {
  if (!url?.trim() || !key?.trim()) return null
  try {
    const parsed = new URL(url.trim())
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    if (parsed.username || parsed.password || parsed.search || parsed.hash
      || !(parsed.protocol === 'https:' || (local && parsed.protocol === 'http:'))
      || !key.trim().startsWith('sb_publishable_')) return null
    return { url: url.trim(), key: key.trim() }
  } catch {
    return null
  }
}
