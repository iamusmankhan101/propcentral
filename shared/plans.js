// Plans are sold per company per month in PKR; annual billing is 20% off (a sales decision, not modelled here).
// Every limit below is a hard ceiling the CRM enforces, counted across the whole company. null = unlimited.
export const PLANS = [
  { id: 'solo', name: 'Solo', tagline: 'One-person desk', monthly: 1999, users: 1, branches: 1, projects: 3, units: 300, leads: 1000 },
  { id: 'starter', name: 'Starter', tagline: 'Small sales floor', monthly: 6499, users: 5, branches: 1, projects: 10, units: 1500, leads: 5000 },
  { id: 'growth', name: 'Growth', tagline: 'Growing team', monthly: 12499, users: 15, branches: 3, projects: 30, units: 5000, leads: 25000, popular: true },
  { id: 'agency', name: 'Agency', tagline: 'Multi-branch agency', monthly: 19999, users: null, branches: null, projects: null, units: null, leads: null },
  // The Special Needs Therapy product has its own flat price. Property and student sign-ups cannot pick it, and therapy sign-ups cannot pick the others.
  { id: 'therapy', name: 'Special Needs Therapy', tagline: 'For therapy and special education centres', monthly: 8500, module: 'therapy', users: null, branches: null, projects: null, units: null, leads: null,
    features: ['Unlimited children and staff', 'AI assessments, goals, lessons and 3-month reviews', 'Parent portal and PDF reports', 'Knowledge base and skills library'] },
]
// the plans a company can sign up for, given the product it picked
export const plansFor = moduleId => PLANS.filter(p => (moduleId === 'therapy' ? p.module === 'therapy' : !p.module))

export const planOf = id => PLANS.find(p => p.id === id) || null
export const planName = id => planOf(id)?.name || 'Free trial'
export const SUPPORT_WHATSAPP = '923058562523'

// Limits the CRM counts and enforces, in the order the plan cards show them
export const PLAN_LIMITS = ['users', 'branches', 'projects', 'units', 'leads']
export const LIMIT_WORDS = { users: ['user', 'users'], branches: ['branch', 'branches'], projects: ['project', 'projects'], units: ['unit', 'units'], leads: ['lead', 'leads'] }

export const limitLabel = (plan, what) => {
  const n = plan[what], [sg, pl] = LIMIT_WORDS[what]
  if (n == null) return `unlimited ${pl}`
  return `${n.toLocaleString('en-PK')} ${n === 1 ? sg : pl}`
}
// "1 user · 1 branch · 3 projects · 300 units · 1,000 leads", used by the sign-up cards and Users
export const limitLine = plan => PLAN_LIMITS.map(w => limitLabel(plan, w)).join(' · ')

// Product modules. `property` is the base CRM and every company keeps it; the platform owner switches the
// others on per company. Edu is sold inside every plan, so it costs nothing — it is gated to keep the
// navigation honest, not to upsell. `perm` is the role permission that decides which staff inside the
// company actually see it once the company has it.
export const MODULES = [
  { id: 'property', name: 'Property CRM', blurb: 'Leads, projects, inventory, allotments and collections.' },
  { id: 'edu', name: 'Student Consultancy', blurb: 'Student leads, universities and courses, applications, documents, visas and appointments.', perm: 'edu' },
  { id: 'hr', name: 'HR & Payroll', blurb: 'Employees, attendance, leave, payroll and payslips.', perm: 'hr', addon: true }, // add-on: switched on by the platform owner, not offered at sign-up
  { id: 'accounting', name: 'Accounting', blurb: 'Cash and bank accounts, ledger, vendor bills, payables and profit & loss.', perm: 'accounting', addon: true },
  { id: 'therapy', name: 'Special Needs Therapy', blurb: 'Children, 3-month goals, AI next-step plans and what to try when a child is stuck.', perm: 'therapy' },
]

export const moduleOf = id => MODULES.find(m => m.id === id) || null
// users.modules is a JSON array; a hand-edited or legacy value must not take a request or the UI down
export const parseModules = raw => {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
