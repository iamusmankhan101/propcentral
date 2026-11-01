import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, fmt, toIso, go, phone, readFile, shrinkImage } from './api.js'
import { Select, When, Status } from './Leads.jsx'
import { StudentApplications } from './EduApplications.jsx'

const docLabel = t => (t || '').replace(/_/g, ' ')
const due = d => d && d < new Date().toISOString()

// Passports and CNICs never get a bare-token URL, so the file comes back through the session header
// and opens from a blob the browser keeps for a minute.
async function openDoc(d) {
  const r = await fetch('/api/edu/documents/' + d.id + '/file', { headers: { authorization: 'Bearer ' + (localStorage.token || '') } })
  if (r.status === 401) { delete localStorage.token; location.reload(); return }
  if (!r.ok) throw new Error(r.status === 403 ? 'This document belongs to a student outside your reach.' : 'Could not open the file.')
  const url = URL.createObjectURL(await r.blob())
  Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noreferrer' }).click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

export default function Students({ query }) {
  const m = useMeta()
  const s = m.settings
  const params = new URLSearchParams(query)
  const [f, setF] = useState({ q: params.get('q') || '', stage: '', counselor_id: '', missing_docs: '', followup: '', page: 0 })
  const [view, setView] = useState(() => { try { return localStorage.eduView || 'board' } catch { return 'board' } })
  const board = view === 'board'
  const pick = v => { setView(v); try { localStorage.eduView = v } catch { /* private mode */ } }
  const qs = new URLSearchParams(Object.entries({ ...f, size: board ? 200 : 50 }).filter(([, v]) => v !== '')).toString()
  const [data, reload] = useApi('/edu/students?' + qs)
  const [adding, setAdding] = useState(params.has('new'))
  const set = k => e => setF({ ...f, [k]: e.target.value, page: 0 })
  const counselors = m.users.filter(u => u.active && ['agent', 'team_lead'].includes(u.role)).map(u => [u.id, u.name])
  const hasFilters = !!(f.q || f.stage || f.counselor_id || f.missing_docs || f.followup)

  return (
    <section>
      <div className="row between">
        <h2>Students {data && <span className="count">{data.total}</span>}</h2>
        <div className="row">
          <div className="seg small">{[['board', 'Journey'], ['table', 'Table']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => pick(k)}>{l}</button>)}</div>
          <button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ New student'}</button>
        </div>
      </div>
      {adding && <NewStudent counselors={counselors} onDone={() => { setAdding(false); reload() }} />}
      <div className="filters">
        <input placeholder="Search name, phone, email, college, passport…" value={f.q} onChange={set('q')} />
        {!board && <Select value={f.stage} onChange={set('stage')} options={s.edu_stages} blank="Any stage" />}
        {m.me.role !== 'agent' && <Select value={f.counselor_id} onChange={set('counselor_id')} options={counselors} blank="Any counselor" />}
        <Select value={f.missing_docs} onChange={set('missing_docs')} options={[['1', 'No documents yet']]} blank="Any paperwork" />
        <Select value={f.followup} onChange={set('followup')} options={[['1', 'Follow-up due']]} blank="Any follow-up" />
        {hasFilters && <button type="button" className="ghost" onClick={() => setF({ q: '', stage: '', counselor_id: '', missing_docs: '', followup: '', page: 0 })}>✕ Reset filters</button>}
      </div>
      {board ? <Journey data={data} reload={reload} /> : <>
        <div className="card scroll">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Stage</th><th>Studied</th><th>Target</th><th>Docs</th><th>Cases</th><th>Counselor</th><th>Next follow-up</th><th>Added</th></tr></thead>
            <tbody>
              {data?.rows.map(r => (
                <tr key={r.id} onClick={() => go('/students/' + r.id)} className="link">
                  <td><div className="who"><span className="avatar sm">{r.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</span><div><b>{r.name}</b><small className="muted">{r.current_level || '—'}</small></div></div></td>
                  <td className="nowrap">{phone(r.phone)}</td>
                  <td><Status s={r.stage} /></td>
                  <td>{r.institution || '—'}{r.graduate_year && <small className="muted"> · {r.graduate_year}</small>}</td>
                  <td>{r.target_level || '—'}{r.target_countries && <small><br />{r.target_countries}</small>}{r.intake && <small className="muted"><br />{r.intake}</small>}</td>
                  <td>{r.documents} <small className={r.unverified ? 'warn' : 'muted'}>({r.unverified} to verify)</small></td>
                  <td>{r.applications ? <span>{r.applications}{r.offers ? <small className="ok"> · {r.offers} offer{r.offers === 1 ? '' : 's'}</small> : null}</span> : <span className="muted">none</span>}</td>
                  <td>{r.counselor_name || <span className="warn">Unassigned</span>}</td>
                  <When d={r.next_action_at} className={due(r.next_action_at) ? 'warn' : ''} />
                  <When d={r.stage_at} />
                </tr>
              ))}
              {data?.rows.length === 0 && <tr><td colSpan="10" className="muted">No students yet. Add one, or promote a lead from its page.</td></tr>}
            </tbody>
          </table>
        </div>
        {data?.total > 50 && (
          <div className="row">
            <button className="ghost" disabled={!f.page} onClick={() => setF({ ...f, page: f.page - 1 })}>← Prev</button>
            <span className="muted">Page {f.page + 1} of {Math.ceil(data.total / 50)}</span>
            <button className="ghost" disabled={(f.page + 1) * 50 >= data.total} onClick={() => setF({ ...f, page: f.page + 1 })}>Next →</button>
          </div>
        )}
      </>}
    </section>
  )
}

// The admission journey: one column per stage, drag a student to move them. Same rules as the lead board.
function Journey({ data, reload }) {
  const { settings: s } = useMeta()
  const { run, error, busy, setError } = useAction()
  const [over, setOver] = useState(null)
  if (!data) return <p className="muted">Loading…</p>
  const drop = stage => e => {
    e.preventDefault(); setOver(null); setError('')
    const student = data.rows.find(x => x.id === +e.dataTransfer.getData('text/plain'))
    if (!student || student.stage === stage) return
    run(async () => { await api(`/edu/students/${student.id}`, { method: 'PATCH', body: { stage } }); reload() })
  }
  return (
    <>
      {error && <p className="error">{error}</p>}
      {data.total > data.rows.length && <p className="muted">Showing the newest {data.rows.length} of {data.total} students. Use the filters to narrow it down.</p>}
      <div className={'board-cols' + (busy ? ' busy' : '')}>
        {s.edu_stages.map(stage => {
          const list = data.rows.filter(x => x.stage === stage)
          return (
            <div key={stage} className={'board-col' + (over === stage ? ' over' : '')}
              onDragOver={e => { e.preventDefault(); setOver(stage) }} onDragLeave={() => setOver(o => (o === stage ? null : o))} onDrop={drop(stage)}>
              <div className="row between board-col-header"><Status s={stage} /><b className="count dark">{list.length}</b></div>
              {list.length === 0 ? (
                <div className="board-empty-hint">Drop students here</div>
              ) : list.map(x => (
                <a key={x.id} href={'#/students/' + x.id} className="board-card" draggable onDragStart={e => e.dataTransfer.setData('text/plain', x.id)}>
                  <b>{x.name}</b>
                  <small className="board-phone">{phone(x.phone)}</small>
                  <small className="muted">{x.target_level || 'No target'}{x.target_countries ? ` · ${x.target_countries}` : ''}{x.intake ? ` · ${x.intake}` : ''}</small>
                  <small>{x.counselor_name ? <span className="board-agent">👤 {x.counselor_name}</span> : <span className="warn">⚠️ Unassigned</span>}</small>
                  {x.documents === 0 && <small className="warn">📄 No documents</small>}
                  {x.applications > 0 && <small className="muted">🎓 {x.applications} application{x.applications === 1 ? '' : 's'}{x.offers ? ` · ${x.offers} offer${x.offers === 1 ? '' : 's'}` : ''}</small>}
                  {x.next_action_at && <small className={'board-due ' + (due(x.next_action_at) ? 'warn' : 'muted')}>📅 {fmt(x.next_action_at)}</small>}
                </a>
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}

function NewStudent({ counselors, onDone }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const submit = e => {
    const body = formData(e)
    run(async () => go('/students/' + (await api('/edu/students', { body })).id))
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">New student</h3>
      <label>Name *<input name="name" required /></label>
      <label>Phone *<input name="phone" required placeholder="03xx xxxxxxx" /></label>
      <label>Email<input name="email" type="email" /></label>
      <label>City<input name="city" /></label>
      <label>Studied<Select name="current_level" options={m.settings.edu_levels} /></label>
      <label>Institution<input name="institution" /></label>
      <label>Target<Select name="target_level" options={m.settings.edu_levels} /></label>
      <label>Country<input name="target_countries" placeholder="UK, Canada, Australia" /></label>
      <label>Intake<Select name="intake" options={m.settings.edu_intakes} /></label>
      {m.me.role !== 'agent' && <label>Counselor<Select name="counselor_id" options={counselors} blank="Me" /></label>}
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Create student</button><button type="button" className="ghost" onClick={onDone}>Cancel</button></div>
    </form>
  )
}

export function Student({ id }) {
  const m = useMeta()
  const [data, reload, loadError] = useApi('/edu/students/' + id)
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return <p className="muted">Loading…</p>
  const { student, documents, activities, lead, applications, payments = [] } = data
  const masked = student.phone?.includes('*')

  return (
    <section>
      <div className="back-nav"><a className="button soft back-btn" href="#/students">← Back to students</a></div>
      <div className="row between lead-header">
        <div>
          <h2>{student.name} <Status s={student.stage} /></h2>
          <p className="muted">
            #{student.id} · {student.current_level || 'no background'} → {student.target_level || 'no target'}
            {student.target_countries && ` in ${student.target_countries}`}{student.intake && ` · ${student.intake}`}
            {' '}· {student.counselor_name ? `counsellor ${student.counselor_name}` : 'unassigned'} · in stage since {fmt(student.stage_at)}
          </p>
        </div>
        <div className="row">
          <span className="phone">{phone(student.phone)}</span>
          {!masked && <a className="button" href={'tel:+' + student.phone}>Call</a>}
          {!masked && <a className="button ghost" href={'https://wa.me/' + student.phone} target="_blank" rel="noreferrer">WhatsApp</a>}
        </div>
      </div>
      {lead && <div className="card banner">
        Came from <a href={'#/leads/' + lead.id}>lead #{lead.id}</a> · {lead.source}{lead.campaign && ` / ${lead.campaign}`} · <Status s={lead.status} />
      </div>}

      <div className="cols">
        <div>
          <LogStudentActivity student={student} reload={reload} />
          <h3>Timeline</h3>
          <ul className="timeline card">
            {activities.map(a => (
              <li key={a.id} className={a.type === 'system' ? 'sys' : ''}>
                <div>{a.type !== 'system' && <b>{a.type.replace('_', ' ')}</b>}{a.outcome && ` · ${a.outcome}`} <small className="muted">{a.user_name || 'System'} · {fmt(a.created_at)}</small></div>
                {a.notes && <div>{a.notes}</div>}
                {a.next_action_at && <small className="muted">Next: {a.next_action || 'follow up'} on {fmt(a.next_action_at)}</small>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <ChangeStage student={student} reload={reload} />
          <StudentApplications student={student} applications={applications} reload={reload} />
          <StudentPayments student={student} payments={payments} reload={reload} />
          <Documents student={student} documents={documents} reload={reload} />
          <StudentProfile student={student} reload={reload} />
        </div>
      </div>
    </section>
  )
}

function ChangeStage({ student, reload }) {
  const { settings: s } = useMeta()
  const { run, error, busy } = useAction()
  const [stage, setStage] = useState(student.stage)
  const submit = e => { e.preventDefault(); run(async () => { await api(`/edu/students/${student.id}`, { method: 'PATCH', body: { stage } }); reload() }) }
  return (
    <form className="card" onSubmit={submit}>
      <h3>Journey stage</h3>
      <Select value={stage} onChange={e => setStage(e.target.value)} options={s.edu_stages} blank={null} />
      {error && <p className="error">{error}</p>}
      <button disabled={busy || stage === student.stage}>Move to {stage}</button>
    </form>
  )
}

function LogStudentActivity({ student, reload }) {
  const { settings: s } = useMeta()
  const { run, error, busy } = useAction()
  const [type, setType] = useState('call')
  const [nextAt, setNextAt] = useState('')
  const submit = e => {
    const form = e.target
    const body = formData(e)
    run(async () => {
      await api(`/edu/students/${student.id}/activity`, { body: { ...body, next_action_at: toIso(body.next_action_at) } })
      form.reset(); setType('call'); setNextAt(''); reload()
    })
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">Log activity</h3>
      <label>Type<Select name="type" value={type} onChange={e => setType(e.target.value)} options={s.activity_types} blank={null} /></label>
      <label>Outcome<Select name="outcome" options={s.outcomes} /></label>
      <label className="wide">Notes *<textarea name="notes" rows="2" required /></label>
      <label>Next action<input name="next_action" placeholder="e.g. share the IELTS prep list" /></label>
      <label>Next follow-up<input name="next_action_at" type="datetime-local" value={nextAt} onChange={e => setNextAt(e.target.value)} /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide"><button disabled={busy}>Save activity</button></div>
    </form>
  )
}

const GROUPS = [['Identity', ['gender', 'dob', 'city', 'passport', 'passport_expiry']],
  ['Background', ['current_level', 'institution', 'graduate_year', 'gpa', 'major']],
  ['Test scores', ['ielts', 'toefl', 'gre', 'gmat']],
  ['Plan', ['target_level', 'target_countries', 'intake']],
  ['Sponsor', ['sponsor_name', 'sponsor_occupation']],
  ['Visa', ['visa_type', 'visa_app_number', 'cas_coe_number', 'embassy_date', 'biometrics_date', 'visa_decision_date', 'visa_outcome', 'visa_expiry']]]
const inputType = f => ({ dob: 'date', passport_expiry: 'date', graduate_year: 'number', gpa: 'number', toefl: 'number', gre: 'number', gmat: 'number',
  embassy_date: 'date', biometrics_date: 'date', visa_decision_date: 'date', visa_expiry: 'date' })[f] || 'text'

function StudentProfile({ student, reload }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [saved, setSaved] = useState(false)
  const submit = e => {
    const body = formData(e)
    run(async () => { await api(`/edu/students/${student.id}`, { method: 'PATCH', body }); setSaved(true); reload() })
  }
  const field = f => (
    <label key={f}>{f.replace(/_/g, ' ')}
      {['current_level', 'target_level'].includes(f)
        ? <Select name={f} options={m.settings.edu_levels} defaultValue={student[f] ?? ''} />
        : f === 'intake' ? <Select name={f} options={m.settings.edu_intakes} defaultValue={student[f] ?? ''} />
        : f === 'visa_outcome' ? <Select name={f} options={m.settings.edu_visa_outcomes || ['Approved', 'Refused', 'Pending', 'Withdrawn']} defaultValue={student[f] ?? ''} blank="Pending / Not applied" />
        : <input name={f} type={inputType(f)} step={f === 'gpa' ? '0.01' : undefined} defaultValue={student[f] ?? ''} />}
    </label>
  )
  return (
    <form className="card grid" onSubmit={submit} onChange={() => setSaved(false)}>
      <h3 className="wide">Student profile</h3>
      <label>Name *<input name="name" defaultValue={student.name} required /></label>
      <label>Email<input name="email" type="email" defaultValue={student.email ?? ''} /></label>
      <label>CNIC<input name="cnic" defaultValue={student.cnic ?? ''} /></label>
      {!student.phone.includes('*') && <label>Alternate phones<input name="alt_phones" defaultValue={student.alt_phones ?? ''} /></label>}
      {GROUPS.map(([title, fields]) => <div className="wide" key={title}><h4 className="muted">{title}</h4><div className="grid">{fields.map(field)}</div></div>)}
      <label className="wide">Remarks<textarea name="remarks" rows="2" defaultValue={student.remarks ?? ''} /></label>
      <label className="wide">Tags<input name="tags" defaultValue={student.tags ?? ''} placeholder="scholarship, needs-visa" /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Save profile</button>{saved && <span className="ok">Saved</span>}</div>
    </form>
  )
}

function Documents({ student, documents, reload }) {
  const m = useMeta()
  const { run, error, busy, setError } = useAction()
  const [type, setType] = useState('passport')
  const submit = e => {
    e.preventDefault()
    const file = e.target.elements.file.files[0]
    if (!file) return setError('Choose a PDF or an image first')
    run(async () => {
      const data = file.type.startsWith('image/') ? await shrinkImage(file, 2000) : await readFile(file)
      await api(`/edu/students/${student.id}/documents`, { body: { type, name: file.name, data } })
      e.target.reset(); setType('passport'); reload()
    })
  }
  const open = d => run(async () => { await openDoc(d) })
  const verify = d => run(async () => { await api(`/edu/documents/${d.id}`, { method: 'PATCH', body: { verified: !d.verified } }); reload() })
  const remove = d => {
    const reason = prompt(`Why is ${docLabel(d.type)} being removed?`)
    if (!reason) return
    run(async () => { await api(`/edu/documents/${d.id}`, { method: 'DELETE', body: { reason } }); reload() })
  }
  const have = new Set(documents.map(d => d.type))
  return (
    <div className="card">
      <h3>Documents <small className="muted">{documents.length} on file, {documents.filter(d => !d.verified).length} to verify</small></h3>
      {documents.map(d => (
        <p key={d.id}>
          <b>{docLabel(d.type)}</b> · <a href="#" onClick={e => { e.preventDefault(); open(d) }}>{d.name || 'open'}</a>
          {' '}<b className={d.verified ? 'ok' : 'warn'}>{d.verified ? 'verified' : 'unverified'}</b>
          {d.notes && <small className="muted"> · {d.notes}</small>}
          <small className="muted"><br />{fmt(d.created_at)}</small>
          {' '}<span className="row"><button className="ghost mini-btn" onClick={() => verify(d)} disabled={busy}>{d.verified ? 'Unverify' : 'Verify'}</button>
            <button className="ghost mini-btn danger" onClick={() => remove(d)} disabled={busy}>Remove</button></span>
        </p>
      ))}
      {documents.length === 0 && <p className="muted">Nothing uploaded yet. A passport and transcripts are the usual first two.</p>}
      <form onSubmit={submit}>
        <div className="row">
          <Select value={type} onChange={e => setType(e.target.value)} options={m.settings.edu_doc_types.map(t => [t, docLabel(t) + (have.has(t) ? ' (already on file)' : '')])} blank={null} />
          <input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf" style={{ flex: 1 }} />
          <button disabled={busy}>Upload</button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  )
}


function StudentPayments({ student, payments = [], reload }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [adding, setAdding] = useState(false)
  const paymentTypes = m.settings.edu_payment_types || ['tuition_deposit', 'visa_fee', 'ielts_fee', 'service_fee', 'scholarship', 'other']

  const submit = e => {
    const body = formData(e)
    run(async () => {
      await api(`/edu/students/${student.id}/payments`, { body })
      setAdding(false)
      reload()
    })
  }

  const remove = p => {
    if (!confirm(`Delete ${p.type.replace(/_/g, ' ')} payment of ${p.currency || 'PKR'} ${Number(p.amount).toLocaleString()}?`)) return
    run(async () => {
      await api(`/edu/payments/${p.id}`, { method: 'DELETE' })
      reload()
    })
  }

  const total = payments.reduce((acc, p) => acc + (p.amount || 0), 0)

  return (
    <div className="card">
      <div className="row between">
        <h3>Fees & Payments <small className="muted">({payments.length} record{payments.length === 1 ? '' : 's'})</small></h3>
        <button className="ghost mini-btn" onClick={() => setAdding(!adding)}>{adding ? 'Close' : '+ Record payment'}</button>
      </div>

      {payments.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {payments.map(p => (
            <p key={p.id}>
              <b>{p.type.replace(/_/g, ' ')}</b> · <span className="ok">{p.currency || 'PKR'} {Number(p.amount).toLocaleString('en-PK')}</span>
              {p.method && <small className="muted"> via {p.method}</small>}
              {p.reference && <small className="muted"> (ref: {p.reference})</small>}
              {p.paid_at && <small className="muted"> · {fmt(p.paid_at)}</small>}
              {p.note && <small className="muted"><br />{p.note}</small>}
              {' '}<button className="ghost mini-btn danger" onClick={() => remove(p)} disabled={busy} style={{ float: 'right' }}>Delete</button>
            </p>
          ))}
          <div className="line-item" style={{ marginTop: 8, borderTop: '1px solid var(--border)' }}>
            <span>Total recorded</span>
            <b>PKR {total.toLocaleString('en-PK')}</b>
          </div>
        </div>
      )}

      {payments.length === 0 && !adding && (
        <p className="muted">No payments or fee records logged yet.</p>
      )}

      {adding && (
        <form className="grid" onSubmit={submit} style={{ marginTop: 8 }}>
          <label>Type *
            <Select name="type" options={paymentTypes.map(t => [t, t.replace(/_/g, ' ')])} blank={null} required />
          </label>
          <label>Amount *
            <input name="amount" type="number" min="1" step="100" required placeholder="50000" />
          </label>
          <label>Currency
            <Select name="currency" options={['PKR', 'GBP', 'USD', 'EUR', 'CAD', 'AUD']} defaultValue="PKR" blank={null} />
          </label>
          <label>Payment method
            <input name="method" placeholder="Bank transfer, Cash, Online" />
          </label>
          <label>Reference #
            <input name="reference" placeholder="Receipt / Cheque / Tx ID" />
          </label>
          <label>Date paid
            <input name="paid_at" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
          </label>
          <label className="wide">Note
            <input name="note" placeholder="Any specific notes regarding this fee" />
          </label>
          {error && <p className="error wide">{error}</p>}
          <div className="wide row">
            <button disabled={busy}>Save payment</button>
            <button type="button" className="ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}
