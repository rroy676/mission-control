'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useMissionControl, type Tenant } from '@/store'
import { Button } from '@/components/ui/button'

interface CatalogEntry { provider_id: string; model_id: string; display_name: string; enabled_globally: boolean; promotional_free: boolean; promotional_expires_at: number | null }
interface Profile { id: number; provider_id: string; model_id: string; purpose: string; scope: string; agent_id: number | null; enabled: boolean; priority: number; credential_ref: string | null; fallback_profile_id: number | null; promotional_free: boolean; promotional_expires_at: number | null }
interface Agent { id: number; name: string }

export function ModelProfilesPanel() {
  const { activeTenant } = useMissionControl()
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [providerModel, setProviderModel] = useState('')
  const [scope, setScope] = useState<'tenant-default' | 'agent-override'>('tenant-default')
  const [agentId, setAgentId] = useState('')
  const [credentialRef, setCredentialRef] = useState('')
  const [fallbackId, setFallbackId] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [catalogData, profileData, agentData] = await Promise.all([
        apiFetch<{ catalog?: CatalogEntry[] }>('/api/model-catalog'),
        apiFetch<{ profiles?: Profile[] }>('/api/model-profiles'),
        apiFetch<{ agents?: Agent[] }>('/api/agents'),
      ])
      setCatalog(catalogData.catalog || [])
      setProfiles(profileData.profiles || [])
      setAgents(agentData.agents || [])
      if (!providerModel && catalogData.catalog?.[0]) setProviderModel(`${catalogData.catalog[0].provider_id}/${catalogData.catalog[0].model_id}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Model configuration unavailable')
    }
  }, [providerModel])

  useEffect(() => { void load() }, [load, activeTenant?.tenant_key])

  async function save() {
    const [provider, ...modelParts] = providerModel.split('/')
    try {
      await apiFetch('/api/model-profiles', {
        method: 'POST',
        body: JSON.stringify({ provider_id: provider, model_id: modelParts.join('/'), scope, purpose: scope === 'agent-override' ? 'general' : 'general', agent_id: scope === 'agent-override' ? Number(agentId) : null, credential_ref: credentialRef || null, fallback_profile_id: fallbackId ? Number(fallbackId) : null }),
      })
      setMessage('Model profile saved')
      await load()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save model profile') }
  }

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Model Profiles</h1>
        <p className="text-sm text-muted-foreground mt-1">Tenant-scoped configuration for {activeTenant?.display_name || 'the active tenant'}. No provider secrets are stored here.</p>
      </div>
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-sm">Provider / model
            <select value={providerModel} onChange={(e) => setProviderModel(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2">
              {catalog.filter((m) => m.enabled_globally).map((model) => <option key={`${model.provider_id}/${model.model_id}`} value={`${model.provider_id}/${model.model_id}`}>{model.display_name} · {model.provider_id}/{model.model_id}{model.promotional_free ? ' · promotional' : ''}</option>)}
            </select>
          </label>
          <label className="text-sm">Scope
            <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2">
              <option value="tenant-default">Tenant default</option><option value="agent-override">Agent override</option>
            </select>
          </label>
          {scope === 'agent-override' && <label className="text-sm">Agent
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2"><option value="">Select an agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
          </label>}
          <label className="text-sm">Credential reference (metadata only)
            <input value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)} placeholder="tenant/provider/primary" className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" />
          </label>
          <label className="text-sm">Fallback profile
            <select value={fallbackId} onChange={(e) => setFallbackId(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2"><option value="">No fallback</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>#{profile.id} {profile.provider_id}/{profile.model_id}</option>)}</select>
          </label>
        </div>
        <Button onClick={save} disabled={!providerModel || (scope === 'agent-override' && !agentId)}>Save profile</Button>
        {message && <span className="ml-3 text-sm text-muted-foreground">{message}</span>}
      </section>
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium mb-3">Active tenant profiles</h2>
        {profiles.length === 0 ? <p className="text-sm text-muted-foreground">No tenant profile configured. The resolver fails safely until an authorized profile is added.</p> : <div className="space-y-2">{profiles.map((profile) => <div key={profile.id} className="flex flex-wrap items-center gap-2 text-sm"><span className="font-mono">#{profile.id}</span><span>{profile.provider_id}/{profile.model_id}</span><span className="text-muted-foreground">{profile.scope} · {profile.purpose}</span><span className={profile.enabled ? 'text-green-400' : 'text-muted-foreground'}>{profile.enabled ? 'enabled' : 'disabled'}</span>{profile.promotional_free && <span className="text-amber-400">promotional/free</span>}{profile.fallback_profile_id && <span className="text-muted-foreground">→ #{profile.fallback_profile_id}</span>}</div>)}</div>}
      </section>
    </div>
  )
}
