'use client'

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'

type Status = any

export function CompanyObservabilityPanel() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const [control, setControl] = useState('')
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let active = true
    const load = async () => {
      try { const next = await apiFetch<Status>('/api/autonomous-company'); if (active) { setStatus(next); setError('') } }
      catch { if (active) setError('Company status unavailable') }
    }
    load()
    const timer = window.setInterval(load, 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  if (error) return <div className="p-6 text-sm text-muted-foreground">{error}</div>
  if (!status) return <div className="p-6 text-sm text-muted-foreground">Loading company status…</div>
  const gates = Object.entries(status.blueprint || {})
  const pause = async () => {
    setPending(true); setControl('PAUSE request pending…')
    try { const result = await apiFetch<any>('/api/autonomous-company/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause', requested_by: 'CEO', reason: 'CEO requested PAUSE from Mission Control', request_id: `mc-${crypto.randomUUID()}` }) }); setControl(result.allow && result.equivalence ? 'PAUSE accepted by reference; authority is PAUSED' : `PAUSE shadow result: ${result.reason_code || 'rejected'}`) }
    catch (e: any) { setControl(`PAUSE failed: ${e?.message || 'Hermes unavailable'}`) }
    finally { setPending(false); setTimeout(() => window.location.reload(), 500) }
  }
  return <div className="space-y-6 p-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-semibold">Company Observability</h1><p className="text-xs text-muted-foreground">Bounded operational view · updated {status.generated_at || 'UNKNOWN'}</p></div><div className="flex items-center gap-3"><span className="rounded border border-border px-3 py-2 text-sm">Authority: <strong>{status.company?.dispatch_mode || 'UNKNOWN'}</strong></span><button className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={pending || status.company?.dispatch_mode === 'PAUSED'} onClick={pause}>{pending ? 'Pausing…' : 'PAUSE'}</button></div></div>
    {control && <div className="rounded border border-border bg-card p-3 text-sm">{control}</div>}
    <div className="grid gap-3 md:grid-cols-4">
      {gates.map(([key, value]) => <div key={key} className="rounded border border-border bg-card p-4"><div className="text-xs uppercase text-muted-foreground">{key}</div><div className="mt-1 text-2xl font-semibold">{String(value)}</div></div>)}
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Company"><Rows data={status.company} /></Card>
      <Card title="Engineering"><Rows data={status.engineering} /></Card>
      <Card title="Product Operations"><Rows data={status.product_ops} /></Card>
      <Card title="Backup / DR and Finance"><Rows data={{ ...status.backup_dr, ...status.finance }} /></Card>
    </div>
    <Card title="Projects and agents"><Rows data={{ projects: status.projects?.map((p: any) => `${p.name} · ${p.repository}`).join(' | '), agents: status.agents?.map((a: any) => `${a.name} (${a.role})`).join(' | '), policy: status.policy?.mode }} /></Card>
  </div>
}

function Card({ title, children }: { title: string; children: React.ReactNode }) { return <section className="rounded border border-border bg-card p-4"><h2 className="mb-3 font-medium">{title}</h2>{children}</section> }
function Rows({ data }: { data: Record<string, unknown> }) { return <dl className="space-y-2 text-sm">{Object.entries(data).map(([key, value]) => <div key={key} className="flex justify-between gap-4 border-b border-border/50 pb-1"><dt className="text-muted-foreground">{key.replaceAll('_', ' ')}</dt><dd className="max-w-[65%] text-right">{typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'UNKNOWN')}</dd></div>)}</dl> }
