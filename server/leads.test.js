import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'
import { parseCsv } from './lib.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const port = 55000 + (process.pid % 2000)

async function boot(t) {
  const dbPath = path.join(os.tmpdir(), `estate-centric-leads-${port}.db`)
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let startupError = ''
  let startupOutput = ''
  let exitStatus = null
  child.stdout.on('data', chunk => { startupOutput += chunk })
  child.stderr.on('data', chunk => { startupError += chunk })
  child.on('exit', (code, signal) => { exitStatus = `${code ?? 'null'}/${signal ?? 'null'}` })
  t.after(async () => {
    child.kill()
    await sleep(300)
    for (const file of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(file, { force: true })
  })
  const base = `http://localhost:${port}/api`
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return base } catch {}
    await sleep(100)
  }
  throw new Error(`server did not start (exit ${exitStatus || 'running'})${startupOutput ? ` stdout: ${startupOutput}` : ''}${startupError ? ` stderr: ${startupError}` : ''}`)
}

const post = (base, route, body, token) => fetch(base + route, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify(body),
})
const login = (base, email) => post(base, '/login', { email, password: 'password123' }).then(r => r.json()).then(d => d.token)

test('lead CSV and XLSX exports are valid import files', async t => {
  const base = await boot(t)
  const token = await login(base, 'admin@propcentral.local')
  assert.ok(token)

  const created = await post(base, '/leads', { name: 'Round Trip Lead', phone: '03001234567', source: 'Website' }, token)
  assert.equal(created.status, 200)

  const csv = await fetch(base + '/leads/export', { headers: { authorization: 'Bearer ' + token } })
  assert.equal(csv.status, 200)
  assert.match(csv.headers.get('content-type') || '', /text\/csv/)
  const csvRows = parseCsv(await csv.text())
  assert.equal(csvRows[0][0], 'id', 'CSV starts with headers so it can be imported again')
  assert.ok(csvRows.some(row => row.includes('Round Trip Lead')))

  const dryRun = await post(base, '/leads/import', {
    rows: [{ name: 'Round Trip Lead', phone: '03001234567', source: 'Website' }],
    commit: false,
  }, token)
  assert.equal(dryRun.status, 200)
  assert.equal((await dryRun.json()).report[0].status, 'duplicate')

  const xlsx = await fetch(base + '/leads/export.xlsx', { headers: { authorization: 'Bearer ' + token } })
  assert.equal(xlsx.status, 200)
  assert.match(xlsx.headers.get('content-type') || '', /spreadsheetml/)
  const workbook = XLSX.read(Buffer.from(await xlsx.arrayBuffer()))
  const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' })
  assert.equal(sheetRows[0][0], 'id')
  assert.ok(sheetRows.some(row => row.includes('Round Trip Lead')))
})
