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
  assert.equal((await post(base, '/register', { name: 'Real Person', email: realEmail, password: 'password123' })).status, 200)
  assert.equal((await post(base, '/login', { email: realEmail, password: 'password123' })).status, 403, 'real sign-up still reaches the approval queue')

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
