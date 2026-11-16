import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'

// argon2id password hashes (D42) with Node's built-in `crypto.argon2`, stored as PHC strings:
// $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>, base64 without padding.
// Parameters are the OWASP minimum for argon2id (19 MiB, 2 passes, 1 lane). A stored hash
// keeps its own parameters, so raising them later only affects new hashes.

const PARAMS = { memory: 19_456, passes: 2, parallelism: 1 }
const SALT_BYTES = 16
const TAG_BYTES = 32

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '')

function derive(
  password: string,
  salt: Buffer,
  p: { memory: number; passes: number; parallelism: number },
  tagLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: password, nonce: salt, tagLength, ...p }, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await derive(password, salt, PARAMS, TAG_BYTES)
  const { memory, passes, parallelism } = PARAMS
  const params = `m=${String(memory)},t=${String(passes)},p=${String(parallelism)}`
  return `$argon2id$v=19$${params}$${b64(salt)}$${b64(hash)}`
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

/** False for a wrong password and for anything that is not an argon2id hash we can read. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = PHC.exec(stored)
  if (!match) return false
  const [m, t, p, salt = '', hash = ''] = match.slice(1)
  const expected = Buffer.from(hash, 'base64')
  if (expected.length < 16) return false
  const params = { memory: Number(m), passes: Number(t), parallelism: Number(p) }
  // Refuse parameters far outside what we write, so a bad row can't exhaust memory.
  if (params.memory > 262_144 || params.passes > 10 || params.parallelism > 8) return false
  try {
    const actual = await derive(password, Buffer.from(salt, 'base64'), params, expected.length)
    return timingSafeEqual(actual, expected)
  } catch {
    // Parameters argon2 itself rejects (salt too short, memory below 8 KiB per lane, ...).
    return false
  }
}

let dummy: Promise<string> | undefined

/**
 * Spends the same time as checking a real password, for sign-ins with an unknown email,
 * so response time doesn't tell whether an account exists.
 */
export async function verifyDummy(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'))
  await verifyPassword(password, await dummy)
  return false
}
