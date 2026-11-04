import { lazy, Suspense, useState } from 'react'
import { api, useApi, useMeta, useAction, formData, fmt, pkr, phone } from './api.js'
import { Select } from './Leads.jsx'
import { inPolygon, areasAt, fitTransform, fitCorners } from '../server/lib.js'
const PropertyMap = lazy(() => import('./PropertyMap.jsx')) // map library loads only on this page
import logoImg from './assets/logo.png'

export const STATUS_COLOR = { Let: '#1f9e5a', Ending: '#e8a10e', 'Ending soon': '#d92d20', 'Rent overdue': '#d92d20', Vacant: '#2f6fdb' }
const KINDS = ['House', 'Upper portion', 'Lower portion', 'Apartment', 'Plot', 'Shop', 'Office', 'Building', 'Farmhouse', 'Other']
const UOMS = ['marla', 'kanal', 'sqft', 'sqyd']
const STATUSES = ['Let', 'Ending', 'Ending soon', 'Rent overdue', 'Vacant']
const today = () => new Date().toLocaleDateString('en-CA')
const rs = n => 'PKR ' + Number(n || 0).toLocaleString('en-PK')
const prefix = (word, v) => v && (new RegExp('^' + word, 'i').test(v) ? v : `${word} ${v}`) // "6" → "Phase 6", "Phase 6" stays
export const propLabel = p => p.title || [p.society, prefix('Phase', p.phase), prefix('Block', p.block), p.number && `#${p.number}`].filter(Boolean).join(' · ') || `Property ${p.id}`
const Dot = ({ s }) => <span className="status-dot" style={{ background: STATUS_COLOR[s] }} title={s} />
const Call = ({ c }) => c?.phone && !c.phone.includes('*')
  ? <span className="row"><a className="button" href={'tel:+' + c.phone}>Call</a><a className="button ghost" href={'https://wa.me/' + c.phone} target="_blank" rel="noreferrer">WhatsApp</a></span> : null

export default function Properties() {
  const m = useMeta()
  const [rows, reload] = useApi('/properties')
  const [areas, reloadAreas] = useApi('/areas')
  const [overlaysSaved, reloadOverlays] = useApi('/overlays')
  const [opacity, setOpacity] = useState({}) // live slider values before they're saved
  const overlays = overlaysSaved?.map(o => ({ ...o, opacity: opacity[o.id] ?? o.opacity }))
  const [view, setView] = useState('map')
  const [city, setCity] = useState('Lahore')
  const [mapMode, setMapMode] = useState('2d')
  const [mapBearing, setMapBearing] = useState(0)
  const [showMapTools, setShowMapTools] = useState(false)
  const [layer, setLayer] = useState('properties')
  const [f, setF] = useState({ status: '', area: '', q: '' })
  const [sel, setSel] = useState(null)
  const [selArea, setSelArea] = useState(null)
  const [selOverlay, setSelOverlay] = useState(null)
  const [placing, setPlacing] = useState(null) // { mode: 'pin' | 'outline', target: 'new' | 'property' | 'plot' | 'area' | 'area-redraw' }
  const [draft, setDraft] = useState(null) // { kind: 'property', lat, lng } or { kind: 'area', outline } waiting for its form
  const { run, error } = useAction()
  const set = k => e => setF({ ...f, [k]: e.target.value })
  const area = areas?.find(a => a.id === +f.area)
  const shown = (rows || []).filter(p => (!city || (p.city || 'Lahore') === city) && (!f.status || p.status === f.status) && (!area || (p.lat != null && inPolygon([p.lng, p.lat], area.outline)))
    && (!f.q || [propLabel(p), p.owner_name, p.lease?.tenant_name, p.address].join(' ').toLowerCase().includes(f.q.toLowerCase())))
  const counts = (rows || []).reduce((c, p) => ({ ...c, [p.status]: (c[p.status] || 0) + 1 }), {})
  const hasMap = !!m.maptiler_key
  const mapFull = !draft && (view === 'map' || layer === 'societies')
  const startAdd = () => { setSel(null); setLayer('properties'); if (hasMap) { setView('map'); setPlacing({ mode: 'pin', target: 'new' }) } else setDraft({ kind: 'property' }) }
  const startDrawSociety = () => { setLayer('societies'); setView('map'); setSelArea(null); setDraft(null); setPlacing({ mode: 'outline', target: 'area' }) }
  const place = pos => {
    const t = placing.target
    if (t === 'new') { setPlacing(null); return setDraft({ kind: 'property', city, lat: pos.lat, lng: pos.lng }) }
    if (t === 'area') { setPlacing(null); return setDraft({ kind: 'area', outline: pos.outline }) }
    if (t === 'overlay') return run(async () => { // corners dragged by hand, or moved by the transform the matched points describe
      const o = overlays.find(x => x.id === placing.id)
      await api('/overlays/' + o.id, { method: 'PATCH', body: { corners: pos.corners || o.corners.map(fitTransform(pos.pairs)) } })
      setPlacing(null); reloadOverlays()
    })
    run(async () => {
      if (t === 'area-redraw') { await api('/areas/' + selArea, { method: 'PATCH', body: { outline: pos.outline } }); reloadAreas() }
      else await api('/properties/' + sel, { method: 'PATCH', body: t === 'plot' ? pos : { lat: pos.lat, lng: pos.lng } })
      setPlacing(null); reload()
    })
  }
  const overlayAction = (action, value) => {
    const o = overlays?.find(x => x.id === selOverlay)
    if (!o) return
    if (action === 'close') return setSelOverlay(null)
    if (action === 'adjust' || action === 'match') {
      setSelOverlay(null); setShowMapTools(false); setView('map'); setLayer('societies'); setPlacing({ mode: action, target: 'overlay', id: o.id }); return
    }
    if (action === 'delete') {
      if (!confirm(`Delete the ${o.name} map image?`)) return
      return run(async () => { await api('/overlays/' + o.id, { method: 'DELETE' }); setSelOverlay(null); reloadOverlays() })
    }
    if (action === 'reset') {
      const areaForOverlay = areas?.find(a => a.id === o.area_id) || areas?.find(a => a.kind === 'Society') || areas?.[0]
      if (!areaForOverlay) return
      return run(async () => { await api('/overlays/' + o.id, { method: 'PATCH', body: { corners: fitCorners(areaForOverlay.outline, o.width || 1, o.height || 1) } }); reloadOverlays() })
    }
    if (action === 'redraw') {
      const areaForOverlay = areas?.find(a => a.id === o.area_id)
      if (!areaForOverlay) return
      setSelOverlay(null); setLayer('societies'); setSelArea(areaForOverlay.id); setView('map'); setPlacing({ mode: 'outline', target: 'area-redraw' }); return
    }
    if (action === 'toggle' || action === 'opacity') {
      return run(async () => { await api('/overlays/' + o.id, { method: 'PATCH', body: action === 'toggle' ? { visible: false } : { opacity: value } }); if (action === 'toggle') setSelOverlay(null); reloadOverlays() })
    }
  }
  const panel = draft?.kind === 'property' ? <NewProperty at={draft} areas={areas || []} onCancel={() => setDraft(null)} onDone={id => { setDraft(null); reload(); setSel(id) }} />
    : draft?.kind === 'area' ? <NewArea outline={draft.outline} onCancel={() => setDraft(null)} onDone={id => { setDraft(null); reloadAreas(); reload(); setSelArea(id) }} />
      : layer === 'societies' ? <Societies areas={areas || []} rows={rows || []} sel={selArea} onSel={setSelArea} placing={placing}
        onDraw={startDrawSociety}
        onRedraw={() => setPlacing({ mode: 'outline', target: 'area-redraw' })}
        onShow={a => { setF({ ...f, area: String(a.id) }); setLayer('properties') }}
        onChange={() => { reloadAreas(); reload() }}
        maps={<SocietyMaps overlays={overlays || []} areas={areas || []} area={areas?.find(a => a.id === selArea)} placing={placing} reload={reloadOverlays}
          setOpacity={(id, v) => setOpacity({ ...opacity, [id]: v })} onAlign={(o, mode) => { setView('map'); setPlacing({ mode, target: 'overlay', id: o.id }) }} />} />
        : sel ? <PropertyPanel id={sel} key={sel + String(rows?.length)} placing={placing} onPlace={target => { setView('map'); setPlacing({ mode: target === 'plot' ? 'outline' : 'pin', target }) }} />
          : <div className="card muted">{hasMap ? 'Click a pin to see the owner, tenant and lease. Use “Add property” and click the map to add one.' : 'Select a property to see the owner, tenant and lease.'}</div>
  return (
    <section className={mapFull ? 'properties-map-screen' : ''}>
      {!mapFull && <>
      <div className="row between">
        <h2>Properties {rows && <span className="count">{rows.length}</span>}</h2>
        <div className="row">
          <div className="seg small">{[['properties', 'Properties'], ['societies', 'Societies']].map(([k, l]) => <button key={k} className={layer === k ? 'on' : ''} onClick={() => { setLayer(k); setPlacing(null); setDraft(null) }}>{l}</button>)}</div>
          {layer === 'properties' && <div className="seg small">{[['map', 'Map'], ['list', 'List']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</div>}
          {layer === 'properties' && <button onClick={startAdd} disabled={!!placing}>+ Add property</button>}
        </div>
      </div>
      {layer === 'properties' && <div className="filters">
        <input placeholder="Search address, owner, tenant" value={f.q} onChange={set('q')} />
        <Select value={f.area} onChange={set('area')} options={(areas || []).slice().sort((x, y) => x.name.localeCompare(y.name)).map(a => [a.id, `${a.name} (${a.kind.toLowerCase()})`])} blank="All areas" />
        <div className="seg small status-filter">
          <button className={!f.status ? 'on' : ''} onClick={() => setF({ ...f, status: '' })}>All</button>
          {STATUSES.map(s => <button key={s} className={f.status === s ? 'on' : ''} onClick={() => setF({ ...f, status: f.status === s ? '' : s })}><Dot s={s} />{s} {counts[s] || 0}</button>)}
        </div>
      </div>}
      {error && <p className="error">{error}</p>}
      </>}
      <div className={'inv' + (mapFull ? ' map-inv full-map' : '')}>
        {view === 'map' || layer === 'societies'
          ? <Suspense fallback={<div className="prop-map" />}><PropertyMap rows={shown} areas={areas} overlays={overlays} layer={layer} city={city} mode={mapMode} bearing={mapBearing} onCity={setCity} onMode={setMapMode} sel={sel} selArea={selArea} selectedOverlay={overlays?.find(o => o.id === selOverlay)} onSelect={id => { setSelOverlay(null); setDraft(null); setSel(id) }}
            onSelectArea={id => { setSelOverlay(null); setSelArea(id) }} onSelectOverlay={id => { setSel(null); setSelOverlay(id) }} onOverlayAction={overlayAction} placing={placing} onPlace={place} onCancel={() => setPlacing(null)} clean={mapFull} /></Suspense>
          : <div className="card scroll">
            <table>
              <thead><tr><th></th><th>Property</th><th>Owner</th><th>Tenant</th><th>Rent</th><th>Lease ends</th><th>Overdue</th></tr></thead>
              <tbody>
                {shown.map(p => (
                  <tr key={p.id} className={'clickable' + (sel === p.id ? ' sel' : '')} onClick={() => { setDraft(null); setSel(p.id) }}>
                    <td><Dot s={p.status} /></td>
                    <td><b>{propLabel(p)}</b><small className="muted"><br />{p.kind}{p.size ? ` · ${+p.size} ${p.uom}` : ''}{p.managed ? ' · managed' : ''}{p.lat == null ? ' · not on map' : ''}</small></td>
                    <td>{p.owner_name || '—'}</td>
                    <td>{p.lease?.tenant_name || <span className="muted">Vacant</span>}</td>
                    <td className="nowrap">{p.lease ? pkr(p.lease.rent) : '—'}</td>
                    <td className="nowrap">{p.lease ? <>{p.lease.end_date}<small className="muted"><br />{p.lease.days_left < 0 ? `${-p.lease.days_left} days ago` : `${p.lease.days_left} days`}</small></> : '—'}</td>
                    <td className={'nowrap' + (p.lease?.overdue ? ' error' : '')}>{p.lease?.overdue ? pkr(p.lease.overdue) : '—'}</td>
                  </tr>
                ))}
                {rows && !shown.length && <tr><td colSpan="7" className="muted">{rows.length ? 'No properties match.' : 'No properties yet. Use “Add property”.'}</td></tr>}
              </tbody>
            </table>
          </div>}
        {!mapFull && <div className="inv-panel">{panel}</div>}
      </div>
      {mapFull && <MapBottomNav layer={layer} view={view} city={city} mode={mapMode} onLayer={k => { setLayer(k); setPlacing(null); setDraft(null); setShowMapTools(false) }} onView={setView} onCity={setCity} onMode={setMapMode} onRotate={delta => setMapBearing(b => (b + delta + 360) % 360)} onAdd={startAdd} onDraw={startDrawSociety} onUpload={() => setShowMapTools(true)} disabled={!!placing} />}
      {mapFull && layer === 'societies' && showMapTools && <div className="map-tools-panel">
        <button className="map-tools-close" onClick={() => setShowMapTools(false)} aria-label="Close map tools">×</button>
        <SocietyMaps overlays={overlays || []} areas={areas || []} area={areas?.find(a => a.id === selArea)} placing={placing} reload={reloadOverlays}
          setOpacity={(id, v) => setOpacity({ ...opacity, [id]: v })} onAlign={(o, mode) => { setShowMapTools(false); setView('map'); setPlacing({ mode, target: 'overlay', id: o.id }) }} />
      </div>}
    </section>
  )
}

function MapBottomNav({ layer, view, city, mode, onLayer, onView, onCity, onMode, onRotate, onAdd, onDraw, onUpload, disabled }) {
  return <div className="map-bottom-nav">
    <button className={layer === 'properties' ? 'on' : ''} onClick={() => onLayer('properties')}>Properties</button>
    <button className={layer === 'societies' ? 'on' : ''} onClick={() => onLayer('societies')}>Societies</button>
    <span className="map-nav-divider" />
    <label>Location<select value={city} onChange={e => onCity(e.target.value)}><option>Lahore</option><option>Dubai</option></select></label>
    <button className={mode === '2d' ? 'on' : ''} onClick={() => onMode('2d')}>2D</button>
    <button className={mode === '3d' ? 'on' : ''} onClick={() => onMode('3d')}>3D</button>
    <button className="rotate-button" onClick={() => onRotate(-30)} title="Rotate left" aria-label="Rotate left">↺</button><button className="rotate-button" onClick={() => onRotate(30)} title="Rotate right" aria-label="Rotate right">↻</button>
    {layer === 'properties' ? <button onClick={onAdd} disabled={disabled}>+ Add property</button> : <><button onClick={onDraw} disabled={disabled}>+ Add society</button><button onClick={onUpload} disabled={disabled}>Upload map</button></>}
    <button className={view === 'list' ? 'on' : ''} onClick={() => onView('list')}>List</button>
  </div>
}

function PropertyPanel({ id, onPlace, placing }) {
  const [d] = useApi('/properties/' + id)
  if (!d) return <div className="card muted">Loading…</div>
  const { property: p, owner, lease, status } = d
  return (
    <div className="card unit-panel">
      <div className="row between"><h3>{propLabel(p)}</h3><span className="status" style={{ background: STATUS_COLOR[status], color: '#fff' }}>{status}</span></div>
      <p className="muted">{p.kind}{p.size ? ` · ${+p.size} ${p.uom}` : ''}{p.bedrooms ? ` · ${p.bedrooms} bed` : ''}{p.address ? ` · ${p.address}` : ''}</p>
      <div className="inset left">
        <div className="line"><span>Owner</span><b>{owner?.name || '—'}</b></div>
        {owner && <Call c={owner} />}
      </div>
      <div className="inset left">
        {lease ? <>
          <div className="line"><span>Tenant</span><b>{lease.tenant?.name}</b></div>
          <Call c={lease.tenant} />
          <div className="line"><span>Rent</span><b>{rs(lease.schedule.at(-1)?.amount ?? lease.rent)} / month</b></div>
          <div className="line"><span>Lease ends</span><b className={lease.days_left <= 30 ? 'error' : lease.days_left <= 90 ? 'warn' : ''}>{lease.end_date} ({lease.days_left < 0 ? `${-lease.days_left} days ago` : `${lease.days_left} days`})</b></div>
          {lease.overdue > 0 && <div className="line"><span>Rent overdue</span><b className="error">{rs(lease.overdue)}</b></div>}
        </> : <div className="line"><span>Tenant</span><b>Vacant</b></div>}
      </div>
      <div className="actions">
        <a className="button" href={'#/properties/' + p.id}>Open property</a>
        {d.can_edit && !placing && <button className="ghost" onClick={() => onPlace('property')}>{p.lat != null ? 'Move pin' : 'Put on map'}</button>}
        {d.can_edit && !placing && <button className="ghost" onClick={() => onPlace('plot')}>{p.outline ? 'Redraw plot outline' : 'Draw plot outline'}</button>}
      </div>
    </div>
  )
}

function PropertyFields({ p = {} }) {
  const { settings: s, users } = useMeta()
  return <>
    <label>Type<Select name="kind" options={KINDS} defaultValue={p.kind || 'House'} blank={null} /></label>
    <label>Society / area<input name="society" list="society-list" defaultValue={p.society} placeholder="DHA, Bahria Town…" /></label>
    <datalist id="society-list">{s.societies.map(x => <option key={x} value={x} />)}</datalist>
    <label>Phase<input name="phase" defaultValue={p.phase} /></label>
    <label>Block / sector<input name="block" defaultValue={p.block} /></label>
    <label>Street<input name="street" defaultValue={p.street} /></label>
    <label>House / plot no.<input name="number" defaultValue={p.number} /></label>
    <label className="wide">Title (optional)<input name="title" defaultValue={p.title} placeholder="e.g. Upper portion, 1 Kanal house near Jalal Sons" /></label>
    <label>Size<input name="size" type="number" min="0" step="any" defaultValue={p.size} /></label>
    <label>Unit<Select name="uom" options={UOMS} defaultValue={p.uom || 'marla'} blank={null} /></label>
    <label>Bedrooms<input name="bedrooms" type="number" min="0" defaultValue={p.bedrooms} /></label>
    <label>Agent<Select name="agent_id" options={users.filter(u => u.active).map(u => [u.id, u.name])} defaultValue={p.agent_id} blank="Me" /></label>
    <label className="check"><input name="managed" type="checkbox" defaultChecked={!!p.managed} /> We manage it (collect rent for the owner)</label>
    <label>Management fee %<input name="mgmt_fee_pct" type="number" min="0" max="50" step="0.1" defaultValue={p.mgmt_fee_pct} placeholder="e.g. 5" /></label>
    <label className="wide">Notes<input name="notes" defaultValue={p.notes} /></label>
  </>
}
const packProperty = b => ({ ...b, managed: !!b.managed, owner: b.owner_phone ? { name: b.owner_name, phone: b.owner_phone, cnic: b.owner_cnic } : undefined })

// Short form in the side panel after clicking the map: the society / phase / block come from the areas the click fell in
function NewProperty({ at, areas, onDone, onCancel }) {
  const { run, error, busy } = useAction()
  const where = at.lat != null ? areasAt([at.lng, at.lat], areas) : {}
  const submit = e => { const b = packProperty(formData(e)); run(async () => onDone((await api('/properties', { body: { ...b, lat: at.lat, lng: at.lng } })).id)) }
  return (
    <form className="card new-prop" onSubmit={submit}>
      <h3>New property</h3>
      <p className="muted">{at.lat != null ? (Object.values(where).join(' · ') || 'Outside the drawn societies. Type the area below, or draw it under Societies.') : 'Not placed on the map.'}</p>
      <div className="two">
        <label>City<Select name="city" options={['Lahore', 'Dubai']} defaultValue={at.city || 'Lahore'} blank={null} /></label>
        <label>Society<input name="society" list="society-list" defaultValue={where.society} /></label>
        <label>Phase<input name="phase" defaultValue={where.phase} /></label>
        <label>Block<input name="block" defaultValue={where.block} /></label>
        <label>House / plot no.<input name="number" required autoFocus /></label>
        <label>Type<Select name="kind" options={KINDS} blank={null} /></label>
        <label>Street<input name="street" /></label>
        <label>Size<input name="size" type="number" min="0" step="any" /></label>
        <label>Unit<Select name="uom" options={UOMS} blank={null} /></label>
        <label>Owner name<input name="owner_name" /></label>
        <label>Owner phone<input name="owner_phone" placeholder="0300 1234567" /></label>
      </div>
      <label className="check"><input name="managed" type="checkbox" /> We collect rent for the owner</label>
      <datalist id="society-list">{[...new Set(areas.filter(a => a.kind === 'Society').map(a => a.name))].map(x => <option key={x} value={x} />)}</datalist>
      {error && <p className="error">{error}</p>}
      <div className="row"><button disabled={busy}>Save property</button><button type="button" className="ghost" onClick={onCancel}>Cancel</button></div>
      <small className="muted">Bedrooms, management fee, agent and notes are on the property page.</small>
    </form>
  )
}

// Societies tab: drawn societies / phases / blocks, what's inside each, and tools to draw, rename, redraw, delete
function Societies({ areas, rows, sel, onSel, placing, onDraw, onRedraw, onShow, onChange, maps }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const manage = m.can('properties') || m.can('settings')
  const inside = a => rows.filter(p => p.lat != null && inPolygon([p.lng, p.lat], a.outline))
  const a = areas.find(x => x.id === sel)
  if (a) {
    const ps = inside(a), by = s => ps.filter(p => p.status === s).length
    const rename = () => { const name = prompt(`Rename ${a.name}`, a.name); if (name?.trim()) run(async () => { await api('/areas/' + a.id, { method: 'PATCH', body: { name } }); onChange() }) }
    const remove = () => confirm(`Delete the ${a.name} boundary? Properties keep their society / phase / block names.`) && run(async () => { await api('/areas/' + a.id, { method: 'DELETE' }); onSel(null); onChange() })
    return (
      <div className="card unit-panel">
        <a href="#" className="muted" onClick={e => { e.preventDefault(); onSel(null) }}>← All areas</a>
        <div className="row between"><h3>{a.name}</h3><span className="count">{a.kind}</span></div>
        <div className="inset left">
          <div className="line"><span>Properties</span><b>{ps.length}</b></div>
          {STATUSES.map(s => by(s) > 0 && <div key={s} className="line"><span><Dot s={s} /> {s}</span><b>{by(s)}</b></div>)}
          <div className="line"><span>Owners</span><b>{new Set(ps.map(p => p.owner_contact_id).filter(Boolean)).size}</b></div>
          <div className="line"><span>Rent overdue</span><b className={ps.some(p => p.lease?.overdue) ? 'error' : ''}>{rs(ps.reduce((s, p) => s + (p.lease?.overdue || 0), 0))}</b></div>
        </div>
        {areas.filter(x => x.id !== a.id && inPolygon(centre(x.outline), a.outline)).length > 0 && (
          <p className="muted">Inside: {areas.filter(x => x.id !== a.id && inPolygon(centre(x.outline), a.outline)).map(x => <a key={x.id} href="#" onClick={e => { e.preventDefault(); onSel(x.id) }}>{x.name}</a>).reduce((acc, el, i) => i ? [...acc, ', ', el] : [el], [])}</p>
        )}
        <div className="actions">
          <button onClick={() => onShow(a)} disabled={!ps.length}>Show its properties</button>
          {manage && !placing && <><button className="ghost" onClick={rename}>Rename</button><button className="ghost" onClick={onRedraw}>Redraw boundary</button><button className="ghost danger" onClick={remove} disabled={busy}>Delete</button></>}
        </div>
        {error && <p className="error">{error}</p>}
        {maps}
      </div>
    )
  }
  const kinds = ['Society', 'Phase', 'Block']
  return (
    <>
    <div className="card">
      <div className="row between"><h3>Societies</h3>{manage && <button onClick={onDraw} disabled={!!placing}>+ Draw area</button>}</div>
      <p className="muted">Draw each society's boundary on the map, then its phases and blocks inside it. Properties dropped inside get their society, phase and block automatically.</p>
      {kinds.map(k => areas.some(x => x.kind === k) && (
        <div key={k}>
          <h4>{k === 'Society' ? 'Societies' : k + 's'}</h4>
          {areas.filter(x => x.kind === k).sort((x, y) => x.name.localeCompare(y.name)).map(x => (
            <a key={x.id} href="#" className="line-item" onClick={e => { e.preventDefault(); onSel(x.id) }}><span>{x.name}</span><b>{inside(x).length}</b></a>
          ))}
        </div>
      ))}
      {!areas.length && <p className="muted">No areas yet.{manage ? ' Click “Draw area”, then click around DHA (or any society) corner by corner.' : ''}</p>}
    </div>
    <div className="card">{maps}</div>
    </>
  )
}

// Society map images (a phase plan, a block map) laid over the satellite: upload → auto-fitted to the boundary → align by matching points
const LAHORE_BOX = [[74.33, 31.51], [74.35, 31.51], [74.35, 31.53], [74.33, 31.53]]
const readMapImage = file => new Promise((ok, fail) => { // keeps it under 4096px, the safe texture size for phones and laptops
  const img = new Image()
  img.onload = () => {
    const k = Math.min(1, 4096 / Math.max(img.width, img.height))
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) })
    const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height)
    URL.revokeObjectURL(img.src)
    ok({ data: c.toDataURL('image/png'), width: c.width, height: c.height })
  }
  img.onerror = () => fail(new Error(file.type === 'application/pdf' ? 'PDFs can\'t be placed directly. Open the PDF, export or screenshot the map as a JPG/PNG, and upload that.' : `${file.name} is not an image`))
  img.src = URL.createObjectURL(file)
})
function SocietyMaps({ overlays, areas, area, placing, reload, setOpacity, onAlign }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const manage = m.can('properties') || m.can('settings')
  const shown = area ? overlays.filter(o => o.area_id === area.id) : overlays
  const fallback = area || areas.find(a => a.kind === 'Society') || areas[0] // never drop a plan in the middle of nowhere
  const fitRing = o => (areas.find(a => a.id === o.area_id) || fallback)?.outline || LAHORE_BOX
  const areaOpts = areas.map(a => [a.id, `${a.name} (${a.kind.toLowerCase()})`])
  const moveTo = (o, id) => { const a = areas.find(x => x.id === +id); if (a) patchO(o, { area_id: a.id, corners: fitCorners(a.outline, o.width || 1, o.height || 1) }) }
  const upload = e => {
    const form = e.target, b = formData(e), file = form.file.files[0], target = areas.find(a => a.id === +b.area_id) || fallback
    run(async () => {
      const img = await readMapImage(file)
      await api('/overlays', { body: { ...img, name: b.name || target?.name || file.name.replace(/\.\w+$/, ''), area_id: target?.id, corners: fitCorners(target?.outline || LAHORE_BOX, img.width, img.height) } })
      form.reset(); reload()
    })
  }
  const patchO = (o, body) => run(async () => { await api('/overlays/' + o.id, { method: 'PATCH', body }); reload() })
  const remove = o => confirm(`Delete the ${o.name} map image?`) && run(async () => { await api('/overlays/' + o.id, { method: 'DELETE' }); reload() })
  return (
    <div className="society-maps">
      <h4>Society maps {shown.length > 0 && <span className="count">{shown.length}</span>}</h4>
      {shown.map(o => (
        <div key={o.id} className="society-map">
          <div className="row between">
            <label className="check"><input type="checkbox" checked={o.visible} onChange={e => patchO(o, { visible: e.target.checked })} /> <b>{o.name}</b></label>
            {manage && !placing && <span className="row nowrap">
              <button className="ghost" onClick={() => onAlign(o, 'adjust')} disabled={!o.visible} title="Drag, resize and turn with the mouse">Adjust by hand</button>
              <button className="ghost" onClick={() => onAlign(o, 'match')} disabled={!o.visible} title="Click matching spots on the plan and the satellite">Match points</button>
              <button className="ghost danger" onClick={() => remove(o)} disabled={busy} aria-label={'Delete ' + o.name}>×</button>
            </span>}
          </div>
          {o.visible && <label className="check"><input type="checkbox" checked={o.clear_white} onChange={e => patchO(o, { clear_white: e.target.checked })} disabled={!manage} /> Remove all white background</label>}
          {o.visible && <label className="opacity">See-through<input type="range" min="0.1" max="1" step="0.05" value={o.opacity}
            onChange={e => setOpacity(o.id, +e.target.value)} onPointerUp={e => manage && patchO(o, { opacity: +e.target.value })} onKeyUp={e => manage && patchO(o, { opacity: +e.target.value })} /></label>}
          {manage && !placing && areas.length > 0 && <label className="opacity">Over<Select value={o.area_id ?? ''} onChange={e => moveTo(o, e.target.value)} options={areaOpts} blank="Choose a boundary…" /></label>}
          {manage && !placing && <button className="link" onClick={() => patchO(o, { corners: fitCorners(fitRing(o), o.width || 1, o.height || 1) })}>Reset: fit to {areas.find(a => a.id === o.area_id)?.name || fallback?.name || 'boundary'} again</button>}
        </div>
      ))}
      {!shown.length && <p className="muted">Upload a society or phase plan (JPG/PNG) to see plot lines over the satellite.</p>}
      {manage && !placing && (
        <form className="allot-form" onSubmit={upload}>
          <input name="file" type="file" accept="image/*,application/pdf" required />
          <div className="row">
            {areas.length > 0
              ? <Select name="area_id" options={areaOpts} defaultValue={fallback?.id} blank={null} />
              : <span className="muted">Draw the society boundary first so the plan lands in the right place.</span>}
            <input name="name" placeholder="Name (e.g. DHA Phase 6 plan)" />
          </div>
          <button disabled={busy}>{busy ? 'Uploading…' : 'Upload & place'}</button>
          <small className="muted">It's fitted over the boundary you pick. Then <b>Adjust by hand</b> (drag, resize, turn) or <b>Match points</b> (click 2–4 matching spots, e.g. roundabouts).</small>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
const centre = ring => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length]

function NewArea({ outline, onDone, onCancel }) {
  const { run, error, busy } = useAction()
  const submit = e => { const b = formData(e); run(async () => onDone((await api('/areas', { body: { ...b, outline } })).id)) }
  return (
    <form className="card new-prop" onSubmit={submit}>
      <h3>Name this area</h3>
      <label>Type<Select name="kind" options={[['Society', 'Society (e.g. DHA, Bahria Town)'], ['Phase', 'Phase (e.g. Phase 6)'], ['Block', 'Block / sector (e.g. Block K)']]} blank={null} /></label>
      <label>Name<input name="name" required autoFocus placeholder="e.g. DHA" /></label>
      {error && <p className="error">{error}</p>}
      <div className="row"><button disabled={busy}>Save area</button><button type="button" className="ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  )
}

// Full property page: details, owner, current lease + rent ledger, history, maintenance, owner statement
export function PropertyPage({ id }) {
  const [d, reload, loadError] = useApi('/properties/' + id)
  const [editing, setEditing] = useState(false)
  if (loadError) return <p className="error">{loadError}</p>
  if (!d) return <p className="muted">Loading…</p>
  const { property: p, owner, lease, status, statement } = d
  return (
    <section>
      <div className="row between">
        <div>
          <a href="#/properties" className="muted">← All properties</a>
          <h2>{propLabel(p)} <span className="status" style={{ background: STATUS_COLOR[status], color: '#fff' }}>{status}</span></h2>
          <p className="muted">{p.kind}{p.size ? ` · ${+p.size} ${p.uom}` : ''}{p.bedrooms ? ` · ${p.bedrooms} bed` : ''} · {p.city}{p.managed ? ` · managed${p.mgmt_fee_pct ? ` (${+p.mgmt_fee_pct}% fee)` : ''}` : ''}</p>
        </div>
        {d.can_edit && <button className="ghost" onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit details'}</button>}
      </div>
      {editing && <EditProperty p={p} owner={owner} done={() => { setEditing(false); reload() }} />}
      <div className="cols">
        <div>
          {lease ? <Lease d={d} reload={reload} /> : d.can_edit ? <NewLease p={p} reload={reload} /> : <div className="card muted">Vacant.</div>}
          <Payments d={d} reload={reload} />
        </div>
        <div>
          <div className="card">
            <h3>Owner</h3>
            {owner ? <><p><b>{owner.name}</b><br /><small className="muted">{phone(owner.phone)}{owner.cnic && ` · CNIC ${owner.cnic}`}</small></p><Call c={owner} /></> : <p className="muted">No owner on record. Add one under Edit details.</p>}
          </div>
          {p.managed ? <OwnerStatement d={d} reload={reload} /> : null}
          <Maintenance d={d} reload={reload} />
          {d.history.length > 0 && (
            <div className="card">
              <h3>Past leases</h3>
              {d.history.map(l => <p key={l.id}><b>{l.tenant?.name}</b> · {l.start_date} → {l.ended_on || l.end_date} · {rs(l.rent)} <small className="muted">{l.status}{l.end_note && `: ${l.end_note}`}</small>{l.arrears > 0 && <small className="error"> · owes {rs(l.arrears)}</small>}</p>)}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function EditProperty({ p, owner, done }) {
  const { run, error, busy } = useAction()
  const submit = e => { const b = packProperty(formData(e)); run(async () => { await api('/properties/' + p.id, { method: 'PATCH', body: b }); done() }) }
  return (
    <form className="card grid" onSubmit={submit}>
      <PropertyFields p={p} />
      <label>Owner name<input name="owner_name" defaultValue={owner?.name} /></label>
      <label>Owner phone<input name="owner_phone" defaultValue={owner?.phone?.includes('*') ? '' : owner?.phone} placeholder={owner ? 'Leave empty to keep' : ''} /></label>
      <label>Owner CNIC<input name="owner_cnic" pattern="\d{5}-?\d{7}-?\d" /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide"><button disabled={busy}>Save</button></div>
    </form>
  )
}

function NewLease({ p, reload }) {
  const { run, error, busy } = useAction()
  const submit = e => {
    const b = formData(e)
    run(async () => { await api(`/properties/${p.id}/leases`, { body: { ...b, tenant: { name: b.tenant_name, phone: b.tenant_phone, cnic: b.tenant_cnic } } }); reload() })
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">New tenant</h3>
      <label>Tenant name *<input name="tenant_name" required /></label>
      <label>Tenant phone *<input name="tenant_phone" required /></label>
      <label>Tenant CNIC<input name="tenant_cnic" pattern="\d{5}-?\d{7}-?\d" /></label>
      <label>Monthly rent (PKR) *<input name="rent" type="number" min="1" required /></label>
      <label>Start *<input name="start_date" type="date" defaultValue={today()} required /></label>
      <label>End *<input name="end_date" type="date" required /></label>
      <label>Security deposit (PKR)<input name="deposit" type="number" min="0" /></label>
      <label>Yearly increase %<input name="increase_pct" type="number" min="0" max="100" step="0.5" defaultValue="10" /></label>
      <label>Police registration no.<input name="police_reg_no" placeholder="Tenant registration (Punjab)" /></label>
      <label>Agreement no.<input name="agreement_no" /></label>
      <p className="muted wide"><small>Rent falls due every month on the start date's day. Record advance rent as a rent payment and it covers the first months.</small></p>
      {error && <p className="error wide">{error}</p>}
      <div className="wide"><button disabled={busy}>Save lease</button></div>
    </form>
  )
}

const STATUS_CLS = { Paid: 'u-available', Partial: 'u-on-hold', Overdue: 'u-sold', Due: '' }
function Lease({ d, reload }) {
  const l = d.lease
  const { run, error, busy } = useAction()
  const [mode, setMode] = useState('')
  const renew = e => { const b = formData(e); run(async () => { await api(`/leases/${l.id}/renew`, { body: b }); setMode(''); reload() }) }
  const end = e => { const b = formData(e); run(async () => { await api(`/leases/${l.id}/end`, { body: b }); setMode(''); reload() }) }
  const save = e => { const b = formData(e); run(async () => { await api(`/leases/${l.id}`, { method: 'PATCH', body: b }); setMode(''); reload() }) }
  const shown = l.schedule.slice(-12).reverse()
  return (
    <div className="card">
      <div className="row between">
        <h3>Current lease</h3>
        {d.can_edit && <div className="seg small">{[['renew', 'Renew'], ['edit', 'Edit'], ['end', 'Tenant moved out']].map(([k, t]) => <button key={k} className={mode === k ? 'on' : ''} onClick={() => setMode(mode === k ? '' : k)}>{t}</button>)}</div>}
      </div>
      <p><b>{l.tenant?.name}</b> <small className="muted">{phone(l.tenant?.phone)}{l.tenant?.cnic && ` · CNIC ${l.tenant.cnic}`}</small></p>
      <Call c={l.tenant} />
      <div className="ledger-tiles">
        <div><small>Rent now</small><b>{rs(l.schedule.at(-1)?.amount ?? l.rent)}</b></div>
        <div><small>Ends</small><b className={l.days_left <= 30 ? 'error' : l.days_left <= 90 ? 'warn' : ''}>{l.end_date}</b></div>
        <div><small>Overdue</small><b className={l.overdue ? 'error' : ''}>{rs(l.overdue)}</b></div>
        <div><small>Next due</small><b>{l.next_due ? `${rs(l.next_due.amount)}` : '—'}</b></div>
      </div>
      <p className="muted"><small>{l.start_date} → {l.end_date} · {+l.increase_pct || 0}% yearly increase{l.deposit ? ` · deposit ${rs(l.deposit)}` : ''}{l.police_reg_no ? ` · police reg. ${l.police_reg_no}` : ' · police registration missing'}{l.agreement_no ? ` · agreement ${l.agreement_no}` : ''}</small></p>
      {mode === 'renew' && <form className="allot-form" onSubmit={renew}>
        <div className="row"><label>New end date<input name="end_date" type="date" required /></label><label>New monthly rent<input name="rent" type="number" min="1" defaultValue={l.schedule.at(-1)?.amount ?? l.rent} required /></label></div>
        <div className="row"><label>Yearly increase %<input name="increase_pct" type="number" min="0" max="100" step="0.5" defaultValue={l.increase_pct} /></label><label>Agreement no.<input name="agreement_no" /></label></div>
        <button disabled={busy}>Renew from {l.end_date}</button>
      </form>}
      {mode === 'edit' && <form className="allot-form" onSubmit={save}>
        <div className="row"><label>Police registration no.<input name="police_reg_no" defaultValue={l.police_reg_no} /></label><label>Agreement no.<input name="agreement_no" defaultValue={l.agreement_no} /></label></div>
        <div className="row"><label>Security deposit<input name="deposit" type="number" min="0" defaultValue={l.deposit} /></label><label>Notes<input name="notes" defaultValue={l.notes} /></label></div>
        <button disabled={busy}>Save</button>
      </form>}
      {mode === 'end' && <form className="allot-form" onSubmit={end}>
        <div className="row"><label>Move-out date<input name="ended_on" type="date" defaultValue={today()} required /></label><label>Note<input name="note" placeholder="e.g. deposit refunded, keys returned" /></label></div>
        <button className="danger-solid" disabled={busy}>End lease</button>
      </form>}
      {error && <p className="error">{error}</p>}
      <h4>Rent (last 12 months)</h4>
      <table><tbody>
        {shown.map(r => <tr key={r.due_date}><td className="nowrap">{r.due_date}</td><td className="nowrap">{rs(r.amount)}</td><td className="nowrap">{rs(r.paid)}</td><td><span className={'status ' + STATUS_CLS[r.status]}>{r.status}</span></td></tr>)}
        {!shown.length && <tr><td className="muted">First rent falls due on {l.start_date}.</td></tr>}
      </tbody></table>
    </div>
  )
}

const KIND_LABEL = { rent: 'Rent', deposit: 'Security deposit', deposit_refund: 'Deposit refund' }
function Payments({ d, reload }) {
  const { run, error, busy } = useAction()
  const record = e => {
    const form = e.target, b = formData(e)
    run(async () => { const r = await api(`/leases/${d.lease.id}/payments`, { body: b }); form.reset(); reload(); location.hash = '/rent-receipts/' + r.id })
  }
  const voidIt = r => { const note = prompt(`Void ${r.receipt_no} (${rs(r.amount)})?\n\nReason:`); if (note?.trim()) run(async () => { await api(`/rent-payments/${r.id}/void`, { body: { note } }); reload() }) }
  return (
    <div className="card scroll">
      <h3>Payments <span className="count">{d.payments.filter(r => !r.voided_at).length}</span></h3>
      {d.lease && d.can_money && (
        <form className="row" onSubmit={record}>
          <Select name="kind" options={Object.entries(KIND_LABEL)} blank={null} />
          <input name="amount" type="number" min="1" placeholder="Amount (PKR)" required style={{ width: 140 }} />
          <input name="paid_on" type="date" max={today()} defaultValue={today()} required aria-label="Date" />
          <Select name="method" options={d.methods} required blank="Method…" />
          <input name="ref" placeholder="Ref / cheque no." style={{ width: 140 }} />
          <button disabled={busy}>Save &amp; print receipt</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      <table>
        <tbody>
          {d.payments.map(r => (
            <tr key={r.id} className={r.voided_at ? 'voided' : ''} title={r.void_note ? 'Voided: ' + r.void_note : ''}>
              <td><a href={'#/rent-receipts/' + r.id}><b>{r.receipt_no}</b></a></td><td className="nowrap">{r.paid_on}</td><td>{KIND_LABEL[r.kind]}</td>
              <td>{r.method}{r.ref && <small className="muted"><br />{r.ref}</small>}</td><td className="nowrap">{r.kind === 'deposit_refund' ? '−' : ''}{rs(r.amount)}</td>
              <td>{d.can_money && !r.voided_at && <button className="ghost danger" onClick={() => voidIt(r)}>Void</button>}</td>
            </tr>
          ))}
          {!d.payments.length && <tr><td className="muted">No payments yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function Maintenance({ d, reload }) {
  const { run, error, busy } = useAction()
  const add = e => { const form = e.target, b = formData(e); run(async () => { await api(`/properties/${d.property.id}/maintenance`, { body: b }); form.reset(); reload() }) }
  const update = (m, body) => run(async () => { await api('/maintenance/' + m.id, { method: 'PATCH', body }); reload() })
  const done = m => { const cost = prompt(`Mark “${m.title}” done. Final cost (PKR)?`, m.cost || ''); if (cost !== null) update(m, { status: 'Done', cost: +cost || null }) }
  return (
    <div className="card">
      <h3>Maintenance <span className="count">{d.maintenance.filter(m => m.status !== 'Done').length} open</span></h3>
      {d.maintenance.map(m => (
        <div key={m.id} className="line-item">
          <span><b>{m.title}</b> <small className="muted">{m.status}{m.cost ? ` · ${rs(m.cost)} to ${m.charge_to.toLowerCase()}` : ''}{m.vendor ? ` · ${m.vendor}` : ''} · {fmt(m.created_at)}</small>{m.details && <><br /><small>{m.details}</small></>}</span>
          {d.can_edit && m.status !== 'Done' && <span className="row nowrap">{m.status === 'Open' && <button className="ghost" onClick={() => update(m, { status: 'In progress' })}>Start</button>}<button className="ghost" onClick={() => done(m)}>Done</button></span>}
        </div>
      ))}
      {d.can_edit && (
        <form className="allot-form" onSubmit={add}>
          <input name="title" placeholder="What needs fixing? e.g. Geyser not working" required />
          <div className="row"><input name="vendor" placeholder="Plumber / vendor" /><input name="cost" type="number" min="0" placeholder="Estimated cost" /><Select name="charge_to" options={['Owner', 'Tenant', 'Company']} blank={null} /></div>
          <button disabled={busy}>Add job</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function OwnerStatement({ d, reload }) {
  const s = d.statement
  const { run, error, busy } = useAction()
  const pay = e => { const form = e.target, b = formData(e); run(async () => { await api(`/properties/${d.property.id}/payouts`, { body: b }); form.reset(); reload() }) }
  return (
    <div className="card">
      <h3>Owner statement</h3>
      <div className="inset left">
        <div className="line"><span>Rent collected</span><b>{rs(s.collected)}</b></div>
        <div className="line"><span>Management fee ({+d.property.mgmt_fee_pct || 0}%)</span><b>− {rs(s.fee)}</b></div>
        <div className="line"><span>Maintenance charged to owner</span><b>− {rs(s.owner_costs)}</b></div>
        <div className="line"><span>Paid to owner</span><b>− {rs(s.paid_out)}</b></div>
        <div className="line total"><span>Owed to owner</span><b className={s.balance < 0 ? 'error' : ''}>{rs(s.balance)}</b></div>
      </div>
      {d.payouts.length > 0 && <p className="muted"><small>Payouts: {d.payouts.map(x => `${x.paid_on} ${rs(x.amount)}`).join(' · ')}</small></p>}
      {d.can_money && s.balance > 0 && (
        <form className="row" onSubmit={pay}>
          <input name="amount" type="number" min="1" defaultValue={s.balance} required style={{ width: 140 }} aria-label="Payout amount" />
          <input name="paid_on" type="date" defaultValue={today()} required aria-label="Date" />
          <input name="ref" placeholder="Ref" style={{ width: 100 }} />
          <button disabled={busy}>Record payout</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

export function RentReceipt({ id }) {
  const [r, , loadError] = useApi('/rent-payments/' + id)
  if (loadError) return <p className="error">{loadError}</p>
  if (!r) return <p className="muted">Loading…</p>
  return (
    <section>
      <div className="row between no-print"><a href={'#/properties/' + r.property_id} className="muted">← {propLabel(r.property)}</a><button onClick={() => print()}>Print receipt</button></div>
      <article className="card letter">
        {r.voided_at && <div className="stamp">Void</div>}
        <header className="row between">
          <img src={logoImg} alt="Estate Centric" />
          <div className="right"><small>Receipt No.</small><b>{r.receipt_no}</b><small>Date: {r.paid_on}</small></div>
        </header>
        <h1>{r.kind === 'deposit_refund' ? 'Deposit Refund Voucher' : r.kind === 'deposit' ? 'Security Deposit Receipt' : 'Rent Receipt'}</h1>
        <table className="letter-table"><tbody>
          <tr><th>{r.kind === 'deposit_refund' ? 'Paid to' : 'Received from'}</th><td>{r.tenant_name}{r.tenant_cnic && ` (CNIC ${r.tenant_cnic})`}</td></tr>
          <tr><th>Amount</th><td><b>{rs(r.amount)}</b></td></tr>
          <tr><th>Method</th><td>{r.method}{r.ref && ` · ${r.ref}`}</td></tr>
          <tr><th>Property</th><td>{propLabel(r.property)}{r.property.address && `, ${r.property.address}`}</td></tr>
          {r.note && <tr><th>Note</th><td>{r.note}</td></tr>}
        </tbody></table>
        <div className="signs"><div><span />Tenant</div><div><span />Received by<br /><small>Estate Centric</small></div></div>
        <footer><small>Recorded by {r.created_by_name || 'Estate Centric'} on {fmt(r.created_at)}</small></footer>
      </article>
    </section>
  )
}
