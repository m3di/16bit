// DEV_ANONYMOUS_AS_OWNER and its startup guard (D41). M0 only: removed with real auth in M1.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export type DevAnonymousCheck =
  { enabled: false } | { enabled: true; warning: string } | { enabled: true; error: string }

/**
 * Whether requests without a key may act as the dev owner, and whether the server may start.
 * The flag is refused on a non-loopback HOST unless DEV_ANONYMOUS_ALLOW_NONLOCAL=1 says the
 * port is published to loopback only, as compose does for the container that binds 0.0.0.0.
 */
export function checkDevAnonymous(env: NodeJS.ProcessEnv, host: string): DevAnonymousCheck {
  if (env['DEV_ANONYMOUS_AS_OWNER'] !== 'true') return { enabled: false }
  if (!LOOPBACK.has(host) && env['DEV_ANONYMOUS_ALLOW_NONLOCAL'] !== '1') {
    return {
      enabled: true,
      error:
        `api: refusing to start: DEV_ANONYMOUS_AS_OWNER=true gives owner access to anyone who ` +
        `can reach HOST=${host}. Bind to 127.0.0.1, or set DEV_ANONYMOUS_ALLOW_NONLOCAL=1 only ` +
        `if the port is published to loopback alone (as compose.yaml does).`,
    }
  }
  return {
    enabled: true,
    warning:
      `api: WARNING: DEV_ANONYMOUS_AS_OWNER is on. Requests without a key act as the dev ` +
      `owner. Local use only, never in a deployment.`,
  }
}
