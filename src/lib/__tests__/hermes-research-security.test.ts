import { describe, expect, it, vi } from 'vitest'
import { normalizeResearchUrl, validatePublicHttpsUrl } from '@/lib/hermes-research'

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
  it('normalizes HTML-escaped query separators before validation', async () => {
    const raw = 'https://epiceries.ca/api?endpoint=search&amp;q=lait&amp;store=metro&amp;limit=5'
    expect(normalizeResearchUrl(raw)).toBe('https://epiceries.ca/api?endpoint=search&q=lait&store=metro&limit=5')
    await expect(validatePublicHttpsUrl(raw, async () => [{ address: '93.184.216.34', family: 4 }])).resolves.toMatchObject({
      protocol: 'https:',
      hostname: 'epiceries.ca',
      search: '?endpoint=search&q=lait&store=metro&limit=5',
    })
  })

  it('keeps protocol and host safety checks after normalization', async () => {
    await expect(validatePublicHttpsUrl('http://epiceries.ca/api?x=1&amp;y=2', async () => [{ address: '93.184.216.34', family: 4 }])).rejects.toThrow()
    await expect(validatePublicHttpsUrl('https://localhost/api?x=1&amp;y=2', async () => [{ address: '127.0.0.1', family: 4 }])).rejects.toThrow()
  })

})
