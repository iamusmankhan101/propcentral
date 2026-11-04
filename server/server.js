import express from 'express'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as L from './lib.js'
import { newSecret, checkTotp } from './totp.js'
import { PLANS, MODULES, parseModules, planOf, planName, limitLabel, SUPPORT_WHATSAPP } from '../shared/plans.js'

// ---- email sending (Resend REST API) ----
const sendEmail = async (to, subject, html) => {
  const recipients = Array.isArray(to) ? to : [to]
  const apiKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev'
  if (!apiKey) {
    console.warn(`[sendEmail] RESEND_API_KEY missing! Cannot deliver email to: ${recipients.join(', ')}`)
    return { ok: false, error: 'RESEND_API_KEY missing' }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromEmail, to: recipients, subject, html })
    })
    const bodyText = await res.text()
    if (!res.ok) {
      console.error('[Resend API Error]', res.status, bodyText)
      return { ok: false, status: res.status, error: bodyText }
    }
    console.log('[Resend API Success]', bodyText)
    return { ok: true, data: bodyText }
  } catch (err) {
    console.error('[Resend Network Error]', err.message)
    return { ok: false, error: err.message }
  }
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const clean = v => v?.trim().replace(/^(['"])(.*)\1$/, '$2') || undefined
const dbUrl = clean(process.env.CRM_DATABASE_URL) || clean(process.env.TURSO_DATABASE_URL) || clean(process.env.DB_PATH) || path.join(root, 'crm.db')
const dbToken = clean(process.env.CRM_DATABASE_TOKEN) || clean(process.env.TURSO_AUTH_TOKEN)
const remote = /^(libsql|https?):/i.test(dbUrl)
// /api/health may report where a remote database lives, but only the hostname: never the token or path
const dbHost = remote ? (() => { try { return new URL(dbUrl.replace(/^libsql:/, 'https:')).hostname || null } catch { return null } })() : null
const SCHEMA_VERSION = '14'
// Every plan starts with a free trial. TRIAL_DAYS=0 is how the tests (and a demo) force the lock immediately.
const TRIAL_DAYS = Number.isFinite(+process.env.TRIAL_DAYS) && process.env.TRIAL_DAYS !== '' ? +process.env.TRIAL_DAYS : 7
const trialEndsAt = () => new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString()

// A failed database init must not take the whole function down: /api/health reports the cause
// and every other route answers 503 instead of a boot crash nobody can read.
let db = null
let dbError = null
try {
  const { default: Database } = await import('libsql')
  db = new Database(dbUrl, dbToken ? { authToken: dbToken } : undefined)
  if (!remote) db.pragma('journal_mode = WAL')
  const tablesReady = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'`).get()
  if (!tablesReady) db.exec(`
CREATE TABLE IF NOT EXISTS branches(id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT);
CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY, name TEXT NOT NULL, branch_id INTEGER REFERENCES branches(id));
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT, pass TEXT NOT NULL,
  role TEXT NOT NULL, team_id INTEGER, branch_id INTEGER, active INTEGER DEFAULT 1, available INTEGER DEFAULT 1, max_open INTEGER DEFAULT 300, last_assigned_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
CREATE TABLE IF NOT EXISTS contacts(id INTEGER PRIMARY KEY, name TEXT, phone TEXT UNIQUE NOT NULL, alt_phones TEXT, email TEXT, cnic TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS contacts_email ON contacts(email);
CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id), ext_id TEXT UNIQUE,
  source TEXT NOT NULL, campaign TEXT, adset TEXT, ad TEXT, form_id TEXT, referrer TEXT, city TEXT, lead_type TEXT DEFAULT 'buyer', interest TEXT,
  property_type TEXT, budget_min INTEGER, budget_max INTEGER, locations TEXT, payment_pref TEXT, project TEXT, remarks TEXT, tags TEXT, custom TEXT,
  status TEXT NOT NULL DEFAULT 'New', pending_status TEXT, pending_reason TEXT, pending_by INTEGER, lost_reason TEXT, lost_at TEXT,
  agent_id INTEGER REFERENCES users(id), branch_id INTEGER, score INTEGER DEFAULT 0, sla_level INTEGER DEFAULT 0, stale_flag INTEGER DEFAULT 0,
  assigned_at TEXT, first_contact_at TEXT, last_activity_at TEXT, next_action_at TEXT, created_at TEXT NOT NULL, deleted INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS leads_agent ON leads(agent_id, status);
CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, user_id INTEGER, type TEXT NOT NULL, outcome TEXT, notes TEXT,
  next_action TEXT, next_action_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS activities_lead ON activities(lead_id);
CREATE TABLE IF NOT EXISTS visits(id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, agent_id INTEGER, site TEXT, scheduled_at TEXT, transport INTEGER DEFAULT 0,
  status TEXT DEFAULT 'scheduled', otp TEXT, otp_attempts INTEGER DEFAULT 0, distance_m INTEGER, checked_in_at TEXT, verified_at TEXT, feedback TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS sla_breaches(id INTEGER PRIMARY KEY, lead_id INTEGER, user_id INTEGER, level INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, lead_id INTEGER, read INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, entity TEXT, entity_id INTEGER, data TEXT, ip TEXT, created_at TEXT);
CREATE TRIGGER IF NOT EXISTS audit_immutable_u BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_immutable_d BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, city TEXT, kind TEXT NOT NULL DEFAULT 'land',
  marla_sqft REAL NOT NULL DEFAULT 225, premiums TEXT NOT NULL DEFAULT '[]', hold_hours INTEGER NOT NULL DEFAULT 24, notes TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS units(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  phase TEXT NOT NULL DEFAULT '', block TEXT NOT NULL DEFAULT '', street TEXT NOT NULL DEFAULT '', unit_no TEXT NOT NULL,
  unit_type TEXT NOT NULL DEFAULT 'Plot', category TEXT NOT NULL DEFAULT 'residential', size REAL, uom TEXT NOT NULL DEFAULT 'marla',
  dimensions TEXT, facing TEXT, features TEXT, premiums TEXT NOT NULL DEFAULT '[]', price_override INTEGER,
  status TEXT NOT NULL DEFAULT 'Available', hold_by INTEGER, hold_until TEXT, lead_id INTEGER, updated_at TEXT,
  UNIQUE(project_id, phase, block, street, unit_no));
CREATE INDEX IF NOT EXISTS units_project ON units(project_id, status);
CREATE TABLE IF NOT EXISTS price_lists(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, unit_type TEXT NOT NULL, rate INTEGER NOT NULL,
  per TEXT NOT NULL, effective_from TEXT NOT NULL, note TEXT, created_by INTEGER, created_at TEXT, size REAL, uom TEXT);
CREATE TABLE IF NOT EXISTS allotments(id INTEGER PRIMARY KEY, allotment_no TEXT UNIQUE, unit_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', sale_status TEXT NOT NULL, list_price INTEGER, price INTEGER NOT NULL,
  sale_date TEXT NOT NULL, note TEXT, created_by INTEGER, created_at TEXT, cancelled_at TEXT, cancel_note TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS allotments_one_active ON allotments(unit_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS unit_history(id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL, user_id INTEGER, from_status TEXT, to_status TEXT,
  lead_id INTEGER, note TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS installments(id INTEGER PRIMARY KEY, allotment_id INTEGER NOT NULL, label TEXT NOT NULL, due_date TEXT NOT NULL, amount INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS installments_allot ON installments(allotment_id, due_date);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, receipt_no TEXT UNIQUE, allotment_id INTEGER NOT NULL, lead_id INTEGER NOT NULL,
  kind TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT, ref TEXT, paid_on TEXT NOT NULL, note TEXT, created_by INTEGER, created_at TEXT,
  voided_at TEXT, void_note TEXT);
CREATE INDEX IF NOT EXISTS payments_allot ON payments(allotment_id);
CREATE TABLE IF NOT EXISTS dealers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, company TEXT, phone TEXT, rate REAL, active INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS commissions(id INTEGER PRIMARY KEY, allotment_id INTEGER NOT NULL, user_id INTEGER, dealer_id INTEGER, rate REAL NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', paid_on TEXT, ref TEXT, paid_by INTEGER, created_at TEXT);
CREATE INDEX IF NOT EXISTS commissions_allot ON commissions(allotment_id);
CREATE TABLE IF NOT EXISTS targets(user_id INTEGER NOT NULL, month TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(user_id, month));
CREATE TABLE IF NOT EXISTS export_requests(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, query TEXT NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', decided_by INTEGER, decided_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS allotment_docs(allotment_id INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT, PRIMARY KEY(allotment_id, kind));
CREATE TABLE IF NOT EXISTS listings(id INTEGER PRIMARY KEY, purpose TEXT NOT NULL, property_type TEXT NOT NULL, title TEXT, city TEXT, area TEXT, address TEXT,
  size REAL, uom TEXT, price INTEGER NOT NULL, bedrooms INTEGER, features TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'Available',
  owner_lead_id INTEGER, agent_id INTEGER, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, kind TEXT NOT NULL,
  name TEXT, mime TEXT, data BLOB, url TEXT, size INTEGER, created_by INTEGER, created_at TEXT);
CREATE INDEX IF NOT EXISTS media_entity ON media(entity, entity_id);
CREATE TABLE IF NOT EXISTS properties(id INTEGER PRIMARY KEY, title TEXT, kind TEXT NOT NULL DEFAULT 'House', society TEXT, phase TEXT, block TEXT, street TEXT,
  number TEXT, address TEXT, city TEXT DEFAULT 'Lahore', size REAL, uom TEXT, bedrooms INTEGER, owner_contact_id INTEGER, agent_id INTEGER,
  managed INTEGER DEFAULT 0, mgmt_fee_pct REAL, lat REAL, lng REAL, outline TEXT, notes TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS areas(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, outline TEXT NOT NULL, created_by INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS overlays(id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, area_id INTEGER, mime TEXT NOT NULL, data BLOB NOT NULL,
  width INTEGER, height INTEGER, corners TEXT NOT NULL, opacity REAL DEFAULT 0.7, visible INTEGER DEFAULT 1, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS leases(id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, tenant_contact_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  rent INTEGER NOT NULL, deposit INTEGER, increase_pct REAL DEFAULT 0, police_reg_no TEXT, agreement_no TEXT, status TEXT NOT NULL DEFAULT 'active',
  ended_on TEXT, end_note TEXT, alert_level INTEGER DEFAULT 0, notes TEXT, created_by INTEGER, created_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active ON leases(property_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS rent_payments(id INTEGER PRIMARY KEY, receipt_no TEXT UNIQUE, lease_id INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
  paid_on TEXT NOT NULL, method TEXT, ref TEXT, note TEXT, created_by INTEGER, created_at TEXT, voided_at TEXT, void_note TEXT);
CREATE TABLE IF NOT EXISTS maintenance(id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, title TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'Open',
  cost INTEGER, charge_to TEXT DEFAULT 'Owner', vendor TEXT, created_by INTEGER, created_at TEXT, done_at TEXT);
CREATE TABLE IF NOT EXISTS owner_payouts(id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, amount INTEGER NOT NULL, paid_on TEXT NOT NULL, method TEXT, ref TEXT, note TEXT,
  created_by INTEGER, created_at TEXT, voided_at TEXT);
CREATE TABLE IF NOT EXISTS unit_photos(id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL, data TEXT NOT NULL, created_by INTEGER, created_at TEXT);
`)

  // Auth throttle counters must exist on databases created before this table was added
  db.exec('CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT)')

  db.exec(`CREATE TABLE IF NOT EXISTS payment_requests(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, plan TEXT, amount INTEGER, method TEXT, reference TEXT, note TEXT,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, decided_at TEXT)`)

  // Student Consultancy. A student is the contact behind a lead, promoted: the same person, now on an
  // admission journey instead of a property one. lead_id keeps the link back to the original capture.
  db.exec(`CREATE TABLE IF NOT EXISTS edu_students(id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id),
    lead_id INTEGER, branch_id INTEGER, counselor_id INTEGER REFERENCES users(id),
    stage TEXT NOT NULL DEFAULT 'New Inquiry', stage_at TEXT,
    gender TEXT, dob TEXT, city TEXT, passport TEXT, passport_expiry TEXT,
    current_level TEXT, institution TEXT, graduate_year INTEGER, gpa REAL, major TEXT,
    ielts REAL, toefl INTEGER, gre INTEGER, gmat INTEGER, target_level TEXT, target_countries TEXT, intake TEXT,
    sponsor_name TEXT, sponsor_occupation TEXT, remarks TEXT, tags TEXT,
    created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT)`)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS edu_students_contact ON edu_students(contact_id)')
  db.exec('CREATE INDEX IF NOT EXISTS edu_students_stage ON edu_students(stage, counselor_id)')
  // documents are the paper an admission actually needs, so they carry their own verification flag.
  // Passports and CNICs, so no public token URL like media has — the browser fetches the file with the session header.
  db.exec(`CREATE TABLE IF NOT EXISTS edu_documents(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES edu_students(id),
    type TEXT NOT NULL, name TEXT, mime TEXT, data TEXT, verified INTEGER DEFAULT 0, notes TEXT,
    uploaded_by INTEGER, created_at TEXT NOT NULL)`)
  db.exec('CREATE INDEX IF NOT EXISTS edu_documents_student ON edu_documents(student_id, type)')
  db.exec(`CREATE TABLE IF NOT EXISTS edu_activities(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES edu_students(id),
    user_id INTEGER, type TEXT NOT NULL, outcome TEXT, notes TEXT, next_action TEXT, next_action_at TEXT, created_at TEXT NOT NULL)`)
  db.exec('CREATE INDEX IF NOT EXISTS edu_activities_student ON edu_activities(student_id)')

  // The catalog a counsellor sells from, shared by the whole company, and the applications that hang off it.
  // One student applies to several universities, so an application is its own record keyed on student + course.
  db.exec(`CREATE TABLE IF NOT EXISTS edu_universities(id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL, city TEXT,
    website TEXT, ranking TEXT, note TEXT, active INTEGER NOT NULL DEFAULT 1, created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT)`)
  db.exec('CREATE INDEX IF NOT EXISTS edu_universities_country ON edu_universities(country, active)')
  db.exec(`CREATE TABLE IF NOT EXISTS edu_campuses(id INTEGER PRIMARY KEY, university_id INTEGER NOT NULL REFERENCES edu_universities(id),
    name TEXT NOT NULL, city TEXT, note TEXT, created_at TEXT NOT NULL)`)
  db.exec('CREATE INDEX IF NOT EXISTS edu_campuses_university ON edu_campuses(university_id)')
  db.exec(`CREATE TABLE IF NOT EXISTS edu_programs(id INTEGER PRIMARY KEY, university_id INTEGER NOT NULL REFERENCES edu_universities(id),
    campus_id INTEGER REFERENCES edu_campuses(id), name TEXT NOT NULL, level TEXT, field TEXT, tuition INTEGER, currency TEXT DEFAULT 'GBP',
    duration_months INTEGER, intakes TEXT, eligibility TEXT, requirements TEXT, ielts_min REAL, active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT)`)
  db.exec('CREATE INDEX IF NOT EXISTS edu_programs_university ON edu_programs(university_id, active)')
  db.exec(`CREATE TABLE IF NOT EXISTS edu_applications(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES edu_students(id),
    program_id INTEGER NOT NULL REFERENCES edu_programs(id), status TEXT NOT NULL DEFAULT 'Ready', ref TEXT, note TEXT,
    submitted_at TEXT, decision_at TEXT, offer_type TEXT, created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT)`)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS edu_applications_pair ON edu_applications(student_id, program_id)')
  db.exec('CREATE INDEX IF NOT EXISTS edu_applications_status ON edu_applications(status)')

  // columns added after first release: run the migration once per schema version, not on every cold start
  const schemaVersion = tablesReady && db.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get()?.value
  if (schemaVersion !== SCHEMA_VERSION) {
    // SQLite matches column names case-insensitively, so the guard must too: a column stored as PLAN
    // would otherwise be "missing" here and the ALTER would abort the whole init (every route 503s).
    const addColumn = (table, col, type) => {
      if (db.prepare(`PRAGMA table_info(${table})`).all().some(c => String(c.name).toLowerCase() === col)) return
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`) }
      catch (e) { if (!/duplicate column name/i.test(e.message)) throw e }
    }
    addColumn('price_lists', 'size', 'REAL')
    addColumn('price_lists', 'uom', 'TEXT')
    addColumn('units', 'down_payment', 'INTEGER')
    addColumn('units', 'map_ref', 'TEXT') // id of the plot's path in the project map SVG
    addColumn('projects', 'map_svg', 'TEXT')
    addColumn('projects', 'share_token', 'TEXT') // client map link: /#/map/<token>
    addColumn('activities', 'amount', 'INTEGER') // offer amount
    addColumn('leads', 'dealer_id', 'INTEGER') // external dealer who brought the client
    addColumn('allotments', 'agent_id', 'INTEGER') // who gets credit for the sale (lead owner at the time)
    addColumn('allotments', 'dealer_id', 'INTEGER')
    addColumn('allotments', 'form', 'TEXT') // booking application form: father name, address, nominee…
    addColumn('commissions', 'note', 'TEXT') // reason for a manual adjustment or cancellation
    addColumn('users', 'totp_secret', 'TEXT')
    addColumn('users', 'commission_rate', 'REAL')
    addColumn('overlays', 'clear_white', 'INTEGER DEFAULT 1') // show the plan's white background as see-through // agent's own commission %, empty = the default in settings
    addColumn('users', 'totp_on', 'INTEGER DEFAULT 0')
    addColumn('leads', 'campaign_id', 'TEXT') // Meta campaign id, so leads match campaigns even if renamed
    addColumn('contacts', 'portal_token', 'TEXT') // customer portal link: /#/portal/<token>
    addColumn('users', 'plan', 'TEXT') // sold plan id from shared/plans.js; NULL = account predating plans, never capped
    addColumn('users', 'trial_ends_at', 'TEXT')
    addColumn('users', 'owner_id', 'INTEGER') // NULL = main account (a sign-up); else the main account this user was added under
    addColumn('users', 'paid_at', 'TEXT') // an admin marked the plan paid; the trial lock stops applying
    addColumn('users', 'modules', 'TEXT') // JSON array of product modules this company can use; NULL = property only
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS units_map_ref ON units(project_id, map_ref) WHERE map_ref IS NOT NULL')
    // Visa tracking fields on edu_students
    addColumn('edu_students', 'visa_type', 'TEXT')
    addColumn('edu_students', 'visa_app_number', 'TEXT')
    addColumn('edu_students', 'cas_coe_number', 'TEXT')
    addColumn('edu_students', 'embassy_date', 'TEXT')
    addColumn('edu_students', 'biometrics_date', 'TEXT')
    addColumn('edu_students', 'visa_decision_date', 'TEXT')
    addColumn('edu_students', 'visa_outcome', 'TEXT')
    addColumn('edu_students', 'visa_expiry', 'TEXT')
    // Student payment tracking
    db.exec(`CREATE TABLE IF NOT EXISTS edu_payments(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES edu_students(id),
      type TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT DEFAULT 'PKR', method TEXT, reference TEXT, note TEXT,
      paid_at TEXT, created_by INTEGER, created_at TEXT NOT NULL)`)
    db.exec('CREATE INDEX IF NOT EXISTS edu_payments_student ON edu_payments(student_id)')
    // Edu commissions tracking
    db.exec(`CREATE TABLE IF NOT EXISTS edu_commissions(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES edu_students(id),
      application_id INTEGER REFERENCES edu_applications(id), user_id INTEGER REFERENCES users(id),
      type TEXT NOT NULL DEFAULT 'counselor', amount INTEGER NOT NULL, currency TEXT DEFAULT 'PKR',
      status TEXT NOT NULL DEFAULT 'pending', paid_on TEXT, ref TEXT, note TEXT, created_by INTEGER, created_at TEXT NOT NULL)`)
    db.exec('CREATE INDEX IF NOT EXISTS edu_commissions_student ON edu_commissions(student_id)')
    // Email verification
    db.exec(`CREATE TABLE IF NOT EXISTS email_verifications(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL)`)
    db.exec('CREATE INDEX IF NOT EXISTS email_verifications_user ON email_verifications(user_id)')
    addColumn('users', 'email_verified', 'INTEGER DEFAULT 0')
    addColumn('users', 'created_at', 'TEXT') // when the account was created; NULL for accounts that predate the column
    addColumn('users', 'two_factor_method', "TEXT DEFAULT 'email'") // 'email' | 'totp' | null
    // 2FA login email verification codes
    db.exec(`CREATE TABLE IF NOT EXISTS login_email_codes(
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL)`)
    db.exec('CREATE INDEX IF NOT EXISTS login_email_codes_user ON login_email_codes(user_id)')
    db.prepare(`INSERT INTO settings(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(SCHEMA_VERSION)
  }
} catch (e) {
  console.error('Database init failed:', e)
  db = null
  dbError = e
}

// ---------- settings (M22: everything configurable from admin) ----------
const MGMT = ['team_lead', 'branch_manager', 'sales_head', 'admin']
const DEFAULTS = {
  statuses: ['New', 'Contacted', 'Not Reachable', 'Qualified', 'Visit Scheduled', 'Visit Done', 'Negotiation', 'Booked', 'Lost', 'Junk'],
  closed_statuses: ['Booked', 'Lost', 'Junk'],
  approval_statuses: ['Lost', 'Junk'],
  lost_reasons: ['Budget mismatch', 'Bought elsewhere', 'Not interested', 'Location mismatch', 'Wrong number', 'Not reachable after 5 attempts'],
  sources: ['Facebook', 'Instagram', 'Website', 'WhatsApp', 'Zameen', 'Graana', 'OLX', 'Google Ads', 'Walk-in', 'Referral', 'Inbound call', 'Other'],
  activity_types: ['call', 'whatsapp', 'sms', 'email', 'meeting', 'office_visit', 'note', 'task'],
  outcomes: ['Connected', 'Not answered', 'Busy', 'Switched off', 'Interested', 'Not interested', 'Call back later'],
  lead_types: ['buyer', 'seller', 'tenant', 'landlord', 'investor'],
  property_types: ['Plot', 'House', 'Apartment', 'Shop', 'Office', 'File'],
  unit_statuses: ['Available', 'On Hold', 'Token Received', 'Booked', 'Sold', 'Blocked', 'Cancelled'],
  max_holds_per_agent: 3,
  commission: { agent_pct: 1, dealer_pct: 2 },
  weekly_report: { recipients: [], weekday: 1, hour: 9 },
  listing_statuses: ['Available', 'Under offer', 'Sold', 'Rented', 'Withdrawn'],
  lease_amber_days: 90,
  lease_red_days: 30,
  societies: ['DHA', 'Bahria Town', 'Gulberg', 'Johar Town', 'Model Town', 'Lake City', 'Wapda Town', 'Valencia', 'Askari', 'Cantt'],
  custom_fields: [],
  sla_minutes: { default: 30, Facebook: 30, Instagram: 30, Website: 30 },
  working_hours: { default: { start: 9, end: 19, days: [1, 2, 3, 4, 5, 6], tz: 5 } },
  stale_days: 3,
  recycle_cooldown_days: 30,
  scoring: { budget: 10, connected_call: 5, visit_done: 30, qualified: 20 },
  sites: [{ name: 'Head Office', lat: 31.5204, lng: 74.3587, radius_m: 300 }],
  visit_feedback_hours: 24,
  assignment_rules: [{ name: 'Default round robin', priority: 100, when: {}, method: 'round_robin', team_id: null }],
  permissions: {
    reassign: MGMT, approve_lost: MGMT, export: ['sales_head', 'admin'], import: ['marketing', 'sales_head', 'admin'],
    view_phone: ['agent', ...MGMT, 'owner', 'accounts'], settings: ['sales_head', 'admin'], manage_users: ['platform', 'admin'],
    audit: ['admin', 'owner'], delete: ['admin'],
    manage_inventory: ['inventory', 'sales_head', 'admin'], edit_pricing: ['sales_head', 'admin'],
    unit_status: ['inventory', 'accounts', 'sales_head', 'admin'],
    payments: ['accounts', 'sales_head', 'admin'],
    request_export: ['branch_manager'],
    properties: ['inventory', 'accounts', 'sales_head', 'admin'],
    // the student consultancy module. Only meaningful for companies the platform has switched Edu on for
    edu: ['agent', ...MGMT, 'owner'],
  },
  // the admission journey, in order. `stage` on edu_students always holds one of these.
  edu_stages: ['New Inquiry', 'Initial Counseling', 'Profile Evaluation', 'Documents Collection', 'University Application', 'Offer Received', 'Fee Payment', 'Visa Processing', 'Visa Decision', 'Enrolled'],
  edu_doc_types: ['passport', 'cnic', 'transcript', 'diploma', 'ielts', 'toefl', 'gre', 'gmat', 'cv', 'sop', 'lor', 'financial', 'offer_letter', 'visa', 'other'],
  edu_levels: ['Intermediate', 'Bachelor', 'Master', 'PhD'],
  edu_intakes: ['Spring 2027', 'Fall 2027', 'Spring 2028', 'Fall 2028'],
  // where the company places students; a university's country is picked from this list
  edu_countries: ['UK', 'USA', 'Canada', 'Australia', 'Ireland', 'Germany', 'Netherlands', 'China', 'Turkey', 'UAE', 'Malaysia', 'Saudi Arabia'],
  // an application has its own lifecycle, separate from the student's stage: one student runs several at once
  edu_application_statuses: ['Ready', 'Submitted', 'Under review', 'Interview', 'Conditional offer', 'Unconditional offer', 'Accepted', 'Rejected', 'Withdrawn'],
  edu_payment_types: ['tuition_deposit', 'visa_fee', 'ielts_fee', 'service_fee', 'scholarship', 'other'],
  edu_visa_outcomes: ['Approved', 'Refused', 'Pending', 'Withdrawn'],
  edu_country_checklists: {
    UK: ['passport', 'transcript', 'ielts', 'sop', 'lor', 'financial', 'offer_letter', 'visa'],
    USA: ['passport', 'transcript', 'toefl', 'gre', 'sop', 'lor', 'financial', 'offer_letter', 'visa'],
    Canada: ['passport', 'transcript', 'ielts', 'sop', 'lor', 'financial', 'offer_letter', 'visa'],
    Australia: ['passport', 'transcript', 'ielts', 'sop', 'lor', 'financial', 'offer_letter', 'visa'],
    Germany: ['passport', 'transcript', 'ielts', 'cv', 'sop', 'financial', 'offer_letter', 'visa'],
  },
}
// Roles: 10 built in plus custom ones (Settings › Roles & permissions). access = which leads the role sees
const BUILT_IN_ROLES = [
  ['agent', 'Agent', 'own'], ['team_lead', 'Team lead', 'team'], ['branch_manager', 'Branch manager', 'branch'], ['sales_head', 'Sales head', 'all'],
  ['marketing', 'Marketing', 'all'], ['inventory', 'Inventory', 'none'], ['accounts', 'Accounts', 'none'], ['owner', 'Owner', 'all'], ['admin', 'Admin', 'all'],
  ['platform', 'Platform', 'none'],
].map(([key, label, access]) => ({ key, label, access, built_in: true }))
const ACCESS = ['own', 'team', 'branch', 'all', 'none']
const roles = () => [...BUILT_IN_ROLES, ...(S('custom_roles') || [])]
const accessOf = role => roles().find(r => r.key === role)?.access ?? 'none'
const S = key => JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? 'null') ?? DEFAULTS[key]
const can = (u, perm) => ({ ...DEFAULTS.permissions, ...S('permissions') })[perm]?.includes(u.role) // saved matrix + permissions added later
const closedJson = () => JSON.stringify(S('closed_statuses'))
const OPEN = `l.deleted=0 AND l.status NOT IN (SELECT value FROM json_each(?))`

// ---------- helpers ----------
const now = () => new Date().toISOString()
const err = (status, message, data) => Object.assign(new Error(message), { status, ...(data ? { data } : {}) })
// libsql attaches query timing metadata to rows; strip it so API responses stay clean
const stripMeta = r => { if (r) delete r._metadata; return r }
// libsql has no bool binding: a JS true/false in a parameter panics the Rust layer and kills the process
const sqlValue = v => (typeof v === 'boolean' ? (v ? 1 : 0) : v)
const params = p => p.map(sqlValue)
const one = (sql, ...p) => stripMeta(db.prepare(sql).get(...params(p)))
const all = (sql, ...p) => db.prepare(sql).all(...params(p)).map(stripMeta)
const run = (sql, ...p) => db.prepare(sql).run(...params(p))

// ---------- plans & trials ----------
function pickPlan(id) {
  const p = planOf(typeof id === 'string' ? id.trim().toLowerCase() : '')
  if (!p) throw err(400, `Choose a plan: ${PLANS.map(x => x.name).join(', ')}`)
  return p
}
// Accounts that signed up before billing exists have no plan: never locked, never capped.
// Admins are never locked out either — same reason the permission matrix keeps settings/manage_users off the table.
const trialOver = u => !u.paid_at && !!u.trial_ends_at && u.trial_ends_at < now() && u.role !== 'admin'
const trialDaysLeft = u => Math.max(0, Math.ceil((new Date(u.trial_ends_at) - Date.now()) / 864e5))
// A plan is sold per company, so every cap counts the whole database: no branch or project gets its own allowance.
const COUNT = {
  // seats count per main account's tree (it plus the users added under it)
  users: actor => { const root = actor.owner_id ?? actor.id; return one("SELECT count(*) n FROM users WHERE active=1 AND role!='platform' AND (id=? OR owner_id=?)", root, root).n },
  branches: () => one('SELECT count(*) n FROM branches').n,
  projects: () => one('SELECT count(*) n FROM projects').n,
  units: () => one('SELECT count(*) n FROM units').n,
  leads: () => one(`SELECT count(*) n FROM leads l WHERE ${OPEN}`, closedJson()).n,
}
function planCap(actor, what, add = 1) {
  const p = planOf(actor.plan)
  if (!p || p[what] == null || COUNT[what](actor) + add <= p[what]) return
  throw err(400, `Your ${p.name} plan covers ${limitLabel(p, what)}. Upgrade the plan or free one up first.`)
}
// Website forms and the Facebook webhook carry no signed-in user, so the company's plan is read off its admin account.
const systemAccount = () => one(`SELECT plan FROM users WHERE role='admin' AND active=1 AND plan IS NOT NULL
  ORDER BY (paid_at IS NOT NULL) DESC, id LIMIT 1`) || {}
// A refused capture must not be silent: the webhook still answers Meta with 200, so tell someone who can upgrade
function notifyPlanBlock(message, where) {
  for (const u of all('SELECT * FROM users WHERE active=1').filter(u => can(u, 'manage_users')))
    notify(u.id, `Plan limit hit (${where}): ${message}`, null)
}

// ---------- product modules ----------
// The platform owner switches a module on for a whole company; the setting lives on that company's main
// account so every user under it inherits it, and moving a sub-account between companies needs no copy.
// Property CRM is the base product and is always on, so a NULL column (every account predating modules)
// resolves to it alone. `edu` in the permission matrix then decides which staff inside see it.
const MODULE_IDS = MODULES.map(m => m.id)
const modulesOf = u => {
  const main = u.owner_id ? one('SELECT modules FROM users WHERE id=?', u.owner_id) : u
  const list = parseModules(main?.modules).filter(id => MODULE_IDS.includes(id))
  // If modules were explicitly set (e.g. only ['edu']), return that list. If null/empty (legacy accounts), default to property.
  return list.length ? list : ['property']
}

// ---------- auth throttling ----------
// Counters live in the DB so limits hold across serverless instances; Turso serialises the upsert.
const rateKey = (kind, value) => `${kind}:${value}`
const rateMins = resetAt => Math.max(1, Math.ceil((resetAt - Date.now()) / 60000))
const rateMsg = (prefix, resetAt) => {
  const m = rateMins(resetAt)
  return `${prefix}. Try again in ${m} minute${m === 1 ? '' : 's'}.`
}
// Fixed-window counter: the first hit starts the window, later hits add to it. The increment is one
// atomic upsert; RETURNING is avoided because remote libSQL treats writes as row-less statements.
const rateHit = (key, max, windowMs, prefix = 'Too many attempts') => {
  const t = Date.now()
  run(`INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
      reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END`, key, t + windowMs, t, t, t + windowMs)
  const row = one('SELECT count, reset_at FROM rate_limits WHERE key=?', key) || { count: 1, reset_at: t + windowMs }
  if (row.count > max) {
    const e = err(429, rateMsg(prefix, row.reset_at))
    e.retryAfter = Math.ceil((row.reset_at - Date.now()) / 1000)
    throw e
  }
  return row
}
const rateLocked = key => {
  const row = one('SELECT count, reset_at FROM rate_limits WHERE key=?', key)
  return row && row.reset_at > Date.now() ? row : null
}
const rateClear = key => run('DELETE FROM rate_limits WHERE key=?', key)

// ---------- abuse guards ----------
// Per-instance fixed windows cheaply absorb bursts before they reach the database; the DB-backed
// limits above still hold for auth when a request lands on a different serverless instance.
const windows = new Map()
const overLimit = (key, max, windowMs) => {
  const t = Date.now()
  let w = windows.get(key)
  if (!w || w.reset <= t) windows.set(key, (w = { count: 0, reset: t + windowMs }))
  w.count++
  if (windows.size > 5000) for (const [k, v] of windows) if (v.reset <= t) windows.delete(k)
  return w.count > max ? Math.ceil((w.reset - t) / 1000) : 0
}
const API_PER_MIN = +(process.env.API_RATE_LIMIT || 1200)
const PUBLIC_PER_MIN = +(process.env.PUBLIC_RATE_LIMIT || 120)
// Unauthenticated surfaces: sign-in, sign-up, share links and integration hooks
const PUBLIC_PATHS = /^\/api\/(login|register|forgot-password|reset-password|inbound|portal|public|files|overlay-images|webhooks)(\/|$)/
const CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; " +
  "script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: https://*.maptiler.com; connect-src 'self' https://*.maptiler.com; " +
  "worker-src 'self' blob:; child-src 'self' blob:; manifest-src 'self'"

// libsql has no nested transactions: the outer call uses the driver's transaction, inner calls join it
let txDepth = 0
const tx = fn => (...args) => {
  if (txDepth > 0) {
    txDepth++
    try { return fn(...args) } finally { txDepth-- }
  }
  txDepth++
  try { return db.transaction(fn)(...args) } finally { txDepth-- }
}

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex')
const checkPw = (pw, stored) => {
  const [salt, h] = stored.split(':')
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, salt, 32))
}
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
// Uploaded SVGs are served as documents, so a sandbox CSP stops a shared link from running script on our origin
const sendSvg = (res, svg) => res.type('image/svg+xml')
  .set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'").send(svg)

// ---------- password resets ----------
// Only the SHA-256 of a reset token is stored; links expire in 30 minutes, work once,
// and issuing a new one cancels the previous unused link for that account.
const RESET_TTL_MS = 30 * 60e3
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex')
const issueReset = userId => {
  run('DELETE FROM password_resets WHERE user_id=? AND used_at IS NULL', userId)
  const token = crypto.randomBytes(32).toString('hex')
  run('INSERT INTO password_resets(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', hashToken(token), userId, now(), Date.now() + RESET_TTL_MS)
  return token
}

function audit(userId, action, entity, entityId, data, ip) {
  run('INSERT INTO audit(user_id,action,entity,entity_id,data,ip,created_at) VALUES(?,?,?,?,?,?,?)',
    userId ?? null, action, entity, entityId ?? null, data ? JSON.stringify(data) : null, ip ?? null, now())
}

// ponytail: SMS/push are console stubs. Plug the local SMS gateway + FCM in here (M6.8, M8.7).
const sendSms = (phone, text) => phone && console.log(`[SMS -> ${phone}] ${text}`)

function notify(userId, text, leadId, { sms = false } = {}) {
  if (!userId) return
  run('INSERT INTO notifications(user_id,text,lead_id,created_at) VALUES(?,?,?,?)', userId, text, leadId ?? null, now())
  if (sms) sendSms(one('SELECT phone FROM users WHERE id=?', userId)?.phone, text)
}
const notifyTeamLeads = (agentId, text, leadId) =>
  all(`SELECT id FROM users WHERE role='team_lead' AND active=1 AND team_id=(SELECT team_id FROM users WHERE id=?)`, agentId)
    .forEach(u => notify(u.id, text, leadId))
const notifyRole = (roles, text, leadId) =>
  all(`SELECT id FROM users WHERE active=1 AND role IN (SELECT value FROM json_each(?))`, JSON.stringify(roles)).forEach(u => notify(u.id, text, leadId))

const CONTACT_TYPES = ['call', 'whatsapp', 'sms', 'email', 'meeting', 'site_visit', 'office_visit']
function addActivity(leadId, userId, type, notes, x = {}) {
  const t = now()
  run('INSERT INTO activities(lead_id,user_id,type,outcome,notes,next_action,next_action_at,amount,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    leadId, userId ?? null, type, x.outcome ?? null, notes ?? null, x.next_action ?? null, x.next_action_at ?? null, x.amount ?? null, t)
  if (type === 'system') return
  run('UPDATE leads SET last_activity_at=?, stale_flag=0 WHERE id=?', t, leadId)
  if (CONTACT_TYPES.includes(type))
    run('UPDATE leads SET first_contact_at=COALESCE(first_contact_at, ?) WHERE id=? AND agent_id=?', t, leadId, userId)
}

function rescore(leadId) {
  const lead = one('SELECT * FROM leads WHERE id=?', leadId)
  const stats = one(`SELECT (SELECT count(*) FROM activities WHERE lead_id=? AND outcome='Connected') connected,
    (SELECT count(*) FROM visits WHERE lead_id=? AND status='verified') visits`, leadId, leadId)
  run('UPDATE leads SET score=? WHERE id=?', L.leadScore(lead, stats, S('scoring')), leadId)
}

// ---------- assignment (M3) ----------
function eligibleAgents({ team_id = null, branch_id = null } = {}, exclude = null) {
  return all(`SELECT u.id, u.last_assigned_at, u.max_open,
      (SELECT count(*) FROM leads l WHERE l.agent_id=u.id AND ${OPEN}) open,
      (SELECT avg(l.status='Booked') FROM leads l WHERE l.agent_id=u.id AND l.deleted=0) conversion
    FROM users u WHERE u.role='agent' AND u.active=1 AND u.available=1
      AND (? IS NULL OR u.team_id=?) AND (? IS NULL OR u.branch_id=?) AND u.id IS NOT ?`,
    closedJson(), team_id, team_id, branch_id, branch_id, exclude).filter(a => a.open < a.max_open)
}

function setAgent(leadId, agentId, reason, actorId) {
  const t = now()
  run('UPDATE leads SET agent_id=?, assigned_at=?, sla_level=0, branch_id=(SELECT branch_id FROM users WHERE id=?) WHERE id=?', agentId, t, agentId, leadId)
  run('UPDATE users SET last_assigned_at=? WHERE id=?', t, agentId)
  const { name } = one('SELECT name FROM users WHERE id=?', agentId)
  addActivity(leadId, actorId, 'system', `Assigned to ${name}. ${reason}`)
  notify(agentId, `New lead assigned: ${one('SELECT c.name FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE l.id=?', leadId).name}`, leadId, { sms: true })
}

function autoAssign(leadId, { exclude = null, reason = 'Auto-assigned', quiet = false } = {}) {
  const lead = one('SELECT * FROM leads WHERE id=?', leadId)
  // M3.5: returning contact goes back to previous owner if still active
  const prev = one(`SELECT l.agent_id FROM leads l JOIN users u ON u.id=l.agent_id
    WHERE l.contact_id=? AND l.id<>? AND u.active=1 AND u.available=1 AND u.id IS NOT ? ORDER BY l.id DESC`, lead.contact_id, lead.id, exclude)
  if (prev) return setAgent(leadId, prev.agent_id, 'Returning contact, previous owner.', null), prev.agent_id
  const hour = new Date(Date.now() + 5 * 3600e3).getUTCHours()
  for (const r of [...S('assignment_rules')].sort((a, b) => a.priority - b.priority)) {
    if (!L.ruleMatches(r, lead, hour)) continue
    const pool = eligibleAgents(r, exclude)
    const id = r.method === 'agent' ? pool.find(a => a.id === r.agent_id)?.id : L.pickAgent(pool, r.method)
    if (id) return setAgent(leadId, id, `${reason} by rule "${r.name}".`, null), id
  }
  if (!quiet) notifyRole(['sales_head'], `Lead #${leadId} could not be assigned: no eligible agent`, leadId)
  return null
}

// ---------- lead creation (M1.2, M1.3, M1.4) ----------
const LEAD_FIELDS = ['source', 'campaign', 'campaign_id', 'adset', 'ad', 'form_id', 'referrer', 'city', 'lead_type', 'interest', 'property_type', 'budget_min', 'budget_max',
  'locations', 'payment_pref', 'project', 'remarks', 'tags', 'custom', 'dealer_id']
const CONTACT_FIELDS = ['name', 'alt_phones', 'email', 'cnic']
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k] === '' ? null : typeof o[k] === 'object' && o[k] ? JSON.stringify(o[k]) : o[k]]))

function checkLeadInput(input) {
  const phone = L.normalizePhone(input.phone)
  if (!phone) throw err(400, `Invalid phone "${input.phone ?? ''}"`)
  if (!input.source) throw err(400, 'Source is required')
  if (!input.name?.trim()) throw err(400, 'Name is required')
  return { phone, email: input.email?.trim().toLowerCase() || null }
}
const findContact = (phone, email) => one('SELECT * FROM contacts WHERE phone=? OR (? IS NOT NULL AND email=?)', phone, email, email)

const createLead = tx((input, actorId = null, agentId = null) => {
  const { phone, email } = checkLeadInput(input)
  if (input.ext_id && one('SELECT 1 FROM leads WHERE ext_id=?', input.ext_id)) return { duplicate: true }
  let contact = findContact(phone, email)
  if (contact) {
    const open = one(`SELECT * FROM leads l WHERE contact_id=? AND COALESCE(lead_type,'buyer')=? AND ${OPEN} ORDER BY id DESC`,
      contact.id, input.lead_type || 'buyer', closedJson())
    if (open) {
      addActivity(open.id, actorId, 'system', `Repeat inquiry via ${input.source}${input.campaign ? ' / ' + input.campaign : ''}${input.remarks ? ': ' + input.remarks : ''}`)
      notify(open.agent_id, `Existing lead ${contact.name} inquired again via ${input.source}`, open.id)
      return { lead_id: open.id, duplicate: true }
    }
  } else {
    const id = run('INSERT INTO contacts(name,phone,alt_phones,email,cnic,created_at) VALUES(?,?,?,?,?,?)',
      input.name.trim(), phone, input.alt_phones ?? null, email, input.cnic ?? null, now()).lastInsertRowid
    contact = { id }
  }
  const f = pick(input, LEAD_FIELDS)
  const cols = ['contact_id', 'ext_id', 'created_at', ...Object.keys(f)]
  const leadId = run(`INSERT INTO leads(${cols}) VALUES(${cols.map(() => '?')})`, contact.id, input.ext_id ?? null, input.created_at ?? now(), ...Object.values(f)).lastInsertRowid
  addActivity(leadId, actorId, 'system', `Lead created from ${input.source}`)
  if (agentId) setAgent(leadId, agentId, 'Manual entry.', actorId)
  else autoAssign(leadId)
  rescore(leadId)
  return { lead_id: leadId, duplicate: false }
})

// ---------- scoping (who sees which leads) ----------
function scope(u) {
  const a = accessOf(u.role)
  if (a === 'all') return ['1=1', []]
  if (a === 'branch') return ['l.branch_id=?', [u.branch_id]]
  if (a === 'team') return ['l.agent_id IN (SELECT id FROM users WHERE team_id=?)', [u.team_id]]
  if (a === 'own') return ['l.agent_id=?', [u.id]]
  return ['0', []]
}
function scopedLead(u, id) {
  const [w, p] = scope(u)
  const lead = one(`SELECT l.*, c.name, c.phone, c.alt_phones, c.email, c.cnic, u.name agent_name FROM leads l
    JOIN contacts c ON c.id=l.contact_id LEFT JOIN users u ON u.id=l.agent_id WHERE l.id=? AND l.deleted=0 AND ${w}`, id, ...p)
  if (!lead) throw err(404, 'Lead not found')
  return lead
}
const maskRow = (u, r) => (can(u, 'view_phone') ? r : { ...r, phone: L.maskPhone(r.phone), alt_phones: r.alt_phones && '*****' })

// ---------- app ----------
const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)

app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  })
  next()
})

app.use((req, res, next) => {
  if (!req.path.startsWith('/api') || req.method === 'OPTIONS') return next()
  const ip = req.ip || 'local'
  const wait = overLimit('api:' + ip, API_PER_MIN, 60e3) ||
    (PUBLIC_PATHS.test(req.path) ? overLimit('public:' + ip, PUBLIC_PER_MIN, 60e3) : 0)
  if (!wait) return next()
  res.set('Retry-After', String(wait))
  next(err(429, `Too many requests. Try again in ${wait} second${wait === 1 ? '' : 's'}.`))
})

// Only endpoints that carry base64 files may send a large body; everything else stays small so a
// giant payload cannot be used to burn memory or CPU on the API.
const jsonParser = limit => express.json({ limit, verify: (req, _res, buf) => { req.rawBody = buf } })
const smallJson = jsonParser('2mb'), bigJson = jsonParser('24mb')
const BIG_BODY = /^\/api\/(media|overlays|leads\/import)(\/|$)|^\/api\/projects\/\d+\/map$|^\/api\/units\/\d+\/photos$|^\/api\/allotments\/\d+\/docs\/|^\/api\/edu\/students\/\d+\/documents$|^\/api\/platform\/accounts\/\d+\/restore$/
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next()
  const parse = BIG_BODY.test(req.path) ? bigJson : smallJson
  parse(req, res, next)
})
// body-parser leaves req.body undefined when a request carries no JSON; route handlers expect an object
app.use((req, _res, next) => { if (req.body == null) req.body = {}; next() })

app.get('/api/health', (req, res) => {
  const mode = remote ? 'turso' : 'file'
  const host = dbHost ? { host: dbHost } : {}
  if (!db) return res.status(503).json({ ok: false, db: mode, ...host, error: String(dbError?.message || 'Database unavailable').slice(0, 300) })
  res.json({
    ok: true,
    db: mode,
    ...host,
    schema: SCHEMA_VERSION,
    has_resend_key: !!process.env.RESEND_API_KEY,
    email_from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
    site_url: process.env.SITE_URL || 'https://app.estatecentric.com'
  })
})

// Without this, a failed database init becomes an opaque FUNCTION_INVOCATION_FAILED on every route
app.use('/api', (req, res, next) => {
  if (db) return next()
  res.status(503).json({ error: 'Database unavailable', detail: String(dbError?.message || 'init failed').slice(0, 300) })
})

// Login is throttled per IP (all attempts) and per account (failed attempts), so neither a single
// address nor a single account can be hammered; a successful sign-in clears that account's failures.
app.post('/api/login', async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const password = typeof req.body.password === 'string' ? req.body.password : ''
  // scrypt cost scales with input, so refuse oversized credentials before hashing anything
  if (email.length > 254 || password.length > 200) throw err(400, 'Enter a valid email and password')
  const ip = req.ip || 'local'
  rateHit(rateKey('login-ip', ip), 60, 15 * 60e3)
  const userKey = rateKey('login-user', email)
  const locked = rateLocked(userKey)
  if (locked?.count >= 5) throw err(429, rateMsg('Too many attempts', locked.reset_at))
  const u = one('SELECT * FROM users WHERE email=? AND active=1', email)
  if (!u || !checkPw(password, u.pass)) {
    const pending = one('SELECT * FROM users WHERE email=? AND active=0', email)
    if (pending && checkPw(password, pending.pass)) throw err(403, 'Please verify your email address. Check your inbox for the verification link.', { need_verify: true, email: pending.email })
    rateHit(userKey, 5, 15 * 60e3)
    audit(u?.id, 'login_failed', 'user', u?.id, { email }, req.ip)
    throw err(401, 'Wrong email or password')
  }
  if (trialOver(u)) {
    audit(u.id, 'login_blocked_trial', 'user', u.id, { plan: u.plan }, req.ip)
    throw err(403, `Your ${planName(u.plan)} free trial ended on ${u.trial_ends_at.slice(0, 10)}.`,
      { trial_ended: true, plan: u.plan, trial_ends_at: u.trial_ends_at, support: SUPPORT_WHATSAPP })
  }
  if (u.totp_on) {
    const method = u.two_factor_method || 'email'
    if (!req.body.code) {
      if (method === 'email') {
        // Generate 6-digit random code and email it to the user
        const code = String(crypto.randomInt(100000, 999999))
        const expiresAt = Date.now() + 10 * 60e3 // 10 minutes
        // Invalidate older codes
        run('DELETE FROM login_email_codes WHERE user_id=?', u.id)
        run('INSERT INTO login_email_codes(user_id,code,expires_at,created_at) VALUES(?,?,?,?)', u.id, code, expiresAt, now())
        const html = `<div style="font-family:Arial,sans-serif;max-width:520px;padding:20px;border:1px solid #eee;border-radius:10px">
<h2 style="margin:0 0 12px;color:#1a1a2e">Your Login Verification Code</h2>
<p style="color:#4a4a6a;line-height:1.6">Hi ${u.name},</p>
<p style="color:#4a4a6a;line-height:1.6">Here is your two-factor login verification code for Estate Centric:</p>
<div style="margin:20px 0;padding:16px;background:#fff7ed;border:1px dashed #fed7aa;border-radius:8px;text-align:center">
  <span style="font-size:32px;font-weight:900;letter-spacing:6px;color:#ea580c">${code}</span>
</div>
<p style="color:#888;font-size:12px">This code is valid for 10 minutes. If you did not attempt to sign in, change your password immediately.</p>
</div>`
        await sendEmail(u.email, `Your Estate Centric Login Code: ${code}`, html).catch(e => console.error('[2fa email]', e))
        return res.json({ need_code: true, method: 'email', email: u.email })
      } else {
        return res.json({ need_code: true, method: 'totp' })
      }
    }

    if (method === 'email') {
      const match = one('SELECT * FROM login_email_codes WHERE user_id=? AND code=? AND used_at IS NULL AND expires_at>?',
        u.id, String(req.body.code).trim(), Date.now())
      if (!match) {
        rateHit(userKey, 5, 15 * 60e3)
        audit(u.id, 'login_failed', 'user', u.id, { email, reason: '2fa_email' }, req.ip)
        throw err(401, 'Invalid or expired verification code')
      }
      run('UPDATE login_email_codes SET used_at=? WHERE id=?', now(), match.id)
    } else {
      if (!checkTotp(u.totp_secret, req.body.code)) {
        rateHit(userKey, 5, 15 * 60e3)
        audit(u.id, 'login_failed', 'user', u.id, { email, reason: '2fa_totp' }, req.ip)
        throw err(401, 'Wrong authenticator code')
      }
    }
  }
  rateClear(userKey)
  const token = crypto.randomBytes(32).toString('hex')
  run('INSERT INTO sessions VALUES(?,?,?)', token, u.id, now())
  audit(u.id, 'login', 'user', u.id, null, req.ip)
  res.json({ token })
})

// Self-service sign-up: creates an inactive account; email verification activates it.
app.post('/api/register', async (req, res) => {
  const ip = req.ip || 'local'
  rateHit(rateKey('register-ip', ip), 5, 3600e3, 'Too many sign-ups from this address')
  // A global ceiling stops a botnet rotating addresses from flooding the approval queue and audit log
  rateHit('register-all', 50, 3600e3, 'Sign-ups are paused for a while')
  // Honeypot: real people never see or fill the off-screen field; bots fill everything. Pretend success.
  if (typeof req.body.website === 'string' && req.body.website.trim()) return res.json({ ok: true })
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const pass = typeof req.body.password === 'string' ? req.body.password : ''
  const rawPhone = typeof req.body.phone === 'string' ? req.body.phone.trim() : ''
  const phone = rawPhone ? L.normalizePhone(rawPhone) : null
  if (!name) throw err(400, 'Name is required')
  if (name.length > 80) throw err(400, 'Name is too long')
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err(400, 'Enter a valid email address')
  const pwProblem = L.passwordProblem(pass)
  if (pwProblem) throw err(400, pwProblem)
  if (rawPhone.length > 30 || (rawPhone && !phone)) throw err(400, 'Enter a valid phone number')
  if (one('SELECT 1 FROM users WHERE email=?', email)) throw err(400, 'An account with that email already exists')
  const plan = pickPlan(req.body.plan)
  const trialEnds = trialEndsAt()
  const id = run('INSERT INTO users(name,email,phone,role,active,available,pass,plan,trial_ends_at,created_at) VALUES(?,?,?,?,0,1,?,?,?,?)',
    name, email, phone, 'agent', hash(pass), plan.id, trialEnds, now()).lastInsertRowid
  audit(null, 'register', 'user', id, { email, plan: plan.id }, req.ip)
  // Generate and store a 32-byte verification token
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
  const expiresAt = Date.now() + 24 * 3600e3 // 24 hours
  run('INSERT INTO email_verifications(user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?)', id, tokenHash, expiresAt, now())
  const siteUrl = process.env.SITE_URL || 'https://app.estatecentric.com'
  const verifyUrl = `${siteUrl}/#/verify-email?token=${rawToken}`
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;padding:20px;border:1px solid #eee;border-radius:10px">
<h2 style="margin:0 0 12px;color:#1a1a2e">Verify your email</h2>
<p style="color:#4a4a6a;line-height:1.6">Hi ${name},</p>
<p style="color:#4a4a6a;line-height:1.6">Thanks for signing up for Estate Centric! Click the button below to verify your email and activate your account:</p>
<div style="margin:24px 0">
  <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#ea580c;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Verify Email</a>
</div>
<p style="color:#888;font-size:12px">Or copy and paste this link in your browser:<br/><a href="${verifyUrl}" style="color:#ea580c">${verifyUrl}</a></p>
<p style="color:#888;font-size:12px">This link expires in 24 hours. If you didn't create an account, ignore this email.</p>
</div>`
  await sendEmail(email, 'Verify your Estate Centric email', html).catch(e => console.error('[register email error]', e))
  res.json({ ok: true, plan: plan.id, trial_ends_at: trialEnds })
})

// Email verification: called by the frontend with the raw token from the link
app.post('/api/verify-email', (req, res) => {
  rateHit(rateKey('verify-ip', req.ip || 'local'), 10, 15 * 60e3, 'Too many verification attempts')
  const token = typeof req.body.token === 'string' ? req.body.token.trim() : ''
  if (!token) throw err(400, 'Verification token is required')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const row = one('SELECT * FROM email_verifications WHERE token_hash=?', tokenHash)
  if (!row || row.used_at || row.expires_at <= Date.now()) throw err(400, 'This verification link has expired or already been used. Request a new one.')
  run('UPDATE users SET active=1, email_verified=1 WHERE id=?', row.user_id)
  run('UPDATE email_verifications SET used_at=? WHERE token_hash=?', now(), tokenHash)
  audit(row.user_id, 'email_verified', 'user', row.user_id, null, req.ip)
  res.json({ ok: true })
})

// Resend verification email
app.post('/api/resend-verification', async (req, res) => {
  rateHit(rateKey('resend-verify-ip', req.ip || 'local'), 3, 3600e3, 'Too many resend requests. Try again in an hour.')
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const u = email && one('SELECT * FROM users WHERE email=? AND active=0', email)
  if (u) {
    run('DELETE FROM email_verifications WHERE user_id=?', u.id)
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = Date.now() + 24 * 3600e3
    run('INSERT INTO email_verifications(user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?)', u.id, tokenHash, expiresAt, now())
    const siteUrl = process.env.SITE_URL || 'https://app.estatecentric.com'
    const verifyUrl = `${siteUrl}/#/verify-email?token=${rawToken}`
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;padding:20px;border:1px solid #eee;border-radius:10px">
<h2 style="margin:0 0 12px;color:#1a1a2e">Verify your email</h2>
<p style="color:#4a4a6a;line-height:1.6">Hi ${u.name},</p>
<p style="color:#4a4a6a;line-height:1.6">Click the button below to verify your email and activate your account:</p>
<div style="margin:24px 0">
  <a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#ea580c;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Verify Email</a>
</div>
<p style="color:#888;font-size:12px">Or copy and paste this link in your browser:<br/><a href="${verifyUrl}" style="color:#ea580c">${verifyUrl}</a></p>
<p style="color:#888;font-size:12px">This link expires in 24 hours.</p>
</div>`
    await sendEmail(email, 'Verify your Estate Centric email', html).catch(e => console.error('[resend-verify email error]', e))
  }
  res.json({ ok: true }) // always succeeds — don't reveal if email exists
})

// "Forgot password": the answer never reveals whether the email exists, and no reset secret is emailed
// or logged. Admins are notified and hand the user a one-time link from Users.
app.post('/api/forgot-password', (req, res) => {
  const ip = req.ip || 'local'
  rateHit(rateKey('forgot-ip', ip), 5, 3600e3, 'Too many reset requests from this address')
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : ''
  if (email) rateHit(rateKey('forgot-user', email), 3, 3600e3, 'Too many reset requests for this account')
  const u = email && one('SELECT * FROM users WHERE email=? AND active=1', email)
  if (u) {
    for (const a of all('SELECT * FROM users WHERE active=1').filter(a => can(a, 'manage_users')))
      notify(a.id, `Password reset requested for ${u.name} (${u.email}). Open Users and copy their reset link.`, null)
    audit(null, 'password_reset_requested', 'user', u.id, { email }, ip)
  }
  res.json({ ok: true })
})

app.post('/api/reset-password', (req, res) => {
  rateHit(rateKey('reset-ip', req.ip || 'local'), 10, 15 * 60e3, 'Too many reset attempts')
  const token = typeof req.body.token === 'string' ? req.body.token.trim() : ''
  const pass = typeof req.body.password === 'string' ? req.body.password : ''
  const problem = L.passwordProblem(pass)
  if (problem) throw err(400, problem)
  const row = /^[a-f0-9]{64}$/.test(token) && one('SELECT * FROM password_resets WHERE token_hash=?', hashToken(token))
  if (!row || row.used_at || row.expires_at <= Date.now()) throw err(400, 'This reset link has expired. Ask an admin for a new one.')
  const u = one('SELECT * FROM users WHERE id=? AND active=1', row.user_id)
  if (!u) throw err(400, 'This reset link is no longer usable. Ask an admin for a new one.')
  run('UPDATE users SET pass=? WHERE id=?', hash(pass), u.id)
  run('UPDATE password_resets SET used_at=? WHERE token_hash=?', now(), row.token_hash)
  run('DELETE FROM sessions WHERE user_id=?', u.id) // a reset signs the account out everywhere
  audit(u.id, 'password_reset', 'user', u.id, null, req.ip)
  res.json({ ok: true })
})

// Vercel Cron entry point; replaces the 60s in-process timers when deployed serverless
app.get('/api/cron/tick', (req, res) => {
  const secret = process.env.CRON_SECRET
  if (!secret || !safeEqual(req.headers.authorization, `Bearer ${secret}`)) throw err(401, 'Unauthorized')
  leaseTick()
  slaTick()
  reportTick()
  run('DELETE FROM rate_limits WHERE reset_at < ?', Date.now())
  run('DELETE FROM password_resets WHERE used_at IS NOT NULL OR expires_at < ?', Date.now())
  res.json({ ok: true })
})

// ---- public integration endpoints (M2) ----
// Facebook settings come from Settings › Facebook (stored in the DB); .env values are the fallback
// ponytail: the app secret and page token sit in the settings table in plain text like the rest of the DB; encrypt them if the DB file ever leaves the server
const fbConf = () => ({ verify_token: process.env.FB_VERIFY_TOKEN, app_secret: process.env.FB_APP_SECRET, page_token: process.env.FB_PAGE_TOKEN, ...S('facebook') })
// Imports run before the 200 (serverless freezes the function once it responds), so record each
// delivery in the settings row and show it in Settings › Facebook to keep failed imports visible.
const fbNote = ev => run(`INSERT INTO settings VALUES('fb_log',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  JSON.stringify([...(S('fb_log') || []), ev].slice(-20)))
const GRAPH = process.env.FB_GRAPH_URL || 'https://graph.facebook.com/v21.0' // override only to test against a fake Graph API
async function graph(path, params = {}, method = 'GET') {
  let r
  try { r = await fetch(`${GRAPH}/${path}?${new URLSearchParams(params)}`, { method }) }
  catch (e) { throw err(502, `The CRM server could not reach Facebook: ${e.cause?.code || e.message}`) }
  const d = await r.json().catch(() => ({}))
  if (!r.ok || d.error) throw err(400, `Facebook says: ${d.error?.message || r.statusText}`)
  return d
}
app.get('/api/webhooks/facebook', (req, res) => {
  if (req.query['hub.verify_token'] && req.query['hub.verify_token'] === fbConf().verify_token) return res.send(req.query['hub.challenge'])
  res.sendStatus(403)
})
app.post('/api/webhooks/facebook', async (req, res) => {
  const secret = fbConf().app_secret
  if (!secret) throw err(503, 'Facebook is not connected (Settings › Facebook)')
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex')
  if (!safeEqual(req.headers['x-hub-signature-256'], sig)) { fbNote({ t: now(), sig: 'rejected' }); return res.sendStatus(401) }
  const ids = []
  for (const e of req.body.entry || []) for (const c of e.changes || [])
    if (c.field === 'leadgen') ids.push(c.value?.leadgen_id)
  await Promise.all(ids.map(id => importFbLead(id).then(
    () => fbNote({ t: now(), id, ok: true }),
    e => {
      fbNote({ t: now(), id, ok: false, err: e.message })
      if (/plan covers/.test(e.message)) notifyPlanBlock(e.message, 'Facebook lead ' + id)
    })))
  res.sendStatus(200)
})
async function importFbLead(id) {
  planCap(systemAccount(), 'leads')
  const fields = 'field_data,campaign_id,campaign_name,adset_name,ad_name,form_id,platform,created_time'
  const d = await graph(id, { fields, access_token: fbConf().page_token })
  const fd = Object.fromEntries((d.field_data || []).map(f => [f.name, f.values?.[0]]))
  const rawPhone = fd.phone_number || fd.whatsapp_number || null
  const invalidPhone = rawPhone && !L.normalizePhone(rawPhone)
  const phone = invalidPhone ? 'FB' + String(id).replace(/\D/g, '') : rawPhone
  const remarks = [
    Object.entries(fd).filter(([k]) => !['full_name', 'first_name', 'phone_number', 'whatsapp_number', 'email', 'city'].includes(k)).map(([k, v]) => `${k}: ${v}`).join('; '),
    invalidPhone ? `phone given: ${rawPhone}` : '',
  ].filter(Boolean).join('; ') || null
  createLead({
    ext_id: 'fb:' + id, name: fd.full_name || fd.first_name || 'Facebook lead', phone, email: fd.email, city: fd.city,
    source: d.platform === 'ig' ? 'Instagram' : 'Facebook', campaign: d.campaign_name, campaign_id: d.campaign_id, adset: d.adset_name, ad: d.ad_name, form_id: d.form_id,
    remarks,
  })
}
// Website forms, Zapier, portal email parsers, telephony "new caller" hooks all post here (M2.2-M2.6)
const inboundKey = () => S('inbound_key') || process.env.INBOUND_API_KEY
app.post('/api/inbound', (req, res) => {
  const key = inboundKey()
  if (!key) throw err(503, 'Website forms are not set up (Settings › Website forms)')
  if (!safeEqual(req.headers['x-api-key'], key)) throw err(401, 'Bad API key')
  // A leaked key must not be able to flood the pipeline; hash it so the raw secret never lands in the DB
  const keyHash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)
  rateHit(rateKey('inbound', keyHash), 600, 3600e3, 'Website form limit reached')
  planCap(systemAccount(), 'leads')
  res.json(createLead({ ...req.body, source: req.body.source || 'Website' }))
})

// Client map link: plot status and size only, never customers or prices
const sharedProject = token => {
  const p = token && one('SELECT id, name, city, kind, map_svg FROM projects WHERE share_token=? AND map_svg IS NOT NULL', token)
  if (!p) throw err(404, 'This map link is not valid')
  return p
}
app.get('/api/public/map/:token', (req, res) => {
  const { map_svg, ...p } = sharedProject(req.params.token)
  res.json({ ...p, statuses: S('unit_statuses'), units: all(`SELECT id, map_ref, phase, block, street, unit_no, unit_type, category, size, uom, facing, dimensions, status
    FROM units WHERE project_id=? AND map_ref IS NOT NULL`, p.id) })
})
app.get('/api/public/map/:token/svg', (req, res) => sendSvg(res, sharedProject(req.params.token).map_svg))

// Customer portal: the buyer's own allotments, schedule and receipts, behind an unguessable per-contact link
const portalContact = token => {
  const c = /^[a-f0-9]{48}$/.test(token || '') && one('SELECT * FROM contacts WHERE portal_token=?', token)
  if (!c) throw err(404, 'This link is not valid. Ask your agent for a new one.')
  return c
}
app.get('/api/portal/:token', (req, res) => {
  const c = portalContact(req.params.token)
  const allots = all(`${ALLOT_SELECT} WHERE l.contact_id=? ORDER BY a.id`, c.id).map(a => {
    const paid = paidFor(a.id)
    return {
      ...pick(a, ['id', 'allotment_no', 'status', 'sale_status', 'price', 'sale_date', 'project', 'city', 'kind', 'phase', 'block', 'street', 'unit_no', 'unit_type', 'size', 'uom', 'category']),
      paid, schedule: L.allocate(all('SELECT label, due_date, amount FROM installments WHERE allotment_id=? ORDER BY due_date, id', a.id), paid, today()),
      payments: all(`SELECT id, receipt_no, kind, amount, method, paid_on FROM payments WHERE allotment_id=? AND lead_id IN (SELECT id FROM leads WHERE contact_id=?) AND voided_at IS NULL ORDER BY paid_on, id`, a.id, c.id),
    }
  })
  res.json({ name: c.name, allotments: allots })
})
app.get('/api/portal/:token/receipts/:id', (req, res) => {
  const c = portalContact(req.params.token), r = receiptData(req.params.id)
  if (!one('SELECT 1 FROM leads WHERE id=? AND contact_id=?', r.lead_id, c.id) || r.voided_at) throw err(404, 'Receipt not found')
  res.json(r)
})
// Media files (brochures, floor plans, listing photos) are served by unguessable token so they can be shared with clients
app.get('/api/files/:token', (req, res) => {
  const f = one('SELECT name, mime, data FROM media WHERE token=? AND data IS NOT NULL', req.params.token)
  if (!f) throw err(404, 'File not found')
  res.set('cache-control', 'private, max-age=86400').type(f.mime).set('content-disposition', `inline; filename="${(f.name || 'file').replace(/[^\w. -]/g, '_')}"`).send(f.data)
})

// Society map images laid over the satellite (loaded by the map by token, so no login header is needed)
app.get('/api/overlay-images/:token', (req, res) => {
  const o = one('SELECT mime, data FROM overlays WHERE token=?', req.params.token)
  if (!o) throw err(404, 'Map image not found')
  res.set('cache-control', 'private, max-age=86400').type(o.mime).send(o.data)
})

// ---- everything below needs a session ----
app.use('/api', (req, _res, next) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
  if (!/^[a-f0-9]{64}$/.test(token)) throw err(401, 'Please log in') // keep junk out of the session lookup
  const u = one(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1 AND s.created_at>?`,
    token, new Date(Date.now() - 7 * 864e5).toISOString())
  if (!u) throw err(401, 'Please log in')
  req.user = u
  req.token = token
  next()
})
const guard = perm => (req, _res, next) => (can(req.user, perm) ? next() : next(err(403, 'You do not have permission for this')))
const log = (req, action, entity, id, data) => audit(req.user.id, action, entity, id, data, req.ip)

app.post('/api/logout', (req, res) => { run('DELETE FROM sessions WHERE token=?', req.token); res.json({ ok: true }) })

// ---- my profile & password ----
app.patch('/api/me', (req, res) => {
  const f = pick(req.body, ['name', 'phone'])
  if ('name' in f && !String(f.name || '').trim()) throw err(400, 'Name is required')
  if (Object.keys(f).length) run(`UPDATE users SET ${Object.keys(f).map(k => k + '=?')} WHERE id=?`, ...Object.values(f), req.user.id)
  log(req, 'update_profile', 'user', req.user.id, f)
  res.json({ ok: true })
})
app.post('/api/me/password', (req, res) => {
  const current = typeof req.body.current === 'string' ? req.body.current : ''
  const pass = typeof req.body.password === 'string' ? req.body.password : ''
  if (current.length > 200 || !checkPw(current, req.user.pass)) throw err(400, 'Current password is wrong')
  const problem = L.passwordProblem(pass)
  if (problem) throw err(400, problem)
  run('UPDATE users SET pass=? WHERE id=?', hash(pass), req.user.id)
  run('DELETE FROM sessions WHERE user_id=? AND token<>?', req.user.id, req.token) // log out other devices
  log(req, 'change_password', 'user', req.user.id)
  res.json({ ok: true })
})

// ---- two-factor login (Email code or TOTP app) ----
app.post('/api/me/2fa/email/enable', async (req, res) => {
  run("UPDATE users SET totp_on=1, two_factor_method='email', totp_secret=NULL WHERE id=?", req.user.id)
  log(req, '2fa_email_on', 'user', req.user.id)
  res.json({ ok: true, method: 'email' })
})
app.post('/api/me/2fa/setup', (req, res) => {
  if (req.user.totp_on && req.user.two_factor_method === 'totp') throw err(400, 'Two-factor authenticator app is already on')
  const secret = newSecret()
  run('UPDATE users SET totp_secret=? WHERE id=?', secret, req.user.id)
  res.json({ secret, uri: `otpauth://totp/Estate%20Centric:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=Estate%20Centric` })
})
app.post('/api/me/2fa/enable', (req, res) => {
  if (!checkTotp(req.user.totp_secret, req.body.code)) throw err(400, 'That code is not right. Check the time on your phone and try the newest code.')
  run("UPDATE users SET totp_on=1, two_factor_method='totp' WHERE id=?", req.user.id)
  run('DELETE FROM sessions WHERE user_id=? AND token<>?', req.user.id, req.token) // other devices must log in again with a code
  log(req, '2fa_on', 'user', req.user.id)
  res.json({ ok: true, method: 'totp' })
})
app.post('/api/me/2fa/disable', (req, res) => {
  if (!checkPw(String(req.body.password || ''), req.user.pass)) throw err(400, 'Wrong password')
  run('UPDATE users SET totp_on=0, totp_secret=NULL, two_factor_method=NULL WHERE id=?', req.user.id)
  log(req, '2fa_off', 'user', req.user.id)
  res.json({ ok: true })
})
app.post('/api/users/:id/reset-2fa', guard('manage_users'), (req, res) => { // reset
  run('UPDATE users SET totp_on=0, totp_secret=NULL, two_factor_method=NULL WHERE id=?', req.params.id)
  run('DELETE FROM sessions WHERE user_id=?', req.params.id)
  log(req, '2fa_reset', 'user', +req.params.id)
  res.json({ ok: true })
})
// Admin hands out a one-time link instead of choosing a password (so the admin never knows it)
app.post('/api/users/:id/reset-password', guard('manage_users'), (req, res) => {
  const u = one('SELECT * FROM users WHERE id=? AND active=1', req.params.id)
  if (!u) throw err(404, 'User not found')
  const token = issueReset(u.id)
  notify(u.id, 'An admin created a password reset link for you', null)
  log(req, 'password_reset_link', 'user', u.id)
  res.json({ token, expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString() })
})

app.get('/api/meta', (req, res) => {
  const u = req.user
  const keys = ['commission', 'statuses', 'closed_statuses', 'approval_statuses', 'lost_reasons', 'sources', 'activity_types', 'outcomes', 'lead_types', 'property_types', 'custom_fields', 'sites', 'unit_statuses', 'listing_statuses', 'societies']
  const edu = eduOpen(u) ? { edu_stages: S('edu_stages'), edu_doc_types: S('edu_doc_types'), edu_levels: S('edu_levels'), edu_intakes: S('edu_intakes'),
    edu_countries: S('edu_countries'), edu_application_statuses: S('edu_application_statuses'),
    edu_payment_types: S('edu_payment_types'), edu_visa_outcomes: S('edu_visa_outcomes'),
    edu_country_checklists: S('edu_country_checklists') || DEFAULTS.edu_country_checklists } : {}
  res.json({
    me: { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, team_id: u.team_id, branch_id: u.branch_id, available: u.available, totp_on: !!u.totp_on, two_factor_method: u.two_factor_method || 'email',
      plan: u.plan, paid_at: u.paid_at, trial_ends_at: u.trial_ends_at, modules: modulesOf(u),
      trial_days_left: u.trial_ends_at && !u.paid_at ? trialDaysLeft(u) : null },
    perms: Object.keys({ ...DEFAULTS.permissions, ...S('permissions') }).filter(p => can(u, p)),
    settings: { ...Object.fromEntries(keys.map(k => [k, S(k)])), ...edu, projects: all('SELECT name FROM projects ORDER BY name').map(p => p.name) },
    users: all("SELECT id, name, role, team_id, branch_id, active, available FROM users WHERE role!='platform' ORDER BY name"),
    branches: all('SELECT * FROM branches'), teams: all('SELECT * FROM teams'),
    dealers: all('SELECT id, name, company, active FROM dealers ORDER BY name'),
    roles: roles().map(r => ({ key: r.key, label: r.label })),
    maptiler_key: S('maptiler_key') || null,
  })
})
app.post('/api/me/available', (req, res) => {
  run('UPDATE users SET available=? WHERE id=?', req.body.available ? 1 : 0, req.user.id)
  log(req, 'availability', 'user', req.user.id, { available: !!req.body.available })
  res.json({ ok: true })
})

// ---- leads ----
function leadQuery(req) {
  const q = req.query, u = req.user
  const [w, p] = scope(u)
  const where = [`l.deleted=0`, w], params = [...p]
  const add = (sql, ...v) => { where.push(sql); params.push(...v) }
  if (q.status) add('l.status=?', q.status)
  if (q.source) add('l.source=?', q.source)
  if (q.project) add('l.project=?', q.project)
  if (q.campaign) add('(l.campaign_id=? OR lower(l.campaign)=lower(?))', q.campaign, q.campaign)
  if (q.agent_id) add('l.agent_id=?', q.agent_id)
  if (q.q) add('(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR l.project LIKE ?)', `%${q.q}%`, `%${L.normalizePhone(q.q) || q.q.replace(/\D/g, '').replace(/^0+/, '') || q.q}%`, `%${q.q}%`, `%${q.q}%`)
  const closed = closedJson()
  if (q.filter === 'overdue') add(`l.next_action_at < ? AND l.status NOT IN (SELECT value FROM json_each(?))`, now(), closed)
  if (q.filter === 'unassigned') add('l.agent_id IS NULL')
  if (q.filter === 'pending') add('l.pending_status IS NOT NULL')
  if (q.filter === 'untouched') add(`COALESCE(l.last_activity_at, l.created_at) < ? AND l.status NOT IN (SELECT value FROM json_each(?))`, new Date(Date.now() - S('stale_days') * 864e5).toISOString(), closed)
  if (q.filter === 'recycle') add(`l.status='Lost' AND l.lost_at < ?`, new Date(Date.now() - S('recycle_cooldown_days') * 864e5).toISOString())
  return [`FROM leads l JOIN contacts c ON c.id=l.contact_id LEFT JOIN users u ON u.id=l.agent_id WHERE ${where.join(' AND ')}`, params]
}
app.get('/api/leads', (req, res) => {
  const [from, p] = leadQuery(req)
  const page = Math.max(0, +req.query.page || 0), size = Math.min(500, Math.max(1, +req.query.size || 50)) // the board asks for more
  const rows = all(`SELECT l.id, c.name, c.phone, l.source, l.campaign, l.city, l.project, l.status, l.pending_status, l.score, l.agent_id, u.name agent_name,
    l.next_action_at, l.last_activity_at, l.created_at ${from} ORDER BY l.id DESC LIMIT ? OFFSET ?`, ...p, size, page * size)
  res.json({ rows: rows.map(r => maskRow(req.user, r)), total: one(`SELECT count(*) n ${from}`, ...p).n })
})

// Campaigns: lead counts per (campaign, form_id) from the same scoped rows the leads list uses
app.get('/api/campaigns', (req, res) => {
  const [w, p] = scope(req.user)
  const rows = all(`SELECT l.campaign, l.form_id, l.source, l.project, l.status, l.created_at FROM leads l
    WHERE l.deleted=0 AND (l.campaign IS NOT NULL OR l.form_id IS NOT NULL) AND ${w}`, ...p)
  res.json({ rows: L.groupCampaigns(rows, S('closed_statuses')), page_name: S('facebook')?.page_name ?? null })
})

// Meta campaigns (needs the ads_read user token saved on connect), with CRM lead counts; cached 60s
let metaCache
app.get('/api/campaigns/meta', async (req, res) => {
  const tok = S('facebook')?.user_token
  if (!tok) return res.json({ connected: false, reason: 'Reconnect Facebook and tick the ads_read permission' })
  if (metaCache?.tok !== tok || Date.now() - metaCache.at > 6e4) {
    try {
      const out = []
      for (const a of (await graph('me/adaccounts', { fields: 'name,account_id,currency', access_token: tok, limit: 100 })).data || []) {
        const camps = (await graph(`act_${a.account_id}/campaigns`, { fields: 'name,status,effective_status,objective,daily_budget,lifetime_budget,start_time', limit: 100, access_token: tok })).data || []
        const spend = {}
        try { for (const i of (await graph(`act_${a.account_id}/insights`, { level: 'campaign', fields: 'campaign_id,spend', date_preset: 'maximum', limit: 500, access_token: tok })).data || []) spend[i.campaign_id] = +i.spend } catch {}
        out.push(...camps.map(c => ({ ...c, account: a.name, currency: a.currency, active: c.effective_status === 'ACTIVE', spend: spend[c.id] ?? null })))
      }
      metaCache = { tok, at: Date.now(), out }
    } catch (e) { return res.json({ connected: true, error: e.message }) }
  }
  const [w, p] = scope(req.user)
  const leads = all(`SELECT l.campaign, l.campaign_id, l.status FROM leads l WHERE l.deleted=0 AND (l.campaign IS NOT NULL OR l.campaign_id IS NOT NULL) AND ${w}`, ...p)
  res.json({ connected: true, rows: metaCache.out.map(c => {
    const mine = leads.filter(l => l.campaign_id ? l.campaign_id === c.id : l.campaign?.toLowerCase() === c.name.toLowerCase())
    const won = mine.filter(l => l.status === 'Booked').length
    return { ...c, leads: mine.length, won, conversion: mine.length ? Math.round((won / mine.length) * 100) : 0 }
  }), known_names: metaCache.out.map(c => c.name.toLowerCase()) })
})

app.get('/api/leads/export', guard('export'), (req, res) => sendExport(req, res))
function sendExport(req, res, extra) {
  const [from, p] = leadQuery(req)
  const rows = all(`SELECT l.id, c.name, c.phone, c.email, l.source, l.campaign, l.city, l.lead_type, l.project, l.property_type, l.budget_min, l.budget_max,
    l.status, u.name agent, l.created_at ${from} ORDER BY l.id DESC`, ...p)
  audit(req.user.id, 'export', 'lead', null, { count: rows.length, query: req.query, ...extra }, req.ip)
  res.type('text/csv').attachment(`leads-${Date.now()}.csv`)
    .send(L.toCsv([[`Exported by ${req.user.name} (${req.user.email}) at ${now()}. Confidential.`], Object.keys(rows[0] || { id: 0 }), ...rows.map(Object.values)]))
}

// Export approval: branch managers ask, export holders (sales head, admin) approve, the requester downloads once
const exporters = () => all('SELECT * FROM users WHERE active=1').filter(u => can(u, 'export'))
app.post('/api/exports', guard('request_export'), (req, res) => {
  const reason = req.body.reason?.trim()
  if (!reason) throw err(400, 'Say why you need the export')
  const id = run('INSERT INTO export_requests(user_id,query,reason,created_at) VALUES(?,?,?,?)', req.user.id, JSON.stringify(req.body.query || {}), reason, now()).lastInsertRowid
  exporters().forEach(u => notify(u.id, `${req.user.name} requests a lead export: ${reason}`))
  log(req, 'request_export', 'export', id, { reason, query: req.body.query })
  res.json({ id })
})
app.get('/api/exports', (req, res) => {
  const mine = 'r.user_id=?', approver = can(req.user, 'export')
  res.json(all(`SELECT r.*, u.name user_name, d.name decided_name FROM export_requests r JOIN users u ON u.id=r.user_id LEFT JOIN users d ON d.id=r.decided_by
    WHERE ${approver ? `(${mine} OR r.status='pending')` : mine} ORDER BY r.id DESC LIMIT 30`, req.user.id).map(r => ({ ...r, query: JSON.parse(r.query) })))
})
app.post('/api/exports/:id/decide', guard('export'), (req, res) => {
  const r = one(`SELECT * FROM export_requests WHERE id=? AND status='pending'`, req.params.id)
  if (!r) throw err(404, 'Request not found or already decided')
  const status = req.body.approve ? 'approved' : 'rejected'
  run('UPDATE export_requests SET status=?, decided_by=?, decided_at=? WHERE id=?', status, req.user.id, now(), r.id)
  notify(r.user_id, `Your lead export was ${status} by ${req.user.name}`)
  log(req, 'export_' + status, 'export', r.id)
  res.json({ ok: true })
})
app.get('/api/exports/:id/download', (req, res) => {
  const r = one(`SELECT * FROM export_requests WHERE id=? AND user_id=? AND status='approved'`, req.params.id, req.user.id)
  if (!r) throw err(404, 'No approved export to download (each approval downloads once)')
  run(`UPDATE export_requests SET status='used' WHERE id=?`, r.id)
  sendExport({ ...req, query: JSON.parse(r.query) }, res, { request_id: r.id })
})

app.post('/api/leads', (req, res) => {
  const u = req.user
  planCap(u, 'leads')
  // Agents' manual entries stay with them; managers/receptionist may pick an agent (walk-in M2.7) or leave to rules
  const agentId = u.role === 'agent' ? u.id : req.body.agent_id || null
  const r = createLead(req.body, u.id, agentId)
  log(req, 'create', 'lead', r.lead_id, { duplicate: r.duplicate, source: req.body.source })
  res.json(r)
})

app.post('/api/leads/import', guard('import'), (req, res) => {
  const rows = req.body.rows || []
  if (req.body.commit) planCap(req.user, 'leads', rows.length)
  const report = rows.map((row, i) => {
    try {
      if (!req.body.commit) {
        const { phone, email } = checkLeadInput(row)
        return { row: i + 1, status: findContact(phone, email) ? 'duplicate' : 'ok' }
      }
      const r = createLead(row, req.user.id)
      return { row: i + 1, status: r.duplicate ? 'duplicate' : 'ok', lead_id: r.lead_id }
    } catch (e) { return { row: i + 1, status: 'error', message: e.message } }
  })
  if (req.body.commit) log(req, 'import', 'lead', null, { rows: rows.length, ok: report.filter(r => r.status === 'ok').length })
  res.json({ report })
})

app.get('/api/leads/:id', (req, res) => {
  const lead = maskRow(req.user, scopedLead(req.user, req.params.id))
  if (can(req.user, 'view_phone')) log(req, 'view', 'lead', lead.id)
  res.json({
    lead,
    activities: all('SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE lead_id=? ORDER BY a.id DESC', lead.id),
    visits: all('SELECT v.id, v.site, v.scheduled_at, v.status, v.distance_m, v.verified_at, v.feedback, u.name agent_name FROM visits v LEFT JOIN users u ON u.id=v.agent_id WHERE lead_id=? ORDER BY v.id DESC', lead.id),
    other_leads: all('SELECT id, lead_type, status, project, created_at FROM leads WHERE contact_id=? AND id<>? AND deleted=0', lead.contact_id, lead.id),
    units: all(`SELECT un.id, un.project_id, p.name project, un.block, un.unit_no, un.status, un.hold_until, a.id allotment_id, a.allotment_no
      FROM units un JOIN projects p ON p.id=un.project_id LEFT JOIN allotments a ON a.unit_id=un.id AND a.status='active' WHERE un.lead_id=?`, lead.id),
    // the same person can already be on an admission journey, and the lead page says so instead of promoting twice
    student: eduStudentOf(req.user, lead.contact_id),
  })
})

app.patch('/api/leads/:id', (req, res) => {
  const lead = scopedLead(req.user, req.params.id)
  const lf = pick(req.body, LEAD_FIELDS.filter(f => !['source', 'campaign', 'adset', 'ad', 'form_id'].includes(f))) // M2.9 source is permanent
  const cf = pick(req.body, CONTACT_FIELDS)
  if (Object.keys(lf).length) run(`UPDATE leads SET ${Object.keys(lf).map(k => k + '=?')} WHERE id=?`, ...Object.values(lf), lead.id)
  if (Object.keys(cf).length) run(`UPDATE contacts SET ${Object.keys(cf).map(k => k + '=?')} WHERE id=?`, ...Object.values(cf), lead.contact_id)
  const before = Object.fromEntries(Object.keys({ ...lf, ...cf }).map(k => [k, lead[k]]))
  log(req, 'update', 'lead', lead.id, { before, after: { ...lf, ...cf } })
  rescore(lead.id)
  res.json({ ok: true })
})

function applyStatus(lead, status, actor, reason) {
  run(`UPDATE leads SET status=?, pending_status=NULL, pending_reason=NULL, pending_by=NULL, lost_reason=?, lost_at=? WHERE id=?`,
    status, reason || null, status === 'Lost' ? now() : null, lead.id)
  addActivity(lead.id, actor, 'system', `Status: ${lead.status} → ${status}${reason ? ` (${reason})` : ''}`)
  rescore(lead.id)
}
app.post('/api/leads/:id/status', (req, res) => {
  const lead = scopedLead(req.user, req.params.id)
  const { status, reason, note } = req.body
  if (!S('statuses').includes(status)) throw err(400, 'Unknown status')
  if (S('approval_statuses').includes(status)) {
    if (!S('lost_reasons').includes(reason)) throw err(400, 'Pick a reason')
    if (!note?.trim()) throw err(400, 'A note is required')
    const full = `${reason}: ${note.trim()}`
    if (!can(req.user, 'approve_lost')) {
      run('UPDATE leads SET pending_status=?, pending_reason=?, pending_by=? WHERE id=?', status, full, req.user.id, lead.id)
      addActivity(lead.id, req.user.id, 'system', `Requested ${status}: ${full}`)
      notifyTeamLeads(lead.agent_id, `${req.user.name} requests marking ${lead.name} as ${status}`, lead.id)
      log(req, 'request_status', 'lead', lead.id, { status, reason: full })
      return res.json({ pending: true })
    }
    applyStatus(lead, status, req.user.id, full)
  } else applyStatus(lead, status, req.user.id)
  log(req, 'status', 'lead', lead.id, { from: lead.status, to: status })
  res.json({ ok: true })
})
app.post('/api/leads/:id/approve', guard('approve_lost'), (req, res) => {
  const lead = scopedLead(req.user, req.params.id)
  if (!lead.pending_status) throw err(400, 'Nothing pending')
  if (req.body.approve) applyStatus(lead, lead.pending_status, req.user.id, lead.pending_reason)
  else {
    run('UPDATE leads SET pending_status=NULL, pending_reason=NULL, pending_by=NULL WHERE id=?', lead.id)
    addActivity(lead.id, req.user.id, 'system', `${lead.pending_status} request rejected${req.body.note ? ': ' + req.body.note : ''}`)
  }
  notify(lead.pending_by, `Your ${lead.pending_status} request for ${lead.name} was ${req.body.approve ? 'approved' : 'rejected'}`, lead.id)
  log(req, req.body.approve ? 'approve_status' : 'reject_status', 'lead', lead.id, { status: lead.pending_status })
  res.json({ ok: true })
})

app.post('/api/leads/:id/assign', guard('reassign'), (req, res) => {
  const lead = scopedLead(req.user, req.params.id)
  const reason = req.body.reason?.trim()
  if (!reason) throw err(400, 'Reason is required')
  const target = one(`SELECT * FROM users WHERE id=? AND active=1 AND role IN ('agent','team_lead')`, req.body.agent_id)
  if (!target) throw err(400, 'Pick an active agent')
  if (req.user.role === 'team_lead' && target.team_id !== req.user.team_id) throw err(403, 'You can only assign within your team')
  if (req.user.role === 'branch_manager' && target.branch_id !== req.user.branch_id) throw err(403, 'You can only assign within your branch')
  if (lead.status === 'Lost') run(`UPDATE leads SET status='New', lost_reason=NULL, lost_at=NULL, first_contact_at=NULL WHERE id=?`, lead.id) // recycle pool M1.12
  setAgent(lead.id, target.id, `By ${req.user.name}: ${reason}`, req.user.id)
  log(req, 'reassign', 'lead', lead.id, { from: lead.agent_id, to: target.id, reason })
  res.json({ ok: true })
})

app.post('/api/leads/:id/activities', (req, res) => {
  const lead = scopedLead(req.user, req.params.id)
  const b = req.body
  if (!S('activity_types').includes(b.type)) throw err(400, 'Unknown activity type')
  const closed = S('closed_statuses').includes(lead.status)
  if (!closed && b.type !== 'note' && !b.next_action_at) throw err(400, 'Set the next follow-up date (or close the lead)') // M4.6
  if (b.next_action_at && b.next_action_at < now()) throw err(400, 'Next follow-up must be in the future')
  addActivity(lead.id, req.user.id, b.type, b.notes, b)
  if (b.next_action_at) run('UPDATE leads SET next_action_at=? WHERE id=?', b.next_action_at, lead.id)
  if (lead.status === 'New' && CONTACT_TYPES.includes(b.type)) applyStatus(lead, b.outcome === 'Connected' || b.outcome === 'Interested' ? 'Contacted' : 'Not Reachable', req.user.id)
  rescore(lead.id)
  res.json({ ok: true })
})

app.post('/api/leads/:id/offers', (req, res) => {
  const lead = scopedLead(req.user, req.params.id)
  const amount = Math.round(+req.body.amount), by = req.body.by === 'Company' ? 'Company' : 'Client'
  if (!(amount > 0)) throw err(400, 'Offer amount is required')
  if (S('closed_statuses').includes(lead.status)) throw err(400, `Lead is ${lead.status}`)
  const unit = req.body.unit?.trim()
  addActivity(lead.id, req.user.id, 'offer', `${by} offer: PKR ${amount.toLocaleString('en-PK')}${unit ? ` for ${unit}` : ''}${req.body.notes?.trim() ? `. ${req.body.notes.trim()}` : ''}`, { amount })
  if (S('statuses').indexOf(lead.status) < S('statuses').indexOf('Negotiation')) applyStatus(lead, 'Negotiation', req.user.id)
  log(req, 'offer', 'lead', lead.id, { amount, by })
  res.json({ ok: true })
})

app.delete('/api/leads/:id', guard('delete'), (req, res) => {
  const lead = scopedLead(req.user, req.params.id)
  // A lead can only be deleted while it holds no money records: allotments and payments keep their lead_id,
  // and a deleted lead disappears from every list, so an allotted client would become untraceable.
  const allotment = one(`SELECT allotment_no FROM allotments WHERE lead_id=? AND status='active'`, lead.id)
  if (allotment) throw err(400, `This lead holds allotment ${allotment.allotment_no}. Cancel it first if the booking really was wrong.`)
  run('UPDATE leads SET deleted=1 WHERE id=?', lead.id) // M24.6 soft delete only
  log(req, 'delete', 'lead', lead.id, { status: lead.status })
  res.json({ ok: true })
})

// ---- site visits (M7) ----
const visitFor = (u, id) => {
  const v = one('SELECT * FROM visits WHERE id=?', id)
  if (!v) throw err(404, 'Visit not found')
  return { v, lead: scopedLead(u, v.lead_id) }
}
app.get('/api/visits', (req, res) => {
  const [w, p] = scope(req.user)
  const fbCutoff = new Date(Date.now() - S('visit_feedback_hours') * 3600e3).toISOString()
  res.json(all(`SELECT v.id, v.lead_id, v.site, v.scheduled_at, v.status, v.distance_m, v.verified_at, v.feedback IS NOT NULL has_feedback, v.agent_id,
      c.name, u.name agent_name,
      (v.status<>'verified' AND v.scheduled_at < ?) unverified,
      (v.status='verified' AND v.feedback IS NULL AND v.verified_at < ?) feedback_overdue
    FROM visits v JOIN leads l ON l.id=v.lead_id JOIN contacts c ON c.id=l.contact_id LEFT JOIN users u ON u.id=v.agent_id
    WHERE l.deleted=0 AND ${w} ORDER BY v.scheduled_at DESC LIMIT 200`, now(), fbCutoff, ...p))
})
app.post('/api/leads/:id/visits', (req, res) => {
  const lead = scopedLead(req.user, req.params.id)
  const site = S('sites').find(s => s.name === req.body.site)
  if (!site) throw err(400, 'Pick a site')
  if (!req.body.scheduled_at) throw err(400, 'Pick date and time')
  const id = run('INSERT INTO visits(lead_id,agent_id,site,scheduled_at,transport,created_at) VALUES(?,?,?,?,?,?)',
    lead.id, lead.agent_id, site.name, req.body.scheduled_at, req.body.transport ? 1 : 0, now()).lastInsertRowid
  addActivity(lead.id, req.user.id, 'system', `Site visit scheduled at ${site.name} for ${req.body.scheduled_at}`)
  run('UPDATE leads SET next_action_at=? WHERE id=?', req.body.scheduled_at, lead.id)
  if (S('statuses').indexOf(lead.status) < S('statuses').indexOf('Visit Scheduled')) applyStatus(lead, 'Visit Scheduled', req.user.id)
  sendSms(lead.phone, `Your visit to ${site.name} is confirmed for ${new Date(req.body.scheduled_at).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}.`)
  log(req, 'create', 'visit', id)
  res.json({ id })
})
app.post('/api/visits/:id/checkin', (req, res) => {
  const { v, lead } = visitFor(req.user, req.params.id)
  if (v.agent_id !== req.user.id) throw err(403, 'Only the assigned agent can check in')
  if (v.status === 'verified') throw err(400, 'Already verified')
  const site = S('sites').find(s => s.name === v.site)
  if (!site) throw err(400, `Site ${v.site} no longer exists in settings`)
  const { lat, lng } = req.body
  if (typeof lat !== 'number' || typeof lng !== 'number') throw err(400, 'Location required')
  const d = Math.round(L.distanceM(lat, lng, site.lat, site.lng))
  if (d > site.radius_m) throw err(400, `You are ${d} m from ${site.name}. Allowed radius: ${site.radius_m} m.`)
  const otp = String(crypto.randomInt(100000, 1000000))
  run(`UPDATE visits SET status='checked_in', otp=?, otp_attempts=0, distance_m=?, checked_in_at=? WHERE id=?`, otp, d, now(), v.id)
  sendSms(lead.phone, `Your visit verification code is ${otp}. Share it with your agent only at the site.`)
  log(req, 'visit_checkin', 'visit', v.id, { lat, lng, distance_m: d })
  res.json({ ok: true, distance_m: d })
})
app.post('/api/visits/:id/verify', (req, res) => {
  const { v, lead } = visitFor(req.user, req.params.id)
  if (v.status !== 'checked_in') throw err(400, 'Check in at the site first')
  if (v.otp_attempts >= 5) throw err(429, 'Too many wrong codes. Check in again to get a new code.')
  if (String(req.body.otp) !== v.otp) {
    run('UPDATE visits SET otp_attempts=otp_attempts+1 WHERE id=?', v.id)
    throw err(400, 'Wrong code')
  }
  run(`UPDATE visits SET status='verified', verified_at=?, otp=NULL WHERE id=?`, now(), v.id)
  addActivity(lead.id, req.user.id, 'site_visit', `Visit verified at ${v.site} (${v.distance_m} m, OTP)`)
  if (S('statuses').indexOf(lead.status) < S('statuses').indexOf('Visit Done')) applyStatus(lead, 'Visit Done', req.user.id)
  log(req, 'visit_verified', 'visit', v.id)
  res.json({ ok: true })
})
app.post('/api/visits/:id/feedback', (req, res) => {
  const { v, lead } = visitFor(req.user, req.params.id)
  const { interest, objections, units_shown, next_step, next_action_at } = req.body
  if (!interest || !next_step || !next_action_at) throw err(400, 'Interest, next step and follow-up date are required')
  run('UPDATE visits SET feedback=? WHERE id=?', JSON.stringify({ interest, objections, units_shown, next_step }), v.id)
  addActivity(lead.id, req.user.id, 'note', `Visit feedback: interest ${interest}. Objections: ${objections || '-'}. Shown: ${units_shown || '-'}. Next: ${next_step}`, { next_action: next_step, next_action_at })
  run('UPDATE leads SET next_action_at=? WHERE id=?', next_action_at, lead.id)
  res.json({ ok: true })
})

// ---- dashboard (M9) ----
app.get('/api/dashboard', (req, res) => {
  const q = req.query, u = req.user
  // The SPA sends calendar days picked in the business timezone; interpret them there, not as UTC days
  const TZ = '+05:00', dayStart = d => new Date(`${d}T00:00:00${TZ}`).toISOString(), dayEnd = d => new Date(`${d}T23:59:59.999${TZ}`).toISOString()
  const fromDay = q.from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
  const toDay = (q.to || now().slice(0, 10))
  const from = dayStart(fromDay), to = dayEnd(toDay)
  const [w, p] = scope(u)
  const where = [`l.deleted=0`, w, `l.created_at BETWEEN ? AND ?`], params = [...p, from, to]
  for (const [k, col] of [['source', 'l.source'], ['project', 'l.project'], ['agent_id', 'l.agent_id'], ['branch_id', 'l.branch_id'], ['team_id', 'u.team_id']])
    if (q[k]) { where.push(`${col}=?`); params.push(q[k]) }
  const W = `FROM leads l LEFT JOIN users u ON u.id=l.agent_id WHERE ${where.join(' AND ')}`
  const closed = closedJson()
  const staleCut = new Date(Date.now() - 72 * 3600e3).toISOString()

  const RESP = `avg((julianday(l.first_contact_at)-julianday(l.assigned_at))*1440) avg_response`
  // same-length window just before `from`, for period-over-period deltas
  const start = Date.parse(from), prevParams = [...params]
  prevParams.splice(p.length, 2, new Date(start - (Date.parse(to) - start) - 1).toISOString(), new Date(start - 1).toISOString())
  const prev = one(`SELECT count(*) leads, sum(l.status='Booked') booked, sum(l.first_contact_at IS NOT NULL) contacted,
      sum(NOT EXISTS(SELECT 1 FROM sla_breaches b WHERE b.lead_id=l.id)) within_sla, ${RESP} ${W}`, ...prevParams)
  const kpi = one(`SELECT count(*) leads, sum(l.status='Booked') booked, sum(l.first_contact_at IS NOT NULL) contacted, ${RESP},
      sum(NOT EXISTS(SELECT 1 FROM sla_breaches b WHERE b.lead_id=l.id)) within_sla,
      sum(l.status NOT IN (SELECT value FROM json_each(?)) AND COALESCE(l.last_activity_at,l.created_at) < ?) untouched_72h,
      sum(l.status NOT IN (SELECT value FROM json_each(?)) AND l.next_action_at < ?) overdue
    ${W}`, closed, staleCut, closed, now(), ...params)
  const visits = one(`SELECT count(*) total, sum(v.status='verified') verified FROM visits v JOIN leads l ON l.id=v.lead_id LEFT JOIN users u ON u.id=l.agent_id
    WHERE ${where.join(' AND ').replace('l.created_at BETWEEN', 'v.scheduled_at BETWEEN')} AND v.scheduled_at < ?`, ...params, now())
  const funnel = all(`SELECT l.status, count(*) n ${W} GROUP BY l.status`, ...params)
  const sources = all(`SELECT l.source, l.campaign, count(*) leads, sum(l.status='Booked') booked, sum(l.first_contact_at IS NOT NULL) contacted ${W} GROUP BY l.source, l.campaign ORDER BY leads DESC`, ...params)
  const lost = all(`SELECT substr(l.lost_reason,1,instr(l.lost_reason||':',':')-1) reason, count(*) n ${W} AND l.status IN ('Lost','Junk') GROUP BY reason ORDER BY n DESC`, ...params)
  const agents = all(`SELECT u.id, u.name, count(l.id) leads, sum(l.first_contact_at IS NOT NULL) contacted, sum(l.status='Booked') booked,
      sum(l.status NOT IN (SELECT value FROM json_each(?)) AND l.next_action_at < ?) overdue,
      (SELECT count(*) FROM sla_breaches b WHERE b.user_id=u.id AND b.level=1 AND b.created_at BETWEEN ? AND ?) breaches,
      (SELECT count(*) FROM activities a WHERE a.user_id=u.id AND a.type='call' AND a.created_at BETWEEN ? AND ?) calls,
      (SELECT count(*) FROM activities a WHERE a.user_id=u.id AND a.type='call' AND a.outcome='Connected' AND a.created_at BETWEEN ? AND ?) connected,
      (SELECT count(*) FROM visits v WHERE v.agent_id=u.id AND v.status='verified' AND v.scheduled_at BETWEEN ? AND ?) visits_verified,
      (SELECT count(*) FROM visits v WHERE v.agent_id=u.id AND v.status<>'verified' AND v.scheduled_at BETWEEN ? AND ? AND v.scheduled_at < ?) visits_unverified
    ${W} AND l.agent_id IS NOT NULL GROUP BY u.id ORDER BY booked DESC, contacted DESC`,
    closed, now(), from, to, from, to, from, to, from, to, from, to, now(), ...params)
  const daily = all(`SELECT date(l.created_at, '+5 hours') d, count(*) leads, sum(l.first_contact_at IS NOT NULL) contacted ${W} GROUP BY d ORDER BY d`, ...params)
  const resp = all(`SELECT l.agent_id, (julianday(l.first_contact_at)-julianday(l.assigned_at))*1440 m ${W} AND l.first_contact_at IS NOT NULL`, ...params)
  for (const a of agents) {
    const m = resp.filter(r => r.agent_id === a.id).map(r => r.m).sort((x, y) => x - y)
    a.avg_response_min = m.length ? Math.round(m.reduce((s, x) => s + x, 0) / m.length) : null
    a.median_response_min = m.length ? Math.round(m[Math.floor(m.length / 2)]) : null
  }
  const mine = all(`SELECT l.id, c.name, l.status, l.next_action_at, a.next_action FROM leads l JOIN contacts c ON c.id=l.contact_id
      LEFT JOIN activities a ON a.id=(SELECT max(id) FROM activities WHERE lead_id=l.id AND next_action_at IS NOT NULL)
    WHERE l.agent_id=? AND ${OPEN} AND (l.next_action_at < ? OR l.status='New') ORDER BY l.next_action_at LIMIT 30`,
    u.id, closed, new Date(Date.now() + 864e5).toISOString())
  res.json({ from: fromDay, to: toDay, kpi, prev, visits, funnel, sources, lost, agents, mine, daily })
})

// ---- notifications ----
app.get('/api/notifications', (req, res) => res.json({
  rows: all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id),
  unread: one('SELECT count(*) n FROM notifications WHERE user_id=? AND read=0', req.user.id).n,
}))
app.post('/api/notifications/read', (req, res) => { run('UPDATE notifications SET read=1 WHERE user_id=?', req.user.id); res.json({ ok: true }) })

// ---- users & org (M22) ----
const USER_FIELDS = ['name', 'email', 'phone', 'role', 'team_id', 'branch_id', 'max_open', 'available', 'commission_rate']
const checkRole = (f, actor) => {
  if (!('role' in f)) return
  if (!roles().some(r => r.key === f.role)) throw err(400, 'Unknown role')
  if (f.role === 'platform' && actor?.role !== 'platform') throw err(403, 'Only a platform owner can assign the platform role')
}
const checkRate = f => { if (f.commission_rate != null && !(+f.commission_rate >= 0 && +f.commission_rate <= 20)) throw err(400, 'Commission must be 0–20%') }
app.get('/api/users', guard('manage_users'), (_req, res) => res.json(all(`SELECT u.id, ${USER_FIELDS.map(f => 'u.' + f)}, u.active, u.totp_on,
  u.plan, u.trial_ends_at, u.paid_at, u.owner_id, u.modules,
  (SELECT count(*) FROM leads l WHERE l.agent_id=u.id AND ${OPEN}) open_leads FROM users u ORDER BY u.active DESC, u.name`, closedJson())))
app.post('/api/users', guard('manage_users'), (req, res) => {
  const f = pick(req.body, USER_FIELDS)
  checkRate(f); checkRole(f, req.user)
  const pass = typeof req.body.password === 'string' ? req.body.password : ''
  if (!f.name || !f.email || !f.role || !pass) throw err(400, 'Name, email, role and password are required')
  const problem = L.passwordProblem(pass)
  if (problem) throw err(400, problem)
  f.email = f.email.toLowerCase()
  planCap(req.user, 'users')
  const plan = req.body.plan ? pickPlan(req.body.plan) : null
  const owner = req.user.role === 'platform' ? null : req.user.owner_id ?? req.user.id
  const cols = [...Object.keys(f), 'pass', 'owner_id', 'created_at', ...(plan ? ['plan', 'trial_ends_at'] : [])]
  const id = run(`INSERT INTO users(${cols}) VALUES(${cols.map(() => '?')})`, ...Object.values(f), hash(pass), owner, now(),
    ...(plan ? [plan.id, trialEndsAt()] : [])).lastInsertRowid
  log(req, 'create', 'user', id, { ...f, plan: plan?.id })
  res.json({ id })
})
app.patch('/api/users/:id', guard('manage_users'), (req, res) => {
  const f = pick(req.body, USER_FIELDS)
  checkRate(f); checkRole(f, req.user)
  if (req.body.password) {
    const pass = typeof req.body.password === 'string' ? req.body.password : ''
    const problem = L.passwordProblem(pass)
    if (problem) throw err(400, problem)
    f.pass = hash(pass)
    run('DELETE FROM sessions WHERE user_id=?', req.params.id)
  }
  // Choosing a plan (at activation, or moving someone up or down) restarts their 7 days — unless an admin has marked it paid.
  if ('plan' in req.body) {
    const target = one('SELECT * FROM users WHERE id=?', req.params.id)
    if (!target) throw err(404, 'User not found')
    f.plan = req.body.plan ? pickPlan(req.body.plan).id : null
    if (f.plan && !target.paid_at) f.trial_ends_at = trialEndsAt()
  }
  if (Object.keys(f).length) run(`UPDATE users SET ${Object.keys(f).map(k => k + '=?')} WHERE id=?`, ...Object.values(f), req.params.id)
  log(req, 'update', 'user', +req.params.id, { ...f, pass: f.pass && '***' })
  res.json({ ok: true })
})
// Payment is still handled off the CRM (WhatsApp + bank transfer), so the admin says "this one is paid"
// and the trial lock stops applying. The plan stays as the record of what they are on.
const markPaid = (id, plan) => run('UPDATE users SET paid_at=?, trial_ends_at=NULL, plan=COALESCE(?,plan) WHERE id=?', now(), plan ?? null, id)
app.post('/api/users/:id/mark-paid', guard('manage_users'), (req, res) => {
  const target = one('SELECT * FROM users WHERE id=?', req.params.id)
  if (!target) throw err(404, 'User not found')
  markPaid(target.id)
  log(req, 'mark_paid', 'user', target.id, { plan: target.plan })
  res.json({ ok: true })
})

// ---- platform admin panel (role 'platform' only) ----
const platformOnly = (req, _res, next) => (req.user.role === 'platform' ? next() : next(err(403, 'Platform admins only')))

// Platform creates a brand-new company account (owner_id = NULL, active = 1, role = admin)
app.post('/api/platform/accounts', platformOnly, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const rawPhone = typeof req.body.phone === 'string' ? req.body.phone.trim() : ''
  const phone = rawPhone ? L.normalizePhone(rawPhone) : null
  if (!name) throw err(400, 'Name is required')
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err(400, 'Enter a valid email')
  if (rawPhone && !phone) throw err(400, 'Enter a valid phone number')
  if (one('SELECT 1 FROM users WHERE email=?', email)) throw err(400, 'An account with that email already exists')
  const plan = req.body.plan ? pickPlan(req.body.plan) : null
  const tempPass = crypto.randomBytes(16).toString('hex') + 'Aa1!'
  const cols = ['name', 'email', 'phone', 'role', 'active', 'available', 'pass', 'created_at', ...(plan ? ['plan', 'trial_ends_at'] : [])]
  const id = run(`INSERT INTO users(${cols}) VALUES(${cols.map(() => '?')})`,
    name, email, phone, 'admin', 1, 1, hash(tempPass), now(), ...(plan ? [plan.id, trialEndsAt()] : [])).lastInsertRowid
  const raw = crypto.randomBytes(32).toString('hex')
  run('INSERT INTO password_resets(token_hash,user_id,created_at) VALUES(?,?,?)',
    crypto.createHash('sha256').update(raw).digest('hex'), id, now())
  log(req, 'create_account', 'user', id, { email, plan: plan?.id })
  res.json({ id, token: raw })
})

// Main accounts (no owner) with the users added under them. Pre-hierarchy users have no owner, so they count as main accounts.
app.get('/api/platform/accounts', platformOnly, (_req, res) => {
  const us = all(`SELECT u.id, u.name, u.email, u.phone, u.role, u.active, u.plan, u.trial_ends_at, u.paid_at, u.totp_on, u.owner_id, u.modules, u.created_at,
    (SELECT count(*) FROM leads l WHERE l.agent_id=u.id AND ${OPEN}) open_leads FROM users u WHERE u.role!='platform' ORDER BY u.active DESC, u.name`, closedJson())
  const mains = us.filter(u => u.owner_id == null)
  res.json(mains.map(m => ({
    ...m,
    subs: us.filter(u => u.owner_id === m.id),
    open_leads: us.filter(u => u.id === m.id || u.owner_id === m.id).reduce((s, u) => s + (u.open_leads || 0), 0),
  })))
})
// Which product modules a company can use. Set on its main account so everyone under it inherits the same
// navigation; who inside the company actually sees Edu is then the permission matrix's job.
app.post('/api/platform/accounts/:id/modules', platformOnly, (req, res) => {
  const acct = one('SELECT id, name, owner_id, modules FROM users WHERE id=?', +req.params.id)
  if (!acct) throw err(404, 'Account not found')
  if (acct.owner_id != null) throw err(400, 'Modules are switched on the main account, not on a user added under it')
  if (!Array.isArray(req.body.modules)) throw err(400, 'Send the modules as a list')
  const unknown = req.body.modules.filter(m => !MODULE_IDS.includes(m))
  if (unknown.length) throw err(400, `Unknown module ${unknown.join(', ')}. Choose from ${MODULE_IDS.join(', ')}`)
  // the base CRM is never switched off, whatever the console sends: whole sections of the app key off it
  const list = [...new Set(['property', ...req.body.modules])]
  run('UPDATE users SET modules=? WHERE id=?', JSON.stringify(list), acct.id)
  for (const u of all("SELECT id FROM users WHERE (id=? OR owner_id=?) AND role='admin' AND active=1", acct.id, acct.id))
    notify(u.id, list.includes('edu') ? 'The Student Consultancy module is now enabled for your account.' : 'The Student Consultancy module was disabled for your account.', null)
  log(req, 'modules', 'user', acct.id, { modules: list })
  res.json({ id: acct.id, modules: list })
})

// Company admins can toggle modules for their own workspace directly from Settings › Company modules
app.post('/api/company/modules', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'platform') throw err(403, 'Only company administrators can configure modules')
  if (!Array.isArray(req.body.modules)) throw err(400, 'Send the modules as a list')
  const unknown = req.body.modules.filter(m => !MODULE_IDS.includes(m))
  if (unknown.length) throw err(400, `Unknown module ${unknown.join(', ')}`)
  const list = [...new Set(['property', ...req.body.modules.filter(m => MODULE_IDS.includes(m))])]

  const targetId = req.user.owner_id ?? req.user.id
  run('UPDATE users SET modules=? WHERE id=? OR owner_id=?', JSON.stringify(list), targetId, targetId)
  log(req, 'modules', 'company', targetId, { modules: list })
  res.json({ ok: true, modules: list })
})
app.get('/api/platform/dashboard', platformOnly, (_req, res) => {
  const mains = all("SELECT * FROM users WHERE role!='platform' AND owner_id IS NULL"), t = now(), soon = new Date(Date.now() + 3 * 864e5).toISOString()
  const trial = mains.filter(u => !u.paid_at && u.trial_ends_at && u.trial_ends_at >= t)
  const paid = mains.filter(u => u.paid_at)
  const week = new Date(Date.now() - 7 * 864e5).toISOString()
  const subs = id => mains.find(m => m.id === id) ? all('SELECT id FROM users WHERE owner_id=?', id).length : 0
  const counts = one("SELECT sum(status='pending') pending, sum(status='approved') approved, sum(status='rejected') rejected FROM payment_requests")
  const pending = all(`SELECT r.*, u.name user_name, u.email user_email FROM payment_requests r LEFT JOIN users u ON u.id=r.user_id
    WHERE r.status='pending' ORDER BY r.id DESC LIMIT 5`)
  res.json({
    accounts: mains.length, in_trial: trial.length, expiring_soon: trial.filter(u => u.trial_ends_at <= soon).length, paid: paid.length,
    inactive: mains.filter(u => !u.active).length,
    // a trial that ran out without anyone marking it paid: the account cannot sign in, so it is work to do
    locked_out: mains.filter(u => !u.paid_at && u.trial_ends_at && u.trial_ends_at < t).length,
    new_this_week: mains.filter(u => u.created_at >= week).length,
    with_edu: mains.filter(u => parseModules(u.modules).includes('edu')).length,
    sub_users: one("SELECT count(*) n FROM users WHERE role!='platform' AND owner_id IS NOT NULL").n,
    revenue: PLANS.map(p => { const n = paid.filter(u => u.plan === p.id).length; return { plan: p.id, name: p.name, count: n, monthly: n * p.monthly } }),
    monthly_revenue: paid.reduce((s, u) => s + (planOf(u.plan)?.monthly || 0), 0),
    requests: {
      pending: counts.pending || 0, approved: counts.approved || 0, rejected: counts.rejected || 0,
      pending_amount: pending.reduce((s, r) => s + (planOf(r.plan)?.monthly || r.amount || 0), 0),
      latest: pending,
    },
    recent: mains.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 8)
      .map(u => ({ id: u.id, name: u.name, email: u.email, plan: u.plan, active: u.active, created_at: u.created_at,
        trial_ends_at: u.trial_ends_at, paid_at: u.paid_at, modules: parseModules(u.modules), subs: subs(u.id) })),
  })
})
// A main account reports an off-platform payment (bank transfer etc.); the platform approves or rejects it.
app.post('/api/payment-requests', (req, res) => {
  if (req.user.role === 'platform') throw err(403, 'Platform admins have no account to pay for')
  const plan = pickPlan(req.body.plan)
  const txt = (k, max) => { const v = typeof req.body[k] === 'string' ? req.body[k].trim() : ''; if (v.length > max) throw err(400, `${k} is too long`); return v || null }
  const method = txt('method', 80), reference = txt('reference', 200), note = txt('note', 500)
  if (!method) throw err(400, 'Say how you paid')
  const uid = req.user.owner_id ?? req.user.id
  const id = run('INSERT INTO payment_requests(user_id,plan,amount,method,reference,note,created_at) VALUES(?,?,?,?,?,?,?)', uid, plan.id, plan.monthly, method, reference, note, now()).lastInsertRowid
  for (const a of all("SELECT id FROM users WHERE role='platform' AND active=1")) notify(a.id, `Payment submitted by ${req.user.name} for ${plan.name}`, null)
  log(req, 'payment_request', 'payment_request', id, { plan: plan.id })
  res.json({ id })
})
app.get('/api/platform/payment-requests', platformOnly, (_req, res) => res.json(all(`SELECT r.*, u.name user_name, u.email user_email FROM payment_requests r
  LEFT JOIN users u ON u.id=r.user_id ORDER BY (r.status='pending') DESC, r.id DESC LIMIT 300`)))
const decide = status => (req, res) => {
  const r = one('SELECT * FROM payment_requests WHERE id=?', req.params.id)
  if (!r) throw err(404, 'Request not found')
  if (r.status !== 'pending') throw err(400, `Already ${r.status}`)
  run('UPDATE payment_requests SET status=?, decided_at=? WHERE id=?', status, now(), r.id)
  if (status === 'approved') markPaid(r.user_id, r.plan)
  notify(r.user_id, status === 'approved' ? 'Your payment was approved. Thank you!' : 'Your payment request was rejected. Please contact support.', null)
  log(req, status, 'payment_request', r.id, { user_id: r.user_id, plan: r.plan })
  res.json({ ok: true })
}
app.post('/api/platform/payment-requests/:id/approve', platformOnly, decide('approved'))
app.post('/api/platform/payment-requests/:id/reject', platformOnly, decide('rejected'))
// Payment methods and invoice details live in the settings table like everything else configurable
const INVOICE_KEYS = ['business_name', 'address', 'phone', 'footer']
const platformSettings = () => ({ payment_methods: S('payment_methods') || [], invoice_details: { ...Object.fromEntries(INVOICE_KEYS.map(k => [k, ''])), ...S('invoice_details') } })
app.get('/api/platform/settings', platformOnly, (_req, res) => res.json(platformSettings()))
app.put('/api/platform/settings', platformOnly, (req, res) => {
  const { payment_methods: pm, invoice_details: inv } = req.body
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  if (pm !== undefined) {
    if (!Array.isArray(pm) || pm.length > 20) throw err(400, 'Payment methods must be a list of up to 20')
    putSetting('payment_methods', pm.map(m => ({ label: str(m?.label, 80), details: str(m?.details, 500) })).filter(m => m.label))
  }
  if (inv !== undefined) {
    if (!inv || typeof inv !== 'object') throw err(400, 'Invoice details must be an object')
    putSetting('invoice_details', Object.fromEntries(INVOICE_KEYS.map(k => [k, str(inv[k], 500)])))
  }
  log(req, 'platform_settings', 'setting', null)
  res.json(platformSettings())
})
app.get('/api/payment-methods', (_req, res) => res.json(S('payment_methods') || []))
// VACUUM INTO writes a consistent copy of a local database file; a remote (Turso) database is backed up on its own platform.
app.get('/api/platform/backup', platformOnly, (req, res) => {
  if (remote) throw err(501, 'This database is hosted remotely: take backups from the database provider')
  const tmp = path.join(os.tmpdir(), `crm-backup-${crypto.randomBytes(6).toString('hex')}.db`)
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)
    const data = fs.readFileSync(tmp)
    log(req, 'backup', 'database', null)
    res.set('content-disposition', `attachment; filename="crm-backup-${now().slice(0, 10)}.db"`).type('application/octet-stream').send(data)
  } finally { fs.rmSync(tmp, { force: true }) }
})
// ---- per-workspace backup and restore ----
// A workspace owns its team and everything those people touched, so that is what a bundle carries.
// Projects, units, the university catalogue and settings are not partitioned per company in the schema,
// so they stay out: restoring one company's file can never overwrite another company's inventory.
// The audit log is append-only by trigger, so it is neither exported nor deleted on restore.
const WS_KIND = 'estate-centric-workspace'
const marks = n => Array.from({ length: n }, () => '?').join(',')
// column names here always come from this file, never from the request. No ORDER BY: targets and
// allotment_docs have no id column, and every row carries its own key on the way back in
const pick_by = (table, pairs) => {
  const parts = [], params = []
  for (const [col, ids] of pairs) {
    if (!ids.length) continue
    parts.push(`${col} IN (${marks(ids.length)})`); params.push(...ids)
  }
  return parts.length ? all(`SELECT * FROM ${table} WHERE ${parts.join(' OR ')}`, ...params) : []
}
const ids_of = rows => rows.map(r => r.id).filter(x => x != null)
const uniq = list => [...new Set(list)]

function workspaceRows(mainId) {
  const main = one('SELECT * FROM users WHERE id=? AND owner_id IS NULL', mainId)
  if (!main) throw err(404, 'Workspace not found')
  const users = all('SELECT * FROM users WHERE id=? OR owner_id=? ORDER BY id', mainId, mainId)
  const uid = ids_of(users)
  const leads = pick_by('leads', [['agent_id', uid]])
  const lid = ids_of(leads)
  const students = pick_by('edu_students', [['counselor_id', uid]])
  const sid = ids_of(students)
  const cid = uniq([...leads.map(l => l.contact_id), ...students.map(s => s.contact_id)].filter(x => x != null))
  const properties = pick_by('properties', [['agent_id', uid], ['created_by', uid], ['owner_contact_id', cid]])
  // attribution only: a shared property or contact belongs to whoever entered it, not to every company that touches it
  const leases = pick_by('leases', [['created_by', uid], ['tenant_contact_id', cid]])
  const leaseId = ids_of(leases)
  const allotments = pick_by('allotments', [['created_by', uid], ['agent_id', uid], ['lead_id', lid]])
  const aid = ids_of(allotments)
  const listings = pick_by('listings', [['agent_id', uid], ['created_by', uid], ['owner_lead_id', lid]])
  // media rows are the only real BLOBs; files on leads, allotments and students live in their own tables as text
  const listingMedia = all(`SELECT id FROM media WHERE entity='listing' AND entity_id IN (${marks(ids_of(listings).length || 1)})`,
    ...(ids_of(listings).length ? ids_of(listings) : [0])).map(r => r.id)
  const media = pick_by('media', [['created_by', uid], ['id', listingMedia]])
  const data = {
    users,
    // an account's own pending links belong to it: they reference users(id), so they leave and come back with it
    email_verifications: pick_by('email_verifications', [['user_id', uid]]),
    contacts: pick_by('contacts', [['id', cid]]),
    leads,
    activities: pick_by('activities', [['lead_id', lid]]),
    visits: pick_by('visits', [['lead_id', lid]]),
    sla_breaches: pick_by('sla_breaches', [['lead_id', lid], ['user_id', uid]]),
    notifications: pick_by('notifications', [['user_id', uid]]),
    targets: pick_by('targets', [['user_id', uid]]),
    export_requests: pick_by('export_requests', [['user_id', uid], ['decided_by', uid]]),
    unit_history: pick_by('unit_history', [['lead_id', lid], ['user_id', uid]]),
    allotments,
    installments: pick_by('installments', [['allotment_id', aid]]),
    payments: pick_by('payments', [['allotment_id', aid], ['lead_id', lid], ['created_by', uid]]),
    commissions: pick_by('commissions', [['allotment_id', aid], ['user_id', uid], ['paid_by', uid]]),
    allotment_docs: pick_by('allotment_docs', [['allotment_id', aid]]),
    listings,
    properties,
    leases,
    rent_payments: pick_by('rent_payments', [['lease_id', leaseId], ['created_by', uid]]),
    maintenance: pick_by('maintenance', [['created_by', uid]]),
    owner_payouts: pick_by('owner_payouts', [['created_by', uid]]),
    edu_students: students,
    edu_documents: pick_by('edu_documents', [['student_id', sid], ['uploaded_by', uid]]),
    edu_activities: pick_by('edu_activities', [['student_id', sid]]),
    edu_applications: pick_by('edu_applications', [['student_id', sid], ['created_by', uid]]),
    edu_payments: pick_by('edu_payments', [['student_id', sid], ['created_by', uid]]),
    edu_commissions: pick_by('edu_commissions', [['student_id', sid], ['user_id', uid], ['created_by', uid]]),
    media,
  }
  return { main, data }
}
// media holds real BLOBs, which JSON cannot carry: they travel as base64 and are marked so the
// restore knows to hand the bytes back to the driver rather than a string
const encodeBlobs = data => ({
  ...data,
  media: data.media.map(m => ({ ...m, data: m.data == null ? null : Buffer.from(m.data).toString('base64'), data_b64: m.data != null })),
})
function decodeBlobs(rows) {
  return rows.map(r => {
    if (r.data_b64 !== true || typeof r.data !== 'string') return r
    const { data_b64, ...rest } = r
    return { ...rest, data: new Uint8Array(Buffer.from(r.data, 'base64')) }
  })
}
// children first: the same order the restore re-inserts in is parents first
const WS_ORDER = ['users', 'email_verifications', 'contacts', 'leads', 'activities', 'visits', 'sla_breaches', 'notifications', 'targets', 'export_requests',
  'unit_history', 'allotments', 'installments', 'payments', 'commissions', 'allotment_docs', 'listings', 'properties', 'leases',
  'rent_payments', 'maintenance', 'owner_payouts', 'edu_students', 'edu_documents', 'edu_activities', 'edu_applications',
  'edu_payments', 'edu_commissions', 'media']
const WS_DELETE_ORDER = [...WS_ORDER].reverse()

app.get('/api/platform/accounts/:id/backup', platformOnly, (req, res) => {
  const { main, data } = workspaceRows(+req.params.id)
  const counts = Object.fromEntries(WS_ORDER.map(k => [k, (data[k] || []).length]))
  log(req, 'backup', 'workspace', main.id, counts)
  res.set('content-disposition', `attachment; filename="workspace-${main.id}-${String(main.email).split('@')[0]}-${now().slice(0, 10)}.json"`)
    .type('application/json')
    .send(JSON.stringify({ kind: WS_KIND, version: 1, generated_at: now(),
      account: { id: main.id, name: main.name, email: main.email, plan: main.plan, modules: parseModules(main.modules) },
      counts, data: encodeBlobs(data) }))
})

// Restore replaces the workspace's own rows with the file's. The account id must match, the email must be
// typed back, and the current state is read first so a failed insert leaves the caller the numbers to check.
app.post('/api/platform/accounts/:id/restore', platformOnly, (req, res) => {
  const id = +req.params.id
  const bundle = req.body.bundle
  if (!bundle || bundle.kind !== WS_KIND) throw err(400, `This is not a workspace backup file (expected ${WS_KIND})`)
  if (bundle.account?.id !== id) throw err(400, `That file belongs to workspace ${bundle.account?.id}, not ${id}`)
  const email = typeof req.body.confirm === 'string' ? req.body.confirm.trim().toLowerCase() : ''
  if (email !== String(bundle.account.email).toLowerCase()) throw err(400, 'Type the account email exactly to confirm the restore')
  const { main } = workspaceRows(id)
  if (email !== String(main.email).toLowerCase()) throw err(400, 'The file and the workspace no longer match on email')
  const data = bundle.data
  if (!data || !Array.isArray(data.users)) throw err(400, 'The backup file has no team rows in it')
  const tables = Object.keys(data).filter(k => WS_ORDER.includes(k))
  const unknown = Object.keys(data).filter(k => !WS_ORDER.includes(k))
  if (unknown.length) throw err(400, `This build cannot restore ${unknown.join(', ')}`)
  const rows = { ...data, media: decodeBlobs(data.media || []) }
  // wipe what the workspace holds *now*, not the ids in the file: rows created since the backup would
  // otherwise survive a restore and sit next to the older copies of the same people
  const current = workspaceRows(id).data
  // one phone entered by two companies is one contact row, so a contact another workspace still points
  // at stays behind even though this workspace's copy of it is being replaced
  const stillReferenced = (table, col, ids, keep) => !ids.length ? []
    : all(`SELECT DISTINCT ${col} id FROM ${table} WHERE ${col} IN (${marks(ids.length)})${keep.length ? ` AND id NOT IN (${marks(keep.length)})` : ''}`, ...ids, ...keep).map(r => r.id)
  const contactIds = ids_of(current.contacts)
  const sharedContacts = new Set([
    ...stillReferenced('leads', 'contact_id', contactIds, ids_of(current.leads)),
    ...stillReferenced('edu_students', 'contact_id', contactIds, ids_of(current.edu_students)),
  ])
  const wipe = (table, list) => {
    let idc = ids_of(list)
    if (table === 'contacts') idc = idc.filter(x => !sharedContacts.has(x))
    if (!idc.length) return
    if (table === 'allotment_docs') return run(`DELETE FROM allotment_docs WHERE allotment_id IN (${marks(idc.length)})`, ...idc)
    if (table === 'targets') return run(`DELETE FROM targets WHERE user_id IN (${marks(idc.length)})`, ...idc)
    run(`DELETE FROM ${table} WHERE id IN (${marks(idc.length)})`, ...idc)
  }
  const uid = ids_of(current.users)
  const keep = { contacts: sharedContacts }
  const restored = tx(() => {
    // another company can still point at these people (an agent assigned a lead across the room); SQLite
    // refuses the delete, so unassign them first the same way deleting a user does
    if (uid.length) {
      const m = marks(uid.length)
      run(`UPDATE leads SET agent_id=NULL WHERE agent_id IN (${m})`, ...uid)
      run(`UPDATE edu_students SET counselor_id=NULL WHERE counselor_id IN (${m})`, ...uid)
      run(`UPDATE edu_commissions SET user_id=NULL WHERE user_id IN (${m})`, ...uid)
    }
    for (const table of WS_DELETE_ORDER) {
      if (!tables.includes(table)) continue
      wipe(table, table === 'allotment_docs' ? current.allotments : table === 'targets' ? current.users : current[table] || [])
    }
    for (const table of WS_ORDER) {
      if (!tables.includes(table)) continue
      for (const r of rows[table] || []) {
        if (keep[table]?.has(r.id)) continue
        insert(table, Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)))
      }
    }
    return Object.fromEntries(WS_ORDER.filter(k => tables.includes(k))
      .map(k => [k, (rows[k] || []).filter(r => !keep[k]?.has(r.id)).length]))
  })()
  if (uid.length) run(`DELETE FROM sessions WHERE user_id IN (${marks(uid.length)})`, ...uid)
  log(req, 'restore', 'workspace', id, restored)
  res.json({ ok: true, restored, generated_at: bundle.generated_at })
})
// Platform deletes an entire company account / tenant workspace and all its users
app.delete('/api/platform/accounts/:id', platformOnly, (req, res) => {
  const id = +req.params.id
  if (id === req.user.id) throw err(400, 'You cannot delete yourself')
  const target = one('SELECT * FROM users WHERE id=?', id)
  if (!target) throw err(404, 'Account not found')

  // Find all sub-users under this tenant
  const userIds = all('SELECT id FROM users WHERE id=? OR owner_id=?', id, id).map(u => u.id)
  const qMarks = userIds.map(() => '?').join(',')

  // Clean up sessions & reset tokens
  db.exec(`DELETE FROM sessions WHERE user_id IN (${userIds.join(',')})`)
  db.exec(`DELETE FROM password_resets WHERE user_id IN (${userIds.join(',')})`)
  db.exec(`DELETE FROM email_verifications WHERE user_id IN (${userIds.join(',')})`)

  // Unassign or nullify references from leads, students, etc.
  db.exec(`UPDATE leads SET agent_id=NULL WHERE agent_id IN (${userIds.join(',')})`)
  db.exec(`UPDATE edu_students SET counselor_id=NULL WHERE counselor_id IN (${userIds.join(',')})`)

  // Delete all users under this tenant
  db.exec(`DELETE FROM users WHERE id IN (${userIds.join(',')})`)

  log(req, 'delete_account', 'user', id, { name: target.name, email: target.email, deleted_users_count: userIds.length })
  res.json({ ok: true, deleted_count: userIds.length })
})

// Delete a single user under the company
app.delete('/api/users/:id', guard('manage_users'), (req, res) => {
  const id = +req.params.id
  if (id === req.user.id) throw err(400, 'You cannot delete yourself')
  const target = one('SELECT * FROM users WHERE id=?', id)
  if (!target) throw err(404, 'User not found')

  // Normal company admins cannot delete other companies' users
  if (req.user.role !== 'platform') {
    const owner = req.user.owner_id ?? req.user.id
    if (target.id !== owner && target.owner_id !== owner) throw err(403, 'Permission denied')
    if (target.owner_id == null && target.id === owner) throw err(400, 'Cannot delete the workspace owner account')
  }

  // Clean up sessions, tokens, lead assignments
  run('DELETE FROM sessions WHERE user_id=?', id)
  run('DELETE FROM password_resets WHERE user_id=?', id)
  run('DELETE FROM email_verifications WHERE user_id=?', id)
  run('UPDATE leads SET agent_id=NULL WHERE agent_id=?', id)
  run('UPDATE edu_students SET counselor_id=NULL WHERE counselor_id=?', id)
  run('DELETE FROM users WHERE id=?', id)

  log(req, 'delete', 'user', id, { name: target.name, email: target.email })
  res.json({ ok: true })
})

// M3.7 / M22.7: offboarding — deactivate, kill sessions, redistribute open leads
app.post('/api/users/:id/deactivate', guard('manage_users'), (req, res) => {
  const id = +req.params.id
  if (id === req.user.id) throw err(400, 'You cannot deactivate yourself')
  run('UPDATE users SET active=0, available=0 WHERE id=?', id)
  run('DELETE FROM sessions WHERE user_id=?', id)
  const open = all(`SELECT l.id FROM leads l WHERE l.agent_id=? AND ${OPEN}`, id, closedJson())
  const moved = open.filter(l => autoAssign(l.id, { exclude: id, reason: 'Previous agent offboarded.' })).length
  log(req, 'deactivate', 'user', id, { open: open.length, reassigned: moved })
  res.json({ open: open.length, reassigned: moved })
})
app.post('/api/users/:id/activate', guard('manage_users'), (req, res) => {
  const target = one('SELECT * FROM users WHERE id=?', req.params.id)
  if (!target) throw err(404, 'User not found')
  // bringing someone back uses up a seat on the admin's plan too (activating an active account adds nothing)
  if (!target.active) planCap(req.user, 'users')
  run('UPDATE users SET active=1, available=1 WHERE id=?', req.params.id)
  log(req, 'activate', 'user', +req.params.id)
  res.json({ ok: true })
})
app.post('/api/branches', guard('manage_users'), (req, res) => {
  if (!req.body.name) throw err(400, 'Name required')
  planCap(req.user, 'branches')
  res.json({ id: run('INSERT INTO branches(name,city) VALUES(?,?)', req.body.name, req.body.city ?? null).lastInsertRowid })
})
app.post('/api/teams', guard('manage_users'), (req, res) => {
  if (!req.body.name) throw err(400, 'Name required')
  res.json({ id: run('INSERT INTO teams(name,branch_id) VALUES(?,?)', req.body.name, req.body.branch_id || null).lastInsertRowid })
})

// ---- settings & audit ----
app.get('/api/settings', guard('settings'), (_req, res) => res.json(Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, S(k)]))))
app.put('/api/settings/:key', guard('settings'), (req, res) => {
  const k = req.params.key
  if (!(k in DEFAULTS)) throw err(400, 'Unknown setting')
  if (k === 'permissions' && req.user.role !== 'admin') throw err(403, 'Only admins can change permissions')
  const v = req.body.value
  if (k === 'permissions') {
    const keys = roles().map(r => r.key)
    if (!v || typeof v !== 'object' || Object.values(v).some(list => !Array.isArray(list) || list.some(r => !keys.includes(r)))) throw err(400, 'Each permission needs a list of known roles')
    if (!['settings', 'manage_users'].every(p => v[p]?.includes('admin'))) throw err(400, 'Admins must keep Settings and Manage users, or nobody could undo this')
  }
  if (v === null || typeof v !== typeof DEFAULTS[k] || Array.isArray(v) !== Array.isArray(DEFAULTS[k])) throw err(400, `Expected ${Array.isArray(DEFAULTS[k]) ? 'a list' : typeof DEFAULTS[k]}`)
  log(req, 'setting', 'setting', null, { key: k, before: S(k), after: v })
  run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(v))
  res.json({ ok: true })
})
app.get('/api/audit', guard('audit'), (req, res) => res.json(all(`SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id
  WHERE (? IS NULL OR a.entity=?) AND (? IS NULL OR a.user_id=?) ORDER BY a.id DESC LIMIT 300`,
  req.query.entity || null, req.query.entity || null, req.query.user_id || null, req.query.user_id || null)))

// ---- projects & inventory (M10) ----
const UNIT_FIELDS = ['phase', 'block', 'street', 'unit_no', 'unit_type', 'category', 'size', 'uom', 'dimensions', 'facing', 'features', 'premiums', 'map_ref']
const UOMS = ['marla', 'kanal', 'sqft', 'sqyd']
const parseUnit = u => ({ ...u, premiums: JSON.parse(u.premiums || '[]') })
function projectRow(id) {
  const row = one('SELECT * FROM projects WHERE id=?', id)
  if (!row) throw err(404, 'Project not found')
  const { map_svg, ...p } = row // the map is megabytes: served on its own route
  return { ...p, has_map: !!map_svg, premiums: JSON.parse(p.premiums) }
}
function pricedUnits(p, where = '1=1', ...params) {
  const lists = all('SELECT * FROM price_lists WHERE project_id=?', p.id), today = now()
  return all(`SELECT un.*, u.name hold_name, c.name lead_name FROM units un LEFT JOIN users u ON u.id=un.hold_by
      LEFT JOIN leads l ON l.id=un.lead_id LEFT JOIN contacts c ON c.id=l.contact_id
    WHERE un.project_id=? AND ${where} ORDER BY un.phase, un.block, un.street, CAST(un.unit_no AS INTEGER), un.unit_no`, p.id, ...params)
    .map(parseUnit).map(un => ({ ...un, price: L.unitPrice(un, L.currentRate(lists, un, today), p.premiums, p.marla_sqft) }))
}
function unitHistory(unitId, userId, from, to, leadId, note) {
  run('INSERT INTO unit_history(unit_id,user_id,from_status,to_status,lead_id,note,created_at) VALUES(?,?,?,?,?,?,?)', unitId, userId ?? null, from, to, leadId ?? null, note ?? null, now())
}
const unitLabel = un => [un.phase, un.block, un.street].filter(Boolean).join(' / ') + ' #' + un.unit_no

app.get('/api/projects', (_req, res) => res.json(all(`SELECT p.id, p.name, p.city, p.kind, p.marla_sqft,
    (SELECT json_group_object(status, n) FROM (SELECT status, count(*) n FROM units WHERE project_id=p.id GROUP BY status)) counts
  FROM projects p ORDER BY p.name`).map(p => ({ ...p, counts: JSON.parse(p.counts || '{}') }))))

function projectInput(b) {
  const f = pick(b, ['name', 'city', 'kind', 'marla_sqft', 'premiums', 'hold_hours', 'notes'])
  if (f.kind && !['land', 'building'].includes(f.kind)) throw err(400, 'Kind must be land or building')
  if (f.marla_sqft != null && !(+f.marla_sqft > 0)) throw err(400, 'Marla size must be positive')
  if (f.hold_hours != null && !(+f.hold_hours > 0)) throw err(400, 'Hold hours must be positive')
  if (f.premiums) for (const x of JSON.parse(f.premiums)) if (!x.name || !['pct', 'fixed'].includes(x.type) || !(x.value >= 0)) throw err(400, 'Each premium needs a name, type pct|fixed and a value')
  return f
}
app.post('/api/projects', guard('manage_inventory'), (req, res) => {
  const f = projectInput(req.body)
  if (!f.name?.trim()) throw err(400, 'Name is required')
  if (one('SELECT 1 FROM projects WHERE name=?', f.name.trim())) throw err(400, 'A project with this name exists')
  f.name = f.name.trim()
  planCap(req.user, 'projects')
  const cols = [...Object.keys(f), 'created_at']
  const id = run(`INSERT INTO projects(${cols}) VALUES(${cols.map(() => '?')})`, ...Object.values(f), now()).lastInsertRowid
  log(req, 'create', 'project', id, f)
  res.json({ id })
})
app.patch('/api/projects/:id', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id), f = projectInput(req.body)
  if ('name' in f) {
    f.name = String(f.name ?? '').trim()
    if (!f.name) throw err(400, 'Name is required')
    if (one('SELECT 1 FROM projects WHERE name=? AND id<>?', f.name, p.id)) throw err(400, 'A project with this name exists')
  }
  if (Object.keys(f).length) run(`UPDATE projects SET ${Object.keys(f).map(k => k + '=?')} WHERE id=?`, ...Object.values(f), p.id)
  log(req, 'update', 'project', p.id, f)
  res.json({ ok: true })
})
// Deletes the project with its units, prices, holds and allotments; the audit row keeps a copy of all of it
app.delete('/api/projects/:id', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id)
  if (req.body?.confirm !== p.name) throw err(400, 'Type the project name to confirm')
  const units = all('SELECT * FROM units WHERE project_id=?', p.id)
  const snapshot = { project: p, units, prices: all('SELECT * FROM price_lists WHERE project_id=?', p.id), allotments: all('SELECT * FROM allotments WHERE project_id=?', p.id) }
  tx(() => {
    run('DELETE FROM unit_history WHERE unit_id IN (SELECT id FROM units WHERE project_id=?)', p.id)
    for (const t of ['allotments', 'price_lists', 'units']) run(`DELETE FROM ${t} WHERE project_id=?`, p.id)
    run('DELETE FROM projects WHERE id=?', p.id)
  })()
  log(req, 'delete', 'project', p.id, snapshot)
  res.json({ ok: true })
})
app.get('/api/projects/:id', (req, res) => {
  const p = projectRow(req.params.id)
  res.json({ project: p, units: pricedUnits(p), prices: all('SELECT pl.*, u.name created_by_name FROM price_lists pl LEFT JOIN users u ON u.id=pl.created_by WHERE project_id=? ORDER BY effective_from DESC, id DESC', p.id) })
})

// Plot map: an SVG whose <g id="plots"> paths are linked to units through units.map_ref
app.get('/api/projects/:id/map', (req, res) => {
  const m = one('SELECT map_svg FROM projects WHERE id=?', req.params.id)?.map_svg
  if (!m) throw err(404, 'No map for this project')
  sendSvg(res, m)
})
app.put('/api/projects/:id/map', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id), svg = req.body.svg
  if (typeof svg !== 'string' || !/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg) || !svg.includes('id="plots"')) throw err(400, 'Upload an SVG with a <g id="plots"> group')
  if (svg.length > 8e6) throw err(400, 'Map SVG is too large (max 8 MB)')
  tx(() => {
    run('UPDATE projects SET map_svg=? WHERE id=?', svg, p.id)
    run('UPDATE units SET map_ref=NULL WHERE project_id=?', p.id) // plot ids belong to the old map
  })()
  log(req, 'upload_map', 'project', p.id, { bytes: svg.length })
  res.json({ ok: true })
})

// Plots missing from an uploaded map (e.g. commercial plots that were never traced) are drawn in the app and added to <g id="plots">
const KIND_COLOR = { Commercial: '#9ecbf2', Residential: '#fdbf7f', 'Mix Use': '#c9b3e6', Apartment: '#d7c6f0', Amenity: '#9fd8a6' } // a size the map has never had
const escAttr = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const projectSvg = id => {
  const m = one('SELECT map_svg FROM projects WHERE id=?', id)?.map_svg
  if (!m) throw err(400, 'Upload the project map first')
  return String(m)
}
app.post('/api/projects/:id/map/plots', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id), b = req.body, svg = projectSvg(p.id)
  if (!/^M[\d.\s,L-]+Z$/.test(b.d || '')) throw err(400, 'Draw at least 3 corners')
  if (!String(b.no || '').trim()) throw err(400, 'Plot number is required')
  if (b.uom && !UOMS.includes(b.uom)) throw err(400, 'Unknown unit of measure')
  const id = 'drawn-' + crypto.randomBytes(4).toString('hex')
  const same = svg.match(new RegExp(`data-size="${escAttr(+b.size || '')}" data-uom="${escAttr(b.uom)}"[^>]*data-color="([^"]*)"`)) // colour like other plots of that size
  const path = `<path id="${id}" data-kind="${escAttr(b.kind || 'Commercial')}" data-block="${escAttr(String(b.block || '').trim())}" data-no="${escAttr(String(b.no).trim())}"`
    + (+b.size > 0 ? ` data-size="${+b.size}" data-uom="${escAttr(b.uom || 'kanal')}"` : '') + ` data-color="${same ? same[1] : KIND_COLOR[b.kind] || KIND_COLOR.Commercial}"` + ` d="${b.d}"/>`
  const at = svg.indexOf('</g>', svg.indexOf('id="plots"'))
  run('UPDATE projects SET map_svg=? WHERE id=?', svg.slice(0, at) + path + svg.slice(at), p.id)
  log(req, 'draw_plot', 'project', p.id, { map_ref: id, block: b.block, no: b.no })
  res.json({ id })
})
app.delete('/api/projects/:id/map/plots/:ref', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id), ref = req.params.ref, svg = projectSvg(p.id)
  if (!/^drawn-[a-f0-9]+$/.test(ref)) throw err(400, 'Only plots drawn in the app can be removed (the others come from the uploaded map)')
  if (one('SELECT 1 FROM units WHERE project_id=? AND map_ref=?', p.id, ref)) throw err(400, 'This plot is linked to inventory. Unlink it first.')
  run('UPDATE projects SET map_svg=? WHERE id=?', svg.replace(new RegExp(`<path id="${ref}"[^>]*/>`), ''), p.id)
  log(req, 'delete_drawn_plot', 'project', p.id, { map_ref: ref })
  res.json({ ok: true })
})

// New random client link; the old one stops working
app.post('/api/projects/:id/share', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id), token = crypto.randomBytes(16).toString('base64url')
  run('UPDATE projects SET share_token=? WHERE id=?', token, p.id)
  log(req, 'share_map', 'project', p.id, {})
  res.json({ token })
})

// Bulk add (the client expands "Block A, 1-50" into rows); duplicates are reported, not overwritten
app.post('/api/projects/:id/units', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id)
  const rows = req.body.units || []
  if (!rows.length || rows.length > 2000) throw err(400, 'Send 1 to 2000 units')
  planCap(req.user, 'units', rows.length) // all-or-nothing: a half-imported block is worse than a refused batch
  const added = tx(() => rows.reduce((n, r) => {
    const f = pick(r, UNIT_FIELDS)
    if (!String(f.unit_no ?? '').trim()) throw err(400, 'Every unit needs a number')
    if (f.uom && !UOMS.includes(f.uom)) throw err(400, 'Unknown unit of measure ' + f.uom)
    for (const k of ['phase', 'block', 'street']) f[k] = (f[k] ?? '').toString().trim()
    const cols = ['project_id', ...Object.keys(f), 'updated_at']
    return n + run(`INSERT OR IGNORE INTO units(${cols}) VALUES(${cols.map(() => '?')})`, p.id, ...Object.values(f), now()).changes
  }, 0))()
  log(req, 'create_units', 'project', p.id, { requested: rows.length, added })
  res.json({ added, skipped: rows.length - added })
})

// price_override / down_payment are pricing decisions: only pricing managers set them
function moneyFields(user, b) {
  const f = {}
  for (const k of ['price_override', 'down_payment']) if (k in b) {
    const v = b[k] === '' || b[k] == null ? null : Math.round(+b[k])
    if (v != null && !(v > 0)) throw err(400, `${k === 'down_payment' ? 'Down payment' : 'Price'} must be a positive amount`)
    if (!can(user, 'edit_pricing')) throw err(403, 'Only pricing managers can set prices and down payments')
    f[k] = v
  }
  if (f.price_override && f.down_payment && f.down_payment > f.price_override) throw err(400, 'Down payment cannot be more than the price')
  return f
}
const uniqueUnit = fn => {
  try { return fn() } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw err(409, 'That plot number already exists in this block')
    throw e
  }
}

// One plot at a time, for irregular blocks and numbering
app.post('/api/projects/:id/plot', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id)
  const f = { ...pick(req.body, UNIT_FIELDS), ...moneyFields(req.user, req.body) }
  for (const k of ['phase', 'block', 'street']) f[k] = (f[k] ?? '').toString().trim()
  f.unit_no = String(f.unit_no ?? '').trim()
  if (!f.unit_no) throw err(400, 'Plot number is required')
  if (f.uom && !UOMS.includes(f.uom)) throw err(400, 'Unknown unit of measure')
  if (f.size != null && !(+f.size > 0)) throw err(400, 'Size must be positive')
  planCap(req.user, 'units')
  const cols = ['project_id', ...Object.keys(f), 'updated_at']
  const id = uniqueUnit(() => run(`INSERT INTO units(${cols}) VALUES(${cols.map(() => '?')})`, p.id, ...Object.values(f), now()).lastInsertRowid)
  unitHistory(id, req.user.id, null, 'Available', null, 'Plot added')
  log(req, 'create', 'unit', id, f)
  res.json({ id })
})

const unitFor = id => {
  const un = one('SELECT * FROM units WHERE id=?', id)
  if (!un) throw err(404, 'Unit not found')
  return parseUnit(un)
}
app.get('/api/units/:id', (req, res) => {
  const un = unitFor(req.params.id), p = projectRow(un.project_id)
  res.json({
    unit: pricedUnits(p, 'un.id=?', un.id)[0], project: p,
    allotment: one(`SELECT id, allotment_no, price, sale_date FROM allotments WHERE unit_id=? AND status='active'`, un.id),
    photos: all('SELECT id, data FROM unit_photos WHERE unit_id=? ORDER BY id', un.id),
    history: all(`SELECT h.*, u.name user_name, c.name lead_name FROM unit_history h LEFT JOIN users u ON u.id=h.user_id
      LEFT JOIN leads l ON l.id=h.lead_id LEFT JOIN contacts c ON c.id=l.contact_id WHERE unit_id=? ORDER BY h.id DESC`, un.id),
  })
})
app.patch('/api/units/:id', guard('manage_inventory'), (req, res) => {
  const un = unitFor(req.params.id)
  const f = { ...pick(req.body, UNIT_FIELDS), ...moneyFields(req.user, req.body) }
  if (f.uom && !UOMS.includes(f.uom)) throw err(400, 'Unknown unit of measure')
  for (const k of ['phase', 'block', 'street']) if (k in f) f[k] = (f[k] ?? '').toString().trim()
  if ('unit_no' in f && !String(f.unit_no ?? '').trim()) throw err(400, 'Unit number cannot be empty')
  if (f.map_ref) run('UPDATE units SET map_ref=NULL WHERE project_id=? AND map_ref=? AND id<>?', un.project_id, f.map_ref, un.id) // a plot shows one unit
  if (Object.keys(f).length) uniqueUnit(() => run(`UPDATE units SET ${Object.keys(f).map(k => k + '=?')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), un.id))
  log(req, 'update', 'unit', un.id, { before: pick(un, Object.keys(f)), after: f })
  res.json({ ok: true })
})

// M10.7-M10.8: holds and status changes are conditional UPDATEs; SQLite serializes writers, so two agents can never hold the same unit
const holdUnit = tx((user, un, lead) => {
  const p = projectRow(un.project_id)
  if (one(`SELECT count(*) n FROM units WHERE hold_by=? AND status='On Hold'`, user.id).n >= S('max_holds_per_agent'))
    throw err(400, `You already have ${S('max_holds_per_agent')} units on hold. Release one first.`)
  const until = new Date(Date.now() + p.hold_hours * 3600e3).toISOString()
  if (!run(`UPDATE units SET status='On Hold', hold_by=?, hold_until=?, lead_id=?, updated_at=? WHERE id=? AND status='Available'`, user.id, until, lead.id, now(), un.id).changes)
    throw err(409, 'Someone else just took this unit. It is no longer available.')
  unitHistory(un.id, user.id, 'Available', 'On Hold', lead.id, `Held for ${p.hold_hours}h`)
  addActivity(lead.id, user.id, 'system', `Unit ${p.name} ${unitLabel(un)} put on hold for ${p.hold_hours}h`)
  return until
})
app.post('/api/units/:id/hold', (req, res) => {
  const un = unitFor(req.params.id), lead = scopedLead(req.user, req.body.lead_id)
  const until = holdUnit(req.user, un, lead)
  log(req, 'hold', 'unit', un.id, { lead_id: lead.id, until })
  res.json({ ok: true, hold_until: until })
})
app.post('/api/units/:id/release', (req, res) => {
  const un = unitFor(req.params.id)
  if (un.status !== 'On Hold') throw err(400, 'Unit is not on hold')
  if (un.hold_by !== req.user.id && !can(req.user, 'manage_inventory')) throw err(403, 'Only the agent who placed the hold can release it')
  run(`UPDATE units SET status='Available', hold_by=NULL, hold_until=NULL, lead_id=NULL, updated_at=? WHERE id=? AND status='On Hold'`, now(), un.id)
  unitHistory(un.id, req.user.id, 'On Hold', 'Available', un.lead_id, 'Released')
  log(req, 'release', 'unit', un.id)
  res.json({ ok: true })
})
const NEEDS_LEAD = ['Token Received', 'Booked', 'Sold']
app.post('/api/units/:id/status', guard('unit_status'), (req, res) => {
  const un = unitFor(req.params.id), { status, expected, note } = req.body
  if (!S('unit_statuses').includes(status) || status === 'On Hold') throw err(400, 'Pick a status (use Hold to put a unit on hold)')
  if (expected !== un.status) throw err(409, `Unit changed to "${un.status}" meanwhile. Reload and check.`)
  // the customer stays linked through token/booking/sale and on cancellation (for the record); Available/Blocked clear it
  const leadId = NEEDS_LEAD.includes(status) ? req.body.lead_id || un.lead_id : status === 'Cancelled' ? un.lead_id : null
  if (NEEDS_LEAD.includes(status) && !leadId) throw err(400, `${status} needs a customer lead`)
  // unit_status holders (accounts, inventory) record bookings for any customer, even leads outside their view
  const lead = leadId ? one('SELECT * FROM leads WHERE id=? AND deleted=0', leadId) : null
  if (leadId && !lead) throw err(404, 'Lead not found')
  if (!run(`UPDATE units SET status=?, lead_id=?, hold_by=NULL, hold_until=NULL, updated_at=? WHERE id=? AND status=?`,
    status, leadId, now(), un.id, un.status).changes) throw err(409, 'Unit changed meanwhile. Reload and check.')
  unitHistory(un.id, req.user.id, un.status, status, leadId, note)
  if (lead) {
    const p = projectRow(un.project_id)
    addActivity(lead.id, req.user.id, 'system', `Unit ${p.name} ${unitLabel(un)}: ${un.status} → ${status}${note ? ` (${note})` : ''}`)
    if (['Booked', 'Sold'].includes(status) && lead.status !== 'Booked') applyStatus(lead, 'Booked', req.user.id)
  }
  log(req, 'unit_status', 'unit', un.id, { from: un.status, to: status, lead_id: leadId })
  res.json({ ok: true })
})

function addPrice(p, b, userId) {
  const { unit_type, rate, per, effective_from, note } = b
  if (!unit_type || !(+rate > 0) || ![...UOMS, 'plot'].includes(per) || !/^\d{4}-\d{2}-\d{2}/.test(effective_from || '')) throw err(400, 'Unit type, positive price, per-unit and effective date are required')
  if (per === 'plot' && !(+b.size > 0 && UOMS.includes(b.uom))) throw err(400, 'A per-plot price needs the plot size')
  return run('INSERT INTO price_lists(project_id,unit_type,rate,per,size,uom,effective_from,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    p.id, unit_type, Math.round(+rate), per, per === 'plot' ? +b.size : null, per === 'plot' ? b.uom : null, effective_from, note || null, userId, now()).lastInsertRowid
}
app.post('/api/projects/:id/prices', guard('edit_pricing'), (req, res) => {
  const p = projectRow(req.params.id), id = addPrice(p, req.body, req.user.id)
  log(req, 'price_list', 'project', p.id, pick(req.body, ['unit_type', 'rate', 'per', 'size', 'uom', 'effective_from']))
  res.json({ id })
})

// A size category ("5 marla plot, PKR 50 Lac, 200 plots"): sets its per-plot price and creates the plots with the next free numbers
const numbersOf = text => { try { return L.parseNumbers(text) } catch (e) { throw err(400, e.message) } }
const takenIn = (projectId, block) => new Set(all(`SELECT unit_no FROM units WHERE project_id=? AND phase='' AND block=? AND street=''`, projectId, block).map(r => r.unit_no))
app.post('/api/projects/:id/categories', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id)
  const { unit_type = 'Plot', category = 'residential', size, uom = 'marla', price } = req.body
  const block = (req.body.block || '').trim(), listed = numbersOf(req.body.numbers)
  const count = listed.length || +req.body.count || 0
  if (!(+size > 0) || !UOMS.includes(uom)) throw err(400, 'Size and unit are required')
  if (!Number.isInteger(count) || count < 0 || count > 5000) throw err(400, 'Number of plots must be 0 to 5000')
  if (!count && !price) throw err(400, 'Give a price, plots, or both')
  if (price && !can(req.user, 'edit_pricing')) throw err(403, 'Only pricing managers can set prices')
  planCap(req.user, 'units', count)
  const result = tx(() => {
    if (price) addPrice(p, { unit_type, rate: price, per: 'plot', size, uom, effective_from: req.body.effective_from || now().slice(0, 10), note: req.body.note }, req.user.id)
    const taken = takenIn(p.id, block)
    let nos = listed.filter(n => !taken.has(n))
    const skipped = listed.filter(n => taken.has(n))
    if (!listed.length) { // no numbers given: next free auto numbers ("5M-31"…), or plain 1, 2, 3 inside a named block
      const prefix = block ? '' : L.autoPrefix(size, uom)
      nos = []
      for (let n = 1; nos.length < count; n++) if (!taken.has(prefix + n)) nos.push(prefix + n)
    }
    for (const no of nos)
      run(`INSERT INTO units(project_id,block,unit_no,unit_type,category,size,uom,updated_at) VALUES(?,?,?,?,?,?,?,?)`, p.id, block, no, unit_type, category, +size, uom, now())
    return { added: nos.length, first: nos[0], last: nos.at(-1), skipped }
  })()
  log(req, 'add_size', 'project', p.id, { unit_type, size, uom, price, ...result })
  res.json(result)
})

// Give auto-numbered plots of one size ("5M-1"…) their real block and plot numbers, in order
app.post('/api/projects/:id/number', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id)
  const { unit_type, size, uom } = req.body, block = (req.body.block || '').trim(), nos = numbersOf(req.body.numbers)
  if (!block) throw err(400, 'Block is required')
  if (!nos.length) throw err(400, 'Enter the plot numbers, e.g. 1-50')
  const prefix = L.autoPrefix(size, uom)
  const pending = all(`SELECT id, unit_no FROM units WHERE project_id=? AND unit_type=? AND size=? AND uom=? AND phase='' AND block='' AND street='' AND unit_no LIKE ?`,
    p.id, unit_type, +size, uom, prefix + '%').filter(u => /^\d+$/.test(u.unit_no.slice(prefix.length)))
    .sort((a, b) => a.unit_no.slice(prefix.length) - b.unit_no.slice(prefix.length))
  if (nos.length > pending.length) throw err(400, `Only ${pending.length} un-numbered plots of this size are left. Add more plots first, or enter fewer numbers.`)
  const clash = nos.filter(n => takenIn(p.id, block).has(n))
  if (clash.length) throw err(409, `Block ${block} already has plot ${clash.slice(0, 10).join(', ')}${clash.length > 10 ? '…' : ''}`)
  tx(() => nos.forEach((no, i) => {
    run(`UPDATE units SET block=?, unit_no=?, updated_at=? WHERE id=?`, block, no, now(), pending[i].id)
    unitHistory(pending[i].id, req.user.id, null, null, null, `Numbered ${pending[i].unit_no} → Block ${block} #${no}`)
  }))()
  log(req, 'number_plots', 'project', p.id, { size, uom, block, count: nos.length })
  res.json({ numbered: nos.length, left: pending.length - nos.length })
})

// ---- deleting plots: only Available plots with no client and no allotment ever; everything else is kept for the record
const DELETABLE = `units.status='Available' AND units.lead_id IS NULL AND NOT EXISTS (SELECT 1 FROM allotments a WHERE a.unit_id=units.id)`
const removeUnits = tx(ids => ids.forEach(id => { run('DELETE FROM unit_history WHERE unit_id=?', id); run('DELETE FROM units WHERE id=?', id) }))

app.delete('/api/units/:id', guard('manage_inventory'), (req, res) => {
  const un = unitFor(req.params.id)
  if (!one(`SELECT 1 FROM units WHERE id=? AND ${DELETABLE}`, un.id))
    throw err(400, 'Only available plots that were never sold or allotted can be deleted. Mark it Blocked instead.')
  removeUnits([un.id])
  log(req, 'delete', 'unit', un.id, un)
  res.json({ ok: true })
})

app.post('/api/projects/:id/sizes/delete', guard('manage_inventory'), (req, res) => {
  const p = projectRow(req.params.id)
  const { unit_type, size, uom, scope } = req.body
  if (!['unnumbered', 'all'].includes(scope)) throw err(400, 'Choose what to delete')
  const same = `project_id=? AND unit_type=? AND size=? AND uom=?`, args = [p.id, unit_type, +size, uom]
  const prefix = L.autoPrefix(size, uom)
  let rows = all(`SELECT * FROM units WHERE ${same} AND ${DELETABLE}`, ...args)
  if (scope === 'unnumbered') rows = rows.filter(u => !u.phase && !u.block && !u.street && u.unit_no.startsWith(prefix) && /^\d+$/.test(u.unit_no.slice(prefix.length)))
  removeUnits(rows.map(u => u.id))
  const kept = one(`SELECT count(*) n FROM units WHERE ${same}`, ...args).n
  // an emptied size disappears with its per-plot prices (pricing managers only; otherwise the price row stays)
  const priceRemoved = scope === 'all' && !kept && can(req.user, 'edit_pricing')
    ? run(`DELETE FROM price_lists WHERE project_id=? AND unit_type=? AND per='plot' AND size=? AND uom=?`, ...args).changes : 0
  log(req, 'delete_units', 'project', p.id, { unit_type, size, uom, scope, deleted: rows.map(u => [u.block, u.unit_no].filter(Boolean).join('-')), priceRemoved })
  res.json({ deleted: rows.length, kept, price_removed: priceRemoved > 0 })
})

// ---- allotments: assigning a sold/booked plot to its client (M13/M15, light) ----
const ALLOTTABLE = ['Available', 'On Hold', 'Token Received', 'Booked']
app.post('/api/units/:id/allot', guard('unit_status'), (req, res) => {
  const un = unitFor(req.params.id), p = projectRow(un.project_id)
  const { status = 'Sold', expected, note } = req.body
  if (!['Booked', 'Sold'].includes(status)) throw err(400, 'Assign as Booked or Sold')
  if (expected !== un.status) throw err(409, `Unit changed to "${un.status}" meanwhile. Reload and check.`)
  if (!ALLOTTABLE.includes(un.status)) throw err(400, `A ${un.status} unit cannot be assigned`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.sale_date || '')) throw err(400, 'Sale date is required')
  const out = tx(() => {
    let leadId = +req.body.lead_id || null
    if (!leadId) { // buyer not in the CRM yet
      const c = req.body.client || {}
      leadId = createLead({ name: c.name, phone: c.phone, cnic: c.cnic, email: c.email, source: 'Walk-in', project: p.name, remarks: 'Created at plot allotment' }, req.user.id).lead_id
    }
    const lead = one('SELECT * FROM leads WHERE id=? AND deleted=0', leadId)
    if (!lead) throw err(404, 'Client not found')
    const listPrice = pricedUnits(p, 'un.id=?', un.id)[0].price?.total ?? null
    const price = Math.round(+req.body.price || listPrice || 0)
    if (!(price > 0)) throw err(400, 'Sale price is required (this unit has no list price)')
    if (!run(`UPDATE units SET status=?, lead_id=?, hold_by=NULL, hold_until=NULL, updated_at=? WHERE id=? AND status=?`, status, lead.id, now(), un.id, un.status).changes)
      throw err(409, 'Unit changed meanwhile. Reload and check.')
    const id = run(`INSERT INTO allotments(unit_id,project_id,lead_id,sale_status,list_price,price,sale_date,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      un.id, p.id, lead.id, status, listPrice, price, req.body.sale_date, note || null, req.user.id, now()).lastInsertRowid
    const no = String(req.body.allotment_no || '').trim() || `AL-${String(id).padStart(5, '0')}`
    try { run('UPDATE allotments SET allotment_no=? WHERE id=?', no, id) } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw err(409, `Allotment number ${no} is already used`)
      throw e
    }
    if (req.body.plan) setPlan({ id, price, sale_date: req.body.sale_date }, req.body.plan)
    addCommissions(id, price, lead)
    unitHistory(un.id, req.user.id, un.status, status, lead.id, `Allotted (${no}) at PKR ${price.toLocaleString('en-PK')}`)
    addActivity(lead.id, req.user.id, 'system', `Allotted ${p.name} ${unitLabel(un)} (${no}) at PKR ${price.toLocaleString('en-PK')}`)
    if (lead.status !== 'Booked') applyStatus(lead, 'Booked', req.user.id)
    return { id, allotment_no: no, lead_id: lead.id }
  })()
  log(req, 'allot', 'unit', un.id, { ...out, status, price: req.body.price })
  res.json(out)
})

const ALLOT_SELECT = `SELECT a.*, un.phase, un.block, un.street, un.unit_no, un.unit_type, un.size, un.uom, un.category, un.down_payment, p.name project, p.city, p.kind, p.marla_sqft,
    c.name client, c.phone, c.cnic, c.email, u.name created_by_name
  FROM allotments a JOIN units un ON un.id=a.unit_id JOIN projects p ON p.id=a.project_id JOIN leads l ON l.id=a.lead_id
  JOIN contacts c ON c.id=l.contact_id LEFT JOIN users u ON u.id=a.created_by`
const maskAllot = (u, a) => (can(u, 'view_phone') ? a : { ...a, phone: L.maskPhone(a.phone), cnic: a.cnic && '*****' })
app.get('/api/projects/:id/allotments', guard('unit_status'), (req, res) =>
  res.json(all(`${ALLOT_SELECT} WHERE a.project_id=? ORDER BY a.id DESC`, req.params.id).map(a => maskAllot(req.user, a))))
function visibleAllotment(u, id) {
  const a = one(`${ALLOT_SELECT} WHERE a.id=?`, id)
  if (!a) throw err(404, 'Allotment not found')
  if (!can(u, 'unit_status') && !can(u, 'payments')) scopedLead(u, a.lead_id) // agents see allotments of their own clients only
  return a
}
app.get('/api/allotments/:id', (req, res) => {
  const a = visibleAllotment(req.user, req.params.id)
  log(req, 'view', 'allotment', a.id)
  res.json(maskAllot(req.user, a))
})
app.post('/api/allotments/:id/cancel', guard('unit_status'), (req, res) => {
  const a = one(`SELECT * FROM allotments WHERE id=? AND status='active'`, req.params.id)
  if (!a) throw err(404, 'Active allotment not found')
  if (!req.body.note?.trim()) throw err(400, 'A reason is required')
  tx(() => {
    run(`UPDATE allotments SET status='cancelled', cancelled_at=?, cancel_note=? WHERE id=?`, now(), req.body.note.trim(), a.id)
    run(`UPDATE commissions SET status='cancelled' WHERE allotment_id=? AND status='pending'`, a.id) // paid ones stay, flagged for recovery
    const un = unitFor(a.unit_id)
    run(`UPDATE units SET status='Available', lead_id=NULL, updated_at=? WHERE id=? AND lead_id=?`, now(), a.unit_id, a.lead_id)
    unitHistory(a.unit_id, req.user.id, un.status, 'Available', a.lead_id, `Allotment ${a.allotment_no} cancelled: ${req.body.note.trim()}`)
    addActivity(a.lead_id, req.user.id, 'system', `Allotment ${a.allotment_no} cancelled: ${req.body.note.trim()}`)
  })()
  log(req, 'cancel_allotment', 'allotment', a.id, { note: req.body.note })
  res.json({ ok: true })
})

// ---- payment plans, receipts, ledgers, transfers (Phase 2 collections) ----
const PAID_SUM = `COALESCE(sum(CASE kind WHEN 'payment' THEN amount WHEN 'refund' THEN -amount ELSE 0 END), 0)`
const paidFor = id => one(`SELECT ${PAID_SUM} n FROM payments WHERE allotment_id=? AND voided_at IS NULL`, id).n
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10) // Pakistan date, not UTC
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '')
const PAYMENT_METHODS = ['Cash', 'Bank transfer', 'Cheque', 'Pay order', 'Online']

function setPlan(a, b) {
  const down = Math.round(+b.down || 0), count = Math.round(+b.count || 0), every = +b.every || 1, start = b.start || a.sale_date
  if (down < 0 || down > a.price) throw err(400, 'Down payment must be between 0 and the sale price')
  if (count < 0 || count > 360) throw err(400, 'Installments must be between 0 and 360')
  if (![1, 3, 6, 12].includes(every)) throw err(400, 'Installments are monthly, quarterly, half-yearly or yearly')
  if (down < a.price && !count) throw err(400, 'Add installments for the balance after the down payment')
  if (!isDate(start)) throw err(400, 'Plan start date is required')
  run('DELETE FROM installments WHERE allotment_id=?', a.id)
  for (const r of L.buildSchedule(a.price, down, count, every, start))
    run('INSERT INTO installments(allotment_id,label,due_date,amount) VALUES(?,?,?,?)', a.id, r.label, r.due_date, r.amount)
}
const allotmentRow = id => {
  const a = one(`SELECT * FROM allotments WHERE id=?`, id)
  if (!a) throw err(404, 'Allotment not found')
  return a
}

app.get('/api/allotments/:id/ledger', (req, res) => {
  const a = visibleAllotment(req.user, req.params.id)
  const paid = paidFor(a.id)
  const schedule = L.allocate(all('SELECT * FROM installments WHERE allotment_id=? ORDER BY due_date, id', a.id), paid, today())
  log(req, 'view', 'ledger', a.id)
  res.json({
    allotment: maskAllot(req.user, a), schedule, paid,
    overdue: schedule.reduce((s, i) => s + (i.status === 'Overdue' ? i.amount - i.paid : 0), 0),
    fees: one(`SELECT COALESCE(sum(amount),0) n FROM payments WHERE allotment_id=? AND kind='transfer' AND voided_at IS NULL`, a.id).n,
    payments: all(`SELECT p.*, c.name payer, u.name created_by_name FROM payments p JOIN leads l ON l.id=p.lead_id JOIN contacts c ON c.id=l.contact_id
      LEFT JOIN users u ON u.id=p.created_by WHERE allotment_id=? ORDER BY p.paid_on, p.id`, a.id),
    methods: PAYMENT_METHODS,
  })
})

app.put('/api/allotments/:id/plan', guard('payments'), (req, res) => {
  const a = allotmentRow(req.params.id)
  if (a.status !== 'active') throw err(400, 'This allotment is cancelled')
  tx(() => setPlan(a, req.body))()
  log(req, 'payment_plan', 'allotment', a.id, req.body)
  res.json({ ok: true })
})

function addPayment(a, leadId, b, kind, userId) {
  const id = run(`INSERT INTO payments(allotment_id,lead_id,kind,amount,method,ref,paid_on,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    a.id, leadId, kind, Math.round(+b.amount || 0), b.method || null, b.ref?.trim() || null, b.paid_on, b.note?.trim() || null, userId, now()).lastInsertRowid
  run('UPDATE payments SET receipt_no=? WHERE id=?', `RC-${String(id).padStart(5, '0')}`, id)
  return id
}
app.post('/api/allotments/:id/payments', guard('payments'), (req, res) => {
  const a = allotmentRow(req.params.id), b = req.body, amount = Math.round(+b.amount)
  if (!['payment', 'refund'].includes(b.kind)) throw err(400, 'Record a payment or a refund')
  if (!(amount > 0)) throw err(400, 'Amount is required')
  if (!isDate(b.paid_on) || b.paid_on > today()) throw err(400, 'Payment date is required and cannot be in the future')
  if (!PAYMENT_METHODS.includes(b.method)) throw err(400, 'Pick a payment method')
  const id = tx(() => {
    const paid = paidFor(a.id)
    if (b.kind === 'payment' && a.status !== 'active') throw err(400, 'This allotment is cancelled. Only refunds can be recorded')
    if (b.kind === 'payment' && paid + amount > a.price) throw err(400, `That is more than the balance (PKR ${(a.price - paid).toLocaleString('en-PK')})`)
    if (b.kind === 'refund' && amount > paid) throw err(400, `Refund is more than what was paid (PKR ${paid.toLocaleString('en-PK')})`)
    if (b.kind === 'refund' && !b.note?.trim()) throw err(400, 'A reason is required for a refund')
    const id = addPayment(a, a.lead_id, { ...b, amount }, b.kind, req.user.id)
    addActivity(a.lead_id, req.user.id, 'system', `${b.kind === 'refund' ? 'Refund' : 'Payment'} PKR ${amount.toLocaleString('en-PK')} (${b.method}) on ${a.allotment_no}`)
    return id
  })()
  log(req, b.kind, 'allotment', a.id, { payment_id: id, amount, method: b.method })
  res.json({ id })
})
app.post('/api/payments/:id/void', guard('payments'), (req, res) => {
  const p = one('SELECT * FROM payments WHERE id=? AND voided_at IS NULL', req.params.id)
  if (!p) throw err(404, 'Payment not found or already voided')
  if (!req.body.note?.trim()) throw err(400, 'A reason is required')
  if (p.kind === 'payment' && paidFor(p.allotment_id) - p.amount < 0) throw err(400, 'Void the refund first') // paid total can't go negative
  run('UPDATE payments SET voided_at=?, void_note=? WHERE id=?', now(), req.body.note.trim(), p.id)
  addActivity(p.lead_id, req.user.id, 'system', `Receipt ${p.receipt_no} voided: ${req.body.note.trim()}`)
  log(req, 'void_payment', 'payment', p.id, { note: req.body.note })
  res.json({ ok: true })
})
function receiptData(id) {
  const p = one(`SELECT p.*, c.name payer, c.cnic payer_cnic, u.name created_by_name FROM payments p JOIN leads l ON l.id=p.lead_id
    JOIN contacts c ON c.id=l.contact_id LEFT JOIN users u ON u.id=p.created_by WHERE p.id=?`, id)
  if (!p) throw err(404, 'Receipt not found')
  const a = one(`${ALLOT_SELECT} WHERE a.id=?`, p.allotment_id)
  return { ...p, allotment: { ...a, phone: undefined, cnic: undefined, email: undefined }, paid_to_date: paidFor(a.id) }
}
app.get('/api/payments/:id', (req, res) => {
  const p = receiptData(req.params.id)
  visibleAllotment(req.user, p.allotment_id)
  log(req, 'view', 'receipt', p.id)
  res.json({ ...p, payer_cnic: can(req.user, 'view_phone') ? p.payer_cnic : p.payer_cnic && '*****' })
})

// Transfer: the plot and its payment history move to the new owner; the transfer fee is receipted separately
app.post('/api/allotments/:id/transfer', guard('payments'), (req, res) => {
  const a = allotmentRow(req.params.id), b = req.body, fee = Math.round(+b.fee || 0)
  if (a.status !== 'active') throw err(400, 'This allotment is cancelled')
  if (fee < 0) throw err(400, 'Fee cannot be negative')
  if (fee > 0 && !PAYMENT_METHODS.includes(b.method)) throw err(400, 'Pick how the fee was paid')
  if (!isDate(b.paid_on) || b.paid_on > today()) throw err(400, 'Transfer date is required and cannot be in the future')
  const out = tx(() => {
    const p = projectRow(a.project_id), un = unitFor(a.unit_id)
    const leadId = +b.lead_id || createLead({ ...b.client, source: 'Walk-in', project: p.name, remarks: `Transfer of ${a.allotment_no}` }, req.user.id).lead_id
    if (leadId === a.lead_id) throw err(400, 'Pick a different client')
    const lead = one('SELECT * FROM leads WHERE id=? AND deleted=0', leadId)
    if (!lead) throw err(404, 'Client not found')
    const from = one('SELECT c.name FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE l.id=?', a.lead_id).name
    const to = one('SELECT name FROM contacts WHERE id=?', lead.contact_id).name
    const note = `Transfer from ${from} to ${to}${b.note?.trim() ? `. ${b.note.trim()}` : ''}`
    run('UPDATE allotments SET lead_id=? WHERE id=?', lead.id, a.id)
    run('UPDATE units SET lead_id=?, updated_at=? WHERE id=?', lead.id, now(), a.unit_id)
    const id = addPayment(a, lead.id, { amount: fee, method: fee ? b.method : null, ref: b.ref, paid_on: b.paid_on, note }, 'transfer', req.user.id)
    unitHistory(a.unit_id, req.user.id, un.status, un.status, lead.id, `${a.allotment_no}: ${note}`)
    addActivity(a.lead_id, req.user.id, 'system', `${a.allotment_no} (${p.name} ${unitLabel(un)}) transferred to ${to}`)
    addActivity(lead.id, req.user.id, 'system', `${a.allotment_no} (${p.name} ${unitLabel(un)}) transferred from ${from}`)
    if (lead.status !== 'Booked') applyStatus(lead, 'Booked', req.user.id)
    return { payment_id: id, lead_id: lead.id }
  })()
  log(req, 'transfer', 'allotment', a.id, { from: a.lead_id, ...out, fee })
  res.json(out)
})

// Collections: every active allotment with what was due by today, what came in, and the overdue gap
app.get('/api/collections', guard('payments'), (req, res) => {
  const t = today()
  res.json(all(`SELECT a.id, a.allotment_no, a.price, a.lead_id, a.project_id, p.name project, un.phase, un.block, un.street, un.unit_no, c.name client, c.phone,
      (SELECT count(*) FROM installments WHERE allotment_id=a.id) plan,
      (SELECT COALESCE(sum(amount),0) FROM installments WHERE allotment_id=a.id AND due_date<?) due,
      (SELECT min(due_date) FROM installments WHERE allotment_id=a.id AND due_date>=?) next_due,
      (SELECT ${PAID_SUM} FROM payments WHERE allotment_id=a.id AND voided_at IS NULL) paid
    FROM allotments a JOIN units un ON un.id=a.unit_id JOIN projects p ON p.id=a.project_id JOIN leads l ON l.id=a.lead_id JOIN contacts c ON c.id=l.contact_id
    WHERE a.status='active' ORDER BY p.name, a.id`, t, t)
    .map(r => maskAllot(req.user, { ...r, overdue: Math.max(0, r.due - r.paid), balance: r.price - r.paid })))
})

// ---- portal link, booking form ----
app.post('/api/allotments/:id/portal', guard('payments'), (req, res) => {
  const a = allotmentRow(req.params.id), c = one('SELECT c.* FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE l.id=?', a.lead_id)
  const token = !c.portal_token || req.body.reset ? crypto.randomBytes(24).toString('hex') : c.portal_token
  run('UPDATE contacts SET portal_token=? WHERE id=?', token, c.id)
  log(req, req.body.reset ? 'portal_reset' : 'portal_link', 'contact', c.id)
  res.json({ token, name: c.name, phone: c.phone })
})

const FORM_FIELDS = ['father_name', 'dob', 'occupation', 'address', 'nominee_name', 'nominee_relation', 'nominee_cnic', 'nominee_phone', 'nominee_address']
const DOC_KINDS = ['buyer_cnic_front', 'buyer_cnic_back', 'nominee_cnic_front', 'nominee_cnic_back']
app.get('/api/allotments/:id/form', (req, res) => {
  const a = visibleAllotment(req.user, req.params.id), full = can(req.user, 'view_phone')
  log(req, 'view', 'booking_form', a.id)
  res.json({
    allotment: maskAllot(req.user, a), form: JSON.parse(a.form || '{}'),
    schedule: all('SELECT label, due_date, amount FROM installments WHERE allotment_id=? ORDER BY due_date, id', a.id),
    docs: full ? Object.fromEntries(all('SELECT kind, data FROM allotment_docs WHERE allotment_id=?', a.id).map(d => [d.kind, d.data])) : {},
  })
})
app.put('/api/allotments/:id/form', guard('unit_status'), (req, res) => {
  const a = allotmentRow(req.params.id), f = Object.fromEntries(FORM_FIELDS.map(k => [k, String(req.body[k] ?? '').trim()]).filter(([, v]) => v))
  run('UPDATE allotments SET form=? WHERE id=?', JSON.stringify(f), a.id)
  if (req.body.cnic !== undefined) { // buyer CNIC lives on the contact
    if (req.body.cnic && !/^\d{5}-?\d{7}-?\d$/.test(req.body.cnic)) throw err(400, 'CNIC should look like 35202-1234567-1')
    run('UPDATE contacts SET cnic=? WHERE id=(SELECT contact_id FROM leads WHERE id=?)', req.body.cnic || null, a.lead_id)
  }
  log(req, 'booking_form', 'allotment', a.id)
  res.json({ ok: true })
})
app.put('/api/allotments/:id/docs/:kind', guard('unit_status'), (req, res) => {
  const a = allotmentRow(req.params.id), { kind } = req.params, data = String(req.body.data || '')
  if (!DOC_KINDS.includes(kind)) throw err(400, 'Unknown document')
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(data) || data.length > 3e6) throw err(400, 'Upload a JPEG or PNG image under 2 MB')
  run('INSERT INTO allotment_docs VALUES(?,?,?,?) ON CONFLICT(allotment_id, kind) DO UPDATE SET data=excluded.data, created_at=excluded.created_at', a.id, kind, data, now())
  log(req, 'upload_doc', 'allotment', a.id, { kind })
  res.json({ ok: true })
})
app.delete('/api/allotments/:id/docs/:kind', guard('unit_status'), (req, res) => {
  run('DELETE FROM allotment_docs WHERE allotment_id=? AND kind=?', req.params.id, req.params.kind)
  log(req, 'delete_doc', 'allotment', +req.params.id, { kind: req.params.kind })
  res.json({ ok: true })
})

// ---- third-party listings: resale and rental properties of outside owners ----
const LISTING_FIELDS = ['purpose', 'property_type', 'title', 'city', 'area', 'address', 'size', 'uom', 'price', 'bedrooms', 'features', 'notes', 'status', 'agent_id']
const LISTING_SELECT = `SELECT li.*, c.name owner_name, c.phone owner_phone, ag.name agent_name,
    (SELECT token FROM media WHERE entity='listing' AND entity_id=li.id AND kind='photo' ORDER BY id LIMIT 1) cover
  FROM listings li LEFT JOIN leads ol ON ol.id=li.owner_lead_id LEFT JOIN contacts c ON c.id=ol.contact_id LEFT JOIN users ag ON ag.id=li.agent_id`
const maskListing = (u, l) => (can(u, 'view_phone') ? l : { ...l, owner_phone: L.maskPhone(l.owner_phone) })
const listingFor = id => {
  const l = one(`${LISTING_SELECT} WHERE li.id=?`, id)
  if (!l) throw err(404, 'Listing not found')
  return l
}
const canEditListing = (u, l) => can(u, 'manage_inventory') || [l.created_by, l.agent_id].includes(u.id) || MGMT.includes(u.role)
function listingFields(b) {
  const f = pick(b, LISTING_FIELDS)
  if ('purpose' in f && !['Sale', 'Rent'].includes(f.purpose)) throw err(400, 'Purpose is Sale or Rent')
  if ('status' in f && !S('listing_statuses').includes(f.status)) throw err(400, 'Unknown status')
  if ('price' in f && !(+f.price > 0)) throw err(400, 'Price is required')
  if ('uom' in f && f.uom && !UOMS.includes(f.uom)) throw err(400, 'Unknown unit of measure')
  return f
}
app.get('/api/listings', (req, res) => {
  const q = req.query, where = ['1=1'], p = []
  const add = (sql, ...v) => { where.push(sql); p.push(...v) }
  if (q.purpose) add('li.purpose=?', q.purpose)
  if (q.status) add('li.status=?', q.status)
  if (q.type) add('li.property_type=?', q.type)
  if (q.max) add('li.price<=?', +q.max)
  if (q.q) add('(li.title LIKE ? OR li.area LIKE ? OR li.city LIKE ? OR c.name LIKE ?)', ...Array(4).fill(`%${q.q}%`))
  res.json(all(`${LISTING_SELECT} WHERE ${where.join(' AND ')} ORDER BY li.status='Available' DESC, li.id DESC LIMIT 300`, ...p).map(l => maskListing(req.user, l)))
})
app.get('/api/listings/:id', (req, res) => {
  const l = listingFor(req.params.id)
  res.json({ listing: maskListing(req.user, l), can_edit: canEditListing(req.user, l), media: all(`SELECT id, token, kind, name FROM media WHERE entity='listing' AND entity_id=? ORDER BY id`, l.id) })
})
app.post('/api/listings', (req, res) => {
  const f = listingFields(req.body)
  if (!f.purpose || !f.property_type || !f.price) throw err(400, 'Purpose, property type and price are required')
  const id = tx(() => {
    let ownerId = +req.body.owner_lead_id || null
    if (!ownerId && req.body.owner?.phone) ownerId = createLead({ ...req.body.owner, source: 'Walk-in', lead_type: f.purpose === 'Rent' ? 'landlord' : 'seller', remarks: 'Listed a property' }, req.user.id, req.user.role === 'agent' ? req.user.id : null).lead_id
    const cols = [...Object.keys(f), 'owner_lead_id', 'agent_id', 'created_by', 'created_at', 'updated_at'].filter((k, i, a) => a.indexOf(k) === i)
    const vals = { ...f, owner_lead_id: ownerId, agent_id: f.agent_id || req.user.id, created_by: req.user.id, created_at: now(), updated_at: now() }
    return run(`INSERT INTO listings(${cols}) VALUES(${cols.map(() => '?')})`, ...cols.map(k => vals[k])).lastInsertRowid
  })()
  log(req, 'create', 'listing', id, f)
  res.json({ id })
})
app.patch('/api/listings/:id', (req, res) => {
  const l = listingFor(req.params.id)
  if (!canEditListing(req.user, l)) throw err(403, 'Only the listing agent or a manager can change this listing')
  const f = listingFields(req.body)
  if (Object.keys(f).length) run(`UPDATE listings SET ${Object.keys(f).map(k => k + '=?')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), l.id)
  log(req, 'update', 'listing', l.id, { before: pick(l, Object.keys(f)), after: f })
  res.json({ ok: true })
})

// ---- media: project brochures, floor plans, videos; listing photos ----
const MEDIA_KINDS = ['brochure', 'floor_plan', 'photo', 'video', 'other']
const MEDIA_MIME = /^data:(image\/(jpeg|png|webp)|application\/pdf);base64,/
function mediaGuard(u, entity, id) {
  if (entity === 'project') { projectRow(id); if (!can(u, 'manage_inventory')) throw err(403, 'You do not have permission for this') }
  else if (entity === 'listing') { if (!canEditListing(u, listingFor(id))) throw err(403, 'Only the listing agent or a manager can change this listing') }
  else throw err(400, 'Unknown item')
}
app.get('/api/media', (req, res) => res.json(all(`SELECT id, token, kind, name, mime, url, size, created_at FROM media WHERE entity=? AND entity_id=? ORDER BY kind, id`, req.query.entity, req.query.entity_id)))
app.post('/api/media', (req, res) => {
  const { entity, entity_id, kind, url } = req.body, name = String(req.body.name || '').trim().slice(0, 120)
  mediaGuard(req.user, entity, entity_id)
  if (!MEDIA_KINDS.includes(kind)) throw err(400, 'Unknown media type')
  let mime = null, data = null
  if (kind === 'video') { if (!/^https:\/\/\S+$/.test(url || '')) throw err(400, 'Paste a video link starting with https:// (YouTube, Drive, Vimeo…)') }
  else {
    const m = String(req.body.data || '').match(MEDIA_MIME)
    if (!m) throw err(400, 'Upload a PDF, JPEG, PNG or WebP file')
    mime = m[1]; data = Buffer.from(req.body.data.slice(m[0].length), 'base64')
    if (data.length > 15e6) throw err(400, 'File is too large (max 15 MB)')
  }
  // ponytail: files live as BLOBs in SQLite; move to object storage if media passes a few GB
  const id = run('INSERT INTO media(token,entity,entity_id,kind,name,mime,data,url,size,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    crypto.randomBytes(16).toString('hex'), entity, entity_id, kind, name || null, mime, data, kind === 'video' ? url : null, data?.length ?? null, req.user.id, now()).lastInsertRowid
  log(req, 'add_media', entity, +entity_id, { media_id: id, kind, name })
  res.json({ id })
})
app.delete('/api/media/:id', (req, res) => {
  const m = one('SELECT * FROM media WHERE id=?', req.params.id)
  if (!m) throw err(404, 'File not found')
  mediaGuard(req.user, m.entity, m.entity_id)
  run('DELETE FROM media WHERE id=?', m.id)
  log(req, 'delete_media', m.entity, m.entity_id, { media_id: m.id, name: m.name })
  res.json({ ok: true })
})

// ---------- Student Consultancy (the edu module) ----------
// Two gates, in order: the platform switches the module on for the company, then the permission matrix
// picks which staff inside it get in. Both are checked on every request, so a bookmarked URL is not a way in.
const hasEdu = u => modulesOf(u).includes('edu')
const eduOpen = u => hasEdu(u) && can(u, 'edu')
const eduGuard = (req, _res, next) => (eduOpen(req.user)
  ? next() : next(err(403, 'Student Consultancy is not enabled for your account')))
// the same reach as leads, measured on the counsellor instead of the agent
function eduScope(u) {
  const a = accessOf(u.role)
  if (a === 'all') return ['1=1', []]
  if (a === 'branch') return ['s.branch_id=?', [u.branch_id]]
  if (a === 'team') return ['s.counselor_id IN (SELECT id FROM users WHERE team_id=?)', [u.team_id]]
  if (a === 'own') return ['s.counselor_id=?', [u.id]]
  return ['0', []]
}
const EDU_FROM = 'FROM edu_students s JOIN contacts c ON c.id=s.contact_id LEFT JOIN users u ON u.id=s.counselor_id'
const EDU_FIELDS = ['gender', 'dob', 'city', 'passport', 'passport_expiry', 'current_level', 'institution', 'graduate_year',
  'gpa', 'major', 'ielts', 'toefl', 'gre', 'gmat', 'target_level', 'target_countries', 'intake', 'sponsor_name', 'sponsor_occupation', 'remarks', 'tags',
  'visa_type', 'visa_app_number', 'cas_coe_number', 'embassy_date', 'biometrics_date', 'visa_decision_date', 'visa_outcome', 'visa_expiry']
const eduStage = s => {
  const list = S('edu_stages')
  if (s != null && s !== '' && !list.includes(s)) throw err(400, `Unknown stage. Use: ${list.join(', ')}`)
  return s || list[0]
}
function scopedEdu(u, id) {
  const [w, p] = eduScope(u)
  const s = one(`SELECT s.*, c.name, c.phone, c.alt_phones, c.email, c.cnic, u.name counselor_name ${EDU_FROM} WHERE s.id=? AND ${w}`, id, ...p)
  if (!s) throw err(404, 'Student not found')
  return s
}
const eduDocs = id => all('SELECT id, type, name, mime, verified, notes, created_at FROM edu_documents WHERE student_id=? ORDER BY type, id', id)
// the student behind a contact, but only where this user has reach: the lead page links to it rather than promoting twice
function eduStudentOf(u, contactId) {
  if (!eduOpen(u)) return null
  const [w, p] = eduScope(u)
  return one(`SELECT s.id, s.stage FROM edu_students s WHERE s.contact_id=? AND ${w}`, contactId, ...p) || null
}
// a student keeps one timeline; stage moves are written into it so the journey reads as one story
function eduActivity(studentId, userId, type, notes, x = {}) {
  run('INSERT INTO edu_activities(student_id,user_id,type,outcome,notes,next_action,next_action_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
    studentId, userId ?? null, type, x.outcome ?? null, notes ?? null, x.next_action ?? null, x.next_action_at ?? null, now())
}

app.get('/api/edu/students', eduGuard, (req, res) => {
  const [w, p] = eduScope(req.user)
  const where = [w], params = [...p]
  const add = (sql, ...v) => { where.push(sql); params.push(...v) }
  const q = req.query
  if (q.stage) add('s.stage=?', eduStage(q.stage))
  if (q.counselor_id) add('s.counselor_id=?', +q.counselor_id)
  if (q.branch_id) add('s.branch_id=?', +q.branch_id)
  if (q.missing_docs) add('(SELECT count(*) FROM edu_documents d WHERE d.student_id=s.id)=0')
  if (q.followup) add('s.id IN (SELECT student_id FROM edu_activities WHERE next_action_at IS NOT NULL AND next_action_at<=?)', now())
  if (q.q) { const like = `%${q.q}%`; add('(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR s.institution LIKE ? OR s.passport LIKE ?)', like, like, like, like, like) }
  const size = Math.min(200, Math.max(1, +q.size || 60)), page = Math.max(0, +q.page || 0)
  const from = `${EDU_FROM} WHERE ${where.join(' AND ')}`
  res.json({
    rows: all(`SELECT s.id, s.stage, s.stage_at, s.counselor_id, u.name counselor_name, s.target_level, s.target_countries, s.intake,
      s.current_level, s.institution, s.graduate_year, s.ielts, c.name, c.phone, c.email,
      (SELECT count(*) FROM edu_documents d WHERE d.student_id=s.id) documents,
      (SELECT count(*) FROM edu_documents d WHERE d.student_id=s.id AND d.verified=0) unverified,
      (SELECT count(*) FROM edu_applications a WHERE a.student_id=s.id) applications,
      (SELECT count(*) FROM edu_applications a WHERE a.student_id=s.id AND a.status IN ('Conditional offer','Unconditional offer','Accepted')) offers,
      (SELECT max(created_at) FROM edu_activities a WHERE a.student_id=s.id) last_activity,
      (SELECT min(next_action_at) FROM edu_activities a WHERE a.student_id=s.id AND a.next_action_at IS NOT NULL) next_action_at
      ${from} ORDER BY s.id DESC LIMIT ? OFFSET ?`, ...params, size, page * size).map(r => maskRow(req.user, r)),
    total: one(`SELECT count(*) n ${from}`, ...params).n,
    stages: S('edu_stages').map(stage => ({ stage, n: one(`SELECT count(*) n ${EDU_FROM} WHERE stage=? AND ${w}`, stage, ...p).n })),
  })
})
app.post('/api/edu/students', eduGuard, (req, res) => {
  const name = String(req.body.name || '').trim(), phone = L.normalizePhone(req.body.phone || '')
  if (!name) throw err(400, 'Name is required')
  if (!phone) throw err(400, 'A phone number is required')
  const email = req.body.email?.trim().toLowerCase() || null
  const contact = findContact(phone, email) ?? { id: run('INSERT INTO contacts(name,phone,alt_phones,email,cnic,created_at) VALUES(?,?,?,?,?,?)',
    name, phone, req.body.alt_phones || null, email, req.body.cnic || null, now()).lastInsertRowid }
  const f = pick(req.body, EDU_FIELDS)
  const id_ = v => (v === '' || v == null || isNaN(+v) ? null : +v) // an empty <select> must not reach the foreign key as ""
  const cols = ['contact_id', 'lead_id', 'branch_id', 'counselor_id', 'stage', 'stage_at', ...Object.keys(f), 'created_by', 'created_at']
  const vals = [contact.id, id_(req.body.lead_id), id_(req.body.branch_id) ?? req.user.branch_id,
    id_(req.body.counselor_id) ?? req.user.id, eduStage(req.body.stage), now(), ...Object.values(f), req.user.id, now()]
  const id = run(`INSERT INTO edu_students(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...vals).lastInsertRowid
  eduActivity(id, req.user.id, 'note', `Student added${one('SELECT 1 FROM leads WHERE contact_id=?', contact.id) ? ' from a known contact' : ''}`)
  log(req, 'create', 'student', id, { name, stage: vals[4] })
  res.json({ id })
})
app.get('/api/edu/students/:id', eduGuard, (req, res) => {
  const s = scopedEdu(req.user, +req.params.id)
  res.json({
    student: maskRow(req.user, s),
    documents: eduDocs(s.id),
    activities: all(`SELECT a.*, u.name user_name FROM edu_activities a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.student_id=? ORDER BY a.id DESC LIMIT 200`, s.id),
    lead: s.lead_id ? one('SELECT id, source, campaign, status, agent_id FROM leads WHERE id=?', s.lead_id) : null,
    applications: all(`SELECT a.*, p.name program, p.level, p.tuition, p.currency, p.intakes, p.university_id, u.name university, u.country
      FROM edu_applications a JOIN edu_programs p ON p.id=a.program_id JOIN edu_universities u ON u.id=p.university_id
      WHERE a.student_id=? ORDER BY a.id DESC`, s.id),
    payments: all(`SELECT p.*, u.name created_by_name FROM edu_payments p LEFT JOIN users u ON u.id=p.created_by
      WHERE p.student_id=? ORDER BY p.paid_at DESC, p.id DESC`, s.id),
  })
})
app.patch('/api/edu/students/:id', eduGuard, (req, res) => {
  const s = scopedEdu(req.user, +req.params.id)
  const f = pick(req.body, [...EDU_FIELDS, 'branch_id', 'counselor_id'])
  const cf = pick(req.body, CONTACT_FIELDS) // the person is shared with the lead, so one edit updates both pages
  const stage = req.body.stage === undefined ? null : eduStage(req.body.stage)
  if (stage && stage !== s.stage) {
    f.stage = stage
    f.stage_at = now()
    eduActivity(s.id, req.user.id, 'system', `${s.stage} → ${stage}`)
    if (s.counselor_id && s.counselor_id !== req.user.id) notify(s.counselor_id, `${s.name} moved to ${stage}`, s.lead_id)
  }
  if (Object.keys(f).length) run(`UPDATE edu_students SET ${Object.keys(f).map(k => k + '=?')}, updated_at=? WHERE id=?`,
    ...Object.values(f), now(), s.id)
  if (Object.keys(cf).length) run(`UPDATE contacts SET ${Object.keys(cf).map(k => k + '=?')} WHERE id=?`, ...Object.values(cf), s.contact_id)
  log(req, 'update', 'student', s.id, { before: pick(s, Object.keys({ ...f, ...cf })), after: { ...f, ...cf } })
  res.json({ ok: true, stage: f.stage ?? s.stage })
})
app.post('/api/edu/students/:id/activity', eduGuard, (req, res) => {
  const s = scopedEdu(req.user, +req.params.id)
  const type = String(req.body.type || 'note')
  if (![...S('activity_types'), 'system'].includes(type)) throw err(400, `Unknown activity type. Use: ${S('activity_types').join(', ')}`)
  const notes = String(req.body.notes || '').trim().slice(0, 4000)
  if (!notes) throw err(400, 'Write something first')
  const next = req.body.next_action_at ? String(req.body.next_action_at).slice(0, 32) : null
  eduActivity(s.id, req.user.id, type, notes, { outcome: req.body.outcome || null, next_action: req.body.next_action || null, next_action_at: next })
  // the same contact can be live in both products: a property lead keeps its own last-touch clock
  if (s.lead_id && type !== 'system') run('UPDATE leads SET last_activity_at=?, stale_flag=0 WHERE id=?', now(), s.lead_id)
  if (next) notify(req.user.id, `Follow-up: ${s.name} — ${req.body.next_action || notes.slice(0, 60)}`, s.lead_id)
  log(req, 'activity', 'student', s.id, { type })
  res.json({ ok: true })
})
app.post('/api/edu/students/:id/documents', eduGuard, (req, res) => {
  const s = scopedEdu(req.user, +req.params.id)
  const type = String(req.body.type || '')
  if (!S('edu_doc_types').includes(type)) throw err(400, `Unknown document. Use: ${S('edu_doc_types').join(', ')}`)
  const data = String(req.body.data || '')
  const m = data.match(/^data:(image\/(jpeg|png|webp)|application\/pdf);base64,/)
  if (!m) throw err(400, 'Upload a PDF, JPEG, PNG or WebP file')
  if (data.length > 8e6) throw err(400, 'File is too large (max 6 MB)')
  const id = run('INSERT INTO edu_documents(student_id,type,name,mime,data,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)',
    s.id, type, String(req.body.name || '').trim().slice(0, 120) || null, m[1], data, req.user.id, now()).lastInsertRowid
  eduActivity(s.id, req.user.id, 'note', `Document uploaded: ${type}`)
  log(req, 'upload_doc', 'student', s.id, { type, document_id: id })
  res.json({ id })
})
// Paperwork is passports and CNICs, so unlike the marketing media there is no bare-token URL:
// the browser fetches this with the session header and opens the result as a blob.
app.get('/api/edu/documents/:id/file', eduGuard, (req, res) => {
  const d = one('SELECT * FROM edu_documents WHERE id=?', +req.params.id)
  if (!d) throw err(404, 'Document not found')
  scopedEdu(req.user, d.student_id)
  const raw = String(d.data || '').replace(/^data:[^;]*;base64,/, '')
  log(req, 'view_doc', 'student', d.student_id, { document_id: d.id, type: d.type })
  res.set('cache-control', 'private, max-age=86400').type(d.mime || 'application/octet-stream')
    .set('content-disposition', `inline; filename="${(d.name || d.type).replace(/[^\w. -]/g, '_')}"`)
    .send(Buffer.from(raw, 'base64'))
})
app.patch('/api/edu/documents/:id', eduGuard, (req, res) => {
  const d = one('SELECT * FROM edu_documents WHERE id=?', +req.params.id)
  if (!d) throw err(404, 'Document not found')
  scopedEdu(req.user, d.student_id) // scope check: an out-of-reach student's paper is not here
  const verified = req.body.verified === undefined ? d.verified : (req.body.verified ? 1 : 0)
  const notes = req.body.notes === undefined ? d.notes : String(req.body.notes).slice(0, 1000)
  run('UPDATE edu_documents SET verified=?, notes=? WHERE id=?', verified, notes, d.id)
  if (verified && !d.verified) eduActivity(d.student_id, req.user.id, 'note', `Verified: ${d.type}`)
  log(req, 'update_doc', 'student', d.student_id, { document_id: d.id, verified })
  res.json({ ok: true, verified: !!verified })
})
app.delete('/api/edu/documents/:id', eduGuard, (req, res) => {
  const d = one('SELECT * FROM edu_documents WHERE id=?', +req.params.id)
  if (!d) throw err(404, 'Document not found')
  scopedEdu(req.user, d.student_id)
  if (!req.body.reason) throw err(400, 'Say why the document is being removed')
  run('DELETE FROM edu_documents WHERE id=?', d.id)
  log(req, 'delete_doc', 'student', d.student_id, { document_id: d.id, type: d.type, reason: req.body.reason })
  res.json({ ok: true })
})
// A promoted lead is the usual way in: the capture, SLA and routing engine already found the person.
app.post('/api/edu/leads/:id/promote', eduGuard, (req, res) => {
  const lead = scopedLead(req.user, +req.params.id)
  const existing = one('SELECT id FROM edu_students WHERE contact_id=?', lead.contact_id)
  if (existing) {
    if (!eduStudentOf(req.user, lead.contact_id)) throw err(409, 'This contact is already a student under another counsellor.')
    log(req, 'promote', 'student', existing.id, { lead_id: lead.id }); return res.json({ id: existing.id, existed: true })
  }
  const stage = eduStage(req.body.stage)
  const id = run(`INSERT INTO edu_students(contact_id,lead_id,branch_id,counselor_id,stage,stage_at,remarks,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, lead.contact_id, lead.id, lead.branch_id ?? req.user.branch_id, lead.agent_id ?? req.user.id, stage, now(),
    lead.remarks || null, req.user.id, now()).lastInsertRowid
  eduActivity(id, req.user.id, 'system', `Promoted from lead #${lead.id} (${lead.source}${lead.campaign ? ' / ' + lead.campaign : ''})`)
  addActivity(lead.id, req.user.id, 'system', `Promoted to student (stage: ${stage})`)
  log(req, 'promote', 'student', id, { lead_id: lead.id, stage })
  res.json({ id })
})

// ---------- The catalogue a counsellor sells from: universities, campuses, courses ----------
// Company-wide on purpose, not per counsellor: two people working the same student must see the same
// tuition and the same entry requirements. Once an application exists the course is proof of an offer,
// so the rows are deactivated rather than deleted.
const UNI_FIELDS = ['name', 'country', 'city', 'website', 'ranking', 'note']
const PROG_FIELDS = ['university_id', 'campus_id', 'name', 'level', 'field', 'tuition', 'currency', 'duration_months', 'intakes', 'eligibility', 'requirements', 'ielts_min']
const uniOf = id => { const u = one('SELECT * FROM edu_universities WHERE id=?', +id); if (!u) throw err(404, 'University not found'); return u }
const progOf = id => { const p = one(`SELECT p.*, u.name university, u.country FROM edu_programs p JOIN edu_universities u ON u.id=p.university_id WHERE p.id=?`, +id); if (!p) throw err(404, 'Course not found'); return p }
const countryOf = c => { const list = S('edu_countries'); if (!c) throw err(400, `Pick a country. Add more in Settings › edu_countries`); if (!list.includes(c)) throw err(400, `Unknown country. Use: ${list.join(', ')}`); return c }
const levelOf = l => { if (l == null || l === '') return null; if (!S('edu_levels').includes(l)) throw err(400, `Unknown level. Use: ${S('edu_levels').join(', ')}`); return l }
const insert = (table, obj) => run(`INSERT INTO ${table}(${Object.keys(obj).join(',')}) VALUES(${Object.keys(obj).map(() => '?').join(',')})`, ...Object.values(obj)).lastInsertRowid
// forms post strings; a tuition of "24000" stored as text would sort and add wrong, so the numbers are coerced here
const num = v => (v == null || v === '' || !Number.isFinite(+v) ? null : +v)
const PROG_NUMS = ['campus_id', 'tuition', 'duration_months', 'ielts_min']
const numFields = f => { PROG_NUMS.forEach(k => k in f && (f[k] = num(f[k]))); return f }

app.get('/api/edu/universities', eduGuard, (_req, res) => {
  const where = ['1=1'], params = []
  const q = _req.query
  if (q.country) { where.push('u.country=?'); params.push(q.country) }
  if (q.q) { const like = `%${q.q}%`; where.push('(u.name LIKE ? OR u.city LIKE ? OR u.note LIKE ?)'); params.push(like, like, like) }
  where.push(q.active === '0' ? 'u.active=0' : 'u.active=1')
  const w = where.join(' AND ')
  res.json({
    rows: all(`SELECT u.*, (SELECT count(*) FROM edu_programs p WHERE p.university_id=u.id AND p.active=1) programs,
      (SELECT count(*) FROM edu_campuses c WHERE c.university_id=u.id) campuses,
      (SELECT count(*) FROM edu_applications a JOIN edu_programs p ON p.id=a.program_id WHERE p.university_id=u.id) applications,
      (SELECT count(DISTINCT s.id) FROM edu_applications a JOIN edu_programs p ON p.id=a.program_id JOIN edu_students s ON s.id=a.student_id WHERE p.university_id=u.id) students
      FROM edu_universities u WHERE ${w} ORDER BY u.country, u.name`, ...params),
    countries: all('SELECT country, count(*) n FROM edu_universities WHERE active=1 GROUP BY country ORDER BY n DESC, country'),
  })
})
app.get('/api/edu/universities/:id', eduGuard, (req, res) => {
  const u = uniOf(req.params.id)
  res.json({
    university: { ...u,
      applications: one(`SELECT count(*) n FROM edu_applications a JOIN edu_programs p ON p.id=a.program_id WHERE p.university_id=?`, u.id).n,
      students: one(`SELECT count(DISTINCT a.student_id) n FROM edu_applications a JOIN edu_programs p ON p.id=a.program_id WHERE p.university_id=?`, u.id).n },
    campuses: all(`SELECT c.*, (SELECT count(*) FROM edu_programs p WHERE p.campus_id=c.id) programs FROM edu_campuses c WHERE c.university_id=? ORDER BY c.name`, u.id),
    programs: all(`SELECT p.*, c.name campus, (SELECT count(*) FROM edu_applications a WHERE a.program_id=p.id) applications
      FROM edu_programs p LEFT JOIN edu_campuses c ON c.id=p.campus_id WHERE p.university_id=? ORDER BY p.active DESC, p.level, p.name`, u.id),
  })
})
app.post('/api/edu/universities', eduGuard, (req, res) => {
  const f = pick(req.body, UNI_FIELDS)
  if (!f.name) throw err(400, 'Name is required')
  f.country = countryOf(f.country)
  const id = insert('edu_universities', { ...f, active: 1, created_by: req.user.id, created_at: now() })
  log(req, 'create', 'university', id, { name: f.name, country: f.country })
  res.json({ id })
})
app.patch('/api/edu/universities/:id', eduGuard, (req, res) => {
  const u = uniOf(req.params.id)
  const f = pick(req.body, UNI_FIELDS)
  if (f.country !== undefined) f.country = countryOf(f.country)
  if (req.body.active !== undefined) f.active = req.body.active ? 1 : 0
  if (Object.keys(f).length) run(`UPDATE edu_universities SET ${Object.keys(f).map(k => k + '=?')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), u.id)
  log(req, 'update', 'university', u.id, { before: pick(u, Object.keys(f)), after: f })
  res.json({ ok: true })
})
app.delete('/api/edu/universities/:id', eduGuard, (req, res) => {
  const u = uniOf(req.params.id)
  const used = one(`SELECT count(*) n FROM edu_applications a JOIN edu_programs p ON p.id=a.program_id WHERE p.university_id=?`, u.id).n
  if (used) throw err(400, `${u.name} has ${used} application${used === 1 ? '' : 's'} — switch it off instead of deleting it`)
  run('DELETE FROM edu_programs WHERE university_id=?', u.id)
  run('DELETE FROM edu_campuses WHERE university_id=?', u.id)
  run('DELETE FROM edu_universities WHERE id=?', u.id)
  log(req, 'delete', 'university', u.id, { name: u.name, reason: req.body.reason || null })
  res.json({ ok: true })
})
app.post('/api/edu/universities/:id/campuses', eduGuard, (req, res) => {
  const u = uniOf(req.params.id)
  const name = String(req.body.name || '').trim()
  if (!name) throw err(400, 'Campus name is required')
  const id = insert('edu_campuses', { university_id: u.id, name, city: req.body.city || null, note: req.body.note || null, created_at: now() })
  log(req, 'create', 'university', u.id, { campus_id: id, name })
  res.json({ id })
})
app.delete('/api/edu/campuses/:id', eduGuard, (req, res) => {
  const c = one('SELECT * FROM edu_campuses WHERE id=?', +req.params.id)
  if (!c) throw err(404, 'Campus not found')
  if (one('SELECT count(*) n FROM edu_programs WHERE campus_id=?', c.id).n) throw err(400, 'Courses are attached to this campus')
  run('DELETE FROM edu_campuses WHERE id=?', c.id)
  log(req, 'delete', 'university', c.university_id, { campus_id: c.id, name: c.name })
  res.json({ ok: true })
})

app.get('/api/edu/programs', eduGuard, (req, res) => {
  const where = ['p.active=1', 'u.active=1'], params = []
  const q = req.query
  if (q.university_id) { where.push('p.university_id=?'); params.push(+q.university_id) }
  if (q.level) { where.push('p.level=?'); params.push(levelOf(q.level)) }
  if (q.country) { where.push('u.country=?'); params.push(q.country) }
  if (q.intake) { where.push(`p.intakes LIKE ?`); params.push(`%${q.intake}%`) }
  if (q.q) { const like = `%${q.q}%`; where.push('(p.name LIKE ? OR p.field LIKE ? OR u.name LIKE ?)'); params.push(like, like, like) }
  const w = where.join(' AND ')
  res.json({
    rows: all(`SELECT p.*, u.name university, u.country, c.name campus,
      (SELECT count(*) FROM edu_applications a WHERE a.program_id=p.id) applications
      FROM edu_programs p JOIN edu_universities u ON u.id=p.university_id LEFT JOIN edu_campuses c ON c.id=p.campus_id
      WHERE ${w} ORDER BY u.country, u.name, p.name`, ...params),
    total: one(`SELECT count(*) n FROM edu_programs p JOIN edu_universities u ON u.id=p.university_id WHERE ${w}`, ...params).n,
  })
})
app.post('/api/edu/programs', eduGuard, (req, res) => {
  const f = numFields(pick(req.body, PROG_FIELDS))
  if (!f.name) throw err(400, 'Course name is required')
  if (!f.university_id) throw err(400, 'Pick the university this course belongs to')
  const u = uniOf(f.university_id)
  if (f.campus_id && !one('SELECT id FROM edu_campuses WHERE id=? AND university_id=?', f.campus_id, u.id)) throw err(400, 'That campus belongs to another university')
  f.level = levelOf(f.level)
  const id = insert('edu_programs', { ...f, university_id: u.id, active: 1, created_by: req.user.id, created_at: now() })
  log(req, 'create', 'program', id, { name: f.name, university_id: u.id })
  res.json({ id })
})
app.patch('/api/edu/programs/:id', eduGuard, (req, res) => {
  const p = progOf(req.params.id)
  const f = numFields(pick(req.body, PROG_FIELDS))
  if (f.level !== undefined) f.level = levelOf(f.level)
  if (f.university_id !== undefined) f.university_id = uniOf(f.university_id).id
  if (f.campus_id && !one('SELECT id FROM edu_campuses WHERE id=? AND university_id=?', f.campus_id, f.university_id ?? p.university_id)) throw err(400, 'That campus belongs to another university')
  if (req.body.active !== undefined) f.active = req.body.active ? 1 : 0
  if (Object.keys(f).length) run(`UPDATE edu_programs SET ${Object.keys(f).map(k => k + '=?')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), p.id)
  log(req, 'update', 'program', p.id, { before: pick(p, Object.keys(f)), after: f })
  res.json({ ok: true })
})
app.delete('/api/edu/programs/:id', eduGuard, (req, res) => {
  const p = progOf(req.params.id)
  const used = one('SELECT count(*) n FROM edu_applications WHERE program_id=?', p.id).n
  if (used) throw err(400, `${p.name} has ${used} application${used === 1 ? '' : 's'} — switch it off instead of deleting it`)
  run('DELETE FROM edu_programs WHERE id=?', p.id)
  log(req, 'delete', 'program', p.id, { name: p.name })
  res.json({ ok: true })
})

// ---------- Applications: one row per student and course, with its own lifecycle ----------
// The student's stage is the counsellor's pipeline; an application is a live case with a university,
// so they move independently. Reach is still the student's: eduScope is measured on the counsellor.
const APP_FROM = `FROM edu_applications a JOIN edu_programs p ON p.id=a.program_id JOIN edu_universities u ON u.id=p.university_id
  JOIN edu_students s ON s.id=a.student_id JOIN contacts c ON c.id=s.contact_id LEFT JOIN users cu ON cu.id=s.counselor_id`
const APP_SELECT = `SELECT a.*, p.name program, p.level, p.tuition, p.currency, p.intakes, p.university_id, u.name university, u.country,
  c.name student_name, c.phone, s.stage, s.lead_id, s.counselor_id, cu.name counselor_name`
const appStatus = x => { const list = S('edu_application_statuses'); if (x && !list.includes(x)) throw err(400, `Unknown status. Use: ${list.join(', ')}`); return x || list[0] }
const DECIDED = ['Conditional offer', 'Unconditional offer', 'Accepted', 'Rejected']
function scopedApp(u, id) {
  const [w, p] = eduScope(u)
  const a = one(`${APP_SELECT} ${APP_FROM} WHERE a.id=? AND ${w}`, id, ...p)
  if (!a) throw err(404, 'Application not found')
  return a
}

app.get('/api/edu/applications', eduGuard, (req, res) => {
  const [w, p] = eduScope(req.user)
  const where = [w], params = [...p]
  const q = req.query
  if (q.status) { where.push('a.status=?'); params.push(appStatus(q.status)) }
  if (q.student_id) { where.push('a.student_id=?'); params.push(+q.student_id) }
  if (q.university_id) { where.push('p.university_id=?'); params.push(+q.university_id) }
  if (q.country) { where.push('u.country=?'); params.push(q.country) }
  if (q.q) { const like = `%${q.q}%`; where.push('(c.name LIKE ? OR p.name LIKE ? OR u.name LIKE ?)'); params.push(like, like, like) }
  const from = `${APP_FROM} WHERE ${where.join(' AND ')}`
  res.json({
    rows: all(`${APP_SELECT}, s.stage student_stage ${from} ORDER BY a.updated_at DESC, a.id DESC LIMIT 300`, ...params).map(r => maskRow(req.user, r)),
    total: one(`SELECT count(*) n ${from}`, ...params).n,
    statuses: S('edu_application_statuses').map(status => ({ status, n: one(`SELECT count(*) n ${APP_FROM} WHERE a.status=? AND ${w}`, status, ...p).n })),
  })
})
app.post('/api/edu/applications', eduGuard, (req, res) => {
  const s = scopedEdu(req.user, num(req.body.student_id))
  const p = progOf(req.body.program_id)
  if (one('SELECT id FROM edu_applications WHERE student_id=? AND program_id=?', s.id, p.id))
    throw err(409, `${s.name} already has an application to ${p.name} at ${p.university}`)
  const status = appStatus(req.body.status)
  const id = insert('edu_applications', { student_id: s.id, program_id: p.id, status, ref: req.body.ref || null, note: req.body.note || null,
    submitted_at: status === 'Ready' ? null : now(), created_by: req.user.id, created_at: now() })
  eduActivity(s.id, req.user.id, 'system', `Application opened: ${p.name} — ${p.university}, ${p.country}`)
  log(req, 'create', 'application', id, { student_id: s.id, program_id: p.id, status })
  res.json({ id })
})
app.patch('/api/edu/applications/:id', eduGuard, (req, res) => {
  const a = scopedApp(req.user, req.params.id)
  const f = pick(req.body, ['ref', 'note', 'offer_type'])
  const status = req.body.status === undefined ? null : appStatus(req.body.status)
  if (status && status !== a.status) {
    f.status = status
    if (status !== 'Ready' && !a.submitted_at) f.submitted_at = now()
    if (DECIDED.includes(status)) f.decision_at = now()
    eduActivity(a.student_id, req.user.id, 'system', `${a.university} (${a.program}): ${a.status} → ${status}`)
    if (a.counselor_id && a.counselor_id !== req.user.id) notify(a.counselor_id, `${a.student_name}: ${a.university} is ${status}`, a.lead_id ?? null)
  }
  if (Object.keys(f).length) run(`UPDATE edu_applications SET ${Object.keys(f).map(k => k + '=?')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), a.id)
  log(req, 'update', 'application', a.id, { before: pick(a, Object.keys(f)), after: f })
  res.json({ ok: true, status: f.status ?? a.status })
})
app.delete('/api/edu/applications/:id', eduGuard, (req, res) => {
  const a = scopedApp(req.user, req.params.id)
  if (!req.body.reason) throw err(400, 'Say why the application is being removed')
  run('DELETE FROM edu_applications WHERE id=?', a.id)
  eduActivity(a.student_id, req.user.id, 'system', `Application withdrawn from the record: ${a.university} (${a.program}) — ${req.body.reason}`)
  log(req, 'delete', 'application', a.id, { student_id: a.student_id, program_id: a.program_id, reason: req.body.reason })
  res.json({ ok: true })
})

// ---------- Student payments ----------
app.get('/api/edu/payments', eduGuard, (req, res) => {
  const [w, p] = eduScope(req.user)
  const q = req.query
  const where = [w.replace(/\bs\./g, 's.')], params = [...p]
  if (q.type) { where.push('p.type=?'); params.push(q.type) }
  if (q.student_id) { where.push('p.student_id=?'); params.push(+q.student_id) }
  if (q.q) {
    where.push('(c.name LIKE ? OR c.phone LIKE ? OR p.reference LIKE ? OR p.note LIKE ?)')
    const like = `%${q.q}%`
    params.push(like, like, like, like)
  }
  const rows = all(`SELECT p.*, c.name student_name, c.phone student_phone, u.name created_by_name
    FROM edu_payments p JOIN edu_students s ON s.id=p.student_id JOIN contacts c ON c.id=s.contact_id
    LEFT JOIN users u ON u.id=p.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY p.paid_at DESC, p.id DESC LIMIT 100`, ...params)
  res.json({ rows, total: rows.length })
})
app.get('/api/edu/students/:id/payments', eduGuard, (req, res) => {
  const s = scopedEdu(req.user, +req.params.id)
  res.json(all(`SELECT p.*, u.name created_by_name FROM edu_payments p LEFT JOIN users u ON u.id=p.created_by
    WHERE p.student_id=? ORDER BY p.paid_at DESC, p.id DESC`, s.id))
})
app.post('/api/edu/students/:id/payments', eduGuard, (req, res) => {
  const s = scopedEdu(req.user, +req.params.id)
  const type = String(req.body.type || '')
  if (!S('edu_payment_types').includes(type)) throw err(400, `Unknown payment type. Use: ${S('edu_payment_types').join(', ')}`)
  const amount = +req.body.amount
  if (!amount || amount <= 0) throw err(400, 'Amount must be a positive number')
  const id = run('INSERT INTO edu_payments(student_id,type,amount,currency,method,reference,note,paid_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    s.id, type, amount, req.body.currency || 'PKR', req.body.method || null, req.body.reference || null,
    req.body.note || null, req.body.paid_at || now(), req.user.id, now()).lastInsertRowid
  eduActivity(s.id, req.user.id, 'note', `Payment recorded: ${type.replace(/_/g, ' ')} — ${req.body.currency || 'PKR'} ${amount.toLocaleString()}`)
  log(req, 'create', 'edu_payment', id, { student_id: s.id, type, amount })
  res.json({ id })
})
app.patch('/api/edu/payments/:id', eduGuard, (req, res) => {
  const p = one('SELECT * FROM edu_payments WHERE id=?', +req.params.id)
  if (!p) throw err(404, 'Payment not found')
  scopedEdu(req.user, p.student_id)
  const f = pick(req.body, ['type', 'amount', 'currency', 'method', 'reference', 'note', 'paid_at'])
  if (f.type && !S('edu_payment_types').includes(f.type)) throw err(400, `Unknown payment type`)
  if (f.amount != null && (+f.amount <= 0 || !Number.isFinite(+f.amount))) throw err(400, 'Amount must be positive')
  if (f.amount) f.amount = +f.amount
  if (Object.keys(f).length) run(`UPDATE edu_payments SET ${Object.keys(f).map(k => k + '=?')} WHERE id=?`, ...Object.values(f), p.id)
  log(req, 'update', 'edu_payment', p.id, { before: pick(p, Object.keys(f)), after: f })
  res.json({ ok: true })
})
app.delete('/api/edu/payments/:id', eduGuard, (req, res) => {
  const p = one('SELECT * FROM edu_payments WHERE id=?', +req.params.id)
  if (!p) throw err(404, 'Payment not found')
  scopedEdu(req.user, p.student_id)
  run('DELETE FROM edu_payments WHERE id=?', p.id)
  log(req, 'delete', 'edu_payment', p.id, { student_id: p.student_id, type: p.type, amount: p.amount })
  res.json({ ok: true })
})

// ---------- Edu dashboard & reports ----------
app.get('/api/edu/dashboard', eduGuard, (req, res) => {
  const q = req.query
  const TZ = '+05:00', dayStart = d => new Date(`${d}T00:00:00${TZ}`).toISOString(), dayEnd = d => new Date(`${d}T23:59:59.999${TZ}`).toISOString()
  const fromDay = q.from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
  const toDay = q.to || now().slice(0, 10)
  const from = dayStart(fromDay), to = dayEnd(toDay)
  const [w, p] = eduScope(req.user)
  const W = `${EDU_FROM} WHERE ${w}`

  // Stage funnel — all current students, not date-filtered
  const stages = S('edu_stages').map(stage => ({ stage, n: one(`SELECT count(*) n ${EDU_FROM} WHERE s.stage=? AND ${w}`, stage, ...p).n }))
  const totalStudents = stages.reduce((s, x) => s + x.n, 0)

  // Date-filtered KPIs
  const kpi = one(`SELECT count(*) new_students ${EDU_FROM} WHERE s.created_at BETWEEN ? AND ? AND ${w}`, from, to, ...p)
  const apps = one(`SELECT count(*) sent,
    sum(a.status IN ('Conditional offer','Unconditional offer','Accepted')) offers,
    sum(a.status='Accepted') accepted, sum(a.status='Rejected') rejected
    FROM edu_applications a JOIN edu_students s ON s.id=a.student_id WHERE a.created_at BETWEEN ? AND ? AND ${w}`, from, to, ...p)
  const enrolled = one(`SELECT count(*) n ${EDU_FROM} WHERE s.stage='Enrolled' AND s.stage_at BETWEEN ? AND ? AND ${w}`, from, to, ...p).n

  // Follow-ups due
  const followups = one(`SELECT count(*) n FROM edu_activities ea JOIN edu_students s ON s.id=ea.student_id
    WHERE ea.next_action_at IS NOT NULL AND ea.next_action_at<=? AND ${w.replace(/\bs\./g, 's.')}`, now(), ...p).n
  // Documents pending verification
  const unverified = one(`SELECT count(*) n FROM edu_documents d JOIN edu_students s ON s.id=d.student_id
    WHERE d.verified=0 AND ${w.replace(/\bs\./g, 's.')}`, ...p).n

  // Counselor performance
  const counselors = all(`SELECT u.id, u.name,
    (SELECT count(*) FROM edu_students s2 WHERE s2.counselor_id=u.id AND s2.created_at BETWEEN ? AND ?) new_students,
    (SELECT count(*) FROM edu_students s2 WHERE s2.counselor_id=u.id) total_students,
    (SELECT count(*) FROM edu_applications a2 JOIN edu_students s2 ON s2.id=a2.student_id WHERE s2.counselor_id=u.id AND a2.created_at BETWEEN ? AND ?) applications,
    (SELECT count(*) FROM edu_applications a2 JOIN edu_students s2 ON s2.id=a2.student_id WHERE s2.counselor_id=u.id AND a2.status IN ('Conditional offer','Unconditional offer','Accepted')) offers,
    (SELECT count(*) FROM edu_students s2 WHERE s2.counselor_id=u.id AND s2.stage='Enrolled') enrolled,
    (SELECT count(*) FROM edu_activities ea WHERE ea.student_id IN (SELECT id FROM edu_students WHERE counselor_id=u.id) AND ea.next_action_at IS NOT NULL AND ea.next_action_at<=?) overdue
    FROM users u WHERE u.active=1 AND u.id IN (SELECT DISTINCT counselor_id FROM edu_students)
    ORDER BY enrolled DESC, offers DESC, total_students DESC`, from, to, from, to, now())

  // Country distribution
  const countries = all(`SELECT json_each.value country, count(*) n FROM edu_students s, json_each('["' || replace(s.target_countries, ', ', '","') || '"]')
    WHERE ${w} AND s.target_countries IS NOT NULL AND s.target_countries!='' GROUP BY json_each.value ORDER BY n DESC`, ...p)

  // Intake pipeline & urgency alert
  const intakes = all(`SELECT s.intake, count(*) n, sum(s.stage='Enrolled') enrolled,
    sum(s.stage NOT IN ('Enrolled', 'Visa Decision')) active_pipeline,
    (SELECT count(*) FROM edu_applications a WHERE a.student_id IN (SELECT id FROM edu_students WHERE intake=s.intake)) applications
    ${EDU_FROM} WHERE s.intake IS NOT NULL AND s.intake!='' AND ${w} GROUP BY s.intake ORDER BY s.intake`, ...p)

  // Intake deadline urgency alerts: upcoming intakes with active students pending application or offers
  const intakeAlerts = intakes.filter(i => i.active_pipeline > 0).map(i => ({
    intake: i.intake,
    pending_students: i.active_pipeline,
    warning: `Intake ${i.intake} has ${i.active_pipeline} active student(s) still in counseling or application phase.`
  }))

  // My follow-ups (for the logged-in user)
  const mine = all(`SELECT s.id, c.name, s.stage, ea.next_action, ea.next_action_at
    FROM edu_activities ea JOIN edu_students s ON s.id=ea.student_id JOIN contacts c ON c.id=s.contact_id
    WHERE s.counselor_id=? AND ea.next_action_at IS NOT NULL AND ea.next_action_at<=?
    AND ea.id=(SELECT max(id) FROM edu_activities WHERE student_id=s.id AND next_action_at IS NOT NULL)
    ORDER BY ea.next_action_at LIMIT 30`, req.user.id, new Date(Date.now() + 864e5).toISOString())

  // Revenue & Payments Breakdown (Yearly and Monthly)
  let paymentsYear = []
  try {
    paymentsYear = all(`SELECT strftime('%Y-%m', paid_at) ym, sum(amount) total, count(*) count
      FROM edu_payments WHERE paid_at >= date('now', '-12 months') GROUP BY ym ORDER BY ym`)
  } catch (e) { console.error('paymentsYear error:', e) }

  // Placement commissions monthly breakdown
  let commissionsYear = []
  try {
    commissionsYear = all(`SELECT strftime('%Y-%m', paid_on) ym, sum(amount) total, count(*) count
      FROM edu_commissions WHERE status='paid' AND paid_on >= date('now', '-12 months') GROUP BY ym ORDER BY ym`)
  } catch (e) { console.error('commissionsYear error:', e) }

  // Recent fee / commission transactions
  let recentTransactions = []
  try {
    recentTransactions = all(`SELECT p.id, p.student_id, c.name student_name, p.type, p.amount, p.currency, p.paid_at, p.method, 'Fee Payment' category
      FROM edu_payments p JOIN edu_students s ON s.id=p.student_id JOIN contacts c ON c.id=s.contact_id
      WHERE ${w.replace(/\bs\./g, 's.')}
      ORDER BY p.paid_at DESC LIMIT 6`, ...p)
  } catch (e) { console.error('recentTransactions error:', e) }

  // Student Engagement & Status Activity (Active in progress vs Inactive/Dropped vs Enrolled/Completed)
  let studentActivity = { active: 0, inactive: 0, enrolled: 0, total: 0 }
  try {
    studentActivity = one(`SELECT
      COALESCE(sum(s.stage NOT IN ('Enrolled', 'Visa Decision')), 0) active,
      COALESCE(sum(s.stage IN ('Visa Decision', 'Rejected', 'Withdrawn')), 0) inactive,
      COALESCE(sum(s.stage = 'Enrolled'), 0) enrolled,
      count(*) total
      ${EDU_FROM} WHERE ${w}`, ...p) || studentActivity
  } catch (e) { console.error('studentActivity error:', e) }

  // Operations & Health
  const ops = {
    docVerificationRate: totalStudents === 0 ? '100%' : `${Math.round(((totalStudents - unverified) / totalStudents) * 100)}%`,
    pendingDocs: unverified,
    followupsDue: followups,
    activeCounselors: counselors.length
  }

  res.json({ from: fromDay, to: toDay, stages, totalStudents, kpi, apps, enrolled, followups, unverified, counselors, countries, intakes, intakeAlerts, mine, paymentsYear, commissionsYear, recentTransactions, studentActivity, ops })
})

app.get('/api/edu/reports', eduGuard, (req, res) => {
  const q = req.query
  const TZ = '+05:00', dayStart = d => new Date(`${d}T00:00:00${TZ}`).toISOString(), dayEnd = d => new Date(`${d}T23:59:59.999${TZ}`).toISOString()
  const fromDay = q.from || new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)
  const toDay = q.to || now().slice(0, 10)
  const from = dayStart(fromDay), to = dayEnd(toDay)
  const [w, p] = eduScope(req.user)

  // Counselor leaderboard
  const counselors = all(`SELECT u.id, u.name,
    (SELECT count(*) FROM edu_students s WHERE s.counselor_id=u.id AND s.created_at BETWEEN ? AND ?) new_students,
    (SELECT count(*) FROM edu_students s WHERE s.counselor_id=u.id) total,
    (SELECT count(*) FROM edu_applications a JOIN edu_students s ON s.id=a.student_id WHERE s.counselor_id=u.id AND a.created_at BETWEEN ? AND ?) apps_sent,
    (SELECT count(*) FROM edu_applications a JOIN edu_students s ON s.id=a.student_id WHERE s.counselor_id=u.id AND a.status IN ('Conditional offer','Unconditional offer','Accepted')) offers,
    (SELECT count(*) FROM edu_students s WHERE s.counselor_id=u.id AND s.stage='Enrolled' AND s.stage_at BETWEEN ? AND ?) enrolled,
    (SELECT count(*) FROM edu_activities ea WHERE ea.user_id=u.id AND ea.type NOT IN ('system') AND ea.created_at BETWEEN ? AND ?) activities
    FROM users u WHERE u.active=1 AND u.id IN (SELECT DISTINCT counselor_id FROM edu_students)
    ORDER BY enrolled DESC, offers DESC`, from, to, from, to, from, to, from, to)

  // Country-wise placement stats
  const byCountry = all(`SELECT u.country, count(DISTINCT a.student_id) students, count(*) applications,
    sum(a.status IN ('Conditional offer','Unconditional offer','Accepted')) offers,
    sum(a.status='Accepted') accepted, sum(a.status='Rejected') rejected
    FROM edu_applications a JOIN edu_programs pr ON pr.id=a.program_id JOIN edu_universities u ON u.id=pr.university_id
    JOIN edu_students s ON s.id=a.student_id WHERE ${w.replace(/\bs\./g, 's.')} AND a.created_at BETWEEN ? AND ?
    GROUP BY u.country ORDER BY applications DESC`, ...p, from, to)

  // University-wise acceptance rates
  const byUniversity = all(`SELECT u.name university, u.country, count(*) applications,
    sum(a.status IN ('Conditional offer','Unconditional offer','Accepted')) offers,
    sum(a.status='Accepted') accepted, sum(a.status='Rejected') rejected,
    CASE WHEN sum(a.status IN ('Accepted','Rejected'))>0 THEN round(100.0*sum(a.status='Accepted')/sum(a.status IN ('Accepted','Rejected')),1) ELSE null END acceptance_rate
    FROM edu_applications a JOIN edu_programs pr ON pr.id=a.program_id JOIN edu_universities u ON u.id=pr.university_id
    JOIN edu_students s ON s.id=a.student_id WHERE ${w.replace(/\bs\./g, 's.')} AND a.created_at BETWEEN ? AND ?
    GROUP BY u.id ORDER BY applications DESC`, ...p, from, to)

  // Intake pipeline
  const byIntake = all(`SELECT s.intake, count(*) students,
    sum(s.stage IN ('University Application','Offer Received','Fee Payment','Visa Processing','Visa Decision','Enrolled')) in_progress,
    sum(s.stage='Enrolled') enrolled,
    (SELECT count(*) FROM edu_applications a WHERE a.student_id IN (SELECT id FROM edu_students WHERE intake=s.intake)) applications
    ${EDU_FROM} WHERE s.intake IS NOT NULL AND s.intake!='' AND ${w} GROUP BY s.intake ORDER BY s.intake`, ...p)

  // Stage conversion: average days in each stage
  const stageAvg = all(`SELECT ea.notes stage_move, count(*) n,
    round(avg(julianday(ea.created_at) - julianday(COALESCE(
      (SELECT max(ea2.created_at) FROM edu_activities ea2 WHERE ea2.student_id=ea.student_id AND ea2.type='system' AND ea2.created_at<ea.created_at),
      (SELECT s.created_at FROM edu_students s WHERE s.id=ea.student_id)
    ))),1) avg_days
    FROM edu_activities ea WHERE ea.type='system' AND ea.notes LIKE '%→%' AND ea.created_at BETWEEN ? AND ?
    GROUP BY ea.notes ORDER BY ea.notes`, from, to)

  // Daily new students trend
  const daily = all(`SELECT date(s.created_at, '+5 hours') d, count(*) n ${EDU_FROM}
    WHERE s.created_at BETWEEN ? AND ? AND ${w} GROUP BY d ORDER BY d`, from, to, ...p)

  // Payments summary
  const payments = all(`SELECT ep.type, count(*) count, sum(ep.amount) total, ep.currency
    FROM edu_payments ep JOIN edu_students s ON s.id=ep.student_id
    WHERE ep.created_at BETWEEN ? AND ? AND ${w.replace(/\bs\./g, 's.')}
    GROUP BY ep.type, ep.currency ORDER BY total DESC`, from, to, ...p)

  res.json({ from: fromDay, to: toDay, counselors, byCountry, byUniversity, byIntake, stageAvg, daily, payments })
})

// ---------- Student Reassignment & Bulk Actions ----------
app.post('/api/edu/students/bulk-assign', eduGuard, (req, res) => {
  const ids = Array.isArray(req.body.student_ids) ? req.body.student_ids.map(Number).filter(Boolean) : []
  if (!ids.length) throw err(400, 'Pick at least one student')
  const counselorId = +req.body.counselor_id
  const target = one(`SELECT * FROM users WHERE id=? AND active=1 AND role IN ('agent','team_lead')`, counselorId)
  if (!target) throw err(400, 'Pick an active counselor')
  const reason = req.body.reason?.trim() || 'Bulk reassignment'

  const [w, p] = eduScope(req.user)
  const accessible = all(`SELECT s.id, s.counselor_id, c.name FROM edu_students s JOIN contacts c ON c.id=s.contact_id
    WHERE s.id IN (${ids.map(() => '?').join(',')}) AND ${w}`, ...ids, ...p)

  let moved = 0
  for (const s of accessible) {
    if (s.counselor_id === target.id) continue
    run('UPDATE edu_students SET counselor_id=?, updated_at=? WHERE id=?', target.id, now(), s.id)
    eduActivity(s.id, req.user.id, 'system', `Reassigned to ${target.name} by ${req.user.name}: ${reason}`)
    notify(target.id, `${s.name} was assigned to you by ${req.user.name} (${reason})`, null)
    moved++
  }

  log(req, 'bulk_reassign', 'edu_students', null, { target_id: target.id, count: moved, total_requested: ids.length, reason })
  res.json({ ok: true, moved, total: accessible.length })
})

// ---------- Student Import & Export ----------
app.get('/api/edu/students/export', eduGuard, (req, res) => {
  const [w, p] = eduScope(req.user)
  const where = [w], params = [...p]
  const q = req.query
  if (q.stage) { where.push('s.stage=?'); params.push(eduStage(q.stage)) }
  if (q.counselor_id) { where.push('s.counselor_id=?'); params.push(+q.counselor_id) }
  if (q.branch_id) { where.push('s.branch_id=?'); params.push(+q.branch_id) }
  if (q.q) { const like = `%${q.q}%`; where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR s.institution LIKE ? OR s.passport LIKE ?)'); params.push(like, like, like, like, like) }

  const from = `${EDU_FROM} WHERE ${where.join(' AND ')}`
  const rows = all(`SELECT s.id, c.name, c.phone, c.email, c.cnic, s.gender, s.dob, s.city, s.passport, s.passport_expiry,
    s.current_level, s.institution, s.graduate_year, s.gpa, s.major, s.ielts, s.toefl, s.gre, s.gmat,
    s.target_level, s.target_countries, s.intake, s.stage, s.stage_at, u.name counselor_name,
    s.visa_type, s.visa_app_number, s.cas_coe_number, s.visa_outcome, s.created_at
    ${from} ORDER BY s.id DESC`, ...params)

  audit(req.user.id, 'export', 'edu_students', null, { count: rows.length, query: q }, req.ip)
  res.type('text/csv').attachment(`students-${Date.now()}.csv`)
    .send(L.toCsv([[`Exported by ${req.user.name} (${req.user.email}) at ${now()}. Confidential.`], Object.keys(rows[0] || { id: 0 }), ...rows.map(Object.values)]))
})

app.post('/api/edu/students/import', eduGuard, (req, res) => {
  const rows = req.body.rows || []
  const report = rows.map((row, i) => {
    try {
      const name = String(row.name || '').trim()
      const phone = L.normalizePhone(row.phone || '')
      if (!name) throw err(400, 'Name is required')
      if (!phone) throw err(400, 'A valid phone number is required')
      const email = row.email ? String(row.email).trim().toLowerCase() : null
      const existingContact = findContact(phone, email)
      const existingStudent = existingContact ? one('SELECT id FROM edu_students WHERE contact_id=?', existingContact.id) : null

      if (!req.body.commit) {
        return { row: i + 1, name, phone, status: existingStudent ? 'duplicate' : 'ok' }
      }

      if (existingStudent) {
        return { row: i + 1, name, phone, status: 'duplicate', student_id: existingStudent.id }
      }

      const contact = existingContact ?? { id: run('INSERT INTO contacts(name,phone,email,cnic,created_at) VALUES(?,?,?,?,?)',
        name, phone, email, row.cnic || null, now()).lastInsertRowid }

      const f = pick(row, EDU_FIELDS)
      const stage = row.stage && S('edu_stages').includes(row.stage) ? row.stage : S('edu_stages')[0]
      const counselorId = row.counselor_id && !isNaN(+row.counselor_id) ? +row.counselor_id : req.user.id

      const cols = ['contact_id', 'branch_id', 'counselor_id', 'stage', 'stage_at', ...Object.keys(f), 'created_by', 'created_at']
      const vals = [contact.id, req.user.branch_id, counselorId, stage, now(), ...Object.values(f), req.user.id, now()]
      const id = run(`INSERT INTO edu_students(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...vals).lastInsertRowid

      eduActivity(id, req.user.id, 'note', `Student imported via CSV`)
      return { row: i + 1, name, phone, status: 'ok', student_id: id }
    } catch (e) {
      return { row: i + 1, status: 'error', message: e.message }
    }
  })

  if (req.body.commit) log(req, 'import', 'edu_students', null, { rows: rows.length, ok: report.filter(r => r.status === 'ok').length })
  res.json({ report })
})

// ---------- Edu Commissions (Placement commissions) ----------
app.get('/api/edu/commissions', eduGuard, (req, res) => {
  const [w, p] = eduScope(req.user)
  res.json(all(`SELECT ec.*, s.id student_id, c.name student_name, c.phone student_phone, s.stage student_stage,
    p.name program_name, u.name university_name, u.country university_country,
    cu.name counselor_name, a.status application_status
    FROM edu_commissions ec JOIN edu_students s ON s.id=ec.student_id
    JOIN contacts c ON c.id=s.contact_id
    LEFT JOIN edu_applications a ON a.id=ec.application_id
    LEFT JOIN edu_programs p ON p.id=a.program_id
    LEFT JOIN edu_universities u ON u.id=p.university_id
    LEFT JOIN users cu ON cu.id=ec.user_id
    WHERE ${w.replace(/\bs\./g, 's.')} ORDER BY ec.id DESC`, ...p))
})

app.post('/api/edu/commissions', eduGuard, (req, res) => {
  const studentId = +req.body.student_id
  const s = scopedEdu(req.user, studentId)
  const amount = +req.body.amount
  if (!amount || amount <= 0) throw err(400, 'Valid commission amount is required')

  const id = run(`INSERT INTO edu_commissions(student_id,application_id,user_id,type,amount,currency,status,note,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, s.id, req.body.application_id ? +req.body.application_id : null,
    req.body.user_id ? +req.body.user_id : (s.counselor_id || req.user.id),
    req.body.type || 'counselor', amount, req.body.currency || 'PKR', 'pending',
    req.body.note || null, req.user.id, now()).lastInsertRowid

  eduActivity(s.id, req.user.id, 'note', `Placement commission recorded: ${req.body.currency || 'PKR'} ${amount.toLocaleString()}`)
  log(req, 'create', 'edu_commission', id, { student_id: s.id, amount })
  res.json({ id })
})

app.post('/api/edu/commissions/:id/pay', guard('payments'), (req, res) => {
  if (!isDate(req.body.paid_on) || req.body.paid_on > today()) throw err(400, 'Valid payment date is required')
  if (!run(`UPDATE edu_commissions SET status='paid', paid_on=?, ref=?, note=COALESCE(?, note) WHERE id=? AND status='pending'`,
    req.body.paid_on, req.body.ref?.trim() || null, req.body.note?.trim() || null, req.params.id).changes) {
    throw err(400, 'Commission is not in pending status')
  }
  log(req, 'pay_edu_commission', 'edu_commission', +req.params.id, req.body)
  res.json({ ok: true })
})

app.post('/api/edu/commissions/:id/cancel', guard('payments'), (req, res) => {
  const note = req.body.note?.trim()
  if (!note) throw err(400, 'Cancellation reason is required')
  run(`UPDATE edu_commissions SET status='cancelled', note=? WHERE id=?`, note, req.params.id)
  log(req, 'cancel_edu_commission', 'edu_commission', +req.params.id, { note })
  res.json({ ok: true })
})

// ---- Settings › Facebook: connect a Page's Lead Ads in one step ----
const adminOnly = (req, _res, next) => (req.user.role === 'admin' ? next() : next(err(403, 'Only admins can change integrations')))
const mask = s => (s ? '••••' + s.slice(-4) : null)
app.get('/api/facebook', adminOnly, (_req, res) => {
  const c = fbConf()
  res.json({
    page_id: c.page_id ?? null, page_name: c.page_name ?? null, connected_at: c.connected_at ?? null, callback_url: c.callback_url ?? null,
    app_secret: mask(c.app_secret), page_token: mask(c.page_token),
    last_lead: one(`SELECT max(created_at) at, count(*) n FROM leads WHERE ext_id LIKE 'fb:%'`),
    recent: (S('fb_log') || []).slice(-8).reverse(),
  })
})
app.post('/api/facebook/connect', adminOnly, async (req, res) => {
  const b = req.body, secret = String(b.app_secret || '').trim() || fbConf().app_secret, token = String(b.token || '').trim()
  const base = String(b.public_url || '').trim().replace(/\/+$/, '')
  if (!secret || !token) throw err(400, 'Paste the App secret and an access token')
  if (!/^https:\/\/[^/]+$/.test(base) || /localhost|127\.0\.0\.1/.test(base)) throw err(400, 'Facebook needs the CRM at a public https address (e.g. https://crm.yourcompany.com). It cannot reach localhost.')
  const appId = (await graph('app', { access_token: token })).id
  const appToken = `${appId}|${secret}`
  const info = (await graph('debug_token', { input_token: token, access_token: appToken })).data // also proves the secret matches the app
  if (!info?.is_valid) throw err(400, 'That access token is not valid any more. Generate a new one.')
  const missing = ['leads_retrieval', 'pages_show_list', 'pages_manage_metadata'].filter(p => !(info.scopes || []).includes(p))
  if (info.type === 'USER' && missing.length) throw err(400, `The token is missing permissions: ${missing.join(', ')}. Tick them in Graph API Explorer and generate again.`)
  let page, userToken
  if (info.type === 'USER') { // swap for a long-lived user token: page tokens made from it never expire
    const long = (await graph('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: secret, fb_exchange_token: token })).access_token
    userToken = long
    const pages = (await graph('me/accounts', { fields: 'id,name,access_token', access_token: long })).data || []
    if (!pages.length) throw err(400, 'This Facebook account does not manage any Page (or the Page was not ticked when generating the token).')
    page = pages.find(p => p.id === b.page_id) || (pages.length === 1 && pages[0])
    if (!page) return res.json({ pages: pages.map(p => ({ id: p.id, name: p.name })) }) // more than one: ask which
  } else if (info.type === 'PAGE') {
    if (info.expires_at) throw err(400, 'This Page token expires. Paste the user token from Graph API Explorer instead, and the CRM will make a permanent one.')
    const me = await graph('me', { fields: 'id,name', access_token: token })
    page = { ...me, access_token: token }
  } else throw err(400, 'Use a user or Page access token from Graph API Explorer')
  const verify = fbConf().verify_token || crypto.randomBytes(16).toString('hex'), callback = base + '/api/webhooks/facebook'
  const save = extra => run(`INSERT INTO settings VALUES('facebook',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    JSON.stringify({ verify_token: verify, app_secret: secret, page_token: page.access_token, page_id: page.id, page_name: page.name, app_id: appId, callback_url: callback, user_token: userToken ?? fbConf().user_token, ...extra }))
  save({}) // saved first: Facebook calls our webhook to check the verify token while we subscribe
  try {
    await graph(`${appId}/subscriptions`, { object: 'page', callback_url: callback, verify_token: verify, fields: 'leadgen', include_values: 'true', access_token: appToken }, 'POST')
  } catch (e) { throw err(400, `${e.message} Check that ${base} is online and opens this CRM.`) }
  await graph(`${page.id}/subscribed_apps`, { subscribed_fields: 'leadgen', access_token: page.access_token }, 'POST')
  save({ connected_at: now() })
  run(`DELETE FROM settings WHERE key='fb_log'`) // fresh delivery history for the new connection
  log(req, 'facebook_connect', 'setting', null, { page_id: page.id, page_name: page.name, app_id: appId })
  res.json({ ok: true, page_name: page.name })
})
app.post('/api/facebook/disconnect', adminOnly, async (req, res) => {
  const c = fbConf()
  if (c.page_id) await graph(`${c.page_id}/subscribed_apps`, { access_token: c.page_token }, 'DELETE').catch(() => {}) // best effort: token may already be revoked
  run(`DELETE FROM settings WHERE key='facebook'`)
  log(req, 'facebook_disconnect', 'setting', null, { page_id: c.page_id })
  res.json({ ok: true })
})

// ---- Assistant: natural-language questions answered from scoped, read-only metrics (Groq) ----
const GROQ_URL = () => process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'
const KARACHI_TODAY = () => { const d = new Date(Date.now() + 5 * 3600e3); return d.toISOString().slice(0, 10) }
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const assistantRange = q => {
  const from = DAY_RE.test(q.from || '') ? q.from : new Date(Date.now() - 29 * 864e5 + 5 * 3600e3).toISOString().slice(0, 10)
  const to = DAY_RE.test(q.to || '') ? q.to : KARACHI_TODAY()
  return { fromISO: new Date(`${from}T00:00:00+05:00`).toISOString(), toISO: new Date(`${to}T23:59:59.999+05:00`).toISOString(), from, to }
}
const ASSISTANT_SCHEMAS = [
  { type: 'function', function: { name: 'sales_summary', description: 'Period totals: leads, contacted, booked, SLA compliance, sales value, commissions. Use when asked about overall sales/numbers.', parameters: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD in Asia/Karachi' }, to: { type: 'string', description: 'YYYY-MM-DD in Asia/Karachi' } } } } },
  { type: 'function', function: { name: 'agent_leaderboard', description: 'Per-agent performance: leads, calls, visits, bookings, sales value, commission earned. Use when asked about agents, team performance or commissions.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } } },
  { type: 'function', function: { name: 'pipeline_overview', description: 'Current lead counts grouped by pipeline status.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'top_sources', description: 'Lead counts and bookings grouped by source and campaign for a period.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } } },
  { type: 'function', function: { name: 'find_leads', description: 'Search leads by name or phone substring, optionally filtered by status. Returns at most 20.', parameters: { type: 'object', properties: { search: { type: 'string' }, status: { type: 'string', description: 'optional pipeline status, e.g. New, Booked, Lost' }, limit: { type: 'integer' } }, required: ['search'] } } },
]
const assistantTools = u => {
  const [w, p] = scope(u)
  const visibleAgents = `SELECT l.agent_id FROM leads l WHERE l.deleted=0 AND ${w}`
  return {
    sales_summary: q => {
      const { fromISO, toISO, from, to } = assistantRange(q)
      const kpi = one(`SELECT count(*) leads, sum(l.first_contact_at IS NOT NULL) contacted, sum(l.status='Booked') booked,
          round(avg((julianday(l.first_contact_at)-julianday(l.assigned_at))*1440)) avg_response_min,
          sum(NOT EXISTS(SELECT 1 FROM sla_breaches b WHERE b.lead_id=l.id)) within_sla
        FROM leads l WHERE l.deleted=0 AND ${w} AND l.created_at BETWEEN ? AND ?`, ...p, fromISO, toISO)
      // Money is per agent, not per lead row: scope it to agents the user can see, sum once
      const sales = one(`SELECT COALESCE(sum(a.price),0) n FROM allotments a WHERE a.status='active' AND a.sale_date BETWEEN ? AND ? AND a.agent_id IN (${visibleAgents})`, fromISO, toISO, ...p).n
      const commission = one(`SELECT COALESCE(sum(c.amount),0) n FROM commissions c JOIN allotments a ON a.id=c.allotment_id
        WHERE c.status<>'cancelled' AND a.sale_date BETWEEN ? AND ? AND c.user_id IN (${visibleAgents})`, fromISO, toISO, ...p).n
      return { period: { from, to }, ...kpi, sales, commission }
    },
    agent_leaderboard: q => {
      const { fromISO, toISO, from, to } = assistantRange(q)
      // Parameter order follows appearance: two subqueries, then scope, then the BETWEEN pair
      const rows = all(`SELECT u.name, count(l.id) leads, sum(l.first_contact_at IS NOT NULL) contacted, sum(l.status='Booked') booked,
          (SELECT COALESCE(sum(a.price),0) FROM allotments a WHERE a.agent_id=u.id AND a.status='active' AND a.sale_date BETWEEN ? AND ?) sales,
          (SELECT COALESCE(sum(c.amount),0) FROM commissions c JOIN allotments a ON a.id=c.allotment_id WHERE c.user_id=u.id AND c.status<>'cancelled' AND a.sale_date BETWEEN ? AND ?) commission
        FROM leads l JOIN users u ON u.id=l.agent_id
        WHERE l.deleted=0 AND ${w} AND l.created_at BETWEEN ? AND ? GROUP BY u.id ORDER BY booked DESC, leads DESC LIMIT 10`,
        fromISO, toISO, fromISO, toISO, ...p, fromISO, toISO)
      return { period: { from, to }, rows }
    },
    pipeline_overview: () => ({ rows: all(`SELECT l.status, count(*) n FROM leads l WHERE l.deleted=0 AND ${w} GROUP BY l.status ORDER BY n DESC`, ...p) }),
    top_sources: q => {
      const { fromISO, toISO, from, to } = assistantRange(q)
      return { period: { from, to }, rows: all(`SELECT l.source, l.campaign, count(*) leads, sum(l.status='Booked') booked
        FROM leads l WHERE l.deleted=0 AND ${w} AND l.created_at BETWEEN ? AND ? GROUP BY l.source, l.campaign ORDER BY leads DESC LIMIT 10`, ...p, fromISO, toISO) }
    },
    find_leads: q => {
      const limit = Math.min(Math.max(+q.limit || 10, 1), 20)
      const search = String(q.search || '').trim()
      if (!search) return { error: 'search is required' }
      const status = String(q.status || '').trim()
      const like = `%${search.slice(0, 40)}%`
      const rows = all(`SELECT l.id, c.name, l.status, l.source, l.created_at, u.name agent_name, c.phone, l.next_action_at
        FROM leads l JOIN contacts c ON c.id=l.contact_id LEFT JOIN users u ON u.id=l.agent_id
        WHERE l.deleted=0 AND ${w}${status ? ' AND l.status=?' : ''} AND (c.name LIKE ? OR c.phone LIKE ?)
        ORDER BY l.id DESC LIMIT ?`, ...p, ...(status ? [status] : []), like, like, limit)
      return { rows: rows.map(r => maskRow(u, r)) }
    },
  }
}
app.post('/api/assistant', async (req, res) => {
  const key = process.env.GROQ_API_KEY
  if (!key) throw err(503, 'The assistant is not configured yet (missing GROQ_API_KEY)')
  const u = req.user
  rateHit(rateKey('assistant', u.id), 30, 60e3, 'The assistant is busy. Give it a moment and try again.')
  const history = Array.isArray(req.body.messages) ? req.body.messages.slice(-12) : []
  const fns = assistantTools(u)
  const msgs = [
    { role: 'system', content: `You are the built-in assistant of the Estate Centric CRM. Today is ${KARACHI_TODAY()} (Asia/Karachi). Answer the user's question about their sales business using the provided tools. Dates you pass to tools must be YYYY-MM-DD in Asia/Karachi. Amounts are in PKR. Be concise: a few sentences or a compact list. When a tool returns rows, summarize the key numbers rather than dumping everything. If the tools cannot answer, say so plainly.` },
    ...history.filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 4000) })),
  ]
  if (!msgs.some(m => m.role === 'user')) throw err(400, 'Ask a question first')
  const ask = withTools => fetch(`${GROQ_URL()}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', messages: msgs, temperature: 0.2, ...(withTools ? { tools: ASSISTANT_SCHEMAS } : {}) }),
  }).then(async r => {
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw err(502, `Assistant provider error: ${d.error?.message || r.statusText}`)
    return d.choices?.[0]?.message
  })
  for (let round = 0; round < 5; round++) {
    const msg = await ask(true)
    if (!msg) continue // provider hiccup: fall through to the no-tools answer below
    if (!msg.tool_calls?.length) return res.json({ reply: msg.content || 'No answer.', usage: null })
    msgs.push(msg)
    for (const call of msg.tool_calls) {
      const fn = fns[call.function?.name]
      let result
      if (!fn) result = { error: `Unknown tool ${call.function?.name}` }
      else {
        let args = {}
        try { args = JSON.parse(call.function.arguments || '{}') } catch { /* unparseable args: run with none */ }
        try { result = fn(args) } catch (e) { result = { error: e.message } }
      }
      msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }
  msgs.push({ role: 'user', content: 'Answer in your own words now, from the tool results above. Do not call any more tools.' })
  const final = await ask(false).catch(() => null)
  res.json({ reply: final?.content || 'The assistant could not turn that into an answer. Try naming a period, an agent or a lead.' })
})

// ---- Settings › Website forms: the key for POST /api/inbound ----
app.get('/api/integrations/inbound', adminOnly, (_req, res) =>
  res.json({ key: inboundKey() || null, from_env: !S('inbound_key') && !!process.env.INBOUND_API_KEY, website_leads_30d: one(`SELECT count(*) n FROM leads WHERE source='Website' AND created_at>?`, new Date(Date.now() - 30 * 864e5).toISOString()).n }))
app.post('/api/integrations/inbound/rotate', adminOnly, (req, res) => {
  run(`INSERT INTO settings VALUES('inbound_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(crypto.randomBytes(24).toString('hex')))
  log(req, 'rotate_inbound_key', 'setting', null)
  res.json({ key: inboundKey() })
})

// ---- agent reports: day / week (Mon–Sun) / month, in Pakistan time ----
const shiftDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10)
const pkStart = d => new Date(Date.parse(d + 'T00:00:00+05:00')).toISOString() // midnight PKT as a UTC timestamp
function periodRange(period, date) {
  const d = isDate(date) ? date : today()
  if (period === 'month') { const start = d.slice(0, 8) + '01'; return { start, end: L.addMonths(start, 1) } }
  if (period === 'week') { const start = shiftDay(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7)); return { start, end: shiftDay(start, 7) } }
  return { start: d, end: shiftDay(d, 1) } // end is exclusive
}
function reportRange(req) {
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day', { start, end } = periodRange(period, req.query.date)
  const [w, p] = userScope(req.user)
  const ids = all(`SELECT u.id FROM users u WHERE ${w}`, ...p).map(r => r.id)
  return { period, start, end, P: { from: pkStart(start), to: pkStart(end), fromD: start, toD: end, now: now(), closed: closedJson(), ids: JSON.stringify(ids) } }
}
const IN = col => `${col}>=@from AND ${col}<@to`
const AGENT_METRICS = `
  (SELECT count(*) FROM leads l WHERE l.agent_id=u.id AND l.deleted=0 AND ${IN('l.assigned_at')}) new_leads,
  (SELECT count(*) FROM leads l WHERE l.agent_id=u.id AND l.deleted=0 AND ${IN('l.assigned_at')} AND l.first_contact_at IS NOT NULL) contacted,
  (SELECT round(avg((julianday(l.first_contact_at)-julianday(l.assigned_at))*1440)) FROM leads l WHERE l.agent_id=u.id AND l.deleted=0 AND ${IN('l.assigned_at')} AND l.first_contact_at IS NOT NULL) avg_response_min,
  (SELECT count(*) FROM sla_breaches b WHERE b.user_id=u.id AND b.level=1 AND ${IN('b.created_at')}) sla_breaches,
  (SELECT count(*) FROM activities a WHERE a.user_id=u.id AND a.type='call' AND ${IN('a.created_at')}) calls,
  (SELECT count(*) FROM activities a WHERE a.user_id=u.id AND a.type='call' AND a.outcome IN ('Connected','Interested') AND ${IN('a.created_at')}) connected,
  (SELECT count(*) FROM activities a WHERE a.user_id=u.id AND a.type NOT IN ('system','call','offer') AND ${IN('a.created_at')}) other_activities,
  (SELECT count(*) FROM visits v WHERE v.agent_id=u.id AND ${IN('v.scheduled_at')}) visits_scheduled,
  (SELECT count(*) FROM visits v WHERE v.agent_id=u.id AND v.status='verified' AND ${IN('v.verified_at')}) visits_done,
  (SELECT count(*) FROM activities a WHERE a.user_id=u.id AND a.type='offer' AND ${IN('a.created_at')}) offers,
  (SELECT count(*) FROM allotments a WHERE a.agent_id=u.id AND a.status='active' AND a.sale_date>=@fromD AND a.sale_date<@toD) bookings,
  (SELECT COALESCE(sum(a.price),0) FROM allotments a WHERE a.agent_id=u.id AND a.status='active' AND a.sale_date>=@fromD AND a.sale_date<@toD) sales,
  (SELECT COALESCE(sum(c.amount),0) FROM commissions c JOIN allotments a ON a.id=c.allotment_id WHERE c.user_id=u.id AND c.status<>'cancelled' AND a.sale_date>=@fromD AND a.sale_date<@toD) commission,
  (SELECT count(*) FROM leads l WHERE l.agent_id=u.id AND l.deleted=0 AND l.status='Lost' AND ${IN('l.lost_at')}) lost,
  (SELECT count(*) FROM leads l WHERE l.agent_id=u.id AND l.deleted=0 AND l.status NOT IN (SELECT value FROM json_each(@closed))) open_now,
  (SELECT count(*) FROM leads l WHERE l.agent_id=u.id AND l.deleted=0 AND l.next_action_at<@now AND l.status NOT IN (SELECT value FROM json_each(@closed))) overdue_now`
const REPORT_USERS = `FROM users u WHERE u.id IN (SELECT value FROM json_each(@ids))
  AND (u.role IN ('agent','team_lead') OR EXISTS(SELECT 1 FROM leads WHERE agent_id=u.id AND deleted=0))`

app.get('/api/reports/agents', (req, res) => {
  const { period, start, end, P } = reportRange(req)
  res.json({ period, start, end: shiftDay(end, -1), rows: all(`SELECT u.id, u.name, u.role, u.active, ${AGENT_METRICS} ${REPORT_USERS} AND u.active=1 ORDER BY sales DESC, calls DESC, u.name`, P) })
})
app.get('/api/reports/agents/:id', (req, res) => {
  const { period, start, end, P } = reportRange(req), id = +req.params.id
  const agent = one(`SELECT u.id, u.name, u.role, ${AGENT_METRICS} ${REPORT_USERS} AND u.id=@id`, { ...P, id })
  if (!agent) throw err(404, 'Agent not found or outside your view')
  const day = col => `date(${col}, '+5 hours')` // Pakistan calendar day
  const series = (sql, key) => Object.fromEntries(all(sql, { ...P, id }).map(r => [r.d, r[key]]))
  const acts = Object.fromEntries(all(`SELECT ${day('created_at')} d, sum(type='call') calls, sum(type NOT IN ('system','call','offer')) other FROM activities
    WHERE user_id=@id AND ${IN('created_at')} GROUP BY d`, { ...P, id }).map(r => [r.d, r]))
  const leads = series(`SELECT ${day('assigned_at')} d, count(*) n FROM leads WHERE agent_id=@id AND deleted=0 AND ${IN('assigned_at')} GROUP BY d`, 'n')
  const visits = series(`SELECT ${day('verified_at')} d, count(*) n FROM visits WHERE agent_id=@id AND status='verified' AND ${IN('verified_at')} GROUP BY d`, 'n')
  const sales = series(`SELECT sale_date d, count(*) n FROM allotments WHERE agent_id=@id AND status='active' AND sale_date>=@fromD AND sale_date<@toD GROUP BY d`, 'n')
  const days = []
  for (let d = start; d < end; d = shiftDay(d, 1)) days.push({ date: d, new_leads: leads[d] || 0, calls: acts[d]?.calls || 0, other_activities: acts[d]?.other || 0, visits_done: visits[d] || 0, bookings: sales[d] || 0 })
  res.json({
    period, start, end: shiftDay(end, -1), agent, days,
    activities: all(`SELECT a.id, a.type, a.outcome, a.notes, a.created_at, a.lead_id, c.name lead_name FROM activities a JOIN leads l ON l.id=a.lead_id JOIN contacts c ON c.id=l.contact_id
      WHERE a.user_id=@id AND a.type<>'system' AND ${IN('a.created_at')} ORDER BY a.id DESC LIMIT 300`, { ...P, id }),
    bookings: all(`SELECT a.id, a.allotment_no, a.price, a.sale_date, p.name project, un.block, un.unit_no, c.name client FROM allotments a JOIN projects p ON p.id=a.project_id
      JOIN units un ON un.id=a.unit_id JOIN leads l ON l.id=a.lead_id JOIN contacts c ON c.id=l.contact_id
      WHERE a.agent_id=@id AND a.status='active' AND a.sale_date>=@fromD AND a.sale_date<@toD ORDER BY a.sale_date`, { ...P, id }),
  })
})

// ---- Settings › Maps: MapTiler key for the satellite map (a browser key: restrict it to your domain at maptiler.com) ----
app.put('/api/integrations/maptiler', adminOnly, (req, res) => {
  const key = String(req.body.key || '').trim()
  if (key && !/^[A-Za-z0-9]{10,64}$/.test(key)) throw err(400, 'That does not look like a MapTiler key')
  if (key) putSetting('maptiler_key', key); else run(`DELETE FROM settings WHERE key='maptiler_key'`)
  log(req, 'maptiler_key', 'setting', null, { set: !!key })
  res.json({ ok: true })
})

// ---- custom roles (admin) ----
const slug = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const putSetting = (k, v) => run(`INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, JSON.stringify(v))
const allPerms = () => ({ ...DEFAULTS.permissions, ...S('permissions') })
const customRole = key => {
  const r = (S('custom_roles') || []).find(x => x.key === key)
  if (!r) throw err(404, BUILT_IN_ROLES.some(x => x.key === key) ? 'Built-in roles cannot be renamed or deleted (their permissions can be changed)' : 'Role not found')
  return r
}
app.get('/api/roles', adminOnly, (_req, res) => res.json({
  roles: roles().map(r => ({ ...r, users: one('SELECT count(*) n FROM users WHERE role=? AND active=1', r.key).n })), permissions: allPerms(), access: ACCESS,
}))
app.post('/api/roles', adminOnly, (req, res) => {
  const label = String(req.body.label || '').trim(), key = slug(label), { access, copy_from } = req.body
  if (!key) throw err(400, 'Role name is required')
  if (roles().some(r => r.key === key || r.label.toLowerCase() === label.toLowerCase())) throw err(400, `A role called ${label} already exists`)
  if (!ACCESS.includes(access)) throw err(400, 'Pick which leads this role can see')
  tx(() => {
    putSetting('custom_roles', [...(S('custom_roles') || []), { key, label, access }])
    if (copy_from) putSetting('permissions', Object.fromEntries(Object.entries(allPerms()).map(([p, list]) => [p, list.includes(copy_from) ? [...list, key] : list])))
  })()
  log(req, 'create_role', 'setting', null, { key, label, access, copy_from })
  res.json({ key })
})
app.patch('/api/roles/:key', adminOnly, (req, res) => {
  const r = customRole(req.params.key), label = req.body.label?.trim() || r.label, access = req.body.access || r.access
  if (!ACCESS.includes(access)) throw err(400, 'Pick which leads this role can see')
  putSetting('custom_roles', S('custom_roles').map(x => (x.key === r.key ? { ...x, label, access } : x)))
  log(req, 'update_role', 'setting', null, { key: r.key, label, access })
  res.json({ ok: true })
})
app.delete('/api/roles/:key', adminOnly, (req, res) => {
  const r = customRole(req.params.key), n = one('SELECT count(*) n FROM users WHERE role=?', r.key).n
  if (n) throw err(400, `${n} user(s) still have the ${r.label} role. Give them another role first.`)
  tx(() => {
    putSetting('custom_roles', S('custom_roles').filter(x => x.key !== r.key))
    putSetting('permissions', Object.fromEntries(Object.entries(allPerms()).map(([p, list]) => [p, list.filter(x => x !== r.key)])))
  })()
  log(req, 'delete_role', 'setting', null, { key: r.key })
  res.json({ ok: true })
})

// ---- weekly email report ----
function weeklyReport() {
  const to = today(), from = new Date(Date.parse(to) - 7 * 864e5).toISOString().slice(0, 10), fromTs = from + 'T00:00:00'
  const n = (sql, ...p) => one(sql, ...p).n
  const leads = n('SELECT count(*) n FROM leads WHERE deleted=0 AND created_at>=?', fromTs)
  const sales = one(`SELECT count(*) n, COALESCE(sum(price),0) v FROM allotments WHERE status='active' AND sale_date>=?`, from)
  const collected = n(`SELECT ${PAID_SUM} n FROM payments WHERE voided_at IS NULL AND paid_on>=?`, from)
  const overdue = all(`SELECT a.id, a.price, (SELECT COALESCE(sum(amount),0) FROM installments WHERE allotment_id=a.id AND due_date<?) due,
    (SELECT ${PAID_SUM} FROM payments WHERE allotment_id=a.id AND voided_at IS NULL) paid FROM allotments a WHERE a.status='active'`, to)
    .reduce((s, r) => s + Math.max(0, r.due - r.paid), 0)
  const sources = all('SELECT source, count(*) n FROM leads WHERE deleted=0 AND created_at>=? GROUP BY source ORDER BY n DESC LIMIT 5', fromTs)
  const agents = all(`SELECT u.name, count(a.id) n, COALESCE(sum(a.price),0) v FROM allotments a JOIN users u ON u.id=a.agent_id
    WHERE a.status='active' AND a.sale_date>=? GROUP BY u.id ORDER BY v DESC LIMIT 5`, from)
  const breaches = n('SELECT count(*) n FROM sla_breaches WHERE created_at>=?', fromTs)
  const pendingComm = n(`SELECT COALESCE(sum(amount),0) n FROM commissions WHERE status='pending'`)
  const rs = v => 'PKR ' + Math.round(v).toLocaleString('en-PK')
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const row = (k, v) => `<tr><td style="padding:6px 12px;color:#666">${k}</td><td style="padding:6px 12px;font-weight:700">${v}</td></tr>`
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px">
<h2 style="margin:0 0 4px">Weekly sales & collections</h2><p style="color:#666;margin:0 0 16px">${from} to ${to}</p>
<table style="border-collapse:collapse;width:100%">${row('New leads', leads)}${row('SLA breaches', breaches)}${row('Plots sold / booked', `${sales.n} · ${rs(sales.v)}`)}
${row('Collected', rs(collected))}${row('Overdue now', rs(overdue))}${row('Commission pending', rs(pendingComm))}</table>
<h3>Top sources</h3><p>${sources.map(s => `${esc(s.source)}: ${s.n}`).join(' · ') || 'No new leads'}</p>
<h3>Top agents by sales</h3><p>${agents.map(a => `${esc(a.name)}: ${a.n} (${rs(a.v)})`).join('<br>') || 'No sales this week'}</p></div>`
  return { subject: `Weekly report ${from} – ${to}: ${sales.n} sales, ${rs(collected)} collected`, html }
}
function sendWeeklyReport() {
  const to = S('weekly_report').recipients || []
  if (!to.length) return false
  const r = weeklyReport()
  sendEmail(to, r.subject, r.html)
  run(`INSERT INTO settings VALUES('weekly_report_sent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(today()))
  return true
}
function reportTick() { // runs every minute; sends once on the configured weekday/hour (Pakistan time)
  const c = S('weekly_report'), pk = new Date(Date.now() + 5 * 3600e3)
  if (pk.getUTCDay() === +c.weekday && pk.getUTCHours() >= +c.hour && S('weekly_report_sent') !== today()) sendWeeklyReport()
}
app.get('/api/reports/weekly', guard('settings'), (_req, res) => res.type('html').send(weeklyReport().html))
app.post('/api/reports/weekly/send', guard('settings'), (req, res) => {
  if (!sendWeeklyReport()) throw err(400, 'Add recipients to the weekly_report setting first')
  log(req, 'send_report', 'report', null)
  res.json({ ok: true })
})

// ---- managed properties: owners, tenants, leases, rent, maintenance, owner statements ----
const PROPERTY_FIELDS = ['title', 'kind', 'society', 'phase', 'block', 'street', 'number', 'address', 'city', 'size', 'uom', 'bedrooms', 'agent_id', 'managed', 'mgmt_fee_pct', 'lat', 'lng', 'outline', 'notes']
const LEASE_FIELDS = ['start_date', 'end_date', 'rent', 'deposit', 'increase_pct', 'police_reg_no', 'agreement_no', 'notes']
const RENT_METHODS = ['Cash', 'Bank transfer', 'Cheque', 'Online', 'JazzCash', 'Easypaisa']
// owners and tenants are contacts (one record per phone number), so the same person is recognised everywhere
function contactFor(c) {
  const phone = L.normalizePhone(c?.phone)
  if (!phone) throw err(400, `Invalid phone "${c?.phone ?? ''}"`)
  if (!c.name?.trim()) throw err(400, 'Name is required')
  const found = one('SELECT * FROM contacts WHERE phone=?', phone)
  if (found) { if (c.cnic && !found.cnic) run('UPDATE contacts SET cnic=? WHERE id=?', c.cnic, found.id); return found.id }
  return run('INSERT INTO contacts(name,phone,cnic,email,created_at) VALUES(?,?,?,?,?)', c.name.trim(), phone, c.cnic || null, c.email || null, now()).lastInsertRowid
}
const contactOut = (u, id) => {
  const c = id && one('SELECT id, name, phone, cnic, email FROM contacts WHERE id=?', id)
  return c && (can(u, 'view_phone') ? c : { ...c, phone: L.maskPhone(c.phone), cnic: c.cnic && '*****' })
}
// A tenant's leases on one property (original + renewals) are one rent account: arrears carry across renewals
function leaseState(l) { // rent due so far vs paid, and how close the end is
  const t = today()
  const chain = all('SELECT * FROM leases WHERE property_id=? AND tenant_contact_id=? ORDER BY start_date, id', l.property_id, l.tenant_contact_id)
  const due = chain.flatMap(x => L.rentSchedule({ ...x, end_date: x.ended_on && x.ended_on < x.end_date ? x.ended_on : x.end_date }, t))
  const paid = one(`SELECT COALESCE(sum(amount),0) n FROM rent_payments WHERE kind='rent' AND voided_at IS NULL
    AND lease_id IN (SELECT value FROM json_each(?))`, JSON.stringify(chain.map(x => x.id))).n
  const schedule = L.allocate(due, paid, t)
  const overdue = schedule.reduce((s, r) => s + (r.status === 'Overdue' ? r.amount - r.paid : 0), 0), days = L.daysLeft(l.end_date, t)
  return { schedule, overdue, days_left: days, next_due: L.rentSchedule({ ...l, end_date: l.end_date }, L.addMonths(t, 1)).find(r => r.due_date >= t) || null }
}
// map colour: overdue rent or ending within red days → red, within amber days → amber, let → green, empty → vacant
function propertyStatus(l, st) {
  if (!l) return 'Vacant'
  if (st.overdue > 0) return 'Rent overdue'
  if (st.days_left <= S('lease_red_days')) return 'Ending soon'
  if (st.days_left <= S('lease_amber_days')) return 'Ending'
  return 'Let'
}
const canEditProperty = (u, p) => can(u, 'properties') || p.agent_id === u.id
const propertyFor = id => {
  const p = one('SELECT * FROM properties WHERE id=?', id)
  if (!p) throw err(404, 'Property not found')
  return p
}
const areaList = () => all('SELECT id, name, kind, outline FROM areas').map(a => ({ ...a, outline: JSON.parse(a.outline) }))
const parseRing = v => {
  const ring = typeof v === 'string' ? JSON.parse(v) : v
  if (!Array.isArray(ring) || ring.length < 3 || ring.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== 'number'))) throw err(400, 'Bad outline: draw at least 3 corners')
  return ring
}
function propertyFields(b, old = {}) {
  const f = pick(b, PROPERTY_FIELDS)
  if ('managed' in f) f.managed = f.managed ? 1 : 0
  if ('lat' in f || 'lng' in f) for (const k of ['lat', 'lng']) if (f[k] != null && !(Math.abs(+f[k]) <= 180)) throw err(400, 'Bad map position')
  if (f.outline) f.outline = JSON.stringify(parseRing(f.outline)) // GeoJSON polygon ring: [[lng, lat], …]
  // a pin takes the names of the drawn society / phase / block it lands in, unless they were typed in this same save;
  // a moved pin drops names that came from areas it has left (hand-typed names stay)
  if (f.lat != null && f.lng != null) {
    const areas = areaList(), at = L.areasAt([+f.lng, +f.lat], areas)
    for (const [kind, k] of Object.entries(L.AREA_FIELD)) {
      if (b[k]) continue
      if (at[k]) f[k] = at[k]
      else if (old[k] && areas.some(a => a.kind === kind && a.name === old[k])) f[k] = null
    }
  }
  if (f.uom && !UOMS.includes(f.uom)) throw err(400, 'Unknown unit of measure')
  return f
}

app.get('/api/properties', (req, res) => {
  const rows = all(`SELECT p.*, o.name owner_name, o.phone owner_phone, ag.name agent_name FROM properties p LEFT JOIN contacts o ON o.id=p.owner_contact_id
    LEFT JOIN users ag ON ag.id=p.agent_id ORDER BY p.society, p.phase, p.block, p.number`)
  const leases = Object.fromEntries(all(`SELECT l.*, c.name tenant_name, c.phone tenant_phone FROM leases l JOIN contacts c ON c.id=l.tenant_contact_id WHERE l.status='active'`).map(l => [l.property_id, l]))
  const mask = !can(req.user, 'view_phone')
  res.json(rows.map(p => {
    const l = leases[p.id], st = l && leaseState(l)
    return {
      ...p, outline: p.outline && JSON.parse(p.outline), owner_phone: mask ? L.maskPhone(p.owner_phone) : p.owner_phone,
      status: propertyStatus(l, st), lease: l && { id: l.id, tenant_name: l.tenant_name, tenant_phone: mask ? L.maskPhone(l.tenant_phone) : l.tenant_phone, rent: l.rent, end_date: l.end_date, days_left: st.days_left, overdue: st.overdue },
    }
  }))
})
app.get('/api/properties/:id', (req, res) => {
  const p = propertyFor(req.params.id), u = req.user
  const leases = all('SELECT * FROM leases WHERE property_id=? ORDER BY start_date DESC, id DESC', p.id)
  const active = leases.find(l => l.status === 'active'), st = active && leaseState(active)
  const collected = one(`SELECT COALESCE(sum(r.amount),0) n FROM rent_payments r JOIN leases l ON l.id=r.lease_id WHERE l.property_id=? AND r.kind='rent' AND r.voided_at IS NULL`, p.id).n
  const ownerCosts = one(`SELECT COALESCE(sum(cost),0) n FROM maintenance WHERE property_id=? AND charge_to='Owner' AND status='Done'`, p.id).n
  const paidOut = one(`SELECT COALESCE(sum(amount),0) n FROM owner_payouts WHERE property_id=? AND voided_at IS NULL`, p.id).n
  const fee = Math.round(collected * (p.managed ? +p.mgmt_fee_pct || 0 : 0) / 100)
  log(req, 'view', 'property', p.id)
  res.json({
    property: { ...p, outline: p.outline && JSON.parse(p.outline) }, owner: contactOut(u, p.owner_contact_id), status: propertyStatus(active, st),
    can_edit: canEditProperty(u, p), can_money: canEditProperty(u, p) || can(u, 'payments'), methods: RENT_METHODS,
    lease: active && { ...active, tenant: contactOut(u, active.tenant_contact_id), ...st },
    history: leases.filter(l => l.status !== 'active').map(l => ({ ...l, tenant: contactOut(u, l.tenant_contact_id), arrears: l.tenant_contact_id === active?.tenant_contact_id ? 0 : leaseState(l).overdue })),
    payments: all(`SELECT r.*, us.name created_by_name FROM rent_payments r JOIN leases l ON l.id=r.lease_id LEFT JOIN users us ON us.id=r.created_by
      WHERE l.property_id=? ORDER BY r.paid_on DESC, r.id DESC`, p.id),
    maintenance: all('SELECT * FROM maintenance WHERE property_id=? ORDER BY status=\'Done\', id DESC', p.id),
    payouts: all('SELECT * FROM owner_payouts WHERE property_id=? ORDER BY paid_on DESC, id DESC', p.id),
    statement: { collected, fee, owner_costs: ownerCosts, paid_out: paidOut, balance: collected - fee - ownerCosts - paidOut },
  })
})
app.post('/api/properties', (req, res) => {
  if (!can(req.user, 'properties') && !can(req.user, 'manage_inventory') && req.user.role !== 'agent') throw err(403, 'You do not have permission for this')
  const f = propertyFields(req.body)
  if (!f.number && !f.title) throw err(400, 'Give the house / plot number or a title')
  const id = tx(() => {
    const owner = req.body.owner?.phone ? contactFor(req.body.owner) : null
    const vals = { kind: 'House', city: 'Lahore', ...f, agent_id: f.agent_id || req.user.id, owner_contact_id: owner, created_by: req.user.id, created_at: now(), updated_at: now() }
    return run(`INSERT INTO properties(${Object.keys(vals)}) VALUES(${Object.keys(vals).map(() => '?')})`, ...Object.values(vals)).lastInsertRowid
  })()
  log(req, 'create', 'property', id, f)
  res.json({ id })
})
app.patch('/api/properties/:id', (req, res) => {
  const p = propertyFor(req.params.id)
  if (!canEditProperty(req.user, p)) throw err(403, 'Only the property agent or a property manager can change this')
  const f = propertyFields(req.body, p)
  tx(() => {
    if (req.body.owner?.phone) f.owner_contact_id = contactFor(req.body.owner)
    if (Object.keys(f).length) run(`UPDATE properties SET ${Object.keys(f).map(k => k + '=?')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), p.id)
  })()
  log(req, 'update', 'property', p.id, { ...f, outline: f.outline && 'set' })
  res.json({ ok: true })
})

const leaseFor = id => {
  const l = one('SELECT * FROM leases WHERE id=?', id)
  if (!l) throw err(404, 'Lease not found')
  return { l, p: propertyFor(l.property_id) }
}
function leaseFields(b) {
  const f = pick(b, LEASE_FIELDS)
  for (const k of ['start_date', 'end_date']) if (k in f && !isDate(f[k])) throw err(400, 'Start and end dates are required')
  if ('rent' in f && !(+f.rent > 0)) throw err(400, 'Monthly rent is required')
  if (f.increase_pct != null && !(+f.increase_pct >= 0 && +f.increase_pct <= 100)) throw err(400, 'Yearly increase must be 0–100%')
  return f
}
app.post('/api/properties/:id/leases', (req, res) => {
  const p = propertyFor(req.params.id)
  if (!canEditProperty(req.user, p)) throw err(403, 'Only the property agent or a property manager can add a tenant')
  const f = leaseFields(req.body)
  if (!f.start_date || !f.end_date || !f.rent) throw err(400, 'Tenant, start, end and monthly rent are required')
  if (f.end_date <= f.start_date) throw err(400, 'End date must be after the start date')
  const id = tx(() => {
    if (one(`SELECT 1 FROM leases WHERE property_id=? AND status='active'`, p.id)) throw err(400, 'This property already has an active lease. End or renew it first.')
    const tenant = +req.body.tenant_contact_id || contactFor(req.body.tenant)
    const vals = { ...f, property_id: p.id, tenant_contact_id: tenant, created_by: req.user.id, created_at: now() }
    return run(`INSERT INTO leases(${Object.keys(vals)}) VALUES(${Object.keys(vals).map(() => '?')})`, ...Object.values(vals)).lastInsertRowid
  })()
  log(req, 'create', 'lease', id, f)
  res.json({ id })
})
app.patch('/api/leases/:id', (req, res) => {
  const { l, p } = leaseFor(req.params.id)
  if (!canEditProperty(req.user, p)) throw err(403, 'You do not have permission for this')
  const f = pick(req.body, ['police_reg_no', 'agreement_no', 'notes', 'deposit'])
  if (Object.keys(f).length) run(`UPDATE leases SET ${Object.keys(f).map(k => k + '=?')} WHERE id=?`, ...Object.values(f), l.id)
  log(req, 'update', 'lease', l.id, f)
  res.json({ ok: true })
})
// Renewal = a new lease for the same tenant starting where the old one ends; the old one keeps its own rent history
app.post('/api/leases/:id/renew', (req, res) => {
  const { l, p } = leaseFor(req.params.id)
  if (!canEditProperty(req.user, p)) throw err(403, 'You do not have permission for this')
  if (l.status !== 'active') throw err(400, 'Only an active lease can be renewed')
  const f = leaseFields({ ...l, start_date: l.end_date, notes: null, ...pick(req.body, ['end_date', 'rent', 'increase_pct', 'deposit', 'agreement_no', 'police_reg_no']) })
  if (f.end_date <= f.start_date) throw err(400, 'New end date must be after ' + f.start_date)
  const id = tx(() => {
    run(`UPDATE leases SET status='renewed', ended_on=? WHERE id=?`, l.end_date, l.id)
    const vals = { ...f, property_id: p.id, tenant_contact_id: l.tenant_contact_id, created_by: req.user.id, created_at: now() }
    return run(`INSERT INTO leases(${Object.keys(vals)}) VALUES(${Object.keys(vals).map(() => '?')})`, ...Object.values(vals)).lastInsertRowid
  })()
  log(req, 'renew', 'lease', l.id, { new_lease: id, end_date: f.end_date, rent: f.rent })
  res.json({ id })
})
app.post('/api/leases/:id/end', (req, res) => {
  const { l, p } = leaseFor(req.params.id)
  if (!canEditProperty(req.user, p)) throw err(403, 'You do not have permission for this')
  if (l.status !== 'active') throw err(400, 'Lease is not active')
  if (!isDate(req.body.ended_on)) throw err(400, 'Move-out date is required')
  run(`UPDATE leases SET status='ended', ended_on=?, end_note=? WHERE id=?`, req.body.ended_on, req.body.note?.trim() || null, l.id)
  log(req, 'end', 'lease', l.id, req.body)
  res.json({ ok: true })
})
app.post('/api/leases/:id/payments', (req, res) => {
  const { l, p } = leaseFor(req.params.id), b = req.body, amount = Math.round(+b.amount)
  if (!canEditProperty(req.user, p) && !can(req.user, 'payments')) throw err(403, 'You do not have permission for this')
  if (!['rent', 'deposit', 'deposit_refund'].includes(b.kind)) throw err(400, 'Pick rent, deposit or deposit refund')
  if (!(amount > 0)) throw err(400, 'Amount is required')
  if (!isDate(b.paid_on) || b.paid_on > today()) throw err(400, 'Date is required and cannot be in the future')
  if (!RENT_METHODS.includes(b.method)) throw err(400, 'Pick a payment method')
  const id = run(`INSERT INTO rent_payments(lease_id,kind,amount,paid_on,method,ref,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    l.id, b.kind, amount, b.paid_on, b.method, b.ref?.trim() || null, b.note?.trim() || null, req.user.id, now()).lastInsertRowid
  run('UPDATE rent_payments SET receipt_no=? WHERE id=?', `RR-${String(id).padStart(5, '0')}`, id)
  log(req, 'rent_' + b.kind, 'lease', l.id, { payment_id: id, amount })
  res.json({ id })
})
app.post('/api/rent-payments/:id/void', (req, res) => {
  const r = one('SELECT * FROM rent_payments WHERE id=? AND voided_at IS NULL', req.params.id)
  if (!r) throw err(404, 'Payment not found or already voided')
  const { p } = leaseFor(r.lease_id)
  if (!canEditProperty(req.user, p) && !can(req.user, 'payments')) throw err(403, 'You do not have permission for this')
  if (!req.body.note?.trim()) throw err(400, 'A reason is required')
  run('UPDATE rent_payments SET voided_at=?, void_note=? WHERE id=?', now(), req.body.note.trim(), r.id)
  log(req, 'void_rent', 'lease', r.lease_id, { payment_id: r.id, note: req.body.note })
  res.json({ ok: true })
})
app.get('/api/rent-payments/:id', (req, res) => { // receipt
  const r = one(`SELECT r.*, l.property_id, c.name tenant_name, c.cnic tenant_cnic, us.name created_by_name FROM rent_payments r JOIN leases l ON l.id=r.lease_id
    JOIN contacts c ON c.id=l.tenant_contact_id LEFT JOIN users us ON us.id=r.created_by WHERE r.id=?`, req.params.id)
  if (!r) throw err(404, 'Receipt not found')
  res.json({ ...r, tenant_cnic: can(req.user, 'view_phone') ? r.tenant_cnic : r.tenant_cnic && '*****', property: propertyFor(r.property_id) })
})

app.post('/api/properties/:id/maintenance', (req, res) => {
  const p = propertyFor(req.params.id), b = req.body
  if (!canEditProperty(req.user, p)) throw err(403, 'You do not have permission for this')
  if (!b.title?.trim()) throw err(400, 'What needs fixing?')
  const id = run('INSERT INTO maintenance(property_id,title,details,vendor,cost,charge_to,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
    p.id, b.title.trim(), b.details?.trim() || null, b.vendor?.trim() || null, +b.cost || null, ['Owner', 'Tenant', 'Company'].includes(b.charge_to) ? b.charge_to : 'Owner', req.user.id, now()).lastInsertRowid
  log(req, 'create', 'maintenance', id, b)
  res.json({ id })
})
app.patch('/api/maintenance/:id', (req, res) => {
  const m = one('SELECT * FROM maintenance WHERE id=?', req.params.id)
  if (!m) throw err(404, 'Job not found')
  if (!canEditProperty(req.user, propertyFor(m.property_id))) throw err(403, 'You do not have permission for this')
  const f = pick(req.body, ['status', 'cost', 'vendor', 'charge_to', 'details'])
  if (f.status && !['Open', 'In progress', 'Done'].includes(f.status)) throw err(400, 'Unknown status')
  if (f.status === 'Done' && m.status !== 'Done') f.done_at = now()
  if (Object.keys(f).length) run(`UPDATE maintenance SET ${Object.keys(f).map(k => k + '=?')} WHERE id=?`, ...Object.values(f), m.id)
  log(req, 'update', 'maintenance', m.id, f)
  res.json({ ok: true })
})
app.post('/api/properties/:id/payouts', (req, res) => {
  const p = propertyFor(req.params.id), b = req.body, amount = Math.round(+b.amount)
  if (!can(req.user, 'properties') && !can(req.user, 'payments')) throw err(403, 'Only accounts or property managers record owner payouts')
  if (!(amount > 0) || !isDate(b.paid_on)) throw err(400, 'Amount and date are required')
  const id = run('INSERT INTO owner_payouts(property_id,amount,paid_on,method,ref,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
    p.id, amount, b.paid_on, b.method || null, b.ref?.trim() || null, b.note?.trim() || null, req.user.id, now()).lastInsertRowid
  log(req, 'owner_payout', 'property', p.id, { payout_id: id, amount })
  res.json({ id })
})

// Society / phase / block boundaries drawn on the map; properties inside take their names
const AREA_KINDS = Object.keys(L.AREA_FIELD)
const canAreas = u => can(u, 'properties') || can(u, 'settings')
function retagArea(a) { // every pinned property inside the area gets its name
  const ring = typeof a.outline === 'string' ? JSON.parse(a.outline) : a.outline, col = L.AREA_FIELD[a.kind]
  for (const p of all('SELECT id, lat, lng FROM properties WHERE lat IS NOT NULL'))
    if (L.inPolygon([p.lng, p.lat], ring)) run(`UPDATE properties SET ${col}=?, updated_at=? WHERE id=?`, a.name, now(), p.id)
}
app.get('/api/areas', (_req, res) => res.json(areaList()))
app.post('/api/areas', (req, res) => {
  if (!canAreas(req.user)) throw err(403, 'You do not have permission for this')
  const name = String(req.body.name || '').trim(), { kind } = req.body
  if (!name || !AREA_KINDS.includes(kind)) throw err(400, 'Give the area a name and say whether it is a society, phase or block')
  const outline = JSON.stringify(parseRing(req.body.outline))
  const id = tx(() => {
    const id = run('INSERT INTO areas(name,kind,outline,created_by,created_at) VALUES(?,?,?,?,?)', name, kind, outline, req.user.id, now()).lastInsertRowid
    retagArea({ name, kind, outline })
    return id
  })()
  log(req, 'create', 'area', id, { name, kind })
  res.json({ id })
})
app.patch('/api/areas/:id', (req, res) => {
  if (!canAreas(req.user)) throw err(403, 'You do not have permission for this')
  const a = one('SELECT * FROM areas WHERE id=?', req.params.id)
  if (!a) throw err(404, 'Area not found')
  const f = { name: String(req.body.name ?? a.name).trim(), kind: req.body.kind ?? a.kind, outline: req.body.outline ? JSON.stringify(parseRing(req.body.outline)) : a.outline }
  if (!f.name || !AREA_KINDS.includes(f.kind)) throw err(400, 'Name and type are required')
  tx(() => {
    run('UPDATE areas SET name=?, kind=?, outline=? WHERE id=?', f.name, f.kind, f.outline, a.id)
    if (f.name !== a.name || f.kind !== a.kind) { // take the old label off properties inside the old outline only (another society may have a "Phase 6" too)
      const col = L.AREA_FIELD[a.kind], ring = JSON.parse(a.outline)
      for (const p of all(`SELECT id, lat, lng FROM properties WHERE lat IS NOT NULL AND ${col}=?`, a.name))
        if (L.inPolygon([p.lng, p.lat], ring)) run(`UPDATE properties SET ${col}=NULL WHERE id=?`, p.id)
    }
    retagArea(f)
  })()
  log(req, 'update', 'area', a.id, { name: f.name, kind: f.kind, outline: !!req.body.outline })
  res.json({ ok: true })
})
app.delete('/api/areas/:id', (req, res) => {
  if (!canAreas(req.user)) throw err(403, 'You do not have permission for this')
  const a = one('SELECT * FROM areas WHERE id=?', req.params.id)
  if (!a) throw err(404, 'Area not found')
  run('DELETE FROM areas WHERE id=?', a.id) // properties keep their society / phase / block text
  log(req, 'delete', 'area', a.id, { name: a.name })
  res.json({ ok: true })
})

// Uploaded society / phase maps, aligned over the satellite by their 4 corners (top-left, top-right, bottom-right, bottom-left)
const parseCorners = v => {
  const c = typeof v === 'string' ? JSON.parse(v) : v
  if (!Array.isArray(c) || c.length !== 4 || c.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== 'number' || !isFinite(n)))) throw err(400, 'Bad map corners')
  return JSON.stringify(c)
}
const overlayOut = o => ({ ...o, corners: JSON.parse(o.corners), visible: !!o.visible, clear_white: o.clear_white !== 0 })
app.get('/api/overlays', (_req, res) => res.json(all('SELECT id, token, name, area_id, width, height, corners, opacity, visible, clear_white, updated_at FROM overlays ORDER BY name').map(overlayOut)))
app.post('/api/overlays', (req, res) => {
  if (!canAreas(req.user)) throw err(403, 'You do not have permission for this')
  const name = String(req.body.name || '').trim(), m = String(req.body.data || '').match(/^data:(image\/(jpeg|png|webp));base64,/)
  if (!name) throw err(400, 'Name the map, e.g. DHA Phase 6')
  if (!m) throw err(400, 'Upload a JPG, PNG or WebP image of the map')
  const data = Buffer.from(req.body.data.slice(m[0].length), 'base64')
  if (data.length > 20e6) throw err(400, 'Image is too large (max 20 MB)')
  const id = run('INSERT INTO overlays(token,name,area_id,mime,data,width,height,corners,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    crypto.randomBytes(16).toString('hex'), name, +req.body.area_id || null, m[1], data, +req.body.width || null, +req.body.height || null, parseCorners(req.body.corners), req.user.id, now(), now()).lastInsertRowid
  log(req, 'create', 'overlay', id, { name })
  res.json({ id })
})
app.patch('/api/overlays/:id', (req, res) => {
  if (!canAreas(req.user)) throw err(403, 'You do not have permission for this')
  const f = pick(req.body, ['name', 'opacity', 'visible', 'corners', 'area_id', 'clear_white'])
  if ('corners' in f) f.corners = parseCorners(f.corners)
  for (const k of ['visible', 'clear_white']) if (k in f) f[k] = f[k] ? 1 : 0
  if ('opacity' in f && !(+f.opacity >= 0 && +f.opacity <= 1)) throw err(400, 'Opacity is 0–1')
  if (!Object.keys(f).length || !run(`UPDATE overlays SET ${Object.keys(f).map(k => k + '=?')}, updated_at=? WHERE id=?`, ...Object.values(f), now(), req.params.id).changes) throw err(404, 'Map not found')
  if ('corners' in f) log(req, 'align', 'overlay', +req.params.id)
  res.json({ ok: true })
})
app.delete('/api/overlays/:id', (req, res) => {
  if (!canAreas(req.user)) throw err(403, 'You do not have permission for this')
  if (!run('DELETE FROM overlays WHERE id=?', req.params.id).changes) throw err(404, 'Map not found')
  log(req, 'delete', 'overlay', +req.params.id)
  res.json({ ok: true })
})

// Lease alerts: once when a lease enters the amber window, once more at red (runs with the minute job)
function leaseTick() {
  const t = today(), amber = S('lease_amber_days'), red = S('lease_red_days')
  for (const l of all(`SELECT l.*, p.agent_id, COALESCE(p.title, p.society || ' ' || COALESCE(p.block,'') || ' ' || COALESCE(p.number,'')) label, c.name tenant
      FROM leases l JOIN properties p ON p.id=l.property_id JOIN contacts c ON c.id=l.tenant_contact_id WHERE l.status='active'`)) {
    const days = L.daysLeft(l.end_date, t), level = days <= red ? 2 : days <= amber ? 1 : 0
    if (level <= l.alert_level) continue
    const text = `Lease ending in ${days} days: ${l.label.trim()} (${l.tenant}), ends ${l.end_date}. Renew or re-let.`
    if (l.agent_id) notify(l.agent_id, text, null, { sms: level === 2 })
    all('SELECT * FROM users WHERE active=1').filter(u => can(u, 'properties') && u.id !== l.agent_id).forEach(u => notify(u.id, text)) // property managers too
    run('UPDATE leases SET alert_level=? WHERE id=?', level, l.id)
  }
}

// ---- unit photos ----
// ponytail: photos stored as data URLs in SQLite (client downsizes to ~1600px); move to object storage if the DB grows past a few GB
app.post('/api/units/:id/photos', guard('manage_inventory'), (req, res) => {
  const un = unitFor(req.params.id), data = String(req.body.data || '')
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(data)) throw err(400, 'Upload a JPEG, PNG or WebP image')
  if (data.length > 3e6) throw err(400, 'Image is too large')
  if (one('SELECT count(*) n FROM unit_photos WHERE unit_id=?', un.id).n >= 12) throw err(400, 'A unit can have up to 12 photos')
  const id = run('INSERT INTO unit_photos(unit_id,data,created_by,created_at) VALUES(?,?,?,?)', un.id, data, req.user.id, now()).lastInsertRowid
  log(req, 'add_photo', 'unit', un.id, { photo_id: id })
  res.json({ id })
})
app.delete('/api/units/:id/photos/:photo', guard('manage_inventory'), (req, res) => {
  if (!run('DELETE FROM unit_photos WHERE id=? AND unit_id=?', req.params.photo, req.params.id).changes) throw err(404, 'Photo not found')
  log(req, 'delete_photo', 'unit', +req.params.id, { photo_id: +req.params.photo })
  res.json({ ok: true })
})

// ---- dealers, commissions, targets (Phase 2) ----
// Commission is earned at allotment: the lead's agent and (if any) the dealer who brought the client, % of the sale price
function addCommissions(allotmentId, price, lead) {
  const c = S('commission'), dealer = lead.dealer_id && one('SELECT * FROM dealers WHERE id=?', lead.dealer_id)
  run('UPDATE allotments SET agent_id=?, dealer_id=? WHERE id=?', lead.agent_id, dealer?.id ?? null, allotmentId)
  const add = (userId, dealerId, rate) => rate > 0 && run('INSERT INTO commissions(allotment_id,user_id,dealer_id,rate,amount,created_at) VALUES(?,?,?,?,?,?)',
    allotmentId, userId, dealerId, rate, Math.round(price * rate / 100), now())
  if (lead.agent_id) add(lead.agent_id, null, one('SELECT commission_rate r FROM users WHERE id=?', lead.agent_id)?.r ?? (+c.agent_pct || 0))
  if (dealer) add(null, dealer.id, dealer.rate ?? (+c.dealer_pct || 0))
}
// whose agent figures a user can see: same ladder as lead scope
function userScope(u) {
  const a = u.role === 'marketing' ? 'own' : accessOf(u.role) // marketing sees every lead but not sales figures
  if (can(u, 'payments') || a === 'all') return ['1=1', []]
  if (a === 'branch') return ['u.branch_id=?', [u.branch_id]]
  if (a === 'team') return ['u.team_id=?', [u.team_id]]
  return ['u.id=?', [u.id]]
}

// earned counts live sales only, so a commission paid on a sale cancelled later shows as a negative balance (to recover)
const DEALER_STATS = `(SELECT COALESCE(sum(c.amount),0) FROM commissions c JOIN allotments a ON a.id=c.allotment_id WHERE c.dealer_id=d.id AND c.status<>'cancelled' AND a.status='active') earned,
  (SELECT COALESCE(sum(amount),0) FROM commissions WHERE dealer_id=d.id AND status='paid') paid,
  (SELECT count(*) FROM leads WHERE dealer_id=d.id AND deleted=0) leads,
  (SELECT count(*) FROM allotments WHERE dealer_id=d.id AND status='active') sales`
app.get('/api/dealers', guard('payments'), (_req, res) => res.json(all(`SELECT d.*, ${DEALER_STATS} FROM dealers d ORDER BY d.active DESC, d.name`)))
const dealerFields = b => {
  const f = pick(b, ['name', 'company', 'phone', 'rate', 'active'])
  if ('name' in f && !String(f.name || '').trim()) throw err(400, 'Name is required')
  if (f.rate != null && !(+f.rate >= 0 && +f.rate <= 20)) throw err(400, 'Rate must be 0–20%')
  if ('active' in f) f.active = f.active ? 1 : 0
  return f
}
app.post('/api/dealers', guard('payments'), (req, res) => {
  const f = dealerFields(req.body)
  if (!f.name) throw err(400, 'Name is required')
  const id = run(`INSERT INTO dealers(${Object.keys(f)},created_at) VALUES(${Object.keys(f).map(() => '?')},?)`, ...Object.values(f), now()).lastInsertRowid
  log(req, 'create', 'dealer', id, f)
  res.json({ id })
})
app.patch('/api/dealers/:id', guard('payments'), (req, res) => {
  const f = dealerFields(req.body)
  if (!Object.keys(f).length || !run(`UPDATE dealers SET ${Object.keys(f).map(k => k + '=?')} WHERE id=?`, ...Object.values(f), req.params.id).changes) throw err(404, 'Dealer not found')
  log(req, 'update', 'dealer', +req.params.id, f)
  res.json({ ok: true })
})

app.get('/api/commissions', (req, res) => {
  const [w, p] = userScope(req.user), dealers = can(req.user, 'payments')
  res.json(all(`SELECT c.*, a.allotment_no, a.price, a.status allotment_status, a.sale_date, pr.name project, un.block, un.unit_no, cl.name client,
      COALESCE(u.name, d.name) party, CASE WHEN c.dealer_id IS NULL THEN 'Agent' ELSE 'Dealer' END party_type
    FROM commissions c JOIN allotments a ON a.id=c.allotment_id JOIN projects pr ON pr.id=a.project_id JOIN units un ON un.id=a.unit_id
    JOIN leads l ON l.id=a.lead_id JOIN contacts cl ON cl.id=l.contact_id LEFT JOIN users u ON u.id=c.user_id LEFT JOIN dealers d ON d.id=c.dealer_id
    WHERE (c.user_id IS NOT NULL AND ${w}) OR (c.dealer_id IS NOT NULL AND ?) ORDER BY c.id DESC`, ...p, dealers ? 1 : 0))
})
app.post('/api/commissions/:id/pay', guard('payments'), (req, res) => {
  if (!isDate(req.body.paid_on) || req.body.paid_on > today()) throw err(400, 'Payment date is required and cannot be in the future')
  if (!run(`UPDATE commissions SET status='paid', paid_on=?, ref=?, paid_by=? WHERE id=? AND status='pending'`, req.body.paid_on, req.body.ref?.trim() || null, req.user.id, req.params.id).changes)
    throw err(400, 'Commission is not pending')
  log(req, 'pay_commission', 'commission', +req.params.id, req.body)
  res.json({ ok: true })
})

// Manual corrections, pending only and always with a reason (paid ones are settled; record a new adjustment instead)
const pendingCommission = id => {
  const c = one(`SELECT * FROM commissions WHERE id=? AND status='pending'`, id)
  if (!c) throw err(400, 'Only pending commissions can be changed')
  return c
}
app.patch('/api/commissions/:id', guard('payments'), (req, res) => {
  const c = pendingCommission(req.params.id), amount = Math.round(+req.body.amount), note = req.body.note?.trim()
  if (!(amount >= 0)) throw err(400, 'Amount is required')
  if (!note) throw err(400, 'A reason is required')
  run('UPDATE commissions SET amount=?, note=? WHERE id=?', amount, `Adjusted from PKR ${c.amount.toLocaleString('en-PK')}: ${note}`, c.id)
  log(req, 'adjust_commission', 'commission', c.id, { from: c.amount, to: amount, note })
  res.json({ ok: true })
})
app.post('/api/commissions/:id/cancel', guard('payments'), (req, res) => {
  const c = pendingCommission(req.params.id), note = req.body.note?.trim()
  if (!note) throw err(400, 'A reason is required')
  run(`UPDATE commissions SET status='cancelled', note=? WHERE id=?`, note, c.id)
  log(req, 'cancel_commission', 'commission', c.id, { note })
  res.json({ ok: true })
})

// Agent performance for a month: target vs sales value, bookings, commission, lead conversion
app.get('/api/performance', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7)
  const [w, p] = userScope(req.user)
  res.json({ month, rows: all(`SELECT u.id, u.name, u.role, t.amount target,
      (SELECT COALESCE(sum(price),0) FROM allotments WHERE agent_id=u.id AND status='active' AND substr(sale_date,1,7)=?) sales,
      (SELECT count(*) FROM allotments WHERE agent_id=u.id AND status='active' AND substr(sale_date,1,7)=?) bookings,
      (SELECT COALESCE(sum(c.amount),0) FROM commissions c JOIN allotments a ON a.id=c.allotment_id WHERE c.user_id=u.id AND c.status<>'cancelled' AND substr(a.sale_date,1,7)=?) commission,
      (SELECT count(*) FROM leads WHERE agent_id=u.id AND deleted=0 AND substr(assigned_at,1,7)=?) leads,
      (SELECT count(*) FROM leads WHERE agent_id=u.id AND deleted=0 AND substr(assigned_at,1,7)=? AND status='Booked') converted
    FROM users u LEFT JOIN targets t ON t.user_id=u.id AND t.month=?
    WHERE u.active=1 AND u.role IN ('agent','team_lead') AND ${w} ORDER BY sales DESC, u.name`, month, month, month, month, month, month, ...p) })
})
app.put('/api/targets', guard('payments'), (req, res) => {
  const { user_id, month } = req.body, amount = Math.round(+req.body.amount || 0)
  if (!/^\d{4}-\d{2}$/.test(month || '') || !one('SELECT 1 FROM users WHERE id=?', user_id)) throw err(400, 'Pick an agent and month')
  if (amount > 0) run('INSERT INTO targets VALUES(?,?,?) ON CONFLICT(user_id, month) DO UPDATE SET amount=excluded.amount', user_id, month, amount)
  else run('DELETE FROM targets WHERE user_id=? AND month=?', user_id, month)
  log(req, 'target', 'user', +user_id, { month, amount })
  res.json({ ok: true })
})

// ---- static client + errors ----
const dist = path.join(root, 'dist')
// always revalidate the service worker so PWA updates roll out on the next load
app.get('/sw.js', (_req, res) => res.sendFile(path.join(dist, 'sw.js'), { headers: { 'Cache-Control': 'no-cache' } }))
app.use(express.static(dist))
app.use((req, res, next) => (req.path.startsWith('/api') ? next(err(404, 'Not found')) : res.sendFile(path.join(dist, 'index.html'))))
app.use((e, _req, res, _next) => {
  if (!e.status) console.error(e)
  if (e.status === 429 && e.retryAfter) res.set('Retry-After', String(e.retryAfter))
  const status = e.status || 500
  const message = e.type === 'entity.too.large' ? 'Request is too large' : e.type === 'entity.parse.failed' ? 'Malformed JSON body' : e.status ? e.message : 'Server error'
  // a 403 login lock carries trial_ended/plan so the client can show its "trial ended" panel
  res.status(status).json({ error: message, ...(e.data || {}) })
})

// ---------- background jobs (M4 SLA + stale + unassigned retry) ----------
function releaseExpiredHolds() {
  for (const un of all(`SELECT * FROM units WHERE status='On Hold' AND hold_until < ?`, now())) {
    if (!run(`UPDATE units SET status='Available', hold_by=NULL, hold_until=NULL, lead_id=NULL, updated_at=? WHERE id=? AND status='On Hold'`, now(), un.id).changes) continue
    unitHistory(un.id, null, 'On Hold', 'Available', un.lead_id, 'Hold expired')
    notify(un.hold_by, `Your hold on unit #${un.unit_no} expired and it is available again`, un.lead_id)
  }
}

function slaTick() {
  releaseExpiredHolds()
  const t = Date.now(), sla = S('sla_minutes'), whs = S('working_hours')
  for (const l of all(`SELECT l.*, c.name cname, u.name aname FROM leads l JOIN contacts c ON c.id=l.contact_id JOIN users u ON u.id=l.agent_id
      WHERE l.deleted=0 AND l.status='New' AND l.first_contact_at IS NULL AND l.sla_level<3`)) {
    const lvl = L.slaLevel(L.workingMinutes(Date.parse(l.assigned_at), t, whs[l.branch_id] || whs.default), sla[l.source] ?? sla.default)
    for (let k = l.sla_level + 1; k <= lvl; k++) {
      run('INSERT INTO sla_breaches(lead_id,user_id,level,created_at) VALUES(?,?,?,?)', l.id, l.agent_id, k, now())
      run('UPDATE leads SET sla_level=? WHERE id=?', k, l.id)
      if (k === 1) notify(l.agent_id, `SLA reminder: contact ${l.cname} now`, l.id, { sms: true })
      if (k === 2) notifyTeamLeads(l.agent_id, `SLA breach: ${l.aname} has not contacted ${l.cname}`, l.id)
      if (k === 3) {
        addActivity(l.id, null, 'system', `First-contact SLA breached by ${l.aname}. Reassigning.`)
        notify(l.agent_id, `Lead ${l.cname} was taken away: SLA breached`, l.id)
        autoAssign(l.id, { exclude: l.agent_id, reason: 'SLA reassignment.' })
        break
      }
    }
  }
  const cut = new Date(t - S('stale_days') * 864e5).toISOString()
  for (const l of all(`SELECT l.id, l.agent_id, c.name FROM leads l JOIN contacts c ON c.id=l.contact_id
      WHERE ${OPEN} AND l.stale_flag=0 AND l.agent_id IS NOT NULL AND COALESCE(l.last_activity_at,l.created_at) < ?`, closedJson(), cut)) {
    notifyTeamLeads(l.agent_id, `Stale lead: no activity on ${l.name} for ${S('stale_days')} days`, l.id)
    run('UPDATE leads SET stale_flag=1 WHERE id=?', l.id)
  }
  for (const l of all(`SELECT id FROM leads l WHERE agent_id IS NULL AND ${OPEN} LIMIT 50`, closedJson())) autoAssign(l.id, { quiet: true })
}

// Project names used to live in a settings list; move them into the projects table once
const legacyProjects = db && one(`SELECT value FROM settings WHERE key='projects'`)
if (legacyProjects) {
  for (const n of JSON.parse(legacyProjects.value)) run('INSERT OR IGNORE INTO projects(name, created_at) VALUES(?,?)', n, now())
  run(`DELETE FROM settings WHERE key='projects'`)
}

// ---------- first-run seed ----------
if (db && !one('SELECT 1 FROM users')) {
  const b = run(`INSERT INTO branches(name,city) VALUES('Lahore HQ','Lahore')`).lastInsertRowid
  const tm = run(`INSERT INTO teams(name,branch_id) VALUES('Sales Team A',?)`, b).lastInsertRowid
  const add = (name, email, role, phone, team = null) =>
    run('INSERT INTO users(name,email,role,phone,team_id,branch_id,pass) VALUES(?,?,?,?,?,?,?)', name, email, role, phone, team, b, hash('password123'))
  add('Admin', 'admin@propcentral.local', 'admin', null)
  add('Sales Head', 'head@propcentral.local', 'sales_head', null)
  add('Team Lead', 'lead@propcentral.local', 'team_lead', '03001110000', tm)
  add('Agent One', 'agent1@propcentral.local', 'agent', '03001110001', tm)
  add('Agent Two', 'agent2@propcentral.local', 'agent', '03001110002', tm)
  for (const [name, phone, source, campaign, project] of [
    ['Usman Tariq', '0321-4567890', 'Facebook', 'DHA Plots Oct', 'Phase 9 Prism'], ['Ayesha Malik', '+92 333 1234567', 'Website', null, 'Central Heights'],
    ['Bilal Ahmed', '00923451112233', 'Zameen', null, null], ['Sana Iqbal', '03009998877', 'Facebook', 'Central Heights Launch', 'Central Heights'],
    ['Hamza Sheikh', '03125556677', 'Walk-in', null, 'Central Heights'],
  ]) createLead({ name, phone, source, campaign, project, city: 'Lahore', budget_max: 15000000 })
  const pid = run(`INSERT INTO projects(name,city,kind,premiums,created_at) VALUES('Central Heights','Lahore','land',?,?)`,
    JSON.stringify([{ name: 'Corner', type: 'pct', value: 10 }, { name: 'Park facing', type: 'pct', value: 5 }, { name: 'Main boulevard', type: 'fixed', value: 1500000 }]), now()).lastInsertRowid
  for (const block of ['A', 'B']) for (let n = 1; n <= 20; n++)
    run(`INSERT INTO units(project_id,block,unit_no,unit_type,size,uom,premiums,updated_at) VALUES(?,?,?,?,?,?,?,?)`, pid, block, String(n), 'Plot',
      n % 4 === 0 ? 10 : 5, 'marla', JSON.stringify(n === 1 || n === 20 ? ['Corner'] : []), now())
  run(`INSERT INTO price_lists(project_id,unit_type,rate,per,effective_from,created_at) VALUES(?,'Plot',1200000,'marla','2026-01-01',?)`, pid, now())
  console.log('Seeded demo users (password: password123): admin@propcentral.local, head@propcentral.local, lead@propcentral.local, agent1@propcentral.local, agent2@propcentral.local')
}

// Platform owner from env, idempotent and independent of the demo seed
{
  const em = (process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase(), pw = process.env.PLATFORM_ADMIN_PASSWORD || ''
  if (db && em && pw.length < 10) console.warn('PLATFORM_ADMIN_PASSWORD must be at least 10 characters; platform admin not seeded')
  else if (db && em && !one('SELECT 1 FROM users WHERE email=?', em))
    run(`INSERT INTO users(name,email,role,active,pass) VALUES('Platform Admin',?,'platform',1,?)`, em, hash(pw))
}

// Vercel imports this file as a serverless function: no timers and no listener there; /api/cron/tick replaces them
const serverless = !!process.env.VERCEL
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (!serverless && isMain) {
  if (db) {
    setInterval(slaTick, 60e3)
    setInterval(reportTick, 60e3)
    setInterval(leaseTick, 60e3)
    leaseTick()
    slaTick()
  }
  const port = process.env.PORT || 3001
  app.listen(port, () => console.log(`Estate Centric API on http://localhost:${port}`))
}
export default app
