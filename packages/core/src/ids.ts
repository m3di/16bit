import { z } from 'zod'

/**
 * Safe as a JSONB key, an object key, and in URLs. `__proto__` passes the character set
 * but would be dropped when assigned to a plain object, so it is rejected by name.
 */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((id) => id !== '__proto__', { message: 'Reserved ID' })
