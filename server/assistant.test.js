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
const port = 49000 + (process.pid % 2000)

// Fake Groq: answers with a scripted sequence of chat-completion responses and records every request
async function groqStub(t, script) {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      calls.push(JSON.parse(body))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(script(calls.length)))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  return { calls, url: `http://127.0.0.1:${server.address().port}` }
}
const toolCall = name => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: '{}' } }] } }] })
const final = text => ({ choices: [{ message: { role: 'assistant', content: text } }] })

async function boot(t, env = {}) {
  const dbPath = path.join(os.tmpdir(), `prop-central-asst-${port}.db`)
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
const login = async (base, email) => (await (await fetch(`${base}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }),
})).json()).token
const ask = (base, token, text) => fetch(`${base}/assistant`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
})
const toolResults = calls => calls.at(-1).messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content))

test('assistant needs a provider key and a session', async t => {
  const base = await boot(t)
  const token = await login(base, 'admin@propcentral.local')
  const noKey = await ask(base, token, 'sales this week?')
  assert.equal(noKey.status, 503, 'missing GROQ_API_KEY reports setup, not a crash')
  assert.match((await noKey.json()).error, /GROQ_API_KEY/)
  assert.equal((await ask(base, 'junk', 'hello?')).status, 401, 'anonymous cannot use the assistant')
})

test('assistant answers through a scoped tool call', async t => {
  const stub = await groqStub(t, n => (n === 1 ? toolCall('sales_summary') : final('Solid month.')))
  const base = await boot(t, { GROQ_API_KEY: 'test-key', GROQ_BASE_URL: stub.url })
  const admin = await login(base, 'admin@propcentral.local')
  const r = await ask(base, admin, 'how are sales this month?')
  assert.equal(r.status, 200)
  assert.equal((await r.json()).reply, 'Solid month.')
  assert.equal(stub.calls.length, 2, 'one tool round then the answer')
  const [summary] = toolResults(stub.calls)
  assert.equal(typeof summary.leads, 'number', 'tool returned live metrics')
  assert.ok(summary.period.from && summary.period.to, 'period is echoed back')
})

test('agents only see their own numbers in assistant tools', async t => {
  const stub = await groqStub(t, n => (n % 2 === 1 ? toolCall('sales_summary') : final('ok')))
  const base = await boot(t, { GROQ_API_KEY: 'test-key', GROQ_BASE_URL: stub.url })
  const admin = await login(base, 'admin@propcentral.local')
  const agent = await login(base, 'agent1@propcentral.local')
  const users = await (await fetch(`${base}/users`, { headers: { authorization: 'Bearer ' + admin } })).json()
  const idOf = email => users.find(x => x.email === email).id
  const addLead = async (name, agentEmail) => {
    const r = await fetch(`${base}/leads`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin },
      body: JSON.stringify({ name, phone: `0300${Math.floor(Math.random() * 1e8)}`, source: 'Facebook', agent_id: idOf(agentEmail) }),
    })
    assert.equal(r.status, 200, await r.text())
  }
  await addLead('Floor Lead A', 'agent1@propcentral.local')
  await addLead('Floor Lead B', 'agent1@propcentral.local')
  await addLead('Floor Lead C', 'agent2@propcentral.local')
  await ask(base, admin, 'totals?')
  const adminLeads = toolResults(stub.calls)[0].leads
  await ask(base, agent, 'totals?')
  const agentLeads = toolResults(stub.calls)[0].leads
  assert.ok(agentLeads >= 2, 'agent1 sees the leads assigned to them')
  assert.ok(adminLeads > agentLeads, 'admin sees strictly more than one agent')
})
