import { test, expect } from '@playwright/test'

const runRealHermesAcceptance = process.env.E2E_HERMES_REAL === '1'

test.describe('real Hermes chat workflow', () => {
  test.skip(!runRealHermesAcceptance, 'Set E2E_HERMES_REAL=1 for the deployed Hermes acceptance')
  test.setTimeout(240_000)

  const username = process.env.AUTH_USER || 'testadmin'
  const password = process.env.AUTH_PASS || 'testpass1234!'

  test('creates, uses, refreshes, and separates project-bound conversations', async ({ page, request }) => {
    const login = await request.post('/api/auth/login', { data: { username, password } })
    expect(login.status()).toBe(200)
    const setCookie = login.headers()['set-cookie'] || ''
    const match = setCookie.match(/(__Host-)?mc-session=([^;]+)/)
    expect(match).toBeTruthy()
    await page.context().addCookies([{
      name: match?.[1] ? '__Host-mc-session' : 'mc-session',
      value: match?.[2] || '',
      domain: new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:3005').hostname,
      path: '/',
      secure: (process.env.E2E_BASE_URL || '').startsWith('https:') || Boolean(match?.[1]),
    }])

    await page.goto('/chat', { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(1500)
    await expect(page.getByRole('button', { name: '+ New Chat', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '+ New Chat', exact: true }).click()
    await expect(page.getByText('New conversation', { exact: true })).toBeVisible()
    await page.getByLabel('Agent', { exact: true }).selectOption({ label: 'Hermes' })
    const groceryOption = page.locator('#new-chat-project option[value="7"]')
    await expect(groceryOption).toHaveCount(1, { timeout: 60_000 })
    const groceryName = (await groceryOption.textContent())?.trim() || 'Grocery project'
    await page.getByLabel('Project', { exact: true }).selectOption('7')

    const createResponse = page.waitForResponse((response) => response.url().includes('/api/chat/conversations') && response.request().method() === 'POST' && response.status() === 201)
    await page.getByRole('button', { name: 'Start Conversation', exact: true }).click()
    const firstResponse = await createResponse
    const firstPayload = await firstResponse.json()
    expect(firstResponse.status()).toBe(201)
    const firstConversation = firstPayload.conversation as { id: string; project_id: number }
    expect(firstConversation).toBeTruthy()
    expect(firstConversation.project_id).toBe(7)

    const composer = page.getByTestId('chat-composer')
    await expect(composer).toBeEnabled()
    await composer.fill('Reply exactly: CHAT ACCEPTANCE OK')
    await page.getByTitle('Send message').click()
    await expect.poll(() => page.getByText('CHAT ACCEPTANCE OK', { exact: true }).count(), { timeout: 180_000 }).toBeGreaterThanOrEqual(2)

    await composer.fill('What project context are you currently operating in? Reply with the project name.')
    await page.getByTitle('Send message').click()
    await expect(page.getByText(new RegExp(groceryName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'i')).first()).toBeVisible({ timeout: 180_000 })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText(new RegExp(`Hermes · ${groceryName}`))).toBeVisible({ timeout: 30_000 })
    await page.getByText(new RegExp(`Hermes · ${groceryName}`)).first().click()
    await expect.poll(() => page.getByText('CHAT ACCEPTANCE OK', { exact: true }).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)

    await page.getByRole('button', { name: '+ New Chat', exact: true }).click()
    await page.getByLabel('Agent', { exact: true }).selectOption({ label: 'Hermes' })
    await page.getByLabel('Project', { exact: true }).selectOption({ label: 'General' })
    const secondCreateResponse = page.waitForResponse((response) => response.url().includes('/api/chat/conversations') && response.request().method() === 'POST' && response.status() === 201)
    await page.getByRole('button', { name: 'Start Conversation', exact: true }).click()
    const secondConversation = (await (await secondCreateResponse).json()).conversation as { id: string; project_id: number }
    expect(secondConversation.project_id).toBe(1)
    expect(secondConversation.id).not.toBe(firstConversation.id)

    const deniedProjectStatus = await page.evaluate(async () => {
      const response = await fetch('/api/chat/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_name: 'hermes', project_id: 999999 }),
      })
      return response.status
    })
    expect([400, 403]).toContain(deniedProjectStatus)
  })
})
