import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData } from './api.js'
import { Select } from './Leads.jsx'
import { Letterhead } from './Brand.jsx'

// HR & Payroll module (server/hr.js). Salaries are exact PKR figures, never rounded to Lac/Cr like the sales screens.
const rs = n => (n == null ? '—' : 'PKR ' + Number(n).toLocaleString('en-PK'))
const thisMonth = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 7)
const todayStr = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10)
const label = s => String(s || '').replace('_', ' ').replace(/^./, c => c.toUpperCase())
const ATT = ['present', 'late', 'half_day', 'absent', 'paid_leave', 'unpaid_leave', 'holiday']
const LEAVES = ['annual', 'sick', 'casual', 'unpaid']
const PAY = [['salary', 'Fixed salary'], ['commission', 'Commission only'], ['both', 'Salary + commission']]

export function HrOverview() {
  const [d, , error] = useApi('/hr/summary')
  if (error) return <p className="error">{error}</p>
  if (!d) return <p className="muted pad">Loading…</p>
  const present = (d.today.present || 0) + (d.today.late || 0)
  return (
    <section>
      <div className="cards">
        <div className="card"><small className="muted">Active staff</small><h2>{d.headcount}</h2></div>
        <div className="card"><small className="muted">Present today</small><h2>{present}</h2><small className="muted">{d.marked_today ? `${d.marked_today} marked` : 'Attendance not marked yet'}</small></div>
        <div className="card"><small className="muted">Leave requests waiting</small><h2>{d.pending_leaves}</h2><a href="#/hr/leave">Review</a></div>
        <div className="card"><small className="muted">Monthly salary bill</small><h2>{rs(d.monthly_bill)}</h2><small className="muted">Base + allowances, before commission</small></div>
      </div>
      <div className="card">
        <h3>Payroll for {d.month}</h3>
        <p>{d.this_month ? <>Status: <b>{label(d.this_month.status)}</b> · <a href={'#/hr/payroll/' + d.this_month.id}>Open</a></> : <>Not run yet. <a href="#/hr/payroll">Run payroll</a></>}</p>
      </div>
      <div className="card">
        <h3>Departments</h3>
        {d.departments.length === 0 ? <p className="muted">No employees yet. <a href="#/hr/employees">Add your first employee</a>.</p>
          : <table><tbody>{d.departments.map(x => <tr key={x.department}><td>{x.department}</td><td>{x.n}</td></tr>)}</tbody></table>}
      </div>
    </section>
  )
}

function EmployeeForm({ e = {}, canPay, users, onDone }) {
  const { run, error, busy } = useAction()
  const [type, setType] = useState(e.pay_type || 'salary')
  const save = ev => {
    const body = formData(ev)
    run(async () => { await api('/hr/employees' + (e.id ? '/' + e.id : ''), { method: e.id ? 'PATCH' : 'POST', body }); onDone() })
  }
  return (
    <form className="card grid" onSubmit={save}>
      <h3 className="wide">{e.id ? 'Edit ' + e.name : 'New employee'}</h3>
      <label>Name *<input name="name" defaultValue={e.name} required /></label>
      <label>Designation<input name="designation" defaultValue={e.designation} /></label>
      <label>Department<input name="department" defaultValue={e.department} placeholder="Sales, Accounts, Admin…" /></label>
      <label>Phone<input name="phone" defaultValue={e.phone} /></label>
      <label>CNIC<input name="cnic" defaultValue={e.cnic} /></label>
      <label>Email<input name="email" defaultValue={e.email} /></label>
      <label>Join date<input type="date" name="join_date" defaultValue={e.join_date} /></label>
      <label>CRM login (links their sales commission)<Select name="user_id" defaultValue={e.user_id ?? ''} options={(users || []).map(u => [u.id, u.name])} /></label>
      {canPay && <>
        <label>Pay type<Select name="pay_type" value={type} onChange={x => setType(x.target.value)} options={PAY} blank={null} /></label>
        {type !== 'commission' && <label>Monthly salary (PKR)<input type="number" min="0" name="base_salary" defaultValue={e.base_salary ?? 0} /></label>}
        {type !== 'commission' && <label>Monthly allowance (PKR)<input type="number" min="0" name="allowance" defaultValue={e.allowance ?? 0} /></label>}
        <label>Bank / account details<input name="bank" defaultValue={e.bank} /></label>
      </>}
      <label className="wide">Notes<textarea name="notes" rows={2} defaultValue={e.notes} /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>{e.id ? 'Save' : 'Add employee'}</button><button type="button" className="ghost" onClick={onDone}>Cancel</button></div>
    </form>
  )
}

export function Employees() {
  const m = useMeta()
  const [all, setAll] = useState(false)
  const [rows, reload, error] = useApi('/hr/employees' + (all ? '?status=all' : ''))
  const [edit, setEdit] = useState(null) // null | {} (new) | employee
  const { run, error: err2 } = useAction()
  const canPay = m.can('payroll')
  const done = () => { setEdit(null); reload() }
  const leave = e => { if (confirm(`Mark ${e.name} as left? They stay in past payrolls.`)) run(async () => { await api('/hr/employees/' + e.id, { method: 'PATCH', body: { status: 'left' } }); reload() }) }
  const back = e => run(async () => { await api('/hr/employees/' + e.id, { method: 'PATCH', body: { status: 'active' } }); reload() })
  return (
    <section>
      {edit && <EmployeeForm e={edit} canPay={canPay} users={m.users} onDone={done} key={edit.id || 'new'} />}
      <div className="card scroll">
        <div className="row between">
          <h3>Employees {rows && <span className="count">{rows.length}</span>}</h3>
          <div className="row">
            <label className="row"><input type="checkbox" checked={all} onChange={x => setAll(x.target.checked)} /> Show former staff</label>
            <button onClick={() => setEdit({})}>+ New employee</button>
          </div>
        </div>
        {(error || err2) && <p className="error">{error || err2}</p>}
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Pay</th>{canPay && <th>Salary</th>}<th>Joined</th><th></th></tr></thead>
          <tbody>
            {rows?.map(e => (
              <tr key={e.id} className={e.status === 'active' ? '' : 'muted'}>
                <td><b>{e.name}</b><small className="muted"><br />{[e.phone, e.user_name && 'CRM: ' + e.user_name].filter(Boolean).join(' · ')}</small></td>
                <td>{e.designation || '—'}<small className="muted"><br />{e.department}</small></td>
                <td>{label(e.pay_type)}</td>
                {canPay && <td className="nowrap">{e.pay_type === 'commission' ? '—' : rs((e.base_salary || 0) + (e.allowance || 0))}</td>}
                <td>{e.join_date || '—'}</td>
                <td className="nowrap"><button className="ghost" onClick={() => setEdit(e)}>Edit</button>{' '}
                  {e.status === 'active' ? <button className="ghost" onClick={() => leave(e)}>Mark left</button> : <button className="ghost" onClick={() => back(e)}>Reinstate</button>}</td>
              </tr>
            ))}
            {rows?.length === 0 && <tr><td colSpan="6" className="muted">No employees yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function Attendance() {
  const [date, setDate] = useState(todayStr())
  const [d, reload, error] = useApi('/hr/attendance?date=' + date)
  const [edits, setEdits] = useState({})
  const { run, error: err2, busy } = useAction()
  const [ok, setOk] = useState(false)
  const val = (r, k) => edits[r.employee_id]?.[k] ?? r[k] ?? ''
  const set = (r, k) => e => { setOk(false); setEdits({ ...edits, [r.employee_id]: { ...edits[r.employee_id], [k]: e.target.value } }) }
  const markAll = status => { setOk(false); setEdits(Object.fromEntries(d.rows.map(r => [r.employee_id, { ...edits[r.employee_id], status }]))) }
  const save = () => {
    const rows = Object.entries(edits).map(([id, v]) => ({ employee_id: +id, status: v.status ?? d.rows.find(r => r.employee_id === +id)?.status, check_in: v.check_in, check_out: v.check_out, note: v.note }))
    if (!rows.length) return
    run(async () => { await api('/hr/attendance', { body: { date, rows } }); setEdits({}); setOk(true); reload() })
  }
  const pick = e => { setDate(e.target.value); setEdits({}); setOk(false) }
  return (
    <section>
      <div className="card scroll">
        <div className="row between">
          <h3>Attendance</h3>
          <div className="row">
            <input type="date" value={date} max={todayStr()} onChange={pick} />
            <button className="ghost" onClick={() => markAll('present')} disabled={!d}>Mark all present</button>
            <button onClick={save} disabled={busy || !Object.keys(edits).length}>Save</button>
            {ok && <span className="ok">Saved</span>}
          </div>
        </div>
        {d && !d.workday && <p className="muted">This date is a weekly off (Sunday). Attendance is optional.</p>}
        {(error || err2) && <p className="error">{error || err2}</p>}
        <table>
          <thead><tr><th>Employee</th><th>Status</th><th>In</th><th>Out</th><th>Note</th></tr></thead>
          <tbody>
            {d?.rows.map(r => (
              <tr key={r.employee_id}>
                <td><b>{r.name}</b><small className="muted"><br />{r.designation}</small></td>
                <td><Select value={val(r, 'status')} onChange={set(r, 'status')} options={ATT.map(a => [a, label(a)])} blank="Not marked" /></td>
                <td><input type="time" value={val(r, 'check_in')} onChange={set(r, 'check_in')} /></td>
                <td><input type="time" value={val(r, 'check_out')} onChange={set(r, 'check_out')} /></td>
                <td><input value={val(r, 'note')} onChange={set(r, 'note')} /></td>
              </tr>
            ))}
            {d?.rows.length === 0 && <tr><td colSpan="5" className="muted">Add employees first.</td></tr>}
          </tbody>
        </table>
        <p className="muted"><small>Days with no attendance mark count as present when payroll is calculated.</small></p>
      </div>
    </section>
  )
}

export function Leave() {
  const m = useMeta()
  const [rows, reload, error] = useApi('/hr/leaves')
  const [emps] = useApi('/hr/employees')
  const { run, error: err2, busy } = useAction()
  const add = e => { const form = e.target, body = formData(e); run(async () => { await api('/hr/leaves', { body }); form.reset(); reload() }) }
  const decide = (l, approve) => run(async () => { await api(`/hr/leaves/${l.id}/decide`, { body: { approve } }); reload() })
  return (
    <section>
      <form className="card grid" onSubmit={add}>
        <h3 className="wide">Record a leave request</h3>
        <label>Employee<Select name="employee_id" required options={(emps || []).map(e => [e.id, e.name])} /></label>
        <label>Type<Select name="kind" required blank={null} options={LEAVES.map(k => [k, label(k)])} /></label>
        <label>From<input type="date" name="from_date" required /></label>
        <label>To<input type="date" name="to_date" required /></label>
        <label className="wide">Reason<input name="reason" /></label>
        <div className="wide row"><button disabled={busy}>Submit</button></div>
      </form>
      <div className="card scroll">
        <h3>Requests</h3>
        {(error || err2) && <p className="error">{error || err2}</p>}
        <table>
          <thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Reason</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows?.map(l => (
              <tr key={l.id}>
                <td><b>{l.employee_name}</b></td><td>{label(l.kind)}</td><td>{l.from_date} → {l.to_date}</td><td>{l.reason || '—'}</td><td>{label(l.status)}</td>
                <td className="nowrap">{l.status === 'pending' && m.can('hr') && <><button onClick={() => decide(l, true)}>Approve</button>{' '}<button className="ghost" onClick={() => decide(l, false)}>Reject</button></>}</td>
              </tr>
            ))}
            {rows?.length === 0 && <tr><td colSpan="6" className="muted">No leave requests.</td></tr>}
          </tbody>
        </table>
        <p className="muted"><small>Approving fills the attendance sheet for working days. Unpaid leave is deducted from salary in payroll.</small></p>
      </div>
    </section>
  )
}

export function Payroll() {
  const [runs, reload, error] = useApi('/hr/payroll')
  const [month, setMonth] = useState(thisMonth())
  const [adj, reloadAdj] = useApi('/hr/adjustments?month=' + month)
  const [emps] = useApi('/hr/employees')
  const { run, error: err2, busy } = useAction()
  const start = () => run(async () => { const r = await api('/hr/payroll', { body: { month } }); location.hash = '#/hr/payroll/' + r.id })
  const addAdj = e => { const form = e.target, body = { ...formData(e), month }; run(async () => { await api('/hr/adjustments', { body }); form.reset(); reloadAdj() }) }
  const delAdj = a => run(async () => { await api('/hr/adjustments/' + a.id, { method: 'DELETE' }); reloadAdj() })
  return (
    <section>
      <div className="card">
        <h3>Run payroll</h3>
        <div className="row">
          <input type="month" value={month} max={thisMonth()} onChange={e => setMonth(e.target.value)} />
          <button onClick={start} disabled={busy}>Generate payslips</button>
        </div>
        <p className="muted"><small>Uses the month's attendance, approved leave, the items below and CRM commissions for linked staff. A draft can be regenerated and edited before you finalize it.</small></p>
        {(error || err2) && <p className="error">{error || err2}</p>}
      </div>
      <div className="card scroll">
        <h3>Allowances, bonuses, deductions and advances for {month}</h3>
        <form className="row" onSubmit={addAdj}>
          <Select name="employee_id" required options={(emps || []).map(e => [e.id, e.name])} />
          <Select name="kind" required blank={null} options={[['allowance', 'Allowance'], ['bonus', 'Bonus'], ['deduction', 'Deduction'], ['advance', 'Advance recovery']]} />
          <input name="amount" type="number" min="1" placeholder="Amount (PKR)" required />
          <input name="note" placeholder="Note" />
          <button disabled={busy}>Add</button>
        </form>
        <table>
          <tbody>
            {adj?.map(a => <tr key={a.id}><td>{a.employee_name}</td><td>{label(a.kind)}</td><td>{rs(a.amount)}</td><td>{a.note}</td><td><button className="ghost" onClick={() => delAdj(a)}>Remove</button></td></tr>)}
            {adj?.length === 0 && <tr><td className="muted">None for this month.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card scroll">
        <h3>Payroll runs</h3>
        <table>
          <thead><tr><th>Month</th><th>Status</th><th>Staff</th><th>Net payable</th><th></th></tr></thead>
          <tbody>
            {runs?.map(p => <tr key={p.id}><td><b>{p.month}</b></td><td>{label(p.status)}</td><td>{p.slips}</td><td>{rs(p.total)}</td><td><a href={'#/hr/payroll/' + p.id}>Open</a></td></tr>)}
            {runs?.length === 0 && <tr><td colSpan="5" className="muted">No payroll run yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const FIELDS = [['base', 'Salary'], ['allowance', 'Allowance'], ['commission', 'Commission'], ['bonus', 'Bonus'], ['deductions', 'Deductions'], ['advances', 'Advances'], ['absence_cut', 'Absence cut']]

export function PayrollRun({ id }) {
  const [d, reload, error] = useApi('/hr/payroll/' + id)
  const { run, error: err2, busy } = useAction()
  if (error) return <p className="error">{error}</p>
  if (!d) return <p className="muted pad">Loading…</p>
  const { payroll: p, slips } = d, draft = p.status === 'draft'
  const total = slips.reduce((s, x) => s + x.net, 0), paid = slips.filter(s => s.paid_on).length
  const edit = (s, k, v) => run(async () => { await api('/hr/payslips/' + s.id, { method: 'PATCH', body: { [k]: v } }); reload() })
  const finalize = () => { if (confirm('Finalize this payroll? Payslips can no longer be edited.')) run(async () => { await api(`/hr/payroll/${id}/finalize`, { body: {} }); reload() }) }
  const regenerate = () => { if (confirm('Regenerate from the latest attendance? Manual edits on this draft will be lost.')) run(async () => { await api('/hr/payroll', { body: { month: p.month } }); reload() }) }
  const remove = () => { if (confirm('Delete this draft payroll?')) run(async () => { await api('/hr/payroll/' + id, { method: 'DELETE' }); location.hash = '#/hr/payroll' }) }
  const pay = s => { const method = prompt('Payment method (Cash, Bank transfer, Cheque, Online)', 'Bank transfer'); if (method) run(async () => { await api(`/hr/payslips/${s.id}/pay`, { body: { method } }); reload() }) }
  return (
    <section>
      <div className="row between no-print">
        <a href="#/hr/payroll" className="muted">← Payroll</a>
        <div className="row">
          {draft && <><button className="ghost" onClick={regenerate} disabled={busy}>Regenerate</button><button className="ghost" onClick={remove} disabled={busy}>Delete draft</button><button onClick={finalize} disabled={busy}>Finalize</button></>}
          <button className="ghost" onClick={() => print()}>Print</button>
        </div>
      </div>
      <div className="card scroll">
        <h3>Payroll {p.month} <span className="count">{label(p.status)}</span></h3>
        <p>Net payable <b>{rs(total)}</b>{!draft && <> · Paid {paid} of {slips.length}</>}</p>
        {err2 && <p className="error">{err2}</p>}
        <table>
          <thead><tr><th>Employee</th>{FIELDS.map(([, l]) => <th key={l}>{l}</th>)}<th>Net</th><th></th></tr></thead>
          <tbody>
            {slips.map(s => (
              <tr key={s.id}>
                <td><b>{s.name}</b><small className="muted"><br />{s.designation} · {s.present_days}/{s.working_days} days</small></td>
                {FIELDS.map(([k]) => (
                  <td key={k}>{draft ? <input type="number" min="0" defaultValue={s[k]} style={{ width: 90 }} onBlur={e => +e.target.value !== s[k] && edit(s, k, e.target.value)} /> : rs(s[k])}</td>
                ))}
                <td className="nowrap"><b>{rs(s.net)}</b></td>
                <td className="nowrap no-print">
                  <a href={'#/hr/payslip/' + s.id}>Payslip</a>{' '}
                  {!draft && (s.paid_on ? <span className="ok">Paid {s.paid_on}</span> : <button onClick={() => pay(s)}>Mark paid</button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function Payslip({ id }) {
  const [s, , error] = useApi('/hr/payslips/' + id)
  if (error) return <p className="error">{error}</p>
  if (!s) return <p className="muted pad">Loading…</p>
  const earn = [['Basic salary', s.base], ['Allowance', s.allowance], ['Commission', s.commission], ['Bonus', s.bonus]]
  const ded = [['Absence deduction', s.absence_cut], ['Deductions', s.deductions], ['Advance recovery', s.advances]]
  return (
    <section>
      <div className="row between no-print"><a href={'#/hr/payroll/' + s.payroll_id} className="muted">← Payroll {s.month}</a><button onClick={() => print()}>Print payslip</button></div>
      <article className="card letter">
        <Letterhead brand={s.brand}><div className="right"><small>Payslip</small><b>{s.month}</b>{s.paid_on && <small>Paid {s.paid_on}</small>}</div></Letterhead>
        <h1>Salary Slip</h1>
        <table className="letter-table"><tbody>
          <tr><th>Employee</th><td>{s.name}{s.cnic && <> (CNIC {s.cnic})</>}</td></tr>
          <tr><th>Designation</th><td>{[s.designation, s.department].filter(Boolean).join(' · ') || '—'}</td></tr>
          <tr><th>Attendance</th><td>{s.present_days} of {s.working_days} working days{s.unpaid_days ? ` · ${s.unpaid_days} unpaid` : ''}</td></tr>
          {earn.filter(([, v]) => v).map(([k, v]) => <tr key={k}><th>{k}</th><td>{rs(v)}</td></tr>)}
          {ded.filter(([, v]) => v).map(([k, v]) => <tr key={k}><th>{k}</th><td>− {rs(v)}</td></tr>)}
          <tr><th>Net pay</th><td><b>{rs(s.net)}</b></td></tr>
          {s.paid_on && <tr><th>Paid by</th><td>{s.pay_method}{s.bank && ` · ${s.bank}`}</td></tr>}
          {s.note && <tr><th>Note</th><td>{s.note}</td></tr>}
        </tbody></table>
        <div className="signs"><div><span />Employee</div><div><span />{s.brand?.signatory || 'Authorised signatory'}</div></div>
        <footer><small>{s.brand?.footer || 'This is a computer-generated payslip.'}</small></footer>
      </article>
    </section>
  )
}
