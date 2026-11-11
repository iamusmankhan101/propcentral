import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, fmt } from './api.js'
import { Select, When } from './Leads.jsx'
import { PLANS, MODULES, parseModules, limitLine } from '../shared/plans.js'
import Icon from './Icon.jsx'


export function Users() {
  const m = useMeta()
  const [users, reload] = useApi('/users')
  const [roleData] = useApi('/roles')
  const { run, error, busy, setError } = useAction()
  const [msg, setMsg] = useState('')
  const [resetLink, setResetLink] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [tab, setTab] = useState('directory')
  const teams = m.teams.map(t => [t.id, t.name]), branches = m.branches.map(b => [b.id, b.name])
  const isPlatform = m.me.role === 'platform'
  const done = text => { setMsg(text); reload(); m.reloadMeta() }

  const [showCreate, setShowCreate] = useState(false)
  const create = e => {
    const form = e.target
    const body = formData(e)
    run(async () => {
      if (isPlatform) {
        const r = await api('/platform/accounts', { body })
        setResetLink(location.origin + '/#/reset?token=' + r.token)
        setMsg(`Company workspace account for ${body.name} created! Share the setup link below — it expires in 30 minutes.`)
      } else {
        // If admin left password blank, generate a random one — they'll use the reset link to set their own
        if (!body.password) body.password = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + 'Aa1!'
        const { id } = await api('/users', { body })
        const r = await api(`/users/${id}/invite`, { body: {} })
        setResetLink(r.invite_url)
        setMsg(`${body.name} added. ${r.email_sent ? 'An invitation was emailed.' : 'Email is not configured, so share the link below.'}`)
      }
      form.reset(); setShowCreate(false); reload(); m.reloadMeta()
    })
  }
  const patch = (u, body) => run(async () => { await api('/users/' + u.id, { method: 'PATCH', body }); done('Saved') })
  // The platform switches a product module on for a whole company; the setting lives on its main account
  const setModule = (u, id, on) => run(async () => {
    const other = parseModules(u.modules).filter(x => x !== id)
    await api(`/platform/accounts/${u.id}/modules`, { body: { modules: on ? [...other, id] : other } })
    done(`${u.name}: ${MODULES.find(x => x.id === id)?.name ?? id} ${on ? 'enabled' : 'disabled'}`)
  })
  const deactivate = u => run(async () => {
    const r = await api(`/users/${u.id}/deactivate`, { body: {} })
    done(`${u.name} deactivated. ${r.reassigned} of ${r.open} open leads reassigned.`)
  })
  const deleteAccount = u => run(async () => {
    if (isPlatform && u.owner_id == null) {
      await api(`/platform/accounts/${u.id}`, { method: 'DELETE' })
      done(`Workspace "${u.name}" and its associated accounts were deleted.`)
    } else {
      await api(`/users/${u.id}`, { method: 'DELETE' })
      done(`User "${u.name}" was permanently deleted.`)
    }
  })
  // Hand out a one-time link instead of choosing the password for them
  const invite = u => run(async () => {
    const r = await api(`/users/${u.id}/invite`, { body: {} })
    setResetLink(r.invite_url)
    setMsg(`${r.email_sent ? 'Invitation emailed' : 'Email is not configured; invite link generated'} for ${u.name}. It expires in 30 minutes and works once.`)
  })
  const addOrg = (path, body) => run(async () => { await api(path, { body }); done('Added') })

  return (
    <section>
      <h2>{m.me.role === 'platform' ? 'Accounts' : 'Users'}</h2>
      <p className="muted">Invite people with a role, team and branch. Their role controls the permissions shown below; fine-tune role permissions in Settings › Roles & permissions. Only users in this workspace are shown.</p>
      {!isPlatform && <div className="seg no-print" style={{ marginBottom: 16 }}>
        <button className={tab === 'directory' ? 'on' : ''} onClick={() => setTab('directory')}>User directory</button>
        <button className={tab === 'performance' ? 'on' : ''} onClick={() => setTab('performance')}>Performance</button>
      </div>}
      {tab === 'performance' && !isPlatform ? <UserPerformance /> : <>
      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error" onClick={() => setError('')}>{error}</p>}
      {resetLink && <div className="card row between reset-link">
        <input readOnly value={resetLink} onFocus={e => e.target.select()} aria-label="Invitation link" />
        <button onClick={() => { navigator.clipboard?.writeText(resetLink); setMsg('Reset link copied') }}>Copy</button>
        <button className="ghost" onClick={() => setResetLink('')}>Dismiss</button>
      </div>}
      <div className="card scroll">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Team</th><th>Branch</th><th>Plan</th>{isPlatform && <th>Modules</th>}<th>Open leads</th><th>Max open</th><th title="Empty = default from Settings › commission">Commission %</th><th>Available</th><th></th></tr></thead>
          <tbody>{users?.map(u => (
            <tr key={u.id} className={u.active ? '' : 'muted'}>
              <td>{u.name}<small><br />{u.phone}</small></td><td>{u.email}</td>
              <td>
                <Select value={u.role} onChange={e => patch(u, { role: e.target.value })} options={m.roles.map(r => [r.key, r.label])} blank={null} />
                <button className="ghost" type="button" onClick={() => setExpanded(expanded === u.id ? null : u.id)}>{expanded === u.id ? 'Hide permissions' : 'View permissions'}</button>
                {expanded === u.id && <small className="muted permission-list">{(roleData?.permissions && Object.entries(roleData.permissions).filter(([, roles]) => roles.includes(u.role)).map(([key]) => key.replaceAll('_', ' ')).join(', ')) || 'No permissions assigned'}</small>}
              </td>
              <td><Select value={u.team_id ?? ''} onChange={e => patch(u, { team_id: e.target.value || null })} options={teams} blank="—" /></td>
              <td><Select value={u.branch_id ?? ''} onChange={e => patch(u, { branch_id: e.target.value || null })} options={branches} blank="—" /></td>
              <td>
                <Select value={u.plan ?? ''} onChange={e => patch(u, { plan: e.target.value || null })} options={PLANS.map(p => [p.id, p.name])} blank="No plan" />
                {u.paid_at ? <small className="ok"><br />Paid {fmt(u.paid_at).slice(0, 10)}</small>
                  : u.trial_ends_at ? <small className={u.trial_ends_at < new Date().toISOString() ? 'warn' : 'muted'}><br />Trial to {fmt(u.trial_ends_at).slice(0, 10)}</small> : null}
              </td>
              {isPlatform && <td>{u.owner_id == null
                ? MODULES.map(x => <label key={x.id} className="module-toggle" title={x.blurb}>
                  <input type="checkbox" checked={parseModules(u.modules).includes(x.id)} disabled={busy} onChange={e => setModule(u, x.id, e.target.checked)} />{x.name}
                </label>)
                : <small className="muted" title="Set on the main account this user belongs to">inherits</small>}</td>}
              <td>{u.open_leads}</td>
              <td><input type="number" className="narrow" defaultValue={u.max_open} onBlur={e => +e.target.value !== u.max_open && patch(u, { max_open: +e.target.value })} /></td>
              <td><input type="number" className="narrow" min="0" max="20" step="0.1" placeholder={`${m.settings.commission?.agent_pct ?? 1} (default)`} defaultValue={u.commission_rate ?? ''}
                onBlur={e => e.target.value !== String(u.commission_rate ?? '') && patch(u, { commission_rate: e.target.value })} aria-label={`Commission % for ${u.name}`} /></td>
              <td><input type="checkbox" checked={!!u.available} onChange={e => patch(u, { available: e.target.checked ? 1 : 0 })} /></td>
              <td className="row">
                <button className="ghost" onClick={() => invite(u)}>Invite link</button>
                {u.plan && !u.paid_at && <button className="ghost" onClick={() => run(async () => { await api(`/users/${u.id}/mark-paid`, { body: {} }); done(`${u.name} marked paid — the trial lock is off`) })}>Mark paid</button>}
                {u.totp_on ? <button className="ghost" onClick={() => confirm(`Turn off two-factor login for ${u.name}? (e.g. lost phone)`) && run(async () => { await api(`/users/${u.id}/reset-2fa`, { body: {} }); done('2FA reset') })}>Reset 2FA</button> : null}
                {u.active
                  ? <button className="ghost danger" disabled={busy} onClick={() => confirm(`Deactivate ${u.name}? Their sessions end and open leads are reassigned.`) && deactivate(u)}>Offboard</button>
                  : <button className="ghost" onClick={() => run(async () => { await api(`/users/${u.id}/activate`, { body: {} }); done('Activated') })}>Activate</button>}
                {(!u.active || isPlatform) && u.id !== m.me.id && (
                  <button className="ghost danger" disabled={busy} title="Permanently delete account" onClick={() => confirm(`Are you sure you want to permanently delete "${u.name}"? This cannot be undone.`) && deleteAccount(u)}>Delete</button>
                )}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      {showCreate ? (
        <form className="card grid" onSubmit={create}>
          <div className="wide row space-between between">
            <h3 style={{margin:0}}>{isPlatform ? 'Create new company workspace' : 'Create account'}</h3>
            <button type="button" className="ghost" onClick={() => setShowCreate(false)}>✕ Cancel</button>
          </div>
          <label>Company / Admin Name<input name="name" placeholder={isPlatform ? 'e.g. Apex Real Estate' : 'Full name'} required autoFocus /></label>
          <label>Admin Email<input name="email" type="email" placeholder="admin@company.com" required /></label>
          <label>Phone (optional)<input name="phone" placeholder="03xx xxxxxxx" /></label>
          {isPlatform ? (
            <label>Plan
              <Select name="plan" options={PLANS.map(p => [p.id, `${p.name} (PKR ${p.monthly.toLocaleString('en-PK')}/mo)`])} defaultValue="solo" blank={null} />
            </label>
          ) : (
            <>
              <label>Role<Select name="role" options={m.roles.map(r => [r.key, r.label])} defaultValue="agent" blank={null} /></label>
              <label>Team<Select name="team_id" options={teams} blank="—" /></label>
              <label>Branch<Select name="branch_id" options={branches} blank="—" /></label>
              <label title="Leave blank — a set-password link is generated automatically and shown after saving">
              Password <small className="muted">(optional — leave blank to invite them to set it)</small>
                <input name="password" type="password" minLength="10" maxLength="200" placeholder="Leave blank to auto-generate" />
              </label>
            </>
          )}
          <div className="wide">
            <button disabled={busy}>
              {isPlatform ? 'Create Workspace & Generate Setup Link' : 'Invite user & generate link'}
            </button>
          </div>
        </form>
      ) : (
        <div style={{marginBottom:'16px'}}>
          <button onClick={() => { setShowCreate(true); setMsg(''); setResetLink('') }}>
            <Icon name="users" size={15} /> {isPlatform ? 'Create new company workspace' : 'Create account'}
          </button>
        </div>
      )}

      <div className="cols">
        <form className="card" onSubmit={e => { const b = formData(e); e.target.reset(); addOrg('/branches', b) }}>
          <h3>Branches</h3>
          {m.branches.map(b => <p key={b.id}>{b.name} <small className="muted">#{b.id} · {b.city}</small></p>)}
          <div className="row"><input name="name" placeholder="Branch name" required /><input name="city" placeholder="City" /><button>Add</button></div>
        </form>
        <form className="card" onSubmit={e => { const b = formData(e); e.target.reset(); addOrg('/teams', b) }}>
          <h3>Teams</h3>
          {m.teams.map(t => <p key={t.id}>{t.name} <small className="muted">#{t.id} · {m.branches.find(b => b.id === t.branch_id)?.name}</small></p>)}
          <div className="row"><input name="name" placeholder="Team name" required /><Select name="branch_id" options={branches} blank="Branch" /><button>Add</button></div>
        </form>
      </div>
      </>}
    </section>
  )
}

function UserPerformance() {
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA'))
  const [query, setQuery] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [data, , error] = useApi('/users/performance?date=' + encodeURIComponent(date))
  const rows = (data?.rows || []).filter(u => (!activeOnly || u.active) && (!query || `${u.name} ${u.email} ${u.role}`.toLowerCase().includes(query.toLowerCase())))
  const fmtMoney = n => `PKR ${Number(n || 0).toLocaleString('en-PK')}`
  return <>
    <div className="row between no-print" style={{ marginBottom: 16 }}>
      <div className="row"><label className="muted">Performance date <input type="date" value={date} onChange={e => setDate(e.target.value)} /></label><input placeholder="Search users…" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <label className="row muted"><input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} /> Active only</label>
    </div>
    {error && <p className="error">{error}</p>}
    <div className="card scroll">
      <h3>User performance · {date}</h3>
      <p className="muted">Daily figures use the selected date. Total leads and conversion cover the user’s assigned leads in this workspace.</p>
      <table className="report">
        <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Daily leads</th><th>Total leads</th><th>Open leads</th><th>Contacted</th><th>Calls today</th><th>Visits today</th><th>Bookings today</th><th>Sales today</th></tr></thead>
        <tbody>{rows.map(u => <tr key={u.id}>
          <td><b>{u.name}</b><small className="muted"><br />{u.email}</small></td><td>{u.role}</td><td>{u.active ? <span className="ok">Active</span> : <span className="muted">Inactive</span>}</td>
          <td><b>{u.daily_leads}</b></td><td>{u.total_leads}</td><td>{u.open_leads}</td><td>{u.contacted} ({u.conversion}%)</td><td>{u.daily_calls}</td><td>{u.daily_visits}</td><td>{u.daily_bookings}</td><td>{fmtMoney(u.daily_sales)}</td>
        </tr>)}
        {data && !rows.length && <tr><td colSpan="11" className="muted">No users match.</td></tr>}
      </tbody></table>
    </div>
  </>
}

const HELP = {
  commission: 'Percent of the sale price, earned when a plot is allotted. agent_pct goes to the lead owner; dealer_pct to the dealer on the lead (a dealer\'s own rate overrides it).',
  assignment_rules: 'Evaluated by priority (low first). when: any lead field (source, city, project, lead_type, property_type…), plus min_budget and hours [from, to]. method: round_robin | load | performance | agent (with agent_id). Optional team_id / branch_id limit the pool.',
  sla_minutes: 'First-contact SLA in working minutes per source. Level 1 at 1×: remind agent. 2×: alert team lead. 3×: reassign.',
  working_hours: 'Per branch id, or "default". tz is the UTC offset (Pakistan = 5). days: 0 = Sunday.',
  permissions: 'Which roles may perform each action. Only admins can change this.',
  sites: 'Visit check-in locations. radius_m is the allowed GPS distance.',
  custom_fields: 'Extra lead fields, e.g. [{"key":"file_no","label":"File number"}]',
}

// Settings: personal sections for everyone, company sections by permission. ?tab= picks the section
const SECTIONS = [
  ['profile', 'Profile', 'users'], ['security', 'Privacy & security', 'key'],
  ['facebook', 'Facebook & Instagram', 'inbox', 'admin'], ['website', 'Website forms & API', 'arrow', 'admin'], ['maps', 'Maps', 'map', 'admin'], ['reports', 'Email reports', 'mail', 'settings'],
  ['leads', 'Leads & pipeline', 'leads', 'settings'], ['edu', 'Student consultancy', 'book', 'settings'], ['assignment', 'Assignment & SLA', 'clock', 'settings'], ['visits', 'Site visits', 'visits', 'settings'],
  ['inventory', 'Inventory & listings', 'building', 'settings'], ['properties', 'Properties & leases', 'key', 'settings'], ['sales', 'Commission', 'percent', 'settings'], ['permissions', 'Roles & permissions', 'audit', 'admin'],
  ['modules', 'Company modules', 'layers', 'admin'],
]
const GROUPS = ['Account', 'Integrations', 'Company']
const groupOf = k => (['profile', 'security'].includes(k) ? 'Account' : ['facebook', 'website', 'maps', 'reports'].includes(k) ? 'Integrations' : 'Company')
const KEYS = {
  leads: ['statuses', 'closed_statuses', 'approval_statuses', 'lost_reasons', 'sources', 'activity_types', 'outcomes', 'lead_types', 'property_types', 'custom_fields', 'stale_days', 'recycle_cooldown_days', 'scoring'],
  edu: ['edu_stages', 'edu_doc_types', 'edu_levels', 'edu_intakes', 'edu_countries', 'edu_application_statuses', 'edu_payment_types', 'edu_visa_outcomes'],
  assignment: ['assignment_rules', 'sla_minutes', 'working_hours'],
  visits: ['sites', 'visit_feedback_hours'],
  inventory: ['unit_statuses', 'listing_statuses', 'max_holds_per_agent'],
  properties: ['societies', 'lease_amber_days', 'lease_red_days'],
}
const LABELS = {
  statuses: 'Lead statuses', closed_statuses: 'Closed statuses', approval_statuses: 'Statuses that need approval', lost_reasons: 'Lost reasons', sources: 'Lead sources',
  activity_types: 'Activity types', outcomes: 'Call outcomes', lead_types: 'Lead types', property_types: 'Property types', custom_fields: 'Custom lead fields',
  stale_days: 'Stale lead after (days)', recycle_cooldown_days: 'Recycle cooldown (days)', scoring: 'Lead scoring points', assignment_rules: 'Assignment rules',
  sla_minutes: 'First-contact SLA (minutes)', working_hours: 'Working hours', sites: 'Visit sites', visit_feedback_hours: 'Visit feedback due within (hours)',
  societies: 'Societies & areas', lease_amber_days: 'Lease turns amber this many days before it ends', lease_red_days: 'Lease turns red this many days before it ends',
  unit_statuses: 'Unit statuses', listing_statuses: 'Listing statuses', max_holds_per_agent: 'Max units on hold per agent', permissions: 'Permissions',
  edu_stages: 'Admission journey stages', edu_doc_types: 'Document types', edu_levels: 'Study levels', edu_intakes: 'Available intakes',
  edu_countries: 'Destination countries', edu_application_statuses: 'Application lifecycle statuses', edu_payment_types: 'Payment & fee types', edu_visa_outcomes: 'Visa outcomes',
}

export function Settings({ query = '' }) {
  const m = useMeta()
  const propertyOn = (m.me.modules || []).includes('property')
  const eduOn = (m.me.modules || []).includes('edu')

  // Filter sections based on active company modules
  const PROPERTY_SECTIONS = ['leads', 'assignment', 'visits', 'inventory', 'properties', 'sales', 'maps']
  const EDU_SECTIONS = ['edu']

  const allowed = SECTIONS.filter(([k, , , perm]) => {
    if (!propertyOn && PROPERTY_SECTIONS.includes(k)) return false
    if (!eduOn && EDU_SECTIONS.includes(k)) return false
    return !perm || (perm === 'admin' ? m.me.role === 'admin' : m.can(perm))
  })

  const want = new URLSearchParams(query).get('tab')
  const tab = allowed.find(x => x[0] === want)?.[0] || (!propertyOn && eduOn ? 'edu' : 'profile')
  const [s, reload] = useApi(KEYS[tab] || ['reports', 'sales'].includes(tab) ? '/settings' : null)
  const saved = () => { reload(); m.reloadMeta() }
  const title = SECTIONS.find(x => x[0] === tab)?.[1] || 'Settings'
  return (
    <section className="settings">
      <div className="settings-nav card" role="navigation" aria-label="Settings sections">
        {GROUPS.map(g => allowed.some(x => groupOf(x[0]) === g) && (
          <div key={g}>
            <small>{g}</small>
            {allowed.filter(x => groupOf(x[0]) === g).map(([k, l, icon]) => (
              <a key={k} href={'#/settings?tab=' + k} className={tab === k ? 'on' : ''}><Icon name={icon} size={16} />{l}</a>
            ))}
          </div>
        ))}
      </div>
      <div className="settings-body">
        <h2>{title}</h2>
        {tab === 'profile' && <Profile />}
        {tab === 'security' && <Security />}
        {tab === 'facebook' && <Facebook />}
        {tab === 'website' && <WebsiteForms />}
        {tab === 'maps' && <MapsSetup />}
        {tab === 'reports' && s && <WeeklyReport v={s.weekly_report} onSaved={saved} />}
        {tab === 'sales' && s && <CommissionDefaults v={s.commission} onSaved={saved} />}
        {tab === 'permissions' && <RolesPermissions />}
        {tab === 'modules' && <CompanyModules />}
        {KEYS[tab] && s && <>
          <p className="muted">Changes apply immediately and are recorded in the audit log.</p>
          {KEYS[tab].map(k => <SettingField key={k} k={k} v={s[k]} onSaved={saved} />)}
        </>}
      </div>
    </section>
  )
}
const SettingField = ({ k, v, onSaved }) => typeof v === 'number' ? <NumberEditor k={k} v={v} onSaved={onSaved} />
  : Array.isArray(v) && v.every(x => typeof x === 'string') ? <ListEditor k={k} v={v} onSaved={onSaved} /> : <SettingEditor k={k} v={v} onSaved={onSaved} />

const putSetting = (k, value) => api('/settings/' + k, { method: 'PUT', body: { value } })

function NumberEditor({ k, v, onSaved }) {
  const { run, error, busy } = useAction()
  const [ok, setOk] = useState(false)
  const save = e => { const { n } = formData(e); run(async () => { await putSetting(k, +n); setOk(true); onSaved() }) }
  return (
    <form className="card row between" onSubmit={save} onChange={() => setOk(false)}>
      <b>{LABELS[k]}</b>
      <span className="row"><input name="n" type="number" min="0" className="narrow" defaultValue={v} required aria-label={LABELS[k]} /><button disabled={busy}>Save</button>{ok && <span className="ok">Saved</span>}</span>
      {error && <p className="error">{error}</p>}
    </form>
  )
}

function Profile() {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [ok, setOk] = useState(false)
  const save = e => { const b = formData(e); run(async () => { await api('/me', { method: 'PATCH', body: b }); setOk(true); m.reloadMeta() }) }
  return (
    <form className="card grid" onSubmit={save} onChange={() => setOk(false)}>
      <label>Name<input name="name" defaultValue={m.me.name} required /></label>
      <label>Mobile (for SMS alerts)<input name="phone" defaultValue={m.me.phone} placeholder="0300 1234567" /></label>
      <label>Email<input value={m.me.email} disabled /></label>
      <label>Role<input value={m.me.role.replace('_', ' ')} disabled /></label>
      <p className="muted wide"><small>Your email and role are managed by an admin under Users.</small></p>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Save profile</button>{ok && <span className="ok">Saved</span>}</div>
    </form>
  )
}

function Security() {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [setup, setSetup] = useState(null)
  const [pwOk, setPwOk] = useState(false)
  const startTotp = () => run(async () => setSetup(await api('/me/2fa/setup', { body: {} })))
  const enableTotp = e => { const { code } = formData(e); run(async () => { await api('/me/2fa/enable', { body: { code } }); setSetup(null); m.reloadMeta() }) }
  const enableEmail2fa = () => run(async () => { await api('/me/2fa/email/enable', { body: {} }); m.reloadMeta() })
  const disable = e => { const { password } = formData(e); run(async () => { await api('/me/2fa/disable', { body: { password } }); m.reloadMeta() }) }
  const changePw = e => {
    const form = e.target, b = formData(e)
    if (b.password !== b.confirm) return run(async () => { throw new Error('The new passwords do not match') })
    run(async () => { await api('/me/password', { body: b }); form.reset(); setPwOk(true) })
  }
  return (
    <>
      <div className="card">
        <h3>Two-factor login {m.me.totp_on ? <span className="status u-available">On ({m.me.two_factor_method === 'email' ? 'Email Code' : 'Authenticator App'})</span> : <span className="status">Off</span>}</h3>
        {m.me.totp_on ? (
          <form className="row between" onSubmit={disable}>
            <p className="muted">
              {m.me.two_factor_method === 'email'
                ? `You receive a 6-digit code at ${m.me.email} each time you sign in.`
                : 'You enter a code from your authenticator app each time you log in.'}
            </p>
            <span className="row"><input name="password" type="password" placeholder="Your password" required /><button className="ghost danger" disabled={busy}>Turn off</button></span>
          </form>
        ) : setup ? (
          <form onSubmit={enableTotp}>
            <ol>
              <li>Open Google Authenticator, Authy or 1Password and choose <b>Add account › Enter a setup key</b>.</li>
              <li>Account: <b>{m.me.email}</b>. Key (time based): <code className="secret">{setup.secret.match(/.{1,4}/g).join(' ')}</code></li>
              <li>On a phone, you can tap <a href={setup.uri}>this link</a> instead.</li>
              <li>Type the 6-digit code the app shows:</li>
            </ol>
            <div className="row"><input name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required autoFocus /><button disabled={busy}>Turn on</button> <button type="button" className="ghost" onClick={() => setSetup(null)}>Cancel</button></div>
          </form>
        ) : (
          <div className="cols" style={{marginTop:'12px'}}>
            <div style={{padding:'14px',border:'1px solid var(--line)',borderRadius:'10px'}}>
              <h4 style={{margin:'0 0 6px'}}>Email verification code</h4>
              <p className="muted" style={{fontSize:'12.5px',marginBottom:'12px'}}>Receive a 6-digit code on <b>{m.me.email}</b> each time you log in.</p>
              <button onClick={enableEmail2fa} disabled={busy} className="button">Enable Email 2FA</button>
            </div>
            <div style={{padding:'14px',border:'1px solid var(--line)',borderRadius:'10px'}}>
              <h4 style={{margin:'0 0 6px'}}>Authenticator App</h4>
              <p className="muted" style={{fontSize:'12.5px',marginBottom:'12px'}}>Use Google Authenticator, Authy, or 1Password.</p>
              <button onClick={startTotp} disabled={busy} className="ghost">Set up App 2FA</button>
            </div>
          </div>
        )}
      </div>
      <form className="card grid" onSubmit={changePw} onChange={() => setPwOk(false)}>
        <h3 className="wide">Change password</h3>
        <label>Current password<input name="current" type="password" autoComplete="current-password" required /></label>
        <label>New password<input name="password" type="password" autoComplete="new-password" minLength="8" required /></label>
        <label>Repeat new password<input name="confirm" type="password" autoComplete="new-password" minLength="8" required /></label>
        <p className="muted wide"><small>At least 8 characters. Your other devices are logged out when you change it.</small></p>
        <div className="wide row"><button disabled={busy}>Change password</button>{pwOk && <span className="ok">Password changed</span>}</div>
      </form>
      <div className="card">
        <h3>Privacy</h3>
        <ul className="plain muted">
          <li>Phone numbers and CNICs are masked for roles that don't need them (Roles &amp; permissions › view_phone).</li>
          <li>Every login, lead view, export and change is written to the audit log, which can't be edited.</li>
          <li>Exports are watermarked with the name of the person who downloaded them.</li>
        </ul>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  )
}

// Facebook & Instagram Lead Ads: paste the app secret + a Graph API Explorer token, the server does the rest
function Facebook() {
  const [s, reload] = useApi('/facebook')
  const { run, error, busy } = useAction()
  const [pages, setPages] = useState(null)
  const [open, setOpen] = useState(false)
  if (!s) return <p className="muted">Loading…</p>
  const connected = !!s.connected_at
  const showForm = open || !connected
  const connect = e => {
    const body = formData(e)
    run(async () => {
      const r = await api('/facebook/connect', { body })
      if (r.pages) return setPages(r.pages)
      setPages(null); setOpen(false); reload()
    })
  }
  const disconnect = () => confirm(`Disconnect ${s.page_name}? New Facebook leads stop arriving.`) && run(async () => { await api('/facebook/disconnect', { body: {} }); reload() })
  return (
    <div className="card">
      <div className="row between">
        <div>
          <h3>Lead Ads {connected ? <span className="status u-available">Connected</span> : <span className="status">Not connected</span>}</h3>
          <p className="muted">{connected
            ? <>Page <b>{s.page_name}</b> since {fmt(s.connected_at)} · {s.last_lead.n ? `${s.last_lead.n} leads, last ${fmt(s.last_lead.at)}` : 'no leads yet'}</>
            : 'New leads from your Facebook and Instagram ad forms arrive here automatically, with campaign, ad set and ad.'}</p>
        {connected && <p className="muted">{!s.recent?.length
          ? 'No webhook delivery from Facebook yet. If a test lead does not show up, Meta is not reaching this address.'
          : <>Recent deliveries: {s.recent.map(r => r.ok ? `lead ${r.id} imported` : r.sig ? 'delivery rejected (wrong app secret)' : `lead ${r.id} failed: ${r.err}`).join(' · ')}</>}</p>}
        </div>
        {connected && <div className="row">
          <button className="ghost danger" onClick={disconnect} disabled={busy}>Disconnect</button>
          <button className="ghost" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Reconnect'}</button>
        </div>}
      </div>
      {showForm && (
        <form className="grid" onSubmit={connect}>
          <ol className="wide muted fb-steps">
            <li>At <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com/apps</a> create an app (type <b>Business</b>), add the <b>Webhooks</b> product, and copy the <b>App secret</b> from App settings › Basic.</li>
            <li>Open <a href="https://developers.facebook.com/tools/explorer" target="_blank" rel="noreferrer">Graph API Explorer</a>, pick your app, add the permissions <code>leads_retrieval</code>, <code>pages_show_list</code>, <code>pages_manage_metadata</code>, <code>pages_read_engagement</code>, <code>ads_read</code>, <code>business_management</code> (ads_read lets the CRM list your active campaigns), click <b>Generate Access Token</b>, tick your Page, and copy the token.</li>
            <li>Paste both below. The CRM makes a permanent Page token, registers the webhook and subscribes the Page.</li>
          </ol>
          <label>App secret<input name="app_secret" type="password" autoComplete="off" placeholder={s.app_secret ? `saved ${s.app_secret} (leave empty to keep)` : ''} required={!s.app_secret} /></label>
          <label>Public CRM address<input name="public_url" defaultValue={s.callback_url?.replace('/api/webhooks/facebook', '') || location.origin} placeholder="https://crm.yourcompany.com" required /></label>
          <label className="wide">Access token<textarea name="token" rows="3" autoComplete="off" required /></label>
          {pages && <label className="wide">Which Page?<Select name="page_id" options={pages.map(p => [p.id, p.name])} required /></label>}
          {error && <p className="error wide">{error}</p>}
          <div className="wide"><button disabled={busy}>{busy ? 'Connecting…' : pages ? 'Connect this Page' : 'Connect'}</button></div>
        </form>
      )}
      {!showForm && error && <p className="error">{error}</p>}
    </div>
  )
}

// Website forms, Zapier, portal parsers: one key, sent as the x-api-key header to POST /api/inbound
function WebsiteForms() {
  const [s, reload] = useApi('/integrations/inbound')
  const { run, error, busy } = useAction()
  const [show, setShow] = useState(false)
  const [copied, setCopied] = useState('')
  if (!s) return <p className="muted">Loading…</p>
  const url = `${location.origin}/api/inbound`
  const copy = (text, what) => navigator.clipboard.writeText(text).then(() => setCopied(what))
  const rotate = () => confirm(s.key ? 'Make a new key? Forms and Zaps using the old key stop working until you update them.' : 'Create the key?') &&
    run(async () => { await api('/integrations/inbound/rotate', { body: {} }); setShow(true); reload() })
  const example = `curl -X POST ${url} \\
  -H "x-api-key: ${show && s.key ? s.key : 'YOUR_KEY'}" -H "content-type: application/json" \\
  -d '{"name":"Ali Raza","phone":"0300-1234567","source":"Website","project":"Central Heights","budget_max":15000000,"remarks":"5 marla"}'`
  return (
    <>
      <div className="card">
        <h3>Lead endpoint {s.key ? <span className="status u-available">On</span> : <span className="status">Off</span>}</h3>
        <p className="muted">Your website contact form, Zapier, Make, Zameen/Graana email parsers or a phone system can send leads here. {s.website_leads_30d} website leads in the last 30 days.</p>
        <div className="kv">
          <span>Address</span><span className="row"><code>{url}</code><button className="ghost" onClick={() => copy(url, 'url')}>{copied === 'url' ? 'Copied' : 'Copy'}</button></span>
          <span>Header</span><span className="row"><code>x-api-key: {s.key ? (show ? s.key : '••••••••' + s.key.slice(-4)) : 'not set'}</code>
            {s.key && <><button className="ghost" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button><button className="ghost" onClick={() => copy(s.key, 'key')}>{copied === 'key' ? 'Copied' : 'Copy key'}</button></>}
            <button className={s.key ? 'ghost danger' : ''} onClick={rotate} disabled={busy}>{s.key ? 'New key' : 'Create key'}</button></span>
        </div>
        {s.from_env && <p className="muted"><small>This key comes from the server's .env file. “New key” replaces it here.</small></p>}
        {error && <p className="error">{error}</p>}
      </div>
      <div className="card">
        <h3>How to send a lead</h3>
        <p className="muted">POST JSON with <b>name</b> and <b>phone</b>. Optional: source (default Website), campaign, email, city, project, property_type, budget_min, budget_max, remarks, and ext_id (your own ID, so the same lead isn't added twice). Repeat inquiries from the same phone are attached to the existing lead.</p>
        <pre className="code">{example}</pre>
        <ul className="plain muted">
          <li><b>Zapier / Make:</b> add a “Webhooks › POST” step with the address above, payload type JSON, the x-api-key header, and map your form fields.</li>
          <li><b>Website:</b> send from your site's server or form plugin webhook. Never put the key in website JavaScript, where anyone can read it.</li>
        </ul>
      </div>
    </>
  )
}

function MapsSetup() {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [ok, setOk] = useState('')
  const save = e => { const { key } = formData(e); run(async () => { await api('/integrations/maptiler', { method: 'PUT', body: { key } }); setOk(key ? 'Saved. Open Properties to see the map.' : 'Removed'); m.reloadMeta() }) }
  return (
    <form className="card" onSubmit={save}>
      <h3>Satellite map (MapTiler) {m.maptiler_key ? <span className="status u-available">On</span> : <span className="status">Off</span>}</h3>
      <ol className="muted fb-steps">
        <li>Sign up free at <a href="https://cloud.maptiler.com/account/keys/" target="_blank" rel="noreferrer">cloud.maptiler.com</a> and open <b>API keys</b>.</li>
        <li>Copy the default key, or create one. Under <b>Allowed HTTP origins</b>, add your CRM address (e.g. crm.yourcompany.com) so nobody else can use it.</li>
        <li>Paste it here. The free plan covers a small team; MapTiler emails you before you reach the limit.</li>
      </ol>
      <div className="row"><input name="key" defaultValue={m.maptiler_key || ''} placeholder="MapTiler API key" style={{ flex: 1 }} autoComplete="off" /><button disabled={busy}>Save</button>{ok && <span className="ok">{ok}</span>}</div>
      {error && <p className="error">{error}</p>}
    </form>
  )
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
function WeeklyReport({ v, onSaved }) {
  const { run, error, busy } = useAction()
  const [msg, setMsg] = useState('')
  const save = e => {
    const b = formData(e), recipients = b.recipients.split(/[\s,;]+/).filter(Boolean)
    const bad = recipients.find(r => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))
    if (bad) return run(async () => { throw new Error(`“${bad}” is not an email address`) })
    run(async () => { await putSetting('weekly_report', { recipients, weekday: +b.weekday, hour: +b.hour }); setMsg('Saved'); onSaved() })
  }
  const preview = () => run(async () => { const html = await api('/reports/weekly'); open(URL.createObjectURL(new Blob([html], { type: 'text/html' }))) })
  const send = () => run(async () => { await api('/reports/weekly/send', { body: {} }); setMsg('Sent') })
  return (
    <form className="card grid" onSubmit={save} onChange={() => setMsg('')}>
      <h3 className="wide">Weekly sales &amp; collections email</h3>
      <p className="muted wide">New leads, SLA breaches, sales, money collected, overdue and pending commission for the last 7 days.</p>
      <label className="wide">Send to<input name="recipients" defaultValue={v.recipients.join(', ')} placeholder="owner@company.com, sales.head@company.com" /></label>
      <label>Day<Select name="weekday" options={DAYS.map((d, i) => [i, d])} defaultValue={v.weekday} blank={null} /></label>
      <label>Time (Pakistan)<Select name="hour" options={Array.from({ length: 24 }, (_, h) => [h, `${String(h).padStart(2, '0')}:00`])} defaultValue={v.hour} blank={null} /></label>
      <p className="muted wide"><small>Email delivery isn't connected yet: reports are written to the server log until an email service is added.</small></p>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Save</button><button type="button" className="ghost" onClick={preview} disabled={busy}>Preview</button><button type="button" className="ghost" onClick={send} disabled={busy}>Send now</button>{msg && <span className="ok">{msg}</span>}</div>
    </form>
  )
}

const ACCESS_LABEL = { own: 'Own leads only', team: "Their team's leads", branch: "Their branch's leads", all: 'All leads', none: 'No leads' }
const PERMS = [
  ['view_phone', 'See full phone numbers & CNIC', 'Otherwise numbers are masked'], ['reassign', 'Reassign leads'], ['approve_lost', 'Approve Lost / Junk'],
  ['import', 'Import leads'], ['export', 'Export leads'], ['request_export', 'Request an export', 'Needs approval from someone who can export'],
  ['delete', 'Delete leads'], ['manage_inventory', 'Manage projects, units & media'], ['edit_pricing', 'Edit prices'],
  ['unit_status', 'Change unit status & allot plots'], ['payments', 'Payments, commissions & dealers'],
  ['edu', 'Student Consultancy', 'Only shows the Edu nav when the platform has switched the module on for this company'],
  ['therapy', 'Special Needs Therapy', 'Only shows the Therapy nav when the platform has switched the module on for this company'],
  ['therapy_approve', 'Approve therapy plans', 'Approve assessments, goals and reviews, assign staff and invite parents'],
  ['settings', 'Change company settings'], ['manage_users', 'Manage users'], ['audit', 'View audit log'],
]
const LOCKED = ['settings', 'manage_users'] // admins always keep these, so nobody locks themselves out

function RolesPermissions() {
  const m = useMeta()
  const [d, reload] = useApi('/roles')
  const [p, setP] = useState(null)
  const { run, error, busy } = useAction()
  const [ok, setOk] = useState('')
  if (!d) return <p className="muted">Loading…</p>
  const perms = p || d.permissions
  const done = msg => { setOk(msg); setP(null); reload(); m.reloadMeta() }
  const toggle = (perm, role) => { setOk(''); setP({ ...perms, [perm]: perms[perm]?.includes(role) ? perms[perm].filter(r => r !== role) : [...(perms[perm] || []), role] }) }
  const save = () => run(async () => { await api('/settings/permissions', { method: 'PUT', body: { value: perms } }); done('Permissions saved') })
  const add = e => { const form = e.target, b = formData(e); run(async () => { await api('/roles', { body: b }); form.reset(); done(`Role ${b.label} added`) }) }
  const update = (r, body) => run(async () => { await api('/roles/' + r.key, { method: 'PATCH', body }); done('Saved') })
  const remove = r => confirm(`Delete the ${r.label} role?`) && run(async () => { await api('/roles/' + r.key, { method: 'DELETE' }); done('Role deleted') })
  const rename = r => { const label = prompt('Role name', r.label); if (label?.trim()) update(r, { label }) }
  return (
    <>
      {ok && <p className="ok">{ok}</p>}
      {error && <p className="error">{error}</p>}
      <div className="card scroll">
        <h3>Roles</h3>
        <p className="muted">A role decides which leads someone sees and, below, what they can do. Give people roles under Users.</p>
        <table>
          <thead><tr><th>Role</th><th>Sees</th><th>Active users</th><th></th></tr></thead>
          <tbody>
            {d.roles.map(r => (
              <tr key={r.key}>
                <td><b>{r.label}</b>{r.built_in && <small className="muted"> · built in</small>}</td>
                <td>{r.built_in ? ACCESS_LABEL[r.access] : <Select value={r.access} onChange={e => update(r, { access: e.target.value })} options={d.access.map(a => [a, ACCESS_LABEL[a]])} blank={null} />}</td>
                <td>{r.users}</td>
                <td className="row nowrap">{!r.built_in && <><button className="ghost" onClick={() => rename(r)}>Rename</button><button className="ghost danger" onClick={() => remove(r)} disabled={busy}>Delete</button></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="row" onSubmit={add} style={{ marginTop: 14 }}>
          <input name="label" placeholder="New role, e.g. Recovery officer" required />
          <Select name="access" options={d.access.map(a => [a, ACCESS_LABEL[a]])} defaultValue="own" blank={null} />
          <Select name="copy_from" options={d.roles.map(r => [r.key, 'Same permissions as ' + r.label])} blank="Start with no permissions" />
          <button disabled={busy}>Add role</button>
        </form>
        <p className="muted"><small>New leads are only auto-assigned to Agents and Team leads.</small></p>
      </div>
      <div className="card scroll">
        <div className="row between">
          <h3>Permissions</h3>
          <span className="row">{p && <button className="ghost" onClick={() => setP(null)}>Undo changes</button>}<button onClick={save} disabled={busy || !p}>Save permissions</button></span>
        </div>
        <table className="perm-grid">
          <thead><tr><th></th>{d.roles.map(r => <th key={r.key}>{r.label}</th>)}</tr></thead>
          <tbody>
            {PERMS.map(([k, label, hint]) => (
              <tr key={k}>
                <td><b>{label}</b>{hint && <small className="muted"><br />{hint}</small>}</td>
                {d.roles.map(r => {
                  const locked = r.key === 'admin' && LOCKED.includes(k)
                  return <td key={r.key}><input type="checkbox" checked={locked || !!perms[k]?.includes(r.key)} disabled={locked} onChange={() => toggle(k, r.key)} aria-label={`${r.label}: ${label}`} /></td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function CommissionDefaults({ v, onSaved }) {
  const { run, error, busy } = useAction()
  const [ok, setOk] = useState(false)
  const save = e => { const b = formData(e); run(async () => { await putSetting('commission', { agent_pct: +b.agent_pct, dealer_pct: +b.dealer_pct }); setOk(true); onSaved() }) }
  return (
    <form className="card grid" onSubmit={save} onChange={() => setOk(false)}>
      <p className="muted wide">Percent of the sale price, earned when a plot is allotted. These are the defaults: set a different rate per agent under Users, and per dealer on the Sales page.</p>
      <label>Agent commission %<input name="agent_pct" type="number" min="0" max="20" step="0.1" defaultValue={v.agent_pct} required /></label>
      <label>Dealer commission %<input name="dealer_pct" type="number" min="0" max="20" step="0.1" defaultValue={v.dealer_pct} required /></label>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row"><button disabled={busy}>Save</button>{ok && <span className="ok">Saved</span>}</div>
    </form>
  )
}

// Plain lists of names (sources, lost reasons, statuses…): add / remove instead of editing JSON
function ListEditor({ k, v, onSaved }) {
  const [items, setItems] = useState(v)
  const { run, error, busy } = useAction()
  const [ok, setOk] = useState(false)
  const change = next => { setItems(next); setOk(false) }
  const add = e => {
    const { item } = formData(e)
    const name = item.trim()
    if (name && !items.includes(name)) change([...items, name])
    e.target.reset()
  }
  const save = () => run(async () => { await api('/settings/' + k, { method: 'PUT', body: { value: items } }); setOk(true); onSaved() })
  return (
    <div className="card">
      <h3>{LABELS[k] || k} <span className="count">{items.length}</span></h3>
      {HELP[k] && <p className="muted">{HELP[k]}</p>}
      <div className="chips">
        {items.map(x => <span key={x} className="chip-item">{x}<button type="button" aria-label={'Remove ' + x} onClick={() => change(items.filter(i => i !== x))}>×</button></span>)}
        {!items.length && <span className="muted">None yet.</span>}
      </div>
      <form className="row" onSubmit={add}>
        <input name="item" placeholder="Add item" aria-label={'Add to ' + k} />
        <button className="ghost">Add</button>
        <button type="button" disabled={busy || items === v} onClick={save}>Save</button>
        {ok && <span className="ok">Saved</span>}
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function SettingEditor({ k, v, onSaved }) {
  const [text, setText] = useState(JSON.stringify(v, null, 2))
  const { run, error, busy } = useAction()
  const [ok, setOk] = useState(false)
  const save = () => run(async () => {
    let value
    try { value = JSON.parse(text) } catch { throw new Error('Not valid JSON') }
    await api('/settings/' + k, { method: 'PUT', body: { value } })
    setOk(true); onSaved()
  })
  return (
    <details className="card">
      <summary><b>{LABELS[k] || k}</b> <small className="muted">advanced · JSON</small></summary>
      {HELP[k] && <p className="muted">{HELP[k]}</p>}
      <textarea className="code" rows={Math.min(20, text.split('\n').length + 1)} value={text} onChange={e => { setText(e.target.value); setOk(false) }} />
      {error && <p className="error">{error}</p>}
      <div className="row"><button disabled={busy} onClick={save}>Save</button>{ok && <span className="ok">Saved</span>}</div>
    </details>
  )
}

export function Audit() {
  const [entity, setEntity] = useState('')
  const [rows] = useApi('/audit' + (entity ? '?entity=' + entity : ''))
  return (
    <section>
      <div className="row between">
        <h2>Audit log</h2>
        <Select value={entity} onChange={e => setEntity(e.target.value)} options={['lead', 'user', 'visit', 'setting']} blank="All" />
      </div>
      <div className="card scroll">
        <table>
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Data</th><th>IP</th></tr></thead>
          <tbody>{rows?.map(a => (
            <tr key={a.id}>
              <When d={a.created_at} /><td>{a.user_name || '—'}</td><td>{a.action}</td>
              <td>{a.entity === 'lead' && a.entity_id ? <a href={'#/leads/' + a.entity_id}>lead #{a.entity_id}</a> : `${a.entity} ${a.entity_id ?? ''}`}</td>
              <td><code>{a.data}</code></td><td>{a.ip}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  )
}


function CompanyModules() {
  const m = useMeta()
  const { run, error, busy } = useAction()
  const [msg, setMsg] = useState('')
  const currentModules = m.me.modules || []

  if (m.me.role !== 'admin' && m.me.role !== 'platform') {
    return (
      <div className="card">
        <h3>Active Company Modules</h3>
        <p className="muted">Only workspace administrators can manage company modules.</p>
      </div>
    )
  }

  const toggle = (id, on) => {
    let next
    if (on) next = [...new Set([...currentModules, id])]
    else next = currentModules.filter(x => x !== id)
    if (!next.length) return alert('At least one module must remain enabled.')

    run(async () => {
      await api('/company/modules', { method: 'POST', body: { modules: next } })
      setMsg('Company modules updated. Reloading navigation…')
      m.reloadMeta()
      setTimeout(() => location.reload(), 800)
    })
  }

  return (
    <div className="card">
      <h3>Active Company Modules</h3>
      <p className="muted">Turn modules on or off for this workspace. Each module is separate. At least one must stay on.</p>
      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error">{error}</p>}
      <div className="grid" style={{ marginTop: 12 }}>
        {MODULES.map(mod => (
          <label key={mod.id} className="card row between" style={{ cursor: 'pointer', padding: 14 }}>
            <div>
              <b>{mod.name}</b>
              <p className="muted" style={{ margin: '4px 0 0 0', fontSize: '0.85rem' }}>{mod.blurb}</p>
            </div>
            <input
              type="checkbox"
              checked={currentModules.includes(mod.id)}
              disabled={busy}
              onChange={e => toggle(mod.id, e.target.checked)}
              style={{ width: 20, height: 20 }}
            />
          </label>
        ))}
      </div>
    </div>
  )
}
