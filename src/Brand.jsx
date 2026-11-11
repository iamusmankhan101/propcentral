import { useState } from 'react'
import { api, useApi, useAction, formData, shrinkImage } from './api.js'
import defaultLogo from './assets/logo.png'

// What each company prints at the top of letters, receipts and forms. Falls back to the Estate Centric
// header until a company fills in its own, so older workspaces keep printing exactly what they did.
export const brandName = b => b?.name || 'Estate Centric'

export function Letterhead({ brand, children }) {
  const b = brand || {}
  const contact = [b.address, b.phone, b.email, b.website].filter(Boolean).join(' · ')
  return (
    <header className="row between">
      <div className="brand-head">
        {b.logo || !b.name ? <img src={b.logo || defaultLogo} alt={brandName(b)} /> : null}
        {b.name && <b className="brand-name">{b.name}</b>}
        {b.tagline && <small>{b.tagline}</small>}
        {contact && <small>{contact}</small>}
      </div>
      {children}
    </header>
  )
}

// Settings > Letterhead & receipts: shared by every user of the company, edited by roles with the settings permission
export function BrandSettings() {
  const [b, reload] = useApi('/brand')
  const { run, error, busy } = useAction()
  const [logo, setLogo] = useState(undefined) // undefined = unchanged, '' = removed
  const [ok, setOk] = useState(false)
  if (!b) return <p className="muted">Loading…</p>
  const shown = logo === undefined ? b.logo : logo
  const pick = async e => {
    const f = e.target.files[0]; if (!f) return
    run(async () => { setLogo(await shrinkImage(f, 400)); setOk(false) })
  }
  const save = e => {
    const v = formData(e)
    run(async () => { await api('/brand', { method: 'PUT', body: { ...v, logo: shown || '' } }); setLogo(undefined); setOk(true); reload() })
  }
  const preview = { ...b, logo: shown }
  return (
    <form className="card grid" onSubmit={save} onChange={() => setOk(false)}>
      <p className="muted wide">This letterhead is printed on allotment letters, booking forms, payment receipts, rent receipts and the customer portal for your company only.</p>
      <label>Company name<input name="name" defaultValue={b.name} maxLength={120} placeholder="Your company name" /></label>
      <label>Tagline (optional)<input name="tagline" defaultValue={b.tagline} maxLength={160} /></label>
      <label className="wide">Address<input name="address" defaultValue={b.address} maxLength={240} /></label>
      <label>Phone<input name="phone" defaultValue={b.phone} maxLength={60} /></label>
      <label>Email<input name="email" defaultValue={b.email} maxLength={120} /></label>
      <label>Website<input name="website" defaultValue={b.website} maxLength={120} /></label>
      <label>Signatory title (printed under the signature line)<input name="signatory" defaultValue={b.signatory} maxLength={80} placeholder="e.g. Sales Director" /></label>
      <label className="wide">Footer note<textarea name="footer" rows={2} defaultValue={b.footer} maxLength={300} placeholder="e.g. Valid only with the company stamp and an authorised signature." /></label>
      <div className="wide">
        <label>Logo (PNG, JPG or WebP)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={pick} /></label>
        {shown && <p><button type="button" className="ghost" onClick={() => setLogo('')}>Remove logo</button></p>}
      </div>
      <div className="wide">
        <small className="muted">Preview</small>
        <div className="card letter" style={{ margin: 0 }}><Letterhead brand={preview}><div className="right"><small>Receipt No.</small><b>RC-00001</b></div></Letterhead></div>
      </div>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Save letterhead</button>{ok && <span className="ok">Saved</span>}</div>
    </form>
  )
}
