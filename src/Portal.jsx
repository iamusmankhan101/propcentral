import { useApi, pkr } from './api.js'
import { Receipt } from './Payments.jsx'
import logoImg from './assets/logo.png'

const STATUS_CLS = { Paid: 'u-available', Partial: 'u-on-hold', Overdue: 'u-sold', Due: '' }
const rs = n => 'PKR ' + Number(n).toLocaleString('en-PK')

// Buyer's view, no login: opened from the link the company shares (/#/portal/<token>)
export default function Portal({ token, receipt }) {
  const [d, , error] = useApi('/portal/' + token)
  if (receipt) return <div className="portal"><Receipt id={receipt} path={`/portal/${token}/receipts/${receipt}`} back={'#/portal/' + token} /></div>
  if (error) return <div className="portal"><img className="public-logo" src={logoImg} alt="Company logo" /><p className="error">{error}</p></div>
  if (!d) return <p className="muted pad">Loading…</p>
  return (
    <div className="portal">
      <img className="public-logo" src={logoImg} alt="Company logo" />
      <h2>Assalam-o-Alaikum, {d.name}</h2>
      <p className="muted">Your plots, payment schedule and receipts. Keep this link private.</p>
      {d.allotments.map(a => {
        const overdue = a.schedule.reduce((s, i) => s + (i.status === 'Overdue' ? i.amount - i.paid : 0), 0)
        const next = a.schedule.find(i => i.status !== 'Paid')
        return (
          <div key={a.id} className="card">
            <div className="row between">
              <div>
                <h3>{a.project} · {[a.phase, a.block, a.street].filter(Boolean).join(' / ')} #{a.unit_no}</h3>
                <p className="muted">{a.allotment_no} · {a.size ? `${+a.size} ${a.uom} ` : ''}{a.unit_type} · {a.sale_status} on {a.sale_date}</p>
              </div>
              {a.status === 'cancelled' && <span className="status u-cancelled">Cancelled</span>}
            </div>
            <div className="ledger-tiles">
              <div><small>Price</small><b>{pkr(a.price)}</b></div>
              <div><small>Paid</small><b className="ok">{pkr(a.paid)}</b></div>
              <div><small>Balance</small><b>{pkr(a.price - a.paid)}</b></div>
              <div><small>Overdue</small><b className={overdue ? 'error' : ''}>{pkr(overdue)}</b></div>
            </div>
            {next && a.status === 'active' && <p>Next payment: <b>{rs(next.amount - next.paid)}</b> due {next.due_date}</p>}
            {a.schedule.length > 0 && (
              <details>
                <summary>Payment schedule ({a.schedule.length})</summary>
                <div className="scroll"><table><tbody>
                  {a.schedule.map((i, k) => <tr key={k}><td className="nowrap">{i.due_date}</td><td>{i.label}</td><td className="nowrap">{rs(i.amount)}</td><td><span className={'status ' + STATUS_CLS[i.status]}>{i.status}</span></td></tr>)}
                </tbody></table></div>
              </details>
            )}
            <h4>Receipts</h4>
            {a.payments.length ? <ul className="plain">{a.payments.map(p => (
              <li key={p.id}><a href={`#/portal/${token}/receipts/${p.id}`}>{p.receipt_no}</a> · {p.paid_on} · {p.kind === 'refund' ? 'Refund ' : ''}{rs(p.amount)}{p.method && ` · ${p.method}`}</li>
            ))}</ul> : <p className="muted">No payments yet.</p>}
          </div>
        )
      })}
      {!d.allotments.length && <p className="muted">No plots on record yet.</p>}
    </div>
  )
}
