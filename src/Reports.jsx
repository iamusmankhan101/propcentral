import { useState } from 'react'
import { useApi, fmt, pkr } from './api.js'
import { toCsv } from '../server/lib.js'

const today = () => new Date().toLocaleDateString('en-CA')
const shift = (d, period, n) => {
  const x = new Date(d + 'T00:00:00Z')
  if (period === 'month') x.setUTCMonth(x.getUTCMonth() + n, 1)
  else x.setUTCDate(x.getUTCDate() + n * (period === 'week' ? 7 : 1))
  return x.toISOString().slice(0, 10)
}
const label = (period, start, end) => {
  const f = (d, o) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', ...o })
  return period === 'month' ? f(start, { month: 'long', year: 'numeric' })
    : period === 'week' ? `${f(start, { day: 'numeric', month: 'short' })} – ${f(end, { day: 'numeric', month: 'short', year: 'numeric' })}`
      : f(start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}
const mins = n => (n == null ? '—' : n < 60 ? `${n} min` : `${Math.floor(n / 60)}h ${n % 60}m`)
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—')

// [key, heading, format, summed in totals]
const COLS = [
  ['new_leads', 'New leads'], ['contacted', 'Contacted', (v, r) => `${v} (${pct(v, r.new_leads)})`], ['avg_response_min', 'Avg response', mins, false],
  ['sla_breaches', 'SLA breaches'], ['calls', 'Calls'], ['connected', 'Connected'], ['other_activities', 'WhatsApp, meetings…'],
  ['visits_scheduled', 'Visits set'], ['visits_done', 'Visits done'], ['offers', 'Offers'], ['bookings', 'Bookings'], ['sales', 'Sales', pkr],
  ['commission', 'Commission', pkr], ['lost', 'Lost'], ['open_now', 'Open now', null, true], ['overdue_now', 'Follow-ups overdue', null, true],
]

// Daily / weekly / monthly report for every agent the viewer can see (agents see only themselves)
export default function Reports() {
  const [period, setPeriod] = useState('day')
  const [date, setDate] = useState(today())
  const [agentId, setAgentId] = useState(null)
  const qs = `period=${period}&date=${date}`
  const [d] = useApi('/reports/agents?' + qs)
  const rows = d?.rows || []
  const total = Object.fromEntries(COLS.filter(c => c[3] !== false).map(([k]) => [k, rows.reduce((s, r) => s + (r[k] || 0), 0)]))
  const csv = () => {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([toCsv([['Agent', ...COLS.map(c => c[1])], ...rows.map(r => [r.name, ...COLS.map(([k]) => r[k])])])], { type: 'text/csv' })),
      download: `agent-report-${period}-${d.start}.csv`,
    })
    a.click(); URL.revokeObjectURL(a.href)
  }
  return (
    <section>
      <div className="row between no-print">
        <div className="seg">{['day', 'week', 'month'].map(p => <button key={p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>{{ day: 'Daily', week: 'Weekly', month: 'Monthly' }[p]}</button>)}</div>
        <div className="row">
          <button className="ghost" onClick={() => setDate(shift(date, period, -1))} aria-label="Previous">‹</button>
          {period === 'month'
            ? <input type="month" value={date.slice(0, 7)} onChange={e => e.target.value && setDate(e.target.value + '-01')} aria-label="Month" />
            : <input type="date" value={date} max={today()} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Date" />}
          <button className="ghost" onClick={() => setDate(shift(date, period, 1))} disabled={shift(date, period, 1) > today()} aria-label="Next">›</button>
          <button className="ghost" onClick={() => setDate(today())}>Today</button>
          <button className="ghost" onClick={csv} disabled={!rows.length}>Download CSV</button>
          <button className="ghost" onClick={() => print()}>Print</button>
        </div>
      </div>
      <h2 className="report-title">{d ? label(period, d.start, d.end) : '…'}</h2>
      <div className="card scroll">
        <table className="report">
          <thead><tr><th>Agent</th>{COLS.map(c => <th key={c[0]}>{c[1]}</th>)}</tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={agentId === r.id ? 'sel' : ''} onClick={() => setAgentId(agentId === r.id ? null : r.id)}>
                <td><b>{r.name}</b></td>
                {COLS.map(([k, , f]) => <td key={k} className={k === 'overdue_now' && r[k] ? 'error' : k === 'sla_breaches' && r[k] ? 'warn' : ''}>{f ? f(r[k], r) : r[k]}</td>)}
              </tr>
            ))}
            {d && !rows.length && <tr><td colSpan={COLS.length + 1} className="muted">No agents to show.</td></tr>}
          </tbody>
          {rows.length > 1 && <tfoot><tr><td><b>Total</b></td>{COLS.map(([k, , f, sum]) => <td key={k}><b>{sum === false ? '' : f && k !== 'contacted' ? f(total[k]) : k === 'contacted' ? `${total[k]} (${pct(total[k], total.new_leads)})` : total[k]}</b></td>)}</tr></tfoot>}
        </table>
        <small className="muted no-print">Click an agent for their {period === 'day' ? 'activity log' : 'day-by-day breakdown'}. “Open now” and “Follow-ups overdue” are as of right now.</small>
      </div>
      {agentId && <AgentDetail id={agentId} qs={qs} period={period} key={agentId + qs} />}
    </section>
  )
}

function AgentDetail({ id, qs, period }) {
  const [d, , error] = useApi(`/reports/agents/${id}?${qs}`)
  if (error) return <p className="error">{error}</p>
  if (!d) return <p className="muted">Loading…</p>
  const a = d.agent
  return (
    <>
      <div className="card">
        <h3>{a.name}</h3>
        <div className="ledger-tiles">
          <div><small>Calls</small><b>{a.calls}</b></div>
          <div><small>Connected</small><b>{a.connected} <small>({pct(a.connected, a.calls)})</small></b></div>
          <div><small>Visits done</small><b>{a.visits_done}</b></div>
          <div><small>Sales</small><b>{pkr(a.sales)}</b></div>
        </div>
      </div>
      {period !== 'day' && (
        <div className="card scroll">
          <h3>Day by day</h3>
          <table className="report">
            <thead><tr><th>Date</th><th>New leads</th><th>Calls</th><th>WhatsApp, meetings…</th><th>Visits done</th><th>Bookings</th></tr></thead>
            <tbody>{d.days.map(x => (
              <tr key={x.date} className={x.calls + x.other_activities === 0 && new Date(x.date + 'T00:00:00Z').getUTCDay() !== 0 ? 'muted' : ''}>
                <td className="nowrap">{new Date(x.date + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })}</td>
                <td>{x.new_leads}</td><td>{x.calls}</td><td>{x.other_activities}</td><td>{x.visits_done}</td><td>{x.bookings}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {d.bookings.length > 0 && (
        <div className="card scroll">
          <h3>Bookings</h3>
          <table><tbody>{d.bookings.map(b => (
            <tr key={b.id}><td><a href={'#/ledger/' + b.id}>{b.allotment_no}</a></td><td>{b.sale_date}</td><td>{b.client}</td><td>{b.project} {b.block} #{b.unit_no}</td><td className="nowrap">PKR {pkr(b.price)}</td></tr>
          ))}</tbody></table>
        </div>
      )}
      <div className="card">
        <h3>Activity log <span className="count">{d.activities.length}</span></h3>
        <ul className="timeline">
          {d.activities.map(x => (
            <li key={x.id}><b>{x.type.replace('_', ' ')}</b>{x.outcome && ` · ${x.outcome}`} · <a href={'#/leads/' + x.lead_id}>{x.lead_name}</a> <small className="muted">{fmt(x.created_at)}</small>{x.notes && <div><small>{x.notes}</small></div>}</li>
          ))}
          {!d.activities.length && <li className="sys">No calls, messages or meetings logged in this period.</li>}
        </ul>
      </div>
    </>
  )
}
