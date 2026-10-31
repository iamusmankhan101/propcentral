import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, fmt, pkr, phone } from './api.js'
import { Select } from './Leads.jsx'
import { LeadPicker, leadIdOf } from './Projects.jsx'
import logoImg from './assets/logo.png'

const STATUS_CLS = { Paid: 'u-available', Partial: 'u-on-hold', Overdue: 'u-sold', Due: '' }
const KIND = { payment: 'Payment', refund: 'Refund', transfer: 'Transfer' }
const today = () => new Date().toLocaleDateString('en-CA') // local YYYY-MM-DD
const where = a => [a.phase, a.block, a.street].filter(Boolean).join(' / ') + ' #' + a.unit_no
const rs = n => 'PKR ' + Number(n).toLocaleString('en-PK')

// Customer ledger for one allotment: plan, every receipt, balance, overdue; accounts record payments here
export function Ledger({ id }) {
  const m = useMeta()
  const [d, reload, loadError] = useApi(`/allotments/${id}/ledger`)
  const { run, error } = useAction()
  if (loadError) return <p className="error">{loadError}</p>
  if (!d) return <p className="muted">Loading…</p>
  const a = d.allotment, active = a.status === 'active', manage = m.can('payments')
  const voidIt = p => {
    const note = prompt(`Void receipt ${p.receipt_no} (${rs(p.amount)})? It stays on record, crossed out.\n\nReason:`)
    if (note?.trim()) run(async () => { await api(`/payments/${p.id}/void`, { body: { note } }); reload() })
  }
  return (
    <section>
      <div className="row between no-print">
        <a href={'#/projects/' + a.project_id} className="muted">← {a.project}</a>
        <div className="row">
          {manage && <PortalLink a={a} />}
          <a className="button ghost" href={'#/booking-form/' + a.id}>Booking form</a>
          <a className="button ghost" href={'#/allotments/' + a.id}>Allotment letter</a>
          <button onClick={() => print()}>Print ledger</button>
        </div>
      </div>
      <div className="card">
        <div className="row between">
          <div>
            <h2>{a.client} {!active && <span className="status u-cancelled">Cancelled</span>}</h2>
            <p className="muted">{a.allotment_no} · {a.project} {where(a)} · {phone(a.phone)}</p>
          </div>
        </div>
        <div className="ledger-tiles">
          <div><small>Sale price</small><b>{rs(a.price)}</b></div>
          <div><small>Paid</small><b className="ok">{rs(d.paid)}</b></div>
          <div><small>Balance</small><b>{rs(a.price - d.paid)}</b></div>
          <div><small>Overdue</small><b className={d.overdue ? 'error' : ''}>{rs(d.overdue)}</b></div>
        </div>
        {d.fees > 0 && <small className="muted">Transfer fees received: {rs(d.fees)} (not part of the sale price)</small>}
      </div>

      <div className="card scroll">
        <h3>Payment schedule</h3>
        <table>
          <thead><tr><th>Due</th><th>Item</th><th>Amount</th><th>Paid</th><th>Status</th></tr></thead>
          <tbody>
            {d.schedule.map(i => (
              <tr key={i.id}><td className="nowrap">{i.due_date}</td><td>{i.label}</td><td className="nowrap">{rs(i.amount)}</td><td className="nowrap">{rs(i.paid)}</td>
                <td><span className={'status ' + STATUS_CLS[i.status]}>{i.status}</span></td></tr>
            ))}
            {!d.schedule.length && <tr><td colSpan="5" className="muted">No payment plan yet.{manage && active && ' Set one below.'}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card scroll">
        <h3>Payments <span className="count">{d.payments.filter(p => !p.voided_at).length}</span></h3>
        {error && <p className="error">{error}</p>}
        <table>
          <thead><tr><th>Receipt</th><th>Date</th><th>Type</th><th>From</th><th>Method</th><th>Amount</th><th className="no-print"></th></tr></thead>
          <tbody>
            {d.payments.map(p => (
              <tr key={p.id} className={p.voided_at ? 'voided' : ''} title={p.void_note ? 'Voided: ' + p.void_note : p.note || ''}>
                <td><b>{p.receipt_no}</b></td>
                <td className="nowrap">{p.paid_on}</td>
                <td>{KIND[p.kind]}{p.note && <small className="muted"><br />{p.note}</small>}</td>
                <td>{p.payer}</td>
                <td>{p.method || '—'}{p.ref && <small className="muted"><br />{p.ref}</small>}</td>
                <td className="nowrap">{p.kind === 'refund' ? '−' : ''}{rs(p.amount)}</td>
                <td className="row nowrap no-print">
                  <a className="button ghost" href={'#/receipts/' + p.id}>Receipt</a>
                  {manage && !p.voided_at && <button className="ghost danger" onClick={() => voidIt(p)}>Void</button>}
                </td>
              </tr>
            ))}
            {!d.payments.length && <tr><td colSpan="7" className="muted">No payments recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {manage && (
        <div className="cols no-print">
          <PaymentForm a={a} methods={d.methods} reload={reload} paid={d.paid} />
          <div>
            {active && <PlanForm a={a} open={!d.schedule.length} reload={reload} />}
            {active && <TransferForm a={a} methods={d.methods} reload={reload} />}
          </div>
        </div>
      )}
    </section>
  )
}

// Customer portal: one private link per buyer, shared on WhatsApp; "New link" kills the old one
function PortalLink({ a }) {
  const { run, error } = useAction()
  const [r, setR] = useState(null)
  const get = reset => run(async () => setR(await api(`/allotments/${a.id}/portal`, { body: { reset } })))
  if (!r) return <><button className="ghost" onClick={() => get(false)}>Customer portal link</button>{error && <span className="error">{error}</span>}</>
  const url = `${location.origin}/#/portal/${r.token}`
  const text = `Dear ${r.name}, view your plot, payment schedule and receipts here: ${url}`
  return (
    <span className="row">
      <a className="button ghost" href={`https://wa.me/${/\*/.test(r.phone) ? '' : r.phone}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">Send on WhatsApp</a>
      <button className="ghost" onClick={() => navigator.clipboard.writeText(url)}>Copy link</button>
      <button className="ghost danger" onClick={() => confirm('Make a new link? The old link stops working.') && get(true)}>New link</button>
    </span>
  )
}

function PaymentForm({ a, methods, paid, reload }) {
  const { run, error, busy } = useAction()
  const [kind, setKind] = useState(a.status === 'active' ? 'payment' : 'refund')
  const submit = e => {
    const form = e.target, b = formData(e)
    run(async () => { const r = await api(`/allotments/${a.id}/payments`, { body: { ...b, kind } }); form.reset(); reload(); location.hash = '/receipts/' + r.id })
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">Record {kind}</h3>
      <div className="seg small wide">
        {a.status === 'active' && <button type="button" className={kind === 'payment' ? 'on' : ''} onClick={() => setKind('payment')}>Payment</button>}
        <button type="button" className={kind === 'refund' ? 'on' : ''} onClick={() => setKind('refund')} disabled={!paid}>Refund</button>
      </div>
      <label>Amount (PKR) *<input name="amount" type="number" min="1" required placeholder={kind === 'refund' ? `up to ${pkr(paid)}` : `balance ${pkr(a.price - paid)}`} /></label>
      <label>Date *<input name="paid_on" type="date" max={today()} defaultValue={today()} required /></label>
      <label>Method *<Select name="method" options={methods} required /></label>
      <label>Cheque / transaction no.<input name="ref" /></label>
      <label className="wide">{kind === 'refund' ? 'Reason *' : 'Note'}<input name="note" required={kind === 'refund'} /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide"><button disabled={busy}>Save and print receipt</button></div>
    </form>
  )
}

function PlanForm({ a, open, reload }) {
  const { run, error, busy } = useAction()
  const submit = e => { const b = formData(e); run(async () => { await api(`/allotments/${a.id}/plan`, { method: 'PUT', body: b }); reload() }) }
  return (
    <details className="card" open={open}>
      <summary><h3>{open ? 'Set payment plan' : 'Change payment plan'}</h3></summary>
      <form className="grid" onSubmit={submit}>
        <label>Down payment (PKR)<input name="down" type="number" min="0" max={a.price} defaultValue={a.down_payment || ''} /></label>
        <label>Installments<input name="count" type="number" min="0" max="360" defaultValue="36" /></label>
        <label>Every<Select name="every" options={[[1, 'Month'], [3, 'Quarter'], [6, '6 months'], [12, 'Year']]} blank={null} /></label>
        <label>Starts<input name="start" type="date" defaultValue={a.sale_date} required /></label>
        <p className="muted wide"><small>Down payment is due on the start date. The balance of {rs(a.price)} minus the down payment is split equally. Payments already received are applied to the new schedule, oldest first.</small></p>
        {error && <p className="error wide">{error}</p>}
        <div className="wide"><button disabled={busy}>Save plan</button></div>
      </form>
    </details>
  )
}

function TransferForm({ a, methods, reload }) {
  const { run, error, busy } = useAction()
  const [existing, setExisting] = useState(true)
  const submit = e => {
    const b = formData(e)
    const body = { fee: b.fee, method: b.method, ref: b.ref, paid_on: b.paid_on, note: b.note }
    if (existing) {
      body.lead_id = leadIdOf(b.lead)
      if (!body.lead_id) return run(async () => { throw new Error('Pick the new owner from the list') })
    } else body.client = { name: b.name, phone: b.phone, cnic: b.cnic }
    if (!confirm(`Transfer ${a.allotment_no} away from ${a.client}? The plot and all its payments move to the new owner.`)) return
    run(async () => { await api(`/allotments/${a.id}/transfer`, { body }); reload() })
  }
  return (
    <details className="card">
      <summary><h3>Transfer to new owner</h3></summary>
      <form className="allot-form" onSubmit={submit}>
        <div className="seg small">
          <button type="button" className={existing ? 'on' : ''} onClick={() => setExisting(true)}>Existing client</button>
          <button type="button" className={existing ? '' : 'on'} onClick={() => setExisting(false)}>New client</button>
        </div>
        {existing ? <LeadPicker required /> : <>
          <input name="name" placeholder="New owner name *" required />
          <input name="phone" placeholder="Phone *" required />
          <input name="cnic" placeholder="CNIC" pattern="\d{5}-?\d{7}-?\d" />
        </>}
        <div className="row">
          <input name="fee" type="number" min="0" placeholder="Transfer fee (PKR)" />
          <Select name="method" options={methods} blank="Fee paid by…" />
        </div>
        <div className="row">
          <input name="paid_on" type="date" max={today()} defaultValue={today()} required aria-label="Transfer date" />
          <input name="ref" placeholder="Cheque / transaction no." />
        </div>
        <input name="note" placeholder="Note" />
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>Transfer</button>
      </form>
    </details>
  )
}

export function Receipt({ id, path, back }) {
  const [p, , loadError] = useApi(path || '/payments/' + id)
  if (loadError) return <p className="error">{loadError}</p>
  if (!p) return <p className="muted">Loading…</p>
  const a = p.allotment
  const title = { payment: 'Payment Receipt', refund: 'Refund Voucher', transfer: 'Transfer Fee Receipt' }[p.kind]
  return (
    <section>
      <div className="row between no-print">
        <a href={back || '#/ledger/' + a.id} className="muted">← {back ? 'Back' : 'Ledger ' + a.allotment_no}</a>
        <button onClick={() => print()}>Print receipt</button>
      </div>
      <article className="card letter">
        {p.voided_at && <div className="stamp">Void</div>}
        <header className="row between">
          <img src={logoImg} alt="Prop Central" />
          <div className="right"><small>Receipt No.</small><b>{p.receipt_no}</b><small>Date: {p.paid_on}</small></div>
        </header>
        <h1>{title}</h1>
        <table className="letter-table"><tbody>
          <tr><th>{p.kind === 'refund' ? 'Paid to' : 'Received from'}</th><td>{p.payer}{p.payer_cnic && <> (CNIC {p.payer_cnic})</>}</td></tr>
          <tr><th>Amount</th><td><b>{rs(p.amount)}</b></td></tr>
          {p.method && <tr><th>Method</th><td>{p.method}{p.ref && ` · ${p.ref}`}</td></tr>}
          <tr><th>Against</th><td>{a.allotment_no} · {a.project} {where(a)}</td></tr>
          {p.note && <tr><th>Note</th><td>{p.note}</td></tr>}
          {p.kind !== 'transfer' && <tr><th>Paid to date</th><td>{rs(p.paid_to_date)} of {rs(a.price)}<br /><small>Balance {rs(a.price - p.paid_to_date)}</small></td></tr>}
        </tbody></table>
        {p.voided_at && <p className="error"><small>Voided {fmt(p.voided_at)}: {p.void_note}</small></p>}
        <div className="signs">
          <div><span />{p.kind === 'refund' ? 'Received by' : 'Customer'}</div>
          <div><span />Accounts<br /><small>Prop Central</small></div>
        </div>
        <footer><small>Recorded by {p.created_by_name || 'Prop Central'} on {fmt(p.created_at)} · Valid only with the company stamp.</small></footer>
      </article>
    </section>
  )
}

export function Collections() {
  const [rows, , loadError] = useApi('/collections')
  const [show, setShow] = useState('overdue')
  if (loadError) return <p className="error">{loadError}</p>
  if (!rows) return <p className="muted">Loading…</p>
  const sum = k => rows.reduce((s, r) => s + r[k], 0)
  const shown = rows.filter(r => show === 'all' || (show === 'overdue' ? r.overdue > 0 : !r.plan)).sort((x, y) => y.overdue - x.overdue)
  return (
    <section>
      <div className="card ledger-tiles">
        <div><small>Sold value</small><b>{pkr(sum('price'))}</b></div>
        <div><small>Collected</small><b className="ok">{pkr(sum('paid'))}</b></div>
        <div><small>Outstanding</small><b>{pkr(sum('balance'))}</b></div>
        <div><small>Overdue</small><b className="error">{pkr(sum('overdue'))}</b></div>
      </div>
      <div className="card scroll">
        <div className="seg small">
          {[['overdue', `Overdue (${rows.filter(r => r.overdue > 0).length})`], ['noplan', `No plan (${rows.filter(r => !r.plan).length})`], ['all', `All (${rows.length})`]].map(([k, l]) =>
            <button key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{l}</button>)}
        </div>
        <table>
          <thead><tr><th>Allotment</th><th>Client</th><th>Price</th><th>Paid</th><th>Overdue</th><th>Next due</th><th></th></tr></thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.id}>
                <td><b>{r.allotment_no}</b><small className="muted"><br />{r.project} {where(r)}</small></td>
                <td><a href={'#/leads/' + r.lead_id}>{r.client}</a><small className="muted"><br />{phone(r.phone)}</small></td>
                <td className="nowrap">{pkr(r.price)}</td>
                <td className="nowrap">{pkr(r.paid)}</td>
                <td className={'nowrap' + (r.overdue ? ' error' : '')}>{r.overdue ? pkr(r.overdue) : '—'}</td>
                <td className="nowrap">{r.plan ? r.next_due || 'Plan complete' : <span className="warn">No plan</span>}</td>
                <td><a className="button ghost" href={'#/ledger/' + r.id}>Ledger</a></td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan="7" className="muted">{show === 'overdue' ? 'Nothing overdue.' : 'Nothing here.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}
