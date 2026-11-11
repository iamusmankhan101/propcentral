// HR & Payroll module. Switched on per company (module `hr`) and gated by the `hr` / `payroll` permissions.
// Every row carries company_id = the company's main account, so one client never sees another's staff or salaries.
// Registered from server.js with the shared helpers; kept in its own file so the monolith stays readable.

export const HR_SCHEMA = `
CREATE TABLE IF NOT EXISTS hr_employees(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, user_id INTEGER, name TEXT NOT NULL, phone TEXT, cnic TEXT, email TEXT,
  designation TEXT, department TEXT, join_date TEXT, status TEXT NOT NULL DEFAULT 'active', left_on TEXT, pay_type TEXT NOT NULL DEFAULT 'salary',
  base_salary INTEGER NOT NULL DEFAULT 0, allowance INTEGER NOT NULL DEFAULT 0, bank TEXT, notes TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS hr_employees_company ON hr_employees(company_id);
CREATE TABLE IF NOT EXISTS hr_attendance(employee_id INTEGER NOT NULL, company_id INTEGER NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, check_in TEXT, check_out TEXT,
  note TEXT, PRIMARY KEY(employee_id, date));
CREATE INDEX IF NOT EXISTS hr_attendance_day ON hr_attendance(company_id, date);
CREATE TABLE IF NOT EXISTS hr_leaves(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL,
  kind TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', decided_by INTEGER, decided_at TEXT, created_by INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS hr_adjustments(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL,
  amount INTEGER NOT NULL, note TEXT, created_by INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS hr_payroll(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, month TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_by INTEGER,
  created_at TEXT, finalized_at TEXT, UNIQUE(company_id, month));
CREATE TABLE IF NOT EXISTS hr_payslips(id INTEGER PRIMARY KEY, payroll_id INTEGER NOT NULL, company_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, name TEXT, designation TEXT,
  base INTEGER NOT NULL DEFAULT 0, allowance INTEGER NOT NULL DEFAULT 0, commission INTEGER NOT NULL DEFAULT 0, bonus INTEGER NOT NULL DEFAULT 0, deductions INTEGER NOT NULL DEFAULT 0,
  advances INTEGER NOT NULL DEFAULT 0, absence_cut INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0, working_days INTEGER, unpaid_days REAL, present_days REAL,
  paid_on TEXT, pay_method TEXT, note TEXT, UNIQUE(payroll_id, employee_id));
`

export const ATT_STATUS = ['present', 'late', 'half_day', 'absent', 'paid_leave', 'unpaid_leave', 'holiday']
export const LEAVE_KINDS = ['annual', 'sick', 'casual', 'unpaid']
const PAY_TYPES = ['salary', 'commission', 'both']
const ADJ_KINDS = ['allowance', 'bonus', 'deduction', 'advance']
const PAY_METHODS = ['Cash', 'Bank transfer', 'Cheque', 'Online']
const EMP_FIELDS = ['user_id', 'name', 'phone', 'cnic', 'email', 'designation', 'department', 'join_date', 'pay_type', 'base_salary', 'allowance', 'bank', 'notes']
const WEEKLY_OFF = [0] // ponytail: Sunday is the weekly off for every company; make it a per-company setting when a client works another pattern

const isMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '')
const dayList = (from, to) => { // inclusive list of YYYY-MM-DD between two dates
  const out = [], d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z')
  for (; d <= end && out.length < 400; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10))
  return out
}
const isWorkday = date => !WEEKLY_OFF.includes(new Date(date + 'T00:00:00Z').getUTCDay())
const monthDays = month => {
  const [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return dayList(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`)
}

// The numbers a payslip starts from. Pure so it can be checked without a database.
// Days with no attendance row count as present: a company that does not track attendance still gets a full-month payslip.
export function computePay({ emp, days, att, commission = 0, adj = {} }) {
  const work = days.filter(isWorkday), workingDays = work.length
  const unpaid = work.reduce((s, d) => { const a = att[d]; return s + (a === 'absent' || a === 'unpaid_leave' ? 1 : a === 'half_day' ? 0.5 : 0) }, 0)
  const present = work.reduce((s, d) => { const a = att[d]; return s + (a === undefined || a === 'present' || a === 'late' ? 1 : a === 'half_day' ? 0.5 : 0) }, 0)
  const hasSalary = emp.pay_type !== 'commission'
  const base = hasSalary ? emp.base_salary : 0
  const allowance = hasSalary ? emp.allowance + (adj.allowance || 0) : adj.allowance || 0
  const absence_cut = hasSalary && workingDays ? Math.round(base / workingDays * unpaid) : 0
  const comm = emp.pay_type === 'salary' ? 0 : Math.round(commission)
  const bonus = adj.bonus || 0, deductions = adj.deduction || 0, advances = adj.advance || 0
  return { base, allowance, commission: comm, bonus, deductions, advances, absence_cut, working_days: workingDays, unpaid_days: unpaid, present_days: present,
    net: base + allowance + comm + bonus - deductions - advances - absence_cut }
}

export default function registerHr({ app, one, all, run, tx, err, log, can, modulesOf, today, now, brandOfId }) {
  const co = u => u.owner_id ?? u.id
  const gate = perm => (req, _res, next) => (modulesOf(req.user).includes('hr') && can(req.user, perm)
    ? next() : next(err(403, 'HR & Payroll is not enabled for your account')))
  const hr = gate('hr'), payroll = gate('payroll')
  const emp = req => {
    const e = one('SELECT * FROM hr_employees WHERE id=? AND company_id=?', +req.params.id, co(req.user))
    if (!e) throw err(404, 'Employee not found')
    return e
  }
  const num = (v, what) => { const n = Math.round(+v || 0); if (n < 0) throw err(400, `${what} cannot be negative`); return n }
  const empFields = b => {
    const f = {}
    for (const k of EMP_FIELDS) if (b[k] !== undefined) f[k] = b[k] === '' ? null : typeof b[k] === 'string' ? b[k].trim() : b[k]
    if ('pay_type' in f && !PAY_TYPES.includes(f.pay_type)) throw err(400, 'Pay type is salary, commission or both')
    for (const k of ['base_salary', 'allowance']) if (k in f) f[k] = num(f[k], k === 'base_salary' ? 'Salary' : 'Allowance')
    if ('join_date' in f && f.join_date && !/^\d{4}-\d{2}-\d{2}$/.test(f.join_date)) throw err(400, 'Join date is not valid')
    return f
  }
  const linkOk = (u, userId) => {
    if (!userId) return null
    const x = one('SELECT id FROM users WHERE id=? AND (id=? OR owner_id=?)', +userId, co(u), co(u))
    if (!x) throw err(400, 'That user is not part of your company')
    return x.id
  }

  // ---- overview ----
  app.get('/api/hr/summary', hr, (req, res) => {
    const c = co(req.user), t = today(), month = t.slice(0, 7)
    const count = one(`SELECT COUNT(*) n, SUM(base_salary+allowance) bill FROM hr_employees WHERE company_id=? AND status='active'`, c)
    const marks = all('SELECT status, COUNT(*) n FROM hr_attendance WHERE company_id=? AND date=? GROUP BY status', c, t)
    res.json({
      headcount: count.n, monthly_bill: count.bill || 0, today: Object.fromEntries(marks.map(m => [m.status, m.n])), marked_today: marks.reduce((s, m) => s + m.n, 0),
      pending_leaves: one(`SELECT COUNT(*) n FROM hr_leaves WHERE company_id=? AND status='pending'`, c).n,
      departments: all(`SELECT COALESCE(department,'Unassigned') department, COUNT(*) n FROM hr_employees WHERE company_id=? AND status='active' GROUP BY 1 ORDER BY n DESC`, c),
      this_month: one('SELECT id, status FROM hr_payroll WHERE company_id=? AND month=?', c, month) || null, month,
    })
  })

  // ---- employees ----
  app.get('/api/hr/employees', hr, (req, res) => {
    const rows = all(`SELECT e.*, u.name user_name FROM hr_employees e LEFT JOIN users u ON u.id=e.user_id WHERE e.company_id=? AND (?='all' OR e.status='active')
      ORDER BY e.status, e.name`, co(req.user), req.query.status === 'all' ? 'all' : 'active')
    // salaries are payroll data: hide them from roles that can run HR but not payroll
    res.json(can(req.user, 'payroll') ? rows : rows.map(r => ({ ...r, base_salary: null, allowance: null, bank: null })))
  })
  app.post('/api/hr/employees', hr, (req, res) => {
    const f = empFields(req.body)
    if (!f.name) throw err(400, 'Name is required')
    if (!can(req.user, 'payroll')) { delete f.base_salary; delete f.allowance; delete f.bank }
    f.user_id = linkOk(req.user, f.user_id)
    const vals = { pay_type: 'salary', ...f, company_id: co(req.user), created_at: now() }
    const id = run(`INSERT INTO hr_employees(${Object.keys(vals)}) VALUES(${Object.keys(vals).map(() => '?')})`, ...Object.values(vals)).lastInsertRowid
    log(req, 'create', 'hr_employee', id, { name: f.name })
    res.json({ id })
  })
  app.get('/api/hr/employees/:id', hr, (req, res) => {
    const e = emp(req), m = (req.query.month && isMonth(req.query.month)) ? req.query.month : today().slice(0, 7), pay = can(req.user, 'payroll')
    res.json({
      employee: pay ? e : { ...e, base_salary: null, allowance: null, bank: null }, month: m,
      attendance: all('SELECT date, status, check_in, check_out, note FROM hr_attendance WHERE employee_id=? AND date LIKE ? ORDER BY date', e.id, m + '%'),
      leaves: all('SELECT * FROM hr_leaves WHERE employee_id=? ORDER BY id DESC LIMIT 20', e.id),
      payslips: pay ? all(`SELECT s.*, p.month, p.status payroll_status FROM hr_payslips s JOIN hr_payroll p ON p.id=s.payroll_id WHERE s.employee_id=? ORDER BY p.month DESC LIMIT 12`, e.id) : [],
    })
  })
  app.patch('/api/hr/employees/:id', hr, (req, res) => {
    const e = emp(req), f = empFields(req.body)
    if (!can(req.user, 'payroll')) { delete f.base_salary; delete f.allowance; delete f.bank }
    if ('user_id' in f) f.user_id = linkOk(req.user, f.user_id)
    if (req.body.status === 'left' || req.body.status === 'active') {
      f.status = req.body.status
      f.left_on = req.body.status === 'left' ? (req.body.left_on || today()) : null
    }
    const keys = Object.keys(f)
    if (keys.length) run(`UPDATE hr_employees SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => f[k]), e.id)
    log(req, 'update', 'hr_employee', e.id, f)
    res.json({ ok: true })
  })

  // ---- attendance ----
  app.get('/api/hr/attendance', hr, (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today()
    const rows = all(`SELECT e.id employee_id, e.name, e.designation, e.department, a.status, a.check_in, a.check_out, a.note FROM hr_employees e
      LEFT JOIN hr_attendance a ON a.employee_id=e.id AND a.date=? WHERE e.company_id=? AND e.status='active' ORDER BY e.name`, date, co(req.user))
    res.json({ date, workday: isWorkday(date), rows })
  })
  app.post('/api/hr/attendance', hr, (req, res) => {
    const { date, rows } = req.body || {}
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw err(400, 'Pick a date')
    if (date > today()) throw err(400, 'Attendance cannot be marked for a future date')
    if (!Array.isArray(rows) || !rows.length) throw err(400, 'Nothing to save')
    tx(() => {
      for (const r of rows) {
        const e = one('SELECT id FROM hr_employees WHERE id=? AND company_id=?', +r.employee_id, co(req.user))
        if (!e) throw err(404, 'Employee not found')
        if (!r.status) { run('DELETE FROM hr_attendance WHERE employee_id=? AND date=?', e.id, date); continue }
        if (!ATT_STATUS.includes(r.status)) throw err(400, 'Unknown attendance status')
        run(`INSERT INTO hr_attendance(employee_id,company_id,date,status,check_in,check_out,note) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(employee_id,date) DO UPDATE SET status=excluded.status, check_in=excluded.check_in, check_out=excluded.check_out, note=excluded.note`,
        e.id, co(req.user), date, r.status, r.check_in || null, r.check_out || null, r.note?.trim() || null)
      }
    })()
    log(req, 'update', 'hr_attendance', null, { date, count: rows.length })
    res.json({ ok: true })
  })
  app.get('/api/hr/attendance/month', hr, (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : today().slice(0, 7)
    const rows = all(`SELECT a.employee_id, a.date, a.status FROM hr_attendance a WHERE a.company_id=? AND a.date LIKE ?`, co(req.user), month + '%')
    const emps = all(`SELECT id, name FROM hr_employees WHERE company_id=? AND status='active' ORDER BY name`, co(req.user))
    res.json({ month, days: monthDays(month).map(d => ({ date: d, workday: isWorkday(d) })), employees: emps, marks: rows })
  })

  // ---- leave ----
  app.get('/api/hr/leaves', hr, (req, res) => res.json(all(`SELECT l.*, e.name employee_name FROM hr_leaves l JOIN hr_employees e ON e.id=l.employee_id
    WHERE l.company_id=? ORDER BY (l.status='pending') DESC, l.id DESC LIMIT 200`, co(req.user))))
  app.post('/api/hr/leaves', hr, (req, res) => {
    const b = req.body || {}, e = one('SELECT id FROM hr_employees WHERE id=? AND company_id=?', +b.employee_id, co(req.user))
    if (!e) throw err(404, 'Pick an employee')
    if (!LEAVE_KINDS.includes(b.kind)) throw err(400, 'Pick a leave type')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.from_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.to_date || '') || b.to_date < b.from_date) throw err(400, 'Pick valid from and to dates')
    if (dayList(b.from_date, b.to_date).length > 60) throw err(400, 'Leave is limited to 60 days per request')
    const id = run('INSERT INTO hr_leaves(company_id,employee_id,from_date,to_date,kind,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
      co(req.user), e.id, b.from_date, b.to_date, b.kind, b.reason?.trim() || null, req.user.id, now()).lastInsertRowid
    res.json({ id })
  })
  app.post('/api/hr/leaves/:id/decide', hr, (req, res) => {
    const l = one('SELECT * FROM hr_leaves WHERE id=? AND company_id=?', +req.params.id, co(req.user))
    if (!l) throw err(404, 'Leave request not found')
    if (l.status !== 'pending') throw err(400, `This request is already ${l.status}`)
    const approve = req.body.approve === true
    tx(() => {
      run('UPDATE hr_leaves SET status=?, decided_by=?, decided_at=? WHERE id=?', approve ? 'approved' : 'rejected', req.user.id, now(), l.id)
      if (approve) for (const d of dayList(l.from_date, l.to_date).filter(isWorkday)) // approved leave fills the attendance sheet; payroll reads it from there
        run(`INSERT INTO hr_attendance(employee_id,company_id,date,status,note) VALUES(?,?,?,?,?)
          ON CONFLICT(employee_id,date) DO UPDATE SET status=excluded.status, note=excluded.note`, l.employee_id, l.company_id, d, l.kind === 'unpaid' ? 'unpaid_leave' : 'paid_leave', `${l.kind} leave`)
    })()
    log(req, approve ? 'approve' : 'reject', 'hr_leave', l.id)
    res.json({ ok: true })
  })

  // ---- one-off payroll items (allowance / bonus / deduction / advance) ----
  app.get('/api/hr/adjustments', payroll, (req, res) => res.json(all(`SELECT a.*, e.name employee_name FROM hr_adjustments a JOIN hr_employees e ON e.id=a.employee_id
    WHERE a.company_id=? AND a.month=? ORDER BY a.id DESC`, co(req.user), isMonth(req.query.month) ? req.query.month : today().slice(0, 7))))
  app.post('/api/hr/adjustments', payroll, (req, res) => {
    const b = req.body || {}, e = one('SELECT id FROM hr_employees WHERE id=? AND company_id=?', +b.employee_id, co(req.user))
    if (!e) throw err(404, 'Pick an employee')
    if (!ADJ_KINDS.includes(b.kind)) throw err(400, 'Pick allowance, bonus, deduction or advance')
    if (!isMonth(b.month)) throw err(400, 'Pick a month')
    const amount = Math.round(+b.amount)
    if (!(amount > 0)) throw err(400, 'Amount is required')
    if (one(`SELECT 1 FROM hr_payroll WHERE company_id=? AND month=? AND status='finalized'`, co(req.user), b.month)) throw err(400, 'That month is already finalized')
    const id = run('INSERT INTO hr_adjustments(company_id,employee_id,month,kind,amount,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
      co(req.user), e.id, b.month, b.kind, amount, b.note?.trim() || null, req.user.id, now()).lastInsertRowid
    log(req, 'create', 'hr_adjustment', id, { kind: b.kind, amount })
    res.json({ id })
  })
  app.delete('/api/hr/adjustments/:id', payroll, (req, res) => {
    const a = one('SELECT * FROM hr_adjustments WHERE id=? AND company_id=?', +req.params.id, co(req.user))
    if (!a) throw err(404, 'Not found')
    if (one(`SELECT 1 FROM hr_payroll WHERE company_id=? AND month=? AND status='finalized'`, a.company_id, a.month)) throw err(400, 'That month is already finalized')
    run('DELETE FROM hr_adjustments WHERE id=?', a.id)
    res.json({ ok: true })
  })

  // ---- payroll ----
  const slipFor = (e, month, c) => {
    const days = monthDays(month), att = Object.fromEntries(all('SELECT date, status FROM hr_attendance WHERE employee_id=? AND date LIKE ?', e.id, month + '%').map(a => [a.date, a.status]))
    const adj = Object.fromEntries(all('SELECT kind, SUM(amount) n FROM hr_adjustments WHERE employee_id=? AND month=? GROUP BY kind', e.id, month).map(a => [a.kind, a.n]))
    // CRM commissions the linked user earned on sales made this month (cancelled ones excluded)
    const commission = e.user_id ? one(`SELECT COALESCE(SUM(amount),0) n FROM commissions WHERE user_id=? AND status!='cancelled' AND substr(created_at,1,7)=?`, e.user_id, month).n : 0
    return computePay({ emp: e, days, att, commission, adj })
  }
  app.get('/api/hr/payroll', payroll, (req, res) => res.json(all(`SELECT p.*, (SELECT COUNT(*) FROM hr_payslips WHERE payroll_id=p.id) slips,
    (SELECT COALESCE(SUM(net),0) FROM hr_payslips WHERE payroll_id=p.id) total FROM hr_payroll p WHERE p.company_id=? ORDER BY p.month DESC`, co(req.user))))
  app.post('/api/hr/payroll', payroll, (req, res) => {
    const month = req.body.month
    if (!isMonth(month)) throw err(400, 'Pick a month')
    if (month > today().slice(0, 7)) throw err(400, 'Payroll cannot be run for a future month')
    const c = co(req.user), old = one('SELECT * FROM hr_payroll WHERE company_id=? AND month=?', c, month)
    if (old?.status === 'finalized') throw err(400, 'That month is already finalized')
    const emps = all(`SELECT * FROM hr_employees WHERE company_id=? AND (status='active' OR (left_on IS NOT NULL AND substr(left_on,1,7)>=?)) ORDER BY name`, c, month)
    if (!emps.length) throw err(400, 'Add employees first')
    const id = tx(() => {
      const pid = old?.id ?? run('INSERT INTO hr_payroll(company_id,month,created_by,created_at) VALUES(?,?,?,?)', c, month, req.user.id, now()).lastInsertRowid
      run('DELETE FROM hr_payslips WHERE payroll_id=?', pid) // regenerating a draft starts from the latest attendance and adjustments
      for (const e of emps) {
        const s = slipFor(e, month, c)
        run(`INSERT INTO hr_payslips(payroll_id,company_id,employee_id,name,designation,base,allowance,commission,bonus,deductions,advances,absence_cut,net,working_days,unpaid_days,present_days)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, pid, c, e.id, e.name, e.designation, s.base, s.allowance, s.commission, s.bonus, s.deductions, s.advances, s.absence_cut, s.net,
        s.working_days, s.unpaid_days, s.present_days)
      }
      return pid
    })()
    log(req, 'create', 'hr_payroll', id, { month })
    res.json({ id })
  })
  const runOf = req => {
    const p = one('SELECT * FROM hr_payroll WHERE id=? AND company_id=?', +req.params.id, co(req.user))
    if (!p) throw err(404, 'Payroll not found')
    return p
  }
  app.get('/api/hr/payroll/:id', payroll, (req, res) => {
    const p = runOf(req)
    res.json({ payroll: p, slips: all('SELECT * FROM hr_payslips WHERE payroll_id=? ORDER BY name', p.id) })
  })
  app.delete('/api/hr/payroll/:id', payroll, (req, res) => {
    const p = runOf(req)
    if (p.status !== 'draft') throw err(400, 'Only a draft can be deleted')
    tx(() => { run('DELETE FROM hr_payslips WHERE payroll_id=?', p.id); run('DELETE FROM hr_payroll WHERE id=?', p.id) })()
    res.json({ ok: true })
  })
  app.patch('/api/hr/payslips/:id', payroll, (req, res) => {
    const s = one('SELECT s.*, p.status payroll_status FROM hr_payslips s JOIN hr_payroll p ON p.id=s.payroll_id WHERE s.id=? AND s.company_id=?', +req.params.id, co(req.user))
    if (!s) throw err(404, 'Payslip not found')
    if (s.payroll_status !== 'draft') throw err(400, 'This payroll is finalized')
    const f = { ...pickNums(req.body, ['base', 'allowance', 'commission', 'bonus', 'deductions', 'advances', 'absence_cut']) }
    const m = { ...s, ...f }
    f.net = m.base + m.allowance + m.commission + m.bonus - m.deductions - m.advances - m.absence_cut
    if (req.body.note !== undefined) f.note = String(req.body.note).trim() || null
    const keys = Object.keys(f)
    run(`UPDATE hr_payslips SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => f[k]), s.id)
    log(req, 'update', 'hr_payslip', s.id, f)
    res.json({ ok: true, net: f.net })
  })
  function pickNums(b, keys) {
    const o = {}
    for (const k of keys) if (b[k] !== undefined) o[k] = num(b[k], k)
    return o
  }
  app.post('/api/hr/payroll/:id/finalize', payroll, (req, res) => {
    const p = runOf(req)
    if (p.status !== 'draft') throw err(400, 'Already finalized')
    run(`UPDATE hr_payroll SET status='finalized', finalized_at=? WHERE id=?`, now(), p.id)
    log(req, 'finalize', 'hr_payroll', p.id, { month: p.month })
    res.json({ ok: true })
  })
  app.post('/api/hr/payslips/:id/pay', payroll, (req, res) => {
    const s = one('SELECT s.*, p.status payroll_status FROM hr_payslips s JOIN hr_payroll p ON p.id=s.payroll_id WHERE s.id=? AND s.company_id=?', +req.params.id, co(req.user))
    if (!s) throw err(404, 'Payslip not found')
    if (s.payroll_status !== 'finalized') throw err(400, 'Finalize the payroll before paying')
    if (s.paid_on) throw err(400, 'Already paid')
    if (!PAY_METHODS.includes(req.body.method)) throw err(400, 'Pick a payment method')
    const on = req.body.paid_on || today()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on > today()) throw err(400, 'Payment date is not valid')
    run('UPDATE hr_payslips SET paid_on=?, pay_method=? WHERE id=?', on, req.body.method, s.id)
    log(req, 'pay', 'hr_payslip', s.id, { net: s.net })
    res.json({ ok: true })
  })
  app.get('/api/hr/payslips/:id', payroll, (req, res) => { // printable payslip, with the company letterhead
    const s = one(`SELECT s.*, p.month, p.status payroll_status, e.cnic, e.bank, e.join_date, e.department FROM hr_payslips s JOIN hr_payroll p ON p.id=s.payroll_id
      JOIN hr_employees e ON e.id=s.employee_id WHERE s.id=? AND s.company_id=?`, +req.params.id, co(req.user))
    if (!s) throw err(404, 'Payslip not found')
    res.json({ ...s, brand: brandOfId(req.user.id) })
  })
}
