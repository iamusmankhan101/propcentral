import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, pkr } from './api.js'

const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7)
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—')

// Sales performance vs target, commissions owed/paid, and the dealer book
export default function Commissions() {
  const m = useMeta()
  const eduOn = (m.me.modules || []).includes('edu') && m.perms.includes('edu')
  const propertyOn = (m.me.modules || []).includes('property')
  const [tab, setTab] = useState(!propertyOn && eduOn ? 'edu' : 'property')
  const [month, setMonth] = useState(thisMonth())

  return (
    <section>
      {propertyOn && eduOn && (
        <div className="row between no-print" style={{ marginBottom: 16 }}>
          <div className="seg">
            <button className={tab === 'property' ? 'on' : ''} onClick={() => setTab('property')}>Real Estate Commissions</button>
            <button className={tab === 'edu' ? 'on' : ''} onClick={() => setTab('edu')}>Student Placement Commissions</button>
          </div>
        </div>
      )}

      {tab === 'edu' || (!propertyOn && eduOn) ? (
        <EduCommissionList manage={m.can('payments')} />
      ) : (
        <>
          <Performance month={month} setMonth={setMonth} manage={m.can('payments')} />
          <CommissionList manage={m.can('payments')} />
          {m.can('payments') && <Dealers />}
        </>
      )}
    </section>
  )
}

function Performance({ month, setMonth, manage }) {
  const [d, reload] = useApi('/performance?month=' + month)
  const { run, error } = useAction()
  const setTarget = (r, amount) => run(async () => { await api('/targets', { method: 'PUT', body: { user_id: r.id, month, amount } }); reload() })
  return (
    <div className="card scroll">
      <div className="row between">
        <h3>Sales performance</h3>
        <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} aria-label="Month" />
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Agent</th><th>Target</th><th>Sales</th><th>Achieved</th><th>Bookings</th><th>Leads → booked</th><th>Commission</th></tr></thead>
        <tbody>
          {d?.rows.map(r => (
            <tr key={r.id}>
              <td><b>{r.name}</b></td>
              <td className="nowrap">{manage
                ? <input className="narrow-money" type="number" min="0" step="1" defaultValue={r.target || ''} key={month + r.target} placeholder="Set" aria-label={`Target for ${r.name}`}
                  onBlur={e => +e.target.value !== (r.target || 0) && setTarget(r, e.target.value)} />
                : (r.target || '—')}</td>
              <td className="nowrap">{pkr(r.sales)}</td>
              <td><Bar value={r.bookings} of={r.target} /></td>
              <td>{r.bookings}</td>
              <td className="nowrap">{r.converted} / {r.leads} <small className="muted">({pct(r.converted, r.leads)})</small></td>
              <td className="nowrap">{pkr(r.commission)}</td>
            </tr>
          ))}
          {d?.rows.length === 0 && <tr><td colSpan="7" className="muted">No agents.</td></tr>}
        </tbody>
      </table>
      <small className="muted">Sales are plots allotted this month, credited to the lead owner at the time of sale.{manage && ' Target is the number of plots to sell. Type it and click away to save it.'}</small>
    </div>
  )
}

const Bar = ({ value, of }) => !of ? <span className="muted">—</span> : (
  <span className="target-bar"><b><i style={{ width: Math.min(100, (value / of) * 100) + '%' }} className={value >= of ? 'done' : ''} /></b><small>{pct(value, of)}</small></span>
)

function CommissionList({ manage }) {
  const [rows, reload] = useApi('/commissions')
  const [show, setShow] = useState('pending')
  const { run, error } = useAction()
  const pay = c => {
    const ref = prompt(`Mark ${pkr(c.amount)} commission to ${c.party} as paid?\n\nCheque / transaction no. (optional):`)
    if (ref !== null) run(async () => { await api(`/commissions/${c.id}/pay`, { body: { paid_on: new Date().toLocaleDateString('en-CA'), ref } }); reload() })
  }
  const adjust = c => {
    const amount = prompt(`New commission amount for ${c.party} (now PKR ${c.amount.toLocaleString('en-PK')}):`, c.amount)
    const note = amount !== null && prompt('Reason for the change:')
    if (note?.trim()) run(async () => { await api('/commissions/' + c.id, { method: 'PATCH', body: { amount, note } }); reload() })
  }
  const cancel = c => {
    const note = prompt(`Cancel the ${pkr(c.amount)} commission to ${c.party}?\n\nReason:`)
    if (note?.trim()) run(async () => { await api(`/commissions/${c.id}/cancel`, { body: { note } }); reload() })
  }
  if (!rows) return null
  const recover = c => c.status === 'paid' && c.allotment_status === 'cancelled'
  const shown = rows.filter(c => show === 'all' || c.status === show || (show === 'paid' && recover(c)))
  const total = s => rows.filter(c => c.status === s).reduce((n, c) => n + c.amount, 0)
  return (
    <div className="card scroll">
      <div className="row between">
        <h3>Commissions</h3>
        <small className="muted">Pending PKR {pkr(total('pending'))} · Paid PKR {pkr(total('paid'))}</small>
      </div>
      <div className="seg small">
        {['pending', 'paid', 'cancelled', 'all'].map(k => <button key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Sale</th><th>To</th><th>Sale price</th><th>Rate</th><th>Commission</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {shown.map(c => (
            <tr key={c.id}>
              <td><a href={'#/ledger/' + c.allotment_id}><b>{c.allotment_no}</b></a><small className="muted"><br />{c.project} {c.block} #{c.unit_no} · {c.client} · {c.sale_date}</small></td>
              <td>{c.party}<small className="muted"><br />{c.party_type}</small></td>
              <td className="nowrap">{pkr(c.price)}</td>
              <td>{+c.rate}%</td>
              <td className="nowrap"><b>{pkr(c.amount)}</b></td>
              <td>{c.status}{c.paid_on && <small className="muted"><br />{c.paid_on}{c.ref && ` · ${c.ref}`}</small>}{recover(c) && <small className="error"><br />Sale cancelled: recover</small>}{c.note && <small className="muted"><br />{c.note}</small>}</td>
              <td className="row nowrap">{manage && c.status === 'pending' && <>
                <button className="ghost" onClick={() => pay(c)}>Mark paid</button>
                <button className="ghost" onClick={() => adjust(c)}>Adjust</button>
                <button className="ghost danger" onClick={() => cancel(c)}>Cancel</button>
              </>}</td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan="7" className="muted">None. Commission is created when a plot is allotted to a client.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function Dealers() {
  const m = useMeta()
  const [rows, reload] = useApi('/dealers')
  const { run, error, busy } = useAction()
  const done = () => { reload(); m.reloadMeta() }
  const add = e => { const form = e.target, body = formData(e); run(async () => { await api('/dealers', { body }); form.reset(); done() }) }
  const patch = (d, body) => run(async () => { await api('/dealers/' + d.id, { method: 'PATCH', body }); done() })
  const rate = d => { const r = prompt(`Commission rate for ${d.name} (%). Leave empty for the default.`, d.rate ?? ''); if (r !== null) patch(d, { rate: r }) }
  return (
    <div className="card scroll">
      <h3>Dealers <span className="count">{rows?.filter(d => d.active).length}</span></h3>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Dealer</th><th>Rate</th><th>Leads</th><th>Sales</th><th>Earned</th><th>Paid</th><th>Balance</th><th></th></tr></thead>
        <tbody>
          {rows?.map(d => (
            <tr key={d.id} className={d.active ? '' : 'muted'}>
              <td><b>{d.name}</b><small className="muted"><br />{[d.company, d.phone].filter(Boolean).join(' · ')}</small></td>
              <td><button className="ghost" onClick={() => rate(d)}>{d.rate == null ? 'Default' : +d.rate + '%'}</button></td>
              <td>{d.leads}</td>
              <td>{d.sales}</td>
              <td className="nowrap">{pkr(d.earned)}</td>
              <td className="nowrap">{pkr(d.paid)}</td>
              <td className="nowrap"><b>{pkr(d.earned - d.paid)}</b></td>
              <td><button className="ghost" onClick={() => patch(d, { active: !d.active })}>{d.active ? 'Deactivate' : 'Activate'}</button></td>
            </tr>
          ))}
          {rows?.length === 0 && <tr><td colSpan="8" className="muted">No dealers yet. Add one below, then pick them on a lead.</td></tr>}
        </tbody>
      </table>
      <form className="row" onSubmit={add} style={{ marginTop: 12 }}>
        <input name="name" placeholder="Dealer name *" required />
        <input name="company" placeholder="Company / agency" />
        <input name="phone" placeholder="Phone" />
        <input name="rate" type="number" min="0" max="20" step="0.1" placeholder="Rate % (default)" />
        <button disabled={busy}>Add dealer</button>
      </form>
    </div>
  )
}


function EduCommissionList({ manage }) {
  const [rows, reload] = useApi('/edu/commissions')
  const [show, setShow] = useState('all')
  const [adding, setAdding] = useState(false)
  const { run, error } = useAction()

  const pay = c => {
    const ref = prompt(`Mark ${c.currency || 'PKR'} ${Number(c.amount).toLocaleString('en-PK')} commission to ${c.counselor_name} as paid?\n\nTransaction reference / receipt #:`)
    if (ref !== null) run(async () => { await api(`/edu/commissions/${c.id}/pay`, { body: { paid_on: new Date().toLocaleDateString('en-CA'), ref } }); reload() })
  }

  const cancel = c => {
    const note = prompt(`Cancel this ${c.currency || 'PKR'} ${Number(c.amount).toLocaleString('en-PK')} commission?\n\nReason:`)
    if (note?.trim()) run(async () => { await api(`/edu/commissions/${c.id}/cancel`, { body: { note } }); reload() })
  }

  if (!rows) return <p className="muted">Loading student placement commissions…</p>

  const shown = rows.filter(c => show === 'all' || c.status === show)
  const total = st => rows.filter(c => c.status === st).reduce((n, c) => n + c.amount, 0)

  return (
    <div className="card scroll">
      <div className="row between">
        <div>
          <h3>Student Placement Commissions</h3>
          <small className="muted">Pending: PKR {total('pending').toLocaleString('en-PK')} · Paid: PKR {total('paid').toLocaleString('en-PK')}</small>
        </div>
        {manage && <button onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ Record commission'}</button>}
      </div>

      {adding && <NewEduCommission onDone={() => { setAdding(false); reload() }} />}

      <div className="seg small" style={{ marginTop: 12 }}>
        {['all', 'pending', 'paid', 'cancelled'].map(k => (
          <button key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{k[0].toUpperCase() + k.slice(1)}</button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Student</th>
            <th>Counselor</th>
            <th>University / Program</th>
            <th>Type</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Paid on / Ref</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {shown.map(c => (
            <tr key={c.id}>
              <td><a href={'#/students/' + c.student_id}><b>{c.student_name}</b></a><small className="muted"><br />{c.student_phone}</small></td>
              <td>{c.counselor_name || 'Unassigned'}</td>
              <td>{c.university_name ? <>{c.university_name} <small className="muted">({c.university_country})</small><br /><small>{c.program_name || 'Course placement'}</small></> : 'General placement'}</td>
              <td><span className="chip-item">{c.type}</span></td>
              <td className="nowrap"><b>{c.currency || 'PKR'} {Number(c.amount).toLocaleString('en-PK')}</b></td>
              <td><span className={`status ${c.status === 'paid' ? 'u-available' : c.status === 'cancelled' ? 'warn' : ''}`}>{c.status}</span></td>
              <td>{c.paid_on ? `${c.paid_on}${c.ref ? ` (${c.ref})` : ''}` : '—'}</td>
              <td className="nowrap">
                {manage && c.status === 'pending' && (
                  <span className="row">
                    <button className="ghost mini-btn ok" onClick={() => pay(c)}>Pay</button>
                    <button className="ghost mini-btn danger" onClick={() => cancel(c)}>Cancel</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan="8" className="muted">No commissions in this view.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function NewEduCommission({ onDone }) {
  const students = useApi('/edu/students?size=200')[0]
  const m = useMeta()
  const { run, error, busy } = useAction()

  const submit = e => {
    e.preventDefault()
    const form = e.target
    const data = {
      student_id: form.student_id.value,
      user_id: form.user_id.value || null,
      type: form.type.value,
      amount: form.amount.value,
      currency: form.currency.value,
      note: form.note.value,
    }
    run(async () => {
      await api('/edu/commissions', { body: data })
      onDone()
    })
  }

  return (
    <form className="grid card" onSubmit={submit} style={{ marginTop: 12 }}>
      <h4 className="wide">New placement commission record</h4>
      <label>Student *
        <select name="student_id" required>
          <option value="">Select student</option>
          {(students?.rows || []).map(s => <option key={s.id} value={s.id}>{s.name} ({s.stage})</option>)}
        </select>
      </label>
      <label>Counselor recipient
        <select name="user_id">
          <option value="">Assign to student's counselor</option>
          {m.users.filter(u => u.active).map(u => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
        </select>
      </label>
      <label>Commission Type
        <select name="type">
          <option value="counselor">Counselor placement bonus</option>
          <option value="university_partner">University partner commission</option>
          <option value="sub_agent">Sub-agent referral commission</option>
        </select>
      </label>
      <label>Amount *
        <input name="amount" type="number" min="1" step="100" required placeholder="50000" />
      </label>
      <label>Currency
        <select name="currency" defaultValue="PKR">
          <option value="PKR">PKR</option>
          <option value="GBP">GBP</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="CAD">CAD</option>
          <option value="AUD">AUD</option>
        </select>
      </label>
      <label className="wide">Note
        <input name="note" placeholder="Intake agreement, contract code, or placement details" />
      </label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row">
        <button disabled={busy}>Record commission</button>
        <button type="button" className="ghost" onClick={onDone}>Cancel</button>
      </div>
    </form>
  )
}
