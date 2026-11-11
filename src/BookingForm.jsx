import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, pkr, phone, shrinkImage } from './api.js'
import { Letterhead } from './Brand.jsx'

const DOCS = [['buyer_cnic_front', 'Applicant CNIC (front)'], ['buyer_cnic_back', 'Applicant CNIC (back)'], ['nominee_cnic_front', 'Nominee CNIC (front)'], ['nominee_cnic_back', 'Nominee CNIC (back)']]
const rs = n => 'PKR ' + Number(n).toLocaleString('en-PK')

// Printable booking application: applicant, nominee, plot, payment plan and CNIC copies
export default function BookingForm({ id }) {
  const m = useMeta()
  const [d, reload, loadError] = useApi(`/allotments/${id}/form`)
  const [editing, setEditing] = useState(null)
  if (loadError) return <p className="error">{loadError}</p>
  if (!d) return <p className="muted">Loading…</p>
  const { allotment: a, form: f, schedule, docs } = d
  const edit = editing ?? (m.can('unit_status') && !f.father_name)
  const where = [a.phase, a.block, a.street].filter(Boolean).join(' / ')
  const row = (k, v) => <tr><th>{k}</th><td>{v || <span className="blank" />}</td></tr>
  return (
    <section>
      <div className="row between no-print">
        <a href={'#/ledger/' + a.id} className="muted">← Ledger {a.allotment_no}</a>
        <div className="row">
          {m.can('unit_status') && <button className="ghost" onClick={() => setEditing(!edit)}>{edit ? 'Close editor' : 'Edit details'}</button>}
          <button onClick={() => print()}>Print form</button>
        </div>
      </div>
      {edit && <FormEditor a={a} f={f} docs={docs} reload={reload} onSaved={() => setEditing(false)} />}
      <article className="card letter">
        {a.status === 'cancelled' && <div className="stamp">Cancelled</div>}
        <Letterhead brand={d.brand}>
          <div className="right"><small>Form / File No.</small><b>{a.allotment_no}</b><small>Date: {a.sale_date}</small></div>
        </Letterhead>
        <h1>Booking Application Form</h1>
        <h4>Applicant</h4>
        <table className="letter-table"><tbody>
          {row('Name', a.client)}{row('Father / husband name', f.father_name)}{row('CNIC', a.cnic)}{row('Date of birth', f.dob)}
          {row('Occupation', f.occupation)}{row('Phone', phone(a.phone))}{row('Email', a.email)}{row('Address', f.address)}
        </tbody></table>
        <h4>Nominee</h4>
        <table className="letter-table"><tbody>
          {row('Name', f.nominee_name)}{row('Relation', f.nominee_relation)}{row('CNIC', f.nominee_cnic)}{row('Phone', f.nominee_phone)}{row('Address', f.nominee_address)}
        </tbody></table>
        <h4>Property</h4>
        <table className="letter-table"><tbody>
          {row('Project', `${a.project}${a.city ? ', ' + a.city : ''}`)}{where && row('Location', where)}{row(a.kind === 'building' ? 'Unit no.' : 'Plot no.', a.unit_no)}
          {row('Size / type', `${a.size ? `${+a.size} ${a.uom} ` : ''}${a.unit_type}, ${a.category}`)}{row('Total price', rs(a.price))}
        </tbody></table>
        {schedule.length > 0 && <>
          <h4>Payment plan</h4>
          <table className="letter-table compact"><thead><tr><th>Item</th><th>Due</th><th>Amount</th></tr></thead><tbody>
            {schedule.map((s, i) => <tr key={i}><td>{s.label}</td><td>{s.due_date}</td><td>{rs(s.amount)}</td></tr>)}
          </tbody></table>
        </>}
        {DOCS.some(([k]) => docs[k]) && <div className="cnic-copies">{DOCS.filter(([k]) => docs[k]).map(([k, l]) => <figure key={k}><img src={docs[k]} alt={l} /><figcaption>{l}</figcaption></figure>)}</div>}
        <p><small>I declare that the information above is correct and I agree to the terms and conditions of booking, including the payment schedule. Late payments may attract surcharge or cancellation as per company policy.</small></p>
        <div className="signs">
          <div><span />Applicant signature &amp; thumb</div>
          <div><span />Authorised Signatory</div>
        </div>
      </article>
    </section>
  )
}

function FormEditor({ a, f, docs, reload, onSaved }) {
  const { run, error, busy } = useAction()
  const save = e => { const b = formData(e); run(async () => { await api(`/allotments/${a.id}/form`, { method: 'PUT', body: b }); reload(); onSaved() }) }
  const upload = kind => e => {
    const file = e.target.files[0]
    e.target.value = ''
    if (file) run(async () => { await api(`/allotments/${a.id}/docs/${kind}`, { method: 'PUT', body: { data: await shrinkImage(file, 1200) } }); reload() })
  }
  const remove = kind => run(async () => { await api(`/allotments/${a.id}/docs/${kind}`, { method: 'DELETE' }); reload() })
  return (
    <form className="card grid no-print" onSubmit={save}>
      <h3 className="wide">Applicant &amp; nominee details</h3>
      <label>Father / husband name<input name="father_name" defaultValue={f.father_name} /></label>
      <label>Applicant CNIC<input name="cnic" defaultValue={a.cnic?.includes('*') ? undefined : a.cnic} pattern="\d{5}-?\d{7}-?\d" placeholder="35202-1234567-1" /></label>
      <label>Date of birth<input name="dob" type="date" defaultValue={f.dob} /></label>
      <label>Occupation<input name="occupation" defaultValue={f.occupation} /></label>
      <label className="wide">Address<input name="address" defaultValue={f.address} /></label>
      <label>Nominee name<input name="nominee_name" defaultValue={f.nominee_name} /></label>
      <label>Relation<input name="nominee_relation" defaultValue={f.nominee_relation} placeholder="Wife, son…" /></label>
      <label>Nominee CNIC<input name="nominee_cnic" defaultValue={f.nominee_cnic} pattern="\d{5}-?\d{7}-?\d" /></label>
      <label>Nominee phone<input name="nominee_phone" defaultValue={f.nominee_phone} /></label>
      <label className="wide">Nominee address<input name="nominee_address" defaultValue={f.nominee_address} /></label>
      <div className="wide cnic-slots">
        {DOCS.map(([k, l]) => (
          <div key={k}>
            {docs[k] ? <><img src={docs[k]} alt={l} /><button type="button" className="ghost danger" onClick={() => remove(k)}>Remove</button></>
              : <label className="add-photo">{l}<input type="file" accept="image/*" onChange={upload(k)} hidden /></label>}
          </div>
        ))}
      </div>
      {error && <p className="error wide">{error}</p>}
      <div className="wide"><button disabled={busy}>Save details</button></div>
    </form>
  )
}
