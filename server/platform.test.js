import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const port = 54000 + (process.pid % 2000)
const PLATFORM = { email: 'boss@example.com', password: 'PlatformPass123' }

async function boot(t) {
  const dbPath = path.join(os.tmpdir(), `prop-central-platform-${port}.db`)
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '', TRIAL_DAYS: '7',
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
const login = (base, email, password) => fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then(r => r.json()).then(d => d.token)

test('platform panel: guarded, hierarchy, payment request approval, backup', async t => {
  const base = await boot(t)
  const admin = await login(base, 'admin@propcentral.local', 'password123')
  const boss = await login(base, PLATFORM.email, PLATFORM.password)

  for (const [m, p] of [['GET', '/platform/accounts'], ['GET', '/platform/dashboard'], ['GET', '/platform/payment-requests'], ['GET', '/platform/settings'], ['GET', '/platform/backup'], ['POST', '/platform/payment-requests/1/approve']])
    assert.equal((await call(base, m, p, admin)).status, 403, `${m} ${p}`)

  // a sign-up is a main account; the admin it gets is the owner of whoever it adds
  const reg = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Zed Co', email: 'zed@example.com', password: 'Passw0rd12345', plan: 'starter' }) })
  assert.equal(reg.status, 200)
  const accounts = async () => (await call(base, 'GET', '/platform/accounts', boss)).json()
  const zed = (await accounts()).find(a => a.email === 'zed@example.com')
  assert.equal(zed.owner_id, null)
  await call(base, 'POST', `/users/${zed.id}/activate`, boss)
  await call(base, 'PATCH', `/users/${zed.id}`, boss, { role: 'admin' })
  const zedTok = await login(base, 'zed@example.com', 'Passw0rd12345')
  const sub = await call(base, 'POST', '/users', zedTok, { name: 'Sub One', email: 'sub@example.com', role: 'agent', password: 'Passw0rd12345' })
  assert.equal(sub.status, 200)
  const nested = (await accounts()).find(a => a.id === zed.id)
  assert.deepEqual(nested.subs.map(s => s.email), ['sub@example.com'])
  assert.equal((await call(base, 'GET', '/platform/dashboard', boss).then(r => r.json())).sub_users, 1)

  // payment request -> approve marks paid and sets the plan
  assert.equal((await call(base, 'PUT', '/platform/settings', boss, { payment_methods: [{ label: 'Bank', details: 'IBAN 123' }] })).status, 200)
  assert.deepEqual(await (await call(base, 'GET', '/payment-methods', zedTok)).json(), [{ label: 'Bank', details: 'IBAN 123' }])
  const pr = await call(base, 'POST', '/payment-requests', zedTok, { plan: 'growth', method: 'Bank', reference: 'TX42' })
  assert.equal(pr.status, 200)
  const list = await (await call(base, 'GET', '/platform/payment-requests', boss)).json()
  assert.equal(list[0].status, 'pending')
  assert.equal(list[0].amount, 12499)
  assert.equal((await call(base, 'POST', `/platform/payment-requests/${list[0].id}/approve`, boss)).status, 200)
  assert.equal((await call(base, 'POST', `/platform/payment-requests/${list[0].id}/reject`, boss)).status, 400, 'already decided')
  const paid = (await accounts()).find(a => a.id === zed.id)
  assert.ok(paid.paid_at && paid.plan === 'growth' && !paid.trial_ends_at)
  const dash = await (await call(base, 'GET', '/platform/dashboard', boss)).json()
  assert.equal(dash.paid, 1)
  assert.equal(dash.monthly_revenue, 12499)

  const bk = await call(base, 'GET', '/platform/backup', boss)
  assert.equal(bk.status, 200)
  assert.ok((await bk.arrayBuffer()).byteLength > 1000)
})

test('the platform switches product modules on for one company at a time', async t => {
  const base = await boot(t)
  const boss = await login(base, PLATFORM.email, PLATFORM.password)
  const otherAdmin = await login(base, 'admin@propcentral.local', 'password123')

  const reg = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Skyline Docs', email: 'skyline@example.com', password: 'Passw0rd12345', plan: 'starter' }) })
  assert.equal(reg.status, 200)
  const accounts = async () => (await call(base, 'GET', '/platform/accounts', boss)).json()
  const co = (await accounts()).find(a => a.email === 'skyline@example.com')
  await call(base, 'POST', `/users/${co.id}/activate`, boss)
  await call(base, 'PATCH', `/users/${co.id}`, boss, { role: 'admin' })
  const coTok = await login(base, 'skyline@example.com', 'Passw0rd12345')

  const modules = async tok => (await (await call(base, 'GET', '/meta', tok)).json()).me.modules
  assert.deepEqual(await modules(coTok), ['property'], 'a new company gets the base CRM only')

  assert.equal((await call(base, 'POST', `/platform/accounts/${co.id}/modules`, otherAdmin, { modules: ['edu'] })).status, 403, 'a company admin cannot switch on its own module')
  assert.equal((await call(base, 'POST', `/platform/accounts/${co.id}/modules`, boss, { modules: 'edu' })).status, 400, 'not a list')
  assert.equal((await call(base, 'POST', `/platform/accounts/${co.id}/modules`, boss, { modules: ['eduction'] })).status, 400, 'unknown module')

  assert.equal((await call(base, 'POST', `/platform/accounts/${co.id}/modules`, boss, { modules: ['edu'] })).status, 200)
  assert.deepEqual(await modules(coTok), ['property', 'edu'], 'the base CRM stays on whatever the client sends')

  const sub = await call(base, 'POST', '/users', coTok, { name: 'Counselor', email: 'counselor@example.com', role: 'agent', password: 'Passw0rd12345' })
  assert.equal(sub.status, 200)
  const subId = (await sub.json()).id
  await call(base, 'POST', `/users/${subId}/activate`, coTok)
  const subTok = await login(base, 'counselor@example.com', 'Passw0rd12345')
  assert.deepEqual(await modules(subTok), ['property', 'edu'], 'a user added under the company inherits it')

  assert.equal((await call(base, 'POST', `/platform/accounts/${subId}/modules`, boss, { modules: ['edu'] })).status, 400, 'a sub-account has no switch of its own')

  assert.equal((await call(base, 'POST', `/platform/accounts/${co.id}/modules`, boss, { modules: [] })).status, 200)
  assert.deepEqual(await modules(subTok), ['property'], 'switching off takes it from the whole company at once')
  assert.deepEqual(await modules(otherAdmin), ['property'], 'and only that company')

  // inside a company that has the module, the permission matrix decides who sees it
  const { permissions } = await (await call(base, 'GET', '/roles', otherAdmin)).json()
  assert.ok(permissions.edu.includes('agent') && permissions.edu.includes('admin'), 'counselors and admins get the Edu nav')
  assert.ok(!permissions.edu.includes('inventory') && !permissions.edu.includes('platform'), 'and the roles that counsel nobody do not')
})

test('a workspace backup carries one company and restoring it leaves the others alone', async t => {
  const base = await boot(t)
  const boss = await login(base, PLATFORM.email, PLATFORM.password)
  const otherAdmin = await login(base, 'admin@propcentral.local', 'password123')

  // a workspace is a main account plus the people it added; a lead belongs to whoever entered it
  const company = async (name, email, agentEmail) => {
    await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, email, password: 'Passw0rd12345', plan: 'starter' }) })
    const co = (await (await call(base, 'GET', '/platform/accounts', boss)).json()).find(a => a.email === email)
    await call(base, 'POST', `/users/${co.id}/activate`, boss)
    await call(base, 'PATCH', `/users/${co.id}`, boss, { role: 'admin' })
    const adminTok = await login(base, email, 'Passw0rd12345')
    const agent = await call(base, 'POST', '/users', adminTok, { name: 'Counselor', email: agentEmail, role: 'agent', password: 'Passw0rd12345' })
    const agentId = (await agent.json()).id
    await call(base, 'POST', `/users/${agentId}/activate`, adminTok)
    return { id: co.id, agentId, adminTok, agentTok: await login(base, agentEmail, 'Passw0rd12345') }
  }
  const A = await company('Alpha Realty', 'alpha@example.com', 'ali@alpha.test')
  const B = await company('Beta Homes', 'beta@example.com', 'sam@beta.test')

  const lead = async (tok, name, phone) => (await call(base, 'POST', '/leads', tok, { name, phone, source: 'Walk-in', lead_type: 'buyer' })).json()
  const a1 = await lead(A.agentTok, 'Ali Trivedi', '03001112233')
  await lead(B.agentTok, 'Beta Buyer', '03004445566')
  // closing A's lead frees the same phone for B: one contacts row, two companies pointing at it
  assert.equal((await call(base, 'POST', `/leads/${a1.lead_id}/status`, A.adminTok, { status: 'Lost', reason: 'Not interested', note: 'went elsewhere' })).status, 200)
  const b2 = await lead(B.agentTok, 'Ali Trivedi', '03001112233')
  const listing = await (await call(base, 'POST', '/listings', A.agentTok, { purpose: 'Sale', property_type: 'Plot', price: 5000000, city: 'Lahore' })).json()
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  assert.equal((await call(base, 'POST', '/media', A.agentTok, { entity: 'listing', entity_id: listing.id, kind: 'photo', name: 'front.png', data: 'data:image/png;base64,' + png })).status, 200)

  const bk = await call(base, 'GET', `/platform/accounts/${A.id}/backup`, boss)
  assert.equal(bk.status, 200)
  assert.match(bk.headers.get('content-disposition') || '', /^attachment; filename="workspace-/)
  const file = await bk.json()
  assert.equal(file.kind, 'estate-centric-workspace')
  assert.equal(file.account.email, 'alpha@example.com')
  assert.deepEqual(file.data.users.map(u => u.email).sort(), ['ali@alpha.test', 'alpha@example.com'])
  for (const [table, n] of [['users', 2], ['contacts', 1], ['leads', 1], ['listings', 1], ['media', 1], ['properties', 0], ['allotments', 0], ['edu_students', 0]])
    assert.equal(file.counts[table], n, table)
  const wire = JSON.stringify(file)
  assert.ok(!wire.includes('beta@example.com') && !wire.includes('Beta Buyer'), "company B is not in company A's file")
  assert.equal(file.data.media[0].data_b64, true, 'BLOBs travel as base64')

  assert.equal((await call(base, 'GET', `/platform/accounts/${A.id}/backup`, otherAdmin)).status, 403, 'a company admin has no backup rights')
  assert.equal((await call(base, 'GET', `/platform/accounts/${A.agentId}/backup`, boss)).status, 404, 'a sub-account is not a workspace')

  const fileB = await (await call(base, 'GET', `/platform/accounts/${B.id}/backup`, boss)).json()
  const restore = (id, bundle, confirm) => call(base, 'POST', `/platform/accounts/${id}/restore`, boss, { bundle, confirm })
  assert.equal((await restore(A.id, file)).status, 400, 'nothing restores without the email typed back')
  assert.equal((await restore(A.id, fileB, 'alpha@example.com')).status, 400, 'B file into A')
  assert.equal((await restore(A.id, file, 'beta@example.com')).status, 400, 'the file and the confirmation must agree')
  assert.equal((await restore(A.id, { ...file, data: { ...file.data, tax_returns: [] } }, 'alpha@example.com')).status, 400, 'a table this build cannot restore')

  await lead(A.agentTok, 'Late Entry', '03007778899')
  assert.equal((await (await call(base, 'GET', '/leads?q=Late', A.agentTok)).json()).total, 1)

  const rs = await restore(A.id, file, 'alpha@example.com')
  assert.equal(rs.status, 200)
  const out = await rs.json()
  assert.equal(out.restored.leads, 1)
  assert.equal(out.restored.contacts, 0, 'the contact company B still points at is left in place')

  assert.equal((await call(base, 'GET', '/leads', A.agentTok)).status, 401, 'a restore signs that workspace out')
  const agentTok = await login(base, 'ali@alpha.test', 'Passw0rd12345')
  assert.equal((await (await call(base, 'GET', '/leads?q=Late', agentTok)).json()).total, 0, 'the lead added after the backup is gone')
  assert.equal((await (await call(base, 'GET', '/leads', agentTok)).json()).total, 1)
  const [kept] = await (await call(base, 'GET', `/media?entity=listing&entity_id=${listing.id}`, agentTok)).json()
  const bytes = await call(base, 'GET', `/files/${kept.token}`, agentTok).then(r => r.arrayBuffer())
  assert.equal(Buffer.from(bytes).toString('base64'), png, 'the photo comes back byte for byte')

  assert.equal((await (await call(base, 'GET', '/leads', B.agentTok)).json()).total, 2, "company B's leads are untouched")
  const shared = await (await call(base, 'GET', `/leads/${b2.lead_id}`, B.agentTok)).json()
  assert.equal(shared.lead.name, 'Ali Trivedi', 'and the shared contact row still stands')
})
