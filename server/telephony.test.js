import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeCall } from './telephony.js'
import { normalizePhone } from './lib.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const port = 59500 + (process.pid % 900)
const BOSS = { email: 'boss@tel.test', password: 'PlatformPass123' }

test('exchange field names, directions and statuses are understood', () => {
  const a = normalizeCall({ call_type: 'Inbound', src: '0300 9998877', dst: '2001', extension: ' 101 ', billsec: '125', disposition: 'ANSWERED', recordingfile: 'https://pbx.example.com/r/1.mp3', uniqueid: 'X1', calldate: '2026-11-12 10:00:00' }, normalizePhone)
  assert.equal(a.direction, 'in'); assert.equal(a.customer_phone, '923009998877'); assert.equal(a.agent_ext, '101'); assert.equal(a.duration, 125)
  assert.equal(a.answered, true); assert.equal(a.recording_url, 'https://pbx.example.com/r/1.mp3'); assert.equal(a.ext_id, 'X1')
  const o = normalizeCall({ direction: 'outbound', from: '101', to: '03211234567', status: 'NO ANSWER' }, normalizePhone)
  assert.equal(o.direction, 'out'); assert.equal(o.customer_phone, '923211234567'); assert.equal(o.answered, false)
  assert.equal(normalizeCall({ from: '03211234567', duration: 30 }, normalizePhone).answered, true, 'no status: a call with talk time was answered')
  assert.equal(normalizeCall({ from: '03211234567', recording_url: 'javascript:alert(1)' }, normalizePhone).recording_url, null, 'only http(s) recording links are kept')
  assert.equal(normalizeCall({ customer: '+92 321 1234567', direction: 'out', to: 'x' }, normalizePhone).customer_phone, '923211234567')
})

test('exchange call log: key per company, lead matching, agent mapping, duplicates and isolation', async t => {
  const dbPath = path.join(os.tmpdir(), `estate-centric-tel-${port}.db`)
  const child = spawn(process.execPath, ['server/server.js'], { cwd: root, stdio: 'ignore',
    env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '', PLATFORM_ADMIN_EMAIL: BOSS.email, PLATFORM_ADMIN_PASSWORD: BOSS.password } })
  t.after(async () => { child.kill(); await sleep(300); for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true }) })
  const base = `http://127.0.0.1:${port}/api`
  for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/health')).ok) break } catch {} await sleep(100) }
  const call = (m, p, tok, body, h = {}) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...h }, body: body && JSON.stringify(body) })
  const json = r => r.json()
  const login = async (email, password = 'password123') => (await json(await call('POST', '/login', null, { email, password }))).token
  const A = await login('admin@propcentral.local'), agent = await login('agent1@propcentral.local'), boss = await login(BOSS.email, BOSS.password)

  assert.equal((await call('GET', '/tel/config', agent)).status, 403, 'only settings admins see the key')
  const cfg = await json(await call('GET', '/tel/config', A))
  assert.ok(cfg.api_key.length >= 32 && cfg.endpoint.endsWith('/api/inbound/calls'))
  const post = (body, key = cfg.api_key) => call('POST', '/inbound/calls', null, body, { 'x-api-key': key })

  assert.equal((await post({ from: '03001234567' }, 'wrong-key-wrong-key-1234')).status, 401)
  assert.equal((await call('POST', '/inbound/calls', null, { from: '03001234567' })).status, 401)
  assert.equal((await post({ from: 'abc' })).status, 400, 'a call without a usable customer number is refused')

  // agent One has extension 101
  const users = await json(await call('GET', '/users', A)); const one = users.find(u => u.email === 'agent1@propcentral.local')
  assert.equal((await call('PATCH', `/users/${one.id}`, A, { extension: '101' })).status, 200)

  // an unknown number phones in, agent 101 answers: a new lead assigned to that agent, call on the timeline with its recording
  const r1 = await json(await post({ direction: 'in', from: '0345 1112222', to: '5000', extension: '101', duration: 125, status: 'ANSWERED', call_id: 'CALL-1', recording_url: 'https://pbx.example.com/rec/CALL-1.mp3' }))
  assert.ok(r1.lead_id && r1.matched_agent)
  const lead = await json(await call('GET', `/leads/${r1.lead_id}`, A))
  assert.equal(lead.lead.source, 'Inbound call'); assert.equal(lead.lead.agent_id, one.id)
  assert.ok(lead.activities.some(a => a.type === 'call' && /received, 2:05 \(recorded\)/.test(a.notes) && a.outcome === 'Connected'))
  const list = await json(await call('GET', `/leads/${r1.lead_id}/phone-calls`, A))
  assert.equal(list.length, 1); assert.equal(list[0].recording_url, 'https://pbx.example.com/rec/CALL-1.mp3'); assert.equal(list[0].agent_name, 'Agent One')
  // exchanges retry
  const again = await json(await post({ direction: 'in', from: '0345 1112222', extension: '101', duration: 125, status: 'ANSWERED', call_id: 'CALL-1' }))
  assert.equal(again.duplicate, true); assert.equal((await json(await call('GET', `/leads/${r1.lead_id}/phone-calls`, A))).length, 1)

  // an outbound call to a number we already have: logged on that lead, agent found by email
  const known = (await json(await call('GET', '/leads?q=Hamza', A))).rows[0]
  const r2 = await json(await post({ direction: 'out', to: '03125556677', agent_email: 'agent2@propcentral.local', duration: 40, status: 'answered', call_id: 'CALL-2' }))
  assert.equal(r2.lead_id, known.id)
  // an outbound call to a stranger is stored but creates no lead
  const r3 = await json(await post({ direction: 'out', to: '03339990000', extension: '101', duration: 0, call_id: 'CALL-3' }))
  assert.equal(r3.lead_id, null)
  // a missed inbound call from a known customer: timeline note and the owner is told
  const r4 = await json(await post({ direction: 'in', from: '0345 1112222', extension: '101', status: 'NO ANSWER', call_id: 'CALL-4' }))
  assert.equal(r4.lead_id, r1.lead_id)
  const notes = await json(await call('GET', '/notifications', agent))
  assert.ok(notes.rows.some(n => /Missed call/.test(n.text) && n.lead_id === r1.lead_id))
  const stats = (await json(await call('GET', '/tel/config', A))).stats
  assert.equal(stats.total, 4); assert.equal(stats.unmatched, 1); assert.equal(stats.recorded, 1)

  // company B has its own key and can never write into company A
  assert.equal((await call('POST', '/register', null, { name: 'Beta Homes', email: 'beta@tel.test', password: 'Passw0rd12345', plan: 'starter', modules: ['property'] })).status, 200)
  const beta = (await json(await call('GET', '/platform/accounts', boss))).find(a => a.email === 'beta@tel.test')
  await call('POST', `/users/${beta.id}/activate`, boss); await call('PATCH', `/users/${beta.id}`, boss, { role: 'admin' })
  const B = await login('beta@tel.test', 'Passw0rd12345')
  const bcfg = await json(await call('GET', '/tel/config', B))
  assert.notEqual(bcfg.api_key, cfg.api_key)
  const rb = await json(await post({ direction: 'in', from: '0345 1112222', duration: 30, call_id: 'CALL-1' }, bcfg.api_key))
  assert.ok(rb.lead_id && rb.lead_id !== r1.lead_id, "B's call on the same number and call id makes B's own lead")
  assert.equal((await json(await call('GET', `/leads/${r1.lead_id}/phone-calls`, A))).length, 2, "A's lead is untouched by B")
  assert.equal((await call('GET', `/leads/${r1.lead_id}/phone-calls`, B)).status, 404)
  assert.equal((await json(await call('GET', '/tel/config', B))).recent.length, 1, "B's list has only B's call")

  // rotating the key retires the old one
  const rot = await json(await call('POST', '/tel/config/rotate', A, {}))
  assert.notEqual(rot.api_key, cfg.api_key)
  assert.equal((await post({ from: '03001234567', call_id: 'CALL-9' })).status, 401)
  assert.equal((await post({ direction: 'in', from: '03001234567', duration: 5, call_id: 'CALL-9' }, rot.api_key)).status, 200)
})
