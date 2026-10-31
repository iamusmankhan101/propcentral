import { useState } from 'react'
import { useApi, useMeta, fmt, formData, go } from './api.js'
import { Select, Status } from './Leads.jsx'
import Icon from './Icon.jsx'

const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—')
const initials = n => n.split(' ').map(w => w[0]).join('').slice(0, 2)
const day = d => d.toLocaleDateString('en-CA') // local YYYY-MM-DD

const PERIODS = {
  today: ['today', () => new Date()],
  week: ['the last 7 days', () => new Date(Date.now() - 6 * 864e5)],
  month: ['this month', () => { const d = new Date(); d.setDate(1); return d }],
  d30: ['the last 30 days', () => new Date(Date.now() - 29 * 864e5)],
  d90: ['the last 90 days', () => new Date(Date.now() - 89 * 864e5)],
  year: ['this year', () => new Date(new Date().getFullYear(), 0, 1)],
}

// Period-over-period change. Rates compare in points, counts in percent; `lowerIsBetter` flips the color.
function Delta({ cur, prev, rate, lowerIsBetter }) {
  if (cur == null || prev == null || (!rate && !prev)) return null
  const v = rate ? (cur - prev) * 100 : ((cur - prev) / prev) * 100
  if (!isFinite(v)) return null
  const good = v === 0 || (v > 0) !== !!lowerIsBetter
  return <span className={'delta ' + (good ? 'up' : 'down')}>{v >= 0 ? '↗' : '↘'} {Math.abs(v).toFixed(1)}{rate ? ' pts' : '%'}</span>
}

// Catmull-Rom -> cubic bezier, control points clamped to the baseline so curves never dip below zero
const smooth = (pts, floor) => pts.map((p, i) => {
  if (!i) return `M${p[0]},${p[1]}`
  const p0 = pts[i - 2] || pts[i - 1], p1 = pts[i - 1], p3 = pts[i + 1] || p
  const c1 = [p1[0] + (p[0] - p0[0]) / 6, Math.min(floor, p1[1] + (p[1] - p0[1]) / 6)]
  const c2 = [p[0] - (p3[0] - p1[0]) / 6, Math.min(floor, p[1] - (p3[1] - p1[1]) / 6)]
  return `C${c1} ${c2} ${p}`
}).join('')

function Trend({ daily, from, to }) {
  const [hover, setHover] = useState(null)
  const by = Object.fromEntries(daily.map(r => [r.d, r]))
  const rows = []
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z') && rows.length < 400; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10)
    rows.push({ d: k, leads: by[k]?.leads || 0, contacted: by[k]?.contacted || 0 })
  }
  const W = 900, H = 240, L = 34, R = 12, T = 14, B = 28
  const max = Math.max(4, Math.ceil(Math.max(...rows.map(r => r.leads)) / 4) * 4)
  const x = i => L + (i * (W - L - R)) / Math.max(1, rows.length - 1)
  const y = v => T + (H - T - B) * (1 - v / max)
  const base = y(0)
  const line = k => smooth(rows.map((r, i) => [+x(i).toFixed(1), +y(r[k]).toFixed(1)]), base)
  const area = `${line('leads')}L${x(rows.length - 1)},${base}L${x(0)},${base}Z`
  const tickEvery = Math.ceil(rows.length / 7)
  const label = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-PK', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const pick = e => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    setHover(Math.max(0, Math.min(rows.length - 1, Math.round(((px - L) / (W - L - R)) * (rows.length - 1)))))
  }
  const key = e => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
    if (step) { e.preventDefault(); setHover(h => Math.max(0, Math.min(rows.length - 1, (h ?? rows.length - 1) + step))) }
  }
  const h = hover != null ? rows[hover] : null
  const total = k => rows.reduce((s, r) => s + r[k], 0)

  return (
    <div className="card trend">
      <div className="row between">
        <h3>Leads vs first contact</h3>
        <div className="legend">
          <span><i className="key area" />Leads <b>{total('leads')}</b></span>
          <span><i className="key line" />Contacted <b>{total('contacted')}</b></span>
        </div>
      </div>
      {rows.length < 2 ? <p className="muted">Pick a longer period to see the trend.</p> : (
        <div className="plot">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily leads and contacted leads. Use arrow keys to read values." tabIndex="0"
            onPointerMove={pick} onPointerLeave={() => setHover(null)} onKeyDown={key} onBlur={() => setHover(null)}>
            <defs>
              <linearGradient id="leadFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="var(--s1)" stopOpacity=".28" />
                <stop offset="1" stopColor="var(--s1)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 1, 2, 3, 4].map(t => (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y((max * t) / 4)} y2={y((max * t) / 4)} className="grid" />
                <text x={L - 8} y={y((max * t) / 4) + 4} textAnchor="end">{(max * t) / 4}</text>
              </g>
            ))}
            {rows.map((r, i) => i % tickEvery === 0 && (
              <text key={r.d} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : x(i) > W - 60 ? 'end' : 'middle'}>{label(r.d)}</text>
            ))}
            <path d={area} fill="url(#leadFill)" />
            <path d={line('leads')} className="l1" />
            <path d={line('contacted')} className="l2" />
            {h && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={T} y2={base} className="cross" />
                <circle cx={x(hover)} cy={y(h.leads)} r="5" className="dot1" />
                <circle cx={x(hover)} cy={y(h.contacted)} r="5" className="dot2" />
              </g>
            )}
          </svg>
          {h && (
            <div className="tip" style={{ left: (x(hover) / W) * 100 + '%', top: (y(h.leads) / H) * 100 + '%' }}>
              <small>{label(h.d)}</small>
              <div><i className="key line s1" /><b>{h.leads}</b> leads</div>
              <div><i className="key line" /><b>{h.contacted}</b> contacted</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Pipeline composition: one slice per status, coloured by the status's place in settings so a
// filter or period change never repaints a status
const PALETTE = ['#e4572e', '#2f6fdb', '#8b55d6', '#0f9d76', '#d99a1b', '#1f9e94', '#b23a8a', '#0f7f46', '#6b7280', '#9ca3af', '#5a6b8c', '#a15c00']

// Whole percentages that add up to 100 (largest remainder), so 2/2/2 never reads as 99%
function shares(rows, total) {
  if (!total) return rows.map(() => 0)
  const exact = rows.map(x => (100 * x.n) / total)
  const out = exact.map(Math.floor)
  let left = 100 - out.reduce((s, n) => s + n, 0)
  exact.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .forEach(([, i]) => { if (left > 0) { out[i]++; left-- } })
  return out
}

function Composition({ funnel }) {
  const m = useMeta()
  const [hover, setHover] = useState(null)
  const order = m.settings.statuses
  const rank = s => { const i = order.indexOf(s); return i < 0 ? order.length : i }
  const color = s => PALETTE[(order.indexOf(s) < 0 ? PALETTE.length - 1 : order.indexOf(s) % PALETTE.length)]
  const rows = funnel.filter(f => f.n > 0).sort((a, b) => rank(a.status) - rank(b.status)).map(f => ({ name: f.status, n: f.n, color: color(f.status) }))
  const total = rows.reduce((s, r) => s + r.n, 0)
  const pcts = shares(rows, total)
  const focus = rows[hover]
  const r = 70, C = 2 * Math.PI * r, gap = rows.length > 1 ? 3 : 0
  let off = 0
  return (
    <div className="card">
      <h3>Pipeline composition</h3>
      <div className="composition">
        <ul>
          {rows.map((x, i) => (
            <li key={x.name} className={hover === i ? 'on' : ''}
              onPointerEnter={() => setHover(i)} onPointerLeave={e => e.pointerType !== 'touch' && setHover(null)}>
              <small><i className="swatch" style={{ background: x.color }} />{x.name}</small>
              <div><b>{x.n.toLocaleString()}</b> <span className="muted">{pcts[i]}%</span></div>
            </li>
          ))}
        </ul>
        <svg viewBox="0 0 180 180" role="img" aria-label={rows.map(x => `${x.name} ${x.n}`).join(', ')}>
          <circle cx="90" cy="90" r={r} className="ring" />
          {rows.map((x, i) => {
            const len = (x.n / total) * C, o = off
            off += len
            return (
              <circle key={x.name} cx="90" cy="90" r={r} fill="none" stroke={x.color} strokeWidth={hover === i ? 30 : 26}
                strokeDasharray={`${Math.max(0.1, len - gap)} ${C}`} strokeDashoffset={-o} transform="rotate(-90 90 90)"
                onPointerEnter={() => setHover(i)} onPointerLeave={e => e.pointerType !== 'touch' && setHover(null)} />
            )
          })}
          <text x="90" y="86" textAnchor="middle" className="donut-total">{focus ? focus.n.toLocaleString() : total}</text>
          <text x="90" y="106" textAnchor="middle" className="donut-label">{focus ? focus.name : 'leads'}</text>
          {focus && <text x="90" y="122" textAnchor="middle" className="donut-pct">{pcts[hover]}%</text>}
        </svg>
      </div>
      {!rows.length && <p className="muted">No leads in this period.</p>}
    </div>
  )
}

function Shortcuts() {
  const m = useMeta()
  const find = e => { const { q } = formData(e); go('/leads?q=' + encodeURIComponent(q)) }
  const flow = (href, kind, text) => (
    <a className="card shortcut" href={href}>
      <small className="kind"><Icon name="arrow" size={12} />{kind}</small>
      <b>{text}</b>
    </a>
  )
  return (
    <>
      <a className="card cta" href="#/leads?new=1"><span className="sq"><Icon name="plus" size={20} /></span><b>Add a new lead</b></a>
      <form className="card shortcut" onSubmit={find}>
        <small className="kind"><Icon name="search" size={12} />Shortcut</small>
        <b>Find a lead by phone or name</b>
        <div className="inline"><input name="q" placeholder="0300 1234567" required aria-label="Phone or name" /><button className="sq" aria-label="Search"><Icon name="arrow" size={16} /></button></div>
      </form>
      {m.can('approve_lost') && flow('#/leads?filter=pending', 'Workflow', 'Review pending Lost / Junk requests')}
      {m.can('import') && flow('#/import', 'Workflow', 'Import leads from an Excel sheet')}
      {flow('#/leads?filter=recycle', 'Shortcut', 'Work the recycle pool')}
      {flow('#/visits', 'Shortcut', 'Verify today\'s site visits')}
    </>
  )
}

export default function Dashboard() {
  const m = useMeta()
  const [period, setPeriod] = useState('month')
  const [tab, setTab] = useState('main')
  const [f, setF] = useState({ source: '', project: '', agent_id: '', branch_id: '' })
  const filters = { ...f, from: day(PERIODS[period][1]()), to: day(new Date()) }
  const [d] = useApi('/dashboard?' + new URLSearchParams(Object.entries(filters).filter(([, v]) => v)))
  const set = k => e => setF({ ...f, [k]: e.target.value })
  const isAgent = m.me.role === 'agent'
  const tabs = [['main', 'Main'], ...(isAgent ? [] : [['team', 'Team']]), ['marketing', 'Marketing']]

  const head = (
    <div className="hero">
      <div className="hero-title">
        <h1>Overview for</h1>
        {/* big text on show, a normal-size select on top so its menu stays normal size */}
        <label className="period">
          <span>{PERIODS[period][0]}</span>
          <select value={period} onChange={e => setPeriod(e.target.value)} aria-label="Period">
            {Object.entries(PERIODS).map(([k, [label]]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
      </div>
      <div className="row between">
        <div className="tabs" role="tablist">
          {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        <div className="row">
          <Select value={f.source} onChange={set('source')} options={m.settings.sources} blank="All sources" />
          {m.settings.projects.length > 0 && <Select value={f.project} onChange={set('project')} options={m.settings.projects} blank="All projects" />}
          {!isAgent && <Select value={f.agent_id} onChange={set('agent_id')} options={m.users.filter(u => u.role === 'agent').map(u => [u.id, u.name])} blank="All agents" />}
          {!isAgent && m.branches.length > 1 && <Select value={f.branch_id} onChange={set('branch_id')} options={m.branches.map(b => [b.id, b.name])} blank="All branches" />}
        </div>
      </div>
    </div>
  )
  if (!d) return <section className={'dash loading'}>{head}</section>

  const k = d.kpi, p = d.prev
  const sla = k.leads ? k.within_sla / k.leads : null, prevSla = p.leads ? p.within_sla / p.leads : null
  const strip = [
    ['Total leads', k.leads, null, <Delta cur={k.leads} prev={p.leads} />],
    ['Within SLA', sla == null ? '—' : Math.round(sla * 100), sla == null ? '' : '%', <Delta cur={sla} prev={prevSla} rate />],
    ['Avg first response', k.avg_response == null ? '—' : Math.round(k.avg_response), k.avg_response == null ? '' : ' min', <Delta cur={k.avg_response} prev={p.avg_response} lowerIsBetter />],
    ['Visits verified', d.visits.total ? Math.round((100 * (d.visits.verified || 0)) / d.visits.total) : '—', d.visits.total ? '%' : '', <span className="delta flat">{d.visits.verified || 0} of {d.visits.total}</span>],
    ['Booked', k.booked, null, <Delta cur={k.booked} prev={p.booked} />],
  ]

  return (
    <section className="dash">
      {head}
      <div className="kpis glass">
        {strip.map(([label, value, unit, delta], i) => (
          <div key={label} className={'kpi' + (i === strip.length - 1 ? ' wide' : '')}><small>{label}</small><b>{value ?? 0}{unit && <span>{unit}</span>}</b>{delta}</div>
        ))}
      </div>

      {tab === 'main' && (
        <>
          <div className="board">
            <div>
              {isAgent ? (
                <div className="card">
                  <div className="row between"><h3>My follow-ups <span className="count">{d.mine.length}</span></h3></div>
                  {d.mine.length ? d.mine.map(l => (
                    <a key={l.id} className="item" href={'#/leads/' + l.id}>
                      <span className="tile-av">{initials(l.name)}</span>
                      <div><b>{l.name}</b><small className={l.next_action_at && l.next_action_at < new Date().toISOString() ? 'error' : 'muted'}>{l.next_action || 'First contact'} · {fmt(l.next_action_at)}</small></div>
                      <Status s={l.status} />
                    </a>
                  )) : <p className="muted">Nothing due.</p>}
                </div>
              ) : (
                <div className="card">
                  <div className="row between">
                    <h3>Agents <span className="count">{d.agents.length}</span></h3>
                    {m.can('manage_users') && <a className="button soft" href="#/users"><Icon name="settings" size={14} /> Manage</a>}
                  </div>
                  {d.agents.map(a => (
                    <div key={a.id} className="item">
                      <span className="tile-av">{initials(a.name)}</span>
                      <div><b>{a.name}</b><small className="muted">{a.leads} leads · {a.avg_response_min ?? '—'} min avg response</small></div>
                      <div className="right">
                        <b>{a.booked} booked</b>
                        <small><span className="muted">{pct(a.contacted, a.leads)} contacted</span> <span className={a.breaches ? 'error' : 'ok'}>{a.breaches ? `↘ ${a.breaches} breaches` : '↗ no breaches'}</span></small>
                      </div>
                    </div>
                  ))}
                  {!d.agents.length && <p className="muted">No assigned leads in this period.</p>}
                </div>
              )}
              <Composition funnel={d.funnel} />
            </div>

            <div>
              <div className="card">
                <h3>Pipeline</h3>
                <div className="line-item"><span>Contacted <span className="count">{k.contacted || 0}</span></span><b className="ok">{pct(k.contacted, k.leads)}</b></div>
                <div className="line-item"><span>Not contacted <span className="count">{k.leads - (k.contacted || 0)}</span></span><b className="error">{pct(k.leads - (k.contacted || 0), k.leads)}</b></div>
                {k.untouched_72h > 0 && <a className="alert" href="#/leads?filter=untouched"><Icon name="alert" size={14} /> {k.untouched_72h} leads untouched for 72h+</a>}
                <div className="inset">
                  <small>Total booked</small>
                  <b>{k.booked || 0}</b>
                  <a className="button full" href="#/leads?status=Booked">See all <span className="count dark">{k.booked || 0}</span></a>
                </div>
              </div>
              <a className="card runway" href="#/leads?filter=overdue">
                <div>
                  <div className="big"><b>{k.overdue || 0}</b><small>overdue<br />follow-ups</small></div>
                  <small className="muted">Target is zero. Every open lead needs a future follow-up.</small>
                </div>
                <div className={'pulse' + (k.overdue ? '' : ' calm')}>
                  <svg viewBox="0 0 60 24" aria-hidden="true"><path d="M0 12h18l4-8 6 16 5-12 3 4h24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
                  <small>{k.overdue ? 'Open list' : 'All clear'}</small>
                </div>
              </a>
              <div className="card">
                <h3>Funnel</h3>
                {[...d.funnel].sort((a, b) => m.settings.statuses.indexOf(a.status) - m.settings.statuses.indexOf(b.status)).map(x => (
                  <div key={x.status} className="bar"><span>{x.status}</span><i style={{ width: (100 * x.n) / Math.max(1, ...d.funnel.map(y => y.n)) + '%' }} /><b>{x.n}</b></div>
                ))}
                {!d.funnel.length && <p className="muted">No leads in this period.</p>}
              </div>
            </div>

            <div><Shortcuts /></div>
          </div>
          <Trend daily={d.daily} from={d.from} to={d.to} />
        </>
      )}

      {tab === 'team' && (
        <div className="card scroll">
          <h3>Agent leaderboard</h3>
          <table>
            <thead><tr><th>Agent</th><th>Leads</th><th>Contacted</th><th>Response avg / median</th><th>SLA breaches</th><th>Calls (conn.)</th><th>Visits</th><th>Overdue</th><th>Booked</th></tr></thead>
            <tbody>{d.agents.map(a => (
              <tr key={a.id}>
                <td><div className="who"><span className="tile-av sm">{initials(a.name)}</span><b>{a.name}</b></div></td>
                <td>{a.leads}</td><td>{pct(a.contacted, a.leads)}</td>
                <td>{a.avg_response_min ?? '—'} / {a.median_response_min ?? '—'} min</td>
                <td className={a.breaches ? 'error' : 'ok'}>{a.breaches}</td>
                <td>{a.calls} ({a.connected})</td>
                <td>{a.visits_verified}{a.visits_unverified > 0 && <span className="error"> / {a.visits_unverified} unverified</span>}</td>
                <td className={a.overdue ? 'warn' : ''}>{a.overdue}</td><td><b>{a.booked}</b></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {tab === 'marketing' && (
        <div className="cols">
          <div className="card scroll">
            <h3>Source & campaign</h3>
            <table>
              <thead><tr><th>Source</th><th>Campaign</th><th>Leads</th><th>Contacted</th><th>Booked</th><th>Conversion</th></tr></thead>
              <tbody>{d.sources.map((s, i) => <tr key={i}><td><b>{s.source}</b></td><td>{s.campaign || '—'}</td><td>{s.leads}</td><td>{s.contacted}</td><td>{s.booked}</td><td>{pct(s.booked, s.leads)}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="card">
            <h3>Lost / junk reasons</h3>
            {d.lost.length ? d.lost.map(x => <div key={x.reason} className="line-item"><span>{x.reason || 'Unspecified'}</span><b>{x.n}</b></div>) : <p className="muted">None in this period.</p>}
          </div>
        </div>
      )}
    </section>
  )
}
