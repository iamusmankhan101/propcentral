import { WaPanel } from './WhatsApp.jsx'
import { PhoneCallsCard } from './PhoneCalls.jsx'
import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, fmt, toIso, pkr, phone, go } from './api.js'
import { Select, Status, LeadFields, packCustom } from './Leads.jsx'

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <button type="button" className="ghost mini-btn" onClick={copy} title={`Copy ${text}`}>
      {copied ? '✓ Copied' : label}
    </button>
  )
}

export default function Lead({ id }) {
  const m = useMeta()
  const [data, reload, loadError] = useApi('/leads/' + id)
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return <p className="muted">Loading…</p>
  const { lead, activities, visits, other_leads, units } = data
  const closed = m.settings.closed_statuses.includes(lead.status)
  const masked = lead.phone?.includes('*')

  return (
    <section>
      <div className="back-nav">
        <a className="button soft back-btn" href="#/leads">
          ← Back to leads
        </a>
      </div>
      <div className="row between lead-header">
        <div>
          <h2>{lead.name} <Status s={lead.status} /></h2>
          <p className="muted">
            #{lead.id} · {lead.source}{lead.campaign && ` / ${lead.campaign}`}{lead.adset && ` / ${lead.adset}`}{lead.ad && ` / ${lead.ad}`}
            {' '}· score {lead.score} · {lead.agent_name ? `owner ${lead.agent_name}` : 'unassigned'} · created {fmt(lead.created_at)}
          </p>
        </div>
        <div className="row">
          <span className="phone">{phone(lead.phone)}</span>
          {!masked && <CopyButton text={lead.phone} label="Copy phone" />}
          {!masked && <a className="button" href={'tel:+' + lead.phone}>Call</a>}
          {!masked && <a className="button ghost" href={'https://wa.me/' + lead.phone} target="_blank" rel="noreferrer">WhatsApp</a>}
        </div>
      </div>

      {lead.pending_status && <Pending lead={lead} reload={reload} />}

      <div className="cols">
        <div>
          <LogActivity lead={lead} closed={closed} reload={reload} />
          <h3>Timeline</h3>
          <ul className="timeline card">
            {activities.map(a => (
              <li key={a.id} className={a.type === 'system' ? 'sys' : ''}>
                <div>{a.type !== 'system' && <b>{a.type.replace('_', ' ')}{a.amount && ` · PKR ${pkr(a.amount)}`}</b>}{a.outcome && ` · ${a.outcome}`} <small className="muted">{a.user_name || 'System'} · {fmt(a.created_at)}</small></div>
                {a.notes && <div>{a.notes}</div>}
                {a.next_action_at && <small className="muted">Next: {a.next_action || 'follow up'} on {fmt(a.next_action_at)}</small>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          {m.wa?.connected && <WaPanel leadId={lead.id} onActivity={reload} />}
          <PhoneCallsCard leadId={lead.id} />
          <ChangeStatus lead={lead} reload={reload} />
          {!closed && <RecordOffer lead={lead} units={units} reload={reload} />}
          {m.can('reassign') && <Reassign lead={lead} reload={reload} />}
          <ScheduleVisit lead={lead} reload={reload} />
          {visits.length > 0 && (
            <div className="card">
              <h3>Visits</h3>
              {visits.map(v => <p key={v.id}>{v.site} · {fmt(v.scheduled_at)} · <b className={v.status === 'verified' ? 'ok' : 'warn'}>{v.status}</b></p>)}
              <a href="#/visits">Open visits →</a>
            </div>
          )}
          {units.length > 0 && (
            <div className="card">
              <h3>Units</h3>
              {units.map(u => <p key={u.id}><a href={'#/projects/' + u.project_id}>{u.project} {u.block && `· ${u.block} `}#{u.unit_no}</a> <span className={'status u-' + u.status.toLowerCase().replace(/\s/g, '-')}>{u.status}</span>{u.hold_until && <small className="muted"> until {fmt(u.hold_until)}</small>}{u.allotment_id && <> · <a href={'#/allotments/' + u.allotment_id}>{u.allotment_no}</a> · <a href={'#/ledger/' + u.allotment_id}>ledger</a></>}</p>)}
            </div>
          )}
          {other_leads.length > 0 && (
            <div className="card">
              <h3>Other leads of this contact</h3>
              {other_leads.map(o => <p key={o.id}><a href={'#/leads/' + o.id}>#{o.id}</a> {o.lead_type} · {o.project || '—'} · <Status s={o.status} /></p>)}
            </div>
          )}
          <Details lead={lead} reload={reload} />
          {m.can('delete') && <DeleteLead lead={lead} />}
        </div>
      </div>
    </section>
  )
}

function DeleteLead({ lead }) {
  const { run, error, busy } = useAction()
  const del = () => confirm(`Delete the lead for ${lead.name}? It leaves the lists, dashboards and agent counts, and the app cannot undo it.`) && run(async () => {
    await api('/leads/' + lead.id, { method: 'DELETE' })
    go('/leads')
  })
  return (
    <div className="card">
      <h3>Danger zone</h3>
      <p className="muted">Marking a lead Lost or Junk keeps it in your reports. Delete is for entries that should never have existed — duplicate numbers, test submissions, wrong contacts.</p>
      <button className="ghost danger" onClick={del} disabled={busy}>Delete lead</button>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function Pending({ lead, reload }) {
  const m = useMeta()
  const { run, error } = useAction()
  const decide = approve => run(async () => { await api(`/leads/${lead.id}/approve`, { body: { approve } }); reload() })
  return (
    <div className="card banner">
      <b>Pending approval:</b> mark as {lead.pending_status}. {lead.pending_reason}
      {m.can('approve_lost') && <span className="row"><button onClick={() => decide(true)}>Approve</button><button className="ghost" onClick={() => decide(false)}>Reject</button></span>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function LogActivity({ lead, closed, reload }) {
  const { settings: s } = useMeta()
  const { run, error, busy } = useAction()
  const [type, setType] = useState('call')
  const [nextAt, setNextAt] = useState('')
  const submit = e => {
    const form = e.target
    const body = formData(e)
    run(async () => {
      await api(`/leads/${lead.id}/activities`, { body: { ...body, next_action_at: toIso(body.next_action_at) } })
      form.reset(); setType('call'); setNextAt(''); reload()
    })
  }
  const setQuickDate = hours => {
    const d = new Date(Date.now() + hours * 3600e3)
    d.setMinutes(0, 0, 0)
    const pad = n => String(n).padStart(2, '0')
    setNextAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`)
  }
  const needsNext = !closed && type !== 'note'
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">Log activity</h3>
      <label>Type<Select name="type" value={type} onChange={e => setType(e.target.value)} options={s.activity_types} blank={null} /></label>
      <label>Outcome<Select name="outcome" options={s.outcomes} /></label>
      <label className="wide">Notes<textarea name="notes" rows="2" /></label>
      <label>Next action<input name="next_action" placeholder="e.g. send payment plan" /></label>
      <label className="wide">
        Next follow-up {needsNext && '*'}
        <input name="next_action_at" type="datetime-local" value={nextAt} onChange={e => setNextAt(e.target.value)} required={needsNext} />
        <span className="row presets">
          <small className="muted">Quick:</small>
          <button type="button" className="ghost mini-btn" onClick={() => setQuickDate(24)}>Tomorrow</button>
          <button type="button" className="ghost mini-btn" onClick={() => setQuickDate(48)}>In 2 days</button>
          <button type="button" className="ghost mini-btn" onClick={() => setQuickDate(168)}>Next week</button>
        </span>
      </label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide"><button disabled={busy}>Save activity</button></div>
    </form>
  )
}

function ChangeStatus({ lead, reload }) {
  const m = useMeta()
  const s = m.settings
  const [status, setStatus] = useState(lead.status)
  const { run, error, busy } = useAction()
  const needsReason = s.approval_statuses.includes(status)
  const submit = e => {
    const body = formData(e)
    run(async () => { await api(`/leads/${lead.id}/status`, { body: { ...body, status } }); reload() })
  }
  return (
    <form className="card" onSubmit={submit}>
      <h3>Status</h3>
      <Select value={status} onChange={e => setStatus(e.target.value)} options={s.statuses} blank={null} />
      {needsReason && (
        <>
          <label>Reason *<Select name="reason" options={s.lost_reasons} required /></label>
          <label>Note *<textarea name="note" rows="2" required /></label>
          {!m.can('approve_lost') && <p className="muted">Needs approval from your team lead.</p>}
        </>
      )}
      {error && <p className="error">{error}</p>}
      <button disabled={busy || status === lead.status}>{needsReason && !m.can('approve_lost') ? 'Request' : 'Update'}</button>
    </form>
  )
}

function RecordOffer({ lead, units, reload }) {
  const { run, error, busy } = useAction()
  const submit = e => {
    const form = e.target, body = formData(e)
    run(async () => { await api(`/leads/${lead.id}/offers`, { body }); form.reset(); reload() })
  }
  return (
    <form className="card" onSubmit={submit}>
      <h3>Record offer</h3>
      <div className="row">
        <Select name="by" options={['Client', 'Company']} blank={null} />
        <input name="amount" type="number" min="1" placeholder="Amount (PKR) *" required style={{ flex: 1 }} />
      </div>
      <Select name="unit" options={units.map(u => `${u.project} ${u.block ? u.block + ' ' : ''}#${u.unit_no}`)} blank="Unit (optional)" />
      <input name="notes" placeholder="Terms, e.g. 30% down, rest in 2 years" />
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>Save offer</button>
    </form>
  )
}

function Reassign({ lead, reload }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const agents = m.users.filter(u => u.active && ['agent', 'team_lead'].includes(u.role) && u.id !== lead.agent_id
    && (m.me.role !== 'team_lead' || u.team_id === m.me.team_id) && (m.me.role !== 'branch_manager' || u.branch_id === m.me.branch_id))
  const submit = e => {
    const form = e.target
    const body = formData(e)
    run(async () => { await api(`/leads/${lead.id}/assign`, { body }); form.reset(); reload() })
  }
  return (
    <form className="card" onSubmit={submit}>
      <h3>Reassign</h3>
      <Select name="agent_id" options={agents.map(u => [u.id, u.name + (u.available ? '' : ' (unavailable)')])} required />
      <input name="reason" placeholder="Reason (required)" required />
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>Reassign</button>
    </form>
  )
}

function ScheduleVisit({ lead, reload }) {
  const { settings: s } = useMeta()
  const { run, error, busy } = useAction()
  const submit = e => {
    const form = e.target
    const body = formData(e)
    run(async () => {
      await api(`/leads/${lead.id}/visits`, { body: { ...body, scheduled_at: toIso(body.scheduled_at), transport: !!body.transport } })
      form.reset(); reload()
    })
  }
  return (
    <form className="card" onSubmit={submit}>
      <h3>Schedule site visit</h3>
      <Select name="site" options={s.sites.map(x => x.name)} required />
      <input name="scheduled_at" type="datetime-local" required />
      <label className="check"><input name="transport" type="checkbox" /> Transport arranged</label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>Schedule</button>
    </form>
  )
}

function Details({ lead, reload }) {
  const { run, error, busy } = useAction()
  const [saved, setSaved] = useState(false)
  const submit = e => {
    const body = packCustom(formData(e))
    run(async () => { await api('/leads/' + lead.id, { method: 'PATCH', body }); setSaved(true); reload() })
  }
  return (
    <form className="card grid" onSubmit={submit} onChange={() => setSaved(false)}>
      <h3 className="wide">Details <small className="muted">budget {pkr(lead.budget_min)}–{pkr(lead.budget_max)}</small></h3>
      <label>Name<input name="name" defaultValue={lead.name} required /></label>
      <label>Email<input name="email" type="email" defaultValue={lead.email} /></label>
      {!lead.phone.includes('*') && <label>Alternate phones<input name="alt_phones" defaultValue={lead.alt_phones} /></label>}
      <label>CNIC<input name="cnic" defaultValue={lead.cnic} pattern="\d{5}-?\d{7}-?\d" placeholder="35202-1234567-1" /></label>
      <LeadFields lead={lead} />
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Save details</button>{saved && <span className="ok">Saved</span>}</div>
    </form>
  )
}
