import { useEffect, useRef, useState } from 'react'
import { api, Meta, useApi, useAction, formData, fmt, go } from './api.js'
import Dashboard from './Dashboard.jsx'
import Leads, { Import } from './Leads.jsx'
import Lead from './Lead.jsx'
import Visits from './Visits.jsx'
import Projects, { Project, AllotmentLetter, PublicMap } from './Projects.jsx'
import { Users, Settings, Audit } from './Admin.jsx'
import PlatformAdmin from './PlatformAdmin.jsx'
import { Ledger, Receipt, Collections } from './Payments.jsx'
import Commissions from './Commissions.jsx'
import Listings from './Listings.jsx'
import Reports from './Reports.jsx'
import Campaigns from './Campaigns.jsx'
import Assistant from './Assistant.jsx'
import Properties, { PropertyPage, RentReceipt } from './Properties.jsx'
import Students, { Student, EduPayments } from './Edu.jsx'
import Universities, { University } from './EduCatalogue.jsx'
import Courses from './EduCourses.jsx'
import Applications from './EduApplications.jsx'
import Therapy, { TherapyChild, ParentPortal, TherapyLibrary } from './Therapy.jsx'
import BookingForm from './BookingForm.jsx'
import Portal from './Portal.jsx'
import Icon from './Icon.jsx'
import { PLANS, MODULES, planName, PLAN_LIMITS, limitLabel, SUPPORT_WHATSAPP } from '../shared/plans.js'
import logoImg from './assets/logo.png'
import markImg from './assets/mark.png'

const waLink = (number, text) => `https://wa.me/${number}?text=${encodeURIComponent(text)}`

function Login() {
  const { run, error, busy, setError } = useAction()
  const [mode, setMode] = useState('signin')
  const [needCode, setNeedCode] = useState(false)
  const [twoFactorInfo, setTwoFactorInfo] = useState(null)
  const [notice, setNotice] = useState('')
  const [email, setEmail] = useState('')
  const [trial, setTrial] = useState(null)
  const [needVerify, setNeedVerify] = useState('')
  const [resending, setResending] = useState(false)
  const [resendError, setResendError] = useState('')
  const signup = mode === 'signup', forgot = mode === 'forgot'
  // sign-up is three steps; its fields live in state because each step renders only its own inputs
  const [step, setStep] = useState(0)
  const [su, setSu] = useState({ name: '', email: '', phone: '', password: '', website: '', module: 'property', plan: 'solo' })
  const setF = k => e => setSu({ ...su, [k]: e.target.value })
  const switchTo = m => { setStep(0); setMode(m); setError(''); setNotice(''); setNeedCode(false); setTwoFactorInfo(null); setTrial(null); setNeedVerify(''); setResendError('') }
  const submit = e => {
    if (signup && step < 2) { e.preventDefault(); setError(''); setStep(step + 1); return } // native validation already passed for this step's fields
    const body = signup ? (e.preventDefault(), su) : formData(e)
    run(async () => {
      if (forgot) {
        await api('/forgot-password', { body: { email: body.email } })
        setNotice('If that email has an account, an admin has been notified. They will send you a one-time reset link.')
        return
      }
      if (signup) {
        const { module, ...rest } = body
        const r = await api('/register', { body: { ...rest, modules: [module] } })
        setEmail(body.email); setMode('signin'); setError(''); setNeedCode(false); setStep(0); setSu({ ...su, password: '' })
        setNotice(r.email_sent
          ? `Account created! Check ${body.email} for a verification link.`
          : `Account created, but the verification email to ${body.email} could not be sent. Sign in and use "Resend verification email".`)
        return
      }
      let r
      try { r = await api('/login', { body }) } catch (e) {
        if (e.data?.trial_ended) setTrial(e.data)
        if (e.data?.need_verify) setNeedVerify(e.data.email || body.email)
        throw e
      }
      if (r.need_code) {
        setNeedCode(true)
        setTwoFactorInfo({ method: r.method, email: r.email })
        if (r.method === 'email') {
          setNotice(`A 6-digit verification code has been sent to your email (${r.email}).`)
        }
        return
      }
      localStorage.token = r.token; sessionStorage.logoIntro = '1'; location.reload()
    })
  }
  const resendVerification = async () => {
    setResendError(''); setResending(true)
    try {
      const r = await api('/resend-verification', { body: { email: needVerify } })
      if (r.email_sent) setNotice('Verification email resent! Check your inbox.')
      else setResendError('The email service could not deliver just now. Try again in a few minutes, or contact support.')
    } catch (e) { setResendError(e.message) } finally { setResending(false) }
  }
  return (
    <div className="login-page">
      <aside className="login-bg">
        <img className="login-logo" src={logoImg} alt="Estate Centric" />
        <p>Elevate your portfolio, one asset at a time.<br />Close more deals, faster.</p>
        <small>Estate Centric — real estate, in one place.</small>
      </aside>
      <div className="login-side">
        <form className="login" onSubmit={submit}>
          <h1>{forgot ? 'Reset your password' : signup ? 'Create an account' : 'Welcome back'}</h1>
          <p className="muted">{forgot ? 'Tell us your email. An admin will send you a one-time reset link.' : signup ? 'Three quick steps. Every plan starts with a 7-day free trial.' : 'Enter your credentials to access your Estate Centric dashboard.'}</p>
          {signup && <>
            <ol className="steps" aria-label="Sign-up progress">{['Your details', 'Product', 'Plan'].map((t, i) => <li key={t} className={i === step ? 'on' : i < step ? 'done' : ''}><span>{i < step ? '✓' : i + 1}</span>{t}</li>)}</ol>
            {step === 0 && <>
              <input className="hp" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={su.website} onChange={setF('website')} />
              <label>Full name<span className="field"><Icon name="users" size={16} /><input name="name" autoComplete="name" placeholder="Full name" maxLength={80} required autoFocus value={su.name} onChange={setF('name')} /></span></label>
              <label>Work email<span className="field"><Icon name="mail" size={16} /><input name="email" type="email" autoComplete="email" placeholder="mail@example.com" maxLength={254} required value={su.email} onChange={setF('email')} /></span></label>
              <label>Phone (optional)<span className="field"><Icon name="phone" size={16} /><input name="phone" type="tel" autoComplete="tel" placeholder="03xx xxxxxxx" maxLength={30} value={su.phone} onChange={setF('phone')} /></span></label>
              <label>Password<span className="field"><Icon name="lock" size={16} /><input name="password" type="password" autoComplete="new-password" placeholder="10+ characters, letters and numbers" minLength={10} maxLength={200} required value={su.password} onChange={setF('password')} /></span></label>
            </>}
            {step === 1 && <fieldset className="plan-picker module-picker">
              <legend>What will you use Estate Centric for?</legend>
              {MODULES.map(x => (
                <label key={x.id}>
                  <span className="mod-icon"><Icon name={{ property: 'building', edu: 'cap', therapy: 'heart' }[x.id] || 'layers'} size={22} /></span>
                  <span className="mod-text"><b>{x.name}</b><small>{x.blurb}</small></span>
                  <input type="radio" name="module" value={x.id} checked={su.module === x.id} onChange={setF('module')} />
                </label>
              ))}
              <small className="muted">Pick one. You can change it later in Settings.</small>
            </fieldset>}
            {step === 2 && <>
              <fieldset className="plan-picker">
                <legend>Choose your plan</legend>
                {PLANS.map(p => (
                  <label key={p.id}>
                    <input type="radio" name="plan" value={p.id} checked={su.plan === p.id} onChange={setF('plan')} />
                    <b>{p.name}</b>{p.popular && <em className="tag">Most popular</em>}
                    <span className="plan-price">PKR {p.monthly.toLocaleString('en-PK')}<small>/mo</small></span>
                    <ul className="plan-limits">{PLAN_LIMITS.map(w => <li key={w}>{limitLabel(p, w)}</li>)}</ul>
                  </label>
                ))}
              </fieldset>
              <p className="muted">{MODULES.find(x => x.id === su.module)?.name} · {PLANS.find(x => x.id === su.plan)?.name} plan · 7-day free trial, no card.</p>
            </>}
          </>}
          {!signup && <label>Email<span className="field"><Icon name="mail" size={16} /><input key={mode + email} name="email" type="email" placeholder="mail@example.com" maxLength={254} defaultValue={email} required autoFocus /></span></label>}
          {!forgot && !signup && <label>Password<span className="field"><Icon name="lock" size={16} /><input key={mode + email} name="password" type="password" placeholder="Your password" maxLength={200} required /></span></label>}
          {needCode && (
            <label>
              {twoFactorInfo?.method === 'email' ? 'Email verification code' : 'Authenticator code'}
              <span className="field">
                <Icon name="key" size={16} />
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder={twoFactorInfo?.method === 'email' ? '6-digit code sent to your email' : '6-digit code from your app'}
                  required
                  autoFocus
                />
              </span>
            </label>
          )}
          {notice && <p className="ok">{notice}</p>}
          {error && !needVerify && <p className="error">{error}</p>}
          {needVerify && (
            <div className="card banner" style={{marginBottom:'8px'}}>
              <p style={{margin:'0 0 8px'}}>Please verify your email at <b>{needVerify}</b> before signing in.</p>
              <button type="button" className="button" style={{fontSize:'13px',padding:'6px 14px'}} onClick={resendVerification} disabled={resending}>{resending ? 'Sending…' : 'Resend verification email'}</button>
              {resendError && <p className="error" style={{margin:'8px 0 0'}}>{resendError}</p>}
            </div>
          )}
          {trial && <div className="card banner trial-ended">
            <b>Your {planName(trial.plan)} free trial ended on {String(trial.trial_ends_at).slice(0, 10)}.</b>
            <p className="muted">Nothing is deleted — activate the plan and sign straight back in.</p>
            <a className="button" href={waLink(trial.support, `I'd like to activate my ${planName(trial.plan)} plan on Estate Centric`)} target="_blank" rel="noreferrer">WhatsApp to activate</a>
          </div>}
          {signup ? <div className="row step-nav">
            {step > 0 && <button type="button" className="ghost" onClick={() => { setError(''); setStep(step - 1) }}>Back</button>}
            <button disabled={busy}>{step < 2 ? 'Continue' : busy ? 'Creating…' : 'Create account'}</button>
          </div> : <button disabled={busy}>{forgot ? 'Request reset link' : 'Continue'}</button>}
          {!signup && !forgot && <p className="auth-switch muted"><a href="#" onClick={e => { e.preventDefault(); switchTo('forgot') }}>Forgot password?</a></p>}
          {forgot ? <p className="auth-switch muted"><a href="#" onClick={e => { e.preventDefault(); switchTo('signin') }}>Back to sign in</a></p> : (
            <p className="auth-switch muted">
              {signup ? 'Already have an account? ' : 'New here? '}
              <a href="#" onClick={e => { e.preventDefault(); switchTo(signup ? 'signin' : 'signup') }}>{signup ? 'Sign in' : 'Create an account'}</a>
            </p>
          )}
        </form>
      </div>
    </div>
  )
}

function ResetPassword({ token }) {
  const { run, error, busy, setError } = useAction()
  const [done, setDone] = useState(false)
  if (!token) return (
    <div className="reset-page"><div className="login">
      <h1>Reset link</h1>
      <p className="error">This reset link is not valid. Ask an admin for a new one.</p>
      <a className="button" href="#/">Back to sign in</a>
    </div></div>
  )
  const submit = e => {
    const { password, confirm } = formData(e)
    if (password !== confirm) return setError('The two passwords do not match')
    run(async () => { await api('/reset-password', { body: { token, password } }); setDone(true) })
  }
  return (
    <div className="reset-page">
      <form className="login" onSubmit={submit}>
        <h1>Choose a new password</h1>
        {done ? <>
          <p className="ok">Password changed. Every device was signed out.</p>
          <a className="button" href="#/">Sign in</a>
        </> : <>
          <p className="muted">Use at least 10 characters with a letter and a number. This link works once and expires in 30 minutes.</p>
          <label>New password<span className="field"><Icon name="lock" size={16} /><input name="password" type="password" placeholder="10+ characters, letters and numbers" minLength={10} maxLength={200} required autoFocus /></span></label>
          <label>Confirm password<span className="field"><Icon name="lock" size={16} /><input name="confirm" type="password" placeholder="Repeat the new password" minLength={10} maxLength={200} required /></span></label>
          {error && <p className="error">{error}</p>}
          <button disabled={busy}>Change password</button>
          <p className="auth-switch muted"><a href="#/">Back to sign in</a></p>
        </>}
      </form>
    </div>
  )
}

function VerifyEmail({ token }) {
  const { run, error, busy } = useAction()
  const [done, setDone] = useState(false)
  useEffect(() => { run(async () => { await api('/verify-email', { body: { token } }); setDone(true) }) }, [token])
  if (busy) return <div className="login-page"><div className="login-side"><div className="login"><p className="muted">Verifying your email…</p></div></div></div>
  if (error) return (
    <div className="login-page"><div className="login-side"><div className="login">
      <h1>Verification failed</h1>
      <p className="error">{error}</p>
      <p className="muted">The link may have expired. Sign in to request a new one.</p>
      <a className="button" href="#/">Back to sign in</a>
    </div></div></div>
  )
  if (done) return (
    <div className="login-page"><div className="login-side"><div className="login">
      <h1>Email verified ✓</h1>
      <p className="ok">Your account is active. You can now sign in.</p>
      <a className="button" href="#/">Sign in</a>
    </div></div></div>
  )
  return null
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
      <div className="head-id">
        <a className="app-mark" href="#/" aria-label="Estate Centric home"><img src={markImg} alt="" /></a>
        <div className="greet"><small>Good {part}</small><b>{me.name.split(' ')[0]}</b></div>
      </div>
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
  ['/campaigns', 'Campaigns', 'inbox', null, 'more'],
  ['/users', 'Users', 'users', 'manage_users', 'more'], ['/settings', 'Settings', 'settings', null, 'more'], ['/audit', 'Audit', 'audit', 'audit', 'more'],
]

// Student Consultancy pages. Shown only when the platform switched the module on for this company *and*
// the role's permission matrix includes edu — the API refuses the same way, so hiding is tidiness, not security.
const EDU_NAV = [
  ['/students', 'Students', 'cap', 'edu', 'all'], ['/applications', 'Applications', 'send', 'edu', 'all'],
  ['/universities', 'Universities', 'book', 'edu', 'wide'], ['/courses', 'Courses', 'layers', 'edu', 'wide'],
]

const THERAPY_NAV = [['/therapy', 'Therapy', 'heart', 'therapy', 'all']]

// The platform owner manages sign-ups only, so their whole app is the Users page
const PLATFORM_NAV = [['/users', 'Accounts', 'users', null, 'all']]

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
  const [meta, reloadMeta, metaError] = useApi(localStorage.token ? '/meta' : null)
  const isPlatform = meta?.me?.role === 'platform'

  useEffect(() => {
    const f = () => setRoute(location.hash.slice(1) || '/')
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])

  useEffect(() => {
    if (isPlatform) return
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
  }, [isPlatform])

  // The platform owner has no CRM pages: anything that is not Accounts goes home
  useEffect(() => {
    if (!isPlatform) return
    const special = route.startsWith('/reset') || route.startsWith('/map/') || route.startsWith('/portal/') || route.startsWith('/verify-email')
    if (!special && (route.split('?')[0] || '/') !== '/users') go('/users')
  }, [isPlatform, route])

  const resetToken = route.match(/^\/reset(?:\?token=([a-f0-9]{64}))?$/)?.[1]
  if (route.startsWith('/reset')) return <ResetPassword token={resetToken || ''} key={route} />
  const verifyToken = route.startsWith('/verify-email') ? new URLSearchParams(route.split('?')[1] || '').get('token') : null
  if (verifyToken) return <VerifyEmail token={verifyToken} key={verifyToken} />
  if (route.startsWith('/verify-email')) return <div className="login-page"><div className="login-side"><div className="login"><h1>Invalid link</h1><p className="error">No verification token found.</p><a href="#/">Back to sign in</a></div></div></div>
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
  const eduOn = (meta.me.modules || []).includes('edu') && meta.perms.includes('edu')
  const isParent = meta.me.role === 'parent'
  const propertyOn = !isParent && (meta.me.modules || []).includes('property')
  const therapyOn = (meta.me.modules || []).includes('therapy') && meta.perms.includes('therapy')
  const therapyId = therapyOn ? path.match(/^\/therapy\/(\d+)/)?.[1] : null
  const studentId = eduOn ? path.match(/^\/students\/(\d+)/)?.[1] : null
  const universityId = eduOn ? path.match(/^\/universities\/(\d+)/)?.[1] : null

  // If company only has edu, show ONLY edu nav items and common admin/settings (no real estate items)
  const nav = isPlatform ? PLATFORM_NAV
    : isParent ? [['/', 'My child', 'heart', null, 'all']]
    : !propertyOn && eduOn
      ? [
          ['/', 'Dashboard', 'dashboard', null, 'all'],
          ['/students', 'Students', 'cap', null, 'all'],
          ['/applications', 'Applications', 'send', null, 'all'],
          ['/payments', 'Payments', 'receipt', null, 'all'],
          ['/universities', 'Universities', 'book', null, 'wide'],
          ['/courses', 'Courses', 'layers', null, 'wide'],
          ['/reports', 'Reports', 'calendar', null, 'wide'],
          ['/commissions', 'Commissions', 'percent', null, 'more'],
          ...(therapyOn ? THERAPY_NAV : []),
          ['/users', 'Users', 'users', 'manage_users', 'more'],
          ['/settings', 'Settings', 'settings', null, 'more'],
          ['/audit', 'Audit', 'audit', 'audit', 'more'],
        ]
      : !propertyOn && therapyOn
        ? [['/', 'Therapy', 'heart', null, 'all'], ['/users', 'Users', 'users', 'manage_users', 'more'], ['/settings', 'Settings', 'settings', null, 'more'], ['/audit', 'Audit', 'audit', 'audit', 'more']]
        : [...NAV, ...(eduOn ? EDU_NAV : []), ...(therapyOn ? THERAPY_NAV : [])]

  const moreItems = nav.filter(n => (!n[3] || meta.perms.includes(n[3])) && n[4] === 'more')
  const page = isPlatform ? <Users />
    : isParent ? <ParentPortal />
    : leadId && propertyOn ? <Lead id={leadId} key={leadId} />
    : therapyId ? <TherapyChild id={therapyId} key={therapyId} />
    : studentId ? <Student id={studentId} key={studentId} />
    : universityId ? <University id={universityId} key={universityId} />
    : propertyId && propertyOn ? <PropertyPage id={propertyId} key={propertyId} />
    : rentReceiptId && propertyOn ? <RentReceipt id={rentReceiptId} key={rentReceiptId} />
    : formId && propertyOn ? <BookingForm id={formId} key={formId} />
    : ledgerId && propertyOn ? <Ledger id={ledgerId} key={ledgerId} />
    : receiptId && propertyOn ? <Receipt id={receiptId} key={receiptId} />
    : projectId && propertyOn ? <Project id={projectId} key={projectId} />
    : allotmentId && propertyOn ? <AllotmentLetter id={allotmentId} key={allotmentId} />
    : {
        '/': !propertyOn && !eduOn && therapyOn ? <Therapy /> : <Dashboard />,
        '/reports': <Reports />,
        '/commissions': <Commissions />,
        '/users': <Users />,
        '/settings': <Settings query={query} key={query} />,
        '/audit': <Audit />,
        ...(propertyOn ? {
          '/leads': <Leads query={query} key={query} />,
          '/visits': <Visits />,
          '/projects': <Projects />,
          '/collections': <Collections />,
          '/listings': <Listings />,
          '/properties': <Properties />,
          '/campaigns': <Campaigns />,
          '/import': <Import />,
        } : {}),
        ...(therapyOn ? { '/therapy': <Therapy />, '/therapy/library': <TherapyLibrary /> } : {}),
        ...(eduOn ? {
          '/students': <Students query={query} key={query} />,
          '/applications': <Applications query={query} key={query} />,
          '/payments': <EduPayments query={query} key={query} />,
          '/universities': <Universities query={query} key={query} />,
          '/courses': <Courses query={query} key={query} />,
        } : {})
      }[path]
    ?? <p>Not found</p>
  const title = isPlatform ? 'Accounts' : leadId ? 'Lead' : studentId ? 'Student' : universityId ? 'University' : therapyId ? 'Child' : projectId ? 'Projects' : allotmentId ? 'Allotment' : ledgerId ? 'Ledger' : receiptId ? 'Receipt' : formId ? 'Booking form' : propertyId ? 'Properties' : rentReceiptId ? 'Rent receipt' : nav.find(n => n[0] === path)?.[1] ?? ''
  const homePath = isPlatform ? '/users' : '/'
  const home = path === homePath

  const logout = async () => { await api('/logout', { body: {} }).catch(() => {}); delete localStorage.token; go('/'); location.reload() }
  const toggleAvailable = async () => { await api('/me/available', { body: { available: !meta.me.available } }); reloadMeta() }
  const search = e => {
    const { q } = formData(e)
    if (!propertyOn && eduOn) go('/students?q=' + encodeURIComponent(q))
    else if (!propertyOn && therapyOn) go('/')
    else go('/leads?q=' + encodeURIComponent(q))
  }

  if (isPlatform) return <PlatformAdmin />

  return (
    <Meta.Provider value={{ ...meta, can: p => meta.perms.includes(p), reloadMeta }}>
      <div className="shell">
        <LogoIntro />
        <nav>
          <a className="logo" href={'#' + homePath} aria-label="Estate Centric home"><img src={markImg} alt="" /></a>
          {nav.filter(n => (!n[3] || meta.perms.includes(n[3])) && n[4] !== 'more').map(([href, label, icon, , group]) => (
            <a key={href} href={'#' + href} className={[(href === homePath ? home : path.startsWith(href)) ? 'active' : '', group === 'wide' ? 'nav-wide' : ''].filter(Boolean).join(' ')}><Icon name={icon} size={20} /><span>{label}</span></a>
          ))}
          {moreItems.length > 0 && <MoreMenu items={moreItems} path={path} home={home} />}
          <div className="spacer" />
          <a className="nav-logout" href="#" onClick={e => { e.preventDefault(); logout() }}><Icon name="logout" size={20} /><span>Log out</span></a>
          <a className="avatar" href="#/settings?tab=profile" title={`${meta.me.name} · ${meta.me.role.replace('_', ' ')} · Profile & settings`}>{meta.me.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</a>
        </nav>
        <main>
          <div className={'hero-bg' + (home ? ' tall' : '')} />
          {meta.me.trial_days_left != null && <p className="trial-bar">
            {planName(meta.me.plan)} free trial — {meta.me.trial_days_left > 0
              ? <>{meta.me.trial_days_left} day{meta.me.trial_days_left === 1 ? '' : 's'} left</>
              : <>ended</>}
            <a href={waLink(SUPPORT_WHATSAPP, `I'd like to activate my ${planName(meta.me.plan)} plan on Estate Centric`)} target="_blank" rel="noreferrer">Activate</a>
          </p>}
          <div className={'page-head' + (home ? ' home' : '')}>
            <div className="topbar">
              <MobileAccount me={meta.me} onLogout={logout} />
              {!isPlatform && <form className="glass search" onSubmit={search}>
                <Icon name="search" size={16} />
                <input ref={searchInput} name="q" placeholder={!propertyOn && eduOn ? 'Search students…' : 'Search leads…'} defaultValue={new URLSearchParams(query).get('q') || ''} key={query} aria-label={!propertyOn && eduOn ? 'Search students' : 'Search leads'} />
                <kbd className="search-kbd" title="Press ⌘K or / to search">⌘K</kbd>
              </form>}
              {meta.me.role === 'agent' && (
                <button className={'avail glass' + (meta.me.available ? '' : ' paused')} onClick={toggleAvailable} title={!propertyOn && eduOn ? 'Toggle receiving new student inquiries' : 'Toggle receiving new leads'}>
                  {meta.me.available ? '● Available' : '○ Paused'}
                </button>
              )}
              {!isPlatform && <Bell />}
              <InstallPrompt />
              {!isPlatform && propertyOn && <a className="glass button" href="#/leads?new=1"><Icon name="plus" size={16} /><span className="label">Add lead</span></a>}
              {!isPlatform && !propertyOn && eduOn && <a className="glass button" href="#/students?new=1"><Icon name="plus" size={16} /><span className="label">Add student</span></a>}
            </div>
            {!home && <h1 className="page-title">{title}</h1>}
          </div>
          <div className="content">{page}</div>
        </main>
        {!isPlatform && <Assistant />}
      </div>
    </Meta.Provider>
  )
}
