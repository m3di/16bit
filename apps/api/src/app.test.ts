import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'

describe('api', () => {
  const app = buildApp()
  afterAll(() => app.close())

  it('answers the health check', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })
})
