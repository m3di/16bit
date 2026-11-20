import type { FastifyInstance, FastifyRequest } from 'fastify'
import { hashAgentSecret } from '../auth/agent-key.ts'
import { requireIdentity } from '../auth/auth.ts'
import { HttpError } from '../http.ts'
import { MAX_SOCKETS_PER_SESSION, type Feed, type FeedCredential } from './feed.ts'

// `GET /v1/workspaces/:workspaceId/feed` (D57). Everything an HTTP route checks happens before
// the upgrade and fails as a plain HTTP error: authentication and D49 (the `/v1` auth hook), the
// workspace (the workspace scope's preHandler, 404), and here the origin of a cookie upgrade and
// the per-session socket cap. Only then does the socket open.

function credentialOf(request: FastifyRequest): FeedCredential {
  const identity = requireIdentity(request)
  if (identity.kind === 'person') {
    return {
      kind: 'session',
      sessionIdHash: identity.sessionIdHash,
      accountId: identity.accountId,
    }
  }
  // The auth hook accepted this bearer token; keep only its hash for the periodic check.
  const bearer = /^Bearer (.+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? ''
  return { kind: 'agent', keyHash: hashAgentSecret(bearer), principalId: identity.principalId }
}

/**
 * A browser attaches the session cookie to a WebSocket upgrade from any page, and the upgrade is
 * not subject to CORS, so a cookie upgrade must name an `Origin` whose host is this one's. An
 * agent sends its key in `Authorization` and no cookie; it needs no `Origin`.
 */
function checkOrigin(request: FastifyRequest): void {
  if (request.identity?.kind !== 'person') return
  const origin = request.headers.origin
  let host: string | null = null
  try {
    host = origin ? new URL(origin).host : null
  } catch {
    host = null
  }
  if (host === null || host !== request.host) {
    throw new HttpError('forbidden', 'Cross-origin feed connection refused')
  }
}

export function registerFeedRoute(ws: FastifyInstance, feed: Feed): void {
  ws.route({
    method: 'GET',
    url: '/feed',
    // After the `/v1` auth hook (401, and 400 for D49), before the workspace check.
    onRequest: async (request) => {
      checkOrigin(request)
    },
    preHandler: async (request) => {
      if (feed.socketCount(credentialOf(request)) >= MAX_SOCKETS_PER_SESSION) {
        throw new HttpError(
          'rate_limited',
          `At most ${String(MAX_SOCKETS_PER_SESSION)} feed connections per session`,
        )
      }
    },
    handler: async (_request, reply) =>
      reply
        .status(426)
        .header('upgrade', 'websocket')
        .send({ error: 'invalid_request', message: 'The feed is a WebSocket: send an upgrade' }),
    wsHandler: (socket, request) => {
      feed.accept(socket, {
        // Parsed and checked by the workspace scope's preHandler.
        workspaceId: (request.params as { workspaceId: string }).workspaceId,
        principal: request.principal,
        credential: credentialOf(request),
      })
    },
  })
}
