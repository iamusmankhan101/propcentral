import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const portA = 46000 + (process.pid % 2000)
const portB = 47000 + (process.pid % 2000)
const portC = 48000 + (process.pid % 2000)
const portD = 49000 + (process.pid % 2000)

async function boot(t, port, env = {}) {
  const dbPath = path.join(os.tmpdir(), `prop-central-sec-${port}.db`)
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '', ...env },
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

const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('API refuses abusive requests and replies with security headers', async t => {
  const base = await boot(t, portA)

  const health = await fetch(`${base}/health`)
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(health.headers.get('x-frame-options'), 'DENY')
  assert.match(health.headers.get('content-security-policy') || '', /frame-ancestors 'none'/)
  assert.equal(health.headers.get('x-powered-by'), null, 'does not advertise Express')

  assert.equal((await fetch(`${base}/meta`, { headers: { authorization: 'Bearer not-a-real-token' } })).status, 401, 'junk session ids never reach the lookup')

  const malformed = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error, 'Malformed JSON body')

  const giant = await post(base, '/login', { email: 'spam@example.com', password: 'x', pad: 'a'.repeat(2.5e6) })
  assert.equal(giant.status, 413, 'bodies above the non-upload limit are rejected before parsing')

  assert.equal((await post(base, '/login', { email: 'a'.repeat(300) + '@example.com', password: 'x' })).status, 400)
  assert.equal((await post(base, '/login', { email: 'long@example.com', password: 'x'.repeat(300) })).status, 400)

  const botEmail = `bot-${Date.now()}@example.com`
  const trapped = await post(base, '/register', { name: 'Spam Bot', email: botEmail, password: 'password123', website: 'https://spam.example' })
  assert.equal(trapped.status, 200)
  assert.deepEqual(await trapped.json(), { ok: true }, 'honeypot gets a success answer')
  assert.equal((await post(base, '/login', { email: botEmail, password: 'password123' })).status, 401, 'honeypot sign-up creates no account')

  const realEmail = `real-${Date.now()}@example.com`
  assert.equal((await post(base, '/register', { name: 'Real Person', email: realEmail, password: 'CrmPass2026x' })).status, 400, 'a sign-up has to pick a plan')
  assert.equal((await post(base, '/register', { name: 'Real Person', email: realEmail, password: 'CrmPass2026x', plan: 'growth' })).status, 200)
  assert.equal((await post(base, '/login', { email: realEmail, password: 'CrmPass2026x' })).status, 403, 'real sign-up still reaches the approval queue')

  const token = (await (await post(base, '/login', { email: 'admin@propcentral.local', password: 'password123' })).json()).token
  const auth = { authorization: 'Bearer ' + token }
  const project = await post(base, '/projects', { name: 'Security Test ' + Date.now(), city: 'Lahore', kind: 'land', marla_sqft: 225 }, auth)
  assert.equal(project.status, 200)
  const { id } = await project.json()
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g id="plots"/></svg>'
  assert.equal((await fetch(`${base}/projects/${id}/map`, { method: 'PUT', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ svg }) })).status, 200)
  const map = await fetch(`${base}/projects/${id}/map`, { headers: auth })
  assert.equal(map.status, 200)
  assert.match(map.headers.get('content-security-policy') || '', /^sandbox;/, 'shared SVGs cannot run script on our origin')
})

test('requests per address are capped with Retry-After', async t => {
  const base = await boot(t, portB, { API_RATE_LIMIT: '4' }) // boot's readiness probe uses one request
  const statuses = []
  let last
  for (let i = 0; i < 5; i++) {
    last = await fetch(`${base}/health`)
    statuses.push(last.status)
  }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429])
  assert.ok(Number(last.headers.get('retry-after')) > 0, 'tells the client when to come back')
  assert.match((await last.json()).error, /Too many requests/)
})

test('password reset, role checks, account isolation and SQL-injection shapes', async t => {
  const base = await boot(t, portC)
  const tokenOf = async (email, password = 'password123') => (await (await post(base, '/login', { email, password })).json()).token
  const get = (path, token) => fetch(base + path, { headers: { authorization: 'Bearer ' + token } })

  const weak = await post(base, '/reset-password', { token: 'a'.repeat(64), password: 'short' })
  assert.equal(weak.status, 400)
  assert.match((await weak.json()).error, /at least 10/, 'weak passwords are rejected before the token is even looked up')

  const admin = await tokenOf('admin@propcentral.local')
  const a1 = await tokenOf('agent1@propcentral.local')
  const a2 = await tokenOf('agent2@propcentral.local')

  assert.equal((await get('/users', a1)).status, 403, 'agents cannot list users')
  assert.equal((await fetch(`${base}/settings/statuses`, { method: 'PUT', headers: { authorization: 'Bearer ' + a1, 'content-type': 'application/json' }, body: '{}' })).status, 403, 'agents cannot change settings')

  const users = await (await get('/users', admin)).json()
  const agent2 = users.find(u => u.email === 'agent2@propcentral.local')
  const others = await (await get(`/leads?agent_id=${agent2.id}&size=50`, admin)).json()
  const lead = others.rows[0]
  assert.ok(lead, 'admin sees the seeded leads')
  assert.equal((await get(`/leads/${lead.id}`, a1)).status, 404, 'an agent cannot open another agent’s lead')
  assert.equal((await get(`/leads/${lead.id}`, a2)).status, 200, 'the owning agent still can')

  assert.equal((await post(base, '/login', { email: "' OR 1=1 --", password: 'x' })).status, 401, 'injection-shaped email is just a failed login')
  const inj = await get(`/leads?q=${encodeURIComponent("' OR ''='")}`, admin)
  assert.equal(inj.status, 200)
  assert.equal((await inj.json()).rows.length, 0, 'search input is bound, not concatenated')

  const issued = await (await post(base, `/users/${agent2.id}/reset-password`, {}, { authorization: 'Bearer ' + admin })).json()
  assert.match(issued.token, /^[a-f0-9]{64}$/)
  assert.equal((await post(base, '/reset-password', { token: issued.token, password: 'NewPass2026x' })).status, 200)
  assert.equal((await get('/meta', a2)).status, 401, 'a reset signs the account out everywhere')
  assert.equal((await post(base, '/login', { email: 'agent2@propcentral.local', password: 'password123' })).status, 401)
  assert.equal((await post(base, '/login', { email: 'agent2@propcentral.local', password: 'NewPass2026x' })).status, 200)
  assert.equal((await post(base, '/reset-password', { token: issued.token, password: 'Another2026x' })).status, 400, 'a reset link works once')

  const patch = (id, body) => fetch(`${base}/users/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin }, body: JSON.stringify(body) })
  const agent1 = users.find(u => u.email === 'agent1@propcentral.local')
  assert.equal((await patch(agent1.id, { available: true })).status, 200)
  assert.equal((await get('/meta', a1)).status, 200, 'a boolean in a body never reaches the driver: libsql panics on bool bindings and takes the whole API down')

  const forgot = await post(base, '/forgot-password', { email: 'nobody@example.com' })
  assert.equal(forgot.status, 200)
  assert.deepEqual(await forgot.json(), { ok: true }, 'unknown emails get the same answer')
})

test('leads delete for admins only, and never while they hold a booking', async t => {
  const base = await boot(t, portD)
  const tokenOf = async email => (await (await post(base, '/login', { email, password: 'password123' })).json()).token
  const get = (path, token) => fetch(base + path, { headers: { authorization: 'Bearer ' + token } })
  const del = (id, token) => fetch(`${base}/leads/${id}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + token } })
  const listIds = async token => (await (await get('/leads?size=50', token)).json()).rows.map(l => l.id)
  const admin = await tokenOf('admin@propcentral.local')
  const agent = await tokenOf('agent1@propcentral.local')

  const [booked, spare] = (await (await get('/leads?size=50', admin)).json()).rows
  assert.ok(booked && spare, 'seeded leads to work with')

  assert.equal((await del(booked.id, agent)).status, 403, 'agents cannot delete leads at all')

  const project = await (await get('/projects/1', admin)).json()
  const unit = project.units.find(u => u.status === 'Available')
  const allot = await post(base, `/units/${unit.id}/allot`,
    { status: 'Booked', expected: unit.status, sale_date: '2026-11-01', lead_id: booked.id, price: unit.price.total },
    { authorization: 'Bearer ' + admin })
  assert.equal(allot.status, 200, 'the booking goes through')
  const { allotment_no } = await allot.json()

  const blocked = await del(booked.id, admin)
  assert.equal(blocked.status, 400)
  assert.match((await blocked.json()).error, new RegExp(allotment_no), 'a client with a booking stays so the money trail keeps its owner')

  assert.equal((await del(spare.id, admin)).status, 200)
  assert.equal((await get(`/leads/${spare.id}`, admin)).status, 404, 'a deleted lead is gone from the CRM')
  assert.ok(!(await listIds(admin)).includes(spare.id), 'and off the lists')

  const audit = await (await get('/audit?entity=lead', admin)).json()
  assert.ok(audit.some(a => a.action === 'delete' && a.entity_id === spare.id), 'the deletion is written to the audit trail')
})
