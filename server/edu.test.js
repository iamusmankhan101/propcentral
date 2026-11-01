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
  const catalogue = await call(base, 'GET', '/edu/universities', strangerTok)
  assert.equal(catalogue.status, 200, 'the catalogue is company-wide: two counsellors sell from the same list')
  assert.ok(Array.isArray((await catalogue.json()).rows))
})

test('the catalogue and applications: a student applies to several universities', async t => {
  const base = await boot(t)
  const outsider = await login(base, 'admin@propcentral.local', 'password123')
  assert.equal((await call(base, 'GET', '/edu/universities', outsider)).status, 403, 'a company without the module is refused the catalogue')
  const { token } = await eduCompany(base, 'Oxford Road', 'oxford@example.com')

  assert.equal((await call(base, 'POST', '/edu/universities', token, { name: 'No Country Uni' })).status, 400, 'a country is required')
  assert.equal((await call(base, 'POST', '/edu/universities', token, { name: 'X', country: 'Mars' })).status, 400, 'from the configured list')
  const uni = await (await call(base, 'POST', '/edu/universities', token, { name: 'University of Leeds', country: 'UK', city: 'Leeds', ranking: 'top 100' })).json()
  const campus = await (await call(base, 'POST', `/edu/universities/${uni.id}/campuses`, token, { name: 'Beckett Street' })).json()
  assert.equal((await call(base, 'POST', '/edu/programs', token, { university_id: uni.id, name: 'Nope', level: 'Diploma' })).status, 400, 'level comes from edu_levels')
  const prog = await (await call(base, 'POST', '/edu/programs', token, { university_id: uni.id, campus_id: campus.id, name: 'MSc Data Science',
    level: 'Master', field: 'Computing', tuition: 24000, currency: 'GBP', duration_months: 12, intakes: 'Fall 2027, Spring 2028',
    eligibility: '2:1 in any discipline', requirements: 'transcripts, IELTS', ielts_min: 6.5 })).json()

  const list = await (await call(base, 'GET', '/edu/universities', token)).json()
  assert.deepEqual(list.rows[0].programs, 1)
  assert.deepEqual(list.rows[0].campuses, 1)
  assert.deepEqual(list.countries, [{ country: 'UK', n: 1 }])
  assert.equal((await (await call(base, 'GET', `/edu/programs?level=Master&intake=Fall 2027&country=UK`, token)).json()).total, 1, 'filterable by level, intake and country')
  assert.equal((await (await call(base, 'GET', '/edu/programs?level=Bachelor', token)).json()).total, 0)
  const page = await (await call(base, 'GET', `/edu/universities/${uni.id}`, token)).json()
  assert.equal(page.university.name, 'University of Leeds')
  assert.equal(page.university.applications, 0, 'nothing applied yet')
  assert.deepEqual(page.campuses.map(c => c.programs), [1], 'the detail page carries the campuses and what sits on them')
  assert.equal(page.programs[0].campus, 'Beckett Street')
  assert.equal((await call(base, 'GET', '/edu/universities/9999', token)).status, 404)

  const student = await (await call(base, 'POST', '/edu/students', token, { name: 'Imran Shah', phone: '03009998877', target_level: 'Master' })).json()
  assert.equal((await call(base, 'POST', '/edu/applications', token, { student_id: student.id, program_id: 9999 })).status, 404, 'the course has to exist')
  const app = await call(base, 'POST', '/edu/applications', token, { student_id: student.id, program_id: prog.id })
  assert.equal(app.status, 200)
  const appId = (await app.json()).id
  const twice = await call(base, 'POST', '/edu/applications', token, { student_id: student.id, program_id: prog.id })
  assert.equal(twice.status, 409, 'one student, one course, one application')
  assert.match((await twice.json()).error, /already has an application/)

  const detail = await (await call(base, 'GET', `/edu/students/${student.id}`, token)).json()
  assert.equal(detail.applications.length, 1)
  assert.equal(detail.applications[0].university, 'University of Leeds')
  assert.ok(detail.activities.some(a => /Application opened: MSc Data Science/.test(a.notes)), 'the student timeline carries the case')

  assert.equal((await call(base, 'PATCH', `/edu/applications/${appId}`, token, { status: 'Not A Status' })).status, 400)
  await call(base, 'PATCH', `/edu/applications/${appId}`, token, { status: 'Submitted', ref: 'LED-2231' })
  await call(base, 'PATCH', `/edu/applications/${appId}`, token, { status: 'Unconditional offer', offer_type: 'unconditional' })
  const after = await (await call(base, 'GET', '/edu/applications', token)).json()
  const row = after.rows.find(a => a.id === appId)
  assert.equal(row.status, 'Unconditional offer')
  assert.ok(row.submitted_at && row.decision_at, 'the dates are stamped as the case moves')
  assert.equal(row.university, 'University of Leeds', 'the list joins the course and the university')
  assert.deepEqual(after.statuses.find(s => s.status === 'Unconditional offer'), { status: 'Unconditional offer', n: 1 })
  const counted = await (await call(base, 'GET', '/edu/students', token)).json()
  assert.deepEqual({ n: counted.rows[0].applications, offers: counted.rows[0].offers }, { n: 1, offers: 1 }, 'the students list knows about the cases')

  assert.equal((await call(base, 'DELETE', `/edu/applications/${appId}`, token, {})).status, 400, 'removing a case needs a reason')
  assert.equal((await call(base, 'DELETE', `/edu/universities/${uni.id}`, token, {})).status, 400, 'proof of an application keeps the university')
  assert.equal((await call(base, 'DELETE', `/edu/programs/${prog.id}`, token, {})).status, 400, 'and the course')

  const uni2 = await (await call(base, 'POST', '/edu/universities', token, { name: 'Deakin', country: 'Australia' })).json()
  const prog2 = await (await call(base, 'POST', '/edu/programs', token, { university_id: uni2.id, name: 'BBA', level: 'Bachelor' })).json()
  const app2 = await (await call(base, 'POST', '/edu/applications', token, { student_id: student.id, program_id: prog2.id })).json()
  const both = await (await call(base, 'GET', `/edu/students/${student.id}`, token)).json()
  assert.deepEqual(both.applications.map(a => a.program).sort(), ['BBA', 'MSc Data Science'], 'one student, several universities, separate records')
  assert.deepEqual(both.applications.map(a => a.country).sort(), ['Australia', 'UK'])
  await call(base, 'DELETE', `/edu/applications/${app2.id}`, token, { reason: 'student changed course' })
  assert.equal((await (await call(base, 'GET', `/edu/students/${student.id}`, token)).json()).applications.length, 1, 'the case is gone')
  assert.equal((await call(base, 'DELETE', `/edu/universities/${uni2.id}`, token, {})).status, 200, 'with nothing attached it is deletable')

  await call(base, 'PATCH', `/edu/programs/${prog.id}`, token, { active: false })
  assert.equal((await (await call(base, 'GET', '/edu/programs?country=UK', token)).json()).total, 0, 'a switched-off course leaves the picker')
  assert.equal((await (await call(base, 'GET', `/edu/universities/${uni.id}`, token)).json()).programs[0].active, 0, 'but the university page still shows it: the offer is proof')
  await call(base, 'PATCH', `/edu/programs/${prog.id}`, token, { active: true })

  await call(base, 'PATCH', `/edu/universities/${uni.id}`, token, { active: false })
  assert.equal((await (await call(base, 'GET', '/edu/universities', token)).json()).rows.find(u => u.id === uni.id), undefined, 'switched off, so out of the picker')
  assert.equal((await (await call(base, 'GET', '/edu/programs?country=UK', token)).json()).total, 0, 'and its courses are out of the picker too')
  assert.equal((await (await call(base, 'GET', '/edu/universities?active=0', token)).json()).rows.find(u => u.id === uni.id).name, 'University of Leeds', 'but the archive still shows it')
})

test('an application is only visible to the counsellor who holds the student', async t => {
  const base = await boot(t)
  const { token } = await eduCompany(base, 'Gate Two', 'gate@example.com')
  const uni = await (await call(base, 'POST', '/edu/universities', token, { name: 'TU Delft', country: 'Netherlands' })).json()
  const prog = await (await call(base, 'POST', '/edu/programs', token, { university_id: uni.id, name: 'MSc AI', level: 'Master' })).json()

  await call(base, 'POST', '/users', token, { name: 'Sara Khan', email: 'sara2@example.com', role: 'agent', password: 'Passw0rd12345' })
  const sara = (await (await call(base, 'GET', '/users', token)).json()).find(u => u.email === 'sara2@example.com')
  await call(base, 'POST', `/users/${sara.id}/activate`, token)
  const saraTok = await login(base, 'sara2@example.com')
  const other = await (await call(base, 'POST', '/users', token, { name: 'Nadia Aslam', email: 'nadia@example.com', role: 'agent', password: 'Passw0rd12345' })).json()
  await call(base, 'POST', `/users/${other.id}/activate`, token)
  const otherTok = await login(base, 'nadia@example.com')

  const mine = await (await call(base, 'POST', '/edu/students', saraTok, { name: 'Hira N', phone: '03011112222' })).json()
  const app = await (await call(base, 'POST', '/edu/applications', saraTok, { student_id: mine.id, program_id: prog.id })).json()
  const seen = await (await call(base, 'GET', '/edu/applications', saraTok)).json()
  assert.deepEqual(seen.rows.map(r => r.id), [app.id], 'their own cases')
  assert.equal((await (await call(base, 'GET', '/edu/applications', otherTok)).json()).total, 0, 'a colleague does not appear in your list')
  assert.equal((await call(base, 'PATCH', `/edu/applications/${app.id}`, otherTok, { status: 'Accepted' })).status, 404, 'and cannot move one')
  assert.equal((await call(base, 'GET', `/edu/students/${mine.id}`, otherTok)).status, 404)
})
