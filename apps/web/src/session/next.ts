import type { LocationQueryValue } from 'vue-router'

/** Paths that make no sense to return to after signing in. */
const SKIP = ['/sign-in']

/**
 * The `next` query of the sign-in page as a path in this app, or `/`. Only same-origin paths
 * are kept, so a crafted link can't send someone elsewhere after they sign in.
 */
export function safeNext(value: LocationQueryValue | LocationQueryValue[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/'
  // Browsers read a backslash as a slash, so `/\evil.example` is protocol-relative too.
  if (raw.includes('\\') || hasControlCharacter(raw)) return '/'
  let url: URL
  try {
    url = new URL(raw, 'http://app.invalid')
  } catch {
    return '/'
  }
  if (url.origin !== 'http://app.invalid') return '/'
  // `/.//host` normalises to `//host`, which a browser would read as another origin.
  if (url.pathname.startsWith('//') || SKIP.includes(url.pathname)) return '/'
  return `${url.pathname}${url.search}${url.hash}`
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 0x20) return true
  return false
}
