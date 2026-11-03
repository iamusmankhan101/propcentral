import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useMeta } from './api.js'
import { STATUS_COLOR, propLabel } from './Properties.jsx'
const MAP_LOCATIONS = {
  Lahore: { center: [74.3436, 31.5204], country: 'pk' },
  Dubai: { center: [55.2708, 25.2048], country: 'ae' },
}
const EMPTY = { type: 'FeatureCollection', features: [] }
const AREA_COLOR = { Society: '#ffffff', Phase: '#ffd54a', Block: '#5ad1ff' }
const polygon = ring => ({ type: 'Polygon', coordinates: [[...ring, ring[0]]] })

// Satellite map with:
//  - society / phase / block boundaries (areas), named on the map
//  - a pin per property, plus its plot outline, coloured by lease status
// layer 'properties' | 'societies' decides what clicks select. placing = { mode: 'pin' | 'outline', target } turns clicks into a position or outline.
// overlays = uploaded society maps drawn under everything; placing.mode 'match' collects [map spot, real spot] pairs to align one.
export default function PropertyMap({ rows, areas, overlays, layer, sel, selArea, city = 'Lahore', mode = '2d', bearing = 0, onSelect, onSelectArea, placing, onPlace, onCancel, onCity, onMode, clean = false }) {
  const { maptiler_key: key, me } = useMeta()
  const box = useRef(), map = useRef(), live = useRef({})
  const [ready, setReady] = useState(false)
  const [points, setPoints] = useState([])
  live.current = { onSelect, onSelectArea, placing, onPlace, layer }

  useEffect(() => {
    if (!key) return
    const location = MAP_LOCATIONS[city] || MAP_LOCATIONS.Lahore
    const m = new maplibregl.Map({ container: box.current, style: `https://api.maptiler.com/maps/hybrid/style.json?key=${key}`, center: location.center, zoom: mode === '3d' ? 15.5 : 11, pitch: mode === '3d' ? 55 : 0, bearing, maxPitch: 85, attributionControl: { compact: true } })
    m.addControl(new maplibregl.NavigationControl(), 'top-right')
    m.on('load', () => {
      // place names in English: English name, else the international / Latin-script name, never the Urdu one if any of those exist
      let font
      for (const l of m.getStyle().layers) {
        if (l.type !== 'symbol') continue
        font ??= l.layout?.['text-font']
        if (l.layout?.['text-field']) m.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']])
      }
      m.addSource('areas', { type: 'geojson', data: EMPTY })
      m.addSource('props', { type: 'geojson', data: EMPTY })
      m.addSource('draft', { type: 'geojson', data: EMPTY })
      const isPoly = ['==', ['geometry-type'], 'Polygon']
      m.addLayer({ id: 'area-fill', type: 'fill', source: 'areas', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'sel'], 0.3, ['get', 'active'], 0.12, 0] } })
      try {
        m.addSource('maptiler_buildings', { type: 'vector', url: `https://api.maptiler.com/tiles/buildings/tiles.json?key=${key}` })
        m.addLayer({ id: 'building-3d', type: 'fill-extrusion', source: 'maptiler_buildings', 'source-layer': 'building', minzoom: 13, filter: ['!', ['has', 'hide_3d']], layout: { visibility: mode === '3d' ? 'visible' : 'none' }, paint: {
          'fill-extrusion-color': ['coalesce', ['get', 'facade_color'], ['get', 'roof_color'], ['interpolate', ['linear'], ['coalesce', ['get', 'height'], ['get', 'render_height'], 0], 0, '#d7c7b5', 30, '#c5b8aa', 90, '#9aabbc', 220, '#627d97']], 'fill-extrusion-height': ['coalesce', ['get', 'height'], ['get', 'render_height'], ['*', ['coalesce', ['get', 'levels'], 1], 3.2]], 'fill-extrusion-base': ['coalesce', ['get', 'height_min'], ['get', 'render_min_height'], ['get', 'min_height'], 0], 'fill-extrusion-opacity': 0.95,
        } }, 'area-fill')
      } catch (e) { console.warn('MapTiler 3D buildings unavailable', e) }
      m.addLayer({ id: 'area-line', type: 'line', source: 'areas', paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'sel'], 4, ['==', ['get', 'kind'], 'Society'], 2.5, 1.5], 'line-opacity': 0.9 } })
      m.addLayer({ id: 'area-label', type: 'symbol', source: 'areas', layout: { 'text-field': ['get', 'name'], 'text-font': font || ['Noto Sans Bold'], 'text-size': ['match', ['get', 'kind'], 'Society', 16, 'Phase', 13, 11], 'text-allow-overlap': false },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': 'rgba(0,0,0,.75)', 'text-halo-width': 1.5 } })
      m.addLayer({ id: 'plot-fill', type: 'fill', source: 'props', filter: isPoly, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'sel'], 0.45, 0.25] } })
      m.addLayer({ id: 'plot-line', type: 'line', source: 'props', filter: isPoly, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'sel'], 3, 1.5] } })
      m.addLayer({ id: 'pins', type: 'circle', source: 'props', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': ['case', ['get', 'sel'], 10, 7], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      m.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#ffcc00', 'line-width': 2, 'line-dasharray': [2, 1] } })
      m.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': ['coalesce', ['get', 'c'], '#ffcc00'], 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } })
      try {
        m.addSource('terrain', { type: 'raster-dem', url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${key}`, tileSize: 512, maxzoom: 14 })
        m.setTerrain({ source: 'terrain', exaggeration: 1 })
      } catch (e) { console.warn('MapTiler terrain unavailable', e) }
      setReady(true)
    })
    m.on('click', e => {
      const { placing, onPlace, onSelect, onSelectArea, layer } = live.current
      const at = [+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)]
      if (placing?.mode === 'pin') return onPlace({ lng: at[0], lat: at[1] })
      if (placing?.mode === 'outline' || placing?.mode === 'match') return setPoints(p => [...p, at])
      if (layer === 'societies') { // smallest area under the click: block before phase before society
        const hits = m.queryRenderedFeatures(e.point, { layers: ['area-fill'] })
        const order = { Block: 0, Phase: 1, Society: 2 }
        const f = hits.sort((a, b) => order[a.properties.kind] - order[b.properties.kind])[0]
        return onSelectArea(f ? f.properties.id : null)
      }
      const f = m.queryRenderedFeatures(e.point, { layers: ['pins', 'plot-fill'] })[0]
      if (f) onSelect(f.properties.id)
    })
    for (const l of ['pins', 'plot-fill', 'area-fill']) {
      m.on('mousemove', l, () => {
        const { placing, layer } = live.current
        if (!placing && (l === 'area-fill') === (layer === 'societies')) m.getCanvas().style.cursor = 'pointer'
      })
      m.on('mouseleave', l, () => { if (!live.current.placing) m.getCanvas().style.cursor = '' })
    }
    map.current = m
    return () => { m.remove(); map.current = null; setReady(false) }
  }, [key])

  useEffect(() => {
    if (!ready) return
    const m = map.current
    if (!m) return
    const location = MAP_LOCATIONS[city] || MAP_LOCATIONS.Lahore
    m.easeTo({ center: location.center, pitch: mode === '3d' ? 55 : 0, bearing, zoom: mode === '3d' ? 15.5 : 11, duration: 700 })
  }, [ready, city, mode, bearing])

  useEffect(() => {
    if (!ready || !map.current?.getLayer('building-3d')) return
    map.current.setLayoutProperty('building-3d', 'visibility', mode === '3d' ? 'visible' : 'none')
  }, [ready, mode])

  useEffect(() => {
    if (!ready || !map.current) return
    const showLabels = city === 'Lahore'
    for (const l of map.current.getStyle().layers || []) {
      if (l.type === 'symbol' && l.source !== 'areas') map.current.setLayoutProperty(l.id, 'visibility', showLabels ? 'visible' : 'none')
    }
  }, [ready, city])

  useEffect(() => {
    if (!ready) return
    const m = map.current
    if (!m || !m.getSource('areas')) return
    m.getSource('areas').setData({ type: 'FeatureCollection', features: (areas || []).map(a => ({
      type: 'Feature', geometry: polygon(a.outline),
      properties: { id: a.id, name: a.name, kind: a.kind, color: AREA_COLOR[a.kind], sel: layer === 'societies' && a.id === selArea, active: layer === 'societies' },
    })) })
    for (const l of ['pins', 'plot-fill', 'plot-line']) if (m.getLayer(l)) m.setPaintProperty(l, l === 'pins' ? 'circle-opacity' : l === 'plot-fill' ? 'fill-opacity' : 'line-opacity', layer === 'societies' ? 0.35 : 1)
    if (m.getLayer('pins')) m.setPaintProperty('pins', 'circle-stroke-opacity', layer === 'societies' ? 0.35 : 1)
  }, [ready, areas, layer, selArea])

  useEffect(() => {
    if (!ready) return
    const m = map.current
    if (!m || !m.getSource('props')) return
    const features = rows.filter(p => p.lat != null).flatMap(p => {
      const props = { id: p.id, color: STATUS_COLOR[p.status], sel: p.id === sel }
      return [
        { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } },
        ...(p.outline ? [{ type: 'Feature', properties: props, geometry: polygon(p.outline) }] : []),
      ]
    })
    m.getSource('props').setData({ type: 'FeatureCollection', features })
  }, [ready, rows, sel])

  // first load: fit to everything drawn or pinned
  const fitted = useRef(false)
  useEffect(() => {
    const pts = [...rows.filter(p => p.lat != null).map(p => [p.lng, p.lat]), ...(areas || []).flatMap(a => a.outline)]
    if (!ready || fitted.current || !pts.length) return
    fitted.current = true
    map.current.fitBounds(pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0])), { padding: 60, maxZoom: 16, duration: 0 })
  }, [ready, rows, areas])

  // fly to the selected property / area
  useEffect(() => {
    const p = rows.find(x => x.id === sel)
    if (ready && p?.lat != null) map.current.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.current.getZoom(), 16) })
  }, [ready, sel]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const a = areas?.find(x => x.id === selArea)
    if (ready && a) map.current.fitBounds(a.outline.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(a.outline[0], a.outline[0])), { padding: 80, maxZoom: 17 })
  }, [ready, selArea]) // eslint-disable-line react-hooks/exhaustive-deps

  // drawing: show the points and the closing line
  useEffect(() => {
    if (!ready) return
    map.current.getCanvas().style.cursor = placing ? 'crosshair' : ''
    if (!placing) setPoints([])
  }, [ready, placing])
  useEffect(() => {
    if (!ready) return
    const m = map.current
    if (!m || !m.getSource('draft')) return
    const match = placing?.mode === 'match', ring = points.length > 2 ? [...points, points[0]] : points
    const pt = (c, color) => ({ type: 'Feature', properties: { c: color }, geometry: { type: 'Point', coordinates: c } })
    m.getSource('draft').setData({ type: 'FeatureCollection', features: match
      ? points.flatMap((c, i) => [pt(c, i % 2 ? '#2ee66b' : '#ff8a00'), ...(i % 2 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [points[i - 1], c] } }] : [])])
      : [...points.map(c => pt(c)), ...(points.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } }] : [])] })
  }, [ready, points, placing])

  // uploaded society maps: one image layer each, under the boundaries and pins
  const shownImage = useRef({}) // source id → which image version is on the map
  useEffect(() => {
    if (!ready) return
    let alive = true
    const m = map.current, want = (overlays || []).filter(o => o.visible), ids = new Set(want.map(o => 'ov-' + o.id))
    for (const id of Object.keys(m.getStyle().sources)) if (id.startsWith('ov-') && !ids.has(id)) { m.removeLayer(id); m.removeSource(id); delete shownImage.current[id] }
    for (const o of want) {
      const id = 'ov-' + o.id, src = m.getSource(id), version = `${o.token}:${o.clear_white}`
      if (src && shownImage.current[id] === version) {
        if (!(placing?.mode === 'adjust' && placing.id === o.id)) src.setCoordinates(o.corners) // don't undo a drag in progress
        m.setPaintProperty(id, 'raster-opacity', o.opacity)
        continue
      }
      overlayImage(o).then(url => {
        if (!alive) return
        if (m.getSource(id)) m.getSource(id).updateImage({ url, coordinates: o.corners })
        else {
          m.addSource(id, { type: 'image', url, coordinates: o.corners })
          m.addLayer({ id, type: 'raster', source: id, paint: { 'raster-fade-duration': 0 } }, 'area-fill')
        }
        shownImage.current[id] = version
        m.setPaintProperty(id, 'raster-opacity', o.opacity)
      })
    }
    return () => { alive = false }
  }, [ready, overlays, placing])

  if (!key) return (
    <div className="card map-missing">
      <h3>Satellite map not set up yet</h3>
      <p className="muted">{me.role === 'admin'
        ? <>Add the Mapbox public token to the app's <b>VITE_MAPBOX_TOKEN</b> environment variable.</>
        : 'Ask an admin to configure the Mapbox public token.'} The list view works in the meantime.</p>
    </div>
  )
  const finish = () => {
    const lng = points.reduce((s, p) => s + p[0], 0) / points.length, lat = points.reduce((s, p) => s + p[1], 0) / points.length
    onPlace({ outline: points, lng: +lng.toFixed(6), lat: +lat.toFixed(6) })
  }
  const adjusting = placing?.mode === 'adjust' && (overlays || []).find(o => o.id === placing.id)
  const pairs = Math.floor(points.length / 2)
  const what = placing?.mode === 'match'
    ? (points.length % 2 ? 'Now click the SAME spot on the satellite (green).' : `Click a clear spot on the society map, e.g. a road corner or roundabout (orange). ${pairs} matched${pairs < 2 ? ', 2+ needed' : pairs < 3 ? ', 3+ also fixes stretch' : ''}.`)
    : { new: 'Click where the new property is.', property: 'Click the property to move its pin.', area: 'Click around the boundary, corner by corner', 'area-redraw': 'Click around the new boundary, corner by corner', plot: 'Click each corner of the plot' }[placing?.target]
  return (
    <div className="prop-map">
      <div ref={box} className="prop-map-canvas" />
      {ready && adjusting && <AdjustOverlay map={map.current} overlay={adjusting} onSave={corners => onPlace({ corners })} onCancel={onCancel} />}
      {ready && !placing && <MapSearch map={map.current} mapKey={key} rows={rows} areas={areas || []} city={city} onSelect={onSelect} onSelectArea={layer === 'societies' ? onSelectArea : null} />}
      {!clean && !placing && <div className="map-controls">
        <label>Location<select value={city} onChange={e => onCity?.(e.target.value)}><option>Lahore</option><option>Dubai</option></select></label>
        <div className="seg small"><button className={mode === '2d' ? 'on' : ''} onClick={() => onMode?.('2d')}>2D</button><button className={mode === '3d' ? 'on' : ''} onClick={() => onMode?.('3d')}>3D</button></div>
      </div>}
      {placing && placing.mode !== 'adjust' && (
        <div className="map-hint">
          {what}{placing.mode === 'outline' && ` (${points.length} so far)`}
          {placing.mode === 'match' && <button onClick={() => setPoints(p => p.slice(0, -1))} disabled={!points.length}>Undo</button>}
          {placing.mode === 'match' && <button onClick={() => onPlace({ pairs: Array.from({ length: pairs }, (_, i) => [points[2 * i], points[2 * i + 1]]) })} disabled={pairs < 2}>Align map</button>}
          {placing.mode === 'outline' && <button onClick={() => setPoints(p => p.slice(0, -1))} disabled={!points.length}>Undo point</button>}
          {placing.mode === 'outline' && <button onClick={finish} disabled={points.length < 3}>Finish</button>}
          <button className="ghost" onClick={onCancel}>Cancel</button>
        </div>
      )}
      {!clean && <div className="prop-legend">
        {layer === 'societies'
          ? Object.entries(AREA_COLOR).map(([k, c]) => <span key={k}><i className="ring" style={{ borderColor: c === '#ffffff' ? '#555' : c }} />{k}</span>)
          : Object.entries(STATUS_COLOR).filter(([k]) => k !== 'Rent overdue').map(([k, c]) => <span key={k}><i style={{ background: c }} />{k === 'Ending soon' ? 'Ending soon / rent overdue' : k}</span>)}
      </div>}
    </div>
  )
}

// Search box on the map: your properties and drawn areas first, then nearby places (Mapbox geocoding)
function MapSearch({ map, mapKey, rows, areas, city, onSelect, onSelectArea }) {
  const [q, setQ] = useState('')
  const [places, setPlaces] = useState([])
  const [open, setOpen] = useState(false)
  const [i, setI] = useState(0)
  const marker = useRef()
  const t = q.trim().toLowerCase()
  const props = t.length < 2 ? [] : rows.filter(p => [propLabel(p), p.owner_name, p.lease?.tenant_name, p.address, p.street && `street ${p.street}`].join(' ').toLowerCase().includes(t)).slice(0, 5)
  const zones = t.length < 2 ? [] : areas.filter(a => a.name.toLowerCase().includes(t)).slice(0, 4)
  useEffect(() => {
    if (t.length < 3) return setPlaces([])
    const location = MAP_LOCATIONS[city] || MAP_LOCATIONS.Lahore
    const ctl = new AbortController(), timer = setTimeout(() =>
      fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(q.trim())}.json?key=${mapKey}&country=${location.country}&proximity=${location.center.join(',')}&language=en&limit=5`, { signal: ctl.signal })
        .then(r => r.json()).then(d => setPlaces(d.features || [])).catch(() => {}), 300)
    return () => { clearTimeout(timer); ctl.abort() }
  }, [q, city]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => marker.current?.remove(), [])
  const fit = ring => map.fitBounds(ring.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(ring[0], ring[0])), { padding: 80, maxZoom: 17 })
  const results = [
    ...props.map(p => ({ key: 'p' + p.id, label: propLabel(p), sub: [p.owner_name && `Owner ${p.owner_name}`, p.lease?.tenant_name && `Tenant ${p.lease.tenant_name}`, p.lat == null && 'not on map'].filter(Boolean).join(' · '), kind: 'Property',
      go: () => onSelect(p.id) })), // the map flies to it if it has a pin
    ...zones.map(a => ({ key: 'a' + a.id, label: a.name, sub: a.kind, kind: 'Area', go: () => { fit(a.outline); onSelectArea?.(a.id) } })),
    ...places.map(f => ({ key: 'g' + f.id, label: f.text || f.place_name, sub: f.place_name, kind: 'Place', go: () => {
      marker.current?.remove()
      marker.current = new maplibregl.Marker({ color: '#ff8a00' }).setLngLat(f.center).addTo(map)
      if (f.bbox) map.fitBounds([[f.bbox[0], f.bbox[1]], [f.bbox[2], f.bbox[3]]], { padding: 60, maxZoom: 17 })
      else map.flyTo({ center: f.center, zoom: 16 })
    } })),
  ]
  const pick = r => { r.go(); setQ(r.label); setOpen(false) }
  const key = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && results[i]) { e.preventDefault(); pick(results[i]) }
    else if (e.key === 'Escape') setOpen(false)
  }
  return (
    <div className="map-search">
      <input value={q} placeholder="Search house no., owner, society, road, place…" aria-label="Search the map"
        onChange={e => { setQ(e.target.value); setOpen(true); setI(0) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={key} />
      {q && <button className="clear" onClick={() => { setQ(''); setPlaces([]); marker.current?.remove() }} aria-label="Clear search">×</button>}
      {open && t.length >= 2 && (
        <ul role="listbox">
          {results.map((r, n) => (
            <li key={r.key} role="option" aria-selected={n === i} className={n === i ? 'on' : ''} onMouseDown={() => pick(r)} onMouseEnter={() => setI(n)}>
              <span className="kind">{r.kind}</span><b>{r.label}</b>{r.sub && <small>{r.sub}</small>}
            </li>
          ))}
          {!results.length && <li className="none">{t.length < 3 ? 'Keep typing…' : 'Nothing found'}</li>}
        </ul>
      )}
    </div>
  )
}

// Align a society plan by hand: drag the middle to move, a corner to resize + turn (or stretch it freely), fine-tune with buttons.
// Turning and scaling are done in metres-like local units (a degree of longitude is shorter than one of latitude in Lahore).
function AdjustOverlay({ map, overlay, onSave, onCancel }) {
  const cur = useRef(overlay.corners.map(p => [...p]))
  const handles = useRef([])
  const [stretch, setStretch] = useState(false)
  const stretchRef = useRef(stretch)
  stretchRef.current = stretch
  const centre = cs => [cs.reduce((s, p) => s + p[0], 0) / 4, cs.reduce((s, p) => s + p[1], 0) / 4]
  const turnScale = (cs, angle, scale, c = centre(cs)) => {
    const k = Math.cos(c[1] * Math.PI / 180), cos = Math.cos(angle), sin = Math.sin(angle)
    return cs.map(([x, y]) => { const X = (x - c[0]) * k, Y = y - c[1]; return [c[0] + scale * (X * cos - Y * sin) / k, c[1] + scale * (X * sin + Y * cos)] })
  }
  const show = cs => {
    cur.current = cs
    map.getSource('ov-' + overlay.id)?.setCoordinates(cs)
    handles.current.forEach((h, i) => h.setLngLat(i < 4 ? cs[i] : centre(cs)))
  }
  useEffect(() => {
    const el = cls => Object.assign(document.createElement('div'), { className: 'ov-handle ' + cls })
    let start
    const corners = [0, 1, 2, 3].map(i => {
      const h = new maplibregl.Marker({ element: el('corner'), draggable: true }).setLngLat(cur.current[i]).addTo(map)
      h.on('dragstart', () => { start = cur.current.map(p => [...p]) })
      h.on('drag', () => {
        const p = h.getLngLat().toArray()
        if (stretchRef.current) return show(start.map((q, j) => (j === i ? p : q)))
        const c = centre(start), k = Math.cos(c[1] * Math.PI / 180)
        const v0 = [(start[i][0] - c[0]) * k, start[i][1] - c[1]], v1 = [(p[0] - c[0]) * k, p[1] - c[1]]
        show(turnScale(start, Math.atan2(v1[1], v1[0]) - Math.atan2(v0[1], v0[0]), Math.hypot(...v1) / Math.hypot(...v0), c))
      })
      return h
    })
    const mid = new maplibregl.Marker({ element: el('move'), draggable: true }).setLngLat(centre(cur.current)).addTo(map)
    mid.on('dragstart', () => { start = cur.current.map(p => [...p]) })
    mid.on('drag', () => {
      const [x, y] = mid.getLngLat().toArray(), [cx, cy] = centre(start)
      show(start.map(([a, b]) => [a + x - cx, b + y - cy]))
    })
    handles.current = [...corners, mid]
    return () => {
      handles.current.forEach(h => h.remove())
      map.getSource('ov-' + overlay.id)?.setCoordinates(overlay.corners) // back to the saved spot; a save reloads the new one
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const nudge = (deg, scale) => show(turnScale(cur.current, deg * Math.PI / 180, scale))
  return (
    <div className="map-hint">
      Drag the <b>middle</b> to move · drag a <b>corner</b> to resize and turn
      <label className="check"><input type="checkbox" checked={stretch} onChange={e => setStretch(e.target.checked)} /> Stretch corners freely</label>
      <span className="row nudge">
        <button className="ghost" onClick={() => nudge(0.5, 1)} title="Turn left">↺</button><button className="ghost" onClick={() => nudge(-0.5, 1)} title="Turn right">↻</button>
        <button className="ghost" onClick={() => nudge(0, 0.99)} title="Smaller">−</button><button className="ghost" onClick={() => nudge(0, 1.01)} title="Bigger">+</button>
      </span>
      <button onClick={() => onSave(cur.current)}>Save</button>
      <button className="ghost" onClick={onCancel}>Cancel</button>
    </div>
  )
}

// A plan's white paper becomes see-through, fading over a few shades so plot edges stay smooth.
// Only greys and whites go (low colour), so pale yellow / pink / green plot fills are kept. Done once per image, then cached.
const images = new Map()
function overlayImage(o) {
  const url = '/api/overlay-images/' + o.token
  if (!o.clear_white) return Promise.resolve(url)
  if (!images.has(o.token)) images.set(o.token, new Promise((ok, fail) => {
    const img = new Image()
    img.onload = () => {
      const c = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight }), g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 0, c.width, c.height), px = d.data
      for (let i = 0; i < px.length; i += 4) {
        const lo = Math.min(px[i], px[i + 1], px[i + 2]), hi = Math.max(px[i], px[i + 1], px[i + 2])
        if (hi - lo < 28 && lo > 215) px[i + 3] = lo >= 245 ? 0 : Math.round(px[i + 3] * (245 - lo) / 30)
      }
      g.putImageData(d, 0, 0)
      c.toBlob(b => ok(URL.createObjectURL(b)), 'image/png')
    }
    img.onerror = fail
    img.src = url
  }))
  return images.get(o.token)
}
