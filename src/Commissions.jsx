import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, pkr } from './api.js'

const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7)
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—')

// Sales performance vs target, commissions owed/paid, and the dealer book
export default function Commissions() {
  const m = useMeta()
  const [month, setMonth] = useState(thisMonth())
  return (
    <section>
      <Performance month={month} setMonth={setMonth} manage={m.can('payments')} />
      <CommissionList manage={m.can('payments')} />
      {m.can('payments') && <Dealers />}
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
