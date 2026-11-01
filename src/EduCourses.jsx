import { useState } from 'react'
import { useApi, useMeta, go } from './api.js'
import { Select } from './Leads.jsx'
import { CourseForm } from './EduCatalogue.jsx'

const fee = p => (p.tuition == null ? 'on request' : `${p.currency || 'GBP'} ${Number(p.tuition).toLocaleString('en-PK')}`)

// Every course the company can place a student into, across all universities — the page a counsellor
// opens when a student asks "what can I get with my IELTS and my budget?"
export default function Courses({ query }) {
  const m = useMeta()
  const params = new URLSearchParams(query)
  const [f, setF] = useState({ q: params.get('q') || '', level: params.get('level') || '', country: '', intake: '' })
  const [adding, setAdding] = useState(params.has('new'))
  const [data, reload] = useApi('/edu/programs?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString())
  const set = k => e => setF({ ...f, [k]: e.target.value })
  const hasFilters = !!(f.q || f.level || f.country || f.intake)

  return (
    <section>
      <div className="row between">
        <h2>Courses {data && <span className="count">{data.total}</span>}</h2>
        <button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ Add course'}</button>
      </div>
      {adding && <NewCourse onDone={() => { setAdding(false); reload() }} />}
      <div className="filters">
        <input placeholder="Search course, field, university…" value={f.q} onChange={set('q')} />
        <Select value={f.level} onChange={set('level')} options={m.settings.edu_levels} blank="Any level" />
        <Select value={f.country} onChange={set('country')} options={m.settings.edu_countries} blank="Any country" />
        <Select value={f.intake} onChange={set('intake')} options={m.settings.edu_intakes} blank="Any intake" />
        {hasFilters && <button type="button" className="ghost" onClick={() => setF({ q: '', level: '', country: '', intake: '' })}>✕ Reset filters</button>}
      </div>
      <div className="card scroll">
        <table>
          <thead><tr><th>Course</th><th>University</th><th>Country</th><th>Level</th><th>Fee / year</th><th>Length</th><th>Intakes</th><th>Min IELTS</th><th>Cases</th></tr></thead>
          <tbody>
            {data?.rows.map(p => (
              <tr key={p.id} onClick={() => go('/universities/' + p.university_id)} className="link">
                <td><b>{p.name}</b>{p.field && <small className="muted"><br />{p.field}</small>}{p.campus && <small className="muted"> · {p.campus}</small>}</td>
                <td>{p.university}</td>
                <td>{p.country}</td>
                <td>{p.level || '—'}</td>
                <td className="nowrap">{fee(p)}</td>
                <td>{p.duration_months ? `${p.duration_months} mo` : '—'}</td>
                <td>{p.intakes || '—'}</td>
                <td>{p.ielts_min ?? '—'}</td>
                <td>{p.applications}</td>
              </tr>
            ))}
            {data?.rows.length === 0 && <tr><td colSpan="9" className="muted">
              {hasFilters ? 'Nothing matches those filters. Widen them, or add the course.' : 'No courses yet. A course belongs to a university, so add one there or use "+ Add course".'}
            </td></tr>}
          </tbody>
        </table>
      </div>
      {data?.rows.length > 0 && <p className="muted">Eligibility and the documents a course needs are on the university page — open a row to read them.</p>}
    </section>
  )
}

function NewCourse({ onDone }) {
  const [unis] = useApi('/edu/universities')
  const [uniId, setUniId] = useState('')
  const uni = unis?.rows.find(u => u.id === +uniId)
  const page = useApi(uni ? '/edu/universities/' + uni.id : null)[0]
  if (!unis) return <p className="muted">Loading…</p>
  if (!unis.rows.length) return <div className="card">
    <p className="muted">A course always belongs to a university, and there is none yet.</p>
    <a className="button" href="#/universities?new">Add a university</a>
  </div>
  return (
    <>
      <div className="card row">
        <label style={{ flex: 1 }}>University *
          <Select value={uniId} onChange={e => setUniId(e.target.value)} options={unis.rows.map(u => [u.id, `${u.name} (${u.country})`])} blank="Which university?" />
        </label>
      </div>
      {uni && <CourseForm key={uni.id} uni={uni} campuses={page?.campuses || []} onDone={onDone} />}
    </>
  )
}
