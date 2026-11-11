import { useState } from 'react'
import { api, useApi, useAction, formData } from './api.js'
import { Select } from './Leads.jsx'

// Accounting module (server/accounting.js). Exact PKR everywhere: books are not rounded to Lac/Cr.
const rs = n => 'PKR ' + Number(n || 0).toLocaleString('en-PK')
const todayStr = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10)
const monthStart = () => todayStr().slice(0, 7) + '-01'
const label = s => String(s || '').replace('_', ' ').replace(/^./, c => c.toUpperCase())
const SOURCE = { manual: 'Manual', bill: 'Bill payment', crm_payment: 'CRM receipt', crm_rent: 'CRM rent', crm_commission: 'CRM commission', payroll: 'Payroll' }

function Range({ from, to, set }) {
  return (
    <div className="row">
      <input type="date" value={from} max={to} onChange={e => set({ from: e.target.value, to })} aria-label="From" />
      <span className="muted">to</span>
      <input type="date" value={to} min={from} max={todayStr()} onChange={e => set({ from, to: e.target.value })} aria-label="To" />
    </div>
  )
}

function Bars({ months }) {
  const max = Math.max(1, ...months.flatMap(m => [m.income, m.expense]))
  return (
    <div className="row" style={{ alignItems: 'flex-end', gap: 18, height: 150 }}>
      {months.map(m => (
        <div key={m.month} style={{ textAlign: 'center', flex: 1 }}>
          <div className="row" style={{ alignItems: 'flex-end', justifyContent: 'center', gap: 4, height: 120 }}>
            <div title={'Income ' + rs(m.income)} style={{ width: 16, height: Math.max(2, m.income / max * 120), background: '#147d52', borderRadius: 3 }} />
            <div title={'Expense ' + rs(m.expense)} style={{ width: 16, height: Math.max(2, m.expense / max * 120), background: '#f56a0a', borderRadius: 3 }} />
          </div>
          <small className="muted">{m.month.slice(5)}</small>
        </div>
      ))}
    </div>
  )
}

export function AccOverview() {
  const [r, setR] = useState({ from: monthStart(), to: todayStr() })
  const [d, reload, error] = useApi(`/acc/summary?from=${r.from}&to=${r.to}`)
  const { run, error: err2, busy } = useAction()
  const [msg, setMsg] = useState('')
  const sync = () => run(async () => { const x = await api('/acc/sync', { body: {} }); setMsg(`Imported ${x.added} CRM entries${x.voided ? `, voided ${x.voided}` : ''}.`); reload() })
  if (error) return <p className="error">{error}</p>
  if (!d) return <p className="muted pad">Loading…</p>
  const table = (title, rows, total) => (
    <div className="card">
      <h3>{title}</h3>
      <table><tbody>
        {rows.map(x => <tr key={x.category}><td>{x.category}</td><td className="nowrap">{rs(x.amount)}</td></tr>)}
        {rows.length === 0 && <tr><td className="muted">Nothing in this period.</td></tr>}
        <tr><td><b>Total</b></td><td className="nowrap"><b>{rs(total)}</b></td></tr>
      </tbody></table>
    </div>
  )
  return (
    <section>
      <div className="row between">
        <Range {...r} set={x => setR(x)} />
        <div className="row"><button className="ghost" onClick={sync} disabled={busy}>Import CRM receipts, rent, commissions and payroll</button>{msg && <span className="ok">{msg}</span>}</div>
      </div>
      {(err2) && <p className="error">{err2}</p>}
      <div className="cards">
        <div className="card"><small className="muted">Income</small><h2>{rs(d.income_total)}</h2></div>
        <div className="card"><small className="muted">Expenses</small><h2>{rs(d.expense_total)}</h2></div>
        <div className="card"><small className="muted">Profit / (loss)</small><h2 style={{ color: d.net < 0 ? '#b42318' : '#147d52' }}>{rs(d.net)}</h2></div>
        <div className="card"><small className="muted">Payable to vendors</small><h2>{rs(d.payables.total)}</h2><small className="muted">{d.payables.overdue ? `${rs(d.payables.overdue)} overdue` : `${d.payables.count} open bills`}</small></div>
      </div>
      <div className="card">
        <h3>Cash and bank</h3>
        <table><tbody>
          {d.accounts.map(a => <tr key={a.id}><td>{a.name} <small className="muted">{label(a.kind)}</small></td><td className="nowrap"><b>{rs(a.balance)}</b></td></tr>)}
          {d.accounts.length === 0 && <tr><td className="muted">No accounts yet. <a href="#/accounting/accounts">Add a cash or bank account</a> to start.</td></tr>}
        </tbody></table>
      </div>
      <div className="card"><h3>Last 6 months <small className="muted">green income · orange expense</small></h3><Bars months={d.months} /></div>
      <div className="grid2">{table('Profit & loss: income', d.income, d.income_total)}{table('Profit & loss: expenses', d.expense, d.expense_total)}</div>
    </section>
  )
}

function EntryForm({ meta, onDone }) {
  const [kind, setKind] = useState('expense')
  const { run, error, busy } = useAction()
  const save = e => { const form = e.target, body = { ...formData(e), kind }; run(async () => { await api('/acc/entries', { body }); form.reset(); onDone() }) }
  const accounts = meta.accounts.map(a => [a.id, a.name])
  return (
    <form className="card grid" onSubmit={save}>
      <h3 className="wide">Add entry</h3>
      <div className="seg wide">{['expense', 'income', 'transfer'].map(k => <button type="button" key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{label(k)}</button>)}</div>
      <label>Date<input type="date" name="date" defaultValue={todayStr()} max={todayStr()} required /></label>
      <label>Amount (PKR)<input type="number" min="1" name="amount" required /></label>
      <label>{kind === 'transfer' ? 'From account' : 'Account'}<Select name="account_id" required options={accounts} /></label>
      {kind === 'transfer'
        ? <label>To account<Select name="to_account_id" required options={accounts} /></label>
        : <label>Category<Select name="category" required options={meta[kind].map(c => [c, c])} /></label>}
      {kind !== 'transfer' && <label>{kind === 'income' ? 'Received from' : 'Paid to'}<input name="party" /></label>}
      <label>Reference<input name="ref" placeholder="Cheque / transaction no." /></label>
      <label className="wide">Note<input name="note" /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Save entry</button></div>
    </form>
  )
}

export function AccLedger() {
  const [r, setR] = useState({ from: monthStart(), to: todayStr() })
  const [f, setF] = useState({ kind: '', account: '', q: '' })
  const [meta, reloadMeta] = useApi('/acc/meta')
  const qs = `from=${r.from}&to=${r.to}&kind=${f.kind}&account=${f.account}&q=${encodeURIComponent(f.q)}`
  const [d, reload, error] = useApi('/acc/entries?' + qs)
  const [open, setOpen] = useState(false)
  const { run, error: err2 } = useAction()
  const done = () => { reload(); reloadMeta() }
  const voidIt = e => { const note = prompt('Reason for voiding this entry?'); if (note) run(async () => { await api(`/acc/entries/${e.id}/void`, { body: { note } }); done() }) }
  const csv = () => {
    const rows = [['Date', 'Type', 'Account', 'Category', 'Party', 'Amount', 'Reference', 'Note', 'Source', 'Voided'], ...d.rows.map(e => [e.date, e.kind, e.account_name + (e.to_account_name ? ' > ' + e.to_account_name : ''), e.category, e.party, e.amount, e.ref, e.note, e.source, e.voided_at ? 'yes' : ''])]
    const text = rows.map(x => x.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: `ledger-${r.from}-${r.to}.csv` }).click()
  }
  const sign = e => (e.kind === 'income' ? '+' : e.kind === 'expense' ? '−' : '↔')
  return (
    <section>
      {open && meta && (meta.accounts.length ? <EntryForm meta={meta} onDone={() => { setOpen(false); done() }} /> : <p className="card">Add a cash or bank account first: <a href="#/accounting/accounts">Accounts</a>.</p>)}
      <div className="card scroll">
        <div className="row between">
          <h3>Ledger {d && <span className="count">{d.rows.length}</span>}</h3>
          <div className="row"><button className="ghost" onClick={csv} disabled={!d?.rows.length}>Export CSV</button><button onClick={() => setOpen(!open)}>{open ? 'Close' : '+ Add entry'}</button></div>
        </div>
        <div className="row">
          <Range {...r} set={setR} />
          <Select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })} options={[['income', 'Income'], ['expense', 'Expense'], ['transfer', 'Transfer']]} blank="All types" />
          <Select value={f.account} onChange={e => setF({ ...f, account: e.target.value })} options={(meta?.accounts || []).map(a => [a.id, a.name])} blank="All accounts" />
          <input placeholder="Search party, note, category" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
        </div>
        {(error || err2) && <p className="error">{error || err2}</p>}
        <table>
          <thead><tr><th>Date</th><th>Details</th><th>Account</th><th>Amount</th><th></th></tr></thead>
          <tbody>
            {d?.rows.map(e => (
              <tr key={e.id} className={e.voided_at ? 'muted' : ''} style={e.voided_at ? { textDecoration: 'line-through' } : null}>
                <td className="nowrap">{e.date}</td>
                <td><b>{e.category || 'Transfer'}</b>{e.party && ` · ${e.party}`}<small className="muted"><br />{[e.note, e.ref, SOURCE[e.source]].filter(Boolean).join(' · ')}</small></td>
                <td>{e.account_name}{e.to_account_name && ` → ${e.to_account_name}`}</td>
                <td className="nowrap" style={{ color: e.kind === 'income' ? '#147d52' : e.kind === 'expense' ? '#b42318' : undefined }}><b>{sign(e)} {rs(e.amount)}</b></td>
                <td>{!e.voided_at && <button className="ghost" onClick={() => voidIt(e)}>Void</button>}</td>
              </tr>
            ))}
            {d?.rows.length === 0 && <tr><td colSpan="5" className="muted">No entries in this period.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function AccBills() {
  const [meta] = useApi('/acc/meta')
  const [vendors, reloadV] = useApi('/acc/vendors')
  const [bills, reload, error] = useApi('/acc/bills')
  const { run, error: err2, busy } = useAction()
  const [paying, setPaying] = useState(null)
  const done = () => { reload(); reloadV() }
  const addVendor = e => { const form = e.target, body = formData(e); run(async () => { await api('/acc/vendors', { body }); form.reset(); reloadV() }) }
  const addBill = e => { const form = e.target, body = formData(e); run(async () => { await api('/acc/bills', { body }); form.reset(); done() }) }
  const pay = e => { const body = formData(e); run(async () => { await api(`/acc/bills/${paying.id}/pay`, { body }); setPaying(null); done() }) }
  const voidBill = b => { if (confirm('Void this bill?')) run(async () => { await api(`/acc/bills/${b.id}/void`, { body: {} }); done() }) }
  const owed = bills?.reduce((s, b) => s + b.balance, 0) || 0
  return (
    <section>
      <div className="card"><small className="muted">Total payable</small><h2>{rs(owed)}</h2></div>
      {paying && (
        <form className="card grid" onSubmit={pay}>
          <h3 className="wide">Pay {paying.vendor_name} {paying.bill_no && `· ${paying.bill_no}`} <small className="muted">balance {rs(paying.balance)}</small></h3>
          <label>Amount<input type="number" name="amount" min="1" max={paying.balance} defaultValue={paying.balance} required /></label>
          <label>Date<input type="date" name="date" defaultValue={todayStr()} max={todayStr()} required /></label>
          <label>Pay from<Select name="account_id" required options={(meta?.accounts || []).map(a => [a.id, `${a.name} (${rs(a.balance)})`])} /></label>
          <label>Reference<input name="ref" /></label>
          <div className="wide row"><button disabled={busy}>Record payment</button><button type="button" className="ghost" onClick={() => setPaying(null)}>Cancel</button></div>
        </form>
      )}
      <form className="card row" onSubmit={addBill}>
        <b>New bill</b>
        <Select name="vendor_id" required options={(vendors || []).filter(v => v.active).map(v => [v.id, v.name])} blank="Vendor…" />
        <input name="bill_no" placeholder="Bill no." />
        <input type="date" name="date" defaultValue={todayStr()} required aria-label="Bill date" />
        <input type="date" name="due_date" aria-label="Due date" title="Due date" />
        <Select name="category" required options={(meta?.expense || []).map(c => [c, c])} blank="Category…" />
        <input type="number" min="1" name="amount" placeholder="Amount" required />
        <button disabled={busy}>Add bill</button>
      </form>
      {(error || err2) && <p className="error">{error || err2}</p>}
      <div className="card scroll">
        <h3>Bills</h3>
        <table>
          <thead><tr><th>Vendor</th><th>Bill</th><th>Due</th><th>Amount</th><th>Paid</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {bills?.map(b => (
              <tr key={b.id} className={b.status === 'void' ? 'muted' : ''}>
                <td><b>{b.vendor_name}</b><small className="muted"><br />{b.category}</small></td><td>{b.bill_no || '—'}<small className="muted"><br />{b.date}</small></td>
                <td>{b.due_date || '—'}</td><td className="nowrap">{rs(b.amount)}</td><td className="nowrap">{rs(b.paid)}</td>
                <td style={{ color: b.status === 'overdue' ? '#b42318' : b.status === 'paid' ? '#147d52' : undefined }}>{label(b.status)}</td>
                <td className="nowrap">{b.balance > 0 && <button onClick={() => setPaying(b)}>Pay</button>}{' '}{b.status !== 'void' && b.paid === 0 && <button className="ghost" onClick={() => voidBill(b)}>Void</button>}</td>
              </tr>
            ))}
            {bills?.length === 0 && <tr><td colSpan="7" className="muted">No bills yet. Add a vendor below, then a bill above.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card scroll">
        <h3>Vendors</h3>
        <table><tbody>
          {vendors?.map(v => <tr key={v.id}><td><b>{v.name}</b><small className="muted"><br />{v.phone}</small></td><td className="nowrap">{v.owed ? <>Owed <b>{rs(v.owed)}</b></> : <span className="muted">Settled</span>}</td></tr>)}
        </tbody></table>
        <form className="row" onSubmit={addVendor} style={{ marginTop: 12 }}><input name="name" placeholder="Vendor name *" required /><input name="phone" placeholder="Phone" /><button disabled={busy}>Add vendor</button></form>
      </div>
    </section>
  )
}

export function AccAccounts() {
  const [rows, reload, error] = useApi('/acc/accounts')
  const { run, error: err2, busy } = useAction()
  const add = e => { const form = e.target, body = formData(e); run(async () => { await api('/acc/accounts', { body }); form.reset(); reload() }) }
  const patch = (a, body) => run(async () => { await api('/acc/accounts/' + a.id, { method: 'PATCH', body }); reload() })
  const opening = a => { const v = prompt(`Opening balance for ${a.name} (PKR)`, a.opening_balance); if (v !== null) patch(a, { opening_balance: v }) }
  return (
    <section>
      <div className="card scroll">
        <h3>Cash and bank accounts</h3>
        {(error || err2) && <p className="error">{error || err2}</p>}
        <table>
          <thead><tr><th>Account</th><th>Type</th><th>Opening</th><th>Balance</th><th></th></tr></thead>
          <tbody>
            {rows?.map(a => (
              <tr key={a.id} className={a.active ? '' : 'muted'}>
                <td><b>{a.name}</b></td><td>{label(a.kind)}</td>
                <td><button className="ghost" onClick={() => opening(a)}>{rs(a.opening_balance)}</button></td>
                <td className="nowrap"><b>{rs(a.balance)}</b></td>
                <td><button className="ghost" onClick={() => patch(a, { active: !a.active })}>{a.active ? 'Hide' : 'Show'}</button></td>
              </tr>
            ))}
            {rows?.length === 0 && <tr><td colSpan="5" className="muted">No accounts yet.</td></tr>}
          </tbody>
        </table>
        <form className="row" onSubmit={add} style={{ marginTop: 12 }}>
          <input name="name" placeholder="e.g. Office cash, HBL current" required />
          <Select name="kind" required blank={null} options={[['cash', 'Cash'], ['bank', 'Bank']]} />
          <input name="opening_balance" type="number" placeholder="Opening balance" />
          <button disabled={busy}>Add account</button>
        </form>
        <p className="muted"><small>CRM money you import goes to your first Cash account for cash payments and your first Bank account for everything else.</small></p>
      </div>
    </section>
  )
}
