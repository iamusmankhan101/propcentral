import { useState } from 'react'
import { useApi, fmtParts } from './api.js'

const pct = n => (n == null ? '—' : n + '%')

// Leads rolled up by the campaign and form they arrived from (Facebook/Instagram lead forms)
export default function Campaigns() {
  const [d, , error] = useApi('/campaigns')
  if (error) return <p className="error">{error}</p>
  const meta = useApi('/campaigns/meta')[0]
  const rows = (d?.rows || []).filter(r => !(meta?.known_names?.includes(String(r.campaign).toLowerCase())))
  return (
    <section>
      <MetaCampaigns d={meta} />
      <h3>Other lead sources</h3>
      <div className="row between">
        <h2>Campaigns {d && <span className="count">{rows.length}</span>}</h2>
        {d?.page_name && <span className="muted">Facebook page: <b>{d.page_name}</b></span>}
      </div>
      {!d ? <p className="muted pad">Loading…</p> : (
        <div className="card scroll">
          <table>
            <thead><tr><th>Campaign</th><th>Form ID</th><th>Source</th><th>Project</th><th>Leads</th><th>Open</th><th>Won</th><th>Conversion</th><th>Last lead</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={(r.campaign ?? '') + '\u0000' + (r.form_id ?? '')}>
                  <td><b>{r.campaign || '—'}</b></td>
                  <td>{r.form_id || '—'}</td>
                  <td>{r.source || '—'}</td>
                  <td>{r.project || '—'}</td>
                  <td>{r.leads}</td>
                  <td>{r.open}</td>
                  <td>{r.won}</td>
                  <td>{pct(r.conversion)}</td>
                  <td className="nowrap">{fmtParts(r.last_lead_at)[0]}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan="9" className="muted">No campaign leads yet. Leads from your Facebook lead forms appear here with their campaign and form.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// Active Meta campaigns first; click one to see its leads
function MetaCampaigns({ d }) {
  const [open, setOpen] = useState()
  const [leads] = useApi(open ? '/leads?size=200&campaign=' + encodeURIComponent(open.id) : null)
  if (!d) return <p className="muted pad">Loading Meta campaigns…</p>
  if (!d.connected || d.error) return <p className="muted pad">{d.reason || d.error} <a href="#/settings?tab=facebook">Settings › Facebook</a></p>
  const rows = [...d.rows].sort((a, b) => b.active - a.active)
  return (
    <>
      <h2>Meta campaigns <span className="count">{rows.filter(r => r.active).length} active</span></h2>
      <div className="card scroll">
        <table>
          <thead><tr><th>Campaign</th><th>Status</th><th>Objective</th><th>Spend</th><th>Leads</th><th>Won</th><th>Conversion</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} onClick={() => setOpen(open?.id === r.id ? null : r)} style={{ cursor: 'pointer' }}>
                <td><b>{r.name}</b></td>
                <td><span style={r.active ? { color: 'var(--up, green)', fontWeight: 600 } : undefined}>{r.active ? 'Active' : r.effective_status}</span></td>
                <td>{r.objective || '—'}</td>
                <td>{r.spend == null ? '—' : `${r.currency} ${r.spend.toLocaleString()}`}</td>
                <td>{r.leads}</td><td>{r.won}</td><td>{pct(r.conversion)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="7" className="muted">No campaigns in your ad accounts.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && (
        <div className="card scroll">
          <h3 className="pad">Leads: {open.name}</h3>
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Agent</th><th>Created</th></tr></thead>
            <tbody>
              {(leads?.rows || []).map(l => <tr key={l.id}><td><a href={`#/leads/${l.id}`}>{l.name}</a></td><td>{l.phone}</td><td>{l.status}</td><td>{l.agent_name || '—'}</td><td className="nowrap">{fmtParts(l.created_at)[0]}</td></tr>)}
              {leads && !leads.rows.length && <tr><td colSpan="5" className="muted">No leads yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
