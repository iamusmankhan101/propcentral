import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = path.join(os.tmpdir(), `prop-central-auth-${process.pid}.db`)
const port = 41000 + (process.pid % 5000)
const base = `http://127.0.0.1:${port}/api`
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = body => fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const meta = token => fetch(`${base}/meta`, { headers: { authorization: 'Bearer ' + token } })

test('each login gets its own random session id', async t => {
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '' },
    stdio: 'ignore',
  })
  t.after(async () => {
    child.kill()
    await sleep(300)
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true })
  })

  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break } catch {}
    await sleep(100)
  }

  const users = ['admin@propcentral.local', 'agent1@propcentral.local', 'agent2@propcentral.local']
  const tokens = []
  for (const email of users) for (let i = 0; i < 2; i++) {
    const r = await login({ email, password: 'password123' })
    assert.equal(r.status, 200)
    tokens.push((await r.json()).token)
  }

  for (const token of tokens) assert.match(token, /^[a-f0-9]{64}$/, 'session id is a 256-bit hex token')
  assert.equal(new Set(tokens).size, tokens.length, 'no two logins share a session id')

  for (const token of tokens.slice(0, 2)) {
    const r = await meta(token)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).me.email, users[0], 'each session resolves to its own user')
  }

  const out = await fetch(`${base}/logout`, { method: 'POST', headers: { authorization: 'Bearer ' + tokens[0], 'content-type': 'application/json' }, body: '{}' })
  assert.equal(out.status, 200)
  assert.equal((await meta(tokens[0])).status, 401, 'signed-out session stops working')
  assert.equal((await meta(tokens[1])).status, 200, 'the user’s other session is unaffected')
})
