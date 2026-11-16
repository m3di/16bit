import fastifyStatic from '@fastify/static'
import { relative, sep } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

// Serves the built web app from the API process, so one image serves both (D34).

/** Vite fingerprints everything under assets/, so those files never change at a given URL. */
const IMMUTABLE = 'public, max-age=31536000, immutable'

export function registerWeb(app: FastifyInstance, root: string): void {
  void app.register(fastifyStatic, {
    root,
    cacheControl: false,
    setHeaders: (reply: FastifyReply, path: string) => {
      const immutable = relative(root, path).startsWith(`assets${sep}`)
      void reply.header('cache-control', immutable ? IMMUTABLE : 'no-cache')
    },
  })
}

/** A browser navigation the client router handles: answered with index.html, not a 404. */
export function isAppRoute(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const path = request.url.split('?', 1)[0] ?? ''
  if (path === '/health' || path === '/v1' || path.startsWith('/v1/')) return false
  // A missing file such as /assets/old.js stays a 404, so a stale tab does not get HTML as JS.
  if (/\.[a-z0-9]+$/i.test(path)) return false
  return (request.headers.accept ?? '').includes('text/html')
}

export function sendAppShell(reply: FastifyReply): FastifyReply {
  void reply.header('cache-control', 'no-cache')
  return reply.sendFile('index.html')
}
