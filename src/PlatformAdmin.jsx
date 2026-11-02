import { useState, useEffect } from 'react'
import { api, useApi, fmt } from './api.js'
import { PLANS, MODULES, parseModules } from '../shared/plans.js'
import {
  LayoutDashboard,
  Clock,
  Store,
  Landmark,
  FileText,
  Users as UsersIcon,
  Archive,
  RefreshCw,
  LogOut,
  Shield,
  CheckCircle,
  XCircle,
  KeyRound,
  Snowflake,
  Trash2,
  Lock,
  LockOpen,
  Monitor,
  RotateCcw,
  Pencil,
  Copy,
  X,
  AlertTriangle,
  BadgeCheck,
  Banknote
} from 'lucide-react'

const ADMIN_TABS = [
  { key: 'dashboard', label: 'Overview', title: 'Overview', sub: 'Platform-wide view of accounts, workspaces, payments and backups.', Icon: LayoutDashboard },
  { key: 'requests', label: 'Payment requests', title: 'Payment requests', sub: 'Review and approve subscription payments.', Icon: Clock },
  { key: 'salons', label: 'Workspaces', title: 'Company Workspaces', sub: 'Manage workspaces, plan allocations, and modules.', Icon: Store },
  { key: 'paymentMethods', label: 'Payment methods', title: 'Payment methods', sub: 'Bank accounts shown to tenants on payment requests.', Icon: Landmark },
  { key: 'invoiceDetails', label: 'Invoice details', title: 'Invoice details', sub: 'Business billing identity shown on platform invoices.', Icon: FileText },
  { key: 'users', label: 'Users', title: 'All Users', sub: 'Every user across all tenant companies.', Icon: UsersIcon },
  { key: 'backups', label: 'Backups', title: 'Backups', sub: 'Download or review database backups.', Icon: Archive },
]

export default function PlatformAdmin() {
  const [tab, setTab] = useState('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const [requests, reloadRequests] = useApi('/platform/payment-requests')

  const pendingCount = (requests || []).filter(r => r.status === 'pending').length
  const currentTab = ADMIN_TABS.find(t => t.key === tab) || ADMIN_TABS[0]

  const handleSignOut = () => {
    delete localStorage.token
    window.location.hash = '#/'
    window.location.reload()
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f4f5f7', color: '#1a1a2e', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Top Header Bar */}
      <header style={{
        background: '#0d0d14', padding: '12px 24px', display: 'flex', alignItems: 'center',
        gap: 14, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 60,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: '#7C3AED', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 900, fontSize: 14 }}>
            EC
          </div>
          <span style={{ fontSize: 15, fontWeight: 850, color: '#fff', letterSpacing: '-0.02em' }}>Estate Centric</span>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20,
          background: 'rgba(124,58,237,0.18)', border: '1px solid rgba(167,139,250,0.4)',
        }}>
          <Shield size={12} color="#c4b5fd" />
          <span style={{ fontSize: 10.5, fontWeight: 800, color: "#c4b5fd", letterSpacing: "0.07em" }}>PLATFORM ADMIN CONSOLE</span>
        </div>

        <div style={{ flex: 1 }} />

        <button
          type="button"
          onClick={handleSignOut}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 10,
            padding: '8px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
            background: 'transparent', border: '1px solid #2d2d42', color: '#fca5a5',
          }}
        >
          <LogOut size={13} /> Sign out
        </button>
      </header>

      {/* Main Container */}
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 20px 80px' }}>
        {/* Title Bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 900, color: '#1a1a2e', letterSpacing: '-0.03em' }}>
              {currentTab.title}
            </h1>
            <div style={{ fontSize: 12.5, color: '#9898b0', fontWeight: 600, marginTop: 4 }}>
              {currentTab.sub}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setRefreshKey(k => k + 1)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 10,
              padding: '9px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
              border: '1px solid #e4e4ef', background: '#fff', color: '#43435f',
            }}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, borderBottom: '1px solid #e8e8f2', overflowX: 'auto', scrollbarWidth: 'none' }}>
          {ADMIN_TABS.map(({ key, label, Icon }) => {
            const isCurrent = tab === key
            const count = key === 'requests' ? pendingCount : 0
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: '10px 14px', flexShrink: 0,
                  display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
                  fontWeight: 800, color: isCurrent ? '#6D28D9' : '#8b8ba3',
                  borderBottom: isCurrent ? '2px solid #7C3AED' : '2px solid transparent',
                  marginBottom: -1,
                }}
              >
                <Icon size={15} /> {label}
                {count > 0 && (
                  <span style={{ fontSize: 10.5, fontWeight: 900, color: '#fff', background: '#b45309', borderRadius: 20, padding: '1px 7px' }}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Tab Content Panels */}
        <div key={refreshKey}>
          {tab === 'dashboard' && <AdminDashboardPanel onNavigate={setTab} />}
          {tab === 'requests' && <PaymentRequestsPanel requests={requests} reload={reloadRequests} />}
          {tab === 'salons' && <WorkspacesPanel />}
          {tab === 'paymentMethods' && <PaymentMethodsPanel />}
          {tab === 'invoiceDetails' && <InvoiceDetailsPanel />}
          {tab === 'users' && <AllUsersPanel />}
          {tab === 'backups' && <BackupsPanel />}
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   1. DASHBOARD OVERVIEW PANEL
───────────────────────────────────────────────────────────────────────────── */
function AdminDashboardPanel({ onNavigate }) {
  const [data, reload, err] = useApi('/platform/dashboard')

  if (!data) return <div className="card pad muted">Loading overview…</div>
  if (err) return <div className="card pad error">{err}</div>

  const stats = [
    { label: 'Workspaces', value: data.accounts, sub: `${data.paid} on paid plan · ${data.in_trial} in trial`, Icon: Store, color: '#0284c7' },
    { label: 'Total Users', value: (data.accounts || 0) + (data.sub_users || 0), sub: `${data.sub_users} team members across workspaces`, Icon: UsersIcon, color: '#7C3AED' },
    { label: 'Pending Payments', value: data.requests?.pending || 0, sub: data.requests?.pending_amount ? `≈ PKR ${Number(data.requests.pending_amount).toLocaleString('en-PK')} awaiting review` : 'All clear', Icon: Clock, color: '#d97706' },
    { label: 'Monthly Recurring', value: `PKR ${(data.monthly_revenue || 0).toLocaleString('en-PK')}`, sub: `${data.paid} paying accounts`, Icon: Banknote, color: '#059669' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 4 Stat Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {stats.map((s, i) => (
          <div key={i} style={{ background: '#fff', borderRadius: 14, border: '1px solid #ebebf0', padding: '18px 20px', boxShadow: '0 1px 4px rgba(0,0,0,0.03)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: '#8b8ba3', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</span>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: `${s.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: s.color }}>
                <s.Icon size={17} />
              </div>
            </div>
            <div style={{ fontSize: 24, fontWeight: 900, color: '#1a1a2e', letterSpacing: '-0.03em' }}>{s.value}</div>
            <div style={{ fontSize: 11.5, color: '#9898b0', marginTop: 4, fontWeight: 500 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Status Chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: '#fff', border: '1px solid #ebebf0', fontSize: 12, fontWeight: 700, color: data.expiring_soon ? '#d97706' : '#059669' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: data.expiring_soon ? '#d97706' : '#059669' }} />
          {data.expiring_soon} trials expiring soon
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: '#fff', border: '1px solid #ebebf0', fontSize: 12, fontWeight: 700, color: data.locked_out ? '#dc2626' : '#059669' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: data.locked_out ? '#dc2626' : '#059669' }} />
          {data.locked_out || 0} locked out accounts
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: '#fff', border: '1px solid #ebebf0', fontSize: 12, fontWeight: 700, color: '#6b6b8a' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#6b6b8a' }} />
          {data.new_this_week || 0} sign-ups this week
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: '#fff', border: '1px solid #ebebf0', fontSize: 12, fontWeight: 700, color: '#7C3AED' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#7C3AED' }} />
          {data.with_edu || 0} workspaces with Student Consultancy
        </span>
      </div>

      {/* Two Columns: Plan distribution & Recent Signups */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
        {/* Plans */}
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #ebebf0', padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.03)' }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e', marginBottom: 14 }}>Plan Distribution (Paying)</div>
          {(data.revenue || []).map(p => (
            <div key={p.plan} style={{ padding: '10px 0', borderBottom: '1px solid #f4f4f8' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: '#4a4a6a' }}>{p.name}</span>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: '#1a1a2e' }}>{p.count} accounts <span style={{ color: '#9898b0', fontWeight: 500 }}>(PKR {p.monthly.toLocaleString('en-PK')}/mo)</span></span>
              </div>
              <div style={{ height: 6, background: '#f0f0f5', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, (p.count / Math.max(1, data.paid || 1)) * 100)}%`, height: '100%', background: '#7C3AED', borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </div>

        {/* Recent Workspaces */}
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #ebebf0', padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.03)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e' }}>Recent Workspace Signups</div>
            <button type="button" onClick={() => onNavigate('salons')} style={{ background: 'none', border: 'none', color: '#7C3AED', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>View all →</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(data.recent || []).slice(0, 5).map(u => (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderRadius: 8, background: '#fafafa', border: '1px solid #f0f0f8' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1a2e' }}>{u.name}</div>
                  <div style={{ fontSize: 11, color: '#9898b0' }}>{u.email} · {fmt(u.created_at).slice(0, 10)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 12, background: u.paid_at ? '#ecfdf5' : '#fffbeb', color: u.paid_at ? '#059669' : '#d97706', fontSize: 10.5, fontWeight: 800 }}>
                    {u.paid_at ? 'Paid' : 'Trial'}
                  </span>
                  <div style={{ fontSize: 11, color: '#6b6b8a', marginTop: 2 }}>{u.plan ? PLANS.find(p => p.id === u.plan)?.name : 'No plan'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   2. PAYMENT REQUESTS PANEL
───────────────────────────────────────────────────────────────────────────── */
function PaymentRequestsPanel({ requests, reload }) {
  const [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState(false)

  const act = async (id, status) => {
    setBusy(true)
    try {
      await api(`/platform/payment-requests/${id}/${status}`, { body: {} })
      reload()
    } finally {
      setBusy(false)
    }
  }

  const list = (requests || []).filter(r => filter === 'all' ? true : r.status === filter)
  const counts = {
    all: (requests || []).length,
    pending: (requests || []).filter(r => r.status === 'pending').length,
    approved: (requests || []).filter(r => r.status === 'approved').length,
    rejected: (requests || []).filter(r => r.status === 'rejected').length,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: 8 }}>
        {[
          { key: 'all', label: 'All', color: '#7C3AED', bg: '#f5f3ff' },
          { key: 'pending', label: 'Pending', color: '#d97706', bg: '#fffbeb' },
          { key: 'approved', label: 'Approved', color: '#059669', bg: '#ecfdf5' },
          { key: 'rejected', label: 'Rejected', color: '#dc2626', bg: '#fef2f2' },
        ].map(f => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            style={{
              padding: '8px 16px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${filter === f.key ? f.color : '#e4e4ee'}`,
              background: filter === f.key ? f.bg : '#fff',
              color: filter === f.key ? f.color : '#6b6b8a',
            }}
          >
            {f.label} ({counts[f.key]})
          </button>
        ))}
      </div>

      {/* Cards List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {list.length === 0 ? (
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #ebebf0', padding: '48px', textAlign: 'center', color: '#9898b0' }}>
            <Clock size={28} style={{ opacity: 0.4 }} />
            <div style={{ fontSize: 14, fontWeight: 750, color: '#6b6b8a', marginTop: 10 }}>No {filter === 'all' ? '' : filter} requests</div>
          </div>
        ) : (
          list.map(r => (
            <div key={r.id} style={{ background: '#fff', borderRadius: 14, border: `1px solid ${r.status === 'pending' ? '#fde68a' : '#ebebf0'}`, padding: 18, boxShadow: '0 1px 4px rgba(0,0,0,0.03)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 12, background: '#f0f0f8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: '#7C3AED' }}>
                    {(r.user_name || 'U').charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e' }}>{r.user_name} <span style={{ fontWeight: 400, color: '#9898b0' }}>({r.user_email})</span></div>
                    <div style={{ fontSize: 11.5, color: '#6b6b8a', marginTop: 2 }}>
                      Method: <b>{r.method}</b> {r.reference && `· Ref: ${r.reference}`} · {fmt(r.created_at)}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 16, fontWeight: 900, color: '#7C3AED' }}>PKR {Number(r.amount).toLocaleString('en-PK')}</div>
                    <div style={{ fontSize: 11, color: '#9898b0' }}>{PLANS.find(p => p.id === r.plan)?.name || r.plan} Plan</div>
                  </div>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 20,
                    background: r.status === 'approved' ? '#ecfdf5' : r.status === 'rejected' ? '#fef2f2' : '#fffbeb',
                    color: r.status === 'approved' ? '#059669' : r.status === 'rejected' ? '#dc2626' : '#d97706',
                    fontSize: 11.5, fontWeight: 800, textTransform: 'capitalize',
                  }}>
                    {r.status === 'approved' ? <CheckCircle size={12} /> : r.status === 'rejected' ? <XCircle size={12} /> : <Clock size={12} />}
                    {r.status}
                  </span>
                </div>
              </div>

              {r.note && (
                <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, background: '#fafafa', fontSize: 12, color: '#6b6b8a' }}>
                  <b>Note:</b> {r.note}
                </div>
              )}

              {r.status === 'pending' && (
                <div style={{ display: 'flex', gap: 10, marginTop: 14, paddingTop: 12, borderTop: '1px solid #f4f4f8' }}>
                  <button
                    disabled={busy}
                    onClick={() => act(r.id, 'reject')}
                    style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', fontSize: 12.5, fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  >
                    <XCircle size={14} /> Reject
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => act(r.id, 'approve')}
                    style={{ flex: 2, padding: '9px 0', borderRadius: 10, border: 'none', background: '#059669', color: '#fff', fontSize: 12.5, fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  >
                    <CheckCircle size={14} /> Approve & Activate Plan
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   3. WORKSPACES (SALONS) PANEL
───────────────────────────────────────────────────────────────────────────── */
function WorkspacesPanel() {
  const [accounts, reload, err] = useApi('/platform/accounts')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [resetLink, setResetLink] = useState('')
  const [busy, setBusy] = useState(false)

  const handleCreate = async (e) => {
    e.preventDefault()
    const form = e.target
    const body = Object.fromEntries(new FormData(form).entries())
    setBusy(true)
    try {
      const r = await api('/platform/accounts', { body })
      setResetLink(location.origin + '/#/reset?token=' + r.token)
      setShowCreate(false)
      form.reset()
      reload()
    } finally {
      setBusy(false)
    }
  }

  const markPaid = async (u) => {
    if (!confirm(`Mark ${u.name} paid? This turns off the trial lockout.`)) return
    await api(`/users/${u.id}/mark-paid`, { body: {} })
    reload()
  }

  const setModule = async (u, modId, on) => {
    const other = parseModules(u.modules).filter(x => x !== modId && x !== 'property')
    await api(`/platform/accounts/${u.id}/modules`, { body: { modules: on ? [...other, modId] : other } })
    reload()
  }

  const deleteAcct = async (u) => {
    if (!confirm(`PERMANENTLY DELETE workspace "${u.name}" and all its team members? This cannot be undone.`)) return
    await api(`/platform/accounts/${u.id}`, { method: 'DELETE' })
    reload()
  }

  const list = (accounts || []).filter(a => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (a.name || '').toLowerCase().includes(q) || (a.email || '').toLowerCase().includes(q)
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {resetLink && (
        <div style={{ background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#059669' }}>Workspace created! Setup link:</div>
            <input readOnly value={resetLink} style={{ width: '100%', marginTop: 4, padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid #a7f3d0' }} onFocus={e => e.target.select()} />
          </div>
          <button type="button" onClick={() => { navigator.clipboard.writeText(resetLink); alert('Copied!') }} style={{ padding: '8px 14px', borderRadius: 8, background: '#059669', color: '#fff', border: 'none', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>Copy</button>
          <button type="button" onClick={() => setResetLink('')} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer' }}><X size={16} /></button>
        </div>
      )}

      {/* Action Row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search workspaces by name or email…"
          style={{ padding: '9px 14px', borderRadius: 10, border: '1px solid #e4e4ee', fontSize: 13, outline: 'none', width: 320 }}
        />
        <button
          type="button"
          onClick={() => setShowCreate(s => !s)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 10, border: 'none', background: '#7C3AED', color: '#fff', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}
        >
          <Store size={15} /> Create Workspace
        </button>
      </div>

      {/* Creation Modal / Inline Form */}
      {showCreate && (
        <form onSubmit={handleCreate} style={{ background: '#fff', borderRadius: 14, border: '1px solid #ddd6fe', padding: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 900 }}>Create New Company Workspace</h3>
            <button type="button" onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', color: '#8b8ba3', cursor: 'pointer' }}><X size={16} /></button>
          </div>
          <label style={{ fontSize: 12, fontWeight: 700 }}>
            Company / Workspace Name
            <input name="name" placeholder="e.g. Apex Real Estate" required style={{ width: '100%', marginTop: 4, padding: '8px 12px', borderRadius: 8, border: '1px solid #e4e4ee' }} />
          </label>
          <label style={{ fontSize: 12, fontWeight: 700 }}>
            Admin Email
            <input name="email" type="email" placeholder="admin@apex.com" required style={{ width: '100%', marginTop: 4, padding: '8px 12px', borderRadius: 8, border: '1px solid #e4e4ee' }} />
          </label>
          <label style={{ fontSize: 12, fontWeight: 700 }}>
            Phone (optional)
            <input name="phone" placeholder="03xx xxxxxxx" style={{ width: '100%', marginTop: 4, padding: '8px 12px', borderRadius: 8, border: '1px solid #e4e4ee' }} />
          </label>
          <label style={{ fontSize: 12, fontWeight: 700 }}>
            Initial Plan
            <select name="plan" defaultValue="solo" style={{ width: '100%', marginTop: 4, padding: '8px 12px', borderRadius: 8, border: '1px solid #e4e4ee', background: '#fff' }}>
              {PLANS.map(p => <option key={p.id} value={p.id}>{p.name} (PKR {p.monthly.toLocaleString('en-PK')}/mo)</option>)}
            </select>
          </label>
          <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
            <button disabled={busy} style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: '#7C3AED', color: '#fff', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}>
              Create Workspace &amp; Get Setup Link
            </button>
          </div>
        </form>
      )}

      {/* Workspaces Table */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #ebebf0', overflow: 'hidden', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: 900 }}>
          <thead>
            <tr style={{ background: '#fafafa', borderBottom: '1px solid #f0f0f8' }}>
              {['WORKSPACE', 'PLAN', 'STATUS', 'MODULES', 'TEAM', 'CREATED', 'ACTIONS'].map((h, i) => (
                <th key={i} style={{ padding: '12px 16px', fontSize: 11, fontWeight: 800, color: '#8b8ba3', letterSpacing: '0.05em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map(u => {
              const mods = parseModules(u.modules)
              return (
                <tr key={u.id} style={{ borderBottom: '1px solid #f4f4f8' }}>
                  <td style={{ padding: '14px 16px' }}>
                    <div style={{ fontWeight: 800, fontSize: 13.5, color: '#1a1a2e' }}>{u.name}</div>
                    <div style={{ fontSize: 11.5, color: '#9898b0', marginTop: 2 }}>{u.email} {u.phone && `· ${u.phone}`}</div>
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 800, color: '#1a1a2e' }}>{PLANS.find(p => p.id === u.plan)?.name || 'Custom'}</span>
                    <div style={{ fontSize: 10.5, color: '#9898b0' }}>PKR {(PLANS.find(p => p.id === u.plan)?.monthly || 0).toLocaleString('en-PK')}/mo</div>
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    {u.paid_at ? (
                      <span style={{ padding: '3px 8px', borderRadius: 12, background: '#ecfdf5', color: '#059669', fontSize: 11, fontWeight: 800 }}>Paid</span>
                    ) : u.trial_ends_at ? (
                      <span style={{ padding: '3px 8px', borderRadius: 12, background: u.trial_ends_at < new Date().toISOString() ? '#fef2f2' : '#fffbeb', color: u.trial_ends_at < new Date().toISOString() ? '#dc2626' : '#d97706', fontSize: 11, fontWeight: 800 }}>
                        {u.trial_ends_at < new Date().toISOString() ? 'Trial Expired' : 'Trial'}
                      </span>
                    ) : (
                      <span style={{ color: '#9898b0', fontSize: 11 }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                      <input type="checkbox" checked={mods.includes('edu')} onChange={e => setModule(u, 'edu', e.target.checked)} />
                      Edu Module
                    </label>
                  </td>
                  <td style={{ padding: '14px 16px', fontSize: 12.5, fontWeight: 700, color: '#6b6b8a' }}>
                    {(u.subs || []).length + 1} users
                  </td>
                  <td style={{ padding: '14px 16px', fontSize: 12, color: '#9898b0' }}>
                    {fmt(u.created_at).slice(0, 10)}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {!u.paid_at && (
                        <button type="button" onClick={() => markPaid(u)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#059669', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                          Mark Paid
                        </button>
                      )}
                      <button type="button" onClick={() => deleteAcct(u)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   4. PAYMENT METHODS PANEL
───────────────────────────────────────────────────────────────────────────── */
function PaymentMethodsPanel() {
  const [data, reload] = useApi('/platform/settings')
  const [modal, setModal] = useState(null)
  const [busy, setBusy] = useState(false)

  const methods = data?.payment_methods || []

  const save = async (m) => {
    setBusy(true)
    try {
      const exists = methods.findIndex(x => x.label === m.label)
      const next = exists >= 0 ? methods.map((x, i) => i === exists ? m : x) : [...methods, m]
      await api('/platform/settings', { method: 'PUT', body: { payment_methods: next } })
      reload()
      setModal(null)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (label) => {
    if (!confirm(`Delete bank account "${label}"?`)) return
    const next = methods.filter(m => m.label !== label)
    await api('/platform/settings', { method: 'PUT', body: { payment_methods: next } })
    reload()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: '#6b6b8a' }}>Bank accounts shown to tenants on their subscription payment screens.</div>
        <button
          type="button"
          onClick={() => setModal({ label: '', details: '' })}
          style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 10, border: 'none', background: '#7C3AED', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
        >
          <Landmark size={14} /> Add Bank Account
        </button>
      </div>

      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #ebebf0', overflow: 'hidden' }}>
        {methods.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9898b0', fontSize: 13 }}>No payment bank accounts added yet.</div>
        ) : (
          methods.map((m, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #f4f4f8' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e' }}>{m.label}</div>
                <div style={{ fontSize: 12, color: '#6b6b8a', marginTop: 4, whiteSpace: 'pre-wrap' }}>{m.details}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setModal(m)} style={{ background: 'none', border: 'none', color: '#7C3AED', cursor: 'pointer' }}><Pencil size={15} /></button>
                <button type="button" onClick={() => remove(m.label)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer' }}><Trash2 size={15} /></button>
              </div>
            </div>
          ))
        )}
      </div>

      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <form
            onSubmit={e => {
              e.preventDefault()
              const fd = new FormData(e.target)
              save({ label: fd.get('label'), details: fd.get('details') })
            }}
            style={{ background: '#fff', borderRadius: 16, width: 440, maxWidth: '100%', padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Payment Method</h3>
              <button type="button" onClick={() => setModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={16} /></button>
            </div>
            <label style={{ fontSize: 12, fontWeight: 700 }}>
              Label (e.g. Bank Alfalah / Meezan)
              <input name="label" defaultValue={modal.label} required style={{ width: '100%', marginTop: 4, padding: '9px 12px', borderRadius: 8, border: '1px solid #e4e4ee' }} />
            </label>
            <label style={{ fontSize: 12, fontWeight: 700 }}>
              Account Title, Number &amp; IBAN
              <textarea name="details" defaultValue={modal.details} rows={4} required style={{ width: '100%', marginTop: 4, padding: '9px 12px', borderRadius: 8, border: '1px solid #e4e4ee', resize: 'vertical' }} />
            </label>
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button type="button" onClick={() => setModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid #e4e4ee', background: '#fff', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
              <button disabled={busy} style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: '#7C3AED', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Save</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   5. INVOICE DETAILS PANEL
───────────────────────────────────────────────────────────────────────────── */
function InvoiceDetailsPanel() {
  const [data, reload] = useApi('/platform/settings')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const inv = data?.invoice_details || {}

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    try {
      const fd = new FormData(e.target)
      await api('/platform/settings', {
        method: 'PUT',
        body: { invoice_details: Object.fromEntries(fd.entries()) }
      })
      reload()
      setMsg('Invoice details saved successfully!')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
      <form onSubmit={save} style={{ background: '#fff', borderRadius: 14, border: '1px solid #ebebf0', padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Billed From Details</h3>
        <p style={{ margin: 0, fontSize: 12, color: '#8b8ba3' }}>Shown at the top and in the header of invoices generated for clients.</p>
        {msg && <div style={{ fontSize: 12.5, fontWeight: 700, color: '#059669' }}>{msg}</div>}

        <label style={{ fontSize: 12, fontWeight: 700 }}>
          Business Name
          <input name="business_name" defaultValue={inv.business_name} placeholder="Estate Centric" style={{ width: '100%', marginTop: 4, padding: '9px 12px', borderRadius: 8, border: '1px solid #e4e4ee' }} />
        </label>
        <label style={{ fontSize: 12, fontWeight: 700 }}>
          Address
          <input name="address" defaultValue={inv.address} placeholder="Lahore, Pakistan" style={{ width: '100%', marginTop: 4, padding: '9px 12px', borderRadius: 8, border: '1px solid #e4e4ee' }} />
        </label>
        <label style={{ fontSize: 12, fontWeight: 700 }}>
          Phone
          <input name="phone" defaultValue={inv.phone} placeholder="+92 300 1234567" style={{ width: '100%', marginTop: 4, padding: '9px 12px', borderRadius: 8, border: '1px solid #e4e4ee' }} />
        </label>
        <label style={{ fontSize: 12, fontWeight: 700 }}>
          Invoice Footer Note
          <input name="footer" defaultValue={inv.footer} placeholder="Thank you for choosing Estate Centric" style={{ width: '100%', marginTop: 4, padding: '9px 12px', borderRadius: 8, border: '1px solid #e4e4ee' }} />
        </label>

        <button disabled={busy} style={{ alignSelf: 'flex-start', marginTop: 8, padding: '10px 20px', borderRadius: 10, border: 'none', background: '#7C3AED', color: '#fff', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}>
          Save Invoice Details
        </button>
      </form>

      {/* Preview Card */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #ebebf0', padding: 22 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 800 }}>Invoice Header Preview</h3>
        <div style={{ padding: 20, borderRadius: 12, background: '#fafafa', border: '1px dashed #d6d6e6' }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: '#1a1a2e' }}>{inv.business_name || 'Estate Centric'}</div>
          <div style={{ fontSize: 12, color: '#6b6b8a', marginTop: 4 }}>{inv.address || 'Address'}</div>
          <div style={{ fontSize: 12, color: '#6b6b8a' }}>{inv.phone || 'Phone'}</div>
          <div style={{ marginTop: 24, fontSize: 11, color: '#9898b0', borderTop: '1px solid #e8e8f2', paddingTop: 8 }}>
            Footer: {inv.footer || 'Thank you for your business'}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   6. ALL USERS PANEL
───────────────────────────────────────────────────────────────────────────── */
function AllUsersPanel() {
  const [users, reload] = useApi('/users')
  const [search, setSearch] = useState('')
  const [resetModal, setResetModal] = useState(null)

  const resetPw = async (u) => {
    const r = await api(`/users/${u.id}/reset-password`, { body: {} })
    setResetModal({ user: u, link: location.origin + '/#/reset?token=' + r.token })
  }

  const deleteUser = async (u) => {
    if (!confirm(`Delete user "${u.name}"?`)) return
    await api(`/users/${u.id}`, { method: 'DELETE' })
    reload()
  }

  const list = (users || []).filter(u => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (u.role || '').toLowerCase().includes(q)
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {resetModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 16, width: 440, maxWidth: '100%', padding: 24 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 850 }}>Password Reset Link</h3>
            <p style={{ margin: '0 0 12px', fontSize: 12.5, color: '#6b6b8a' }}>Share this link with {resetModal.user.name}. It works once and expires in 30 minutes.</p>
            <input readOnly value={resetModal.link} style={{ width: '100%', padding: '9px 12px', fontSize: 12, borderRadius: 8, border: '1px solid #e4e4ee', background: '#fafafa' }} onFocus={e => e.target.select()} />
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="button" onClick={() => { navigator.clipboard.writeText(resetModal.link); alert('Copied!') }} style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: '#7C3AED', color: '#fff', fontWeight: 800, cursor: 'pointer' }}>Copy Link</button>
              <button type="button" onClick={() => setResetModal(null)} style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid #e4e4ee', background: '#fff', fontWeight: 700, cursor: 'pointer' }}>Close</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by name, email, or role…"
          style={{ padding: '9px 14px', borderRadius: 10, border: '1px solid #e4e4ee', fontSize: 13, outline: 'none', width: 320 }}
        />
        <div style={{ fontSize: 12.5, color: '#8b8ba3', fontWeight: 700 }}>Total: {list.length} users</div>
      </div>

      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #ebebf0', overflow: 'hidden', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: 800 }}>
          <thead>
            <tr style={{ background: '#fafafa', borderBottom: '1px solid #f0f0f8' }}>
              {['USER', 'ROLE', 'STATUS', 'WORKSPACE OWNER', 'ACTIONS'].map((h, i) => (
                <th key={i} style={{ padding: '12px 16px', fontSize: 11, fontWeight: 800, color: '#8b8ba3', letterSpacing: '0.05em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map(u => (
              <tr key={u.id} style={{ borderBottom: '1px solid #f4f4f8' }}>
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ fontWeight: 800, fontSize: 13, color: '#1a1a2e' }}>{u.name}</div>
                  <div style={{ fontSize: 11, color: '#9898b0' }}>{u.email} {u.phone && `· ${u.phone}`}</div>
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <span style={{ padding: '3px 9px', borderRadius: 16, background: '#f5f3ff', color: '#7C3AED', fontSize: 11, fontWeight: 800, textTransform: 'capitalize' }}>
                    {u.role}
                  </span>
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <span style={{ padding: '3px 8px', borderRadius: 12, background: u.active ? '#ecfdf5' : '#fef2f2', color: u.active ? '#059669' : '#dc2626', fontSize: 10.5, fontWeight: 800 }}>
                    {u.active ? 'Active' : 'Deactivated'}
                  </span>
                </td>
                <td style={{ padding: '12px 16px', fontSize: 12, color: '#6b6b8a' }}>
                  {u.owner_id ? `#${u.owner_id}` : 'Tenant Owner'}
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" onClick={() => resetPw(u)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #ddd6fe', background: '#f5f3ff', color: '#7C3AED', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                      Reset link
                    </button>
                    {u.role !== 'platform' && (
                      <button type="button" onClick={() => deleteUser(u)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────────
   7. BACKUPS PANEL
───────────────────────────────────────────────────────────────────────────── */
function BackupsPanel() {
  const downloadBackup = () => {
    window.open('/api/platform/backup', '_blank')
  }

  return (
    <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #ebebf0', padding: 24, maxWidth: 600 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ width: 42, height: 42, borderRadius: 10, background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0369a1' }}>
          <Archive size={20} />
        </div>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Database Backup</h3>
          <div style={{ fontSize: 12, color: '#8b8ba3', marginTop: 2 }}>Export a consistent point-in-time snapshot of the database.</div>
        </div>
      </div>
      <p style={{ fontSize: 13, color: '#4b5563', lineHeight: 1.6 }}>
        Download a complete SQLite database dump containing all accounts, leads, students, payments, and system configurations.
      </p>
      <button
        type="button"
        onClick={downloadBackup}
        style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 10, border: 'none', background: '#7C3AED', color: '#fff', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}
      >
        <Archive size={15} /> Download Database Backup (.db)
      </button>
    </div>
  )
}
