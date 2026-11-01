import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const port = 55000 + (process.pid % 2000)
const PLATFORM = { email: 'boss@example.com', password: 'PlatformPass123' }
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

async function boot(t) {
  const dbPath = path.join(os.tmpdir(), `prop-central-edu-${port}.db`)
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '',
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

// a company with the Student Consultancy switched on, plus its admin token
async function eduCompany(base, name, email) {
  const boss = await login(base, PLATFORM.email, PLATFORM.password)
  await call(base, 'POST', '/register', null, { name, email, password: 'Passw0rd12345', plan: 'starter' })
  const main = (await (await call(base, 'GET', '/platform/accounts', boss)).json()).find(a => a.email === email)
  await call(base, 'POST', `/users/${main.id}/activate`, boss)
  await call(base, 'PATCH', `/users/${main.id}`, boss, { role: 'admin' })
  assert.equal((await call(base, 'POST', `/platform/accounts/${main.id}/modules`, boss, { modules: ['edu'] })).status, 200)
  return { boss, main, token: await login(base, email) }
}

test('edu students: gated, created, moved through the pipeline and documented', async t => {
  const base = await boot(t)
  const outsider = await login(base, 'admin@propcentral.local', 'password123')
  assert.equal((await call(base, 'GET', '/edu/students', outsider)).status, 403, 'a company without the module is refused')

  const { token } = await eduCompany(base, 'Skyline Docs', 'skyline@example.com')
  const created = await call(base, 'POST', '/edu/students', token, { name: 'Ayesha Riaz', phone: '03001234567', email: 'ayesha@example.com',
    current_level: 'Intermediate', graduate_year: 2025, ielts: 6.5, target_level: 'Bachelor', target_countries: 'UK, Canada', intake: 'Fall 2027' })
  assert.equal(created.status, 200)
  const id = (await created.json()).id

  const list = await (await call(base, 'GET', '/edu/students', token)).json()
  assert.equal(list.total, 1)
  const blank = await call(base, 'POST', '/edu/students', token, { name: 'Ali Berg', phone: '03007654321', counselor_id: '', branch_id: '' })
  assert.equal(blank.status, 200, 'an empty counsellor select means the creator, not a crash')
  const blankBody = await blank.json()
  assert.equal((await (await call(base, 'GET', `/edu/students/${blankBody.id}`, token)).json()).student.counselor_name, 'Skyline Docs')
  assert.equal(list.rows[0].stage, 'New Inquiry')
  assert.equal(list.rows[0].ielts, 6.5)
  assert.deepEqual(list.stages.find(s => s.stage === 'New Inquiry'), { stage: 'New Inquiry', n: 1 })

  assert.equal((await call(base, 'PATCH', `/edu/students/${id}`, token, { stage: 'Not A Stage' })).status, 400, 'the pipeline is the configured list')
  assert.equal((await call(base, 'PATCH', `/edu/students/${id}`, token, { stage: 'Documents Collection' })).status, 200)
  let detail = await (await call(base, 'GET', `/edu/students/${id}`, token)).json()
  assert.equal(detail.student.stage, 'Documents Collection')
  assert.ok(detail.student.stage_at, 'the move is timestamped')
  assert.ok(detail.activities.some(a => a.type === 'system' && /New Inquiry → Documents Collection/.test(a.notes)), 'the journey reads as one story')

  assert.equal((await call(base, 'PATCH', `/edu/students/${id}`, token, { email: 'ayesha.r@example.com', remarks: 'Scholarship shortlist needed.' })).status, 200)
  detail = await (await call(base, 'GET', `/edu/students/${id}`, token)).json()
  assert.equal(detail.student.email, 'ayesha.r@example.com', 'the profile edits the person, not just the journey')
  assert.equal(detail.student.remarks, 'Scholarship shortlist needed.')

  assert.equal((await call(base, 'POST', `/edu/students/${id}/activity`, token, { type: 'nope', notes: 'x' })).status, 400)
  assert.equal((await call(base, 'POST', `/edu/students/${id}/activity`, token, { type: 'call', notes: 'Spoke to her father', next_action_at: '2026-12-01T10:00' })).status, 200)

  assert.equal((await call(base, 'POST', `/edu/students/${id}/documents`, token, { type: 'bogus', data: PNG })).status, 400, 'unknown document category')
  assert.equal((await call(base, 'POST', `/edu/students/${id}/documents`, token, { type: 'passport', data: 'not-a-file' })).status, 400)
  const doc = await call(base, 'POST', `/edu/students/${id}/documents`, token, { type: 'passport', name: 'passport.jpg', data: PNG })
  assert.equal(doc.status, 200)
  const docId = (await doc.json()).id

  const file = await call(base, 'GET', `/edu/documents/${docId}/file`, token)
  assert.equal(file.status, 200)
  assert.equal(file.headers.get('content-type'), 'image/png')
  assert.equal((await file.arrayBuffer()).byteLength, Buffer.from(PNG.split(',')[1], 'base64').byteLength, 'the bytes round-trip')

  assert.equal((await call(base, 'PATCH', `/edu/documents/${docId}`, token, { verified: true })).status, 200)
  detail = await (await call(base, 'GET', `/edu/students/${id}`, token)).json()
  assert.equal(detail.documents[0].verified, 1)
  assert.equal((await call(base, 'DELETE', `/edu/documents/${docId}`, token, {})).status, 400, 'removing paper needs a reason')
  assert.equal((await call(base, 'DELETE', `/edu/documents/${docId}`, token, { reason: 'wrong scan' })).status, 200)
})

test('a lead promotes to a student once, keeping the link and both timelines', async t => {
  const base = await boot(t)
  const { token } = await eduCompany(base, 'Bridge Consultancy', 'bridge@example.com')

  const lead = await call(base, 'POST', '/leads', token, { name: 'Bilal Ahmed', phone: '03219998877', source: 'Website', lead_type: 'buyer', remarks: 'wants a plot' })
  assert.equal(lead.status, 200)
  const leadId = (await lead.json()).lead_id

  const first = await call(base, 'POST', `/edu/leads/${leadId}/promote`, token, {})
  assert.equal(first.status, 200)
  const sid = (await first.json()).id
  const again = await call(base, 'POST', `/edu/leads/${leadId}/promote`, token, {})
  const twice = await again.json()
  assert.equal(twice.existed, true, 'one contact is one student')
  assert.equal(twice.id, sid)

  const detail = await (await call(base, 'GET', `/edu/students/${sid}`, token)).json()
  assert.equal(detail.student.lead_id, leadId)
  assert.equal(detail.lead.id, leadId, 'the property lead is still there and reachable')
  assert.ok(detail.activities.some(a => /Promoted from lead/.test(a.notes)))
  const leadDetail = await (await call(base, 'GET', `/leads/${leadId}`, token)).json()
  assert.ok(leadDetail.activities.some(a => /Promoted to student/.test(a.notes)), 'the lead page shows the promotion too')
  assert.deepEqual(leadDetail.student, { id: sid, stage: 'New Inquiry' }, 'and says the contact is already a student, so the button is a link')
})

test('counsellors see their own students, their lead sees the team', async t => {
  const base = await boot(t)
  const { token } = await eduCompany(base, 'North Gate', 'north@example.com')

  await call(base, 'POST', '/users', token, { name: 'Sara Khan', email: 'sara@example.com', role: 'agent', password: 'Passw0rd12345' })
  const users = await (await call(base, 'GET', '/users', token)).json()
  const sara = users.find(u => u.email === 'sara@example.com')
  await call(base, 'POST', `/users/${sara.id}/activate`, token)
  const saraTok = await login(base, 'sara@example.com')

  const mine = await (await call(base, 'POST', '/edu/students', saraTok, { name: 'My Student', phone: '03000000001' })).json()
  await call(base, 'POST', '/edu/students', token, { name: 'Admins Student', phone: '03000000002', counselor_id: null })
  await call(base, 'POST', '/edu/students', token, { name: 'Assigned To Sara', phone: '03000000003', counselor_id: sara.id })

  const seen = await (await call(base, 'GET', '/edu/students?size=50', saraTok)).json()
  assert.deepEqual(seen.rows.map(r => r.name).sort(), ['Assigned To Sara', 'My Student'], 'an agent only gets their own book')
  assert.ok(seen.rows.some(r => r.id === mine.id))
  const all = await (await call(base, 'GET', '/edu/students?size=50', token)).json()
  assert.equal(all.total, 3, 'the admin sees the company')
  const stranger = await (await call(base, 'POST', '/users', token, { name: 'Other', email: 'other@example.com', role: 'agent', password: 'Passw0rd12345' })).json()
  await call(base, 'POST', `/users/${stranger.id}/activate`, token)
  const strangerTok = await login(base, 'other@example.com')
  assert.equal((await call(base, 'GET', `/edu/students/${mine.id}`, strangerTok)).status, 404, "another counsellor's student is not there, not merely hidden")
})
