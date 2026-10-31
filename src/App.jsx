import { useEffect, useRef, useState } from 'react'
import { api, Meta, useApi, useAction, formData, fmt, go } from './api.js'
import Dashboard from './Dashboard.jsx'
import Leads, { Import } from './Leads.jsx'
import Lead from './Lead.jsx'
import Visits from './Visits.jsx'
import Projects, { Project, AllotmentLetter, PublicMap } from './Projects.jsx'
import { Users, Settings, Audit } from './Admin.jsx'
import { Ledger, Receipt, Collections } from './Payments.jsx'
import Commissions from './Commissions.jsx'
import Listings from './Listings.jsx'
import Reports from './Reports.jsx'
import Properties, { PropertyPage, RentReceipt } from './Properties.jsx'
import BookingForm from './BookingForm.jsx'
import Portal from './Portal.jsx'
import Icon from './Icon.jsx'
import logoImg from './assets/logo.png'
import markImg from './assets/mark.png'

function Login() {
  const { run, error, busy, setError } = useAction()
  const [mode, setMode] = useState('signin')
  const [needCode, setNeedCode] = useState(false)
  const [notice, setNotice] = useState('')
  const [email, setEmail] = useState('')
  const signup = mode === 'signup'
  const switchTo = m => { setMode(m); setError(''); setNotice(''); setNeedCode(false) }
  const submit = e => {
    const body = formData(e)
    run(async () => {
      if (signup) {
        await api('/register', { body })
        setEmail(body.email); setMode('signin'); setError(''); setNeedCode(false)
        setNotice('Account created. An admin has to activate it before you can sign in.')
        return
      }
      const r = await api('/login', { body })
      if (r.need_code) return setNeedCode(true)
      localStorage.token = r.token; sessionStorage.logoIntro = '1'; location.reload()
    })
  }
  return (
    <div className="login-page">
      <aside className="login-bg">
        <img className="login-logo" src={logoImg} alt="Prop Central" />
        <p>Elevate your portfolio, one asset at a time.<br />Close more deals, faster.</p>
        <small>Prop Central — real estate, in one place.</small>
      </aside>
      <div className="login-side">
        <form className="login" onSubmit={submit}>
          <h1>{signup ? 'Create an account' : 'Welcome back'}</h1>
          <p className="muted">{signup ? 'Sign up to join the sales floor. An admin activates new accounts.' : 'Enter your credentials to access your Prop Central dashboard.'}</p>
          {signup && <label>Name<span className="field"><Icon name="users" size={16} /><input name="name" placeholder="Full name" required autoFocus /></span></label>}
          <label>Email<span className="field"><Icon name="mail" size={16} /><input key={mode + email} name="email" type="email" placeholder="mail@example.com" defaultValue={email} required autoFocus={!signup} /></span></label>
          {signup && <label>Phone (optional)<span className="field"><Icon name="phone" size={16} /><input name="phone" type="tel" placeholder="03xx xxxxxxx" /></span></label>}
          <label>Password<span className="field"><Icon name="lock" size={16} /><input key={mode + email} name="password" type="password" placeholder={signup ? 'At least 8 characters' : 'Your password'} minLength={signup ? 8 : undefined} required autoFocus={signup} /></span></label>
          {needCode && <label>Authenticator code<span className="field"><Icon name="key" size={16} /><input name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code from your app" required autoFocus /></span></label>}
          {notice && <p className="ok">{notice}</p>}
          {error && <p className="error">{error}</p>}
          <button disabled={busy}>{signup ? 'Create account' : 'Continue'}</button>
          <p className="auth-switch muted">
            {signup ? 'Already have an account? ' : 'New here? '}
            <a href="#" onClick={e => { e.preventDefault(); switchTo(signup ? 'signin' : 'signup') }}>{signup ? 'Sign in' : 'Create an account'}</a>
          </p>
        </form>
      </div>
    </div>
  )
}

// Plays the mark once, on the first render after signing in; the flag is consumed so a
// reload or navigation never repeats it.
function LogoIntro() {
  const [show, setShow] = useState(() => sessionStorage.logoIntro === '1')
  const [gone, setGone] = useState(false)
  useEffect(() => {
    if (!show) return
    sessionStorage.removeItem('logoIntro')
    const t = setTimeout(() => setGone(true), 1600)
    return () => clearTimeout(t)
  }, [show])
  if (!show || gone) return null
  return (
    <div className="logo-intro" aria-hidden="true">
      <span className="ring" />
      <span className="tile"><img src={markImg} alt="" /></span>
    </div>
  )
}

function Bell() {
  const [data, load] = useApi('/notifications')
  const [open, setOpen] = useState(false)
  const box = useRef()
  useEffect(() => { const t = setInterval(load, 30e3); return () => clearInterval(t) }, [load])
  useEffect(() => { // close on a click outside or Escape
    if (!open) return
    const out = e => box.current.contains(e.target) || setOpen(false)
    const esc = e => e.key === 'Escape' && setOpen(false)
    addEventListener('pointerdown', out); addEventListener('keydown', esc)
    return () => { removeEventListener('pointerdown', out); removeEventListener('keydown', esc) }
  }, [open])
  const toggle = async () => {
    setOpen(!open)
    if (!open && data?.unread) { await api('/notifications/read', { body: {} }); load() }
  }
  return (
    <div className="bell" ref={box}>
      <button className="glass icon-btn" onClick={toggle} aria-label="Notifications" aria-expanded={open}><Icon name="bell" />{data?.unread > 0 && <b className="badge">{data.unread}</b>}</button>
      {open && (
        <div className="dropdown card">
          <h4>Notifications</h4>
          {data?.rows.length ? data.rows.map(n => (
            <a key={n.id} href={n.lead_id ? `#/leads/${n.lead_id}` : undefined} onClick={() => setOpen(false)} className={n.read ? '' : 'unread'}>
              {n.text}<small>{fmt(n.created_at)}</small>
            </a>
          )) : <p className="muted empty">You're all caught up. New leads, SLA alerts and approvals will show here.</p>}
        </div>
      )}
    </div>
  )
}

function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [showIosTip, setShowIosTip] = useState(false)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) {
      setInstalled(true)
      return
    }
    const handler = (e) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }
    const installedHandler = () => {
      setInstalled(true)
      setDeferredPrompt(null)
    }
    window.addEventListener('beforeinstallprompt', handler)
    window.addEventListener('appinstalled', installedHandler)
    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
      window.removeEventListener('appinstalled', installedHandler)
    }
  }, [])

  if (installed) return null

  const isIos = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream

  const install = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt()
      const { outcome } = await deferredPrompt.userChoice
      if (outcome === 'accepted') setInstalled(true)
      setDeferredPrompt(null)
    } else if (isIos) {
      setShowIosTip(true)
    } else {
      alert("To install this app on your device:\n\n• On iPhone/iPad (Safari): Tap Share ⎋ and 'Add to Home Screen' ⊞\n• On Android (Chrome): Tap Menu (⋮) and 'Install app'\n• On Mac/PC (Chrome/Edge): Click the Install icon in the address bar")
    }
  }

  return (
    <>
      <button className="glass button install-btn" onClick={install} title="Install as mobile or desktop app">
        <Icon name="download" size={16} />
        <span className="label">Install App</span>
      </button>
      {showIosTip && (
        <div className="ios-modal-backdrop" onClick={() => setShowIosTip(false)}>
          <div className="card ios-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Install on iPhone / iPad</h3>
            <ol>
              <li>Tap the <b>Share</b> button in the Safari toolbar at the bottom.</li>
              <li>Scroll down and select <b>Add to Home Screen</b> ⊞.</li>
              <li>Tap <b>Add</b> in the top right.</li>
            </ol>
            <button className="button full" onClick={() => setShowIosTip(false)}>Got it</button>
          </div>
        </div>
      )}
    </>
  )
}

function MobileAccount({ me, onLogout }) {
  const [open, setOpen] = useState(false)
  const box = useRef()
  useEffect(() => {
    if (!open) return
    const out = e => box.current.contains(e.target) || setOpen(false)
    const esc = e => e.key === 'Escape' && setOpen(false)
    addEventListener('pointerdown', out); addEventListener('keydown', esc)
    return () => { removeEventListener('pointerdown', out); removeEventListener('keydown', esc) }
  }, [open])
  const hour = new Date().getHours()
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
  const initials = me.name.split(' ').map(w => w[0]).join('').slice(0, 2)
  return (
    <div className="mobile-head">
      <div className="greet"><small>Good {part}</small><b>{me.name.split(' ')[0]}</b></div>
      <div className="acct" ref={box}>
        <button className="avatar" onClick={() => setOpen(!open)} aria-label="Account menu" aria-expanded={open}>{initials}</button>
        {open && (
          <div className="dropdown card">
            <a href="#/settings?tab=profile" onClick={() => setOpen(false)}>Profile & settings</a>
            <a href="#" onClick={e => { e.preventDefault(); setOpen(false); onLogout() }}>Log out</a>
          </div>
        )}
      </div>
    </div>
  )
}

// [path, label, icon, permission, placement]: "all" sits in the bar everywhere, "wide" only on
// desktop, "more" lives behind the overflow button so the bar stays short
const NAV = [
  ['/', 'Dashboard', 'dashboard', null, 'all'], ['/leads', 'Leads', 'leads', null, 'all'], ['/projects', 'Projects', 'building', null, 'all'], ['/visits', 'Visits', 'visits', null, 'all'],
  ['/properties', 'Properties', 'map', null, 'wide'], ['/collections', 'Collections', 'wallet', 'payments', 'wide'], ['/reports', 'Reports', 'calendar', null, 'wide'],
  ['/commissions', 'Sales', 'percent', null, 'more'], ['/listings', 'Listings', 'key', null, 'more'], ['/import', 'Import', 'import', 'import', 'more'],
  ['/users', 'Users', 'users', 'manage_users', 'more'], ['/settings', 'Settings', 'settings', null, 'more'], ['/audit', 'Audit', 'audit', 'audit', 'more'],
]

function MoreMenu({ items, path, home }) {
  const [open, setOpen] = useState(false)
  const box = useRef()
  const isActive = ([href]) => (href === '/' ? home : path.startsWith(href))
  useEffect(() => {
    if (!open) return
    const out = e => box.current.contains(e.target) || setOpen(false)
    const esc = e => e.key === 'Escape' && setOpen(false)
    const close = () => setOpen(false)
    addEventListener('pointerdown', out); addEventListener('keydown', esc); addEventListener('hashchange', close)
    return () => { removeEventListener('pointerdown', out); removeEventListener('keydown', esc); removeEventListener('hashchange', close) }
  }, [open])
  return (
    <div className="more" ref={box}>
      <button className={'more-btn' + (items.some(isActive) ? ' active' : '')} aria-label="More pages" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" size={20} /><span>More</span>
      </button>
      {open && (
        <div className="more-menu" role="menu">
          {items.map(([href, label, icon]) => (
            <a key={href} href={'#' + href} role="menuitem" className={isActive([href]) ? 'active' : ''} onClick={() => setOpen(false)}>
              <Icon name={icon} size={18} /><span>{label}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || '/')
  const searchInput = useRef()

  useEffect(() => {
    const f = () => setRoute(location.hash.slice(1) || '/')
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])

  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchInput.current?.focus()
        searchInput.current?.select()
      } else if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        e.preventDefault()
        searchInput.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const [meta, reloadMeta, metaError] = useApi(localStorage.token ? '/meta' : null)

  const shared = route.match(/^\/map\/([\w-]+)$/)?.[1]
  if (shared) return <PublicMap token={shared} /> // client link: no login
  const portal = route.match(/^\/portal\/([a-f0-9]+)(?:\/receipts\/(\d+))?$/)
  if (portal) return <Portal token={portal[1]} receipt={portal[2]} key={route} /> // buyer link: no login
  if (!localStorage.token) return <Login />
  if (metaError) return <p className="error">{metaError}</p>
  if (!meta) return <p className="muted pad">Loading…</p>

  const [path, query = ''] = route.split('?')
  const leadId = path.match(/^\/leads\/(\d+)/)?.[1]
  const projectId = path.match(/^\/projects\/(\d+)/)?.[1]
  const allotmentId = path.match(/^\/allotments\/(\d+)/)?.[1]
  const ledgerId = path.match(/^\/ledger\/(\d+)/)?.[1]
  const receiptId = path.match(/^\/receipts\/(\d+)/)?.[1]
  const formId = path.match(/^\/booking-form\/(\d+)/)?.[1]
  const propertyId = path.match(/^\/properties\/(\d+)/)?.[1]
  const rentReceiptId = path.match(/^\/rent-receipts\/(\d+)/)?.[1]
  const page = leadId ? <Lead id={leadId} key={leadId} />
    : propertyId ? <PropertyPage id={propertyId} key={propertyId} />
    : rentReceiptId ? <RentReceipt id={rentReceiptId} key={rentReceiptId} />
    : formId ? <BookingForm id={formId} key={formId} />
    : ledgerId ? <Ledger id={ledgerId} key={ledgerId} />
    : receiptId ? <Receipt id={receiptId} key={receiptId} />
    : projectId ? <Project id={projectId} key={projectId} />
    : allotmentId ? <AllotmentLetter id={allotmentId} key={allotmentId} />
    : { '/': <Dashboard />, '/leads': <Leads query={query} key={query} />, '/visits': <Visits />, '/projects': <Projects />, '/collections': <Collections />, '/commissions': <Commissions />, '/listings': <Listings />, '/properties': <Properties />, '/reports': <Reports />, '/import': <Import />, '/users': <Users />, '/settings': <Settings query={query} key={query} />, '/audit': <Audit /> }[path]
    ?? <p>Not found</p>
  const title = leadId ? 'Lead' : projectId ? 'Projects' : allotmentId ? 'Allotment' : ledgerId ? 'Ledger' : receiptId ? 'Receipt' : formId ? 'Booking form' : propertyId ? 'Properties' : rentReceiptId ? 'Rent receipt' : NAV.find(n => n[0] === path)?.[1] ?? ''
  const home = path === '/'

  const logout = async () => { await api('/logout', { body: {} }).catch(() => {}); delete localStorage.token; go('/'); location.reload() }
  const toggleAvailable = async () => { await api('/me/available', { body: { available: !meta.me.available } }); reloadMeta() }
  const search = e => { const { q } = formData(e); go('/leads?q=' + encodeURIComponent(q)) }

  return (
    <Meta.Provider value={{ ...meta, can: p => meta.perms.includes(p), reloadMeta }}>
      <div className="shell">
        <LogoIntro />
        <nav>
          <a className="logo" href="#/" aria-label="Prop Central home"><img src={markImg} alt="ARK" /></a>
          {NAV.filter(n => (!n[3] || meta.perms.includes(n[3])) && n[4] !== 'more').map(([href, label, icon, , group]) => (
            <a key={href} href={'#' + href} className={[(href === '/' ? home : path.startsWith(href)) ? 'active' : '', group === 'wide' ? 'nav-wide' : ''].filter(Boolean).join(' ')}><Icon name={icon} size={20} /><span>{label}</span></a>
          ))}
          <MoreMenu items={NAV.filter(n => (!n[3] || meta.perms.includes(n[3])) && n[4] === 'more')} path={path} home={home} />
          <div className="spacer" />
          <a className="nav-logout" href="#" onClick={e => { e.preventDefault(); logout() }}><Icon name="logout" size={20} /><span>Log out</span></a>
          <a className="avatar" href="#/settings?tab=profile" title={`${meta.me.name} · ${meta.me.role.replace('_', ' ')} · Profile & settings`}>{meta.me.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</a>
        </nav>
        <main>
          <div className={'hero-bg' + (home ? ' tall' : '')} />
          <div className={'page-head' + (home ? ' home' : '')}>
            <div className="topbar">
              <MobileAccount me={meta.me} onLogout={logout} />
              <form className="glass search" onSubmit={search}>
                <Icon name="search" size={16} />
                <input ref={searchInput} name="q" placeholder="Search leads…" defaultValue={new URLSearchParams(query).get('q') || ''} key={query} aria-label="Search leads" />
                <kbd className="search-kbd" title="Press ⌘K or / to search">⌘K</kbd>
              </form>
              {meta.me.role === 'agent' && (
                <button className={'avail glass' + (meta.me.available ? '' : ' paused')} onClick={toggleAvailable} title="Toggle receiving new leads">
                  {meta.me.available ? '● Available' : '○ Paused'}
                </button>
              )}
              <Bell />
              <InstallPrompt />
              <a className="glass button" href="#/leads?new=1"><Icon name="plus" size={16} /><span className="label">Add lead</span></a>
            </div>
            {!home && <h1 className="page-title">{title}</h1>}
          </div>
          <div className="content">{page}</div>
        </main>
      </div>
    </Meta.Provider>
  )
}
