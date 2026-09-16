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
  const continuationControl = async (taskId: number, action: 'enable' | 'disable' | 'continue_once') => {
    setPending(true); setControl(`${action} pending…`)
    try {
      await apiFetch('/api/hermes/continuation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: taskId, action }) })
      setControl(`Continuation ${action} accepted`)
      window.setTimeout(() => window.location.reload(), 500)
    } catch (e: any) { setControl(`${action} failed: ${e?.message || 'request failed'}`) }
    finally { setPending(false) }
  }
  return <div className="space-y-6 p-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-semibold">Company Observability</h1><p className="text-xs text-muted-foreground">Bounded operational view · updated {status.generated_at || 'UNKNOWN'}</p></div><div className="flex items-center gap-3"><span className="rounded border border-border px-3 py-2 text-sm">Authority: <strong>{status.company?.dispatch_mode || 'UNKNOWN'}</strong></span><button className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={pending || status.company?.dispatch_mode === 'PAUSED'} onClick={pause}>{pending ? 'Pausing…' : 'PAUSE'}</button></div></div>
    {control && <div className="rounded border border-border bg-card p-3 text-sm">{control}</div>}
    <div className="grid gap-3 md:grid-cols-4">
      {gates.map(([key, value]) => <div key={key} className="rounded border border-border bg-card p-4"><div className="text-xs uppercase text-muted-foreground">{key}</div><div className="mt-1 text-2xl font-semibold">{String(value)}</div></div>)}
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Hermes COO"><Rows data={{ state: status.hermes_coo?.state, current_task: status.hermes_coo?.current?.task_id, current_project: status.hermes_coo?.current?.project_id, started_at: status.hermes_coo?.current?.started_at, last_heartbeat: status.hermes_coo?.current?.heartbeat_at, last_activity: status.hermes_coo?.current?.last_meaningful_activity, next_task: status.hermes_coo?.next?.title, completed_today: status.hermes_coo?.completed_today, blocked_tasks: status.hermes_coo?.blocked?.length || 0, approvals_waiting: status.hermes_coo?.approvals?.length || 0, provider: status.hermes_coo?.current?.provider_id, model: status.hermes_coo?.current?.model_id, input_tokens: status.hermes_coo?.current?.input_tokens, output_tokens: status.hermes_coo?.current?.output_tokens, cost_usd: status.hermes_coo?.current?.cost_usd, recent_outputs: status.hermes_coo?.recent_outputs?.length || 0 }} /></Card>
      <Card title="Autonomous continuation"><div className="space-y-3">{(status.hermes_coo?.continuations || []).length === 0 && <p className="text-sm text-muted-foreground">No task-level continuation controls configured.</p>}{(status.hermes_coo?.continuations || []).map((row: any) => <div key={row.task_id} className="rounded border border-border/50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">Task {row.task_id} · {row.enabled ? 'ON' : 'OFF'}</span><span className="text-xs text-muted-foreground">{row.continuation_state}</span></div><div className="mt-2 grid gap-1 text-xs text-muted-foreground md:grid-cols-3"><span>Sequence: {row.automatic_runs} / {row.max_automatic_runs}</span><span>Tokens: {row.cumulative_input_tokens + row.cumulative_output_tokens}</span><span>No-progress: {row.consecutive_no_progress} / {row.max_consecutive_no_progress}</span></div><div className="mt-2 text-xs">Last outcome: {row.last_outcome || 'none'} · Next run: {row.next_run_at ? new Date(row.next_run_at * 1000).toLocaleString() : 'none'}{row.stop_reason ? ` · ${row.stop_reason}` : ''}</div><div className="mt-3 flex gap-2"><button className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" disabled={pending || Boolean(row.enabled)} onClick={() => continuationControl(row.task_id, 'enable')}>ENABLE</button><button className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" disabled={pending || !row.enabled} onClick={() => continuationControl(row.task_id, 'disable')}>DISABLE</button><button className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" disabled={pending} onClick={() => continuationControl(row.task_id, 'continue_once')}>CONTINUE ONCE</button></div></div>)}</div></Card>
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
