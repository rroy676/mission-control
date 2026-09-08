'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'

type Backup = { backup_id: string; created_at: number; provider: string; encrypted_size: number; encrypted_sha256: string; upload_status: string; remote_verification_status: string; restore_verification_status: string; failure_reason?: string | null }
type Policy = { enabled: number; primary_provider: string; encryption_profile_ref: string; retention_count: number; backup_schedule: string; status: string; last_successful_backup?: number | null; last_verified_backup?: number | null; last_restore_test?: number | null; failure_reason?: string | null }

export function BackupRecoveryPanel() {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [backups, setBackups] = useState<Backup[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const load = useCallback(async () => { try { const data = await apiFetch<{ policy: Policy; backups: Backup[] }>('/api/tenant-backups'); setPolicy(data.policy); setBackups(data.backups || []) } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to load backup status') } }, [])
  useEffect(() => { load() }, [load])
  const update = async (body: Record<string, unknown>) => { setBusy(true); setMessage(''); try { await apiFetch('/api/tenant-backups', { method: 'PUT', body: JSON.stringify(body) }); await load() } catch (error) { setMessage(error instanceof Error ? error.message : 'Backup policy update failed') } finally { setBusy(false) } }
  const create = async () => { setBusy(true); setMessage(''); try { const result = await apiFetch<{ backup_id: string }>('/api/tenant-backups', { method: 'POST' }); setMessage(`Verified backup created: ${result.backup_id}`); await load() } catch (error) { setMessage(error instanceof Error ? error.message : 'Backup failed') } finally { setBusy(false) } }
  const verify = async (id: string) => { setBusy(true); setMessage(''); try { await apiFetch(`/api/tenant-backups/${encodeURIComponent(id)}/verify`, { method: 'POST' }); setMessage(`Restore verification passed: ${id}`); await load() } catch (error) { setMessage(error instanceof Error ? error.message : 'Restore verification failed') } finally { setBusy(false) } }
  if (!policy) return <div className="p-6 text-sm text-muted-foreground">Loading backup recovery status…</div>
  return <div className="p-6 space-y-6 max-w-5xl">
    <div><h1 className="text-xl font-semibold">Backup & Recovery</h1><p className="text-sm text-muted-foreground mt-1">Tenant-scoped encrypted backups with independent restore verification.</p></div>
    <div className="grid gap-3 md:grid-cols-3">
      <div className="rounded border border-border p-4"><div className="text-xs text-muted-foreground">Provider</div><div className="mt-1 font-medium">{policy.primary_provider}</div><div className="text-xs text-muted-foreground mt-2">Encryption profile: {policy.encryption_profile_ref}</div></div>
      <div className="rounded border border-border p-4"><div className="text-xs text-muted-foreground">Status</div><div className="mt-1 font-medium">{policy.status}</div><div className="text-xs text-muted-foreground mt-2">Schedule: {policy.backup_schedule}</div></div>
      <div className="rounded border border-border p-4"><div className="text-xs text-muted-foreground">Retention</div><div className="mt-1 font-medium">{policy.retention_count} recovery points</div><div className="text-xs text-muted-foreground mt-2">Latest verified: {formatTime(policy.last_verified_backup)}</div></div>
    </div>
    <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={create}>Create backup now</Button><Button disabled={busy} variant="outline" onClick={() => update({ enabled: policy.enabled ? 0 : 1, backup_schedule: policy.backup_schedule })}>{policy.enabled ? 'Disable policy' : 'Enable policy'}</Button></div>
    {message && <div className="rounded border border-border p-3 text-sm">{message}</div>}
    {policy.failure_reason && <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">Latest failure: {policy.failure_reason}</div>}
    <div className="rounded border border-border overflow-hidden"><div className="px-4 py-3 border-b border-border font-medium">Backup history</div>{backups.length === 0 ? <div className="p-4 text-sm text-muted-foreground">No encrypted tenant backups yet.</div> : <div className="divide-y divide-border">{backups.map((backup) => <div key={backup.backup_id} className="p-4 flex flex-wrap items-center justify-between gap-3"><div><div className="font-mono text-sm">{backup.backup_id}</div><div className="text-xs text-muted-foreground">{formatTime(backup.created_at)} · {backup.encrypted_size} bytes · SHA-256 {backup.encrypted_sha256.slice(0, 16)}…</div></div><div className="flex items-center gap-2 text-xs"><span>{backup.remote_verification_status}</span><span>{backup.restore_verification_status}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => verify(backup.backup_id)}>Verify restore</Button></div></div>)}</div>}</div>
  </div>
}

function formatTime(value?: number | null) { return value ? new Date(value * 1000).toLocaleString() : 'not recorded' }
