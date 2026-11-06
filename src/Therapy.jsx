import { useState } from 'react'
import { api, useApi, useAction, formData, go, fmt, shrinkImage, useMeta, downloadBlob } from './api.js'
import { Select, Status } from './Leads.jsx'
import Icon from './Icon.jsx'

// AI text can arrive as a string or null: never call .map on it directly
const arr = v => (Array.isArray(v) ? v : v ? [v] : [])
const L = ({ title, items: raw }) => { const items = arr(raw); return items.length ? <><h4>{title}</h4><ul>{items.map((x, i) => <li key={i}>{typeof x === 'string' ? x : JSON.stringify(x)}</li>)}</ul></> : null }
const Err = ({ e }) => e ? <p className="error">{e}</p> : null
// 03xx... -> 923xx...; anything else is used as typed (digits only)
const waLink = (phone, text) => { const d = String(phone).replace(/\D/g, ''); return `https://wa.me/${d.startsWith('0') ? '92' + d.slice(1) : d}?text=${encodeURIComponent(text)}` }
const ymd = d => (d || '').slice(0, 10) || '—'
const Stat = ({ label, value }) => <div className="card"><small className="muted">{label}</small><h2 style={{ margin: '4px 0 0' }}>{value ?? '…'}</h2></div>

// ---------- shared page header: same hero + KPI strip as the main dashboard ----------
// The app already prints the page title above every page except the home one, so the hero + glass KPI strip is only for home
const isHome = () => (location.hash.replace(/^#/, '').split('?')[0] || '/') === '/'

// ---------- dashboard ----------
export default function Therapy() {
  const [dash] = useApi('/therapy/dashboard')
  const kpis = [['Children', dash?.children], ['Active plans', dash?.active_plans], ['Goals in progress', dash?.in_progress], ['Goals achieved', dash?.achieved], ['Waiting for approval', dash?.pending_approval]]
  return (
    <section className="dash">
      {isHome()
        ? <><div className="hero"><div className="hero-title"><h1>Therapy overview</h1></div></div>
          <div className="kpis glass">{kpis.map(([l, v]) => <div key={l} className="kpi"><small>{l}</small><b>{v ?? 0}</b></div>)}</div></>
        : <div className="grid" style={{ marginBottom: 18 }}>{kpis.map(([l, v]) => <Stat key={l} label={l} value={v ?? 0} />)}</div>}
      <Ask />
      <div className="t-charts">
        <WeeklyChart rows={dash?.charts.weekly} />
        <ProgressDonut rows={dash?.charts.progress} />
        <AreaBars rows={dash?.charts.areas} />
        <IndependenceChart rows={dash?.charts.weekly} />
      </div>
      <div className="board">
        <div>
          <div className="card">
            <h3>Needs attention</h3>
            {dash && <p className="muted">{dash.needs_intervention} goal{dash.needs_intervention === 1 ? '' : 's'} to reassess · {dash.reviews_due} review{dash.reviews_due === 1 ? '' : 's'} due in 14 days</p>}
            {dash?.flags.length === 0 && <p className="muted">Nothing flagged. Flags come from your records, not from AI.</p>}
            <ul>{dash?.flags.map((f, i) => <li key={i}><a href={'#/therapy/' + f.child_id}>{f.text}</a></li>)}</ul>
          </div>
          <Insights />
        </div>
        <div>
          <div className="card"><h3>Recent observations</h3>
            {dash?.recent.length === 0 && <p className="muted">No sessions recorded yet.</p>}
            <ul>{dash?.recent.map(s => <li key={s.id}><a href={'#/therapy/' + s.child_id}><b>{s.child}</b></a> · {s.date}{s.progress && <> · <Status s={s.progress} /></>}{s.response && <><br /><span className="muted">{s.response.slice(0, 110)}</span></>}</li>)}</ul></div>
          <div className="card"><h3>Quick links</h3>
            <p><a href="#/therapy/children?new=1">+ Add a child</a></p><p><a href="#/therapy/children">All children</a></p>
            <p><a href="#/therapy/library">Skills library</a></p><p><a href="#/therapy/org">Organization settings</a></p></div>
        </div>
      </div>
    </section>
  )
}

// ---------- children list ----------
export function TherapyChildren({ query }) {
  const [kids, , loadError] = useApi('/therapy/children')
  const [adding, setAdding] = useState(new URLSearchParams(query).has('new'))
  const [q, setQ] = useState('')
  const { run, error, busy } = useAction()
  const submit = e => { const body = formData(e); body.consent = !!body.consent; run(async () => go('/therapy/' + (await api('/therapy/children', { body })).id)) }
  const shown = kids?.filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <section>
      <div className="row between">
        <h2>Children {kids && <span className="count">{kids.length}</span>}</h2>
        <button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ Add child'}</button>
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
      <div className="filters"><input placeholder="Search children…" value={q} onChange={e => setQ(e.target.value)} /></div>
      <Err e={loadError} />
      <div className="card scroll">
        <table>
          <thead><tr><th>Child</th><th>Age</th><th>Guardian</th><th>Approved goals</th><th>Next review</th><th>Last session</th></tr></thead>
          <tbody>
            {shown?.map(c => (
              <tr key={c.id} className="link" onClick={() => go('/therapy/' + c.id)}>
                <td><b>{c.name}</b></td><td>{c.age ?? '—'}</td><td>{c.guardian || '—'}</td><td>{c.goals}</td><td>{ymd(c.review_date)}</td><td>{ymd(c.last_session)}</td>
              </tr>
            ))}
            {shown?.length === 0 && <tr><td colSpan="6" className="muted">{kids.length ? 'No child matches.' : 'No children yet. Add one to begin with an initial assessment.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ---------- one child ----------
const TABS = [['profile', 'About & assessment'], ['goals', 'Goals'], ['lessons', 'Lessons'], ['sessions', 'Sessions'], ['review', '3-month review'], ['home', 'Parents & team'], ['reports', 'Reports']]

// Tells the educator the one thing to do next, from what is already recorded
function nextStep(d) {
  const asm = d.assessments, goals = d.goals, approved = goals.filter(g => g.status === 'approved'), proposed = goals.filter(g => g.status === 'proposed')
  const active = d.cycles.find(c => c.status === 'active'), today = new Date().toISOString().slice(0, 10)
  if (!asm.length) return { n: 1, text: "Describe the child's difficulties and abilities, and the AI will draft an assessment.", tab: 'profile', go: 'Start assessment' }
  if (!asm.some(a => a.approved)) return { n: 1, text: 'Read the drafted assessment, edit it if needed, then approve it.', tab: 'profile', go: 'Review assessment' }
  if (!goals.length) return { n: 2, text: 'Ask the AI to suggest goals for this child.', tab: 'goals', go: 'Suggest goals' }
  if (proposed.length && d.can_approve) return { n: 2, text: `${proposed.length} suggested goal${proposed.length > 1 ? 's are' : ' is'} waiting. Approve the ones you agree with.`, tab: 'goals', go: 'Review goals' }
  if (!approved.length) return { n: 2, text: 'Approve at least one goal to begin teaching.', tab: 'goals', go: 'Review goals' }
  if (!d.lessons.length) return { n: 3, text: 'Create a lesson plan for an approved goal.', tab: 'lessons', go: 'Create lesson' }
  if (!d.sessions.length) return { n: 4, text: 'After teaching, record how the session went.', tab: 'sessions', go: 'Record session' }
  if (active && active.review_date <= today) return { n: 5, text: 'The 3-month review is due. The AI will use your recorded sessions.', tab: 'review', go: 'Start review' }
  return { n: 4, text: 'Keep recording sessions. The review will be ready at the end of the quarter.', tab: 'sessions', go: 'Record session' }
}
const STEPS = ['Assessment', 'Goals', 'Lessons', 'Sessions', 'Review']

export function TherapyChild({ id }) {
  const [data, reload, loadError] = useApi('/therapy/children/' + id)
  const [tab, setTab] = useState('profile')
  const [langPick, setLang] = useState(null)
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return <p className="muted">Loading…</p>
  const { child } = data
  const lang = langPick ?? data.default_lang ?? 'en'
  const props = { data, reload, lang, id, setTab }
  return (
    <section>
      <div className="back-nav"><a className="button soft back-btn" href="#/therapy/children">← Back to children</a></div>
      <div className="child-head">
        <Photo child={child} reload={reload} id={id} />
        <div className="child-id">
          <h2>{child.name}</h2>
          <div className="t-chips">
            <span className="t-chip">{child.age != null ? child.age + (child.age === 1 ? ' year' : ' years') : 'Age unknown'}</span>
            {child.guardian && <span className="t-chip">Guardian: {child.guardian}</span>}
            <span className={'t-chip ' + (child.consent ? 'ok' : 'warn')}>{child.consent ? '✓ Consent recorded' : '⚠ Consent not recorded'}</span>
          </div>
        </div>
        <label className="child-lang">AI language<Select value={lang} onChange={e => setLang(e.target.value)} options={[['en', 'English'], ['ur', 'Roman Urdu']]} blank={null} /></label>
      </div>
      <NextStep d={data} setTab={setTab} />
      <div className="seg">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'profile' && <Profile {...props} />}
      {tab === 'goals' && <Goals {...props} />}
      {tab === 'lessons' && <Lessons {...props} />}
      {tab === 'sessions' && <Sessions {...props} />}
      {tab === 'review' && <Review {...props} />}
      {tab === 'home' && <Home {...props} />}
      {tab === 'reports' && <Reports {...props} />}
    </section>
  )
}

const FIELDS = [['difficulties', 'Reported difficulties', 'What worries the family or teachers'], ['abilities', 'Current abilities', 'What the child can do now'],
  ['strengths', 'Strengths and interests', 'What the child enjoys and does well'], ['communication', 'Communication abilities', 'How the child makes needs known'],
  ['learning_prefs', 'Learning preferences', 'What helps the child learn'], ['sensory', 'Sensory support needs', 'Sounds, textures, movement, lighting'],
  ['history', 'Developmental history & previous assessments', 'Milestones, reports, earlier therapy']]

function Profile({ data, reload, lang, id }) {
  const { child, assessments } = data
  const save = useAction(), ai = useAction(), del = useAction()
  const [saved, setSaved] = useState(false)
  const submit = e => { const body = formData(e); body.consent = !!body.consent; save.run(async () => { await api('/therapy/children/' + id, { method: 'PATCH', body }); reload(); setSaved(true); setTimeout(() => setSaved(false), 2500) }) }
  const assess = e => { const { text } = formData(e); ai.run(async () => { await api(`/therapy/children/${id}/assessment`, { body: { text, lang } }); e.target.reset(); reload() }) }
  return (
    <>
      <form className="card profile-form" onSubmit={submit}>
        <h3>Basic details</h3>
        <div className="form-sec four">
          <label>Name<input name="name" defaultValue={child.name} required /></label>
          <label>Date of birth<input name="dob" type="date" defaultValue={child.dob || ''} /></label>
          <label>Parent / guardian<input name="guardian" defaultValue={child.guardian || ''} /></label>
          <label>Guardian phone<input name="guardian_phone" defaultValue={child.guardian_phone || ''} placeholder="03xx xxxxxxx" /></label>
        </div>
        <h3>Understanding the child</h3>
        <div className="form-sec">
          {FIELDS.slice(0, 4).map(([k, l, hint]) => <label key={k}>{l}<small className="muted">{hint}</small><textarea name={k} rows={4} defaultValue={child[k] || ''} /></label>)}
        </div>
        <h3>Learning and support</h3>
        <div className="form-sec">
          {FIELDS.slice(4).map(([k, l, hint]) => <label key={k}>{l}<small className="muted">{hint}</small><textarea name={k} rows={4} defaultValue={child[k] || ''} /></label>)}
        </div>
        <label className={'consent-box' + (child.consent ? ' on' : '')}>
          <input name="consent" type="checkbox" defaultChecked={!!child.consent} />
          <span><b>Guardian consent</b><small className="muted">The guardian has agreed to this child's records, and any photos, being kept here.</small></span>
        </label>
        <Err e={save.error} /><Err e={del.error} />
        <div className="form-bar">
          <button disabled={save.busy}>{save.busy ? 'Saving…' : 'Save profile'}</button>
          {saved && <span className="ok">Saved ✓</span>}
          {data.can_approve && <button type="button" className="ghost danger" disabled={del.busy} onClick={() => confirm(`Delete ${child.name} and every record about them? This cannot be undone.`) && del.run(async () => { await api('/therapy/children/' + id, { method: 'DELETE' }); go('/therapy') })}>Delete child</button>}
        </div>
      </form>
      <form className="card" onSubmit={assess}>
        <h3>Initial assessment</h3>
        <p className="muted">Describe the child in plain words. The AI organises it into a draft you review, edit and approve. It does not diagnose.</p>
        <textarea name="text" rows={4} required placeholder="e.g. Cannot speak in complete sentences, uses few words, has difficulty following instructions, struggles to communicate needs." />
        <Err e={ai.error} />
        <button disabled={ai.busy}>{ai.busy ? 'Organising…' : 'Draft assessment with AI'}</button>
      </form>
      {assessments.map(a => <Assessment key={a.id} a={a} reload={reload} can={data.can_approve} />)}
    </>
  )
}

const ASSESS_LISTS = [['reported_difficulties', 'Reported difficulties'], ['demonstrated_abilities', 'Demonstrated abilities'], ['strengths', 'Strengths'],
  ['areas_needing_further_assessment', 'Needs further assessment'], ['suggested_questions', 'Suggested questions'], ['baseline_methods', 'Ways to establish a baseline']]
function Assessment({ a, reload, can }) {
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
          {ASSESS_LISTS.map(([k, l]) => <label key={k}>{l} (one per line)<textarea name={k} rows={3} defaultValue={arr(r[k]).join('\n')} /></label>)}
          <div className="row"><button disabled={busy}>Save edits</button><button type="button" className="ghost" onClick={() => setEdit(false)}>Cancel</button></div>
        </form>
      ) : <>
        {ASSESS_LISTS.map(([k, l]) => <L key={k} title={l} items={r[k]} />)}
        {arr(r.learning_priorities).length > 0 && <><h4>Learning priorities</h4><ul>{arr(r.learning_priorities).map((x, i) => <li key={i}><b>{x.area}</b> ({x.priority}): {x.why}</li>)}</ul></>}
      </>}
      <Err e={error} />
      {!a.approved && !edit && <div className="row">{can && <button onClick={() => patch({ approve: true })} disabled={busy}>Approve</button>}<button className="ghost" onClick={() => setEdit(true)}>Edit</button></div>}
    </div>
  )
}

// ---------- goals ----------
const GOAL_LABELS = [['current_skill', 'Current skill'], ['target_skill', 'Target skill'], ['rationale', 'Why recommended'], ['prerequisites', 'Prerequisites'], ['teaching', 'How to teach it'],
  ['activities', 'Activities'], ['success_criteria', 'Success criteria'], ['measure', 'How progress is measured'], ['timeframe', 'Timeframe']]
const KIND = { long: 'Long-term', short: 'Short-term', three_month: '3-month' }

function Goal({ g, reload, progress, can }) {
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
      ) : <>
        <p style={{ margin: '8px 0' }}><b>{g.target_skill}</b>{g.current_skill && <><br /><span className="muted">Now: {g.current_skill}</span></>}{g.success_criteria && <><br /><span className="muted">Done when: {g.success_criteria}</span></>}</p>
        <details><summary className="muted">Why, how to teach it, and how it is measured</summary>
          <dl>{GOAL_LABELS.filter(([k]) => !['target_skill', 'current_skill', 'success_criteria'].includes(k)).map(([k, l]) => g[k] && <div key={k}><dt className="muted">{l}</dt><dd style={{ margin: '0 0 8px' }}>{g[k]}</dd></div>)}</dl></details></>}
      <Err e={error} />
      {g.status === 'proposed' && !edit && <div className="row">
        {can && <button disabled={busy} onClick={() => patch({ status: 'approved' })}>Approve</button>}
        <button className="ghost" onClick={() => setEdit(true)}>Edit</button>
        {can && <button className="ghost" disabled={busy} onClick={() => patch({ status: 'rejected' })}>Reject</button>}</div>}
      {g.status === 'approved' && <label>Progress<Select value={g.progress} options={progress} blank={null} onChange={e => patch({ progress: e.target.value })} /></label>}
    </div>
  )
}

function Goals({ data, reload, lang, id, setTab }) {
  const { goals, lists, assessments } = data
  const ai = useAction(), manual = useAction()
  const [note, setNote] = useState([])
  const [adding, setAdding] = useState(false)
  const gen = e => { const { area } = formData(e); ai.run(async () => { const r = await api(`/therapy/children/${id}/goals/generate`, { body: { area, lang } }); setNote(r.missing_information); reload() }) }
  const add = e => { const body = formData(e); manual.run(async () => { await api(`/therapy/children/${id}/goals`, { body }); setAdding(false); reload() }) }
  const approved = assessments.some(a => a.approved)
  return (
    <>
      {!approved && <div className="card banner">
        <div><b>Approve an initial assessment to unlock AI goals.</b><br /><span className="muted">Goals are built on the approved assessment, so the suggestions fit this child. You can still add your own goal now.</span></div>
        <button type="button" onClick={() => setTab('profile')}>Go to assessment</button></div>}
      <form className="card row" onSubmit={gen}>
        <Select name="area" options={lists.areas} blank="Highest priorities" />
        <button disabled={ai.busy || !approved} title={approved ? '' : 'Approve an initial assessment first'}>{ai.busy ? 'Thinking…' : 'Suggest goals with AI'}</button>
        <button type="button" className="ghost" onClick={() => setAdding(!adding)}>+ Own goal</button>
      </form>
      <Err e={ai.error} />
      {note.length > 0 && <div className="card"><L title="Information the AI says is missing" items={note} /></div>}
      {adding && <form className="card grid" onSubmit={add}>
        <label>Area<Select name="area" options={lists.areas} /></label>
        {GOAL_LABELS.map(([k, l]) => <label key={k} className={k === 'target_skill' ? '' : 'wide'}>{l}{k === 'target_skill' ? ' *' : ''}<input name={k} required={k === 'target_skill'} /></label>)}
        <Err e={manual.error} /><div className="wide row"><button disabled={manual.busy}>Add as approved</button></div></form>}
      {goals.length === 0 && <p className="muted">No goals yet.</p>}
      {goals.map(g => <Goal key={g.id} g={g} reload={reload} progress={lists.progress} can={data.can_approve} />)}
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
  const [sent, setSent] = useState(false)
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
        {c.home_practice?.length > 0 && <button className="ghost" disabled={busy} onClick={() => run(async () => { await api(`/therapy/children/${l.child_id}/homework`, { body: { goal_id: l.goal_id, texts: c.home_practice } }); setSent(true); reload() })}>{sent ? 'Sent to parents ✓' : 'Send home practice to parents'}</button>}
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
        <label>Goal addressed<Select name="goal_id" options={approved.map(g => [g.id, g.target_skill])} blank="No specific goal" defaultValue={approved[0]?.id} /></label>
        <label className="wide">Activities performed<textarea name="activities" rows={2} /></label>
        <label className="wide">Child's response<textarea name="response" rows={2} /></label>
        <label>Progress status<Select name="progress" options={lists.progress} blank="No change" /></label>
        <details className="wide"><summary><b>Add counts (optional)</b> <small className="muted">for charts and reports</small></summary>
          <div className="grid" style={{ marginTop: 10 }}>
            <label>Tries<input name="trials" type="number" min="0" /></label>
            <label>Done alone<input name="independent" type="number" min="0" /></label>
            <label>Done with help<input name="prompted" type="number" min="0" /></label>
            <label>Type of help<Select name="assistance" options={lists.assistance} blank="—" /></label>
          </div></details>
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
      {reviewed.map(c => <ReviewCard key={c.id} c={c} goals={data.goals} onApprove={() => approve(c.id)} busy={busy} can={data.can_approve} />)}
      {draft.length > 0 && <p className="muted">{draft.length} proposed goals for the next quarter are waiting on the Goals tab for individual approval.</p>}
    </>
  )
}
function ReviewCard({ c, goals, onApprove, busy, can }) {
  const r = c.review
  return (
    <div className="card">
      <p className="muted">Quarter {ymd(c.start_date)} → {ymd(c.review_date)} · {c.review_approved_at ? <b>Review approved {ymd(c.review_approved_at)}</b> : 'Draft: needs professional approval'}</p>
      <h4>Goal outcomes</h4>
      <ul>{arr(r.outcomes).map((o, i) => <li key={i}><b>{goals.find(g => g.id === o.goal_id)?.target_skill || 'Goal ' + o.goal_id}:</b> {o.outcome}. {o.evidence}</li>)}</ul>
      <L title="What improved" items={r.developmental_progress?.improved} /><L title="Remaining difficulties" items={r.developmental_progress?.remaining_difficulties} />
      <L title="Strategies that worked" items={r.intervention_analysis?.effective} /><L title="Strategies to modify" items={r.intervention_analysis?.needs_modification} />
      <L title="Next-step recommendations" items={r.next_step_recommendations} /><L title="Missing information" items={r.missing_information} />
      <div className="row"><button className="ghost" onClick={() => window.print()}>Print</button>
        {can && !c.review_approved_at && c.status === 'active' && <button onClick={onApprove} disabled={busy}>Approve review & close quarter</button>}</div>
    </div>
  )
}

// ---------- photo ----------
function Photo({ child, reload, id }) {
  const { run, error } = useAction()
  const pick = e => { const f = e.target.files[0]; if (f) run(async () => { await api('/therapy/children/' + id, { method: 'PATCH', body: { photo: await shrinkImage(f, 320) } }); reload() }) }
  return (
    <label title="Change photo" style={{ cursor: 'pointer' }}>
      {child.photo ? <img src={child.photo} alt="" style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover' }} />
        : <span className="avatar" style={{ display: 'inline-flex', width: 72, height: 72, borderRadius: '50%', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>{child.name[0]}</span>}
      <small className="muted" style={{ display: 'block', textAlign: 'center', fontSize: 11 }}>Change photo</small>
      <input type="file" accept="image/*" hidden onChange={pick} />{error && <small className="error">{error}</small>}
    </label>
  )
}

// ---------- dashboard AI insights (only when asked) ----------
function Insights() {
  const { run, error, busy } = useAction()
  const [res, setRes] = useState(null)
  return (
    <div className="card">
      <div className="row between"><h3>AI insights</h3>
        <button className="ghost" disabled={busy} onClick={() => run(async () => setRes(await api('/therapy/dashboard/insights', { body: {} })))}>{busy ? 'Reading records…' : res ? 'Refresh' : 'Generate insights'}</button></div>
      <p className="muted">Based only on recorded goals and sessions from the last 30 days. Suggestions for a professional to review.</p>
      <Err e={error} />
      {res?.insights.length === 0 && <p className="muted">Nothing stands out in the current records.</p>}
      {res?.insights.map((i, k) => <p key={k}><a href={'#/therapy/' + i.child_id}><b>{i.title}</b></a> <small className="muted">({i.type.replace(/_/g, ' ')})</small><br />{i.why} <i>{i.suggestion}</i></p>)}
      <L title="Missing information" items={res?.missing_information} />
    </div>
  )
}

// ---------- team, parents, home practice, messages ----------
function Home({ data, reload, id }) {
  const m = useMeta()
  const { staff, staff_options, parents, homework, messages, goals, can_approve } = data
  const a1 = useAction(), a2 = useAction(), a3 = useAction(), a4 = useAction()
  const [sel, setSel] = useState(staff.map(x => x.id))
  const roleName = k => (m.roles || []).find(r => r.key === k)?.label || k
  return (
    <>
      <div className="card">
        <h3>Assigned team</h3>
        {staff_options.map(u => <label key={u.id}><input type="checkbox" style={{ width: 'auto' }} disabled={!can_approve} checked={sel.includes(u.id)}
          onChange={e => setSel(e.target.checked ? [...sel, u.id] : sel.filter(x => x !== u.id))} /> {u.name} <small className="muted">{roleName(u.role)}</small></label>)}
        <Err e={a1.error} />
        {can_approve ? <button disabled={a1.busy} onClick={() => a1.run(async () => { await api(`/therapy/children/${id}/staff`, { method: 'PUT', body: { user_ids: sel } }); reload() })}>Save team</button>
          : <p className="muted">Only a therapist, special educator or admin can change the team.</p>}
      </div>
      <div className="card">
        <h3>Parent / guardian access</h3>
        {parents.length === 0 && <p className="muted">No parent has portal access yet.</p>}
        {parents.map(p => <p key={p.id}>{p.name} · {p.email} {can_approve && <button className="ghost" onClick={() => a2.run(async () => { await api(`/therapy/children/${id}/parent/${p.id}`, { method: 'DELETE' }); reload() })}>Remove</button>}</p>)}
        {data.child.guardian_phone && <p><a className="button ghost" target="_blank" rel="noreferrer" href={waLink(data.child.guardian_phone, `Hello, this is a message from ${data.child.name}'s team.`)}>Message guardian on WhatsApp</a></p>}
        {can_approve && <form className="grid" onSubmit={e => { const body = formData(e); a2.run(async () => { await api(`/therapy/children/${id}/parent`, { body }); e.target.reset(); reload() }) }}>
          <label>Name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label>
          <label>Password<input name="password" type="password" minLength={10} required placeholder="10+ characters" /></label>
          <div className="wide row"><button disabled={a2.busy}>Give parent access</button></div></form>}
        <Err e={a2.error} />
        <p className="muted">Parents see approved goals, progress, reports and home practice. They cannot change professional assessments or plans.</p>
      </div>
      <div className="card">
        <h3>Home practice</h3>
        <form className="grid" onSubmit={e => { const body = formData(e); a3.run(async () => { await api(`/therapy/children/${id}/homework`, { body }); e.target.reset(); reload() }) }}>
          <label className="wide">Task<input name="text" required maxLength={600} placeholder="e.g. Name 3 foods at dinner using two words" /></label>
          <label>Goal<Select name="goal_id" options={goals.filter(g => g.status === 'approved').map(g => [g.id, g.target_skill])} blank="None" /></label>
          <label>Due<input name="due" type="date" /></label>
          <div className="wide row"><button disabled={a3.busy}>Assign</button></div></form>
        <Err e={a3.error} />
        <ul>{homework.map(h => <li key={h.id}>{h.done_at ? '✓ ' : '○ '}{h.text}{h.due && <small className="muted"> · due {h.due}</small>}{h.done_note && <small className="muted"> · parent: {h.done_note}</small>}
          {' '}<button className="ghost" onClick={() => a3.run(async () => { await api('/therapy/homework/' + h.id, { method: 'DELETE' }); reload() })}>×</button></li>)}</ul>
      </div>
      <div className="card">
        <h3>Messages with the parent</h3>
        <form onSubmit={e => { const body = formData(e); a4.run(async () => { await api(`/therapy/children/${id}/messages`, { body }); e.target.reset(); reload() }) }}>
          <textarea name="body" rows={2} required placeholder="Write to the parent" /><button disabled={a4.busy}>Send</button></form>
        <Err e={a4.error} />
        {messages.map(x => <p key={x.id}><b>{x.sender || x.sender_role}</b> <small className="muted">{fmt(x.created_at)}{x.kind === 'observation' && ' · observation from home'}</small><br />{x.body}</p>)}
      </div>
    </>
  )
}

// ---------- reports (print to PDF) ----------
const REPORTS = [['assessment', 'Initial assessment'], ['iep', 'Individualized Education Plan'], ['session', 'Daily session report'], ['weekly', 'Weekly progress'],
  ['monthly', 'Monthly progress'], ['quarterly', 'Quarterly development report'], ['goals', 'Goal achievement'], ['domain', 'Domain-wise development'], ['parent', 'Parent progress report']]
const RANK = ['Not introduced', 'Emerging', 'Developing', 'Progressing', 'Achieved']
const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)

function Reports({ id }) {
  const [type, setType] = useState('quarterly')
  const [from, setFrom] = useState(day(30)), [to, setTo] = useState(day(0))
  const [comment, setComment] = useState('')
  const pickType = t => { setType(t); if (t === 'weekly') { setFrom(day(7)); setTo(day(0)) } if (t === 'monthly') { setFrom(day(30)); setTo(day(0)) } if (t === 'session') { setFrom(day(0)); setTo(day(0)) } }
  const [r] = useApi(`/therapy/children/${id}/report?from=${from}&to=${to}`)
  const [pdfBusy, setPdfBusy] = useState(false), [pdfErr, setPdfErr] = useState('')
  const pdf = async () => {
    setPdfErr(''); setPdfBusy(true)
    try { await downloadBlob(`/therapy/children/${id}/report.pdf?` + new URLSearchParams({ type, from, to, comment }), `${type}-${to}.pdf`) } catch (e) { setPdfErr(e.message) } finally { setPdfBusy(false) }
  }
  return (
    <>
      <div className="card grid">
        <label>Report<Select value={type} onChange={e => pickType(e.target.value)} options={REPORTS} blank={null} /></label>
        {['session', 'weekly', 'monthly'].includes(type) && <><label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>To<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label></>}
        <label className="wide">Professional comments (printed on the report)<textarea rows={2} value={comment} onChange={e => setComment(e.target.value)} /></label>
        <div className="wide row"><button onClick={pdf} disabled={!r || pdfBusy}>{pdfBusy ? 'Preparing…' : 'Download PDF'}</button><button className="ghost" onClick={() => window.print()} disabled={!r}>Print</button></div>
        <Err e={pdfErr} />
      </div>
      {!r ? <p className="muted">Loading…</p> : <ReportPage r={r} type={type} comment={comment} />}
    </>
  )
}

// Bars: [{label, value, max}] ; Line: independent % per session
const Bars = ({ rows }) => (
  <svg viewBox={`0 0 520 ${rows.length * 26 + 6}`} width="100%" role="img" aria-label="Progress by area">
    {rows.map((x, i) => <g key={i} transform={`translate(0 ${i * 26})`}>
      <text x="0" y="16" fontSize="11" fill="currentColor">{x.label.slice(0, 26)}</text>
      <rect x="190" y="4" width="300" height="14" rx="4" fill="#e5e7eb" /><rect x="190" y="4" width={Math.max(2, 300 * x.value / x.max)} height="14" rx="4" fill="#0d9488" />
      <text x="496" y="16" fontSize="11" fill="currentColor">{x.text}</text></g>)}
  </svg>
)
const Trend = ({ pts }) => {
  if (pts.length < 2) return <p className="muted">Not enough sessions with trial counts to draw a trend yet.</p>
  const W = 520, H = 140, x = i => 30 + i * (W - 50) / (pts.length - 1), y = v => H - 20 - v * (H - 40) / 100
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Independent responses over sessions">
      {[0, 50, 100].map(v => <g key={v}><line x1="30" x2={W - 10} y1={y(v)} y2={y(v)} stroke="#e5e7eb" /><text x="0" y={y(v) + 4} fontSize="10" fill="currentColor">{v}%</text></g>)}
      <polyline fill="none" stroke="#0d9488" strokeWidth="2" points={pts.map((p, i) => `${x(i)},${y(p.v)}`).join(' ')} />
      {pts.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.v)} r="3" fill="#0d9488"><title>{p.d}: {p.v}%</title></circle>)}
    </svg>
  )
}
const trend = (sessions, goalId) => sessions.filter(s => s.trials > 0 && s.independent != null && (goalId == null || s.goal_id === goalId)).map(s => ({ d: s.date, v: Math.round(100 * s.independent / s.trials) }))

function ReportPage({ r, type, comment }) {
  const c = r.child, goals = r.goals.filter(g => g.status === 'approved')
  const asm = r.assessment?.result
  const gname = id => r.goals.find(g => g.id === id)?.target_skill || '—'
  const quarter = r.cycles.find(y => y.review)
  const areas = [...new Set(goals.map(g => g.area || 'General'))]
  const domain = areas.map(a => { const gs = goals.filter(g => (g.area || 'General') === a); const avg = gs.reduce((t, g) => t + Math.max(0, RANK.indexOf(g.progress)), 0) / gs.length; return { label: a, value: avg, max: 4, text: `${gs.length} goal${gs.length > 1 ? 's' : ''}` } })
  const sessions = r.sessions
  const title = REPORTS.find(x => x[0] === type)[1]
  return (
    <div className="card print-area">
      <h2 style={{ marginBottom: 0 }}>{title}</h2>
      <p className="muted">{r.organization} · {c.name}{c.age != null && `, ${c.age} years`}{c.guardian && ` · Guardian: ${c.guardian}`} · Generated {r.generated_at.slice(0, 10)} by {r.generated_by}{['session', 'weekly', 'monthly'].includes(type) && ` · ${r.from} to ${r.to}`}</p>

      {type === 'assessment' && (asm ? <>
        <p className="muted">Approved {r.assessment.approved_at?.slice(0, 10)} by {r.assessment.approved_by_name}</p>
        <L title="Reported difficulties" items={asm.reported_difficulties} /><L title="Demonstrated abilities" items={asm.demonstrated_abilities} /><L title="Strengths" items={asm.strengths} />
        <L title="Areas needing further assessment" items={asm.areas_needing_further_assessment} /><L title="Baseline methods" items={asm.baseline_methods} />
        {arr(asm.learning_priorities).length > 0 && <><h4>Learning priorities</h4><ul>{arr(asm.learning_priorities).map((x, i) => <li key={i}><b>{x.area}</b> ({x.priority}): {x.why}</li>)}</ul></>}
      </> : <p className="muted">No approved assessment yet.</p>)}

      {(type === 'iep') && (goals.length ? goals.map(g => <div key={g.id} style={{ breakInside: 'avoid', marginBottom: 12 }}>
        <h4>{g.target_skill} <small className="muted">({g.kind.replace('_', '-')}, {g.area}, priority {g.priority})</small></h4>
        <p><b>Now:</b> {g.current_skill}<br /><b>Why:</b> {g.rationale}<br /><b>Teaching:</b> {g.teaching}<br /><b>Success criteria:</b> {g.success_criteria}<br /><b>Measured by:</b> {g.measure} · {g.timeframe}<br />
          <small className="muted">Approved {g.approved_at?.slice(0, 10)} by {g.approved_by_name}</small></p></div>) : <p className="muted">No approved goals yet.</p>)}

      {['session', 'weekly', 'monthly'].includes(type) && <>
        {type !== 'session' && <><h4>Independent responses over time</h4><Trend pts={trend(sessions)} /></>}
        <p>{sessions.length} session{sessions.length === 1 ? '' : 's'} recorded in this period.</p>
        {sessions.map(s => <p key={s.id} style={{ breakInside: 'avoid' }}><b>{s.date}</b> · {s.educator} · {gname(s.goal_id)}{s.progress && ` · ${s.progress}`}<br />
          {s.activities && <>Activities: {s.activities}<br /></>}{s.response && <>Response: {s.response}<br /></>}
          {s.trials != null && <>Trials {s.trials}, independent {s.independent ?? '—'}, prompted {s.prompted ?? '—'}{s.assistance && `, ${s.assistance}`}<br /></>}
          {s.difficulties && <>Difficulties: {s.difficulties}</>}</p>)}
      </>}

      {(type === 'quarterly') && (quarter ? <>
        <p className="muted">Quarter {quarter.start_date} to {quarter.review_date} · {quarter.review_approved_at ? `Approved ${quarter.review_approved_at.slice(0, 10)} by ${quarter.approved_by_name}` : 'DRAFT: not yet approved'}</p>
        <h4>Goal outcomes</h4><ul>{arr(quarter.review.outcomes).map((o, i) => <li key={i}><b>{gname(o.goal_id)}:</b> {o.outcome}. {o.evidence}</li>)}</ul>
        <L title="What improved" items={quarter.review.developmental_progress?.improved} /><L title="Remaining difficulties" items={quarter.review.developmental_progress?.remaining_difficulties} />
        <L title="Effective strategies" items={quarter.review.intervention_analysis?.effective} /><L title="Strategies to modify" items={quarter.review.intervention_analysis?.needs_modification} />
        <L title="Next-step recommendations" items={quarter.review.next_step_recommendations} />
      </> : <p className="muted">No three-month review has been generated yet.</p>)}

      {(type === 'goals') && <table><thead><tr><th>Goal</th><th>Area</th><th>Progress</th><th>Approved</th></tr></thead>
        <tbody>{goals.map(g => <tr key={g.id}><td>{g.target_skill}</td><td>{g.area}</td><td>{g.progress}</td><td>{g.approved_at?.slice(0, 10)}</td></tr>)}</tbody></table>}
      {(type === 'goals') && <p>{goals.filter(g => g.progress === 'Achieved').length} of {goals.length} approved goals achieved.</p>}

      {(type === 'domain') && (domain.length ? <><p className="muted">Average progress of approved goals per area (0 = not introduced, 4 = achieved).</p><Bars rows={domain} /></> : <p className="muted">No approved goals yet.</p>)}

      {type === 'parent' && <>
        <h4>What we are working on</h4>
        <ul>{goals.map(g => <li key={g.id}><b>{g.target_skill}</b>: {g.progress}</li>)}</ul>
        <h4>Progress</h4><Trend pts={trend(r.all_sessions)} />
        <h4>Home practice</h4><ul>{r.homework.map(h => <li key={h.id}>{h.done_at ? '✓' : '○'} {h.text}</li>)}</ul>
        {quarter?.review_approved_at && <L title="Next steps" items={quarter.review.next_step_recommendations} />}
      </>}

      {comment && <><h4>Professional comments</h4><p style={{ whiteSpace: 'pre-wrap' }}>{comment}</p></>}
      <p className="muted"><small>This report supports, and does not replace, professional judgement. It makes no diagnosis.</small></p>
    </div>
  )
}

// ---------- parent portal ----------
export function ParentPortal() {
  const [kids, , err0] = useApi('/therapy/portal')
  const [sel, setSel] = useState(null)
  const id = sel || kids?.[0]?.id
  return (
    <section>
      <h2>My child</h2>
      <Err e={err0} />
      {kids?.length === 0 && <p className="muted">No child is linked to your account yet. Please ask the centre.</p>}
      {kids?.length > 1 && <div className="seg">{kids.map(k => <button key={k.id} className={k.id === id ? 'on' : ''} onClick={() => setSel(k.id)}>{k.name}</button>)}</div>}
      {id && <PortalChild id={id} key={id} />}
    </section>
  )
}
function PortalChild({ id }) {
  const [d, reload, e0] = useApi('/therapy/portal/' + id)
  const a1 = useAction(), a2 = useAction()
  if (e0) return <p className="error">{e0}</p>
  if (!d) return <p className="muted">Loading…</p>
  const send = (kind, e) => { const { body } = formData(e); a2.run(async () => { await api(`/therapy/portal/${id}/messages`, { body: { body, kind } }); e.target.reset(); reload() }) }
  return (
    <>
      <div className="row">{d.child.photo && <img src={d.child.photo} alt="" style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }} />}
        <div><h3>{d.child.name}</h3><p className="muted">{d.child.age != null && d.child.age + ' years'}</p></div></div>
      <div className="card"><h3>Goals we are working on</h3>
        {d.goals.length === 0 && <p className="muted">Goals appear here once the team has approved them.</p>}
        {d.goals.map(g => <p key={g.id}><b>{g.target_skill}</b> <Status s={g.progress} /><br /><span className="muted">{g.area} · now: {g.current_skill} · success: {g.success_criteria}</span></p>)}</div>
      <div className="card"><h3>Home practice</h3>
        <Err e={a1.error} />
        {d.homework.length === 0 && <p className="muted">No tasks assigned.</p>}
        {d.homework.map(h => <p key={h.id}><label><input type="checkbox" style={{ width: 'auto' }} checked={!!h.done_at}
          onChange={ev => a1.run(async () => { await api(`/therapy/portal/${id}/homework/${h.id}/done`, { body: { undo: !ev.target.checked } }); reload() })} /> {h.text}</label>
          {h.due && <small className="muted"> · due {h.due}</small>}</p>)}</div>
      <div className="card"><h3>Quarterly reports</h3>
        {d.reports.length === 0 && <p className="muted">Reports appear after the team approves each three-month review.</p>}
        {d.reports.map(r => <div key={r.id}><p className="muted">{r.start_date} to {r.review_date}</p>
          <ul>{arr(r.outcomes).map((o, i) => <li key={i}><b>{o.goal}:</b> {o.outcome}</li>)}</ul>
          <L title="What improved" items={r.improved} /><L title="Still working on" items={r.remaining} /><L title="Next steps" items={r.next_steps} /></div>)}</div>
      <div className="card"><h3>Messages & observations</h3>
        <form onSubmit={e => (e.preventDefault(), send('message', e))}><textarea name="body" rows={2} required placeholder="Write to the team, or share something you noticed at home" />
          <div className="row"><button disabled={a2.busy}>Send message</button>
            <button type="button" className="ghost" disabled={a2.busy} onClick={e => send('observation', { target: e.target.form, preventDefault() {} })}>Send as observation</button></div></form>
        <Err e={a2.error} />
        {d.messages.map(x => <p key={x.id}><b>{x.sender || x.sender_role}</b> <small className="muted">{fmt(x.created_at)}{x.kind === 'observation' && ' · observation'}</small><br />{x.body}</p>)}</div>
    </>
  )
}

// ---------- skills & activity library ----------
export function TherapyLibrary() {
  const [f, setF] = useState({ q: '', category: '' })
  const [d, reload] = useApi('/therapy/skills?' + new URLSearchParams(f))
  const [open, setOpen] = useState(null)
  const [adding, setAdding] = useState(false)
  const { run, error, busy } = useAction()
  const FIELD = [['description', 'Description'], ['prerequisites', 'Prerequisite skills'], ['behaviours', 'Observable behaviours'], ['assessment', 'Assessment methods'], ['teaching', 'Teaching instructions'],
    ['activities', 'Activities'], ['materials', 'Required materials'], ['measurement', 'Measurement criteria'], ['alternatives', 'Alternative strategies'], ['refs', 'References']]
  return (
    <section>
      <div className="back-nav"><a className="button soft back-btn" href="#/therapy">← Back to therapy</a></div>
      <div className="row between"><h2>Skills & activity library</h2><button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ Add skill'}</button></div>
      <p className="muted">Starter skills are general teaching guides without external citations. Add your centre's own skills and references. The AI uses this library when it suggests goals.</p>
      {adding && <form className="card grid" onSubmit={e => { const body = formData(e); run(async () => { await api('/therapy/skills', { body }); setAdding(false); reload() }) }}>
        <label>Category<Select name="category" options={d?.categories || []} required /></label><label>Name *<input name="name" required /></label>
        {FIELD.map(([k, l]) => <label key={k} className="wide">{l}<textarea name={k} rows={2} /></label>)}
        <Err e={error} /><div className="wide row"><button disabled={busy}>Save skill</button></div></form>}
      <div className="filters">
        <input placeholder="Search skills…" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
        <Select value={f.category} onChange={e => setF({ ...f, category: e.target.value })} options={d?.categories || []} blank="All categories" />
      </div>
      {d?.skills.map(s => (
        <div key={s.id} className="card">
          <div className="row between" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === s.id ? null : s.id)}><b>{s.name}</b><span className="muted">{s.category}{s.built_in ? '' : ' · yours'}</span></div>
          {open === s.id && <>{FIELD.map(([k, l]) => s[k] ? <p key={k}><b>{l}:</b> {s[k]}</p> : null)}
            {!s.built_in && <button className="ghost" onClick={() => run(async () => { await api('/therapy/skills/' + s.id, { method: 'DELETE' }); reload() })}>Delete</button>}</>}
        </div>
      ))}
      {d?.skills.length === 0 && <p className="muted">No skills match.</p>}
    </section>
  )
}

// ---------- organization settings (admin) ----------
export function TherapyOrg() {
  const [d, reload, loadError] = useApi('/therapy/org')
  const { run, error, busy } = useAction()
  const [saved, setSaved] = useState(false)
  if (loadError) return <p className="error">{loadError}</p>
  if (!d) return <p className="muted">Loading…</p>
  const o = d.org
  const submit = e => { const body = formData(e); run(async () => { await api('/therapy/org', { method: 'PUT', body }); setSaved(true); reload() }) }
  return (
    <section>
      <div className="back-nav"><a className="button soft back-btn" href="#/therapy">← Back to therapy</a></div>
      <h2>Organization</h2>
      <div className="grid">
        <div className="card"><small className="muted">Children</small><h2 style={{ margin: 0 }}>{d.counts.children}</h2></div>
        <div className="card"><small className="muted">Staff</small><h2 style={{ margin: 0 }}>{d.team.filter(t => t.active).length}</h2></div>
        <div className="card"><small className="muted">Parent logins</small><h2 style={{ margin: 0 }}>{d.counts.parents}</h2></div>
      </div>
      <form className="card grid" onSubmit={submit}>
        <h3 className="wide">Settings for {d.account_name}</h3>
        <label>Name on reports<input name="display_name" defaultValue={o.display_name} placeholder={d.account_name} maxLength={120} disabled={!d.can_edit} /></label>
        <label>Default AI language<Select name="default_lang" options={[['en', 'English'], ['ur', 'Roman Urdu']]} defaultValue={o.default_lang} blank={null} /></label>
        <label>Review cycle (days)<input name="cycle_days" type="number" min="28" max="366" defaultValue={o.cycle_days} disabled={!d.can_edit} /></label>
        <label className="wide">Report footer<textarea name="report_footer" rows={2} defaultValue={o.report_footer} maxLength={500} disabled={!d.can_edit} placeholder="Printed at the end of every report" /></label>
        <label className="wide">Centre guidelines for the AI<textarea name="guidelines" rows={4} defaultValue={o.guidelines} maxLength={2000} disabled={!d.can_edit} placeholder="e.g. We follow a play-based approach. Always include a visual-support option." /></label>
        <small className="muted wide">The AI follows these unless they conflict with its safety rules (no diagnosis, evidence-based progress, professional approval).</small>
        <Err e={error} />{saved && <p className="ok wide">Saved.</p>}
        {d.can_edit ? <div className="wide row"><button disabled={busy}>Save settings</button></div> : <p className="muted wide">Only the organization admin can change these.</p>}
      </form>
      <AiSettings d={d} reload={reload} />
      <div className="card scroll">
        <div className="row between"><h3>Team</h3><a className="button ghost" href="#/users">Manage users & roles</a></div>
        <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Assigned children</th><th>Status</th></tr></thead>
          <tbody>{d.team.map(m => <tr key={m.id}><td>{m.name}</td><td>{m.email}</td><td>{m.role.replace(/_/g, ' ')}</td><td>{m.children}</td><td>{m.active ? 'Active' : 'Inactive'}</td></tr>)}</tbody></table>
      </div>
    </section>
  )
}

// ---------- dashboard charts (drawn from recorded data; empty states say so) ----------
const COLORS = { 'Not introduced': '#cbd5e1', Emerging: '#fbbf24', Developing: '#fb923c', Progressing: '#0d9488', Achieved: '#16a34a', 'Requires reassessment': '#dc2626' }
const dayLabel = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

function LineChart({ title, sub, rows, field, unit = '', max: fixedMax, empty }) {
  const [hover, setHover] = useState(null)
  const W = 520, H = 200, L = 34, R = 12, T = 14, B = 28
  const pts = rows?.map((r, i) => ({ i, v: r[field], d: r.label })) || []
  const max = fixedMax || Math.max(4, Math.ceil(Math.max(0, ...pts.map(p => p.v ?? 0)) / 4) * 4)
  const x = i => L + i * (W - L - R) / Math.max(1, pts.length - 1), y = v => T + (H - T - B) * (1 - v / max)
  const have = pts.filter(p => p.v != null)
  const path = have.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  const h = hover != null ? pts[hover] : null
  return (
    <div className="card trend" style={{ margin: 0 }}>
      <h3>{title}</h3><p className="muted" style={{ margin: '0 0 8px' }}>{sub}</p>
      {!rows ? <p className="muted">Loading…</p> : have.length < 2 ? <p className="muted">{empty}</p> : (
        <div className="plot">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${have.map(p => `${dayLabel(p.d)} ${p.v}${unit}`).join(', ')}`} onPointerLeave={() => setHover(null)}
            onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width * W - L) / (W - L - R) * (pts.length - 1))))) }}>
            {[0, 1, 2, 3, 4].map(t => <g key={t}><line x1={L} x2={W - R} y1={y(max * t / 4)} y2={y(max * t / 4)} stroke="var(--line)" /><text x={L - 6} y={y(max * t / 4) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{Math.round(max * t / 4)}{unit}</text></g>)}
            {pts.map(p => p.i % 2 === 0 && <text key={p.i} x={x(p.i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--muted)">{dayLabel(p.d)}</text>)}
            <path d={`${path}L${x(have.at(-1).i)},${y(0)}L${x(have[0].i)},${y(0)}Z`} fill="var(--s1)" opacity=".12" />
            <path d={path} fill="none" stroke="var(--s1)" strokeWidth="2.5" strokeLinejoin="round" />
            {have.map(p => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={hover === p.i ? 5 : 3} fill="var(--s1)" />)}
            {h && h.v != null && <text x={Math.min(W - 70, x(h.i))} y={y(h.v) - 10} fontSize="12" fontWeight="700" fill="var(--text)">{h.v}{unit}</text>}
          </svg>
        </div>
      )}
    </div>
  )
}
const WeeklyChart = ({ rows }) => <LineChart title="Sessions per week" sub="Recorded sessions, last 8 weeks" rows={rows} field="sessions" empty="Record at least two weeks of sessions to see a trend." />
const IndependenceChart = ({ rows }) => <LineChart title="Independent responses" sub="Share of trials answered without help, per week" rows={rows} field="independent_pct" unit="%" max={100} empty="Record sessions with trial counts (trials and independent correct) to see this." />

function ProgressDonut({ rows }) {
  const [hover, setHover] = useState(null)
  const total = rows?.reduce((s, r) => s + r.n, 0) || 0
  const r = 70, C = 2 * Math.PI * r
  let off = 0
  const focus = rows?.[hover]
  return (
    <div className="card" style={{ margin: 0 }}>
      <h3>Goal progress</h3>
      {!rows ? <p className="muted">Loading…</p> : total === 0 ? <p className="muted">No approved goals yet.</p> : (
        <div className="composition">
          <ul>{rows.map((x, i) => <li key={x.label} className={hover === i ? 'on' : ''} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <small><i className="swatch" style={{ background: COLORS[x.label] }} />{x.label}</small><div><b>{x.n}</b> <span className="muted">{Math.round(100 * x.n / total)}%</span></div></li>)}</ul>
          <svg viewBox="0 0 180 180" role="img" aria-label={rows.map(x => `${x.label} ${x.n}`).join(', ')}>
            <circle cx="90" cy="90" r={r} className="ring" />
            {rows.map((x, i) => { const len = x.n / total * C, o = off; off += len; return x.n ? <circle key={x.label} cx="90" cy="90" r={r} fill="none" stroke={COLORS[x.label]} strokeWidth={hover === i ? 30 : 26} strokeDasharray={`${Math.max(0.1, len - 3)} ${C}`} strokeDashoffset={-o} transform="rotate(-90 90 90)" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} /> : null })}
            <text x="90" y="86" textAnchor="middle" className="donut-total">{focus ? focus.n : total}</text>
            <text x="90" y="106" textAnchor="middle" className="donut-label">{focus ? focus.label : 'goals'}</text>
          </svg>
        </div>
      )}
    </div>
  )
}

function AreaBars({ rows }) {
  return (
    <div className="card" style={{ margin: 0 }}>
      <h3>Progress by developmental area</h3><p className="muted" style={{ margin: '0 0 8px' }}>Average of approved goals (0 = not introduced, 4 = achieved)</p>
      {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">No approved goals yet.</p> : (
        <svg viewBox={`0 0 520 ${rows.length * 30 + 4}`} width="100%" role="img" aria-label={rows.map(a => `${a.area} ${a.avg} of 4`).join(', ')}>
          {rows.map((a, i) => <g key={a.area} transform={`translate(0 ${i * 30})`}>
            <text x="0" y="17" fontSize="12" fill="var(--text)">{a.area.length > 26 ? a.area.slice(0, 25) + '…' : a.area}</text>
            <rect x="190" y="4" width="270" height="14" rx="5" fill="var(--field)" /><rect x="190" y="4" width={Math.max(4, 270 * a.avg / 4)} height="14" rx="5" fill="var(--s1)" />
            <text x="468" y="16" fontSize="11" fill="var(--muted)">{a.avg} · {a.n}</text></g>)}
        </svg>
      )}
    </div>
  )
}

function NextStep({ d, setTab }) {
  const n = nextStep(d)
  return (
    <div className="card next-step">
      <ol className="steps" aria-label="Progress">{STEPS.map((t, i) => <li key={t} className={i + 1 === n.n ? 'on' : i + 1 < n.n ? 'done' : ''}><span>{i + 1 < n.n ? '✓' : i + 1}</span>{t}</li>)}</ol>
      <div className="row between"><p style={{ margin: 0 }}><b>Next:</b> {n.text}</p><button onClick={() => setTab(n.tab)}>{n.go}</button></div>
    </div>
  )
}

// ---------- ask the planner ----------
const EXAMPLES = name => name
  ? [`What can I try to help ${name} say longer sentences?`, `Why might ${name} be losing interest in lessons?`, `What should ${name} learn next?`, `How can I help ${name} when frustrated?`]
  : ['How do I help a child who hits when an activity ends?', 'Why might a child lose interest during lessons?', 'What are good first steps for a child who says only single words?', 'How can parents practise at home?']

function Ask() {
  const [kids] = useApi('/therapy/children')
  const [log, setLog] = useState([])
  const [childId, setChildId] = useState('')
  const [lang, setLang] = useState('en')
  const [q, setQ] = useState('')
  const { run, error, busy } = useAction()
  const name = kids?.find(k => String(k.id) === childId)?.name
  const ask = () => {
    const question = q.trim()
    if (!question || busy) return
    run(async () => {
      const r = await api('/therapy/ask', { body: { question, child_id: childId || null, lang } })
      setLog(l => [{ q: question, who: name || 'General', r }, ...l]); setQ('')
    })
  }
  return (
    <div className="card ask">
      <div className="ask-head"><span className="ask-ic"><Icon name="ask" size={20} /></span>
        <div><h3>Ask about a child or a problem</h3><p className="muted">Answers use the child's recorded profile, goals and sessions. They are suggestions for a professional to review.</p></div></div>
      <div className="ask-row">
        <label>About<Select value={childId} onChange={e => setChildId(e.target.value)} options={(kids || []).map(k => [k.id, k.name])} blank="General question (no child)" /></label>
        <label>Answer in<Select value={lang} onChange={e => setLang(e.target.value)} options={[['en', 'English'], ['ur', 'Roman Urdu']]} blank={null} /></label>
      </div>
      <textarea className="ask-box" rows={3} maxLength={1500} value={q} onChange={e => setQ(e.target.value)} placeholder={name ? `Ask anything about ${name}…` : 'Describe a problem or ask a question…'}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask() } }} />
      <div className="ask-foot">
        <div className="ask-chips">{EXAMPLES(name).slice(0, 3).map(x => <button type="button" key={x} className="ask-chip" onClick={() => setQ(x)}>{x}</button>)}</div>
        <button onClick={ask} disabled={busy || !q.trim()}>{busy ? 'Thinking…' : 'Ask'}</button>
      </div>
      <Err e={error} />
      {busy && <p className="muted ask-wait">Reading the records and thinking it through…</p>}
      {log.map((x, i) => (
        <div key={i} className="ask-answer">
          <p className="ask-q"><span>{x.who}</span>{x.q}</p>
          <div className="ask-a">
            <p>{x.r.answer}</p>
            {arr(x.r.suggestions).length > 0 && <><h4>What to try</h4><ol>{arr(x.r.suggestions).map((t, k) => <li key={k}>{t}</li>)}</ol></>}
            {x.r.consult_specialist && <p className="ask-warn"><b>Consider a specialist:</b> {x.r.consult_specialist}</p>}
            {(arr(x.r.based_on).length > 0 || arr(x.r.missing_information).length > 0) && <details><summary className="muted">Sources and gaps</summary>
              <L title="Based on" items={x.r.based_on} /><L title="Missing information" items={x.r.missing_information} /></details>}
          </div>
        </div>
      ))}
      {log.length > 0 && <button type="button" className="ghost" onClick={() => setLog([])}>Clear answers</button>}
    </div>
  )
}

function AiSettings({ d, reload }) {
  const ai = d.ai
  const { run, error, busy } = useAction()
  const [provider, setProvider] = useState(ai.provider)
  const [test, setTest] = useState(null)
  const prov = ai.providers.find(p => p.id === provider)
  const save = e => { e.preventDefault(); const body = formData(e); run(async () => { await api('/therapy/org', { method: 'PUT', body: { ai_provider: provider, ai_model: body.ai_model, ai_key: body.ai_key } }); setTest(null); reload() }) }
  const check = () => run(async () => setTest(await api('/therapy/org/ai-test', { body: {} })))
  return (
    <form className="card grid" onSubmit={save} key={ai.provider + ai.model + ai.has_key}>
      <h3 className="wide">AI provider</h3>
      <p className="muted wide" style={{ margin: 0 }}>
        {ai.using === 'own' ? 'Your own AI account is being used.' : ai.using === 'platform' ? 'The platform\'s shared AI is being used. You can switch to your own account below.' : 'No AI is configured yet. Add your own provider key below.'}
      </p>
      <label>Provider<Select value={provider} onChange={e => setProvider(e.target.value)} options={ai.providers.map(p => [p.id, p.label])} blank="Platform AI (default)" disabled={!d.can_edit} /></label>
      {provider && <>
        <label>Model<input name="ai_model" defaultValue={ai.model} placeholder={prov?.model} disabled={!d.can_edit} /></label>
        <label className="wide">API key<input name="ai_key" type="password" autoComplete="off" placeholder={ai.has_key ? `Saved ${ai.key_hint || ''}. Leave blank to keep it` : 'Paste your API key'} disabled={!d.can_edit} /></label>
        {!ai.can_store && <p className="error wide">This server has no AI_KEY_SECRET, so it cannot store keys safely yet.</p>}
        <small className="muted wide">Keys are encrypted before they are stored and are never shown again. Plans and assessments are sent to this provider: choose one whose data policy suits your children's records.</small>
      </>}
      <Err e={error} />
      {test && <p className="ok wide">Connected to {test.provider} ({test.model}) ✓</p>}
      {d.can_edit && <div className="wide row">
        <button disabled={busy}>Save AI settings</button>
        <button type="button" className="ghost" disabled={busy || ai.using === 'none'} onClick={check}>{busy ? 'Testing…' : 'Test connection'}</button>
        {ai.has_key && <button type="button" className="ghost danger" disabled={busy} onClick={() => run(async () => { await api('/therapy/org', { method: 'PUT', body: { ai_provider: '', clear_ai_key: true } }); setProvider(''); reload() })}>Remove my key</button>}
      </div>}
    </form>
  )
}
