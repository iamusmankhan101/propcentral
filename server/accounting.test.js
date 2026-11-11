import test from 'node:test'
import assert from 'node:assert/strict'
import { billStatus, balanceOf } from './accounting.js'

test('bill status: paid, partial, overdue, open, void', () => {
  const b = { amount: 1000, due_date: '2026-11-10', today: '2026-11-11' }
  assert.equal(billStatus({ ...b, paid: 1000 }), 'paid')
  assert.equal(billStatus({ ...b, paid: 400 }), 'overdue') // part-paid but past due is still overdue
  assert.equal(billStatus({ ...b, paid: 400, today: '2026-11-01' }), 'partial')
  assert.equal(billStatus({ ...b, paid: 0, today: '2026-11-01' }), 'open')
  assert.equal(billStatus({ ...b, paid: 0, voided: '2026-11-02' }), 'void')
})
test('account balance: opening + income - expense, transfers move money, voided entries ignored', () => {
  const cash = { id: 1, opening_balance: 10000 }, bank = { id: 2, opening_balance: 0 }
  const entries = [
    { kind: 'income', account_id: 1, amount: 5000 }, { kind: 'expense', account_id: 1, amount: 2000 },
    { kind: 'transfer', account_id: 1, to_account_id: 2, amount: 3000 }, { kind: 'income', account_id: 1, amount: 999, voided_at: 'x' },
  ]
  assert.equal(balanceOf(cash, entries), 10000 + 5000 - 2000 - 3000)
  assert.equal(balanceOf(bank, entries), 3000)
})
