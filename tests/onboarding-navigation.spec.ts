import { test, expect, type Page } from '@playwright/test'

test.describe('Onboarding and panel navigation', () => {
  test.setTimeout(120_000)
  const username = process.env.AUTH_USER || 'testadmin'
  const password = process.env.AUTH_PASS || 'testpass1234!'
  const browserBaseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:3005'
  const browserBase = new URL(browserBaseUrl)
  const apiBaseUrl = process.env.E2E_API_BASE_URL ? new URL(process.env.E2E_API_BASE_URL) : browserBase
  const apiHeaders = process.env.E2E_API_HOST_HEADER ? { Host: process.env.E2E_API_HOST_HEADER } : undefined
  let sessionCookie: { name: string; value: string } | null = null

  test.beforeAll(async ({ request }) => {
    const login = await request.post(new URL('/api/auth/login', apiBaseUrl).toString(), { data: { username, password }, headers: apiHeaders })
    expect(login.status()).toBe(200)
    const setCookie = login.headers()['set-cookie'] || ''
    const match = setCookie.match(/(__Host-)?mc-session=([^;]+)/)
    expect(match).toBeTruthy()
    sessionCookie = {
      name: match?.[1] ? '__Host-mc-session' : 'mc-session',
      value: match?.[2] || '',
    }
    await request.post(new URL('/api/onboarding', apiBaseUrl).toString(), { data: { action: 'reset' }, headers: apiHeaders })
    await request.post(new URL('/api/onboarding', apiBaseUrl).toString(), { data: { action: 'skip' }, headers: apiHeaders })
  })

  async function authenticate(page: Page) {
    // page.request does not share cookies with the browser context. Install
    // the one fresh, supported login session created in beforeAll.
    expect(sessionCookie).toBeTruthy()
    await page.context().addCookies([{
      name: sessionCookie?.name || 'mc-session',
      value: sessionCookie?.value || '',
      domain: browserBase.hostname,
      path: '/',
      secure: browserBase.protocol === 'https:' || sessionCookie?.name === '__Host-mc-session',
    }])
  }

  test('fresh skipped session keeps the shell usable and Chat commits /chat', async ({ page }) => {
    page.on('pageerror', error => console.log('browser pageerror', error.message))
    await authenticate(page)
    await page.goto('/')
    await expect(page.locator('nav[aria-label="Main navigation"]')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('header')).toBeVisible()
    await expect(page.locator('main')).not.toHaveClass(/pointer-events-none/)
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0)

    const chatLink = page.locator('nav[aria-label="Main navigation"]').getByRole('link', { name: 'Chat', exact: true })
    await chatLink.click()
    await expect(page).toHaveURL(/\/chat$/)
    await expect(page.getByText('Agent Chat', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('main')).not.toHaveClass(/pointer-events-none/)

    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await page.goForward()
    await expect(page).toHaveURL(/\/chat$/)
  })

  test('Settings replay is visible, dismisses cleanly, and does not auto-replay', async ({ page }) => {
    await authenticate(page)
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Replay Onboarding', exact: true }).click()
    await expect(page.locator('[aria-modal="true"]')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: /skip/i }).click()
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0, { timeout: 20_000 })

    const freshPage = await page.context().newPage()
    await authenticate(freshPage)
    await freshPage.goto('/')
    await expect(freshPage.locator('[aria-modal="true"]')).toHaveCount(0, { timeout: 20_000 })
    await freshPage.close()
  })

  for (const route of ['/', '/chat', '/tasks', '/agents', '/memory', '/settings']) {
    test(`direct route ${route} preserves the shell without onboarding`, async ({ page }) => {
      await authenticate(page)
      await page.goto(route)
      await expect(page).toHaveURL(new RegExp(`${route === '/' ? '/$' : `${route}$`}`))
      await expect(page.locator('nav[aria-label="Main navigation"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('header')).toBeVisible()
      await expect(page.locator('[aria-modal="true"]')).toHaveCount(0)
    })
  }
})
