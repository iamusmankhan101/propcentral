import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const portPlan = 50000 + (process.pid % 2000)
const portTrial = 51000 + (process.pid % 2000)
const portCap = 52000 + (process.pid % 2000)

async function boot(t, port, env = {}) {
  const dbPath = path.join(os.tmpdir(), `prop-central-plan-${port}.db`)
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
const patch = (base, path, body, token) =>
  fetch(base + path, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
const get = (base, path, token) => fetch(base + path, { headers: { authorization: 'Bearer ' + token } })
const login = (base, email) => post(base, '/login', { email, password: 'password123' }).then(r => r.json()).then(d => d.token)
const signup = (base, name, email, plan) => post(base, '/register', { name, email, password: 'Passw0rd12345', plan })

test('sign-up chooses a plan and starts the 7-day clock', async t => {
  const base = await boot(t, portPlan)
  const admin = await login(base, 'admin@propcentral.local')

  const wrong = await signup(base, 'No Plan', 'noplan@example.com', 'platinum')
  assert.equal(wrong.status, 400)
  assert.match((await wrong.json()).error, /Choose a plan/)

  const r = await signup(base, 'Zara Iqbal', 'zara@example.com', 'Starter') // the picker sends the label
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.plan, 'starter')
  const days = (new Date(body.trial_ends_at) - Date.now()) / 864e5
  assert.ok(days > 6.9 && days <= 7, `trial runs ${days} days from sign-up`)

  const users = await (await get(base, '/users', admin)).json()
  const zara = users.find(u => u.email === 'zara@example.com')
  assert.equal(zara.plan, 'starter')
  assert.ok(zara.trial_ends_at && !zara.paid_at, 'the admin sees the trial, not a payment')
  const meta = await (await get(base, '/meta', admin)).json()
  assert.equal(meta.me.trial_days_left, null, 'an account with no plan shows no trial banner')
})

test('an expired trial locks sign-in until an admin marks it paid', async t => {
  const base = await boot(t, portTrial, { TRIAL_DAYS: '0' })
  const admin = await login(base, 'admin@propcentral.local')

  await signup(base, 'Iftikhar Ali', 'ifti@example.com', 'solo')
  const users = await (await get(base, '/users', admin)).json()
  const u = users.find(x => x.email === 'ifti@example.com')
  assert.equal((await post(base, `/users/${u.id}/activate`, {}, { authorization: 'Bearer ' + admin })).status, 200)

  const blocked = await post(base, '/login', { email: 'ifti@example.com', password: 'Passw0rd12345' })
  assert.equal(blocked.status, 403)
  const why = await blocked.json()
  assert.equal(why.trial_ended, true, 'the login screen gets the fields for its activate panel')
  assert.match(why.error, /trial ended/)
  assert.equal(why.support, '923058562523')

  assert.equal((await post(base, `/users/${u.id}/mark-paid`, {}, { authorization: 'Bearer ' + admin })).status, 200)
  const again = await post(base, '/login', { email: 'ifti@example.com', password: 'Passw0rd12345' })
  assert.equal(again.status, 200, 'marking it paid opens the door again')
})

test('the acting account plan caps the whole company, not one branch', async t => {
  const base = await boot(t, portCap)
  const admin = await login(base, 'admin@propcentral.local')
  const auth = { authorization: 'Bearer ' + admin }
  const me = (await (await get(base, '/meta', admin)).json()).me.id
  const setPlan = plan => patch(base, `/users/${me}`, { plan }, admin)
  // no branch_id on purpose: a seat outside every branch still counts
  const add = email => post(base, '/users', { name: email.split('@')[0], email, role: 'agent', password: 'Passw0rd12345' }, auth)

  assert.equal((await add('seat1@example.com')).status, 200, 'no plan on the actor = the pre-billing account, never capped')

  assert.equal((await setPlan('solo')).status, 200)
  const tooManySeats = await add('seat2@example.com')
  assert.equal(tooManySeats.status, 400)
  assert.match((await tooManySeats.json()).error, /covers 1 user\./)

  const branch = await post(base, '/branches', { name: 'Faisalabad' }, auth)
  assert.equal(branch.status, 400, 'the seed branch already uses the Solo allowance')
  assert.match((await branch.json()).error, /covers 1 branch\./)

  // the seed project takes one of Solo's three, so the fourth is refused
  const named = i => post(base, '/projects', { name: `Cap Test ${i} ${Date.now()}`, city: 'Lahore', kind: 'land', marla_sqft: 225 }, auth)
  assert.equal((await named(2)).status, 200)
  assert.equal((await named(3)).status, 200)
  const overProject = await named(4)
  assert.equal(overProject.status, 400, 'the third new project is one past the plan')
  assert.match((await overProject.json()).error, /covers 3 projects\./)

  // a batch is measured against the ceiling before any row is written
  const units = n => post(base, '/projects/1/units', { units: Array.from({ length: n }, (_, i) =>
    ({ block: 'C', unit_no: 'BULK' + i, unit_type: 'Plot', size: 5, uom: 'marla' })) }, auth)
  assert.match((await (await units(270)).json()).error, /covers 300 units\./, 'the seed holds 40 of Solo 300 units')
  assert.equal((await units(250)).status, 200, 'the room that is left still fits')

  const importRows = n => post(base, '/leads/import', { commit: true, rows: Array.from({ length: n }, (_, i) =>
    ({ name: `Bulk ${i}`, phone: '03' + String(70000000 + i), source: 'Website' })) }, auth)
  assert.match((await (await importRows(1000)).json()).error, /covers 1,000 leads\./, 'a batch over the ceiling is refused whole')
  assert.equal((await importRows(2)).status, 200, 'under the ceiling the same call works')

  assert.equal((await setPlan('agency')).status, 200)
  assert.equal((await add('seat2@example.com')).status, 200, 'Agency lifts the seat cap')
  assert.equal((await post(base, '/branches', { name: 'Faisalabad' }, auth)).status, 200, 'the branch cap')
  assert.equal((await named(5)).status, 200, 'the project cap')
  assert.equal((await units(300)).status, 200, 'and the inventory cap')
})

test('platform owner is seeded from env, sees users but no CRM data, and cannot be created by an admin', async t => {
  const base = await boot(t, 53000 + (process.pid % 2000), { PLATFORM_ADMIN_EMAIL: 'owner@example.com', PLATFORM_ADMIN_PASSWORD: 'OwnerPass12345' })
  const token = await post(base, '/login', { email: 'owner@example.com', password: 'OwnerPass12345' }).then(r => r.json()).then(d => d.token)
  assert.ok(token)
  assert.equal((await get(base, '/users', token)).status, 200)
  const leads = await get(base, '/leads', token)
  assert.ok(leads.status === 403 || ((await leads.json()).rows ?? []).length === 0)
  const admin = await login(base, 'admin@propcentral.local')
  const r = await post(base, '/users', { name: 'X', email: 'x@example.com', role: 'platform' }, { authorization: 'Bearer ' + admin })
  assert.equal(r.status, 403)
})
