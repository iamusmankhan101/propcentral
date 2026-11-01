import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, fmt, go, phone } from './api.js'
import { Select, When, Status } from './Leads.jsx'

// An application is a case with a university, not a step on the student's journey: one student runs
// several at the same time and each has its own status, reference number and decision date.
const OFFER = ['Conditional offer', 'Unconditional offer', 'Accepted']
const fee = a => (a.tuition == null ? 'fee on request' : `${a.currency || 'GBP'} ${Number(a.tuition).toLocaleString('en-PK')}`)

export default function Applications({ query }) {
  const m = useMeta()
  const params = new URLSearchParams(query)
  const [f, setF] = useState({ q: params.get('q') || '', status: '', country: '', university_id: params.get('university_id') || '' })
  const [view, setView] = useState(() => { try { return localStorage.eduAppView || 'board' } catch { return 'board' } })
  const [adding, setAdding] = useState(params.has('new'))
  const board = view === 'board'
  const pick = v => { setView(v); setF({ ...f, status: '' }); try { localStorage.eduAppView = v } catch { /* private mode */ } }
  const [data, reload] = useApi('/edu/applications?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString())
  const unis = useApi('/edu/universities')[0]
  const uni = unis?.rows.find(u => u.id === +f.university_id)
  const set = k => e => setF({ ...f, [k]: e.target.value })
  const hasFilters = !!(f.q || f.status || f.country || f.university_id)

  return (
    <section>
      <div className="row between">
        <h2>Applications {data && <span className="count">{data.total}</span>}</h2>
        <div className="row">
          <div className="seg small">{[['board', 'Pipeline'], ['table', 'Table']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => pick(k)}>{l}</button>)}</div>
          <button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ New case'}</button>
        </div>
      </div>
      {adding && <NewCase onDone={() => { setAdding(false); reload() }} />}
      <div className="filters">
        <input placeholder="Search student, course, university…" value={f.q} onChange={set('q')} />
        {!board && <Select value={f.status} onChange={set('status')} options={(data?.statuses || []).map(s => [s.status, `${s.status} (${s.n})`])} blank="Any status" />}
        <Select value={f.country} onChange={set('country')} options={m.settings.edu_countries} blank="Any country" />
        {f.university_id && <span className="chip-item">{uni?.name || 'University'}<button onClick={() => setF({ ...f, university_id: '' })}>×</button></span>}
        {hasFilters && <button type="button" className="ghost" onClick={() => setF({ q: '', status: '', country: '', university_id: '' })}>✕ Reset filters</button>}
      </div>
      {board ? <Pipeline data={data} reload={reload} /> : <>
        <div className="card scroll">
          <table>
            <thead><tr><th>Student</th><th>Course</th><th>University</th><th>Status</th><th>Ref</th><th>Sent</th><th>Decision</th><th>Counselor</th></tr></thead>
            <tbody>
              {data?.rows.map(a => (
                <tr key={a.id} onClick={() => go('/students/' + a.student_id)} className="link">
                  <td><b>{a.student_name}</b><small className="muted"><br />{phone(a.phone)}</small></td>
                  <td>{a.program}{a.level && <small className="muted"> · {a.level}</small>}<small className="muted"><br />{fee(a)}</small></td>
                  <td>{a.university}<small className="muted"><br />{a.country}</small></td>
                  <td><Status s={a.status} /></td>
                  <td>{a.ref || '—'}</td>
                  <When d={a.submitted_at} />
                  <When d={a.decision_at} />
                  <td>{a.counselor_name || <span className="warn">Unassigned</span>}</td>
                </tr>
              ))}
              {data?.rows.length === 0 && <tr><td colSpan="8" className="muted">
                {hasFilters ? 'No application matches those filters.' : 'No applications yet. Open one from a student page once a course exists.'}
              </td></tr>}
            </tbody>
          </table>
        </div>
        {data?.total > data?.rows.length && <p className="muted">Showing the {data.rows.length} newest of {data.total} cases. Filter by status or country to see the rest.</p>}
      </>}
    </section>
  )
}

// One column per status; drag a case along the wall and the university record moves with it.
function Pipeline({ data, reload }) {
  const { settings: s } = useMeta()
  const { run, error, busy, setError } = useAction()
  const [over, setOver] = useState(null)
  if (!data) return <p className="muted">Loading…</p>
  const drop = status => e => {
    e.preventDefault(); setOver(null); setError('')
    const a = data.rows.find(x => x.id === +e.dataTransfer.getData('text/plain'))
    if (!a || a.status === status) return
    run(async () => { await api(`/edu/applications/${a.id}`, { method: 'PATCH', body: { status } }); reload() })
  }
  return (
    <>
      {error && <p className="error">{error}</p>}
      <div className={'board-cols' + (busy ? ' busy' : '')}>
        {s.edu_application_statuses.map(status => {
          const list = data.rows.filter(a => a.status === status)
          return (
            <div key={status} className={'board-col' + (over === status ? ' over' : '')}
              onDragOver={e => { e.preventDefault(); setOver(status) }} onDragLeave={() => setOver(o => (o === status ? null : o))} onDrop={drop(status)}>
              <div className="row between board-col-header"><Status s={status} /><b className="count dark">{list.length}</b></div>
              {list.length === 0 ? <div className="board-empty-hint">Drop cases here</div> : list.map(a => (
                <a key={a.id} href={'#/students/' + a.student_id} className="board-card" draggable onDragStart={e => e.dataTransfer.setData('text/plain', a.id)}>
                  <b>{a.student_name}</b>
                  <small className="board-phone">{a.program}</small>
                  <small className="muted">{a.university} · {a.country}</small>
                  <small className="muted">{a.level ? `${a.level} · ` : ''}{fee(a)}</small>
                  {a.ref && <small className="muted">ref {a.ref}</small>}
                  {a.counselor_name ? <small className="board-agent">👤 {a.counselor_name}</small> : <small className="warn">⚠️ Unassigned</small>}
                </a>
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}

function NewCase({ onDone }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [level, setLevel] = useState('')
  const students = useApi('/edu/students?size=200')[0]
  const programs = useApi('/edu/programs' + (level ? '?level=' + encodeURIComponent(level) : ''))[0]
  const submit = e => {
    const body = formData(e)
    run(async () => { await api('/edu/applications', { body }); onDone() })
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">New application</h3>
      <label>Student *<Select name="student_id" options={(students?.rows || []).map(x => [x.id, `${x.name} · ${x.stage}`])} blank="Which student?" required /></label>
      <label>Level<select value={level} onChange={e => setLevel(e.target.value)}><option value="">Any level</option>{m.settings.edu_levels.map(l => <option key={l}>{l}</option>)}</select></label>
      <label className="wide">Course *<Select name="program_id" options={(programs?.rows || []).map(p => [p.id, `${p.name} — ${p.university} (${p.country}) · ${fee(p)}`])} blank={programs ? 'Which course?' : 'Loading courses…'} required /></label>
      <label>Status<Select name="status" options={m.settings.edu_application_statuses} blank="Ready" /></label>
      <label>University ref<input name="ref" placeholder="as printed by the university" /></label>
      <label className="wide">Note<input name="note" placeholder="why this course, anything to chase" /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Open application</button><button type="button" className="ghost" onClick={onDone}>Cancel</button></div>
    </form>
  )
}

export function StudentApplications({ student, applications, reload }) {
  const offers = applications.filter(a => OFFER.includes(a.status)).length
  return (
    <div className="card">
      <h3>Applications <small className="muted">{applications.length} case{applications.length === 1 ? '' : 's'}{offers ? ` · ${offers} with an offer` : ''}</small></h3>
      {applications.map(a => <ApplicationRow key={a.id} a={a} reload={reload} />)}
      {applications.length === 0 && <p className="muted">Nothing applied to yet. One student can hold several applications at once — a separate case per course.</p>}
      <ApplyCard student={student} applications={applications} reload={reload} />
    </div>
  )
}

function ApplicationRow({ a, reload }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [open, setOpen] = useState(false)
  const move = status => { if (status === a.status) return; run(async () => { await api(`/edu/applications/${a.id}`, { method: 'PATCH', body: { status } }); reload() }) }
  const save = e => {
    const body = formData(e)
    run(async () => { await api(`/edu/applications/${a.id}`, { method: 'PATCH', body }); setOpen(false); reload() })
  }
  const remove = () => {
    const reason = prompt(`Why is the application to ${a.program} being removed?`)
    if (!reason) return
    run(async () => { await api(`/edu/applications/${a.id}`, { method: 'DELETE', body: { reason } }); reload() })
  }
  return (
    <div className="app-row">
      <b>{a.program}</b> · <a href={'#/universities/' + a.university_id}>{a.university}</a> <small className="muted">({a.country})</small> <Status s={a.status} />
      <small className="muted"><br />{a.level || '—'} · {fee(a)}{a.intakes && ` · ${a.intakes}`}</small>
      {a.ref && <small className="muted"><br />ref {a.ref}</small>}
      {(a.submitted_at || a.decision_at) && <small className="muted"><br />sent {fmt(a.submitted_at)}{a.decision_at && ` · decision ${fmt(a.decision_at)}`}</small>}
      {a.note && <small className="muted"><br />{a.note}</small>}
      <div className="row">
        <Select value={a.status} onChange={e => move(e.target.value)} options={m.settings.edu_application_statuses} blank={null} />
        <button className="ghost mini-btn" onClick={() => setOpen(!open)} disabled={busy}>{open ? 'Close' : 'Details'}</button>
        <button className="ghost mini-btn danger" onClick={remove} disabled={busy}>Remove</button>
      </div>
      {open && <form className="grid" onSubmit={save}>
        <label>University ref<input name="ref" defaultValue={a.ref ?? ''} /></label>
        <label>Offer<Select name="offer_type" options={['conditional', 'unconditional', 'scholarship', 'rejected']} defaultValue={a.offer_type ?? ''} blank="None yet" /></label>
        <label className="wide">Note<textarea name="note" rows="2" defaultValue={a.note ?? ''} /></label>
        {error && <p className="error wide">{error}</p>}
        <div className="wide row"><button disabled={busy}>Save case</button></div>
      </form>}
    </div>
  )
}

function ApplyCard({ student, applications, reload }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [level, setLevel] = useState(student.target_level || '')
  const programs = useApi('/edu/programs' + (level ? '?level=' + encodeURIComponent(level) : ''))[0]
  const submit = e => {
    const body = formData(e)
    run(async () => { await api('/edu/applications', { body: { ...body, student_id: student.id } }); e.target.reset(); reload() })
  }
  const applied = new Set(applications.map(a => a.program_id))
  return (
    <form onSubmit={submit}>
      <div className="row">
        <label>Level<select value={level} onChange={e => setLevel(e.target.value)}><option value="">Any level</option>{m.settings.edu_levels.map(l => <option key={l}>{l}</option>)}</select></label>
        <label style={{ flex: 1 }}>Course *<Select name="program_id" options={(programs?.rows || []).map(p => [p.id, `${p.name}${applied.has(p.id) ? ' (already applied)' : ''} — ${p.university} (${p.country}) · ${fee(p)}`])} blank={programs ? 'Which course?' : 'Loading courses…'} required /></label>
        <button disabled={busy}>Apply</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
