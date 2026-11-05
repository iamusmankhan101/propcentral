import { useState } from 'react'
import { api, useApi, useAction, formData, go, fmt } from './api.js'
import { Select, Status } from './Leads.jsx'

const L = ({ title, items }) => items?.length ? <><h4>{title}</h4><ul>{items.map((x, i) => <li key={i}>{typeof x === 'string' ? x : JSON.stringify(x)}</li>)}</ul></> : null
const Err = ({ e }) => e ? <p className="error">{e}</p> : null
const ymd = d => (d || '').slice(0, 10) || '—'
const Stat = ({ label, value }) => <div className="card"><small className="muted">{label}</small><h2 style={{ margin: '4px 0 0' }}>{value ?? '…'}</h2></div>

// ---------- dashboard + children ----------
export default function Therapy() {
  const [dash] = useApi('/therapy/dashboard')
  const [kids, , loadError] = useApi('/therapy/children')
  const [adding, setAdding] = useState(false)
  const { run, error, busy } = useAction()
  const submit = e => { const body = formData(e); body.consent = !!body.consent; run(async () => go('/therapy/' + (await api('/therapy/children', { body })).id)) }
  return (
    <section>
      <div className="row between">
        <h2>Special Needs Therapy</h2>
        <button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ Add child'}</button>
      </div>
      <p className="muted">AI drafts assessments, goals, lessons and reviews from what you record. A professional approves everything. It never diagnoses.</p>
      <div className="grid">
        <Stat label="Children" value={dash?.children} /><Stat label="Active plans" value={dash?.active_plans} />
        <Stat label="Goals in progress" value={dash?.in_progress} /><Stat label="Goals achieved" value={dash?.achieved} />
        <Stat label="Need intervention" value={dash?.needs_intervention} /><Stat label="Reviews due (14 days)" value={dash?.reviews_due} />
        <Stat label="Waiting for approval" value={dash?.pending_approval} />
      </div>
      {adding && (
        <form className="card grid" onSubmit={submit}>
          <h3 className="wide">New child</h3>
          <label>Name *<input name="name" required maxLength={80} /></label>
          <label>Date of birth<input name="dob" type="date" /></label>
          <label>Parent / guardian<input name="guardian" maxLength={80} /></label>
          <label>Guardian phone<input name="guardian_phone" maxLength={30} /></label>
          <label className="wide">Reported difficulties<textarea name="difficulties" rows={2} placeholder="e.g. cannot speak in full sentences, struggles to follow instructions" /></label>
          <label className="wide">Current abilities<textarea name="abilities" rows={2} placeholder="e.g. says 'I food', points to things, follows one-step instructions" /></label>
          <label className="wide"><span><input name="consent" type="checkbox" style={{ width: 'auto' }} /> Guardian has consented to this child's records being kept here</span></label>
          <Err e={error} />
          <div className="wide row"><button disabled={busy}>Create child</button></div>
        </form>
      )}
      <div className="card">
        <h3>Needs attention</h3>
        {dash?.flags.length === 0 && <p className="muted">Nothing flagged. Flags come from your records: reassessment needed, reviews due, no recent sessions.</p>}
        <ul>{dash?.flags.map((f, i) => <li key={i}><a href={'#/therapy/' + f.child_id}>{f.text}</a></li>)}</ul>
      </div>
      <Err e={loadError} />
      <div className="card scroll">
        <table>
          <thead><tr><th>Child</th><th>Age</th><th>Guardian</th><th>Approved goals</th><th>Next review</th><th>Last session</th></tr></thead>
          <tbody>
            {kids?.map(c => (
              <tr key={c.id} className="link" onClick={() => go('/therapy/' + c.id)}>
                <td><b>{c.name}</b></td><td>{c.age ?? '—'}</td><td>{c.guardian || '—'}</td><td>{c.goals}</td><td>{ymd(c.review_date)}</td><td>{ymd(c.last_session)}</td>
              </tr>
            ))}
            {kids?.length === 0 && <tr><td colSpan="6" className="muted">No children yet. Add one to begin with an initial assessment.</td></tr>}
          </tbody>
        </table>
      </div>
      {dash?.recent.length > 0 && <div className="card"><h3>Recent observations</h3>
        <ul>{dash.recent.map(s => <li key={s.id}><a href={'#/therapy/' + s.child_id}><b>{s.child}</b></a> · {s.date}{s.progress && <> · <Status s={s.progress} /></>} {s.response && '— ' + s.response.slice(0, 100)}</li>)}</ul></div>}
    </section>
  )
}

// ---------- one child ----------
const TABS = [['profile', 'Profile & assessment'], ['goals', 'Goals'], ['lessons', 'Lessons'], ['sessions', 'Sessions'], ['review', '3-month review']]

export function TherapyChild({ id }) {
  const [data, reload, loadError] = useApi('/therapy/children/' + id)
  const [tab, setTab] = useState('profile')
  const [lang, setLang] = useState('en')
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return <p className="muted">Loading…</p>
  const { child } = data
  const props = { data, reload, lang, id }
  return (
    <section>
      <div className="back-nav"><a className="button soft back-btn" href="#/therapy">← Back to children</a></div>
      <div className="row between">
        <div><h2>{child.name}</h2><p className="muted">{child.age != null ? child.age + ' years' : 'Age unknown'}{child.guardian && ' · ' + child.guardian}{!child.consent && ' · ⚠ consent not recorded'}</p></div>
        <label>AI language<Select value={lang} onChange={e => setLang(e.target.value)} options={[['en', 'English'], ['ur', 'Roman Urdu']]} blank={null} /></label>
      </div>
      <div className="seg">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'profile' && <Profile {...props} />}
      {tab === 'goals' && <Goals {...props} />}
      {tab === 'lessons' && <Lessons {...props} />}
      {tab === 'sessions' && <Sessions {...props} />}
      {tab === 'review' && <Review {...props} />}
    </section>
  )
}

const FIELDS = [['difficulties', 'Reported difficulties'], ['abilities', 'Current abilities'], ['strengths', 'Strengths and interests'], ['communication', 'Communication abilities'],
  ['learning_prefs', 'Learning preferences'], ['sensory', 'Sensory support needs'], ['history', 'Developmental history & previous assessments']]

function Profile({ data, reload, lang, id }) {
  const { child, assessments } = data
  const save = useAction(), ai = useAction()
  const submit = e => { const body = formData(e); body.consent = !!body.consent; save.run(async () => { await api('/therapy/children/' + id, { method: 'PATCH', body }); reload() }) }
  const assess = e => { const { text } = formData(e); ai.run(async () => { await api(`/therapy/children/${id}/assessment`, { body: { text, lang } }); e.target.reset(); reload() }) }
  return (
    <>
      <form className="card grid" onSubmit={submit}>
        <h3 className="wide">Profile</h3>
        <label>Name<input name="name" defaultValue={child.name} required /></label>
        <label>Date of birth<input name="dob" type="date" defaultValue={child.dob || ''} /></label>
        <label>Guardian<input name="guardian" defaultValue={child.guardian || ''} /></label>
        <label>Guardian phone<input name="guardian_phone" defaultValue={child.guardian_phone || ''} /></label>
        {FIELDS.map(([k, l]) => <label key={k} className="wide">{l}<textarea name={k} rows={2} defaultValue={child[k] || ''} /></label>)}
        <label className="wide"><span><input name="consent" type="checkbox" style={{ width: 'auto' }} defaultChecked={!!child.consent} /> Guardian has consented to these records</span></label>
        <Err e={save.error} />
        <div className="wide row"><button disabled={save.busy}>Save profile</button></div>
      </form>
      <form className="card" onSubmit={assess}>
        <h3>Initial assessment</h3>
        <p className="muted">Describe the child in plain words. The AI organises it into a draft you review, edit and approve. It does not diagnose.</p>
        <textarea name="text" rows={4} required placeholder="e.g. Cannot speak in complete sentences, uses few words, has difficulty following instructions, struggles to communicate needs." />
        <Err e={ai.error} />
        <button disabled={ai.busy}>{ai.busy ? 'Organising…' : 'Draft assessment with AI'}</button>
      </form>
      {assessments.map(a => <Assessment key={a.id} a={a} reload={reload} />)}
    </>
  )
}

const ASSESS_LISTS = [['reported_difficulties', 'Reported difficulties'], ['demonstrated_abilities', 'Demonstrated abilities'], ['strengths', 'Strengths'],
  ['areas_needing_further_assessment', 'Needs further assessment'], ['suggested_questions', 'Suggested questions'], ['baseline_methods', 'Ways to establish a baseline']]
function Assessment({ a, reload }) {
  const { run, error, busy } = useAction()
  const [edit, setEdit] = useState(false)
  const r = a.result || {}
  const patch = body => run(async () => { await api('/therapy/assessments/' + a.id, { method: 'PATCH', body }); setEdit(false); reload() })
  const saveEdit = e => {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(e.target))
    patch({ result: { ...r, ...Object.fromEntries(ASSESS_LISTS.map(([k]) => [k, (f[k] || '').split('\n').map(x => x.trim()).filter(Boolean)])) } })
  }
  return (
    <div className="card">
      <p className="muted">{fmt(a.created_at)} · {a.approved ? <b>Approved {ymd(a.approved_at)}</b> : 'Draft: needs professional approval'}</p>
      {edit ? (
        <form onSubmit={saveEdit}>
          {ASSESS_LISTS.map(([k, l]) => <label key={k}>{l} (one per line)<textarea name={k} rows={3} defaultValue={(r[k] || []).join('\n')} /></label>)}
          <div className="row"><button disabled={busy}>Save edits</button><button type="button" className="ghost" onClick={() => setEdit(false)}>Cancel</button></div>
        </form>
      ) : <>
        {ASSESS_LISTS.map(([k, l]) => <L key={k} title={l} items={r[k]} />)}
        {r.learning_priorities?.length > 0 && <><h4>Learning priorities</h4><ul>{r.learning_priorities.map((x, i) => <li key={i}><b>{x.area}</b> ({x.priority}): {x.why}</li>)}</ul></>}
      </>}
      <Err e={error} />
      {!a.approved && !edit && <div className="row"><button onClick={() => patch({ approve: true })} disabled={busy}>Approve</button><button className="ghost" onClick={() => setEdit(true)}>Edit</button></div>}
    </div>
  )
}

// ---------- goals ----------
const GOAL_LABELS = [['current_skill', 'Current skill'], ['target_skill', 'Target skill'], ['rationale', 'Why recommended'], ['prerequisites', 'Prerequisites'], ['teaching', 'How to teach it'],
  ['activities', 'Activities'], ['success_criteria', 'Success criteria'], ['measure', 'How progress is measured'], ['timeframe', 'Timeframe']]
const KIND = { long: 'Long-term', short: 'Short-term', three_month: '3-month' }

function Goal({ g, reload, progress }) {
  const { run, error, busy } = useAction()
  const [edit, setEdit] = useState(false)
  const patch = body => run(async () => { await api('/therapy/goals/' + g.id, { method: 'PATCH', body }); setEdit(false); reload() })
  const save = e => { const body = formData(e); patch(body) }
  return (
    <div className="card">
      <div className="row between"><b>{KIND[g.kind] || g.kind} · {g.area || 'General'} · priority {g.priority || '—'}</b>
        <span><Status s={g.status === 'proposed' ? 'Draft' : g.status === 'approved' ? 'Approved' : 'Rejected'} /> {g.status === 'approved' && <Status s={g.progress} />}</span></div>
      {edit ? (
        <form onSubmit={save}>
          <label>Area<input name="area" defaultValue={g.area || ''} /></label>
          {GOAL_LABELS.map(([k, l]) => <label key={k}>{l}<textarea name={k} rows={2} defaultValue={g[k] || ''} /></label>)}
          <div className="row"><button disabled={busy}>Save</button><button type="button" className="ghost" onClick={() => setEdit(false)}>Cancel</button></div>
        </form>
      ) : <dl>{GOAL_LABELS.map(([k, l]) => g[k] && <div key={k}><dt className="muted">{l}</dt><dd style={{ margin: '0 0 8px' }}>{g[k]}</dd></div>)}</dl>}
      <Err e={error} />
      {g.status === 'proposed' && !edit && <div className="row">
        <button disabled={busy} onClick={() => patch({ status: 'approved' })}>Approve</button>
        <button className="ghost" onClick={() => setEdit(true)}>Edit</button>
        <button className="ghost" disabled={busy} onClick={() => patch({ status: 'rejected' })}>Reject</button></div>}
      {g.status === 'approved' && <label>Progress<Select value={g.progress} options={progress} blank={null} onChange={e => patch({ progress: e.target.value })} /></label>}
    </div>
  )
}

function Goals({ data, reload, lang, id }) {
  const { goals, lists, assessments } = data
  const ai = useAction(), manual = useAction()
  const [note, setNote] = useState([])
  const [adding, setAdding] = useState(false)
  const gen = e => { const { area } = formData(e); ai.run(async () => { const r = await api(`/therapy/children/${id}/goals/generate`, { body: { area, lang } }); setNote(r.missing_information); reload() }) }
  const add = e => { const body = formData(e); manual.run(async () => { await api(`/therapy/children/${id}/goals`, { body }); setAdding(false); reload() }) }
  const approved = assessments.some(a => a.approved)
  return (
    <>
      <form className="card row" onSubmit={gen}>
        <Select name="area" options={lists.areas} blank="Highest priorities" />
        <button disabled={ai.busy || !approved}>{ai.busy ? 'Thinking…' : 'Suggest goals with AI'}</button>
        <button type="button" className="ghost" onClick={() => setAdding(!adding)}>+ Own goal</button>
      </form>
      {!approved && <p className="muted">Approve an initial assessment first (Profile & assessment tab). Goals are built on it.</p>}
      <Err e={ai.error} />
      {note.length > 0 && <div className="card"><L title="Information the AI says is missing" items={note} /></div>}
      {adding && <form className="card grid" onSubmit={add}>
        <label>Area<Select name="area" options={lists.areas} /></label>
        {GOAL_LABELS.map(([k, l]) => <label key={k} className={k === 'target_skill' ? '' : 'wide'}>{l}{k === 'target_skill' ? ' *' : ''}<input name={k} required={k === 'target_skill'} /></label>)}
        <Err e={manual.error} /><div className="wide row"><button disabled={manual.busy}>Add as approved</button></div></form>}
      {goals.length === 0 && <p className="muted">No goals yet.</p>}
      {goals.map(g => <Goal key={g.id} g={g} reload={reload} progress={lists.progress} />)}
    </>
  )
}

// ---------- lessons ----------
function Lessons({ data, reload, lang }) {
  const approved = data.goals.filter(g => g.status === 'approved')
  const { run, error, busy } = useAction()
  const gen = e => { const body = formData(e); run(async () => { await api(`/therapy/goals/${body.goal_id}/lesson`, { body: { kind: body.kind, lang } }); reload() }) }
  return (
    <>
      <form className="card row" onSubmit={gen}>
        <Select name="goal_id" options={approved.map(g => [g.id, g.target_skill])} blank="Choose an approved goal" required />
        <Select name="kind" options={['daily', 'weekly', 'monthly']} blank={null} />
        <button disabled={busy || !approved.length}>{busy ? 'Writing…' : 'Generate lesson plan'}</button>
      </form>
      {!approved.length && <p className="muted">Lessons come from approved goals. Approve a goal first.</p>}
      <Err e={error} />
      {data.lessons.map(l => <Lesson key={l.id} l={l} goal={data.goals.find(g => g.id === l.goal_id)} reload={reload} />)}
    </>
  )
}
function Lesson({ l, goal, reload }) {
  const c = l.content || {}
  const { run, busy } = useAction()
  return (
    <div className="card">
      <div className="row between"><b>{c.title || 'Lesson plan'}</b><span className="muted">{l.kind} · {ymd(l.created_at)}{goal && ' · ' + goal.target_skill}</span></div>
      <p>{c.learning_objective}</p>
      <p className="muted">Target: {c.target_skill} · {c.duration} · difficulty {c.difficulty}</p>
      <L title="Materials" items={c.materials} /><L title="Teaching steps" items={c.steps} /><L title="Activities" items={c.activities} />
      <L title="Practice exercises" items={c.practice_exercises} /><L title="Expected responses" items={c.expected_responses} />
      <L title="Alternative activities" items={c.alternative_activities} /><L title="Home practice" items={c.home_practice} />
      {c.progress_measurement && <><h4>Measuring progress</h4><p>{c.progress_measurement}</p></>}
      <div className="row"><button className="ghost" onClick={() => window.print()}>Print</button>
        <button className="ghost" disabled={busy} onClick={() => run(async () => { await api('/therapy/lessons/' + l.id, { method: 'DELETE' }); reload() })}>Delete</button></div>
    </div>
  )
}

// ---------- sessions + interventions ----------
function Sessions({ data, reload, lang, id }) {
  const approved = data.goals.filter(g => g.status === 'approved')
  const { lists } = data
  const rec = useAction()
  const submit = e => { const body = formData(e); rec.run(async () => { await api(`/therapy/children/${id}/sessions`, { body }); e.target.reset(); reload() }) }
  return (
    <>
      <form className="card grid" onSubmit={submit}>
        <h3 className="wide">Record a session</h3>
        <label>Date<input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></label>
        <label>Goal addressed<Select name="goal_id" options={approved.map(g => [g.id, g.target_skill])} blank="No specific goal" /></label>
        <label className="wide">Activities performed<textarea name="activities" rows={2} /></label>
        <label className="wide">Child's response<textarea name="response" rows={2} /></label>
        <label>Trials<input name="trials" type="number" min="0" /></label>
        <label>Independent correct<input name="independent" type="number" min="0" /></label>
        <label>Prompted correct<input name="prompted" type="number" min="0" /></label>
        <label>Level of assistance<Select name="assistance" options={lists.assistance} blank="—" /></label>
        <label>Progress status<Select name="progress" options={lists.progress} blank="No change" /></label>
        <label className="wide">Difficulties <small className="muted">(then use "Suggest interventions" on the saved session)</small><textarea name="difficulties" rows={2} /></label>
        <label className="wide">Other observations<textarea name="notes" rows={2} /></label>
        <Err e={rec.error} /><div className="wide row"><button disabled={rec.busy}>Save session</button></div>
      </form>
      {data.sessions.length === 0 && <p className="muted">No sessions recorded. Reviews and next steps are built only from recorded sessions.</p>}
      {data.sessions.map(s => <Session key={s.id} s={s} goal={data.goals.find(g => g.id === s.goal_id)} reload={reload} lang={lang} />)}
    </>
  )
}
function Session({ s, goal, reload, lang }) {
  const { run, error, busy } = useAction()
  const a = s.analysis
  return (
    <div className="card">
      <div className="row between"><b>{s.date}{s.educator && ' · ' + s.educator}</b>{s.progress && <Status s={s.progress} />}</div>
      {goal && <p className="muted">Goal: {goal.target_skill}</p>}
      {s.activities && <p><b>Activities:</b> {s.activities}</p>}
      {s.response && <p><b>Response:</b> {s.response}</p>}
      {(s.trials != null || s.independent != null || s.prompted != null) && <p className="muted">Trials {s.trials ?? '—'} · independent {s.independent ?? '—'} · prompted {s.prompted ?? '—'}{s.assistance && ' · ' + s.assistance}</p>}
      {s.difficulties && <p><b>Difficulties:</b> {s.difficulties}</p>}
      {s.notes && <p className="muted">{s.notes}</p>}
      {a && <div className="card"><h4>Suggested interventions <small className="muted">(AI draft: a professional must review)</small></h4>
        <L title="Possible reasons" items={a.possible_reasons} /><L title="Alternative methods" items={a.alternative_methods} /><L title="Simpler activities" items={a.simpler_activities} />
        <L title="Visual or physical aids" items={a.visual_or_physical_aids} /><L title="Prompting strategies" items={a.prompting_strategies} /><L title="Complexity changes" items={a.complexity_changes} />
        <L title="Extra practice" items={a.extra_practice} />
        {a.different_from_before && <p><b>Different from before:</b> {a.different_from_before}</p>}
        {a.reassess_when && <p><b>Reassess when:</b> {a.reassess_when}</p>}</div>}
      <Err e={error} />
      {s.difficulties && <button className="ghost" disabled={busy} onClick={() => run(async () => { await api(`/therapy/sessions/${s.id}/analyze`, { body: { lang } }); reload() })}>{busy ? 'Analysing…' : a ? 'Suggest again' : 'Suggest interventions'}</button>}
    </div>
  )
}

// ---------- three-month review ----------
function Review({ data, reload, lang, id }) {
  const active = data.cycles.find(c => c.status === 'active')
  const { run, error, busy } = useAction()
  const draft = data.goals.filter(g => g.status === 'proposed' && data.cycles.find(c => c.id === g.cycle_id)?.status === 'draft')
  const gen = () => run(async () => { await api(`/therapy/children/${id}/review`, { body: { lang } }); reload() })
  const approve = cid => run(async () => { await api(`/therapy/cycles/${cid}/approve-review`, { body: {} }); reload() })
  const reviewed = data.cycles.filter(c => c.review)
  return (
    <>
      <div className="card">
        <h3>Three-month plan</h3>
        {active ? <p>Active since {ymd(active.start_date)} · review due <b>{ymd(active.review_date)}</b></p> : <p className="muted">No active plan yet. Approve goals to start one.</p>}
        <p className="muted">The review uses only the sessions recorded in this quarter. Nothing is moved up because time has passed.</p>
        <Err e={error} />
        <button onClick={gen} disabled={busy || !active}>{busy ? 'Analysing records…' : 'Generate review & next plan'}</button>
      </div>
      {reviewed.map(c => <ReviewCard key={c.id} c={c} goals={data.goals} onApprove={() => approve(c.id)} busy={busy} />)}
      {draft.length > 0 && <p className="muted">{draft.length} proposed goals for the next quarter are waiting on the Goals tab for individual approval.</p>}
    </>
  )
}
function ReviewCard({ c, goals, onApprove, busy }) {
  const r = c.review
  return (
    <div className="card">
      <p className="muted">Quarter {ymd(c.start_date)} → {ymd(c.review_date)} · {c.review_approved_at ? <b>Review approved {ymd(c.review_approved_at)}</b> : 'Draft: needs professional approval'}</p>
      <h4>Goal outcomes</h4>
      <ul>{r.outcomes?.map((o, i) => <li key={i}><b>{goals.find(g => g.id === o.goal_id)?.target_skill || 'Goal ' + o.goal_id}:</b> {o.outcome}. {o.evidence}</li>)}</ul>
      <L title="What improved" items={r.developmental_progress?.improved} /><L title="Remaining difficulties" items={r.developmental_progress?.remaining_difficulties} />
      <L title="Strategies that worked" items={r.intervention_analysis?.effective} /><L title="Strategies to modify" items={r.intervention_analysis?.needs_modification} />
      <L title="Next-step recommendations" items={r.next_step_recommendations} /><L title="Missing information" items={r.missing_information} />
      <div className="row"><button className="ghost" onClick={() => window.print()}>Print</button>
        {!c.review_approved_at && c.status === 'active' && <button onClick={onApprove} disabled={busy}>Approve review & close quarter</button>}</div>
    </div>
  )
}
