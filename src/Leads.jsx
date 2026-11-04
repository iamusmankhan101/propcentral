import { useRef, useState } from 'react'
import { api, useApi, useMeta, useAction, formData, fmt, fmtParts, go, download, downloadBlob, phone } from './api.js'
import { parseCsv } from '../server/lib.js'
import * as XLSX from 'xlsx'

export const When = ({ d, className }) => {
  const [day, time] = fmtParts(d)
  return <td className={['when', className].filter(Boolean).join(' ')}><span>{day}</span><small>{time}</small></td>
}

export const Select = ({ name, options, value, onChange, blank = '', required, defaultValue }) => (
  <select name={name} value={value} onChange={onChange} required={required} defaultValue={defaultValue}>
    {blank !== null && <option value="">{blank || 'Select…'}</option>}
    {options.map(o => (Array.isArray(o) ? <option key={o[0]} value={o[0]}>{o[1]}</option> : <option key={o}>{o}</option>))}
  </select>
)
export const Status = ({ s }) => <span className={'status s-' + s.toLowerCase().replace(/\s/g, '-')}>{s}</span>

const FILTERS = [['', 'All'], ['overdue', 'Overdue follow-ups'], ['untouched', 'Untouched (stale)'], ['pending', 'Pending approval'], ['unassigned', 'Unassigned'], ['recycle', 'Recycle pool']]

export default function Leads({ query }) {
  const m = useMeta()
  const params = new URLSearchParams(query)
  const [f, setF] = useState({ filter: params.get('filter') || '', q: params.get('q') || '', status: params.get('status') || '', project: '', source: '', agent_id: '', page: 0 })
  const [view, setView] = useState(() => { try { return params.get('view') || localStorage.leadsView || 'board' } catch { return 'board' } })
  const board = view === 'board'
  const pick = v => { setView(v); try { localStorage.leadsView = v } catch { /* private mode */ } }
  const qs = new URLSearchParams(Object.entries(board ? { ...f, status: '', page: '', size: 500 } : f).filter(([, v]) => v !== '')).toString()
  const [data, reload] = useApi('/leads?' + qs)
  const [adding, setAdding] = useState(params.has('new'))
  const set = k => e => setF({ ...f, [k]: e.target.value, page: 0 })
  const agents = m.users.filter(u => u.role === 'agent' && u.active).map(u => [u.id, u.name])
  const hasFilters = !!(f.q || f.filter || (!board && f.status) || f.source || f.project || f.agent_id)
  const clearFilters = () => setF({ filter: '', q: '', status: '', project: '', source: '', agent_id: '', page: 0 })

  return (
    <section>
      <div className="row between">
        <h2>All leads {data && <span className="count">{data.total}</span>}</h2>
        <div className="row">
          <div className="seg small">{[['board', 'Board'], ['table', 'Table']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => pick(k)}>{l}</button>)}</div>
          {m.can('import') && <button className="ghost" onClick={() => go('/import')}>Import leads</button>}
          {m.can('export') && <><button className="ghost" onClick={() => download('/leads/export?' + qs, 'leads.csv')}>Export CSV</button><button className="ghost" onClick={() => downloadBlob('/leads/export.xlsx?' + qs, 'leads.xlsx')}>Export XLSX</button></>}
          {!m.can('export') && m.can('request_export') && <RequestExport query={Object.fromEntries(new URLSearchParams(qs))} />}
          <button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ New lead'}</button>
        </div>
      </div>
      {(m.can('export') || m.can('request_export')) && <ExportRequests />}
      {adding && <NewLead onDone={() => { setAdding(false); reload() }} />}
      <div className="filters">
        <input placeholder="Search name, phone, email, project…" value={f.q} onChange={set('q')} />
        <Select value={f.filter} onChange={set('filter')} options={FILTERS} blank={null} />
        {!board && <Select value={f.status} onChange={set('status')} options={m.settings.statuses} blank="Any status" />}
        <Select value={f.source} onChange={set('source')} options={m.settings.sources} blank="Any source" />
        {m.settings.projects.length > 0 && <Select value={f.project} onChange={set('project')} options={m.settings.projects} blank="Any project" />}
        {m.me.role !== 'agent' && <Select value={f.agent_id} onChange={set('agent_id')} options={agents} blank="Any agent" />}
        {hasFilters && <button type="button" className="ghost" onClick={clearFilters} title="Clear all filters">✕ Reset filters</button>}
      </div>
      {board ? <Board data={data} reload={reload} /> : <>
      <div className="card scroll">
        <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Source</th><th>Project</th><th>Status</th><th>Score</th><th>Agent</th><th>Next follow-up</th><th>Created</th></tr></thead>
          <tbody>
            {data?.rows.map(l => (
              <tr key={l.id} onClick={() => go('/leads/' + l.id)} className="link">
                <td><div className="who"><span className="avatar sm">{l.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</span><div><b>{l.name}</b><small className="muted">{l.city || '—'}</small></div></div></td>
                <td className="nowrap">{phone(l.phone)}</td>
                <td>{l.source}{l.campaign && <small><br />{l.campaign}</small>}</td>
                <td>{l.project || '—'}</td>
                <td><Status s={l.status} />{l.pending_status && <small className="warn"> → {l.pending_status}?</small>}</td>
                <td>{l.score}</td>
                <td>{l.agent_name || <span className="warn">Unassigned</span>}</td>
                <When d={l.next_action_at} className={l.next_action_at && l.next_action_at < new Date().toISOString() ? 'warn' : ''} />
                <When d={l.created_at} />
              </tr>
            ))}
            {data?.rows.length === 0 && <tr><td colSpan="9" className="muted">No leads match.</td></tr>}
          </tbody>
        </table>
      </div>
      {data?.total > 50 && (
        <div className="row">
          <button className="ghost" disabled={!f.page} onClick={() => setF({ ...f, page: f.page - 1 })}>← Prev</button>
          <span className="muted">Page {f.page + 1} of {Math.ceil(data.total / 50)}</span>
          <button className="ghost" disabled={(f.page + 1) * 50 >= data.total} onClick={() => setF({ ...f, page: f.page + 1 })}>Next →</button>
        </div>
      )}
      </>}
    </section>
  )
}

// Pipeline board: a column per status; dropping a card changes the status through the same rules as the lead page
function Board({ data, reload }) {
  const m = useMeta()
  const s = m.settings
  const { run, error, busy, setError } = useAction()
  const [over, setOver] = useState(null)
  const [ask, setAsk] = useState(null) // { lead, status } waiting for a reason (Lost/Junk)
  const [msg, setMsg] = useState('')
  const dlg = useRef()
  if (!data) return <p className="muted">Loading…</p>
  const move = (lead, status, extra = {}) => run(async () => {
    const r = await api(`/leads/${lead.id}/status`, { body: { status, ...extra } })
    setMsg(r.pending ? `Sent ${lead.name} → ${status} to your team lead for approval.` : '')
    setAsk(null); dlg.current?.close(); reload()
  })
  const drop = status => e => {
    e.preventDefault(); setOver(null); setError(''); setMsg('')
    const lead = data.rows.find(l => l.id === +e.dataTransfer.getData('text/plain'))
    if (!lead || lead.status === status) return
    if (s.approval_statuses.includes(status)) { setAsk({ lead, status }); dlg.current.showModal() } else move(lead, status)
  }
  const now = new Date().toISOString()
  return (
    <>
      {error && <p className="error">{error}</p>}
      {msg && <p className="ok">{msg}</p>}
      {data.total > data.rows.length && <p className="muted">Showing the newest {data.rows.length} of {data.total} leads. Use the filters to narrow it down.</p>}
      <div className={'board-cols' + (busy ? ' busy' : '')}>
        {s.statuses.map(st => {
          const list = data.rows.filter(l => l.status === st)
          return (
            <div key={st} className={'board-col' + (over === st ? ' over' : '')}
              onDragOver={e => { e.preventDefault(); setOver(st) }} onDragLeave={() => setOver(o => (o === st ? null : o))} onDrop={drop(st)}>
              <div className="row between board-col-header"><Status s={st} /><b className="count dark">{list.length}</b></div>
              {list.length === 0 ? (
                <div className="board-empty-hint">Drop leads here</div>
              ) : (
                list.map(l => (
                  <a key={l.id} href={'#/leads/' + l.id} className="board-card" draggable onDragStart={e => e.dataTransfer.setData('text/plain', l.id)}>
                    <div className="row between">
                      <b>{l.name}</b>
                      {l.score != null && <span className="board-score" title={`Score: ${l.score}`}>⚡{l.score}</span>}
                    </div>
                    {l.phone && <small className="board-phone">{phone(l.phone)}</small>}
                    <small className="muted">{l.project ? <b>{l.project}</b> : 'No project'} · {l.source}{l.city ? ` (${l.city})` : ''}</small>
                    <small>{l.agent_name ? <span className="board-agent">👤 {l.agent_name}</span> : <span className="warn">⚠️ Unassigned</span>}</small>
                    {l.next_action_at && <small className={'board-due ' + (l.next_action_at < now ? 'warn' : 'muted')}>📅 Follow up {fmt(l.next_action_at)}</small>}
                    {l.pending_status && <small className="warn">⏳ Awaiting approval → {l.pending_status}</small>}
                  </a>
                ))
              )}
            </div>
          )
        })}
      </div>
      <dialog ref={dlg} className="modal" onClose={() => setAsk(null)}>
        {ask && (
          <form className="grid" onSubmit={e => { const b = formData(e); move(ask.lead, ask.status, b) }}>
            <h3 className="wide">Mark {ask.lead.name} as {ask.status}</h3>
            <label>Reason *<Select name="reason" options={s.lost_reasons} required /></label>
            <label className="wide">Note *<textarea name="note" rows="2" required /></label>
            {!m.can('approve_lost') && <p className="muted wide">Needs approval from your team lead.</p>}
            {error && <p className="error wide">{error}</p>}
            <div className="wide row">
              <button disabled={busy}>{m.can('approve_lost') ? 'Update' : 'Request'}</button>
              <button type="button" className="ghost" onClick={() => dlg.current.close()}>Cancel</button>
            </div>
          </form>
        )}
      </dialog>
    </>
  )
}

function RequestExport({ query }) {
  const { run, error } = useAction()
  const [sent, setSent] = useState(false)
  const ask = () => {
    const reason = prompt('Exports need approval from the sales head. Why do you need this export (current filters)?')
    if (reason?.trim()) run(async () => { await api('/exports', { body: { reason, query } }); setSent(true) })
  }
  return <>{sent ? <span className="ok">Requested. You'll be notified.</span> : <button className="ghost" onClick={ask}>Request export</button>}{error && <span className="error">{error}</span>}</>
}

// Approvers see pending requests; requesters see theirs and download once approved
function ExportRequests() {
  const m = useMeta()
  const [rows, reload] = useApi('/exports')
  const { run, error } = useAction()
  const decide = (r, approve) => run(async () => { await api(`/exports/${r.id}/decide`, { body: { approve } }); reload() })
  const get = r => run(async () => { await download(`/exports/${r.id}/download`, `leads-${r.id}.csv`); reload() })
  const shown = rows?.filter(r => r.status === 'pending' || (r.user_id === m.me.id && r.status === 'approved')) || []
  if (!shown.length) return null
  const filters = q => Object.entries(q).map(([k, v]) => `${k}: ${v}`).join(', ') || 'all leads in scope'
  return (
    <div className="card">
      <h3>Export requests</h3>
      {shown.map(r => (
        <div key={r.id} className="row between line-item">
          <span><b>{r.user_name}</b> · {r.reason} <small className="muted">({filters(r.query)}) · {fmt(r.created_at)}</small></span>
          <span className="row">
            {r.status === 'pending' && m.can('export') && <><button onClick={() => decide(r, true)}>Approve</button><button className="ghost" onClick={() => decide(r, false)}>Reject</button></>}
            {r.status === 'pending' && !m.can('export') && <span className="muted">Waiting for approval</span>}
            {r.status === 'approved' && <button onClick={() => get(r)}>Download (once)</button>}
          </span>
        </div>
      ))}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

export function LeadFields({ lead = {} }) {
  const { settings: s, dealers } = useMeta()
  const custom = lead.custom ? JSON.parse(lead.custom) : {}
  return (
    <>
      <label>City<input name="city" defaultValue={lead.city} /></label>
      <label>Lead type<Select name="lead_type" options={s.lead_types} defaultValue={lead.lead_type || 'buyer'} blank={null} /></label>
      <label>Interest<Select name="interest" options={[['own', 'Own project'], ['third_party', 'Third party'], ['both', 'Both']]} defaultValue={lead.interest} /></label>
      <label>Property type<Select name="property_type" options={s.property_types} defaultValue={lead.property_type} /></label>
      <label>Project / society<input name="project" list="project-list" defaultValue={lead.project} /></label>
      <datalist id="project-list">{s.projects.map(p => <option key={p} value={p} />)}</datalist>
      <label>Preferred locations<input name="locations" defaultValue={lead.locations} /></label>
      <label>Budget min (PKR)<input name="budget_min" type="number" min="0" defaultValue={lead.budget_min} /></label>
      <label>Budget max (PKR)<input name="budget_max" type="number" min="0" defaultValue={lead.budget_max} /></label>
      <label>Payment<Select name="payment_pref" options={['cash', 'installment']} defaultValue={lead.payment_pref} /></label>
      {dealers.length > 0 && <label>Dealer<Select name="dealer_id" options={dealers.filter(d => d.active || d.id === lead.dealer_id).map(d => [d.id, d.name + (d.company ? ` · ${d.company}` : '')])} defaultValue={lead.dealer_id ?? ''} blank="No dealer (direct)" /></label>}
      <label>Tags<input name="tags" defaultValue={lead.tags} placeholder="comma separated" /></label>
      {s.custom_fields.map(c => <label key={c.key}>{c.label}<input name={'custom.' + c.key} defaultValue={custom[c.key]} /></label>)}
      <label className="wide">Remarks<textarea name="remarks" defaultValue={lead.remarks} rows="2" /></label>
    </>
  )
}
// "custom.x" form keys -> { custom: { x } }
export const packCustom = body => {
  const custom = {}
  for (const k of Object.keys(body)) if (k.startsWith('custom.')) { custom[k.slice(7)] = body[k]; delete body[k] }
  return Object.keys(custom).length ? { ...body, custom } : body
}

function NewLead({ onDone }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [dup, setDup] = useState()
  const submit = e => {
    const body = packCustom(formData(e))
    run(async () => {
      const r = await api('/leads', { body })
      if (r.duplicate) setDup(r.lead_id)
      else go('/leads/' + r.lead_id)
    })
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <label>Name *<input name="name" required /></label>
      <label>Phone *<input name="phone" required placeholder="03xx xxxxxxx" /></label>
      <label>Email<input name="email" type="email" /></label>
      <label>Source *<Select name="source" options={m.settings.sources} required /></label>
      <label>Campaign / referrer<input name="campaign" /></label>
      {m.me.role !== 'agent' && (
        <label>Assign to<Select name="agent_id" options={m.users.filter(u => u.role === 'agent' && u.active).map(u => [u.id, u.name])} blank="Auto (rules)" /></label>
      )}
      <LeadFields />
      {error && <p className="error wide">{error}</p>}
      {dup && <p className="warn wide">This contact already has an open lead. The inquiry was added to <a href={'#/leads/' + dup} onClick={onDone}>lead #{dup}</a> and its owner was notified.</p>}
      <div className="wide"><button disabled={busy}>Create lead</button></div>
    </form>
  )
}

const IMPORT_FIELDS = ['name', 'phone', 'email', 'source', 'campaign', 'city', 'project', 'lead_type', 'property_type', 'budget_min', 'budget_max', 'remarks', 'created_at']

export function Import() {
  const { settings: s } = useMeta()
  const [csv, setCsv] = useState()
  const [map, setMap] = useState({})
  const [defaultSource, setDefaultSource] = useState('Other')
  const [report, setReport] = useState()
  const { run, error, busy } = useAction()

  const load = async e => {
    const file = e.target.files[0]
    if (!file) return
    let rows
    if (/\.xlsx?$/i.test(file.name)) {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' })
    } else rows = parseCsv(await file.text())
    if (!rows.length) return
    setCsv(rows); setReport()
    const h = rows[0].map(x => x.trim().toLowerCase())
    setMap(Object.fromEntries(IMPORT_FIELDS.map(f => [f, h.findIndex(x => x === f || x.replace(/[\s_]/g, '') === f.replace('_', ''))]).filter(([, i]) => i >= 0)))
  }
  const rows = () => csv.slice(1).map(r => {
    const o = Object.fromEntries(Object.entries(map).filter(([, i]) => i >= 0).map(([f, i]) => [f, r[i]?.trim()]))
    return { ...o, source: o.source || defaultSource }
  })
  const send = commit => run(async () => setReport({ ...(await api('/leads/import', { body: { rows: rows(), commit } })), commit }))
  const count = st => report.report.filter(r => r.status === st).length

  return (
    <section>
      <h2>Import leads</h2>
      <div className="card">
        <p className="muted">Upload a CSV or Excel file. The first row must be headers. Phones are normalized; existing contacts are reported as duplicates and attached as repeat inquiries, not created again.</p>
        <input type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={load} />
      </div>
      {csv && (
        <div className="card grid">
          {IMPORT_FIELDS.map(f => (
            <label key={f}>{f}
              <Select value={map[f] ?? ''} onChange={e => setMap({ ...map, [f]: e.target.value === '' ? -1 : +e.target.value })} options={csv[0].map((h, i) => [i, h])} blank="— skip —" />
            </label>
          ))}
          <label>Source if blank<Select value={defaultSource} onChange={e => setDefaultSource(e.target.value)} options={s.sources} blank={null} /></label>
          <div className="wide row">
            <span className="muted">{csv.length - 1} rows</span>
            <button className="ghost" disabled={busy} onClick={() => send(false)}>Check (dry run)</button>
            <button disabled={busy || !report || report.commit} onClick={() => send(true)}>Import</button>
          </div>
          {error && <p className="error wide">{error}</p>}
        </div>
      )}
      {report && (
        <div className="card">
          <p><b>{report.commit ? 'Imported' : 'Dry run'}:</b> {count('ok')} new · {count('duplicate')} duplicates · {count('error')} errors</p>
          <table><tbody>
            {report.report.filter(r => r.status !== 'ok').map(r => <tr key={r.row}><td>Row {r.row + 1}</td><td className={r.status === 'error' ? 'error' : 'warn'}>{r.status}</td><td>{r.message}</td></tr>)}
          </tbody></table>
        </div>
      )}
    </section>
  )
}
