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

test('the acting account plan caps users and branches', async t => {
  const base = await boot(t, portCap)
  const admin = await login(base, 'admin@propcentral.local')
  const me = (await (await get(base, '/meta', admin)).json()).me.id
  const add = (email, branch_id = 1) => post(base, '/users',
    { name: email.split('@')[0], email, role: 'agent', password: 'Passw0rd12345', branch_id }, { authorization: 'Bearer ' + admin })

  assert.equal((await add('free1@example.com')).status, 200, 'no plan on the actor = the pre-billing account, never capped')

  assert.equal((await patch(base, `/users/${me}`, { plan: 'solo' }, admin)).status, 200)
  const tooMany = await add('free2@example.com')
  assert.equal(tooMany.status, 400)
  assert.match((await tooMany.json()).error, /covers 1 user\./)

  const branch = await post(base, '/branches', { name: 'Faisalabad' }, { authorization: 'Bearer ' + admin })
  assert.equal(branch.status, 400)
  assert.match((await branch.json()).error, /covers 1 branch\./)

  assert.equal((await patch(base, `/users/${me}`, { plan: 'starter' }, admin)).status, 200)
  assert.match((await (await add('free2@example.com')).json()).error, /covers 5 users\./, 'the wording pluralises above one seat')

  assert.equal((await patch(base, `/users/${me}`, { plan: 'agency' }, admin)).status, 200)
  assert.equal((await add('free2@example.com')).status, 200, 'Agency lifts the user cap')
  assert.equal((await post(base, '/branches', { name: 'Faisalabad' }, { authorization: 'Bearer ' + admin })).status, 200, 'and the branch cap')
})
