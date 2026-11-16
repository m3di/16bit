import { safeHref } from './rich-text.ts'

export interface UrlDisplay {
  /** Safe to put in an href, or null when the value is not a web or mail address. */
  href: string | null
  /** What the reader sees: no scheme, no `www.`, no trailing slash. */
  text: string
}

/** How a URL value is shown. Unsafe or unparsable values stay as plain text, never a link. */
export function displayUrl(value: string): UrlDisplay {
  const href = safeHref(value)
  if (!href) return { href: null, text: value.trim() }
  const url = new URL(href)
  if (url.protocol === 'mailto:') return { href, text: decodeURIComponent(url.pathname) }
  const host = url.host.replace(/^www\./, '')
  const rest = `${url.pathname}${url.search}${url.hash}`.replace(/\/$/, '')
  return { href, text: `${host}${rest}` }
}
