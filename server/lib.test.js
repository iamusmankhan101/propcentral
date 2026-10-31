import test from 'node:test'
import assert from 'node:assert/strict'
import { base32, totp, checkTotp } from './totp.js'
import { normalizePhone, pickAgent, ruleMatches, workingMinutes, slaLevel, distanceM, parseCsv, addMonths, buildSchedule, allocate, rentSchedule, daysLeft, inPolygon, areasAt, fitTransform, fitCorners } from './lib.js'

test('phone normalization', () => {
  for (const p of ['0300-1234567', '+92 300 1234567', '923001234567', '00923001234567', '3001234567'])
    assert.equal(normalizePhone(p), '923001234567')
  assert.equal(normalizePhone('123'), null)
})

test('assignment', () => {
  const c = [{ id: 1, open: 5, last_assigned_at: '2026-01-02' }, { id: 2, open: 2, last_assigned_at: '2026-01-03' }, { id: 3, open: 9, last_assigned_at: null }]
  assert.equal(pickAgent(c, 'round_robin'), 3)
  assert.equal(pickAgent(c, 'load'), 2)
  assert.equal(pickAgent([], 'load'), null)
  assert.ok(ruleMatches({ when: { source: 'Facebook', city: ['Lahore', 'Karachi'] } }, { source: 'facebook', city: 'karachi' }, 10))
  assert.ok(!ruleMatches({ when: { min_budget: 100 } }, { budget_max: 50 }, 10))
  assert.ok(!ruleMatches({ when: { hours: [9, 18] } }, {}, 20))
})

test('SLA clock pauses outside working hours', () => {
  const wh = { start: 9, end: 19, days: [1, 2, 3, 4, 5, 6], tz: 5 }
  const pkt = s => Date.parse(s + '+05:00')
  assert.equal(workingMinutes(pkt('2026-10-26T10:00:00'), pkt('2026-10-26T10:30:00'), wh), 30) // Monday
  assert.equal(workingMinutes(pkt('2026-10-26T18:50:00'), pkt('2026-10-27T09:10:00'), wh), 20) // overnight
  assert.equal(workingMinutes(pkt('2026-10-25T10:00:00'), pkt('2026-10-25T12:00:00'), wh), 0)  // Sunday
  assert.equal(slaLevel(25, 10), 2)
  assert.equal(slaLevel(99, 10), 3)
})

test('distance + csv', () => {
  assert.ok(Math.abs(distanceM(31.5204, 74.3587, 31.5294, 74.3587) - 1000) < 10)
  assert.deepEqual(parseCsv('name,phone\r\n"Ali, Khan","0300 ""1"""\n\n'), [['name', 'phone'], ['Ali, Khan', '0300 "1"']])
})

test('area conversion + unit pricing', async () => {
  const { convertArea, unitPrice, currentRate } = await import('./lib.js')
  assert.equal(convertArea(1, 'kanal', 'marla', 225), 20)
  assert.equal(convertArea(5, 'marla', 'sqft', 272.25), 1361.25)
  assert.equal(convertArea(9, 'sqft', 'sqyd', 225), 1)
  const prem = [{ name: 'Corner', type: 'pct', value: 10 }, { name: 'Park facing', type: 'fixed', value: 500000 }]
  const rate = { rate: 1000000, per: 'marla' }
  assert.deepEqual(unitPrice({ size: 5, uom: 'marla', premiums: ['Corner', 'Park facing'] }, rate, prem, 225), { base: 5000000, premium: 1000000, total: 6000000 })
  assert.equal(unitPrice({ size: 1, uom: 'kanal', premiums: [] }, rate, prem, 225).total, 20000000)
  assert.equal(unitPrice({ size: 5, uom: 'marla', premiums: [], price_override: 7 }, null, prem, 225).total, 7)
  const lists = [{ id: 1, unit_type: 'Plot', per: 'marla', effective_from: '2026-01-01', rate: 1 }, { id: 2, unit_type: 'Plot', per: 'marla', effective_from: '2026-06-01', rate: 2 },
    { id: 3, unit_type: 'Plot', per: 'marla', effective_from: '2027-01-01', rate: 3 },
    { id: 4, unit_type: 'Plot', per: 'plot', size: 5, uom: 'marla', effective_from: '2026-02-01', rate: 5000000 },
    { id: 5, unit_type: 'Plot', per: 'plot', size: 5, uom: 'marla', effective_from: '2026-09-01', rate: 5500000 }]
  const five = { unit_type: 'Plot', size: 5, uom: 'marla', premiums: [] }, ten = { unit_type: 'Plot', size: 10, uom: 'marla', premiums: [] }
  assert.equal(currentRate(lists, five, '2026-10-25').rate, 5500000)          // newest per-plot price for its size
  assert.equal(currentRate(lists, five, '2026-03-01').rate, 5000000)
  assert.equal(currentRate(lists, ten, '2026-10-25').rate, 2)                 // no 10 marla price -> per-marla rate
  assert.equal(currentRate(lists, { ...five, unit_type: 'Shop' }, '2026-10-25'), null)
  assert.equal(unitPrice({ ...five, premiums: ['Corner'] }, lists[4], prem, 225).total, 6050000) // per plot + 10% corner
  assert.equal(unitPrice({ unit_type: 'Plot', size: null, uom: 'marla', premiums: [] }, lists[4], prem, 225).total, 5500000)
})

test('plot number lists', async () => {
  const { parseNumbers, autoPrefix } = await import('./lib.js')
  assert.deepEqual(parseNumbers('1-3, 7  9-10,12A'), ['1', '2', '3', '7', '9', '10', '12A'])
  assert.deepEqual(parseNumbers('A-12'), ['A-12'])
  assert.deepEqual(parseNumbers(''), [])
  assert.throws(() => parseNumbers('5-2'), /Bad range/)
  assert.throws(() => parseNumbers('1-3, 2'), /listed twice/)
  assert.equal(autoPrefix(5, 'marla'), '5M-')
  assert.equal(autoPrefix('1', 'kanal'), '1K-')
})

test('payment plan and allocation', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28')
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15')
  const s = buildSchedule(1000, 250, 3, 1, '2026-01-31')
  assert.deepEqual(s.map(r => r.amount), [250, 250, 250, 250])
  assert.deepEqual(buildSchedule(1000, 0, 3, 6, '2026-01-01').map(r => [r.due_date, r.amount]), [['2026-07-01', 333], ['2027-01-01', 333], ['2027-07-01', 334]])
  assert.equal(buildSchedule(500, 500, 0, 1, '2026-01-01')[0].label, 'Full payment')
  const a = allocate(s, 400, '2026-03-15')
  assert.deepEqual(a.map(r => [r.paid, r.status]), [[250, 'Paid'], [150, 'Overdue'], [0, 'Due'], [0, 'Due']])
})

test('TOTP matches RFC 6238 vectors', () => {
  const secret = base32(Buffer.from('12345678901234567890'))
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.equal(totp(secret, 59e3), '287082')
  assert.equal(totp(secret, 1111111109e3), '081804')
  assert.ok(checkTotp(secret, '287 082', 59e3 + 30e3)) // one step of drift is fine
  assert.ok(!checkTotp(secret, '287082', 59e3 + 120e3))
})

test('rent schedule with yearly increase', () => {
  const lease = { start_date: '2025-01-31', end_date: '2027-01-31', rent: 100000, increase_pct: 10 }
  const all = rentSchedule(lease, '2030-01-01')
  assert.equal(all.length, 24) // two years, end date itself not billed
  assert.deepEqual([all[0].due_date, all[1].due_date, all[11].amount, all[12].amount], ['2025-01-31', '2025-02-28', 100000, 110000])
  assert.equal(rentSchedule(lease, '2025-03-15').length, 2) // Jan 31 and Feb 28 due; Mar 31 not yet
  assert.equal(rentSchedule({ ...lease, end_date: null }, '2028-01-31').at(-1).amount, 133100) // year 4: 1.1³
  const paid = allocate(rentSchedule(lease, '2025-03-31'), 150000, '2025-04-01')
  assert.deepEqual(paid.map(r => r.status), ['Paid', 'Overdue', 'Overdue'])
  assert.equal(daysLeft('2026-01-31', '2026-01-01'), 30)
})

test('areas: which society / phase / block a point is in', () => {
  const sq = (x, y, d) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d]]
  const areas = [{ name: 'DHA', kind: 'Society', outline: sq(0, 0, 10) }, { name: 'Phase 6', kind: 'Phase', outline: sq(0, 0, 5) },
    { name: 'Block K', kind: 'Block', outline: sq(1, 1, 1) }, { name: 'Big phase', kind: 'Phase', outline: sq(-5, -5, 20) }]
  assert.ok(inPolygon([0.5, 0.5], sq(0, 0, 1)) && !inPolygon([1.5, 0.5], sq(0, 0, 1)))
  assert.deepEqual(areasAt([1.5, 1.5], areas), { society: 'DHA', phase: 'Phase 6', block: 'Block K' })
  assert.deepEqual(areasAt([7, 7], areas), { society: 'DHA', phase: 'Big phase' })
  assert.deepEqual(areasAt([50, 50], areas), {})
})

test('society map alignment', () => {
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9)
  // real = shown rotated 90°, scaled ×2, moved by (10, 20)
  const real = ([x, y]) => [10 - 2 * y, 20 + 2 * x]
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]]
  const two = fitTransform(pts.slice(0, 2).map(p => [p, real(p)]))
  assert.ok(close(two([3, 4]), real([3, 4])))
  const skew = ([x, y]) => [74 + 0.01 * x + 0.003 * y, 31 + 0.0005 * x + 0.012 * y] // a scanned map: stretched + skewed
  const aff = fitTransform(pts.map(p => [p, skew(p)]))
  assert.ok(close(aff([5, -2]), skew([5, -2])))
  assert.throws(() => fitTransform([[[0, 0], [0, 0]], [[1, 1], [1, 1]], [[2, 2], [2, 2]]]), /line/)
  const c = fitCorners([[74, 31], [74.02, 31], [74.02, 31.01], [74, 31.01]], 1000, 1000)
  assert.ok(c[0][0] < c[1][0] && c[0][1] > c[3][1]) // top-left is left of top-right and above bottom-left
})
