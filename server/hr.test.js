import test from 'node:test'
import assert from 'node:assert/strict'
import { computePay } from './hr.js'

const days = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`) // Nov 2026: 5 Sundays (1,8,15,22,29) => 25 working days
const emp = { pay_type: 'salary', base_salary: 52000, allowance: 3000 }

test('full attendance pays base plus allowance', () => {
  const p = computePay({ emp, days, att: {} })
  assert.equal(p.working_days, 25)
  assert.equal(p.net, 55000)
})
test('absent, half day and unpaid leave cut pay per working day; Sundays and paid leave do not', () => {
  const att = { '2026-11-02': 'absent', '2026-11-03': 'half_day', '2026-11-04': 'unpaid_leave', '2026-11-08': 'absent', '2026-11-05': 'paid_leave' }
  const p = computePay({ emp, days, att })
  assert.equal(p.unpaid_days, 2.5) // 11-08 is a Sunday
  assert.equal(p.absence_cut, 5200) // 52000 / 25 * 2.5
  assert.equal(p.net, 55000 - 5200)
})
test('commission-only staff get commission, no base or cut; adjustments apply', () => {
  const p = computePay({ emp: { pay_type: 'commission', base_salary: 99999, allowance: 5000 }, days, att: { '2026-11-02': 'absent' }, commission: 120000, adj: { bonus: 1000, advance: 20000, deduction: 500 } })
  assert.equal(p.base, 0)
  assert.equal(p.absence_cut, 0)
  assert.equal(p.net, 120000 + 1000 - 20000 - 500)
})
test('salary-only staff ignore CRM commission', () => {
  assert.equal(computePay({ emp, days, att: {}, commission: 50000 }).commission, 0)
})
