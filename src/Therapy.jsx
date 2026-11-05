import { useState } from 'react'
import { api, useApi, useAction, formData, go, fmt } from './api.js'
import { Select } from './Leads.jsx'

const AREAS = [['speech', 'Speech & language'], ['behavior', 'Behavior'], ['motor', 'Motor skills'], ['social', 'Social skills']]
const areaName = k => AREAS.find(a => a[0] === k)?.[1] || k

export default function Therapy() {
  const [data, reload, loadError] = useApi('/therapy/children')
  const [adding, setAdding] = useState(false)
  const { run, error, busy } = useAction()
  const submit = e => { const body = formData(e); run(async () => go('/therapy/' + (await api('/therapy/children', { body })).id)) }
  return (
    <section>
      <div className="row between">
        <h2>Special Needs Therapy {data && <span className="count">{data.length}</span>}</h2>
        <button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ Add child'}</button>
      </div>
      <p className="muted">Enter where the child is now. The planner suggests the next 3-month step and what to try if they get stuck. A therapist should review every plan.</p>
      {adding && (
        <form className="card grid" onSubmit={submit}>
          <h3 className="wide">New child</h3>
          <label>Name *<input name="name" required maxLength={80} /></label>
          <label>Age<input name="age" placeholder="e.g. 4y 6m" maxLength={40} /></label>
          <label className="wide">Background<textarea name="notes" rows={3} maxLength={2000} placeholder="Diagnosis, therapies so far, anything useful (optional)" /></label>
          {error && <p className="error wide">{error}</p>}
          <div className="wide row"><button disabled={busy}>Create child</button></div>
        </form>
      )}
      {loadError && <p className="error">{loadError}</p>}
      <div className="card scroll">
        <table>
          <thead><tr><th>Child</th><th>Age</th><th>Latest level</th><th>Plans</th><th>Last plan</th></tr></thead>
          <tbody>
            {data?.map(c => (
              <tr key={c.id} className="link" onClick={() => go('/therapy/' + c.id)}>
                <td><b>{c.name}</b></td><td>{c.age || '—'}</td><td>{c.last_level || '—'}</td><td>{c.plans}</td><td>{fmt(c.last_plan_at)}</td>
              </tr>
            ))}
            {data?.length === 0 && <tr><td colSpan="5" className="muted">No children yet. Add one to start planning.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const List = ({ title, items }) => items?.length ? <><h4>{title}</h4><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></> : null

function Plan({ t, reload }) {
  const p = t.plan
  const [outcome, setOutcome] = useState(t.outcome || '')
  const { run, error, busy } = useAction()
  return (
    <div className="card">
      <p className="muted">{fmt(t.created_at)} · {areaName(t.area)} · level then: <i>{t.current_level}</i></p>
      <p>{p.summary}</p>
      <p><b>Next 3-month goal:</b> {p.next_goal}</p>
      <List title="Steps" items={p.steps} />
      <List title="Activities" items={p.activities} />
      <List title="Home practice" items={p.home_practice} />
      {p.if_stuck?.length > 0 && <><h4>If the child gets stuck</h4><ul>{p.if_stuck.map((x, i) => <li key={i}><b>{x.problem}</b> → {x.try}</li>)}</ul></>}
      <List title="Check at review" items={p.review_in_3_months_check} />
      <label>Outcome after 3 months <small className="muted">(feeds the next plan)</small>
        <textarea rows={2} value={outcome} onChange={e => setOutcome(e.target.value)} placeholder="Goal achieved? Partly? What does the child say or do now?" />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="ghost" disabled={busy} onClick={() => run(async () => { await api('/therapy/plans/' + t.id, { method: 'PATCH', body: { outcome } }); reload() })}>Save outcome</button>
    </div>
  )
}

export function TherapyChild({ id }) {
  const [data, reload, loadError] = useApi('/therapy/children/' + id)
  const { run, error, busy } = useAction()
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return <p className="muted">Loading…</p>
  const { child, plans } = data
  const submit = e => { const body = formData(e); run(async () => { await api(`/therapy/children/${id}/plan`, { body }); reload() }) }
  return (
    <section>
      <div className="back-nav"><a className="button soft back-btn" href="#/therapy">← Back to children</a></div>
      <h2>{child.name}</h2>
      <p className="muted">{child.age}{child.notes && ' · ' + child.notes}</p>
      <form className="card grid" onSubmit={submit}>
        <h3 className="wide">New 3-month plan</h3>
        <label>Area<Select name="area" options={AREAS} blank={null} /></label>
        <label>Language<Select name="lang" options={[['en', 'English'], ['ur', 'Roman Urdu']]} blank={null} /></label>
        <label className="wide">Where is the child now? *<input name="current" required maxLength={500} placeholder="e.g. says only 'I food'" /></label>
        <label className="wide">Problems / concerns<textarea name="concerns" rows={2} maxLength={1000} placeholder="e.g. gets frustrated, doesn't imitate (optional)" /></label>
        {error && <p className="error wide">{error}</p>}
        <div className="wide row"><button disabled={busy}>{busy ? 'Thinking…' : 'Get next-step plan'}</button></div>
      </form>
      {plans.map(t => <Plan key={t.id} t={t} reload={reload} />)}
    </section>
  )
}
