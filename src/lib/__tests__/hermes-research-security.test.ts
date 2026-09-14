import { describe, expect, it, vi } from 'vitest'
import { validatePublicHttpsUrl } from '@/lib/hermes-research'

describe('Hermes bounded research URL policy', () => {
  it('allows public HTTPS and rejects unsafe schemes/hosts', async () => {
    await expect(validatePublicHttpsUrl('https://example.com/docs', async () => [{ address: '93.184.216.34', family: 4 }])).resolves.toBeInstanceOf(URL)
    await expect(validatePublicHttpsUrl('http://example.com', async () => [{ address: '93.184.216.34', family: 4 }])).rejects.toThrow()
    await expect(validatePublicHttpsUrl('file:///etc/passwd', async () => [{ address: '93.184.216.34', family: 4 }])).rejects.toThrow()
    await expect(validatePublicHttpsUrl('https://localhost', async () => [{ address: '127.0.0.1', family: 4 }])).rejects.toThrow()
    await expect(validatePublicHttpsUrl('https://internal.example', async () => [{ address: '192.168.1.10', family: 4 }])).rejects.toThrow(/Private/)
  })

  it('fails closed when DNS resolves to a private address', async () => {
    await expect(validatePublicHttpsUrl('https://evil.example', async () => [{ address: '10.0.0.5', family: 4 }])).rejects.toThrow()
  })
})
