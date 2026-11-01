import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, go } from './api.js'
import { Select, When } from './Leads.jsx'

// The catalogue is company-wide: one list of universities and courses that every counsellor sells from,
// so two people working the same student quote the same tuition and the same entry requirements.
const fee = p => (p.tuition == null ? 'fee on request' : `${p.currency || 'GBP'} ${Number(p.tuition).toLocaleString('en-PK')}`)

export default function Universities({ query }) {
  const params = new URLSearchParams(query)
  const [f, setF] = useState({ q: params.get('q') || '', country: '', active: '' })
  const [adding, setAdding] = useState(params.has('new'))
  const [data, reload] = useApi('/edu/universities?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString())
  const set = k => e => setF({ ...f, [k]: e.target.value })
  const hasFilters = !!(f.q || f.country || f.active)

  return (
    <section>
      <div className="row between">
        <h2>Universities {data && <span className="count">{data.rows.length}</span>}</h2>
        <button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ Add university'}</button>
      </div>
      {adding && <NewUniversity onDone={() => { setAdding(false); reload() }} />}
      <div className="filters">
        <input placeholder="Search name, city, note…" value={f.q} onChange={set('q')} />
        <Select value={f.country} onChange={set('country')} options={(data?.countries || []).map(c => [c.country, `${c.country} (${c.n})`])} blank="Every country" />
        <Select value={f.active} onChange={set('active')} options={[['0', 'Switched off only']]} blank="Active only" />
        {hasFilters && <button type="button" className="ghost" onClick={() => setF({ q: '', country: '', active: '' })}>✕ Reset filters</button>}
      </div>
      <div className="card scroll">
        <table>
          <thead><tr><th>University</th><th>Country</th><th>Courses</th><th>Campuses</th><th>Applications</th><th>Students</th><th>Added</th></tr></thead>
          <tbody>
            {data?.rows.map(u => (
              <tr key={u.id} onClick={() => go('/universities/' + u.id)} className="link">
                <td><b>{u.name}</b>{u.city && <small className="muted"><br />{u.city}</small>}{u.ranking && <small className="muted"> · {u.ranking}</small>}</td>
                <td>{u.country}</td>
                <td>{u.programs}{!u.programs && <span className="warn"> none</span>}</td>
                <td>{u.campuses}</td>
                <td>{u.applications}</td>
                <td>{u.students}</td>
                <When d={u.created_at} />
              </tr>
            ))}
            {data?.rows.length === 0 && <tr><td colSpan="7" className="muted">
              {f.active === '0' ? 'Nothing has been switched off.' : 'No universities yet. Add the ones you place students with, then the courses you sell.'}
            </td></tr>}
          </tbody>
        </table>
      </div>
      {data && !data.rows.length && !f.active && <p className="muted">Courses a student can apply to only exist under a university, so start there.</p>}
      <p className="muted">The country list itself is edited in Settings › edu_countries.</p>
    </section>
  )
}

function NewUniversity({ onDone }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const submit = e => {
    const body = formData(e)
    run(async () => go('/universities/' + (await api('/edu/universities', { body })).id))
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">Add a university</h3>
      <label>Name *<input name="name" required placeholder="University of Leeds" /></label>
      <label>Country *<Select name="country" options={m.settings.edu_countries} required /></label>
      <label>City<input name="city" /></label>
      <label>Ranking<input name="ranking" placeholder="top 100" /></label>
      <label className="wide">Website<input name="website" placeholder="https://…" /></label>
      <label className="wide">Note<textarea name="note" rows="2" placeholder="agent deals, scholarship cut-offs, deadlines" /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Save university</button><button type="button" className="ghost" onClick={onDone}>Cancel</button></div>
    </form>
  )
}

export function University({ id }) {
  const [data, reload, loadError] = useApi('/edu/universities/' + id)
  const [adding, setAdding] = useState(false)
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return <p className="muted">Loading…</p>
  const { university: u, campuses, programs } = data
  return (
    <section>
      <div className="back-nav"><a className="button soft back-btn" href="#/universities">← Back to universities</a></div>
      <div className="row between lead-header">
        <div>
          <h2>{u.name}{!u.active && <span className="warn"> · switched off</span>}</h2>
          <p className="muted">
            {u.country}{u.city && ` · ${u.city}`}{u.ranking && ` · ${u.ranking}`}
            {' '}· {programs.filter(p => p.active).length} live course{programs.length === 1 ? '' : 's'}
            {' '}· {u.applications} application{u.applications === 1 ? '' : 's'} from {u.students} student{u.students === 1 ? '' : 's'}
          </p>
        </div>
        <div className="row">
          {u.website && <a className="button ghost" href={/^https?:/.test(u.website) ? u.website : 'https://' + u.website} target="_blank" rel="noreferrer">Website</a>}
          <a className="button soft" href={`#/applications?university_id=${u.id}`}>Applications</a>
        </div>
      </div>
      {u.note && <div className="card banner">{u.note}</div>}
      <div className="cols">
        <div>
          <div className="row between">
            <h3>Courses</h3>
            <button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ New course'}</button>
          </div>
          {adding && <CourseForm uni={u} campuses={campuses} onDone={() => { setAdding(false); reload() }} />}
          {programs.length === 0 && !adding && <p className="card muted">No courses here yet. A counsellor cannot open an application until there is one.</p>}
          <div className="card scroll">
            <table>
              <thead><tr><th>Course</th><th>Level</th><th>Fee</th><th>Length</th><th>Intakes</th><th>Entry</th><th>Cases</th></tr></thead>
              <tbody>
                {programs.map(p => <CourseRow key={p.id} p={p} campuses={campuses} uni={u} reload={reload} />)}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <UniForm u={u} reload={reload} />
          <Campuses u={u} campuses={campuses} reload={reload} />
        </div>
      </div>
    </section>
  )
}

function CourseRow({ p, campuses, uni, reload }) {
  const { run, error, busy, setError } = useAction()
  const [editing, setEditing] = useState(false)
  const toggle = () => {
    setError('')
    run(async () => { await api(`/edu/programs/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); reload() })
  }
  const remove = () => {
    const reason = prompt(`Why is ${p.name} being removed?`)
    if (!reason) return
    run(async () => { await api(`/edu/programs/${p.id}`, { method: 'DELETE', body: { reason } }); reload() })
  }
  return (
    <>
      <tr className={p.active ? '' : 'muted'}>
        <td><b>{p.name}</b>{p.campus && <small className="muted"><br />{p.campus}</small>}{p.field && <small className="muted"> · {p.field}</small>}</td>
        <td>{p.level || '—'}</td>
        <td className="nowrap">{fee(p)}{p.active ? '' : ' · off'}</td>
        <td>{p.duration_months ? `${p.duration_months} months` : '—'}</td>
        <td>{p.intakes || '—'}</td>
        <td>{p.ielts_min ? `IELTS ${p.ielts_min}` : '—'}</td>
        <td className="nowrap">
          {p.applications}
          {' '}<button className="ghost mini-btn" onClick={() => { setEditing(!editing); setError('') }} disabled={busy}>{editing ? 'Close' : 'Edit'}</button>
        </td>
      </tr>
      {editing && (
        <tr><td colSpan="7">
          <CourseForm uni={uni} program={p} campuses={campuses} onDone={() => { setEditing(false); reload() }} />
          <div className="row">
            <button className="ghost mini-btn" onClick={toggle} disabled={busy}>{p.active ? 'Switch off' : 'Switch back on'}</button>
            {!p.applications && <button className="ghost mini-btn danger" onClick={remove} disabled={busy}>Delete</button>}
            {error && <span className="error">{error}</span>}
          </div>
          {!p.applications && <p className="muted">Switching off hides it from the course picker without losing the fee and entry rules you typed in.</p>}
        </td></tr>
      )}
    </>
  )
}

export function CourseForm({ uni, program, campuses = [], onDone }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const submit = e => {
    const body = { ...formData(e), university_id: uni.id }
    run(async () => {
      if (program) await api(`/edu/programs/${program.id}`, { method: 'PATCH', body })
      else await api('/edu/programs', { body })
      onDone()
    })
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">{program ? `Edit ${program.name}` : `New course at ${uni.name}`}</h3>
      <label>Course name *<input name="name" defaultValue={program?.name} required placeholder="MSc Data Science" /></label>
      <label>Level<Select name="level" options={m.settings.edu_levels} defaultValue={program?.level ?? ''} /></label>
      <label>Field<input name="field" defaultValue={program?.field ?? ''} placeholder="Computing" /></label>
      <label>Tuition<input name="tuition" type="number" step="500" min="0" defaultValue={program?.tuition ?? ''} placeholder="24000" /></label>
      <label>Currency<Select name="currency" options={['GBP', 'USD', 'EUR', 'AUD', 'CAD', 'AED', 'PKR']} defaultValue={program?.currency ?? 'GBP'} blank={null} /></label>
      <label>Length (months)<input name="duration_months" type="number" min="0" defaultValue={program?.duration_months ?? ''} /></label>
      <label>Min IELTS<input name="ielts_min" type="number" step="0.5" min="0" max="9" defaultValue={program?.ielts_min ?? ''} /></label>
      <label className="wide">Intakes <small className="muted">(comma separated)</small>
        <input name="intakes" defaultValue={program?.intakes ?? ''} placeholder={m.settings.edu_intakes.slice(0, 2).join(', ')} /></label>
      {campuses.length > 0 && <label>Campus<Select name="campus_id" options={campuses.map(c => [c.id, c.name])} defaultValue={program?.campus_id ?? ''} blank="Not campus-specific" /></label>}
      <label className="wide">Eligibility<textarea name="eligibility" rows="2" defaultValue={program?.eligibility ?? ''} placeholder="2:1 in any discipline, 2 years of work experience" /></label>
      <label className="wide">Documents required<textarea name="requirements" rows="2" defaultValue={program?.requirements ?? ''} placeholder="transcripts, IELTS, passport, SOP, 2 LORs" /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>{program ? 'Save course' : 'Add course'}</button><button type="button" className="ghost" onClick={onDone}>Cancel</button></div>
    </form>
  )
}

function UniForm({ u, reload }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [saved, setSaved] = useState(false)
  const submit = e => {
    run(async () => { await api(`/edu/universities/${u.id}`, { method: 'PATCH', body: formData(e) }); setSaved(true); reload() })
  }
  const remove = () => {
    const reason = prompt(`Why is ${u.name} being removed?`)
    if (!reason) return
    run(async () => { await api(`/edu/universities/${u.id}`, { method: 'DELETE', body: { reason } }); go('/universities') })
  }
  const switchOff = () => run(async () => { await api(`/edu/universities/${u.id}`, { method: 'PATCH', body: { active: !u.active } }); reload() })
  return (
    <form className="card grid" onSubmit={submit} onChange={() => setSaved(false)}>
      <h3 className="wide">University details</h3>
      <label>Name *<input name="name" defaultValue={u.name} required /></label>
      <label>Country *<Select name="country" options={m.settings.edu_countries} defaultValue={u.country} blank={null} required /></label>
      <label>City<input name="city" defaultValue={u.city ?? ''} /></label>
      <label>Ranking<input name="ranking" defaultValue={u.ranking ?? ''} /></label>
      <label className="wide">Website<input name="website" defaultValue={u.website ?? ''} /></label>
      <label className="wide">Note<textarea name="note" rows="2" defaultValue={u.note ?? ''} /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row">
        <button disabled={busy}>Save</button>{saved && <span className="ok">Saved</span>}
        <button type="button" className="ghost" onClick={switchOff} disabled={busy}>{u.active ? 'Switch off' : 'Switch back on'}</button>
        {!u.applications && <button type="button" className="ghost danger" onClick={remove} disabled={busy}>Delete</button>}
      </div>
      {!!u.applications && <p className="wide muted">{u.applications} application{u.applications === 1 ? '' : 's'} reference{u.applications === 1 ? 's' : ''} this record, so it cannot be deleted — switch it off instead.</p>}
    </form>
  )
}

function Campuses({ u, campuses, reload }) {
  const { run, error, busy } = useAction()
  const submit = e => {
    run(async () => { await api(`/edu/universities/${u.id}/campuses`, { body: formData(e) }); e.target.reset(); reload() })
  }
  const remove = c => !c.programs && confirm(`Remove the ${c.name} campus?`) &&
    run(async () => { await api(`/edu/campuses/${c.id}`, { method: 'DELETE' }); reload() })
  return (
    <div className="card">
      <h3>Campuses <small className="muted">{campuses.length} on file</small></h3>
      {campuses.map(c => (
        <p key={c.id}>
          <b>{c.name}</b>{c.city && <small className="muted"> · {c.city}</small>}
          <small className="muted"> · {c.programs} course{c.programs === 1 ? '' : 's'}</small>
          {c.note && <small className="muted"><br />{c.note}</small>}
          {' '}<button className="ghost mini-btn danger" onClick={() => remove(c)} disabled={busy || !!c.programs}>Remove</button>
        </p>
      ))}
      {campuses.length === 0 && <p className="muted">No campuses yet. One university can teach in several cities, and a course is attached to one of them.</p>}
      <form onSubmit={submit}>
        <div className="row">
          <input name="name" placeholder="Campus name *" required style={{ flex: 1 }} />
          <input name="city" placeholder="City" />
          <button disabled={busy}>Add</button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
