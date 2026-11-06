import { useEffect, useId, useMemo, useRef, useState } from 'react'
import JsBarcode from 'jsbarcode'
import { createPortal } from 'react-dom'
import { api, useApi, useMeta, useAction, formData, fmt, pkr, go, phone, shrinkImage, readFile } from './api.js'
import logoImg from './assets/logo.png'
import { Select, Status } from './Leads.jsx'
import { convertArea, currentRate, unitPrice, sizeKey, autoPrefix } from '../server/lib.js'

const UOMS = ['marla', 'kanal', 'sqft', 'sqyd']
const LEVELS = { land: ['Phase', 'Block', 'Street'], building: ['Phase', 'Tower', 'Floor'] }
const NEEDS_LEAD = ['Token Received', 'Booked', 'Sold']
const cls = s => 'u-' + s.toLowerCase().replace(/\s/g, '-')
const label = (un, kind) => [un.phase, un.block, un.street].map((v, i) => v && `${LEVELS[kind][i]} ${v}`).filter(Boolean).join(' · ')

function Legend({ counts, statuses }) {
  return (
    <div className="legend-row">
      {statuses.map(s => <span key={s}><i className={'sw ' + cls(s)} />{s} <b>{counts[s] || 0}</b></span>)}
    </div>
  )
}

export default function Projects() {
  const m = useMeta()
  const [rows, reload] = useApi('/projects')
  const { run, error, busy } = useAction()
  const create = e => {
    const body = formData(e)
    run(async () => { const { id } = await api('/projects', { body }); reload(); m.reloadMeta(); go('/projects/' + id) })
  }
  // the buttons sit inside the card link: stop them from opening the project
  const rename = (e, p) => {
    e.preventDefault()
    const name = prompt('Project name', p.name)?.trim()
    if (name && name !== p.name) run(async () => { await api('/projects/' + p.id, { method: 'PATCH', body: { name } }); reload(); m.reloadMeta() })
  }
  const remove = (e, p, total) => {
    e.preventDefault()
    const sold = (p.counts.Sold || 0) + (p.counts.Booked || 0) + (p.counts['Token Received'] || 0)
    const typed = prompt(`Delete ${p.name} with its ${total} units${sold ? `, including ${sold} sold or booked` : ''}, prices and allotments? This cannot be undone.\n\nType the project name to confirm:`)
    if (typed === null) return
    if (typed.trim() !== p.name) return run(async () => { throw new Error('The name did not match. Nothing was deleted.') })
    run(async () => { await api('/projects/' + p.id, { method: 'DELETE', body: { confirm: p.name } }); reload(); m.reloadMeta() })
  }
  return (
    <section>
      {error && <p className="error">{error}</p>}
      <div className="project-cards">
        {rows?.map(p => {
          const total = Object.values(p.counts).reduce((s, n) => s + n, 0)
          return (
            <a key={p.id} className="card project-card" href={'#/projects/' + p.id}>
              <div className="row between"><h3>{p.name}</h3><span className="count">{p.kind}</span></div>
              <p className="muted">{p.city || '—'} · {total} units · 1 marla = {p.marla_sqft} sq ft</p>
              <div className="stack" role="img" aria-label={m.settings.unit_statuses.map(s => `${s} ${p.counts[s] || 0}`).join(', ')}>
                {m.settings.unit_statuses.filter(s => p.counts[s]).map(s => <i key={s} className={cls(s)} style={{ flex: p.counts[s] }} />)}
              </div>
              <Legend counts={p.counts} statuses={['Available', 'On Hold', 'Booked', 'Sold']} />
              {m.can('manage_inventory') && <div className="row card-actions">
                <button type="button" className="ghost" onClick={e => rename(e, p)}>Rename</button>
                <button type="button" className="ghost danger" onClick={e => remove(e, p, total)}>Delete</button>
              </div>}
            </a>
          )
        })}
        {rows?.length === 0 && <p className="muted">No projects yet.</p>}
      </div>
      {m.can('manage_inventory') && (
        <form className="card grid" onSubmit={create}>
          <h3 className="wide">New project</h3>
          <label>Name *<input name="name" required /></label>
          <label>City<input name="city" /></label>
          <label>Layout<Select name="kind" options={[['land', 'Land (phase › block › street › plot)'], ['building', 'Building (tower › floor › unit)']]} blank={null} /></label>
          <label>1 marla = sq ft<input name="marla_sqft" type="number" step="0.01" min="1" defaultValue="225" required /></label>
          {error && <p className="error wide">{error}</p>}
          <div className="wide"><button disabled={busy}>Create project</button></div>
        </form>
      )}
    </section>
  )
}

export function Project({ id }) {
  const m = useMeta()
  const [data, reload, loadError] = useApi('/projects/' + id)
  const [tab, setTab] = useState('inventory')
  const [unitId, setUnitId] = useState(null)
  const [plotRef, setPlotRef] = useState(null) // an unlinked map plot picked for linking
  const [view, setView] = useState('grid')
  const [f, setF] = useState({ status: '', type: '', q: '', by: 'block' })
  const [labels, setLabels] = useState(false)
  const [mapText, reloadMap, mapError] = useApi(data?.project.has_map ? `/projects/${id}/map` : null)
  const map = useMemo(() => mapText && parseMap(mapText), [mapText])
  if (loadError) return <p className="error">{loadError}</p>
  if (!data) return <p className="muted">Loading…</p>
  const { project: p, units, prices } = data
  const counts = units.reduce((c, u) => ({ ...c, [u.status]: (c[u.status] || 0) + 1 }), {})
  const shown = units.filter(u => (!f.status || u.status === f.status) && (!f.type || u.unit_type === f.type) && (!f.q || u.unit_no.toLowerCase().includes(f.q.toLowerCase())))
  const groups = Object.entries(shown.reduce((g, u) => {
    const k = f.by === 'size' ? (u.size ? sizeName(u) : 'No size') : label(u, p.kind) || 'Units'
    return { ...g, [k]: [...(g[k] || []), u] }
  }, {}))
  const tabs = [['inventory', 'Inventory'], ['sizes', 'Sizes & prices'], ['media', 'Media'], ...(m.can('unit_status') ? [['allotments', 'Allotments']] : []),
    ...(m.can('manage_inventory') ? [['add', 'Add units'], ['setup', 'Setup']] : [])]
  const set = k => e => setF({ ...f, [k]: e.target.value })
  const linked = uid => { setPlotRef(null); setUnitId(uid); reload() }
  const panel = plotRef && view === 'map' ? <LinkPlot p={p} map={map} plotRef={plotRef} units={units} prices={prices} reload={reload} onLinked={linked} onRemoved={() => { setPlotRef(null); reloadMap() }} />
    : unitId ? <UnitPanel id={unitId} key={unitId} onChange={reload} onDeleted={() => { setUnitId(null); reload() }} /> : null

  return (
    <section>
      <div className="row between">
        <div>
          <a href="#/projects" className="muted">← All projects</a>
          <h2>{p.name} <span className="count">{p.kind}</span></h2>
          <p className="muted">{p.city || '—'} · {units.length} units · 1 marla = {p.marla_sqft} sq ft · holds last {p.hold_hours}h</p>
        </div>
        <div className="row">
          {m.can('manage_inventory') && <AddPlot p={p} units={units} prices={prices} map={map} onAdded={reload} onLinked={linked}
            mapRef={view === 'map' && plotRef && !units.some(u => u.map_ref === plotRef) ? plotRef : null} />}
          <div className="seg">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        </div>
      </div>

      {labels && <BarcodeSheet p={p} units={shown} onClose={() => setLabels(false)} />}
      {tab === 'inventory' && (
        <>
          <div className="filters">
            <input placeholder="Unit number" value={f.q} onChange={set('q')} />
            <Select value={f.status} onChange={set('status')} options={m.settings.unit_statuses} blank="Any status" />
            <Select value={f.type} onChange={set('type')} options={[...new Set(units.map(u => u.unit_type))]} blank="Any type" />
            {view === 'grid' && <Select value={f.by} onChange={set('by')} options={[['block', 'Group by ' + LEVELS[p.kind][1].toLowerCase()], ['size', 'Group by size']]} blank={null} />}
            <button className="ghost" onClick={() => setLabels(true)} disabled={!shown.length}>Print barcodes</button>
            {p.has_map && view === 'map' && m.can('manage_inventory') && <ShareMap p={p} reload={reload} />}
            {p.has_map && <div className="seg small">{[['grid', 'Grid'], ['map', 'Map']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</div>}
          </div>
          {view === 'map' && p.has_map ? (
            <PlotMap p={p} map={map} error={mapError} units={units} shown={shown} unitId={unitId} plotRef={plotRef} counts={counts} statuses={m.settings.unit_statuses}
              status={f.status} onStatus={s => setF({ ...f, status: f.status === s ? '' : s })} panel={panel} onClose={() => { setUnitId(null); setPlotRef(null) }}
              onPick={(ref, u) => { setPlotRef(u ? null : ref); setUnitId(u?.id ?? null) }}
              onDrawn={m.can('manage_inventory') ? ref => { reloadMap(); setUnitId(null); setPlotRef(ref) } : null} />
          ) : <>
            <Legend counts={counts} statuses={m.settings.unit_statuses} />
            <div className="inv">
              <div>
              {groups.map(([g, list]) => (
                <div key={g} className="card">
                  <div className="row between"><h3>{g}</h3><small className="muted">{list.filter(u => u.status === 'Available').length} of {list.length} available</small></div>
                  <div className="unit-grid">
                    {list.map(u => (
                      <button key={u.id} className={'unit ' + cls(u.status) + (unitId === u.id ? ' sel' : '')} onClick={() => setUnitId(u.id)}
                        aria-label={`Unit ${u.unit_no}, ${u.size ?? ''} ${u.uom}, ${u.status}`} title={`${u.unit_type} · ${u.size ?? '?'} ${u.uom} · ${u.status}${u.price ? ' · PKR ' + pkr(u.price.total) : ''}`}>
                        <b>{u.unit_no}</b><small>{u.size ?? '—'} {u.uom === 'marla' ? 'M' : u.uom === 'kanal' ? 'K' : u.uom}</small>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {!groups.length && <div className="card muted">{units.length ? 'No units match.' : 'No units yet. Use “Add units” to create them.'}</div>}
              </div>
              <div className="inv-panel">{panel || <div className="card muted">Select a unit to see its price, history and actions.</div>}</div>
            </div>
          </>}
        </>
      )}
      {tab === 'sizes' && <Sizes project={p} prices={prices} units={units} reload={reload} />}
      {tab === 'media' && <Media project={p} />}
      {tab === 'add' && <AddUnits project={p} onDone={() => { reload(); setTab('inventory') }} />}
      {tab === 'allotments' && <Allotments project={p} onChange={reload} />}
      {tab === 'setup' && <Setup project={p} reload={() => { reload(); m.reloadMeta() }} />}
    </section>
  )
}

// Picks a lead by typing a name or phone; the chosen option ends with "#id"
export function LeadPicker({ name = 'lead', required, defaultValue }) {
  const [opts, setOpts] = useState([])
  const listId = useId()
  const search = async e => {
    const q = e.target.value
    if (q.length >= 2 && !/#\d+$/.test(q)) setOpts((await api('/leads?q=' + encodeURIComponent(q))).rows)
  }
  return (
    <>
      <input name={name} list={listId} placeholder="Customer: type name or phone" onChange={search} required={required} defaultValue={defaultValue} autoComplete="off" />
      <datalist id={listId}>{opts.map(l => <option key={l.id} value={`${l.name} · ${l.phone} · #${l.id}`} />)}</datalist>
    </>
  )
}
// The map SVG is parsed, not injected: only the background image and the plot paths are rendered
function parseMap(text) {
  const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement
  const img = svg.querySelector('image'), href = img?.getAttribute('href') || img?.getAttribute('xlink:href')
  return {
    viewBox: svg.getAttribute('viewBox'),
    image: /^data:image\//.test(href || '') && { href, width: img.getAttribute('width'), height: img.getAttribute('height') },
    plots: [...svg.querySelectorAll('#plots path[id]')].map(x => ({
      id: x.id, d: x.getAttribute('d'), block: x.getAttribute('data-block') || '', no: x.getAttribute('data-no') || '',
      size: x.getAttribute('data-size') || '', uom: x.getAttribute('data-uom') || '', color: x.getAttribute('data-color') || '',
    })),
  }
}

const sizeLabel = x => `${x.size} ${UOM_LABEL[x.uom] || x.uom}`
const MAP_STATUSES = ['Available', 'On Hold', 'Sold'] // always listed on the map legend, even at zero

// client: the shared map for customers (no "not in inventory" line, project name as title)
function PlotMap({ p, map, error, units, shown, unitId, plotRef, onPick, counts, statuses, status, onStatus, panel, onClose, client, onDrawn }) {
  const [zoom, setZoom] = useState(1)
  const [draw, setDraw] = useState(null) // { pts: [[x, y]…], naming } while tracing a plot that's missing from the map
  const box = useRef(), card = useRef()
  if (error) return <div className="card error">{error}</div>
  if (!map) return <div className="card muted">Loading map…</div>
  const byRef = Object.fromEntries(units.filter(u => u.map_ref).map(u => [u.map_ref, u]))
  const visible = new Set(shown.map(u => u.id))
  const sizes = Object.entries(map.plots.reduce((g, x) => {
    if (x.size) { const k = sizeLabel(x); g[k] = { color: x.color, n: (g[k]?.n || 0) + 1 } }
    return g
  }, {}))
  const zoomBy = k => { // keep the centre of the view in place
    const b = box.current, cx = (b.scrollLeft + b.clientWidth / 2) / b.scrollWidth, cy = (b.scrollTop + b.clientHeight / 2) / b.scrollHeight
    setZoom(z => Math.min(16, Math.max(1, z * k)))
    requestAnimationFrame(() => { b.scrollLeft = cx * b.scrollWidth - b.clientWidth / 2; b.scrollTop = cy * b.scrollHeight - b.clientHeight / 2 })
  }
  return (
    <div className="card map-card" ref={card}>
      <div className="row between">
        {client ? <h2>{p.name}</h2> : <small className="muted">{Object.keys(byRef).length} of {map.plots.length} plots linked to inventory</small>}
        <div className="seg small">
          <button onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out">−</button>
          <button onClick={() => zoomBy(1.6)} aria-label="Zoom in">+</button>
          <button onClick={() => (document.fullscreenElement ? document.exitFullscreen() : card.current.requestFullscreen())} aria-label="Full screen">⛶</button>
        </div>
        {onDrawn && !draw && <button className="ghost" onClick={() => { onClose(); setDraw({ pts: [] }) }} title="Trace a plot that isn't clickable on the map">✎ Draw plot</button>}
      </div>
      {draw && !draw.naming && (
        <div className="draw-bar">
          Zoom in and click each corner of the plot ({draw.pts.length} so far).
          <button className="ghost" onClick={() => setDraw({ pts: draw.pts.slice(0, -1) })} disabled={!draw.pts.length}>Undo</button>
          <button onClick={() => setDraw({ ...draw, naming: true })} disabled={draw.pts.length < 3}>Finish</button>
          <button className="ghost" onClick={() => setDraw(null)}>Cancel</button>
        </div>
      )}
      <div className="map-wrap">
      <div className="map-legend">
        {statuses.filter(s => counts[s] || MAP_STATUSES.includes(s)).map(s => (
          <button key={s} className={status === s ? 'on' : ''} onClick={() => onStatus(s)} title={`Show only ${s}`}>
            <i className={'sw ' + cls(s)} />{s}<b>{counts[s] || 0}</b>
          </button>
        ))}
        {!client && <span><i className="sw free" />Not in inventory<b>{map.plots.length - Object.keys(byRef).length}</b></span>}
        {sizes.length > 0 && <small className="muted">Plot sizes</small>}
        {sizes.map(([k, { color, n }]) => <span key={k}><i className="sw" style={{ background: color }} />{k}<b>{n}</b></span>)}
      </div>
      {draw?.naming ? <div className="map-panel"><NamePlot p={p} map={map} pts={draw.pts} onCancel={() => setDraw(null)} onDone={ref => { setDraw(null); onDrawn(ref) }} /></div>
        : panel && <div className="map-panel"><button className="ghost close" onClick={onClose} aria-label="Close">✕</button>{panel}</div>}
      <div className="plot-map" ref={box}>
        <svg viewBox={map.viewBox} style={{ width: zoom * 100 + '%', height: zoom * 100 + '%' }} className={draw && !draw.naming ? 'drawing' : ''}
          onClickCapture={draw && !draw.naming ? e => { // a corner, in map units (the plan's own coordinates)
            e.stopPropagation()
            const svg = e.currentTarget, pt = Object.assign(svg.createSVGPoint(), { x: e.clientX, y: e.clientY }).matrixTransform(svg.getScreenCTM().inverse())
            setDraw({ pts: [...draw.pts, [+pt.x.toFixed(1), +pt.y.toFixed(1)]] })
          } : undefined}>
          {map.image && <image href={map.image.href} width={map.image.width} height={map.image.height} />}
          {map.plots.map(({ id, d, block, no, size, uom }) => {
            const u = byRef[id]
            const sel = u ? u.id === unitId : id === plotRef
            return (
              <path key={id} d={d} onClick={() => onPick(id, u)}
                className={'plot ' + (u ? cls(u.status) + (visible.has(u.id) ? '' : ' dim') : 'free') + (sel ? ' sel' : '')}>
                <title>{u ? `${label(u, p.kind)} #${u.unit_no} · ${u.status}` : client ? (no ? `${block} #${no}` : '') : `${no ? `${block} #${no} · ` : ''}${size ? sizeLabel({ size, uom }) + ' · ' : ''}not in inventory yet`}</title>
              </path>
            )
          })}
          {draw && <polygon className="draft-plot" points={draw.pts.map(q => q.join(',')).join(' ')} />}
          {draw?.pts.map((q, i) => <circle key={i} className="draft-dot" cx={q[0]} cy={q[1]} r={1.2 / zoom} />)}
        </svg>
      </div>
      </div>
    </div>
  )
}

const shareUrl = token => `${location.origin}${location.pathname}#/map/${token}`

function ShareMap({ p, reload }) {
  const { run, error, busy } = useAction()
  const [copied, setCopied] = useState(false)
  const copy = token => navigator.clipboard?.writeText(shareUrl(token)).then(() => setCopied(true), () => prompt('Copy the client link', shareUrl(token)))
    ?? prompt('Copy the client link', shareUrl(token))
  const create = () => (!p.share_token || confirm('Make a new link? The current client link will stop working.')) &&
    run(async () => { const { token } = await api(`/projects/${p.id}/share`, { body: {} }); reload(); copy(token) })
  return (
    <div className="row">
      {p.share_token && <button type="button" onClick={() => copy(p.share_token)}>{copied ? 'Link copied' : 'Copy client link'}</button>}
      {p.share_token && <a href={shareUrl(p.share_token)} target="_blank" rel="noreferrer" className="muted">Open</a>}
      <button type="button" className="ghost" onClick={create} disabled={busy}>{p.share_token ? 'New link' : 'Share with clients'}</button>
      {error && <span className="error">{error}</span>}
    </div>
  )
}

// The page clients open from a shared link: no login, statuses and sizes only
export function PublicMap({ token }) {
  const [data, , error] = useApi('/public/map/' + token)
  const [text] = useApi(`/public/map/${token}/svg`)
  const map = useMemo(() => text && parseMap(text), [text])
  const [status, setStatus] = useState('')
  const [sel, setSel] = useState(null)
  if (error) return <p className="error pad">{error}</p>
  if (!data || !map) return <p className="muted pad">Loading map…</p>
  const counts = data.units.reduce((c, u) => ({ ...c, [u.status]: (c[u.status] || 0) + 1 }), {})
  const u = data.units.find(x => x.id === sel)
  return (
    <div className="public-map">
      <img className="public-logo" src={logoImg} alt="Estate Centric" />
      <PlotMap client p={data} map={map} units={data.units} shown={data.units.filter(x => !status || x.status === status)} unitId={sel}
        counts={counts} statuses={data.statuses} status={status} onStatus={s => setStatus(status === s ? '' : s)}
        onPick={(_, x) => setSel(x?.id ?? null)} onClose={() => setSel(null)}
        panel={u && (
          <div className="card">
            <div className="row between"><h3>{u.unit_type} #{u.unit_no}</h3><span className={'status ' + cls(u.status)}>{u.status}</span></div>
            <p className="muted">{label(u, data.kind) || data.name}</p>
            <p>{u.size ?? '—'} {u.uom} · {u.category}{u.facing && ` · ${u.facing} facing`}{u.dimensions && ` · ${u.dimensions}`}</p>
          </div>
        )} />
    </div>
  )
}

function LinkPlot({ p, map, plotRef, units, prices, reload, onLinked, onRemoved }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  if (!m.can('manage_inventory')) return <div className="card muted">This plot isn't in the inventory yet.</div>
  const drawn = plotRef.startsWith('drawn-')
  const remove = () => confirm('Remove this drawn outline from the map?') && run(async () => { await api(`/projects/${p.id}/map/plots/${plotRef}`, { method: 'DELETE' }); onRemoved() })
  return (
    <div className="card">
      <h3>This plot isn't linked yet</h3>
      <p className="muted">Pick its {LEVELS[p.kind][1].toLowerCase()} and plot number from the inventory, or add it as a new unit.</p>
      <AddPlot p={p} units={units} prices={prices} map={map} onAdded={reload} mapRef={plotRef} onLinked={onLinked} label="Link this plot" />
      {drawn && <button className="ghost danger full-btn" onClick={remove} disabled={busy}>Remove drawn outline</button>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

// After tracing: name the plot like the map's own plots (block, number, size), then it can be linked to inventory
function NamePlot({ p, map, pts, onDone, onCancel }) {
  const { run, error, busy } = useAction()
  const blocks = [...new Set(map.plots.map(x => x.block).filter(Boolean))].sort()
  const save = e => {
    const b = formData(e), d = 'M' + pts.map(q => q.join(',')).join('L') + 'Z'
    run(async () => onDone((await api(`/projects/${p.id}/map/plots`, { body: { ...b, d } })).id))
  }
  return (
    <form className="card allot-form" onSubmit={save}>
      <h3>Name this plot</h3>
      <input name="block" list="map-blocks" placeholder="Block (e.g. A BLOCK)" />
      <datalist id="map-blocks">{blocks.map(x => <option key={x} value={x} />)}</datalist>
      <input name="no" placeholder="Plot no. (e.g. 4A, 12) *" required autoFocus />
      <div className="row"><input name="size" type="number" min="0" step="any" placeholder="Size" /><Select name="uom" options={UOMS} defaultValue="kanal" blank={null} /></div>
      <Select name="kind" options={['Commercial', 'Residential', 'Mix Use', 'Apartment', 'Amenity']} blank={null} />
      {error && <p className="error">{error}</p>}
      <div className="row"><button disabled={busy}>Add to map</button><button type="button" className="ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  )
}

const NEW = '__new'
const ALLOTTABLE = ['Available', 'On Hold', 'Token Received', 'Booked']

// Records the sale: client (existing lead or new buyer), agreed price, date; marks the plot Sold/Booked
function AllotForm({ u, onDone, onCancel }) {
  const { run, error, busy } = useAction()
  const [existing, setExisting] = useState(true)
  const submit = e => {
    const b = formData(e)
    const body = { expected: u.status, status: b.status, price: b.price || undefined, sale_date: b.sale_date, allotment_no: b.allotment_no, note: b.note }
    if (b.count || b.down) body.plan = { down: b.down, count: b.count, every: b.every }
    if (existing) {
      body.lead_id = leadIdOf(b.lead)
      if (!body.lead_id) return run(async () => { throw new Error('Pick the client from the list') })
    } else body.client = { name: b.name, phone: b.phone, cnic: b.cnic }
    run(async () => { const r = await api(`/units/${u.id}/allot`, { body }); onDone(r) })
  }
  return (
    <form className="allot-form" onSubmit={submit}>
      <div className="seg small">
        <button type="button" className={existing ? 'on' : ''} onClick={() => setExisting(true)}>Existing client</button>
        <button type="button" className={existing ? '' : 'on'} onClick={() => setExisting(false)}>New client</button>
      </div>
      {existing
        ? <LeadPicker required defaultValue={u.lead_id ? `${u.lead_name} · #${u.lead_id}` : ''} />
        : <>
          <input name="name" placeholder="Client name *" required />
          <input name="phone" placeholder="Phone *" required />
          <input name="cnic" placeholder="CNIC" pattern="\d{5}-?\d{7}-?\d" />
        </>}
      <div className="row">
        <Select name="status" options={['Sold', 'Booked']} blank={null} />
        <input name="sale_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required aria-label="Sale date" />
      </div>
      <input name="price" type="number" min="1" placeholder={u.price ? `Sale price (list PKR ${pkr(u.price.total)})` : 'Sale price (PKR) *'} required={!u.price} />
      <input name="allotment_no" placeholder="Allotment / file no. (auto if empty)" />
      <input name="note" placeholder="Note" />
      <details>
        <summary>Payment plan (optional, can be set later)</summary>
        <div className="row">
          <input name="down" type="number" min="0" placeholder="Down payment" defaultValue={u.down_payment || ''} aria-label="Down payment" />
          <input name="count" type="number" min="0" max="360" placeholder="No. of installments" aria-label="Installments" />
          <Select name="every" options={[[1, 'Monthly'], [3, 'Quarterly'], [6, 'Half-yearly'], [12, 'Yearly']]} blank={null} />
        </div>
      </details>
      {error && <p className="error">{error}</p>}
      <div className="row"><button disabled={busy}>Assign plot</button><button type="button" className="ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  )
}

const MEDIA_KINDS = [['brochure', 'Brochure'], ['floor_plan', 'Floor plan'], ['photo', 'Photo'], ['other', 'Other']]
// Brochures, floor plans, photos (files) and video links; files open from a shareable link
function Media({ project: p }) {
  const m = useMeta()
  const [rows, reload] = useApi(`/media?entity=project&entity_id=${p.id}`)
  const { run, error, busy } = useAction()
  const manage = m.can('manage_inventory')
  const link = x => x.url || `${location.origin}/api/files/${x.token}`
  const upload = e => {
    const form = e.target, b = formData(e), file = form.file.files[0]
    run(async () => {
      if (file.size > 15e6) throw new Error('File is too large (max 15 MB)')
      const data = file.type.startsWith('image/') ? await shrinkImage(file, 2400) : await readFile(file)
      await api('/media', { body: { entity: 'project', entity_id: p.id, kind: b.kind, name: b.name || file.name, data } })
      form.reset(); reload()
    })
  }
  const addVideo = e => { const form = e.target, b = formData(e); run(async () => { await api('/media', { body: { entity: 'project', entity_id: p.id, kind: 'video', ...b } }); form.reset(); reload() }) }
  const remove = x => confirm(`Delete ${x.name || 'this file'}?`) && run(async () => { await api('/media/' + x.id, { method: 'DELETE' }); reload() })
  const label = Object.fromEntries([...MEDIA_KINDS, ['video', 'Video']])
  return (
    <>
      <div className="card scroll">
        <h3>Media <span className="count">{rows?.length}</span></h3>
        <table>
          <tbody>
            {rows?.map(x => (
              <tr key={x.id}>
                <td>{x.kind === 'photo' ? <img className="thumb" src={link(x)} alt="" /> : <span className="count">{label[x.kind]}</span>}</td>
                <td><a href={link(x)} target="_blank" rel="noreferrer"><b>{x.name || label[x.kind]}</b></a><small className="muted"><br />{x.size ? `${(x.size / 1e6).toFixed(1)} MB · ` : ''}{fmt(x.created_at)}</small></td>
                <td className="row nowrap">
                  <a className="button ghost" href={'https://wa.me/?text=' + encodeURIComponent(`${p.name}: ${x.name || label[x.kind]}\n${link(x)}`)} target="_blank" rel="noreferrer">WhatsApp</a>
                  {manage && <button className="ghost danger" onClick={() => remove(x)}>Delete</button>}
                </td>
              </tr>
            ))}
            {rows?.length === 0 && <tr><td className="muted">No brochures, floor plans or videos yet.</td></tr>}
          </tbody>
        </table>
        <small className="muted">Links open without logging in, so they can be sent to clients.</small>
      </div>
      {manage && <div className="cols">
        <form className="card" onSubmit={upload}>
          <h3>Upload file</h3>
          <Select name="kind" options={MEDIA_KINDS} blank={null} />
          <input name="file" type="file" accept="application/pdf,image/*" required />
          <input name="name" placeholder="Name (defaults to file name)" />
          <button disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button>
        </form>
        <form className="card" onSubmit={addVideo}>
          <h3>Add video link</h3>
          <input name="url" type="url" placeholder="https://youtube.com/…" required />
          <input name="name" placeholder="Name, e.g. Site walkthrough" />
          <button disabled={busy}>Add video</button>
        </form>
      </div>}
      {error && <p className="error">{error}</p>}
    </>
  )
}

function Photos({ u, photos, manage, reload }) {
  const { run, error, busy } = useAction()
  const add = e => {
    const files = [...e.target.files]
    e.target.value = ''
    run(async () => { for (const f of files) await api(`/units/${u.id}/photos`, { body: { data: await shrinkImage(f) } }); reload() })
  }
  const remove = ph => confirm('Delete this photo?') && run(async () => { await api(`/units/${u.id}/photos/${ph.id}`, { method: 'DELETE' }); reload() })
  if (!photos.length && !manage) return null
  return (
    <div className="photos">
      {photos.map(ph => (
        <figure key={ph.id}>
          <a href={ph.data} target="_blank" rel="noreferrer"><img src={ph.data} alt={`${u.unit_type} ${u.unit_no}`} /></a>
          {manage && <button className="ghost danger" onClick={() => remove(ph)} aria-label="Delete photo">×</button>}
        </figure>
      ))}
      {manage && photos.length < 12 && <label className="add-photo">{busy ? 'Uploading…' : '+ Photos'}<input type="file" accept="image/*" multiple onChange={add} disabled={busy} hidden /></label>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

export const leadIdOf = v => +(String(v || '').match(/#(\d+)$/)?.[1] || 0) || null

function UnitPanel({ id, onChange, onDeleted }) {
  const m = useMeta()
  const [data, reload] = useApi('/units/' + id)
  const { run, error, busy } = useAction()
  const [status, setStatus] = useState('')
  const [allotting, setAllotting] = useState(false)
  if (!data) return <div className="card muted">Loading…</div>
  const { unit: u, project: p, history, allotment, photos } = data
  const done = () => { reload(); onChange() }
  const remove = () => confirm(`Delete plot ${u.unit_no}? This cannot be undone.`) &&
    run(async () => { await api('/units/' + u.id, { method: 'DELETE' }); onDeleted() })
  const act = (path, body) => run(async () => { await api(`/units/${u.id}/${path}`, { body }); setStatus(''); done() })
  const hold = e => {
    const lead_id = leadIdOf(formData(e).lead)
    if (!lead_id) return run(async () => { throw new Error('Pick a customer from the list') })
    act('hold', { lead_id })
  }
  const changeStatus = e => {
    const b = formData(e)
    act('status', { status, expected: u.status, note: b.note, lead_id: leadIdOf(b.lead) || undefined })
  }
  const where = label(u, p.kind)
  const share = `${p.name}${where ? ' · ' + where : ''} · ${u.unit_type} #${u.unit_no}\n${u.size} ${u.uom}${u.premiums.length ? ' · ' + u.premiums.join(', ') : ''}${u.price ? `\nPrice: PKR ${pkr(u.price.total)}` : ''}${u.down_payment ? `\nDown payment: PKR ${pkr(u.down_payment)}` : ''}`

  return (
    <div className="card unit-panel">
      <div className="row between">
        <h3>{u.unit_type} #{u.unit_no}</h3>
        <span className={'status ' + cls(u.status)}>{u.status}</span>
      </div>
      <p className="muted">{where || p.name} · {u.category}{u.facing && ` · ${u.facing} facing`}{u.dimensions && ` · ${u.dimensions}`}</p>
      {u.lead_id && <p>Customer: <a href={'#/leads/' + u.lead_id}>{u.lead_name}</a>{u.status === 'On Hold' && <small className="muted"> · held by {u.hold_name} until {fmt(u.hold_until)}</small>}</p>}

      <div className="inset left">
        {u.price ? (
          <>
            {!u.price.override && <div className="line"><span>Base</span><b>PKR {pkr(u.price.base)}</b></div>}
            {u.price.premium > 0 && <div className="line"><span>Premiums ({u.premiums.join(', ')})</span><b>PKR {pkr(u.price.premium)}</b></div>}
            <div className="line total"><span>Total{u.price.override && ' (plot price)'}</span><b>PKR {pkr(u.price.total)}</b></div>
            {u.down_payment && <div className="line"><span>Down payment</span><b>PKR {pkr(u.down_payment)}</b></div>}
            {u.down_payment && <div className="line"><span>Balance after down payment</span><b>PKR {pkr(u.price.total - u.down_payment)}</b></div>}
          </>
        ) : <span className="muted">No price list for {u.unit_type} yet.</span>}
      </div>
      <Photos u={u} photos={photos} manage={m.can('manage_inventory')} reload={reload} />
      {u.size && (
        <p className="conv">{UOMS.map(x => <span key={x}><b>{+convertArea(u.size, u.uom, x, p.marla_sqft).toFixed(2)}</b> {x}</span>)}</p>
      )}

      {allotment && (
        <div className="allotted">
          <small>Allotted · {allotment.allotment_no}</small>
          <b>{u.lead_name}</b>
          <span>PKR {pkr(allotment.price)} · {allotment.sale_date}</span>
          <a href={'#/allotments/' + allotment.id}>Allotment letter →</a>
          <a href={'#/ledger/' + allotment.id}>Payments ledger →</a>
        </div>
      )}
      {m.can('unit_status') && ALLOTTABLE.includes(u.status) && (allotting
        ? <AllotForm u={u} onDone={() => { setAllotting(false); done() }} onCancel={() => setAllotting(false)} />
        : <button className="full-btn" onClick={() => setAllotting(true)}>Assign plot to client</button>)}

      {!allotting && <div className="actions">
        {u.status === 'Available' && (
          <form onSubmit={hold}>
            <LeadPicker required />
            <button disabled={busy}>Hold for {p.hold_hours}h</button>
          </form>
        )}
        {u.status === 'On Hold' && (u.hold_by === m.me.id || m.can('manage_inventory')) && <button className="ghost" disabled={busy} onClick={() => act('release', {})}>Release hold</button>}
        {m.can('unit_status') && (
          <form onSubmit={changeStatus}>
            <Select value={status} onChange={e => setStatus(e.target.value)} options={m.settings.unit_statuses.filter(s => s !== u.status && s !== 'On Hold')} blank="Change status…" />
            {NEEDS_LEAD.includes(status) && !u.lead_id && <LeadPicker required />}
            {status && <input name="note" placeholder="Note (e.g. token receipt no.)" />}
            {status && <button disabled={busy}>Set {status}</button>}
          </form>
        )}
        <a className="button ghost" href={'https://wa.me/?text=' + encodeURIComponent(share)} target="_blank" rel="noreferrer">Share on WhatsApp</a>
      </div>}
      {error && <p className="error">{error}</p>}
      {m.can('manage_inventory') && <EditUnit u={u} p={p} onSaved={done} />}
      {m.can('manage_inventory') && u.status === 'Available' && !u.lead_id && !allotment && !history.some(h => /Allotted/.test(h.note || '')) &&
        <button className="ghost danger full-btn" disabled={busy} onClick={remove}>Delete plot</button>}

      <h3>History</h3>
      <ul className="timeline">
        {history.map(h => <li key={h.id}><b>{[h.from_status, h.to_status].filter(Boolean).join(' → ') || 'Updated'}</b> <small className="muted">{h.user_name || 'System'} · {fmt(h.created_at)}</small>{(h.lead_name || h.note) && <div><small>{h.lead_name}{h.lead_name && h.note && ' · '}{h.note}</small></div>}</li>)}
        {!history.length && <li className="sys">No changes yet.</li>}
      </ul>
    </div>
  )
}

// Adds one plot at a time: irregular blocks and numbers. "Save & add another" keeps block, size and type.
// Block and plot number list the inventory plus every numbered plot on the map. A number that is on the map
// gets linked to that map plot (or to the plot clicked on the map, mapRef): existing units are linked, new ones created linked
function AddPlot({ p, units, prices, map, onAdded, mapRef, onLinked, label: buttonLabel }) {
  const m = useMeta()
  const ref = useRef()
  const { run, error, busy, setError } = useAction()
  const [last, setLast] = useState(null)
  const [pick, setPick] = useState({ block: '', no: '' })
  const [cat, setCat] = useState({ unit_type: p.kind === 'building' ? 'Apartment' : 'Plot', size: '', uom: p.kind === 'building' ? 'sqft' : 'marla' })
  const [lv1, lv2, lv3] = LEVELS[p.kind]
  const plots = map?.plots || []
  const onMap = new Set(units.map(u => u.map_ref).filter(Boolean))
  const blocks = [...new Set([...units.map(u => u.block), ...plots.map(x => x.block)].filter(Boolean))].sort()
  const nos = {}
  for (const x of plots) if (x.block === pick.block && x.no && (!nos[x.no] || onMap.has(nos[x.no].plot.id))) nos[x.no] = { plot: x }
  for (const u of units) if (u.block === pick.block) nos[u.unit_no] = { ...nos[u.unit_no], unit: u }
  const options = Object.entries(nos).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  const chosen = pick.block !== NEW && pick.no !== NEW && nos[pick.no]
  const unit = chosen?.unit
  const target = mapRef || (chosen?.plot && !onMap.has(chosen.plot.id) ? chosen.plot.id : null)
  const isNew = pick.block === NEW || pick.no === NEW || (chosen && !unit)
  const rate = cat.size > 0 && currentRate(prices, cat, new Date().toISOString())
  const listPrice = rate && unitPrice({ ...cat, premiums: [] }, rate, [], p.marla_sqft)?.base
  const plotSize = x => x?.size && setCat(c => ({ ...c, size: x.size, uom: x.uom })) // the plan's colour gives the size
  const open = () => {
    const here = mapRef && plots.find(x => x.id === mapRef)
    setError(''); setLast(null)
    setPick(here?.block ? { block: here.block, no: here.no } : { block: blocks.length ? '' : NEW, no: '' })
    plotSize(here)
    ref.current.showModal()
  }
  const link = () => run(async () => {
    await api('/units/' + unit.id, { method: 'PATCH', body: { map_ref: target } })
    ref.current.close(); onLinked?.(unit.id)
  })
  const submit = e => {
    e.preventDefault()
    const form = e.target, again = e.nativeEvent.submitter?.value === 'again'
    const b = Object.fromEntries(new FormData(form))
    const body = { ...b, premiums: JSON.stringify(p.premiums.filter(x => b['prem.' + x.name]).map(x => x.name)) }
    for (const k of Object.keys(body)) if (k.startsWith('prem.')) delete body[k]
    if (!m.can('edit_pricing')) { delete body.price_override; delete body.down_payment }
    run(async () => {
      const { id } = await api(`/projects/${p.id}/plot`, { body })
      setLast(`${b.block ? `${lv2} ${b.block} · ` : ''}#${b.unit_no}`)
      if (target) { ref.current.close(); return onLinked?.(id) }
      onAdded()
      if (!again) return ref.current.close()
      for (const k of ['unit_no', 'price_override', 'down_payment', 'facing', 'dimensions', 'features']) if (form.elements[k]) form.elements[k].value = ''
      setPick({ ...pick, no: '' })
    })
  }
  const describe = ([no, { unit: u, plot }]) =>
    `${no} · ${u ? `${u.size ?? '?'} ${u.uom} · ${u.status}` : `${plot?.size ? sizeLabel(plot) + ' · ' : ''}not in inventory`}${!plot && !u?.map_ref ? ' · not on map' : u?.map_ref ? ' · on map' : ''}`
  return (
    <>
      <button type="button" onClick={open}>{buttonLabel || `+ Add ${p.kind === 'building' ? 'unit' : 'plot'}`}</button>
      <dialog ref={ref} className="modal">
        <form className="grid" onSubmit={submit}>
          <div className="wide row between"><h3>{mapRef ? 'Link map plot in' : `Add ${p.kind === 'building' ? 'unit' : 'plot'} to`} {p.name}</h3><button type="button" className="ghost" onClick={() => ref.current.close()} aria-label="Close">✕</button></div>
          {target && isNew && <input type="hidden" name="map_ref" value={target} />}
          <label>{lv2} *
            {blocks.length > 0 && <select value={pick.block} onChange={e => setPick({ block: e.target.value, no: '' })} required autoFocus>
              <option value="">Select…</option>
              {blocks.map(b => <option key={b} value={b}>{b}</option>)}
              <option value={NEW}>+ New {lv2.toLowerCase()}…</option>
            </select>}
            {pick.block === NEW ? <input name="block" placeholder={`New ${lv2.toLowerCase()}`} required autoFocus={blocks.length > 0} /> : <input type="hidden" name="block" value={pick.block} />}
          </label>
          <label>{p.kind === 'building' ? 'Unit' : 'Plot'} number *
            {pick.block !== NEW && <select value={pick.no} onChange={e => { setPick({ ...pick, no: e.target.value }); plotSize(nos[e.target.value]?.plot) }} required disabled={!pick.block}>
              <option value="">{pick.block ? `Select… (${options.length})` : `Pick a ${lv2.toLowerCase()} first`}</option>
              {options.map(o => <option key={o[0]} value={o[0]}>{describe(o)}</option>)}
              <option value={NEW}>+ Other number…</option>
            </select>}
            {pick.block === NEW || pick.no === NEW ? <input name="unit_no" placeholder="Number" required /> : <input type="hidden" name="unit_no" value={pick.no} />}
          </label>
          {unit ? <>
            <p className="wide">{unit.map_ref && unit.map_ref === target ? 'Already in the inventory and on the map.'
              : target ? `Links ${lv2} ${unit.block} #${unit.unit_no} to ${mapRef ? 'the plot you clicked' : 'its plot on the map'}${unit.map_ref ? ' (moves it from its current map plot)' : ''}.`
              : 'Already in the inventory.'}</p>
            {error && <p className="error wide">{error}</p>}
            {target && unit.map_ref !== target && <div className="wide row"><button type="button" onClick={link} disabled={busy}>Link to map</button></div>}
          </> : isNew && <>
          {target && <p className="muted wide">Saved straight onto {mapRef ? 'the plot you clicked' : 'its plot on the map'}.</p>}
          <label>{lv3}<input name="street" /></label>
          <label>{lv1}<input name="phase" /></label>
          <label>Type<Select name="unit_type" value={cat.unit_type} onChange={e => setCat({ ...cat, unit_type: e.target.value })} options={m.settings.property_types} blank={null} /></label>
          <label>Category<Select name="category" options={['residential', 'commercial']} blank={null} /></label>
          <label>Size *<input name="size" type="number" step="0.01" min="0.01" required value={cat.size} onChange={e => setCat({ ...cat, size: e.target.value })} /></label>
          <label>Unit<Select name="uom" value={cat.uom} onChange={e => setCat({ ...cat, uom: e.target.value })} options={UOMS} blank={null} /></label>
          {m.can('edit_pricing') && <>
            <label>Price (PKR)<input name="price_override" type="number" min="1" placeholder={listPrice ? `empty = list ${pkr(listPrice)}` : 'e.g. 5000000'} /></label>
            <label>Down payment (PKR)<input name="down_payment" type="number" min="1" placeholder="e.g. 1000000" /></label>
          </>}
          <label>Facing<input name="facing" placeholder="e.g. North" /></label>
          <label>Dimensions<input name="dimensions" placeholder="e.g. 25 x 45" /></label>
          {p.premiums.length > 0 && <div className="wide row">{p.premiums.map(x => (
            <label key={x.name} className="check"><input type="checkbox" name={'prem.' + x.name} /> {x.name} ({x.type === 'pct' ? x.value + '%' : 'PKR ' + pkr(x.value)})</label>
          ))}</div>}
          {error && <p className="error wide">{error}</p>}
          {last && !error && <p className="ok wide">Added {last}.</p>}
          <div className="wide row">
            {!target && <button value="again" disabled={busy}>Save & add another</button>}
            <button value="close" className={target ? '' : 'ghost'} disabled={busy}>{target ? 'Save & link' : 'Save & close'}</button>
          </div>
          </>}
        </form>
      </dialog>
    </>
  )
}

function EditUnit({ u, p, onSaved }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const submit = e => {
    const b = formData(e)
    const body = { ...b, premiums: JSON.stringify(p.premiums.filter(x => b['prem.' + x.name]).map(x => x.name)) }
    for (const k of Object.keys(body)) if (k.startsWith('prem.')) delete body[k]
    if (!m.can('edit_pricing')) { delete body.price_override; delete body.down_payment }
    run(async () => { await api('/units/' + u.id, { method: 'PATCH', body }); onSaved() })
  }
  return (
    <details>
      <summary><b>Edit unit</b></summary>
      <form className="grid" onSubmit={submit}>
        {LEVELS[p.kind].map((lv, i) => <label key={lv}>{lv}<input name={['phase', 'block', 'street'][i]} defaultValue={u[['phase', 'block', 'street'][i]]} /></label>)}
        <label>{p.kind === 'building' ? 'Unit' : 'Plot'} number<input name="unit_no" defaultValue={u.unit_no} required /></label>
        <label>Type<Select name="unit_type" options={m.settings.property_types} defaultValue={u.unit_type} blank={null} /></label>
        <label>Category<Select name="category" options={['residential', 'commercial']} defaultValue={u.category} blank={null} /></label>
        <label>Size<input name="size" type="number" step="0.01" min="0" defaultValue={u.size} /></label>
        <label>Unit<Select name="uom" options={UOMS} defaultValue={u.uom} blank={null} /></label>
        <label>Dimensions<input name="dimensions" defaultValue={u.dimensions} placeholder="25 x 45" /></label>
        <label>Facing<input name="facing" defaultValue={u.facing} placeholder="North" /></label>
        <label className="wide">Features<input name="features" defaultValue={u.features} /></label>
        {p.premiums.length > 0 && <div className="wide row">{p.premiums.map(x => (
          <label key={x.name} className="check"><input type="checkbox" name={'prem.' + x.name} defaultChecked={u.premiums.includes(x.name)} /> {x.name} ({x.type === 'pct' ? x.value + '%' : 'PKR ' + pkr(x.value)})</label>
        ))}</div>}
        {m.can('edit_pricing') && <label>Plot price (PKR)<input name="price_override" type="number" min="1" defaultValue={u.price_override ?? ''} placeholder="empty = size's list price" /></label>}
        {m.can('edit_pricing') && <label>Down payment (PKR)<input name="down_payment" type="number" min="1" defaultValue={u.down_payment ?? ''} /></label>}
        {error && <p className="error wide">{error}</p>}
        <div className="wide"><button disabled={busy}>Save unit</button></div>
      </form>
    </details>
  )
}

function AddUnits({ project: p, onDone }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [result, setResult] = useState()
  const [lv1, lv2, lv3] = LEVELS[p.kind]
  const submit = e => {
    const b = formData(e)
    const from = +b.from, to = +b.to
    if (!(from >= 0 && to >= from && to - from < 2000)) return run(async () => { throw new Error('Numbers: "to" must be ≥ "from", at most 2000 units') })
    const units = Array.from({ length: to - from + 1 }, (_, i) => ({
      phase: b.phase, block: b.block, street: b.street, unit_no: b.prefix + (from + i), unit_type: b.unit_type, category: b.category, size: b.size || null, uom: b.uom,
    }))
    run(async () => setResult(await api(`/projects/${p.id}/units`, { body: { units } })))
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">Add a range of units</h3>
      <p className="muted wide">Creates one unit per number, e.g. {lv2} A, numbers 1–50. Existing units with the same number are skipped, never overwritten.</p>
      <label>{lv1}<input name="phase" /></label>
      <label>{lv2}<input name="block" /></label>
      <label>{lv3}<input name="street" /></label>
      <label>Number prefix<input name="prefix" placeholder={p.kind === 'building' ? 'e.g. 4' : 'optional'} /></label>
      <label>From *<input name="from" type="number" min="0" defaultValue="1" required /></label>
      <label>To *<input name="to" type="number" min="0" defaultValue="20" required /></label>
      <label>Type<Select name="unit_type" options={m.settings.property_types} defaultValue={p.kind === 'building' ? 'Apartment' : 'Plot'} blank={null} /></label>
      <label>Category<Select name="category" options={['residential', 'commercial']} blank={null} /></label>
      <label>Size<input name="size" type="number" step="0.01" min="0" /></label>
      <label>Unit<Select name="uom" options={UOMS} defaultValue={p.kind === 'building' ? 'sqft' : 'marla'} blank={null} /></label>
      {error && <p className="error wide">{error}</p>}
      {result && <p className="ok wide">Added {result.added} units{result.skipped ? `, skipped ${result.skipped} that already existed` : ''}. <a href="#" onClick={e => { e.preventDefault(); onDone() }}>View inventory</a></p>}
      <div className="wide"><button disabled={busy}>Add units</button></div>
    </form>
  )
}

const UOM_LABEL = { marla: 'Marla', kanal: 'Kanal', sqft: 'sq ft', sqyd: 'sq yd' }
export const sizeName = x => `${+x.size} ${UOM_LABEL[x.uom] || x.uom} ${x.unit_type}`
const COLS = ['Available', 'On Hold', 'Token Received', 'Booked', 'Sold']

function Sizes({ project: p, prices, units, reload }) {
  const m = useMeta()
  const [open, setOpen] = useState(null) // `${key}|price`, `|add`, `|number`, `|delete`
  const [flash, setFlash] = useState('')
  const today = new Date().toISOString()
  const cats = {}
  for (const u of units) if (u.size) (cats[sizeKey(u)] ??= { unit_type: u.unit_type, size: u.size, uom: u.uom, category: u.category, units: [] }).units.push(u)
  for (const l of prices) if (l.per === 'plot') cats[sizeKey(l)] ??= { unit_type: l.unit_type, size: l.size, uom: l.uom, units: [] }
  const rows = Object.values(cats).sort((a, b) => a.unit_type.localeCompare(b.unit_type) || convertArea(a.size, a.uom, 'sqft', p.marla_sqft) - convertArea(b.size, b.uom, 'sqft', p.marla_sqft))
  const noSize = units.filter(u => !u.size).length
  const value = list => list.reduce((s, u) => s + (u.price?.total || 0), 0)
  const count = (list, st) => list.filter(u => u.status === st).length
  const toggle = k => setOpen(open === k ? null : k)

  // the "current" badge: newest effective version per size, and per type for rates
  const current = new Set(Object.values(prices.filter(x => x.effective_from <= today)
    .reduce((c, x) => { const k = x.per === 'plot' ? sizeKey(x) : x.unit_type + '|rate'; return c[k] ? c : { ...c, [k]: x.id } }, {})))

  return (
    <>
      <div className="card scroll">
        {flash && <p className="ok">{flash}</p>}
        <div className="row between"><h3>Plot sizes & inventory</h3><small className="muted">A price per plot for a size takes priority over a rate per marla.</small></div>
        <table className="sizes">
          <thead><tr><th>Size</th><th>Price per plot</th><th>Total</th>{COLS.map(c => <th key={c}>{c}</th>)}<th>Available value</th><th></th></tr></thead>
          <tbody>
            {rows.map(r => {
              const k = sizeKey(r), rate = currentRate(prices, r, today)
              const pending = r.units.filter(u => !u.block && u.unit_no.startsWith(autoPrefix(r.size, r.uom))).length
              const each = rate && unitPrice({ ...r, premiums: [] }, rate, [], p.marla_sqft)
              return [
                <tr key={k}>
                  <td><b>{sizeName(r)}</b>{pending > 0 && <small className="warn"><br />{pending} need plot numbers</small>}</td>
                  <td>{each ? <>PKR {pkr(each.base)}{rate.per !== 'plot' && <small className="muted"><br />at {pkr(rate.rate)} / {rate.per}</small>}</> : <span className="muted">not set</span>}</td>
                  <td><b>{r.units.length}</b></td>
                  {COLS.map(c => <td key={c}>{count(r.units, c) || <span className="muted">0</span>}</td>)}
                  <td>PKR {pkr(value(r.units.filter(u => u.status === 'Available')))}</td>
                  <td className="row nowrap">
                    {m.can('edit_pricing') && <button className="ghost" onClick={() => toggle(k + '|price')}>Change price</button>}
                    {m.can('manage_inventory') && <button className="ghost" onClick={() => toggle(k + '|add')}>Add plots</button>}
                    {m.can('manage_inventory') && pending > 0 && <button className="ghost" onClick={() => toggle(k + '|number')}>Number plots</button>}
                    {m.can('manage_inventory') && <button className="ghost danger" onClick={() => toggle(k + '|delete')}>Delete</button>}
                  </td>
                </tr>,
                open?.startsWith(k + '|') && (
                  <tr key={k + 'f'} className="row-form"><td colSpan={COLS.length + 5}>
                    {open.endsWith('price') && <PriceForm p={p} cat={r} done={() => { setOpen(null); reload() }} />}
                    {open.endsWith('add') && <AddPlots p={p} cat={r} done={() => { setOpen(null); reload() }} />}
                    {open.endsWith('number') && <NumberPlots p={p} cat={r} pending={pending} done={() => { setOpen(null); reload() }} />}
                    {open.endsWith('delete') && <DeleteSize p={p} cat={r} pending={pending} done={msg => { setOpen(null); setFlash(msg); reload() }} />}
                  </td></tr>
                ),
              ]
            })}
            {noSize > 0 && <tr><td colSpan={COLS.length + 5} className="muted">{noSize} units have no size yet. Set it with “Edit unit” on the Inventory tab.</td></tr>}
            {!rows.length && <tr><td colSpan={COLS.length + 5} className="muted">No sizes yet. Add one below, e.g. 5 Marla plot, PKR 50 Lac, 200 plots.</td></tr>}
          </tbody>
          {rows.length > 0 && (
            <tfoot><tr>
              <td><b>Total</b></td><td></td><td><b>{units.length}</b></td>
              {COLS.map(c => <td key={c}><b>{count(units, c)}</b></td>)}
              <td><b>PKR {pkr(value(units.filter(u => u.status === 'Available')))}</b><small className="muted"><br />all units PKR {pkr(value(units))}</small></td><td></td>
            </tr></tfoot>
          )}
        </table>
      </div>

      <div className="cols">
        {m.can('manage_inventory') ? <AddSize p={p} reload={reload} /> : <div />}
        <div className="card scroll">
          <h3>Price history</h3>
          <table>
            <thead><tr><th>Applies to</th><th>Price</th><th>From</th><th>By</th><th></th></tr></thead>
            <tbody>{prices.map(x => (
              <tr key={x.id}>
                <td><b>{x.per === 'plot' ? sizeName(x) : `All ${x.unit_type} sizes`}</b>{x.note && <small className="muted"><br />{x.note}</small>}</td>
                <td className="nowrap">PKR {pkr(x.rate)} / {x.per}</td><td className="nowrap">{x.effective_from.slice(0, 10)}</td><td>{x.created_by_name || '—'}</td>
                <td>{current.has(x.id) ? <span className="status s-booked">current</span> : x.effective_from > today ? <span className="status s-visit-scheduled">scheduled</span> : <span className="muted">past</span>}</td>
              </tr>
            ))}</tbody>
          </table>
          {!prices.length && <p className="muted">No prices yet.</p>}
          {m.can('edit_pricing') && <RateForm p={p} units={units} reload={reload} />}
        </div>
      </div>
    </>
  )
}

function AddSize({ p, reload }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [result, setResult] = useState()
  const submit = e => {
    const form = e.target
    const body = formData(e)
    run(async () => { const r = await api(`/projects/${p.id}/categories`, { body }); setResult({ ...r, name: sizeName(body) }); form.reset(); reload() })
  }
  return (
    <form className="card grid" onSubmit={submit}>
      <h3 className="wide">Add plot size</h3>
      <label>Type<Select name="unit_type" options={m.settings.property_types} defaultValue={p.kind === 'building' ? 'Apartment' : 'Plot'} blank={null} /></label>
      <label>Size *<input name="size" type="number" step="0.01" min="0.01" required placeholder="5" /></label>
      <label>Unit<Select name="uom" options={UOMS} defaultValue={p.kind === 'building' ? 'sqft' : 'marla'} blank={null} /></label>
      {m.can('edit_pricing') && <label>Price per plot (PKR)<input name="price" type="number" min="1" placeholder="5000000" /></label>}
      <label>Block<input name="block" placeholder="e.g. A (optional)" /></label>
      <label>Plot numbers<input name="numbers" placeholder="e.g. 1-50, 55, 60-62" /></label>
      <label>…or number of plots<input name="count" type="number" min="0" max="5000" placeholder="200 (numbered later)" /></label>
      <label>Category<Select name="category" options={['residential', 'commercial']} blank={null} /></label>
      {m.can('edit_pricing') && <label>Price effective from<input name="effective_from" type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></label>}
      {error && <p className="error wide">{error}</p>}
      {result && <p className="ok wide">{result.name}: {result.added ? `added ${result.added} plots (${result.first} to ${result.last})` : 'price saved'}.{result.skipped?.length > 0 && <span className="warn"> Skipped {result.skipped.join(', ')}: already exist.</span>}</p>}
      <div className="wide"><button disabled={busy}>Add size</button></div>
    </form>
  )
}

function PriceForm({ p, cat, done }) {
  const { run, error, busy } = useAction()
  const submit = e => {
    const b = formData(e)
    run(async () => { await api(`/projects/${p.id}/prices`, { body: { ...b, unit_type: cat.unit_type, size: cat.size, uom: cat.uom, per: 'plot' } }); done() })
  }
  return (
    <form className="row" onSubmit={submit}>
      <b>New price for {sizeName(cat)}</b>
      <input name="rate" type="number" min="1" placeholder="Price per plot (PKR)" required autoFocus />
      <input name="effective_from" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required aria-label="Effective from" />
      <input name="note" placeholder="Note (optional)" />
      <button disabled={busy}>Save price</button>
      {error && <span className="error">{error}</span>}
    </form>
  )
}

function AddPlots({ p, cat, done }) {
  const { run, error, busy, setError } = useAction()
  const submit = e => {
    const b = formData(e)
    run(async () => {
      const r = await api(`/projects/${p.id}/categories`, { body: { ...b, unit_type: cat.unit_type, size: cat.size, uom: cat.uom, category: cat.category } })
      if (r.skipped?.length) setError(`Added ${r.added}. Skipped ${r.skipped.join(', ')}: already exist.`)
      else done()
    })
  }
  return (
    <form className="row" onSubmit={submit}>
      <b>Add more {sizeName(cat)}s</b>
      <input name="block" placeholder="Block" autoFocus />
      <input name="numbers" placeholder="Plot numbers, e.g. 1-50" />
      <span className="muted">or</span>
      <input name="count" type="number" min="1" max="5000" placeholder="How many" />
      <button disabled={busy}>Add plots</button>
      {error && <span className="warn">{error}</span>}
    </form>
  )
}

// Deletes plots of one size that are still free (available, no client, never allotted)
function DeleteSize({ p, cat, pending, done }) {
  const { run, error, busy } = useAction()
  const free = cat.units.filter(u => u.status === 'Available' && !u.lead_id).length
  const del = (scope, n) => {
    if (!confirm(`Delete ${n} ${sizeName(cat)}${n === 1 ? '' : 's'}? This cannot be undone.`)) return
    run(async () => {
      const r = await api(`/projects/${p.id}/sizes/delete`, { body: { unit_type: cat.unit_type, size: cat.size, uom: cat.uom, scope } })
      done(`Deleted ${r.deleted} ${sizeName(cat)}${r.deleted === 1 ? '' : 's'}.${r.kept ? ` ${r.kept} kept (held, booked, sold or numbered).` : ''}${r.price_removed ? ' Its price was removed too.' : ''}`)
    })
  }
  return (
    <div className="row">
      <b>Delete {sizeName(cat)}s</b>
      {pending > 0 && <button className="ghost danger" disabled={busy} onClick={() => del('unnumbered', pending)}>Delete {pending} un-numbered</button>}
      <button className="danger-solid" disabled={busy || (!free && cat.units.length > 0)} onClick={() => del('all', free)}>
        {cat.units.length ? `Delete all ${free} available` : 'Remove this size'}
      </button>
      <small className="muted">Held, booked, sold and allotted plots are never deleted.</small>
      {error && <span className="error">{error}</span>}
    </div>
  )
}

// Turns auto-numbered plots ("5M-1"…) into real block / plot numbers, in order
function NumberPlots({ p, cat, pending, done }) {
  const { run, error, busy } = useAction()
  const submit = e => {
    const b = formData(e)
    run(async () => { await api(`/projects/${p.id}/number`, { body: { ...b, unit_type: cat.unit_type, size: cat.size, uom: cat.uom } }); done() })
  }
  return (
    <form className="row" onSubmit={submit}>
      <b>Number {pending} {sizeName(cat)}s</b>
      <input name="block" placeholder="Block" required autoFocus />
      <input name="numbers" placeholder="Plot numbers, e.g. 1-40" required />
      <button disabled={busy}>Assign numbers</button>
      {error && <span className="error">{error}</span>}
    </form>
  )
}

// Type-wide rate (e.g. PKR 12 Lac per marla) for sizes without their own per-plot price
function RateForm({ p, units, reload }) {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const submit = e => {
    const form = e.target
    const body = formData(e)
    run(async () => { await api(`/projects/${p.id}/prices`, { body }); form.reset(); reload() })
  }
  return (
    <details>
      <summary><b>Rate per marla / sq ft for all sizes</b></summary>
      <form className="grid" onSubmit={submit}>
        <label>Type<Select name="unit_type" options={[...new Set([...units.map(u => u.unit_type), ...m.settings.property_types])]} required /></label>
        <label>Rate (PKR)<input name="rate" type="number" min="1" required /></label>
        <label>Per<Select name="per" options={UOMS} blank={null} /></label>
        <label>Effective from<input name="effective_from" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
        {error && <p className="error wide">{error}</p>}
        <div className="wide"><button disabled={busy}>Add rate</button></div>
      </form>
    </details>
  )
}

function Setup({ project: p, reload }) {
  const { run, error, busy } = useAction()
  const [prem, setPrem] = useState(p.premiums)
  const [ok, setOk] = useState(false)
  const submit = e => {
    const b = formData(e)
    run(async () => {
      await api('/projects/' + p.id, { method: 'PATCH', body: { ...b, premiums: JSON.stringify(prem.filter(x => x.name).map(x => ({ ...x, value: +x.value }))) } })
      setOk(true); reload()
    })
  }
  const uploadMap = e => {
    const file = e.target.files[0]
    if (!file || (p.has_map && !confirm('Replace the map? Every plot will need linking again.'))) return (e.target.value = '')
    run(async () => { await api(`/projects/${p.id}/map`, { method: 'PUT', body: { svg: await file.text() } }); e.target.value = ''; reload() })
  }
  const edit = (i, k) => e => setPrem(prem.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))
  return (
    <form className="card grid" onSubmit={submit} onChange={() => setOk(false)}>
      <label>Name<input name="name" defaultValue={p.name} required /></label>
      <label>City<input name="city" defaultValue={p.city} /></label>
      <label>Layout<Select name="kind" options={[['land', 'Land'], ['building', 'Building']]} defaultValue={p.kind} blank={null} /></label>
      <label>1 marla = sq ft<input name="marla_sqft" type="number" step="0.01" min="1" defaultValue={p.marla_sqft} required /></label>
      <label>Hold duration (hours)<input name="hold_hours" type="number" min="1" defaultValue={p.hold_hours} required /></label>
      <label className="wide">Notes<textarea name="notes" rows="2" defaultValue={p.notes} /></label>
      <div className="wide">
        <h3>Premium factors</h3>
        <p className="muted">Added on top of the base price for units that have them, e.g. Corner +10%, Park facing +PKR 5 Lac.</p>
        {prem.map((x, i) => (
          <div key={i} className="row prem">
            <input placeholder="Name (e.g. Corner)" value={x.name} onChange={edit(i, 'name')} />
            <Select value={x.type} onChange={edit(i, 'type')} options={[['pct', '% of base'], ['fixed', 'Fixed PKR']]} blank={null} />
            <input type="number" min="0" step="0.01" value={x.value} onChange={edit(i, 'value')} aria-label="Value" />
            <button type="button" className="ghost" onClick={() => setPrem(prem.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" className="ghost" onClick={() => setPrem([...prem, { name: '', type: 'pct', value: 0 }])}>+ Add premium</button>
      </div>
      <div className="wide">
        <h3>Plot map</h3>
        <p className="muted">An SVG with the plan as an image and each plot as a path inside {'<g id="plots">'}. {p.has_map ? 'Uploading a new map unlinks every plot.' : 'No map yet.'}</p>
        <input type="file" accept=".svg,image/svg+xml" onChange={uploadMap} />
      </div>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Save project</button>{ok && <span className="ok">Saved</span>}</div>
    </form>
  )
}

function Allotments({ project: p, onChange }) {
  const [rows, reload] = useApi(`/projects/${p.id}/allotments`)
  const { run, error } = useAction()
  const cancel = a => {
    const note = prompt(`Cancel allotment ${a.allotment_no} for ${a.client}? The plot becomes available again.\n\nReason:`)
    if (note?.trim()) run(async () => { await api(`/allotments/${a.id}/cancel`, { body: { note } }); reload(); onChange() })
  }
  const active = rows?.filter(a => a.status === 'active') || []
  return (
    <div className="card scroll">
      <div className="row between">
        <h3>Allotments <span className="count">{active.length}</span></h3>
        <small className="muted">Total sold value PKR {pkr(active.reduce((s, a) => s + a.price, 0))}</small>
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>No.</th><th>Plot</th><th>Client</th><th>Sale price</th><th>Date</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows?.map(a => (
            <tr key={a.id} className={a.status === 'cancelled' ? 'muted' : ''}>
              <td><b>{a.allotment_no}</b></td>
              <td>{label(a, p.kind) || '—'} #{a.unit_no}<small className="muted"><br />{sizeName(a)}</small></td>
              <td><a href={'#/leads/' + a.lead_id}>{a.client}</a><small className="muted"><br />{phone(a.phone)}</small></td>
              <td className="nowrap">PKR {pkr(a.price)}{a.list_price > a.price && <small className="warn"><br />{pkr(a.list_price - a.price)} below list</small>}</td>
              <td className="nowrap">{a.sale_date}</td>
              <td>{a.status === 'active' ? <span className={'status ' + cls(a.sale_status)}>{a.sale_status}</span> : <span className="status u-cancelled" title={a.cancel_note}>Cancelled</span>}</td>
              <td className="row nowrap">
                <a className="button ghost" href={'#/allotments/' + a.id}>Letter</a>
                <a className="button ghost" href={'#/ledger/' + a.id}>Ledger</a>
                {a.status === 'active' && <button className="ghost danger" onClick={() => cancel(a)}>Cancel</button>}
              </td>
            </tr>
          ))}
          {rows?.length === 0 && <tr><td colSpan="7" className="muted">No plots assigned yet. Open a unit on the Inventory tab and use “Assign plot to client”.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

export function AllotmentLetter({ id }) {
  const [a, , loadError] = useApi('/allotments/' + id)
  if (loadError) return <p className="error">{loadError}</p>
  if (!a) return <p className="muted">Loading…</p>
  const where = [[LEVELS[a.kind][0], a.phase], [LEVELS[a.kind][1], a.block], [LEVELS[a.kind][2], a.street]].filter(([, v]) => v)
  const sqft = a.size ? Math.round(convertArea(a.size, a.uom, 'sqft', a.marla_sqft)) : null
  return (
    <section>
      <div className="row between no-print">
        <a href={'#/projects/' + a.project_id} className="muted">← {a.project}</a>
        <div className="row"><a className="button ghost" href={'#/ledger/' + a.id}>Payments ledger</a><button onClick={() => print()}>Print letter</button></div>
      </div>
      <article className="card letter">
        {a.status === 'cancelled' && <div className="stamp">Cancelled</div>}
        <header className="row between">
          <img src={logoImg} alt="Estate Centric" />
          <div className="right"><small>Allotment No.</small><b>{a.allotment_no}</b><small>Date: {a.sale_date}</small></div>
        </header>
        <h1>{a.sale_status === 'Booked' ? 'Booking Confirmation' : 'Allotment Letter'}</h1>
        <p>
          This is to certify that the following {a.unit_type.toLowerCase()} in <b>{a.project}</b>{a.city && `, ${a.city}`} has been
          {a.sale_status === 'Booked' ? ' booked for ' : ' allotted to '} <b>{a.client}</b>{a.cnic && <> (CNIC {a.cnic})</>} on {a.sale_date},
          subject to the terms and conditions of the company.
        </p>
        <table className="letter-table"><tbody>
          <tr><th>Project</th><td>{a.project}</td></tr>
          {where.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}
          <tr><th>{a.kind === 'building' ? 'Unit' : 'Plot'} No.</th><td>{a.unit_no}</td></tr>
          <tr><th>Size</th><td>{a.size ? `${+a.size} ${a.uom}${sqft && a.uom !== 'sqft' ? ` (${sqft.toLocaleString()} sq ft)` : ''}` : '—'}</td></tr>
          <tr><th>Type</th><td>{a.unit_type}, {a.category}</td></tr>
          <tr><th>Price</th><td>PKR {Number(a.price).toLocaleString('en-PK')}</td></tr>
          {a.down_payment && <tr><th>Down payment</th><td>PKR {Number(a.down_payment).toLocaleString('en-PK')}<br /><small>Balance PKR {Number(a.price - a.down_payment).toLocaleString('en-PK')}</small></td></tr>}
          <tr><th>Allottee</th><td>{a.client}<br /><small>{phone(a.phone)}{a.email && ` · ${a.email}`}</small></td></tr>
        </tbody></table>
        {a.note && <p><small>Note: {a.note}</small></p>}
        <div className="signs">
          <div><span />Allottee</div>
          <div><span />Authorised Signatory<br /><small>Estate Centric</small></div>
        </div>
        <footer><small>Issued by {a.created_by_name || 'Estate Centric'} · This letter is valid only with the company stamp and an authorised signature.</small></footer>
      </article>
    </section>
  )
}

// Printable sheet of Code 128 barcode labels, one per unit shown (so the filters above choose which). Code is U + unit id.
function BarcodeSheet({ p, units, onClose }) {
  const box = useRef()
  useEffect(() => { box.current.querySelectorAll('svg[data-code]').forEach(el => JsBarcode(el, el.dataset.code, { format: 'CODE128', height: 40, width: 1.6, fontSize: 11, margin: 0 })) }, [units])
  return createPortal(
    <div className="barcode-sheet" ref={box}>
      <div className="no-print row between">
        <b>{units.length} barcode label{units.length === 1 ? '' : 's'}</b>
        <div className="row"><button onClick={() => print()}>Print</button><button className="ghost" onClick={onClose}>Close</button></div>
      </div>
      <div className="barcode-grid">
        {units.map(u => <div key={u.id} className="barcode-label">
          <small>{p.name}</small>
          <b>{[u.phase, u.block, u.street].filter(Boolean).join(' / ')} #{u.unit_no}</b>
          <svg data-code={'U' + u.id} />
        </div>)}
      </div>
    </div>,
    document.body
  )
}
