import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, fmt, pkr, phone, shrinkImage } from './api.js'
import { Select } from './Leads.jsx'

const UOMS = ['marla', 'kanal', 'sqft', 'sqyd']
const file = token => '/api/files/' + token

// Resale and rental properties of outside owners (third-party inventory)
export default function Listings() {
  const m = useMeta()
  const [f, setF] = useState({ q: '', purpose: '', status: 'Available', type: '', max: '' })
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString()
  const [rows, reload] = useApi('/listings?' + qs)
  const [sel, setSel] = useState(null)
  const [adding, setAdding] = useState(false)
  const set = k => e => setF({ ...f, [k]: e.target.value })
  return (
    <section>
      <div className="row between">
        <h2>Listings {rows && <span className="count">{rows.length}</span>}</h2>
        <button className={adding ? 'ghost' : ''} onClick={() => setAdding(!adding)}>{adding ? 'Close form' : '+ New listing'}</button>
      </div>
      {adding && <NewListing onDone={id => { setAdding(false); reload(); setSel(id) }} />}
      <div className="filters">
        <input placeholder="Search title, area, owner" value={f.q} onChange={set('q')} />
        <Select value={f.purpose} onChange={set('purpose')} options={['Sale', 'Rent']} blank="Sale or rent" />
        <Select value={f.status} onChange={set('status')} options={m.settings.listing_statuses} blank="Any status" />
        <Select value={f.type} onChange={set('type')} options={m.settings.property_types} blank="Any type" />
        <input type="number" min="0" placeholder="Max price" value={f.max} onChange={set('max')} />
      </div>
      <div className="inv">
        <div className="listing-grid">
          {rows?.map(l => (
            <button key={l.id} className={'card listing' + (sel === l.id ? ' sel' : '')} onClick={() => setSel(l.id)}>
              {l.cover ? <img src={file(l.cover)} alt="" /> : <span className="no-photo">{l.property_type}</span>}
              <b>PKR {pkr(l.price)}{l.purpose === 'Rent' && <small> /month</small>}</b>
              <span>{l.title || `${l.size ?? ''} ${l.uom ?? ''} ${l.property_type}`}</span>
              <small className="muted">{[l.area, l.city].filter(Boolean).join(', ')} · {l.purpose}{l.status !== 'Available' && ` · ${l.status}`}</small>
            </button>
          ))}
          {rows?.length === 0 && <div className="card muted" style={{ gridColumn: "1 / -1" }}>No listings match. Add resale or rental properties from outside owners with “New listing”.</div>}
        </div>
        <div className="inv-panel">{sel ? <ListingPanel id={sel} key={sel} onChange={reload} /> : <div className="card muted">Select a listing to see details, photos and the owner.</div>}</div>
      </div>
    </section>
  )
}

function ListingFields({ l = {} }) {
  const { settings: s } = useMeta()
  return <>
    <label>Purpose *<Select name="purpose" options={['Sale', 'Rent']} defaultValue={l.purpose} blank={null} /></label>
    <label>Property type *<Select name="property_type" options={s.property_types} defaultValue={l.property_type} required /></label>
    <label className="wide">Title<input name="title" defaultValue={l.title} placeholder="e.g. 10 Marla house, corner, near park" /></label>
    <label>City<input name="city" defaultValue={l.city} /></label>
    <label>Area / society<input name="area" defaultValue={l.area} /></label>
    <label>Address<input name="address" defaultValue={l.address} /></label>
    <label>Size<input name="size" type="number" min="0" step="any" defaultValue={l.size} /></label>
    <label>Unit<Select name="uom" options={UOMS} defaultValue={l.uom || 'marla'} blank={null} /></label>
    <label>Price (PKR) *<input name="price" type="number" min="1" defaultValue={l.price} required placeholder="Rent per month" /></label>
    <label>Bedrooms<input name="bedrooms" type="number" min="0" defaultValue={l.bedrooms} /></label>
    <label className="wide">Features<input name="features" defaultValue={l.features} placeholder="Corner, furnished, gas, parking…" /></label>
    <label className="wide">Internal notes<textarea name="notes" rows="2" defaultValue={l.notes} /></label>
  </>
}

function NewListing({ onDone }) {
  const { run, error, busy } = useAction()
  const submit = e => {
    const b = formData(e), owner = { name: b.owner_name, phone: b.owner_phone }
    delete b.owner_name; delete b.owner_phone
    run(async () => onDone((await api('/listings', { body: { ...b, owner: owner.phone ? owner : undefined } })).id))
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">New listing</h3>
      <ListingFields />
      <label>Owner name<input name="owner_name" /></label>
      <label>Owner phone<input name="owner_phone" placeholder="Saved as a seller / landlord lead" /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide"><button disabled={busy}>Save listing</button></div>
    </form>
  )
}

function ListingPanel({ id, onChange }) {
  const m = useMeta()
  const [d, reload] = useApi('/listings/' + id)
  const { run, error, busy } = useAction()
  const [editing, setEditing] = useState(false)
  if (!d) return <div className="card muted">Loading…</div>
  const { listing: l, media, can_edit } = d
  const done = () => { reload(); onChange() }
  const save = e => { const b = formData(e); run(async () => { await api('/listings/' + l.id, { method: 'PATCH', body: b }); setEditing(false); done() }) }
  const setStatus = status => run(async () => { await api('/listings/' + l.id, { method: 'PATCH', body: { status } }); done() })
  const addPhotos = e => {
    const files = [...e.target.files]
    e.target.value = ''
    run(async () => { for (const f of files) await api('/media', { body: { entity: 'listing', entity_id: l.id, kind: 'photo', name: f.name, data: await shrinkImage(f) } }); reload(); onChange() })
  }
  const removePhoto = ph => confirm('Delete this photo?') && run(async () => { await api('/media/' + ph.id, { method: 'DELETE' }); done() })
  const share = `${l.purpose === 'Rent' ? 'For rent' : 'For sale'}: ${l.title || l.property_type}\n${[l.area, l.city].filter(Boolean).join(', ')}${l.size ? ` · ${+l.size} ${l.uom}` : ''}${l.bedrooms ? ` · ${l.bedrooms} bed` : ''}\nPKR ${pkr(l.price)}${l.purpose === 'Rent' ? ' /month' : ''}${l.features ? `\n${l.features}` : ''}${media.length ? '\n\nPhotos:\n' + media.map(p => location.origin + file(p.token)).join('\n') : ''}`
  return (
    <div className="card unit-panel">
      <div className="row between"><h3>{l.title || l.property_type}</h3><span className="status">{l.status}</span></div>
      <p className="muted">{l.purpose} · {l.property_type} · {[l.address, l.area, l.city].filter(Boolean).join(', ') || '—'}</p>
      <div className="inset left">
        <div className="line total"><span>{l.purpose === 'Rent' ? 'Rent / month' : 'Asking price'}</span><b>PKR {pkr(l.price)}</b></div>
        {l.size && <div className="line"><span>Size</span><b>{+l.size} {l.uom}</b></div>}
        {l.bedrooms != null && <div className="line"><span>Bedrooms</span><b>{l.bedrooms}</b></div>}
        {l.features && <div className="line"><span>Features</span><b>{l.features}</b></div>}
      </div>
      <div className="photos">
        {media.map(ph => (
          <figure key={ph.id}>
            <a href={file(ph.token)} target="_blank" rel="noreferrer"><img src={file(ph.token)} alt={ph.name || 'Photo'} /></a>
            {can_edit && <button className="ghost danger" onClick={() => removePhoto(ph)} aria-label="Delete photo">×</button>}
          </figure>
        ))}
        {can_edit && <label className="add-photo">{busy ? 'Uploading…' : '+ Photos'}<input type="file" accept="image/*" multiple onChange={addPhotos} disabled={busy} hidden /></label>}
      </div>
      <p>Owner: {l.owner_lead_id ? <a href={'#/leads/' + l.owner_lead_id}>{l.owner_name}</a> : '—'} {l.owner_phone && <span className="muted">· {phone(l.owner_phone)}</span>}</p>
      <p className="muted"><small>Agent {l.agent_name || '—'} · updated {fmt(l.updated_at)}</small></p>
      {l.notes && <p><small>{l.notes}</small></p>}
      <div className="actions">
        {can_edit && <Select value={l.status} onChange={e => setStatus(e.target.value)} options={m.settings.listing_statuses} blank={null} />}
        <a className="button ghost" href={'https://wa.me/?text=' + encodeURIComponent(share)} target="_blank" rel="noreferrer">Share on WhatsApp</a>
        {can_edit && <button className="ghost" onClick={() => setEditing(!editing)}>{editing ? 'Cancel edit' : 'Edit'}</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {editing && <form className="grid" onSubmit={save}><ListingFields l={l} /><div className="wide"><button disabled={busy}>Save</button></div></form>}
    </div>
  )
}
