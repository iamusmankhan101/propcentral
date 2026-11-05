import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
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
    env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '', GROQ_API_KEY: '',
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

async function company(base, name, email, modules) {
  const boss = await login(base, PLATFORM.email, PLATFORM.password)
  await call(base, 'POST', '/register', null, { name, email, password: 'Passw0rd12345', plan: 'starter' })
  const main = (await (await call(base, 'GET', '/platform/accounts', boss)).json()).find(a => a.email === email)
  await call(base, 'POST', `/users/${main.id}/activate`, boss)
  await call(base, 'POST', `/platform/accounts/${main.id}/modules`, boss, { modules })
  return login(base, email)
}

test('therapy: module-gated, account-scoped, plan needs the AI key, outcome saves', async t => {
  const base = await boot(t)
  const off = await company(base, 'No Therapy Co', 'nt@example.com', [])
  assert.equal((await call(base, 'GET', '/therapy/children', off)).status, 403, 'module off = refused')
  const a = await company(base, 'Clinic A', 'a@example.com', ['therapy'])
  const b = await company(base, 'Clinic B', 'b@example.com', ['therapy'])
  const id = (await (await call(base, 'POST', '/therapy/children', a, { name: 'Ali', age: '4y' })).json()).id
  assert.equal((await call(base, 'POST', '/therapy/children', a, { name: '' })).status, 400)
  assert.equal((await (await call(base, 'GET', '/therapy/children', a)).json()).length, 1)
  assert.equal((await call(base, 'GET', `/therapy/children/${id}`, b)).status, 404, 'another company cannot read the child')
  assert.equal((await call(base, 'POST', `/therapy/children/${id}/plan`, a, { area: 'speech', current: 'I food' })).status, 503, 'no GROQ_API_KEY configured')
  assert.equal((await call(base, 'POST', `/therapy/children/${id}/plan`, a, { area: 'nope', current: 'x' })).status, 503)
})

test('modules picked at sign-up are saved; unknown ones ignored', async t => {
  const base = await boot(t)
  const boss = await login(base, PLATFORM.email, PLATFORM.password)
  await call(base, 'POST', '/register', null, { name: 'Pick Co', email: 'pick@example.com', password: 'Passw0rd12345', plan: 'starter', modules: ['therapy', 'bogus'] })
  const main = (await (await call(base, 'GET', '/platform/accounts', boss)).json()).find(a => a.email === 'pick@example.com')
  await call(base, 'POST', `/users/${main.id}/activate`, boss)
  const token = await login(base, 'pick@example.com')
  assert.equal((await call(base, 'POST', '/therapy/children', token, { name: 'Sara' })).status, 200, 'therapy was on from sign-up')
})
