// Pure business logic, no DB. Covered by lib.test.js.

// Shared rule for every place a password is set (sign-up, reset, admin create/change, self-service)
const COMMON_PASSWORDS = new Set([
  'password123', 'password1234', '1234567890', 'qwertyuiop', 'admin12345', 'propcentral',
  'letmein123', 'welcome123', 'changeme123', 'password!1', 'iloveyou123',
])
export function passwordProblem(pw) {
  const p = String(pw ?? '')
  if (p.length < 10) return 'Password must be at least 10 characters'
  if (p.length > 200) return 'Password is too long'
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Password must include a letter and a number'
  if (COMMON_PASSWORDS.has(p.toLowerCase())) return 'Pick a password that is harder to guess'
  return null
}

// M1.2: 03xx / +923xx / 923xx / 00923xx -> 923xxxxxxxxx. Non-PK numbers keep their digits.
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (d.startsWith('0092')) d = d.slice(2)
  else if (d.startsWith('03') && d.length === 11) d = '92' + d.slice(1)
  else if (d.startsWith('3') && d.length === 10) d = '92' + d
  return d.length >= 10 ? d : null
}

export const maskPhone = p => (p ? p.slice(0, 5) + '*****' + p.slice(-2) : p)

// M3.2: rule.when = { source: 'facebook', city: ['Lahore','Karachi'], min_budget: 5000000, hours: [9, 18] }
export function ruleMatches(rule, lead, hour) {
  return Object.entries(rule.when || {}).every(([k, v]) => {
    if (k === 'min_budget') return (lead.budget_max || 0) >= v
    if (k === 'hours') return hour >= v[0] && hour < v[1]
    return [].concat(v).map(x => String(x).toLowerCase()).includes(String(lead[k] ?? '').toLowerCase())
  })
}

// M3.3: candidates = [{ id, open, last_assigned_at, conversion }], already filtered for availability (M3.4)
export function pickAgent(candidates, method) {
  if (!candidates.length) return null
  const by = {
    round_robin: (a, b) => (a.last_assigned_at || '').localeCompare(b.last_assigned_at || ''),
    load: (a, b) => a.open - b.open,
    performance: (a, b) => (b.conversion || 0) - (a.conversion || 0) || a.open - b.open,
  }[method] || ((a, b) => a.open - b.open)
  return [...candidates].sort(by)[0].id
}

// M4.2: minutes of working time between two timestamps. wh = { start: 9, end: 19, days: [1..6], tz: 5 }
export function workingMinutes(fromMs, toMs, wh) {
  const off = wh.tz * 3600e3
  let total = 0, t = fromMs
  while (t < toMs) {
    const local = new Date(t + off)
    const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - off
    const open = dayStart + wh.start * 3600e3, close = dayStart + wh.end * 3600e3
    if (wh.days.includes(local.getUTCDay())) total += Math.max(0, Math.min(toMs, close) - Math.max(t, open))
    t = dayStart + 86400e3
  }
  return total / 60e3
}

// M4.3-M4.5: breach level reached after n * sla working minutes
export const slaLevel = (elapsedMin, slaMin) => Math.min(3, Math.floor(elapsedMin / slaMin))

// M7.3: haversine distance in meters
export function distanceM(lat1, lng1, lat2, lng2) {
  const r = x => (x * Math.PI) / 180
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(a))
}

// M1.9: configurable weights, e.g. { budget: 10, connected_call: 5, visit_done: 30, qualified: 20 }
export function leadScore(lead, stats, w) {
  return (lead.budget_max ? w.budget : 0)
    + Math.min(stats.connected || 0, 5) * w.connected_call
    + (stats.visits ? w.visit_done : 0)
    + (['Qualified', 'Visit Scheduled', 'Visit Done', 'Negotiation', 'Booked'].includes(lead.status) ? w.qualified : 0)
}

// M1.6: RFC4180-ish CSV (quotes, escaped quotes, newlines in quotes)
export function parseCsv(text) {
  const rows = [[]]
  let cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { rows.at(-1).push(cell); cell = '' }
    else if (c === '\n') { rows.at(-1).push(cell.replace(/\r$/, '')); cell = ''; rows.push([]) }
    else cell += c
  }
  rows.at(-1).push(cell)
  return rows.filter(r => r.some(c => c.trim()))
}

export const toCsv = rows => rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')

// M10.3: area conversion. Marla size varies by society, so it is passed in (sq ft per marla, e.g. 225 or 272.25).
export function toSqft(size, uom, marlaSqft) {
  return { marla: marlaSqft, kanal: 20 * marlaSqft, sqyd: 9, sqft: 1 }[uom] * size
}
export const convertArea = (size, from, to, marlaSqft) => toSqft(size, from, marlaSqft) / toSqft(1, to, marlaSqft)

// M10.4-M10.5: price = per-plot price for the unit's size, or rate x size (rate per marla/sqft…), + premiums.
// unit.premiums = names, project premiums = [{ name, type: 'pct'|'fixed', value }]
export function unitPrice(unit, rate, premiums, marlaSqft) {
  if (unit.price_override) return { base: unit.price_override, premium: 0, total: unit.price_override, override: true }
  if (!rate || (!unit.size && rate.per !== 'plot')) return null
  const base = Math.round(rate.per === 'plot' ? rate.rate : rate.rate * convertArea(unit.size, unit.uom, rate.per, marlaSqft))
  const premium = Math.round(premiums.filter(p => unit.premiums.includes(p.name))
    .reduce((s, p) => s + (p.type === 'pct' ? (base * p.value) / 100 : p.value), 0))
  return { base, premium, total: base + premium }
}

// Price lists are either per plot of one size (per = 'plot', size + uom set) or a rate per area unit for the whole type
export const sizeKey = x => `${x.unit_type}|${+x.size}|${x.uom}`
// Latest price effective at `at` for this unit: its size's per-plot price wins over the type-wide rate
export function currentRate(lists, unit, at) {
  const live = lists.filter(l => l.unit_type === unit.unit_type && l.effective_from <= at)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.id - a.id)
  return live.find(l => l.per === 'plot' && sizeKey(l) === sizeKey(unit)) || live.find(l => l.per !== 'plot') || null
}

// "1-50, 55, 60-62, 12A" -> ['1', …, '50', '55', '60', '61', '62', '12A']. Only digit-digit is a range, so "A-12" stays one number.
export function parseNumbers(text) {
  const out = []
  for (const t of String(text ?? '').split(/[,\s]+/).filter(Boolean)) {
    const m = t.match(/^(\d+)-(\d+)$/)
    if (!m) { out.push(t); continue }
    const [a, b] = [+m[1], +m[2]]
    if (b < a || b - a >= 5000) throw new Error(`Bad range "${t}"`)
    for (let i = a; i <= b; i++) out.push(String(i))
  }
  const dup = out.find((x, i) => out.indexOf(x) !== i)
  if (dup) throw new Error(`Plot number ${dup} is listed twice`)
  return out
}

// Plots added by count without real numbers get "5M-1", "5M-2"… until they are numbered
const SHORT_UOM = { marla: 'M', kanal: 'K', sqft: 'SF', sqyd: 'SY' }
export const autoPrefix = (size, uom) => `${+size}${SHORT_UOM[uom]}-`

// ---- payment plans (Phase 2 collections) ----
// Adds n months to a YYYY-MM-DD date, clamping to the month's last day (Jan 31 + 1 month = Feb 28)
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const last = new Date(Date.UTC(y, m + n, 0)).getUTCDate()
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10)
}

// Down payment on the start date, then `count` equal installments every `every` months; the last one absorbs rounding
export function buildSchedule(total, down, count, every, start) {
  const rows = down > 0 ? [{ label: count ? 'Down payment' : 'Full payment', due_date: start, amount: down }] : []
  const rest = total - down, each = Math.floor(rest / (count || 1))
  for (let i = 1; i <= count; i++)
    rows.push({ label: `Installment ${i}`, due_date: addMonths(start, i * every), amount: i === count ? rest - each * (count - 1) : each })
  return rows
}

// Applies the money paid to installments, oldest first. Anything due before `today` and not fully covered is overdue
export function allocate(installments, paid, today) {
  let left = paid
  return installments.map(i => {
    const p = Math.max(0, Math.min(i.amount, left))
    left -= p
    return { ...i, paid: p, status: p >= i.amount ? 'Paid' : i.due_date < today ? 'Overdue' : p > 0 ? 'Partial' : 'Due' }
  })
}

// ---- rentals ----
// Monthly rent falls due on the lease start's day of month, from the start until `upto` (or the lease end).
// The yearly increase compounds on each anniversary: year 2 = rent × (1 + pct), year 3 = rent × (1 + pct)², …
export function rentSchedule({ start_date, end_date, rent, increase_pct }, upto) {
  const last = end_date && end_date < upto ? end_date : upto, rows = []
  for (let i = 0; i < 600; i++) {
    const due = addMonths(start_date, i)
    if (due > last || (end_date && due >= end_date)) break
    rows.push({ label: `Rent ${due.slice(0, 7)}`, due_date: due, amount: Math.round(rent * (1 + (+increase_pct || 0) / 100) ** Math.floor(i / 12)) })
  }
  return rows
}
// Days from `today` to the lease end (negative once past)
export const daysLeft = (end, today) => Math.round((Date.parse(end) - Date.parse(today)) / 864e5)

// ---- map areas (society → phase → block boundaries) ----
// Ray casting: is the point [lng, lat] inside the ring [[lng, lat], …]?
export function inPolygon([x, y], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const ringArea = ring => Math.abs(ring.reduce((s, [x, y], i) => { const [x2, y2] = ring[(i + 1) % ring.length]; return s + x * y2 - x2 * y }, 0)) / 2
export const AREA_FIELD = { Society: 'society', Phase: 'phase', Block: 'block' }
// The society / phase / block names a point falls in; where two of a kind overlap, the smaller (more specific) one wins
export function areasAt(pt, areas) {
  const out = {}
  for (const a of areas.filter(a => a.outline && inPolygon(pt, a.outline)).sort((a, b) => ringArea(b.outline) - ringArea(a.outline)))
    out[AREA_FIELD[a.kind]] = a.name
  return out
}

// ---- aligning an uploaded society map to the satellite ----
// Point pairs [shown, real] → a function moving any point. 2 pairs: move + turn + scale (shape kept);
// 3 or more: least-squares affine (also fixes stretch / skew of scanned maps). Works on centred coordinates for precision.
export function fitTransform(pairs) {
  const n = pairs.length
  if (n < 2) throw new Error('Match at least 2 points')
  const mean = k => [0, 1].map(i => pairs.reduce((s, p) => s + p[k][i], 0) / n)
  const [sx, sy] = mean(0), [dx, dy] = mean(1)
  const P = pairs.map(([s, d]) => [s[0] - sx, s[1] - sy, d[0] - dx, d[1] - dy])
  if (n === 2) {
    const [[x1, y1, u1, v1], [x2, y2, u2, v2]] = P, ax = x2 - x1, ay = y2 - y1, bx = u2 - u1, by = v2 - v1, den = ax * ax + ay * ay
    if (!den) throw new Error('Pick two different points')
    const re = (bx * ax + by * ay) / den, im = (by * ax - bx * ay) / den
    return ([x, y]) => { const X = x - sx, Y = y - sy; return [dx + re * X - im * Y, dy + im * X + re * Y] }
  }
  let sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0
  for (const [x, y, u, v] of P) { sxx += x * x; sxy += x * y; syy += y * y; sxu += x * u; syu += y * u; sxv += x * v; syv += y * v }
  const det = sxx * syy - sxy * sxy
  if (!(Math.abs(det) > 1e-9 * sxx * syy)) throw new Error('The points are in a line. Pick points spread around the map')
  const a = (sxu * syy - syu * sxy) / det, b = (syu * sxx - sxu * sxy) / det, c = (sxv * syy - syv * sxy) / det, d = (syv * sxx - sxv * sxy) / det
  return ([x, y]) => { const X = x - sx, Y = y - sy; return [dx + a * X + b * Y, dy + c * X + d * Y] }
}
// Corners (top-left, top-right, bottom-right, bottom-left) that fit an image of w×h pixels inside a boundary, centred, shape kept
export function fitCorners(ring, w, h) {
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const k = Math.cos(((y0 + y1) / 2) * Math.PI / 180) // a degree of longitude is shorter than one of latitude
  let wd = (x1 - x0) * k, ht = y1 - y0
  if (wd / ht > w / h) wd = ht * w / h; else ht = wd * h / w
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = wd / k / 2, hy = ht / 2
  return [[cx - hx, cy + hy], [cx + hx, cy + hy], [cx + hx, cy - hy], [cx - hx, cy - hy]]
}
