import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Two companies on one deployment must never see or change each other's records.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const port = 56500 + (process.pid % 1000)
const BOSS = { email: 'boss@tenancy.test', password: 'PlatformPass123' }

test('company B cannot read or change company A (leads, sales, money, dealers, listings) and assignment stays inside a company', async t => {
  const dbPath = path.join(os.tmpdir(), `estate-centric-tenancy-${port}.db`)
  const child = spawn(process.execPath, ['server/server.js'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '', PLATFORM_ADMIN_EMAIL: BOSS.email, PLATFORM_ADMIN_PASSWORD: BOSS.password } })
  t.after(async () => { child.kill(); await sleep(300); for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true }) })
  const base = `http://127.0.0.1:${port}/api`
  for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/health')).ok) break } catch {} await sleep(100) }
  const call = (m, p, tok, body) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body && JSON.stringify(body) })
  const json = async r => r.json()
  const login = async (email, password = 'password123') => (await json(await call('POST', '/login', null, { email, password }))).token
  const A = await login('admin@propcentral.local'), boss = await login(BOSS.email, BOSS.password)

  // company B signs up, the platform owner activates it
  assert.equal((await call('POST', '/register', null, { name: 'Beta Homes', email: 'beta@example.com', password: 'Passw0rd12345', plan: 'starter', modules: ['property'] })).status, 200)
  const beta = (await json(await call('GET', '/platform/accounts', boss))).find(a => a.email === 'beta@example.com')
  await call('POST', `/users/${beta.id}/activate`, boss)
  await call('PATCH', `/users/${beta.id}`, boss, { role: 'admin' })
  const B = await login('beta@example.com', 'Passw0rd12345')

  // company A has its seeded leads; B starts empty and sees none of them
  const aLeads = await json(await call('GET', '/leads', A)); assert.ok(aLeads.total >= 5)
  assert.equal((await json(await call('GET', '/leads', B))).total, 0, "B sees none of A's leads")
  assert.equal((await call('GET', `/leads/${aLeads.rows[0].id}`, B)).status, 404)
  assert.equal((await call('POST', `/leads/${aLeads.rows[0].id}/activities`, B, { type: 'note', notes: 'x', next_action_at: '2099-01-01T10:00' })).status, 404)
  assert.equal((await json(await call('GET', '/dashboard', B))).kpi.leads, 0)
  assert.deepEqual((await json(await call('GET', '/meta', B))).branches, [], "A's branches are not B's")
  assert.ok((await json(await call('GET', '/meta', A))).branches.length >= 1)

  // a lead B captures is assigned inside B only (never to A's agents) and A cannot see it
  const bl = await json(await call('POST', '/leads', B, { name: 'Beta Buyer', phone: '03005550001', source: 'Walk-in', lead_type: 'buyer' }))
  const got = await json(await call('GET', `/leads/${bl.lead_id}`, B))
  assert.ok(got.lead.agent_id == null, "B's lead is not handed to A's agents: " + JSON.stringify([got.lead.agent_id, got.lead.agent_name, got.lead.company_id]))
  assert.equal((await call('GET', `/leads/${bl.lead_id}`, A)).status, 404, "A cannot see B's lead")
  // the same phone captured by A stays a separate lead (no cross-company duplicate merge)
  const al = await json(await call('POST', '/leads', A, { name: 'Alpha Buyer', phone: '03005550001', source: 'Walk-in', lead_type: 'buyer' }))
  assert.notEqual(al.lead_id, bl.lead_id)
  assert.equal(al.duplicate, false)

  // A sells a plot and takes a payment; B cannot see or touch any of it
  const project = (await json(await call('GET', '/projects', A)))[0]
  const detail = await json(await call('GET', `/projects/${project.id}`, A))
  const unit = detail.units.find(u => u.status === 'Available')
  const sale = await call('POST', `/units/${unit.id}/allot`, A, { status: 'Sold', expected: 'Available', sale_date: '2026-11-01', lead_id: aLeads.rows[0].id, price: 5000000, plan: { down: 1000000, count: 4, every: 1, start: '2026-11-01' } })
  assert.equal(sale.status, 200)
  const allotment = (await json(sale)).id
  const pay = await json(await call('POST', `/allotments/${allotment}/payments`, A, { kind: 'payment', amount: 1000000, method: 'Cash', paid_on: '2026-11-02' }))
  for (const p of [`/allotments/${allotment}`, `/allotments/${allotment}/ledger`, `/allotments/${allotment}/form`, `/payments/${pay.id}`])
    assert.equal((await call('GET', p, B)).status, 404, 'B cannot read ' + p)
  assert.equal((await call('POST', `/allotments/${allotment}/payments`, B, { kind: 'payment', amount: 1, method: 'Cash', paid_on: '2026-11-02' })).status, 404)
  assert.equal((await call('POST', `/payments/${pay.id}/void`, B, { note: 'x' })).status, 404)
  assert.equal((await call('POST', `/allotments/${allotment}/cancel`, B, { note: 'x' })).status, 404)
  assert.deepEqual(await json(await call('GET', '/collections', B)), [])
  assert.deepEqual(await json(await call('GET', '/commissions', B)), [])
  assert.ok((await json(await call('GET', '/commissions', A))).length >= 1)

  // B cannot book a plot to one of A's leads even in a project of its own
  const bp = await json(await call('POST', '/projects', B, { name: 'Beta Heights', city: 'Lahore', kind: 'land' }))
  await call('POST', `/projects/${bp.id}/units`, B, { units: [{ unit_no: '1', unit_type: 'Plot', category: 'residential', size: 5, uom: 'marla' }] })
  const bu = (await json(await call('GET', `/projects/${bp.id}`, B))).units[0]
  assert.equal((await call('POST', `/units/${bu.id}/allot`, B, { status: 'Sold', expected: 'Available', sale_date: '2026-11-01', lead_id: aLeads.rows[0].id, price: 1000000 })).status, 404, "A's lead is not bookable by B")

  // dealers and listings
  const dealer = await json(await call('POST', '/dealers', A, { name: 'Alpha Dealer', rate: 2 }))
  assert.deepEqual(await json(await call('GET', '/dealers', B)), [])
  assert.equal((await call('PATCH', `/dealers/${dealer.id}`, B, { rate: 9 })).status, 404)
  const listing = await json(await call('POST', '/listings', A, { purpose: 'Sale', property_type: 'House', price: 9000000, city: 'Lahore' }))
  assert.deepEqual(await json(await call('GET', '/listings', B)), [])
  assert.equal((await call('GET', `/listings/${listing.id}`, B)).status, 404)
  assert.equal((await call('PATCH', `/listings/${listing.id}`, B, { status: 'Sold' })).status, 404)
  // the audit log and the deployment-wide integration keys are not shared either
  const bAudit = await json(await call('GET', '/audit', B))
  assert.ok(bAudit.every(x => x.user_name === null || ['Beta Homes'].includes(x.user_name)), "B's audit log holds only B's people")
  assert.ok((await json(await call('GET', '/audit', A))).some(x => x.user_name === 'Admin'))
  assert.equal((await call('GET', '/integrations/inbound', B)).status, 403, "B cannot read A's website-form key")
  assert.equal((await call('GET', '/facebook', B)).status, 403)
  assert.equal((await call('GET', '/integrations/inbound', A)).status, 200)
  // the weekly report only counts the viewer's own company
  const report = await (await call('GET', '/reports/weekly', B)).text()
  assert.match(report, /New leads<\/td><td[^>]*>1</, "B's report counts only B's one lead")
})
