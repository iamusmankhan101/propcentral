// Accounting module (add-on `accounting`, permission `accounting`). Cash/bank accounts, a ledger of income, expense and transfer
// entries, vendor bills with payments, and reports. Every row carries company_id = the company's main account.
// CRM money (sale receipts, rent, paid commissions, paid payroll) is pulled in by an explicit, idempotent sync, so the books
// are the single ledger and nothing is counted twice.

export const ACC_SCHEMA = `
CREATE TABLE IF NOT EXISTS acc_accounts(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'cash',
  opening_balance INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS acc_vendors(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS acc_bills(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, vendor_id INTEGER NOT NULL, bill_no TEXT, date TEXT NOT NULL, due_date TEXT,
  category TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT, voided_at TEXT, created_by INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS acc_entries(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, kind TEXT NOT NULL, date TEXT NOT NULL, account_id INTEGER NOT NULL,
  to_account_id INTEGER, category TEXT, amount INTEGER NOT NULL, party TEXT, ref TEXT, note TEXT, bill_id INTEGER, source TEXT NOT NULL DEFAULT 'manual', source_id INTEGER,
  voided_at TEXT, created_by INTEGER, created_at TEXT);
CREATE INDEX IF NOT EXISTS acc_entries_company ON acc_entries(company_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS acc_entries_source ON acc_entries(company_id, source, source_id) WHERE source_id IS NOT NULL;
`

export const INCOME_CATS = ['Sales receipts', 'Rent income', 'Transfer fees', 'Commission income', 'Security deposits', 'Other income']
export const EXPENSE_CATS = ['Salaries', 'Commissions', 'Rent', 'Utilities', 'Marketing & ads', 'Office & supplies', 'Travel', 'Maintenance', 'Legal & fees', 'Taxes', 'Refunds', 'Other expense']
const KINDS = ['income', 'expense', 'transfer']
const ACC_KINDS = ['cash', 'bank']
const METHOD_KIND = m => (/cash/i.test(m || '') ? 'cash' : 'bank')

const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '')

// paid / partial / overdue / open, from what a bill is worth and what has been paid against it. Pure, so it can be checked alone.
export function billStatus({ amount, paid, due_date, today, voided }) {
  if (voided) return 'void'
  if (paid >= amount) return 'paid'
  if (due_date && due_date < today) return 'overdue'
  return paid > 0 ? 'partial' : 'open'
}

// opening balance plus everything that moved through an account. Transfers leave one account and arrive in another.
export function balanceOf(account, entries) {
  return entries.reduce((b, e) => {
    if (e.voided_at) return b
    if (e.kind === 'income' && e.account_id === account.id) return b + e.amount
    if (e.kind === 'expense' && e.account_id === account.id) return b - e.amount
    if (e.kind === 'transfer') return b - (e.account_id === account.id ? e.amount : 0) + (e.to_account_id === account.id ? e.amount : 0)
    return b
  }, account.opening_balance)
}

export default function registerAccounting({ app, one, all, run, tx, err, log, can, modulesOf, today, now }) {
  const co = u => u.owner_id ?? u.id
  const acc = gateWith('accounting')
  function gateWith(perm) {
    return (req, _res, next) => (modulesOf(req.user).includes('accounting') && can(req.user, perm)
      ? next() : next(err(403, 'Accounting is not enabled for your account')))
  }
  const own = (table, id, u, what) => {
    const r = one(`SELECT * FROM ${table} WHERE id=? AND company_id=?`, +id, co(u))
    if (!r) throw err(404, `${what} not found`)
    return r
  }
  const amountOf = v => { const n = Math.round(+v); if (!(n > 0)) throw err(400, 'Amount is required'); return n }
  const range = q => ({ from: isDate(q.from) ? q.from : today().slice(0, 7) + '-01', to: isDate(q.to) ? q.to : today() })

  // ---- accounts ----
  const accountsWithBalance = c => {
    const entries = all('SELECT kind, account_id, to_account_id, amount, voided_at FROM acc_entries WHERE company_id=?', c)
    return all('SELECT * FROM acc_accounts WHERE company_id=? ORDER BY active DESC, name', c).map(a => ({ ...a, balance: balanceOf(a, entries) }))
  }
  app.get('/api/acc/meta', acc, (req, res) => res.json({ income: INCOME_CATS, expense: EXPENSE_CATS, accounts: accountsWithBalance(co(req.user)).filter(a => a.active) }))
  app.get('/api/acc/accounts', acc, (req, res) => res.json(accountsWithBalance(co(req.user))))
  app.post('/api/acc/accounts', acc, (req, res) => {
    const b = req.body || {}, name = String(b.name || '').trim()
    if (!name) throw err(400, 'Name is required')
    if (!ACC_KINDS.includes(b.kind)) throw err(400, 'Pick cash or bank')
    const id = run('INSERT INTO acc_accounts(company_id,name,kind,opening_balance,created_at) VALUES(?,?,?,?,?)', co(req.user), name, b.kind, Math.round(+b.opening_balance || 0), now()).lastInsertRowid
    log(req, 'create', 'acc_account', id, { name })
    res.json({ id })
  })
  app.patch('/api/acc/accounts/:id', acc, (req, res) => {
    const a = own('acc_accounts', req.params.id, req.user, 'Account'), b = req.body || {}
    run('UPDATE acc_accounts SET name=?, opening_balance=?, active=? WHERE id=?', String(b.name ?? a.name).trim() || a.name, b.opening_balance === undefined ? a.opening_balance : Math.round(+b.opening_balance || 0), b.active === undefined ? a.active : b.active ? 1 : 0, a.id)
    res.json({ ok: true })
  })

  // ---- ledger ----
  app.get('/api/acc/entries', acc, (req, res) => {
    const { from, to } = range(req.query), q = `%${String(req.query.q || '').trim()}%`
    const rows = all(`SELECT e.*, a.name account_name, t.name to_account_name FROM acc_entries e JOIN acc_accounts a ON a.id=e.account_id LEFT JOIN acc_accounts t ON t.id=e.to_account_id
      WHERE e.company_id=? AND e.date BETWEEN ? AND ? AND (?='' OR e.kind=?) AND (?=0 OR e.account_id=? OR e.to_account_id=?) AND (?='%%' OR e.party LIKE ? OR e.note LIKE ? OR e.category LIKE ? OR e.ref LIKE ?)
      ORDER BY e.date DESC, e.id DESC LIMIT 1000`, co(req.user), from, to, req.query.kind || '', req.query.kind || '', +req.query.account || 0, +req.query.account || 0, +req.query.account || 0, q, q, q, q, q)
    res.json({ from, to, rows })
  })
  app.post('/api/acc/entries', acc, (req, res) => {
    const b = req.body || {}, c = co(req.user)
    if (!KINDS.includes(b.kind)) throw err(400, 'Pick income, expense or transfer')
    if (!isDate(b.date) || b.date > today()) throw err(400, 'Date is required and cannot be in the future')
    const amount = amountOf(b.amount), a = own('acc_accounts', b.account_id, req.user, 'Account')
    let to = null, category = null
    if (b.kind === 'transfer') {
      to = own('acc_accounts', b.to_account_id, req.user, 'Destination account')
      if (to.id === a.id) throw err(400, 'Pick two different accounts')
    } else {
      category = String(b.category || '').trim()
      if (!(b.kind === 'income' ? INCOME_CATS : EXPENSE_CATS).includes(category)) throw err(400, 'Pick a category')
    }
    const id = run('INSERT INTO acc_entries(company_id,kind,date,account_id,to_account_id,category,amount,party,ref,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      c, b.kind, b.date, a.id, to?.id ?? null, category, amount, b.party?.trim() || null, b.ref?.trim() || null, b.note?.trim() || null, req.user.id, now()).lastInsertRowid
    log(req, 'create', 'acc_entry', id, { kind: b.kind, amount })
    res.json({ id })
  })
  app.post('/api/acc/entries/:id/void', acc, (req, res) => {
    const e = own('acc_entries', req.params.id, req.user, 'Entry')
    if (e.voided_at) throw err(400, 'Already voided')
    if (!req.body.note?.trim()) throw err(400, 'A reason is required')
    run('UPDATE acc_entries SET voided_at=?, note=COALESCE(note || \' · \', \'\') || ? WHERE id=?', now(), 'Voided: ' + req.body.note.trim(), e.id)
    log(req, 'void', 'acc_entry', e.id, { reason: req.body.note })
    res.json({ ok: true })
  })

  // ---- vendors and bills ----
  const billsFor = c => {
    const t = today()
    return all(`SELECT b.*, v.name vendor_name, COALESCE((SELECT SUM(amount) FROM acc_entries e WHERE e.bill_id=b.id AND e.voided_at IS NULL),0) paid
      FROM acc_bills b JOIN acc_vendors v ON v.id=b.vendor_id WHERE b.company_id=? ORDER BY b.date DESC, b.id DESC`, c)
      .map(b => ({ ...b, status: billStatus({ ...b, today: t, voided: b.voided_at }), balance: b.voided_at ? 0 : Math.max(0, b.amount - b.paid) }))
  }
  app.get('/api/acc/vendors', acc, (req, res) => {
    const bills = billsFor(co(req.user))
    res.json(all('SELECT * FROM acc_vendors WHERE company_id=? ORDER BY active DESC, name', co(req.user))
      .map(v => ({ ...v, owed: bills.filter(b => b.vendor_id === v.id).reduce((s, b) => s + b.balance, 0) })))
  })
  app.post('/api/acc/vendors', acc, (req, res) => {
    const b = req.body || {}, name = String(b.name || '').trim()
    if (!name) throw err(400, 'Name is required')
    res.json({ id: run('INSERT INTO acc_vendors(company_id,name,phone,notes,created_at) VALUES(?,?,?,?,?)', co(req.user), name, b.phone?.trim() || null, b.notes?.trim() || null, now()).lastInsertRowid })
  })
  app.get('/api/acc/bills', acc, (req, res) => res.json(billsFor(co(req.user))))
  app.post('/api/acc/bills', acc, (req, res) => {
    const b = req.body || {}, v = own('acc_vendors', b.vendor_id, req.user, 'Vendor')
    if (!isDate(b.date)) throw err(400, 'Bill date is required')
    if (b.due_date && !isDate(b.due_date)) throw err(400, 'Due date is not valid')
    if (!EXPENSE_CATS.includes(b.category)) throw err(400, 'Pick a category')
    const id = run('INSERT INTO acc_bills(company_id,vendor_id,bill_no,date,due_date,category,amount,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      co(req.user), v.id, b.bill_no?.trim() || null, b.date, b.due_date || null, b.category, amountOf(b.amount), b.note?.trim() || null, req.user.id, now()).lastInsertRowid
    log(req, 'create', 'acc_bill', id, { vendor: v.name, amount: b.amount })
    res.json({ id })
  })
  app.post('/api/acc/bills/:id/void', acc, (req, res) => {
    const b = own('acc_bills', req.params.id, req.user, 'Bill')
    if (one('SELECT 1 FROM acc_entries WHERE bill_id=? AND voided_at IS NULL', b.id)) throw err(400, 'Void the payments on this bill first')
    run('UPDATE acc_bills SET voided_at=? WHERE id=?', now(), b.id)
    res.json({ ok: true })
  })
  app.post('/api/acc/bills/:id/pay', acc, (req, res) => {
    const bill = billsFor(co(req.user)).find(x => x.id === +req.params.id)
    if (!bill) throw err(404, 'Bill not found')
    if (bill.voided_at) throw err(400, 'This bill is void')
    const b = req.body || {}, amount = amountOf(b.amount), a = own('acc_accounts', b.account_id, req.user, 'Account')
    if (amount > bill.balance) throw err(400, `That is more than the balance (PKR ${bill.balance.toLocaleString('en-PK')})`)
    if (!isDate(b.date) || b.date > today()) throw err(400, 'Date is required and cannot be in the future')
    const id = run(`INSERT INTO acc_entries(company_id,kind,date,account_id,category,amount,party,ref,note,bill_id,source,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'bill',?,?)`,
      co(req.user), 'expense', b.date, a.id, bill.category, amount, bill.vendor_name, b.ref?.trim() || null, `Bill ${bill.bill_no || '#' + bill.id}`, bill.id, req.user.id, now()).lastInsertRowid
    log(req, 'pay', 'acc_bill', bill.id, { amount })
    res.json({ id })
  })

  // ---- bring CRM money into the books ----
  // Idempotent: each CRM row becomes at most one entry (unique on company+source+source_id). Voided CRM rows void their entry.
  app.post('/api/acc/sync', acc, (req, res) => {
    const c = co(req.user), accounts = all('SELECT * FROM acc_accounts WHERE company_id=? AND active=1 ORDER BY id', c)
    const pick = method => accounts.find(a => a.kind === METHOD_KIND(method)) || accounts[0]
    if (!accounts.length) throw err(400, 'Create a cash or bank account first')
    const inCo = 'COALESCE(u.owner_id, u.id)=?'
    const feeds = [
      ['crm_payment', all(`SELECT p.id, p.kind, p.amount, p.paid_on date, p.method, p.ref, p.voided_at, 'Receipt ' || p.receipt_no note, ct.name party FROM payments p
        JOIN users u ON u.id=p.created_by JOIN leads l ON l.id=p.lead_id JOIN contacts ct ON ct.id=l.contact_id WHERE ${inCo}`, c),
      r => (r.kind === 'refund' ? ['expense', 'Refunds'] : ['income', r.kind === 'transfer' ? 'Transfer fees' : 'Sales receipts'])],
      ['crm_rent', all(`SELECT r.id, r.kind, r.amount, r.paid_on date, r.method, r.ref, r.voided_at, 'Receipt ' || r.receipt_no note, ct.name party FROM rent_payments r
        JOIN users u ON u.id=r.created_by JOIN leases le ON le.id=r.lease_id JOIN contacts ct ON ct.id=le.tenant_contact_id WHERE ${inCo}`, c),
      r => (r.kind === 'deposit_refund' ? ['expense', 'Refunds'] : ['income', r.kind === 'deposit' ? 'Security deposits' : 'Rent income'])],
      ['crm_commission', all(`SELECT m.id, 'paid' kind, m.amount, m.paid_on date, NULL method, m.ref, NULL voided_at, 'Commission on allotment #' || m.allotment_id note, COALESCE(us.name, d.name) party
        FROM commissions m JOIN users u ON u.id=m.paid_by LEFT JOIN users us ON us.id=m.user_id LEFT JOIN dealers d ON d.id=m.dealer_id WHERE m.status='paid' AND m.paid_on IS NOT NULL AND ${inCo}`, c),
      () => ['expense', 'Commissions']],
      ['payroll', all(`SELECT s.id, 'paid' kind, s.net amount, s.paid_on date, s.pay_method method, NULL ref, NULL voided_at, 'Payroll ' || p.month note, s.name party
        FROM hr_payslips s JOIN hr_payroll p ON p.id=s.payroll_id WHERE s.company_id=? AND s.paid_on IS NOT NULL AND s.net > 0`, c),
      () => ['expense', 'Salaries']],
    ]
    let added = 0, voided = 0
    tx(() => {
      for (const [source, rows, cat] of feeds) for (const r of rows) {
        const have = one('SELECT id, voided_at FROM acc_entries WHERE company_id=? AND source=? AND source_id=?', c, source, r.id)
        if (have) { if (r.voided_at && !have.voided_at) { run('UPDATE acc_entries SET voided_at=? WHERE id=?', r.voided_at, have.id); voided++ } continue }
        if (r.voided_at || !(r.amount > 0) || !isDate(r.date)) continue
        const [kind, category] = cat(r)
        run(`INSERT INTO acc_entries(company_id,kind,date,account_id,category,amount,party,ref,note,source,source_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          c, kind, r.date, pick(r.method).id, category, Math.round(r.amount), r.party, r.ref || null, r.note, source, r.id, req.user.id, now())
        added++
      }
    })()
    log(req, 'sync', 'acc_entry', null, { added, voided })
    res.json({ added, voided })
  })

  // ---- reports ----
  app.get('/api/acc/summary', acc, (req, res) => {
    const c = co(req.user), { from, to } = range(req.query), t = today()
    const sums = all(`SELECT kind, category, SUM(amount) n FROM acc_entries WHERE company_id=? AND voided_at IS NULL AND kind!='transfer' AND date BETWEEN ? AND ? GROUP BY kind, category ORDER BY n DESC`, c, from, to)
    const byKind = k => sums.filter(s => s.kind === k).map(s => ({ category: s.category, amount: s.n }))
    const income = byKind('income'), expense = byKind('expense'), total = rows => rows.reduce((s, r) => s + r.amount, 0)
    const months = []
    for (let i = 5; i >= 0; i--) { const d = new Date(t + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - i, 1); months.push(d.toISOString().slice(0, 7)) }
    const series = all(`SELECT substr(date,1,7) m, kind, SUM(amount) n FROM acc_entries WHERE company_id=? AND voided_at IS NULL AND kind!='transfer' AND substr(date,1,7)>=? GROUP BY m, kind`, c, months[0])
    const bills = billsFor(c).filter(b => b.balance > 0)
    res.json({
      from, to, income, expense, income_total: total(income), expense_total: total(expense), net: total(income) - total(expense),
      accounts: accountsWithBalance(c).filter(a => a.active),
      months: months.map(m => ({ month: m, income: series.find(s => s.m === m && s.kind === 'income')?.n || 0, expense: series.find(s => s.m === m && s.kind === 'expense')?.n || 0 })),
      payables: { total: bills.reduce((s, b) => s + b.balance, 0), overdue: bills.filter(b => b.status === 'overdue').reduce((s, b) => s + b.balance, 0), count: bills.length },
    })
  })
}
