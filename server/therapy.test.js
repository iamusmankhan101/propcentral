import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const port = 57000 + (process.pid % 2000)
const PLATFORM = { email: 'boss@example.com', password: 'PlatformPass123' }
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

async function boot(t) {
  const dbPath = path.join(os.tmpdir(), `prop-central-therapy-${port}.db`)
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '', AI_KEY_SECRET: 'test-secret', GROQ_API_KEY: process.env.FAKE_AI ? 'test-key' : '', GROQ_BASE_URL: process.env.FAKE_AI || '',
      PLATFORM_ADMIN_EMAIL: PLATFORM.email, PLATFORM_ADMIN_PASSWORD: PLATFORM.password },
    stdio: 'ignore',
  })
  t.after(async () => {
    child.kill()
    await sleep(300)
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true })
  })
  const base = `http://127.0.0.1:${port}/api`
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return base } catch {}
    await sleep(100)
  }
  throw new Error('server did not start')
}
const call = (base, method, p, token, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) })
const login = (base, email, password = 'Passw0rd12345') => call(base, 'POST', '/login', null, { email, password }).then(r => r.json()).then(d => d.token)


// a stand-in for the AI provider: answers by the JSON shape the server asks for
function fakeAI(t) {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
      const u = JSON.parse(b).messages.at(-1).content
      if (u.includes('FENCED')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ choices: [{ message: { content: 'Here you go:\n```json\n{"reported_difficulties":["few words"],"learning_priorities":[]}\n```' } }] })) }
      if (u.includes('FORCE402')) { res.statusCode = 402; return res.end('{}') }
      if (u.includes('FORCE401')) { res.statusCode = 401; return res.end('{}') }
      const goal = { area: 'Speech and language', kind: 'three_month', current_skill: 'says single words', target_skill: 'two-word phrases', rationale: 'next step', prerequisites: 'single words', teaching: 'model and expand', activities: 'snack time', success_criteria: '8/10 trials', measure: 'trial count', timeframe: '3 months', priority: 'high' }
      const out = u.includes('"consult_specialist"') ? { answer: u.includes('Zebrafish protocol') && u.includes('knowledge_base') ? 'used-kb' : u.includes('one child') ? 'child-specific' : 'general', suggestions: ['try x'], based_on: [], missing_information: [], consult_specialist: null }
        : u.includes('"insights"') ? { insights: [{ child_id: 1, type: 'attention', title: 'Check Ali', why: 'w', suggestion: 's' }, { child_id: 999, type: 'attention', title: 'not yours', why: '', suggestion: '' }], missing_information: [] }
        : u.includes('"outcomes"') ? { outcomes: [{ goal_id: 1, outcome: 'Partially achieved', evidence: 'x' }], developmental_progress: { improved: ['a'], remaining_difficulties: ['b'] }, intervention_analysis: { effective: ['Ali responded well to picture cards at snack time', 'ok'], needs_modification: [] }, next_step_recommendations: ['c'], missing_information: [], next_goals: [{ ...goal, target_skill: 'three-word phrases' }] }
        : u.includes('"goals"') ? { goals: [goal], missing_information: ['hearing check'] }
        : u.includes('"reported_difficulties"') ? { reported_difficulties: 'few words', strengths: null, demonstrated_abilities: [], strengths: [], areas_needing_further_assessment: [], suggested_questions: [], baseline_methods: [], learning_priorities: [] }
        : u.includes('"learning_objective"') ? { title: 'Lesson', learning_objective: 'obj', steps: ['s'] }
        : { possible_reasons: ['r'], alternative_methods: ['m'], different_from_before: 'd' }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }))
    })
  })
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => { t.after(() => srv.close()); ok(`http://127.0.0.1:${srv.address().port}`) }))
}

async function company(base, name, email, modules) {
  const boss = await login(base, PLATFORM.email, PLATFORM.password)
  await call(base, 'POST', '/register', null, { name, email, password: 'Passw0rd12345', plan: modules.includes('therapy') ? 'therapy' : 'starter', modules })
  const main = (await (await call(base, 'GET', '/platform/accounts', boss)).json()).find(a => a.email === email)
  await call(base, 'POST', `/users/${main.id}/activate`, boss)
  return login(base, email)
}
const J = r => r.json()

test('therapy: module-gated and account-scoped', async t => {
  const base = await boot(t)
  const off = await company(base, 'No Therapy Co', 'nt@example.com', ['edu'])
  assert.equal((await call(base, 'GET', '/therapy/children', off)).status, 403, 'module off = refused')
  const a = await company(base, 'Clinic A', 'a@example.com', ['therapy'])
  const b = await company(base, 'Clinic B', 'b@example.com', ['therapy'])
  const id = (await J(await call(base, 'POST', '/therapy/children', a, { name: 'Ali', dob: '2021-01-01' }))).id
  assert.equal((await call(base, 'POST', '/therapy/children', a, { name: '' })).status, 400)
  assert.equal((await J(await call(base, 'GET', '/therapy/children', a))).length, 1)
  assert.equal((await call(base, 'GET', `/therapy/children/${id}`, b)).status, 404, 'another company cannot read the child')
  assert.equal((await call(base, 'POST', `/therapy/children/${id}/assessment`, a, { text: 'x' })).status, 503, 'AI not configured says so')
  assert.equal((await call(base, 'POST', `/therapy/children/${id}/goals/generate`, a, {})).status, 400, 'no goals before an approved assessment')
  assert.equal((await call(base, 'POST', `/therapy/children/${id}/review`, a, {})).status, 400, 'no review without a plan')
})

test('therapy: assessment -> goals -> lesson -> session -> intervention -> review -> next plan', async t => {
  process.env.FAKE_AI = await fakeAI(t)
  const base = await boot(t)
  delete process.env.FAKE_AI
  const a = await company(base, 'Clinic A', 'a@example.com', ['therapy'])
  const id = (await J(await call(base, 'POST', '/therapy/children', a, { name: 'Ali' }))).id
  const get = async () => J(await call(base, 'GET', `/therapy/children/${id}`, a))

  const aid = (await J(await call(base, 'POST', `/therapy/children/${id}/assessment`, a, { text: 'says only I food' }))).id
  const draftA = (await get()).assessments[0].result
  assert.deepEqual(draftA.reported_difficulties, ['few words'], 'a string from the AI becomes a list')
  assert.deepEqual(draftA.strengths, [], 'null becomes an empty list')
  assert.equal((await call(base, 'POST', `/therapy/children/${id}/goals/generate`, a, {})).status, 400, 'draft assessment is not enough')
  assert.equal((await call(base, 'PATCH', `/therapy/assessments/${aid}`, a, { approve: true })).status, 200)
  const gen = await J(await call(base, 'POST', `/therapy/children/${id}/goals/generate`, a, {}))
  assert.equal(gen.added, 1)
  let d = await get()
  const goal = d.goals[0]
  assert.equal(goal.status, 'proposed')
  assert.equal((await call(base, 'POST', `/therapy/goals/${goal.id}/lesson`, a, {})).status, 400, 'lessons need an approved goal')

  assert.equal((await call(base, 'PATCH', `/therapy/goals/${goal.id}`, a, { target_skill: 'edited by educator' })).status, 200, 'a draft can be edited')
  assert.equal((await call(base, 'PATCH', `/therapy/goals/${goal.id}`, a, { status: 'approved' })).status, 200)
  assert.equal((await call(base, 'PATCH', `/therapy/goals/${goal.id}`, a, { target_skill: 'sneaky' })).status, 400, 'an approved goal is locked')
  assert.equal((await call(base, 'PATCH', `/therapy/goals/${goal.id}`, a, { status: 'proposed' })).status, 400, 'and cannot go back to draft')
  assert.equal((await call(base, 'POST', `/therapy/goals/${goal.id}/lesson`, a, { kind: 'weekly' })).status, 200)

  assert.equal((await call(base, 'POST', `/therapy/children/${id}/sessions`, a, {})).status, 400, 'an empty session is refused')
  const s = await J(await call(base, 'POST', `/therapy/children/${id}/sessions`, a, { goal_id: goal.id, activities: 'snack', response: 'said "I want"', trials: 10, independent: 3, prompted: 5, assistance: 'Verbal prompt', difficulties: 'lost interest', progress: 'Developing' }))
  assert.equal((await call(base, 'POST', `/therapy/sessions/${s.id}/analyze`, a, {})).status, 200)
  d = await get()
  assert.equal(d.goals.find(g => g.id === goal.id).progress, 'Developing', 'a session moves the goal status')
  assert.ok(d.sessions[0].analysis.alternative_methods.length, 'intervention saved')
  assert.equal(d.lessons.length, 1)

  const dash = await J(await call(base, 'GET', '/therapy/dashboard', a))
  assert.deepEqual([dash.children, dash.active_plans, dash.in_progress], [1, 1, 1])
  assert.equal(dash.charts.weekly.length, 8)
  assert.equal(dash.charts.weekly.at(-1).sessions, 1, 'this week has the session just recorded')
  assert.equal(dash.charts.weekly.at(-1).independent_pct, 30, '3 of 10 trials independent')
  assert.equal(dash.charts.progress.find(x => x.label === 'Developing').n, 1)
  assert.deepEqual(dash.charts.areas.map(x => [x.area, x.n]), [['Speech and language', 1]])

  assert.equal((await call(base, 'POST', `/therapy/children/${id}/review`, a, {})).status, 200)
  d = await get()
  const cycle = d.cycles.find(c => c.status === 'active')
  assert.equal(cycle.review.outcomes[0].outcome, 'Partially achieved')
  const next = d.goals.find(g => g.target_skill === 'three-word phrases')
  assert.equal(next.status, 'proposed', 'next-quarter goals wait for approval')
  assert.equal((await call(base, 'POST', `/therapy/cycles/${cycle.id}/approve-review`, a, {})).status, 200)
  assert.equal((await get()).cycles.find(c => c.id === cycle.id).status, 'closed')
})

test('modules picked at sign-up are saved; unknown ones ignored', async t => {
  const base = await boot(t)
  const boss = await login(base, PLATFORM.email, PLATFORM.password)
  assert.equal((await call(base, 'POST', '/register', null, { name: 'None Co', email: 'none@example.com', password: 'Passw0rd12345', plan: 'starter', modules: ['bogus'] })).status, 400, 'at least one real module')
  await call(base, 'POST', '/register', null, { name: 'Pick Co', email: 'pick@example.com', password: 'Passw0rd12345', plan: 'therapy', modules: ['therapy', 'bogus'] })
  const main = (await J(await call(base, 'GET', '/platform/accounts', boss))).find(a => a.email === 'pick@example.com')
  const token = await login(base, 'pick@example.com') // no activation step: email verification is off by default
  assert.ok(token, 'a new sign-up can sign in straight away')
  assert.equal((await call(base, 'POST', '/therapy/children', token, { name: 'Sara' })).status, 200, 'therapy was on from sign-up')
})

const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
async function staffUser(base, adminTok, name, email, role) {
  const r = await J(await call(base, 'POST', '/users', adminTok, { name, email, role, password: 'Passw0rd12345' }))
  await call(base, 'POST', `/users/${r.id}/activate`, adminTok)
  return { id: r.id, token: await login(base, email) }
}

test('therapy: roles, assigned staff, parent portal, home practice, messages', async t => {
  const base = await boot(t)
  const admin = await company(base, 'Clinic A', 'a@example.com', ['therapy'])
  const other = await company(base, 'Clinic B', 'b@example.com', ['therapy'])
  const kid = (await J(await call(base, 'POST', '/therapy/children', admin, { name: 'Ali' }))).id
  const kid2 = (await J(await call(base, 'POST', '/therapy/children', admin, { name: 'Sara' }))).id
  const slt = await staffUser(base, admin, 'Speech T', 'slt@example.com', 'speech_therapist')
  const agent = await staffUser(base, admin, 'Plain Agent', 'agent@example.com', 'agent')

  assert.equal((await J(await call(base, 'GET', '/therapy/children', slt.token))).length, 0, 'an unassigned therapist sees no children')
  assert.equal((await call(base, 'GET', `/therapy/children/${kid}`, slt.token)).status, 404)
  assert.equal((await call(base, 'PUT', `/therapy/children/${kid}/staff`, agent.token, { user_ids: [slt.id] })).status, 404, 'a user outside the child team cannot even see them')
  assert.equal((await call(base, 'PUT', `/therapy/children/${kid}/staff`, admin, { user_ids: [slt.id] })).status, 200)
  assert.deepEqual((await J(await call(base, 'GET', '/therapy/children', slt.token))).map(c => c.name), ['Ali'], 'sees only the assigned child')
  assert.equal((await call(base, 'GET', `/therapy/children/${kid2}`, slt.token)).status, 404)

  // a goal added by a non-approver stays a draft and cannot be approved by them
  assert.equal((await call(base, 'POST', `/therapy/children/${kid}/goals`, agent.token, { target_skill: 'x' })).status, 404)
  const mine = (await J(await call(base, 'POST', `/therapy/children/${kid}/goals`, slt.token, { target_skill: 'two-word phrases', area: 'Speech and language', success_criteria: '8/10' }))).id
  const draft = (await J(await call(base, 'POST', `/therapy/children/${kid}/goals`, admin, { target_skill: 'ok' }))).id
  assert.ok(mine && draft)
  let d = await J(await call(base, 'GET', `/therapy/children/${kid}`, admin))
  assert.equal(d.goals.find(g => g.id === mine).status, 'approved', 'a professional own goal is approved')
  assert.equal(d.can_approve, true)

  // photo
  assert.equal((await call(base, 'PATCH', `/therapy/children/${kid}`, admin, { photo: 'data:text/html;base64,AAAA' })).status, 400)
  assert.equal((await call(base, 'PATCH', `/therapy/children/${kid}`, admin, { photo: TINY_JPEG })).status, 200)

  // parent portal
  assert.equal((await call(base, 'POST', `/therapy/children/${kid}/parent`, agent.token, { name: 'P', email: 'p@example.com', password: 'Passw0rd12345' })).status, 404)
  assert.equal((await call(base, 'POST', `/therapy/children/${kid}/parent`, admin, { name: 'Mrs Ali', email: 'mom@example.com', password: 'short' })).status, 400)
  assert.equal((await call(base, 'POST', `/therapy/children/${kid}/parent`, admin, { name: 'Mrs Ali', email: 'mom@example.com', password: 'Passw0rd12345' })).status, 200)
  const mom = await login(base, 'mom@example.com')
  assert.equal((await call(base, 'GET', '/therapy/children', mom)).status, 403, 'a parent cannot use the professional side')
  assert.equal((await call(base, 'PATCH', `/therapy/goals/${mine}`, mom, { progress: 'Achieved' })).status, 403, 'nor change goals')
  assert.equal((await call(base, 'PATCH', `/therapy/goals/${draft}`, admin, { status: 'rejected' })).status, 200)
  const portal = await J(await call(base, 'GET', `/therapy/portal/${kid}`, mom))
  assert.deepEqual(portal.goals.map(g => g.target_skill), ['two-word phrases'], 'only approved goals are visible, not rejected ones')
  assert.equal((await call(base, 'GET', `/therapy/portal/${kid2}`, mom)).status, 404, 'only their own child')
  const dad = await company(base, 'Elsewhere', 'e@example.com', ['therapy'])
  assert.equal((await call(base, 'GET', `/therapy/portal/${kid}`, dad)).status, 403, 'not a parent')

  assert.equal((await call(base, 'POST', `/therapy/children/${kid}/homework`, slt.token, { goal_id: mine, text: 'Name foods at dinner' })).status, 200)
  const hw = (await J(await call(base, 'GET', `/therapy/portal/${kid}`, mom))).homework[0]
  assert.equal((await call(base, 'POST', `/therapy/portal/${kid}/homework/${hw.id}/done`, mom, { note: 'did it' })).status, 200)
  assert.equal((await call(base, 'POST', `/therapy/portal/${kid}/messages`, mom, { body: 'He said "more juice"', kind: 'observation' })).status, 200)
  d = await J(await call(base, 'GET', `/therapy/children/${kid}`, slt.token))
  assert.ok(d.homework[0].done_at, 'staff see the task done')
  assert.equal(d.messages[0].kind, 'observation')
  assert.equal(d.parents.length, 1)
  assert.equal((await call(base, 'POST', `/therapy/children/${kid}/messages`, slt.token, { body: 'Great!' })).status, 200)
  assert.equal((await J(await call(base, 'GET', `/therapy/portal/${kid}`, mom))).messages.length, 2)
  void other
})

test('therapy: reports, skills library, AI insights', async t => {
  process.env.FAKE_AI = await fakeAI(t)
  const base = await boot(t)
  delete process.env.FAKE_AI
  const a = await company(base, 'Clinic A', 'a@example.com', ['therapy'])
  const id = (await J(await call(base, 'POST', '/therapy/children', a, { name: 'Ali' }))).id
  const rep = await J(await call(base, 'GET', `/therapy/children/${id}/report?from=2020-01-01`, a))
  assert.equal(rep.organization, 'Clinic A'); assert.equal(rep.child.name, 'Ali'); assert.equal(rep.from, '2020-01-01')

  const lib = await J(await call(base, 'GET', '/therapy/skills', a))
  assert.equal(lib.categories.length, 14); assert.ok(lib.skills.length >= 14)
  assert.ok((await J(await call(base, 'GET', '/therapy/skills?q=pincer', a))).skills.length >= 1, 'search works')
  assert.equal((await call(base, 'POST', '/therapy/skills', a, { name: 'x', category: 'bogus' })).status, 400)
  const sk = (await J(await call(base, 'POST', '/therapy/skills', a, { name: 'My skill', category: 'Self-care' }))).id
  const b = await company(base, 'Clinic B', 'b@example.com', ['therapy'])
  assert.equal((await J(await call(base, 'GET', '/therapy/skills?q=My skill', b))).skills.length, 0, "another company's skills stay private")
  assert.equal((await call(base, 'DELETE', `/therapy/skills/${sk}`, a)).status, 200)
  assert.equal((await call(base, 'DELETE', '/therapy/skills/b0', a)).status, 404, 'starter skills stay')

  const ins = await J(await call(base, 'POST', '/therapy/dashboard/insights', a, {}))
  assert.equal(ins.insights.length, 1, 'insights about children outside the company are dropped')
})

test('therapy: server PDFs, org settings, delete child, super-admin overview', async t => {
  const base = await boot(t)
  const boss = await login(base, PLATFORM.email, PLATFORM.password)
  const admin = await company(base, 'Clinic A', 'a@example.com', ['therapy'])
  const kid = (await J(await call(base, 'POST', '/therapy/children', admin, { name: 'Ali', guardian: 'Mr Ali' }))).id
  await call(base, 'POST', `/therapy/children/${kid}/goals`, admin, { target_skill: 'two-word phrases', area: 'Speech and language', kind: 'three_month', success_criteria: '8/10' })

  for (const type of ['assessment', 'iep', 'session', 'weekly', 'monthly', 'quarterly', 'goals', 'domain', 'parent']) {
    const r = await call(base, 'GET', `/therapy/children/${kid}/report.pdf?type=${type}&comment=Well+done`, admin)
    assert.equal(r.status, 200, type)
    assert.match(r.headers.get('content-type'), /application\/pdf/)
    assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), '%PDF', `${type} is a real PDF`)
  }
  assert.equal((await call(base, 'GET', `/therapy/children/${kid}/report.pdf?type=bogus`, admin)).status, 400)

  // organization settings: admin edits, others cannot; cycle length drives the review date
  const slt = await staffUser(base, admin, 'Speech T', 'slt@example.com', 'speech_therapist')
  assert.equal((await call(base, 'PUT', '/therapy/org', slt.token, { display_name: 'Hacked' })).status, 403)
  assert.equal((await call(base, 'PUT', '/therapy/org', admin, { display_name: 'Bright Steps', cycle_days: 60, default_lang: 'ur', report_footer: 'Bright Steps Centre', guidelines: 'Play based' })).status, 200)
  const org = await J(await call(base, 'GET', '/therapy/org', slt.token))
  assert.equal(org.org.display_name, 'Bright Steps'); assert.equal(org.can_edit, false); assert.equal(org.counts.children, 1)
  const kid2 = (await J(await call(base, 'POST', '/therapy/children', admin, { name: 'Sara' }))).id
  await call(base, 'POST', `/therapy/children/${kid2}/goals`, admin, { target_skill: 'x' })
  const cyc = (await J(await call(base, 'GET', `/therapy/children/${kid2}`, admin)))
  const days = Math.round((new Date(cyc.cycles[0].review_date) - new Date(cyc.cycles[0].start_date)) / 864e5)
  assert.equal(days, 60, 'review cycle follows the organization setting')
  assert.equal(cyc.default_lang, 'ur')
  assert.equal((await J(await call(base, 'GET', `/therapy/children/${kid}/report`, admin))).organization, 'Bright Steps')

  // super admin sees counts only
  const ov = await J(await call(base, 'GET', '/therapy/platform/overview', boss))
  assert.equal(ov.find(o => o.email === 'a@example.com').children, 2)
  assert.equal(JSON.stringify(ov).includes('Ali'), false, 'no child names in the overview')
  assert.equal((await call(base, 'GET', '/therapy/platform/overview', admin)).status, 403)

  // delete: only approvers; parent login is switched off
  await call(base, 'POST', `/therapy/children/${kid}/parent`, admin, { name: 'Mom', email: 'mom@example.com', password: 'Passw0rd12345' })
  assert.ok(await login(base, 'mom@example.com'))
  assert.equal((await call(base, 'DELETE', `/therapy/children/${kid}`, slt.token)).status, 404, 'unassigned staff cannot even see it')
  assert.equal((await call(base, 'DELETE', `/therapy/children/${kid}`, admin)).status, 200)
  assert.equal((await call(base, 'GET', `/therapy/children/${kid}`, admin)).status, 404)
  assert.equal(await login(base, 'mom@example.com'), undefined, 'a parent with no child left cannot sign in')
})

test('therapy: ask the planner (child-specific, general, scoped)', async t => {
  process.env.FAKE_AI = await fakeAI(t)
  const base = await boot(t)
  delete process.env.FAKE_AI
  const a = await company(base, 'Clinic A', 'a@example.com', ['therapy'])
  const b = await company(base, 'Clinic B', 'b@example.com', ['therapy'])
  const kid = (await J(await call(base, 'POST', '/therapy/children', a, { name: 'Ali', difficulties: 'few words' }))).id
  assert.equal((await call(base, 'POST', '/therapy/ask', a, { question: '  ' })).status, 400)
  assert.equal((await J(await call(base, 'POST', '/therapy/ask', a, { question: 'How do I help?', child_id: kid }))).answer, 'child-specific')
  assert.equal((await J(await call(base, 'POST', '/therapy/ask', a, { question: 'Why do children lose interest?' }))).answer, 'general')
  assert.equal((await call(base, 'POST', '/therapy/ask', b, { question: 'x', child_id: kid })).status, 404, "cannot ask about another company's child")
})

test('therapy: per-organization AI settings are validated, sealed and never returned', async t => {
  process.env.FAKE_AI = await fakeAI(t)
  const base = await boot(t)
  delete process.env.FAKE_AI
  const a = await company(base, 'Clinic A', 'a@example.com', ['therapy'])
  const slt = await staffUser(base, a, 'Speech T', 'slt@example.com', 'speech_therapist')
  const kid = (await J(await call(base, 'POST', '/therapy/children', a, { name: 'Ali' }))).id

  // provider errors become plain messages
  const e402 = await call(base, 'POST', `/therapy/children/${kid}/assessment`, a, { text: 'FORCE402' })
  const fenced = await call(base, 'POST', `/therapy/children/${kid}/assessment`, a, { text: 'FENCED' })
  assert.equal(fenced.status, 200, 'JSON inside code fences is still read')
  assert.equal(e402.status, 502); assert.match((await J(e402)).error, /out of credit/)
  assert.match((await J(await call(base, 'POST', `/therapy/children/${kid}/assessment`, a, { text: 'FORCE401' }))).error, /key on the server was rejected/)

  assert.equal((await call(base, 'PUT', '/therapy/org', slt.token, { ai_provider: 'openrouter', ai_key: 'sk-x' })).status, 403, 'only the org admin')
  assert.equal((await call(base, 'PUT', '/therapy/org', a, { ai_provider: 'http://evil.local', ai_key: 'sk-x' })).status, 400, 'only listed providers: no arbitrary address')
  assert.equal((await call(base, 'PUT', '/therapy/org', a, { ai_provider: 'openrouter' })).status, 400, 'a provider needs a key')
  assert.equal((await call(base, 'PUT', '/therapy/org', a, { ai_provider: 'openrouter', ai_model: 'openai/gpt-4o-mini', ai_key: 'sk-or-secret-1234' })).status, 200)
  const org = await J(await call(base, 'GET', '/therapy/org', a))
  assert.equal(org.ai.provider, 'openrouter'); assert.equal(org.ai.has_key, true); assert.equal(org.ai.key_hint, '••••1234'); assert.equal(org.ai.using, 'own')
  assert.equal(JSON.stringify(org).includes('sk-or-secret'), false, 'the key is never returned')
  assert.equal(JSON.stringify(await J(await call(base, 'GET', `/therapy/children/${kid}`, a))).includes('sk-or-secret'), false)
  // other org settings survive an AI-only save
  await call(base, 'PUT', '/therapy/org', a, { display_name: 'Bright Steps' })
  assert.equal((await J(await call(base, 'GET', '/therapy/org', a))).ai.has_key, true, 'saving other settings keeps the key')
  assert.equal((await call(base, 'PUT', '/therapy/org', a, { ai_provider: '', clear_ai_key: true })).status, 200)
  const after = await J(await call(base, 'GET', '/therapy/org', a))
  assert.equal(after.ai.has_key, false); assert.equal(after.ai.using, 'platform')
})

test('therapy: knowledge base is scoped, approved before use, retrieved into prompts, and learns from reviews', async t => {
  process.env.FAKE_AI = await fakeAI(t)
  const base = await boot(t)
  delete process.env.FAKE_AI
  const a = await company(base, 'Clinic A', 'a@example.com', ['therapy'])
  const b = await company(base, 'Clinic B', 'b@example.com', ['therapy'])
  const agent = await staffUser(base, a, 'Plain Agent', 'agent@example.com', 'agent')
  const kid = (await J(await call(base, 'POST', '/therapy/children', a, { name: 'Ali' }))).id

  assert.equal((await call(base, 'POST', '/therapy/kb', a, { title: '', body: 'x' })).status, 400)
  const mine = await J(await call(base, 'POST', '/therapy/kb', a, { kind: 'guideline', title: 'Zebrafish protocol for transitions', body: 'Always give a two minute warning with a visual timer before an activity ends.' }))
  assert.equal(mine.status, 'active', 'a professional entry is live at once')
  const theirs = await J(await call(base, 'POST', '/therapy/kb', agent.token, { title: 'Agent idea', body: 'Something unreviewed that should not reach the AI yet.' }))
  assert.equal(theirs.status, 'pending', 'anyone else waits for approval')
  assert.equal((await call(base, 'PATCH', `/therapy/kb/${theirs.id}`, agent.token, { status: 'active' })).status, 403, 'and cannot approve it themselves')
  assert.equal((await J(await call(base, 'GET', '/therapy/kb', b))).entries.length, 0, "another company never sees it")
  assert.equal((await call(base, 'PATCH', `/therapy/kb/${mine.id}`, b, { status: 'off' })).status, 404)

  // retrieval: the matching entry reaches the prompt and is reported back
  const hit = await J(await call(base, 'POST', '/therapy/ask', a, { question: 'How should I handle transitions? Zebrafish protocol please', child_id: kid }))
  assert.equal(hit.answer, 'used-kb'); assert.ok(hit.kb_used.includes('Zebrafish protocol for transitions'))
  const miss = await J(await call(base, 'POST', '/therapy/ask', b, { question: 'How should I handle transitions? Zebrafish protocol please' }))
  assert.equal(miss.answer, 'general', "another company's knowledge is not used")
  await call(base, 'PATCH', `/therapy/kb/${mine.id}`, a, { status: 'off' })
  assert.equal((await J(await call(base, 'POST', '/therapy/ask', a, { question: 'Zebrafish protocol for transitions', child_id: kid }))).answer, 'one child'.length ? 'child-specific' : '', 'a switched-off entry is not used')

  // learning loop: an approved review proposes strategies as pending, child name removed
  const aid = (await J(await call(base, 'POST', `/therapy/children/${kid}/assessment`, a, { text: 'x' }))).id
  await call(base, 'PATCH', `/therapy/assessments/${aid}`, a, { approve: true })
  await call(base, 'POST', `/therapy/children/${kid}/goals/generate`, a, {})
  const goal = (await J(await call(base, 'GET', `/therapy/children/${kid}`, a))).goals[0]
  await call(base, 'PATCH', `/therapy/goals/${goal.id}`, a, { status: 'approved' })
  await call(base, 'POST', `/therapy/children/${kid}/sessions`, a, { goal_id: goal.id, activities: 'snack', response: 'ok' })
  assert.equal((await call(base, 'POST', `/therapy/children/${kid}/review`, a, {})).status, 200)
  const cyc = (await J(await call(base, 'GET', `/therapy/children/${kid}`, a))).cycles.find(c => c.status === 'active')
  assert.equal((await call(base, 'POST', `/therapy/cycles/${cyc.id}/approve-review`, a, {})).status, 200)
  const learned = (await J(await call(base, 'GET', '/therapy/kb?kind=learned', a))).entries
  assert.equal(learned.length, 1, 'the too-short suggestion is skipped')
  assert.equal(learned[0].status, 'pending'); assert.equal(learned[0].body.includes('Ali'), false, 'the child name is removed'); assert.match(learned[0].body, /the child responded well to picture cards/i)
})

test('therapy pricing: its own PKR 8,500 plan, enforced both ways', async t => {
  const base = await boot(t)
  const reg = (email, plan, modules) => call(base, 'POST', '/register', null, { name: 'P Co', email, password: 'Passw0rd12345', plan, modules })
  assert.equal((await reg('a@example.com', 'solo', ['therapy'])).status, 400, 'therapy cannot take a cheaper property plan')
  assert.equal((await reg('b@example.com', 'therapy', ['property'])).status, 400, 'property cannot take the therapy plan')
  assert.equal((await reg('c@example.com', 'therapy', ['therapy'])).status, 200)
  const boss = await login(base, PLATFORM.email, PLATFORM.password)
  const acc = (await J(await call(base, 'GET', '/platform/accounts', boss))).find(a => a.email === 'c@example.com')
  assert.equal(acc.plan, 'therapy')
  const dash = await J(await call(base, 'GET', '/platform/dashboard', boss))
  assert.equal(dash.revenue.find(r => r.plan === 'therapy').monthly !== undefined, true)
  // a property company cannot switch therapy on for itself
  await reg('d@example.com', 'solo', ['property'])
  const tok = await login(base, 'd@example.com')
  assert.equal((await call(base, 'POST', '/company/modules', tok, { modules: ['property', 'therapy'] })).status, 403)
})

