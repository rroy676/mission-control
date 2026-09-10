import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('onboarding/navigation integration contract', () => {
  it('keeps the shell mounted and uses an explicit visible loading surface', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/[[...panel]]/page.tsx'), 'utf8')
    const wizard = readFileSync(join(process.cwd(), 'src/components/onboarding/onboarding-wizard.tsx'), 'utf8')

    expect(page).toContain('<NavRail />')
    expect(page).toContain('<HeaderBar />')
    expect(page).toContain('aria-hidden={showOnboarding}')
    expect(wizard).toContain('Loading onboarding…')
    expect(wizard).toContain('role="dialog" aria-modal="true"')
    expect(wizard).not.toContain('if (!mounted || !showOnboarding || !state) return null')
  })

  it('keeps panel navigation URL-driven and preserves browser history', () => {
    const navigation = readFileSync(join(process.cwd(), 'src/lib/navigation.ts'), 'utf8')
    expect(navigation).toContain('router.push(href, { scroll: false })')
    expect(navigation).not.toContain('startTransition')
  })

  it('retains an explicit Settings replay action', () => {
    const settings = readFileSync(join(process.cwd(), 'src/components/panels/settings-panel.tsx'), 'utf8')
    expect(settings).toContain("body: JSON.stringify({ action: 'reset' })")
    expect(settings).toContain('setShowOnboarding(true)')
  })
})
