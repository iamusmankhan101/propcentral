// Phone-exchange call log. The company's own exchange / cloud PBX (Jazz, Zong, Ufone, 3CX, FreePBX, Twilio…) rings the agents and
// records the call; when it ends the exchange POSTs the call's details here and the CRM attaches it to the right lead with a
// recording link. Nothing is dialled from the CRM and no audio is stored: recordings stay with the exchange.
//
// Each company has its own key, so a call can only ever land in the company that owns the key.

export const TEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS tel_config(company_id INTEGER PRIMARY KEY, api_key TEXT NOT NULL, updated_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS tel_config_key ON tel_config(api_key);
CREATE TABLE IF NOT EXISTS phone_calls(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, lead_id INTEGER, ext_id TEXT, direction TEXT NOT NULL, customer_phone TEXT,
  agent_id INTEGER, agent_ref TEXT, status TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0, started_at TEXT, recording_url TEXT, note TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS phone_calls_ext ON phone_calls(company_id, ext_id) WHERE ext_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS phone_calls_lead ON phone_calls(lead_id, id);
`

const pickFirst = (o, keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && String(o[k]).trim() !== '') return o[k] }
const IN = /^(in|inbound|incoming|received|i)$/i, OUT = /^(out|outbound|outgoing|dialed|dialled|o)$/i

// Exchanges name their fields differently, so the common spellings are all accepted. Pure: checked without a database.
export function normalizeCall(b, normalizePhone) {
  b = b || {}
  const dirRaw = String(pickFirst(b, ['direction', 'call_type', 'type']) ?? '')
  const direction = OUT.test(dirRaw) ? 'out' : IN.test(dirRaw) ? 'in' : null
  const from = pickFirst(b, ['from', 'caller', 'caller_number', 'src', 'calling_number', 'cli'])
  const to = pickFirst(b, ['to', 'callee', 'called', 'called_number', 'dst', 'destination'])
  const dir = direction || 'in'
  const customerRaw = pickFirst(b, ['customer', 'customer_number', 'customer_phone']) ?? (dir === 'out' ? to : from)
  const statusRaw = String(pickFirst(b, ['status', 'disposition', 'call_status', 'result']) ?? '').toLowerCase()
  const duration = Math.max(0, Math.round(+pickFirst(b, ['duration', 'talk_time', 'billsec', 'talk_duration', 'seconds']) || 0))
  // "no answer" contains "answer", so the negative words are checked first
  const answered = /miss|no.?answer|un.?answer|busy|fail|cancel|reject/.test(statusRaw) ? false : /answer|connected|complete|success/.test(statusRaw) ? true : duration > 0
  const rec = String(pickFirst(b, ['recording_url', 'recording', 'recording_link', 'recordingfile', 'record_url']) ?? '').trim()
  const started = pickFirst(b, ['started_at', 'start_time', 'start', 'calldate', 'timestamp', 'time'])
  const t = started ? new Date(/^\d{10}$/.test(String(started)) ? +started * 1000 : /^\d{13}$/.test(String(started)) ? +started : started) : null
  return {
    direction: dir, direction_given: !!direction,
    customer_phone: normalizePhone(customerRaw),
    agent_ext: String(pickFirst(b, ['extension', 'agent_extension', 'ext', 'agent_ext']) ?? '').trim() || null,
    agent_email: String(pickFirst(b, ['agent_email', 'agent']) ?? '').trim().toLowerCase() || null,
    agent_phone: normalizePhone(pickFirst(b, ['agent_phone', 'agent_number', dir === 'out' ? 'from' : 'to'])),
    answered, duration,
    recording_url: /^https?:\/\/[^\s]{4,1000}$/i.test(rec) ? rec : null,
    started_at: t && !isNaN(t) ? t.toISOString() : null,
    ext_id: String(pickFirst(b, ['call_id', 'id', 'uniqueid', 'unique_id', 'callid', 'uuid']) ?? '').trim().slice(0, 120) || null,
  }
}

const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// Public: the exchange calls this with the company's key.
export function registerTelephonyIngest({ app, crypto, one, run, now, safeEqual, createLead, addActivity, notify, normalizePhone, err }) {
  app.post('/api/inbound/calls', (req, res) => {
    const key = String(req.headers['x-api-key'] || req.query.key || '')
    const cfg = key.length >= 16 ? one('SELECT * FROM tel_config WHERE api_key=?', key) : null
    if (!cfg || !safeEqual(key, cfg.api_key)) throw err(401, 'Invalid API key')
    const c = normalizeCall(req.body, normalizePhone), company = cfg.company_id
    if (!c.customer_phone) throw err(400, "The customer's phone number is missing or invalid")
    if (c.ext_id) { // exchanges retry: a call is stored once
      const have = one('SELECT id, lead_id FROM phone_calls WHERE company_id=? AND ext_id=?', company, c.ext_id)
      if (have) return res.json({ id: have.id, lead_id: have.lead_id, duplicate: true })
    }
    // which agent: by extension, email or mobile number, always inside this company
    const agent = (c.agent_ext && one('SELECT id FROM users WHERE extension=? AND active=1 AND (id=? OR owner_id=?)', c.agent_ext, company, company))
      || (c.agent_email && one('SELECT id FROM users WHERE lower(email)=? AND active=1 AND (id=? OR owner_id=?)', c.agent_email, company, company))
      || (c.agent_phone && one('SELECT id FROM users WHERE phone=? AND active=1 AND (id=? OR owner_id=?)', c.agent_phone, company, company)) || null
    const contact = one('SELECT id, name FROM contacts WHERE phone=?', c.customer_phone)
    let lead = contact && one('SELECT * FROM leads WHERE contact_id=? AND company_id=? AND deleted=0 ORDER BY id DESC', contact.id, company)
    // an unknown number that phones the company becomes a lead (assigned to the agent who took the call); an unknown number we called does not
    if (!lead && c.direction === 'in') {
      const made = createLead({ name: '+' + c.customer_phone, phone: c.customer_phone, source: 'Inbound call', remarks: 'Phoned the main number', company_id: company }, null, agent?.id ?? null)
      lead = one('SELECT * FROM leads WHERE id=?', made.lead_id)
    }
    const status = c.answered ? 'answered' : 'missed'
    const id = run(`INSERT INTO phone_calls(company_id,lead_id,ext_id,direction,customer_phone,agent_id,agent_ref,status,duration,started_at,recording_url,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      company, lead?.id ?? null, c.ext_id, c.direction, c.customer_phone, agent?.id ?? null, c.agent_ext || c.agent_email || null, status, c.duration, c.started_at, c.recording_url, now()).lastInsertRowid
    if (lead) {
      const who = agent?.id ?? null
      if (c.answered) addActivity(lead.id, who, 'call', `Phone call ${c.direction === 'in' ? 'received' : 'made'}, ${mmss(c.duration)}${c.recording_url ? ' (recorded)' : ''}`, { outcome: 'Connected' })
      else if (c.direction === 'out') addActivity(lead.id, who, 'call', 'Phone call made, not answered', { outcome: 'Not answered' })
      else {
        addActivity(lead.id, null, 'system', 'Missed phone call from the customer')
        notify(lead.agent_id ?? who, 'Missed call from a customer. Call them back.', lead.id)
      }
    }
    res.json({ id, lead_id: lead?.id ?? null, matched_agent: !!agent })
  })
}

// Settings: the company's key and the call list.
export default function registerTelephony({ app, crypto, one, all, run, err, can, now, scopedLead }) {
  const co = u => u.owner_id ?? u.id
  const admin = (req, _res, next) => (can(req.user, 'settings') ? next() : next(err(403, 'You do not have permission for this')))
  const base = req => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
  const keyOf = u => {
    let c = one('SELECT api_key FROM tel_config WHERE company_id=?', co(u))
    if (!c) { run('INSERT INTO tel_config(company_id,api_key,updated_at) VALUES(?,?,?)', co(u), crypto.randomBytes(24).toString('hex'), now()); c = one('SELECT api_key FROM tel_config WHERE company_id=?', co(u)) }
    return c.api_key
  }
  app.get('/api/tel/config', admin, (req, res) => {
    const c = co(req.user)
    res.json({
      endpoint: base(req) + '/api/inbound/calls', api_key: keyOf(req.user),
      extensions: all(`SELECT id, name, extension FROM users WHERE active=1 AND (id=? OR owner_id=?) ORDER BY name`, c, c),
      recent: all(`SELECT k.id, k.lead_id, k.direction, k.status, k.duration, k.customer_phone, k.agent_ref, k.agent_id, k.recording_url, k.created_at, u.name agent_name
        FROM phone_calls k LEFT JOIN users u ON u.id=k.agent_id WHERE k.company_id=? ORDER BY k.id DESC LIMIT 30`, c),
      stats: one(`SELECT count(*) total, sum(lead_id IS NULL) unmatched, sum(agent_id IS NULL) no_agent, sum(recording_url IS NOT NULL) recorded FROM phone_calls WHERE company_id=?`, c),
    })
  })
  app.post('/api/tel/config/rotate', admin, (req, res) => {
    run('INSERT INTO tel_config(company_id,api_key,updated_at) VALUES(?,?,?) ON CONFLICT(company_id) DO UPDATE SET api_key=excluded.api_key, updated_at=excluded.updated_at', co(req.user), crypto.randomBytes(24).toString('hex'), now())
    res.json({ api_key: keyOf(req.user) })
  })
  app.get('/api/leads/:id/phone-calls', (req, res) => {
    const lead = scopedLead(req.user, req.params.id)
    res.json(all(`SELECT k.id, k.direction, k.status, k.duration, k.started_at, k.created_at, k.recording_url, u.name agent_name FROM phone_calls k LEFT JOIN users u ON u.id=k.agent_id
      WHERE k.company_id=? AND k.lead_id=? ORDER BY k.id DESC LIMIT 50`, co(req.user), lead.id))
  })
}
