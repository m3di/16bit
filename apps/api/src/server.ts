import { buildApp } from './app.ts'

const port = Number(process.env['PORT'] ?? 3000)
const host = process.env['HOST'] ?? '127.0.0.1'

const app = buildApp()

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`api received ${signal}, closing`)
  try {
    await app.close()
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

// `once`: a second signal falls through to the default handler and exits at once.
process.once('SIGINT', (signal) => void shutdown(signal))
process.once('SIGTERM', (signal) => void shutdown(signal))

try {
  const address = await app.listen({ port, host })
  console.log(`api listening on ${address}`)
} catch (error) {
  console.error(error)
  process.exit(1)
}
