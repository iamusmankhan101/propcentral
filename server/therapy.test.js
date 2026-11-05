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
    env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '', GROQ_API_KEY: process.env.FAKE_AI ? 'test-key' : '', GROQ_BASE_URL: process.env.FAKE_AI || '',
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
      const u = JSON.parse(b).messages[1].content
      const goal = { area: 'Speech and language', kind: 'three_month', current_skill: 'says single words', target_skill: 'two-word phrases', rationale: 'next step', prerequisites: 'single words', teaching: 'model and expand', activities: 'snack time', success_criteria: '8/10 trials', measure: 'trial count', timeframe: '3 months', priority: 'high' }
      const out = u.includes('"outcomes"') ? { outcomes: [{ goal_id: 1, outcome: 'Partially achieved', evidence: 'x' }], developmental_progress: { improved: ['a'], remaining_difficulties: ['b'] }, intervention_analysis: { effective: [], needs_modification: [] }, next_step_recommendations: ['c'], missing_information: [], next_goals: [{ ...goal, target_skill: 'three-word phrases' }] }
        : u.includes('"goals"') ? { goals: [goal], missing_information: ['hearing check'] }
        : u.includes('"reported_difficulties"') ? { reported_difficulties: ['few words'], demonstrated_abilities: [], strengths: [], areas_needing_further_assessment: [], suggested_questions: [], baseline_methods: [], learning_priorities: [] }
        : u.includes('"learning_objective"') ? { title: 'Lesson', learning_objective: 'obj', steps: ['s'] }
        : { possible_reasons: ['r'], alternative_methods: ['m'], different_from_before: 'd' }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }))
    })
  })
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => { t.after(() => srv.close()); ok(`http://127.0.0.1:${srv.address().port}`) }))
}

async function company(base, name, email, modules) {
  const boss = await login(base, PLATFORM.email, PLATFORM.password)
  await call(base, 'POST', '/register', null, { name, email, password: 'Passw0rd12345', plan: 'starter', modules })
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
  await call(base, 'POST', '/register', null, { name: 'Pick Co', email: 'pick@example.com', password: 'Passw0rd12345', plan: 'starter', modules: ['therapy', 'bogus'] })
  const main = (await J(await call(base, 'GET', '/platform/accounts', boss))).find(a => a.email === 'pick@example.com')
  await call(base, 'POST', `/users/${main.id}/activate`, boss)
  const token = await login(base, 'pick@example.com')
  assert.equal((await call(base, 'POST', '/therapy/children', token, { name: 'Sara' })).status, 200, 'therapy was on from sign-up')
})
