// Plans are sold per company per month in PKR; annual billing is 20% off (a sales decision, not modelled here).
// users/branches are the caps the CRM enforces. null = unlimited.
export const PLANS = [
  { id: 'solo', name: 'Solo', tagline: 'One-person desk', monthly: 1999, users: 1, branches: 1 },
  { id: 'starter', name: 'Starter', tagline: 'Small sales floor', monthly: 6499, users: 5, branches: 1 },
  { id: 'growth', name: 'Growth', tagline: 'Growing team', monthly: 12499, users: 15, branches: 3, popular: true },
  { id: 'agency', name: 'Agency', tagline: 'Multi-branch agency', monthly: 19999, users: null, branches: null },
]

export const planOf = id => PLANS.find(p => p.id === id) || null
export const planName = id => planOf(id)?.name || 'Free trial'
export const SUPPORT_WHATSAPP = '923058562523'
