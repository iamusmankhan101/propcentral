import { createContext, useCallback, useContext, useEffect, useState } from 'react'

export async function api(path, { method, body } = {}) {
  const r = await fetch('/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (localStorage.token || '') },
    body: body && JSON.stringify(body),
  })
  if (r.status === 401 && path !== '/login') { delete localStorage.token; location.reload() }
  const d = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text()
  if (!r.ok) {
    const e = new Error(typeof d === 'object' ? d.error || r.statusText : d || r.statusText)
    e.status = r.status
    e.data = typeof d === 'object' ? d : {} // extra fields the server attaches, e.g. trial_ended
    throw e
  }
  return d
}

export function useApi(path) {
  const [data, setData] = useState()
  const [error, setError] = useState()
  const load = useCallback(() => path && api(path).then(setData, e => setError(e.message)), [path])
  useEffect(() => { load() }, [load])
  return [data, load, error]
}

export const Meta = createContext()
export const useMeta = () => useContext(Meta)

// Wraps a form submit / button action: runs fn, shows the error inline instead of crashing
export function useAction() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn) => {
    setError(''); setBusy(true)
    try { return await fn() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return { run, error, busy, setError }
}

export const formData = e => (e.preventDefault(), Object.fromEntries(new FormData(e.target)))
export const fmt = d => (d ? new Date(d).toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' }) : '—')
// table cells show date and time on separate lines so narrow columns never wrap mid-date
export const fmtParts = d => (d ? [
  new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
  new Date(d).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' }),
] : ['—', ''])
export const toIso = v => (v ? new Date(v).toISOString() : null) // datetime-local is local time -> UTC ISO
export const pkr = n => (n == null || n === '' ? '—' : n >= 1e7 ? (n / 1e7).toFixed(2) + ' Cr' : n >= 1e5 ? (n / 1e5).toFixed(2) + ' Lac' : Number(n).toLocaleString('en-PK'))
export const phone = p => (/^92\d{10}$/.test(p || '') ? `+92 ${p.slice(2, 5)} ${p.slice(5)}` : p)
export const go = path => { location.hash = path }

export async function download(path, name) {
  const text = await api(path)
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: name })
  a.click()
  URL.revokeObjectURL(a.href)
}

export async function downloadBlob(path, name) {
  const r = await fetch('/api' + path, { headers: { authorization: 'Bearer ' + (localStorage.token || '') } })
  if (!r.ok) throw new Error((await r.text()) || r.statusText)
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: name })
  a.click()
  URL.revokeObjectURL(a.href)
}

// Photos are downsized in the browser (JPEG, longest side `max` px) before upload, so a phone camera shot stays ~300KB
export const shrinkImage = (file, max = 1600) => new Promise((ok, fail) => {
  const img = new Image()
  img.onload = () => {
    const k = Math.min(1, max / Math.max(img.width, img.height))
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) })
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    URL.revokeObjectURL(img.src)
    ok(c.toDataURL('image/jpeg', 0.82))
  }
  img.onerror = () => fail(new Error(`${file.name} is not an image`))
  img.src = URL.createObjectURL(file)
})
export const readFile = file => new Promise((ok, fail) => Object.assign(new FileReader(), { onload: e => ok(e.target.result), onerror: fail }).readAsDataURL(file))
