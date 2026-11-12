// One main WhatsApp number per company, through Meta's WhatsApp Business Cloud API: an inbox in the lead's timeline and
// voice calls placed from the browser (WebRTC) through the WhatsApp Business Calling API.
// Credentials are entered by the company admin in Settings › WhatsApp; until then every route answers "not connected".
// The Graph base URL can be overridden with WA_GRAPH_URL so the whole flow is tested against a fake Graph server.
//
// Meta rules this code follows (verify against your Meta app before go-live):
//  - free-form messages only inside 24 hours of the customer's last message; otherwise an approved template
//  - a business may only call a customer who granted call permission (a call_permission_request message the customer accepts)
//  - calling must be switched on for the phone number in WhatsApp Manager

export const WA_SCHEMA = `
CREATE TABLE IF NOT EXISTS wa_config(company_id INTEGER PRIMARY KEY, phone_number_id TEXT, waba_id TEXT, access_token TEXT, app_secret TEXT, verify_token TEXT,
  calling INTEGER NOT NULL DEFAULT 0, record_calls INTEGER NOT NULL DEFAULT 0, display_number TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS wa_messages(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, wa_id TEXT, direction TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text', body TEXT, status TEXT, error TEXT, created_by INTEGER, created_at TEXT NOT NULL, read_at TEXT);
CREATE INDEX IF NOT EXISTS wa_messages_lead ON wa_messages(lead_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_wid ON wa_messages(wa_id) WHERE wa_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS wa_calls(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, lead_id INTEGER NOT NULL, wa_call_id TEXT, direction TEXT NOT NULL DEFAULT 'out',
  status TEXT NOT NULL DEFAULT 'ringing', sdp_answer TEXT, sdp_offer TEXT, error TEXT, created_by INTEGER, created_at TEXT NOT NULL, connected_at TEXT, ended_at TEXT, duration INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS wa_calls_wid ON wa_calls(wa_call_id) WHERE wa_call_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS wa_recordings(call_id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL, created_by INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wa_permissions(company_id INTEGER NOT NULL, wa_id TEXT NOT NULL, status TEXT NOT NULL, permanent INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
  updated_at TEXT, PRIMARY KEY(company_id, wa_id));
`

const GRAPH = () => process.env.WA_GRAPH_URL || process.env.FB_GRAPH_URL || 'https://graph.facebook.com/v21.0'
const WINDOW_MS = 24 * 3600e3
const RING_MS = 45e3 // how long a customer's incoming call can wait for an agent before it counts as missed
const PERMISSION_MS = 72 * 3600e3 // a temporary call permission lasts 72 hours in Meta's rules at the time of writing

// Webhook payloads differ a little between Meta API versions, so the SDP is read from either known place.
export const sdpOf = c => c?.session?.sdp || c?.connection?.webrtc?.sdp || c?.sdp || null
// Text a customer message is shown as in the thread. Media is not downloaded: the agent sees what kind it was.
export function bodyOf(m) {
  if (m.type === 'text') return m.text?.body || ''
  if (m.type === 'button') return m.button?.text || '[button]'
  if (m.type === 'interactive') {
    const i = m.interactive || {}
    if (i.type === 'call_permission_reply') return `[call permission ${i.call_permission_reply?.response || 'reply'}]`
    return i.button_reply?.title || i.list_reply?.title || '[reply]'
  }
  return `[${m.type || 'message'}]` + (m.image?.caption || m.document?.caption || m.video?.caption ? ' ' + (m.image?.caption || m.document?.caption || m.video?.caption) : '')
}
const first = (...v) => v.find(x => x !== undefined && x !== null && x !== '')

function configState(c) {
  return { connected: !!(c?.phone_number_id && c?.access_token), calling: !!(c?.calling && c?.phone_number_id && c?.access_token), recording: !!c?.record_calls, display_number: c?.display_number || null }
}

// Public part: Meta calls this with no login, so it is registered before the auth middleware and proves who sent it by signature.
export function registerWhatsappWebhook({ app, crypto, one, all, run, tx, now, safeEqual, addActivity, createLead, notify, normalizePhone, err }) {
  const cfgByPhoneId = id => one('SELECT * FROM wa_config WHERE phone_number_id=?', String(id))

  // lead for a customer's number inside this company: their open lead, else a new "WhatsApp" lead that goes through normal assignment
  function leadFor(cfg, waId, name) {
    const phone = normalizePhone(waId)
    if (!phone) return null
    const contact = one('SELECT * FROM contacts WHERE phone=?', phone)
    if (contact) {
      const lead = one('SELECT l.* FROM leads l WHERE l.contact_id=? AND l.deleted=0 AND l.company_id=? ORDER BY l.id DESC', contact.id, cfg.company_id)
      if (lead) return lead
    }
    const made = createLead({ name: name || '+' + phone, phone, source: 'WhatsApp', remarks: 'Started a WhatsApp conversation', company_id: cfg.company_id }, null, null)
    return one('SELECT * FROM leads WHERE id=?', made.lead_id)
  }

  function onMessage(cfg, m, profile) {
    const lead = leadFor(cfg, m.from, profile?.[m.from])
    if (!lead) return
    const body = bodyOf(m)
    const inserted = run(`INSERT OR IGNORE INTO wa_messages(company_id,lead_id,wa_id,direction,kind,body,status,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      cfg.company_id, lead.id, m.id, 'in', m.type === 'text' ? 'text' : m.type || 'other', body, 'received', now()).changes
    if (!inserted) return // Meta retries deliveries; one message is stored once
    const reply = m.interactive?.call_permission_reply
    if (reply) {
      const yes = reply.response === 'accept'
      run(`INSERT INTO wa_permissions(company_id,wa_id,status,permanent,expires_at,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(company_id,wa_id) DO UPDATE SET status=excluded.status, permanent=excluded.permanent, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
      cfg.company_id, m.from, yes ? 'granted' : 'rejected', reply.is_permanent ? 1 : 0, yes && !reply.is_permanent ? new Date(Date.now() + PERMISSION_MS).toISOString() : null, now())
    }
    run('UPDATE leads SET last_activity_at=? WHERE id=?', now(), lead.id)
    notify(lead.agent_id, `WhatsApp from ${profile?.[m.from] || lead.id}: ${body.slice(0, 80)}`, lead.id)
  }

  function onStatus(cfg, s) {
    const error = s.errors?.[0]?.title || s.errors?.[0]?.message || null
    run('UPDATE wa_messages SET status=?, error=COALESCE(?, error) WHERE wa_id=? AND company_id=?', s.status, error, s.id, cfg.company_id)
  }

  const markMissed = row => {
    addActivity(row.lead_id, null, 'system', 'Missed WhatsApp call from the customer')
    notify(one('SELECT agent_id FROM leads WHERE id=?', row.lead_id)?.agent_id, 'Missed WhatsApp call from a customer. Call them back.', row.lead_id)
  }
  function onCall(cfg, c) {
    const lead = leadFor(cfg, c.direction === 'USER_INITIATED' ? c.from : c.to, null)
    const row = one('SELECT * FROM wa_calls WHERE wa_call_id=? AND company_id=?', c.id, cfg.company_id)
    const event = String(c.event || '').toLowerCase()
    if (!row) { // a customer calling in: the agent gets an Answer button for 45 seconds, after which it is logged as missed
      if (c.direction === 'USER_INITIATED' && lead && sdpOf(c)) {
        run(`INSERT OR IGNORE INTO wa_calls(company_id,lead_id,wa_call_id,direction,status,sdp_offer,created_at) VALUES(?,?,?,?,?,?,?)`, cfg.company_id, lead.id, c.id, 'in', 'incoming', sdpOf(c), now())
        notify(lead.agent_id, 'A customer is calling you on WhatsApp. Open the CRM to answer.', lead.id)
      }
      return
    }
    if (event === 'connect') {
      const sdp = sdpOf(c)
      if (sdp) run(`UPDATE wa_calls SET sdp_answer=?, status='connected', connected_at=COALESCE(connected_at, ?) WHERE id=?`, sdp, now(), row.id)
    } else if (event === 'terminate' && row.direction === 'in' && !row.connected_at) { // the customer hung up before anyone answered
      if (run(`UPDATE wa_calls SET status='missed', ended_at=? WHERE id=? AND ended_at IS NULL`, now(), row.id).changes) markMissed(row)
    } else if (event === 'terminate') {
      const dur = Math.max(0, Math.round(+c.duration || (row.connected_at ? (Date.now() - Date.parse(row.connected_at)) / 1000 : 0)))
      const failed = /fail|reject|busy|unanswer/i.test(String(c.status || '')) || (!row.connected_at && !dur)
      run(`UPDATE wa_calls SET status=?, ended_at=?, duration=?, error=COALESCE(?, error) WHERE id=? AND ended_at IS NULL`,
        failed ? 'failed' : 'ended', now(), dur, c.errors?.[0]?.message || (failed ? String(c.status || 'not answered') : null), row.id)
      if (!row.ended_at) addActivity(row.lead_id, row.created_by, 'call', `WhatsApp call, ${dur ? dur + ' seconds' : 'not answered'}`, { outcome: dur ? 'Connected' : 'Not answered' })
    }
  }

  app.get('/api/webhooks/whatsapp', (req, res) => {
    const t = req.query['hub.verify_token']
    if (t && one('SELECT 1 FROM wa_config WHERE verify_token=?', String(t))) return res.send(req.query['hub.challenge'])
    res.sendStatus(403)
  })
  app.post('/api/webhooks/whatsapp', (req, res) => {
    const entries = req.body?.entry || []
    const phoneId = entries.flatMap(e => e.changes || []).map(c => c.value?.metadata?.phone_number_id).find(Boolean)
    const cfg = phoneId && cfgByPhoneId(phoneId)
    if (!cfg?.app_secret) throw err(503, 'WhatsApp is not connected')
    const sig = 'sha256=' + crypto.createHmac('sha256', cfg.app_secret).update(req.rawBody || '').digest('hex')
    if (!safeEqual(req.headers['x-hub-signature-256'], sig)) return res.sendStatus(401)
    tx(() => {
      for (const e of entries) for (const ch of e.changes || []) {
        const v = ch.value || {}
        if (v.metadata?.phone_number_id !== cfg.phone_number_id) continue
        const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile?.name]))
        for (const m of v.messages || []) onMessage(cfg, m, names)
        for (const s of v.statuses || []) onStatus(cfg, s)
        for (const c of v.calls || []) onCall(cfg, c)
      }
    })()
    res.sendStatus(200)
  })
  return { markMissed }
}

export default function registerWhatsapp({ app, crypto, one, all, run, err, log, can, now, addActivity, notify, scope, scopedLead, fetchImpl = fetch }) {
  const co = u => u.owner_id ?? u.id
  const cfgOf = u => one('SELECT * FROM wa_config WHERE company_id=?', co(u))
  const need = u => {
    const c = cfgOf(u)
    if (!c?.phone_number_id || !c?.access_token) throw err(400, 'WhatsApp is not connected yet. An admin can connect it in Settings › WhatsApp')
    return c
  }
  async function graph(cfg, path, { method = 'POST', body } = {}) {
    let r
    try {
      r = await fetchImpl(`${GRAPH()}/${path}`, { method, headers: { authorization: 'Bearer ' + cfg.access_token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    } catch (e) { throw err(502, `The CRM server could not reach WhatsApp: ${e.cause?.code || e.message}`) }
    const d = await r.json().catch(() => ({}))
    if (!r.ok || d.error) throw err(400, `WhatsApp says: ${d.error?.error_user_msg || d.error?.message || r.statusText}`)
    return d
  }
  const leadPhone = id => one('SELECT c.phone FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE l.id=?', id).phone
  const lastInbound = (c, leadId) => one(`SELECT created_at FROM wa_messages WHERE company_id=? AND lead_id=? AND direction='in' ORDER BY id DESC LIMIT 1`, c, leadId)?.created_at
  const inWindow = (c, leadId) => { const t = lastInbound(c, leadId); return !!t && Date.now() - Date.parse(t) < WINDOW_MS }
  const permission = (c, phone) => {
    const p = one('SELECT * FROM wa_permissions WHERE company_id=? AND wa_id=?', c, phone)
    if (!p) return 'none'
    if (p.status !== 'granted') return p.status
    return p.permanent || !p.expires_at || p.expires_at > now() ? 'granted' : 'expired'
  }
  const store = (c, leadId, waId, kind, body, userId) => run(`INSERT INTO wa_messages(company_id,lead_id,wa_id,direction,kind,body,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    c, leadId, waId, 'out', kind, body, 'sent', userId, now()).lastInsertRowid

  // what the lead page needs to show the thread and decide which buttons to offer
  app.get('/api/wa/status', (req, res) => res.json(configState(cfgOf(req.user))))

  app.get('/api/leads/:id/wa', (req, res) => {
    const lead = scopedLead(req.user, req.params.id), c = co(req.user), cfg = cfgOf(req.user), phone = leadPhone(lead.id)
    run(`UPDATE wa_messages SET read_at=? WHERE company_id=? AND lead_id=? AND direction='in' AND read_at IS NULL`, now(), c, lead.id)
    res.json({
      ...configState(cfg), window_open: inWindow(c, lead.id), permission: permission(c, phone),
      messages: all('SELECT m.id, m.direction, m.kind, m.body, m.status, m.error, m.created_at, u.name sender FROM wa_messages m LEFT JOIN users u ON u.id=m.created_by WHERE m.company_id=? AND m.lead_id=? ORDER BY m.id DESC LIMIT 200', c, lead.id).reverse(),
      calls: all('SELECT k.id, k.direction, k.status, k.duration, k.created_at, (SELECT 1 FROM wa_recordings r WHERE r.call_id=k.id) has_recording FROM wa_calls k WHERE k.company_id=? AND k.lead_id=? ORDER BY k.id DESC LIMIT 20', c, lead.id),
    })
  })
  app.post('/api/leads/:id/wa/send', async (req, res) => {
    const lead = scopedLead(req.user, req.params.id), cfg = need(req.user), text = String(req.body.text || '').trim()
    if (!text) throw err(400, 'Write a message')
    if (text.length > 4000) throw err(400, 'Message is too long')
    if (!inWindow(cfg.company_id, lead.id)) throw err(400, 'More than 24 hours since the customer last wrote. Send an approved template instead.', { need_template: true })
    const phone = leadPhone(lead.id)
    const out = await graph(cfg, `${cfg.phone_number_id}/messages`, { body: { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text } } })
    const id = store(cfg.company_id, lead.id, out.messages?.[0]?.id, 'text', text, req.user.id)
    addActivity(lead.id, req.user.id, 'whatsapp', text.slice(0, 500))
    log(req, 'wa_send', 'lead', lead.id)
    res.json({ id })
  })
  app.get('/api/wa/templates', async (req, res) => {
    const cfg = need(req.user)
    if (!cfg.waba_id) throw err(400, 'Add the WhatsApp Business Account ID in Settings › WhatsApp to list templates')
    const d = await graph(cfg, `${cfg.waba_id}/message_templates?limit=100&fields=name,language,status,category,components`, { method: 'GET' })
    res.json((d.data || []).filter(t => t.status === 'APPROVED').map(t => ({
      name: t.name, language: t.language, category: t.category, text: t.components?.find(x => x.type === 'BODY')?.text || '',
      params: (t.components?.find(x => x.type === 'BODY')?.text?.match(/\{\{\d+\}\}/g) || []).length,
    })))
  })
  app.post('/api/leads/:id/wa/template', async (req, res) => {
    const lead = scopedLead(req.user, req.params.id), cfg = need(req.user), b = req.body || {}
    if (!/^[a-z0-9_]{1,512}$/.test(b.name || '')) throw err(400, 'Pick a template')
    const params = (Array.isArray(b.params) ? b.params : []).map(x => String(x ?? '').slice(0, 1000))
    const out = await graph(cfg, `${cfg.phone_number_id}/messages`, { body: {
      messaging_product: 'whatsapp', to: leadPhone(lead.id), type: 'template',
      template: { name: b.name, language: { code: b.language || 'en' }, ...(params.length ? { components: [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }] } : {}) },
    } })
    const shown = `[template ${b.name}] ${params.join(' · ')}`.trim()
    const id = store(cfg.company_id, lead.id, out.messages?.[0]?.id, 'template', shown, req.user.id)
    addActivity(lead.id, req.user.id, 'whatsapp', shown.slice(0, 500))
    log(req, 'wa_template', 'lead', lead.id, { name: b.name })
    res.json({ id })
  })

  // ---- calling ----
  app.post('/api/leads/:id/wa/call-permission', async (req, res) => {
    const lead = scopedLead(req.user, req.params.id), cfg = need(req.user)
    if (!cfg.calling) throw err(400, 'Calling is not switched on for this WhatsApp number (Settings › WhatsApp)')
    if (!inWindow(cfg.company_id, lead.id)) throw err(400, 'The customer must have written in the last 24 hours. Send a template asking them to message you first.', { need_template: true })
    const text = String(req.body.text || '').trim() || 'May we call you on WhatsApp to discuss your enquiry?'
    const out = await graph(cfg, `${cfg.phone_number_id}/messages`, { body: {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: leadPhone(lead.id), type: 'interactive',
      interactive: { type: 'call_permission_request', action: { name: 'call_permission_request' }, body: { text: text.slice(0, 1024) } },
    } })
    store(cfg.company_id, lead.id, out.messages?.[0]?.id, 'call_permission_request', text, req.user.id)
    res.json({ ok: true })
  })
  app.post('/api/leads/:id/wa/call', async (req, res) => {
    const lead = scopedLead(req.user, req.params.id), cfg = need(req.user), sdp = String(req.body.sdp || '')
    if (!cfg.calling) throw err(400, 'Calling is not switched on for this WhatsApp number (Settings › WhatsApp)')
    if (!/^v=0/.test(sdp) || sdp.length > 20000) throw err(400, 'The browser did not produce a valid call offer')
    const phone = leadPhone(lead.id), perm = permission(cfg.company_id, phone)
    if (perm !== 'granted') throw err(400, perm === 'rejected' ? 'The customer declined calls on WhatsApp.' : 'The customer has not allowed calls yet. Send a call request first.', { need_permission: true, permission: perm })
    if (one(`SELECT 1 FROM wa_calls WHERE company_id=? AND created_by=? AND ended_at IS NULL AND status IN ('ringing','connected') AND created_at>?`, cfg.company_id, req.user.id, new Date(Date.now() - 3600e3).toISOString()))
      throw err(400, 'You already have a call in progress')
    const id = run(`INSERT INTO wa_calls(company_id,lead_id,direction,status,created_by,created_at) VALUES(?,?,?,?,?,?)`, cfg.company_id, lead.id, 'out', 'ringing', req.user.id, now()).lastInsertRowid
    try {
      const out = await graph(cfg, `${cfg.phone_number_id}/calls`, { body: { messaging_product: 'whatsapp', to: phone, action: 'connect', session: { sdp_type: 'offer', sdp } } })
      run('UPDATE wa_calls SET wa_call_id=? WHERE id=?', out.calls?.[0]?.id || out.id || null, id)
    } catch (e) {
      run(`UPDATE wa_calls SET status='failed', ended_at=?, error=? WHERE id=?`, now(), e.message, id)
      throw e
    }
    log(req, 'wa_call', 'lead', lead.id)
    res.json({ id })
  })
  const callOf = req => {
    const c = one('SELECT * FROM wa_calls WHERE id=? AND company_id=?', +req.params.id, co(req.user))
    if (!c) throw err(404, 'Call not found')
    scopedLead(req.user, c.lead_id) // same visibility as the lead itself
    return c
  }
  app.get('/api/wa/calls/:id', (req, res) => {
    const c = callOf(req)
    // a call nobody answered is closed here rather than left "ringing" forever
    if (c.status === 'ringing' && Date.now() - Date.parse(c.created_at) > 90e3)
      run(`UPDATE wa_calls SET status='failed', ended_at=?, error='No answer' WHERE id=? AND ended_at IS NULL`, now(), c.id)
    const x = one('SELECT id, direction, status, sdp_answer, duration, error FROM wa_calls WHERE id=?', c.id)
    res.json(x)
  })
  app.post('/api/wa/calls/:id/hangup', async (req, res) => {
    const c = callOf(req), cfg = need(req.user)
    if (!c.ended_at) {
      if (c.wa_call_id) await graph(cfg, `${cfg.phone_number_id}/calls`, { body: { messaging_product: 'whatsapp', call_id: c.wa_call_id, action: 'terminate' } }).catch(() => {}) // the end is final either way
      const dur = c.connected_at ? Math.round((Date.now() - Date.parse(c.connected_at)) / 1000) : 0
      if (run(`UPDATE wa_calls SET status=?, ended_at=?, duration=? WHERE id=? AND ended_at IS NULL`, dur ? 'ended' : 'failed', now(), dur, c.id).changes)
        addActivity(c.lead_id, c.created_by, 'call', `WhatsApp call, ${dur ? dur + ' seconds' : 'not answered'}`, { outcome: dur ? 'Connected' : 'Not answered' })
    }
    res.json({ ok: true })
  })

  // ---- customers calling in ----
  // The agent the lead belongs to (or anyone who may see an unassigned lead) gets an Answer button while the call is still ringing.
  app.get('/api/wa/incoming', (req, res) => {
    const [w, p] = scope(req.user)
    res.json(all(`SELECT k.id, k.lead_id, c.name, k.created_at FROM wa_calls k JOIN leads l ON l.id=k.lead_id JOIN contacts c ON c.id=l.contact_id
      WHERE k.company_id=? AND k.direction='in' AND k.status='incoming' AND k.created_at>? AND (l.agent_id=? OR l.agent_id IS NULL) AND ${w}`,
    co(req.user), new Date(Date.now() - RING_MS).toISOString(), req.user.id, ...p))
  })
  app.get('/api/wa/calls/:id/offer', (req, res) => {
    const c = callOf(req)
    if (c.direction !== 'in' || c.status !== 'incoming') throw err(400, 'This call is no longer ringing')
    res.json({ sdp: c.sdp_offer })
  })
  app.post('/api/wa/calls/:id/accept', async (req, res) => {
    const c = callOf(req), cfg = need(req.user), sdp = String(req.body.sdp || '')
    if (c.direction !== 'in' || c.status !== 'incoming' || Date.now() - Date.parse(c.created_at) > RING_MS + 5e3) throw err(400, 'This call is no longer ringing')
    if (!/^v=0/.test(sdp) || sdp.length > 20000) throw err(400, 'The browser did not produce a valid answer')
    // claim it first so two agents cannot both answer
    if (!run(`UPDATE wa_calls SET status='connected', connected_at=?, created_by=? WHERE id=? AND status='incoming'`, now(), req.user.id, c.id).changes) throw err(409, 'Another agent already answered this call')
    try {
      await graph(cfg, `${cfg.phone_number_id}/calls`, { body: { messaging_product: 'whatsapp', call_id: c.wa_call_id, action: 'accept', session: { sdp_type: 'answer', sdp } } })
    } catch (e) {
      run(`UPDATE wa_calls SET status='failed', ended_at=?, error=? WHERE id=?`, now(), e.message, c.id)
      throw e
    }
    run('UPDATE leads SET agent_id=COALESCE(agent_id, ?) WHERE id=?', req.user.id, c.lead_id) // an unassigned customer goes to whoever answered
    log(req, 'wa_answer', 'lead', c.lead_id)
    res.json({ ok: true })
  })
  app.post('/api/wa/calls/:id/reject', async (req, res) => {
    const c = callOf(req), cfg = need(req.user)
    if (c.direction === 'in' && c.status === 'incoming') {
      await graph(cfg, `${cfg.phone_number_id}/calls`, { body: { messaging_product: 'whatsapp', call_id: c.wa_call_id, action: 'reject' } }).catch(() => {})
      if (run(`UPDATE wa_calls SET status='missed', ended_at=? WHERE id=? AND status='incoming'`, now(), c.id).changes) {
        addActivity(c.lead_id, req.user.id, 'system', 'WhatsApp call declined by ' + req.user.name)
      }
    }
    res.json({ ok: true })
  })
  // a call nobody picked up within the ring time is logged as missed (also run on a timer, so it does not need anyone to be looking)
  const tick = () => {
    for (const c of all(`SELECT * FROM wa_calls WHERE direction='in' AND status='incoming' AND created_at<?`, new Date(Date.now() - RING_MS).toISOString()))
      if (run(`UPDATE wa_calls SET status='missed', ended_at=? WHERE id=? AND status='incoming'`, now(), c.id).changes) {
        addActivity(c.lead_id, null, 'system', 'Missed WhatsApp call from the customer')
        notify(one('SELECT agent_id FROM leads WHERE id=?', c.lead_id)?.agent_id, 'Missed WhatsApp call from a customer. Call them back.', c.lead_id)
      }
  }

  // ---- call recordings: made in the agent's browser (Meta does not record), stored only when an admin switched recording on ----
  app.post('/api/wa/calls/:id/recording', (req, res) => {
    const c = callOf(req), cfg = need(req.user)
    if (!cfg.record_calls) throw err(400, 'Call recording is switched off')
    if (c.created_by !== req.user.id) throw err(403, 'Only the agent on the call can save its recording')
    const mime = String(req.body.mime || 'audio/webm').split(';')[0]
    if (!/^audio\/(webm|ogg|mp4)$/.test(mime)) throw err(400, 'Unsupported recording format')
    const buf = Buffer.from(String(req.body.data || ''), 'base64')
    if (buf.length < 200) throw err(400, 'The recording is empty')
    if (buf.length > 16 * 1024 * 1024) throw err(400, 'The recording is too large')
    run(`INSERT INTO wa_recordings(call_id,company_id,mime,data,size,created_by,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(call_id) DO UPDATE SET mime=excluded.mime, data=excluded.data, size=excluded.size, created_at=excluded.created_at`, c.id, cfg.company_id, mime, new Uint8Array(buf), buf.length, req.user.id, now())
    log(req, 'wa_recording', 'lead', c.lead_id, { call: c.id, bytes: buf.length })
    res.json({ ok: true, size: buf.length })
  })
  app.get('/api/wa/calls/:id/recording', (req, res) => {
    const c = callOf(req)
    const r = one('SELECT mime, data FROM wa_recordings WHERE call_id=? AND company_id=?', c.id, co(req.user))
    if (!r) throw err(404, 'No recording for this call')
    log(req, 'wa_recording_play', 'lead', c.lead_id, { call: c.id })
    res.set('cache-control', 'private, no-store').type(r.mime).send(Buffer.from(r.data))
  })

  // ---- inbox: one row per conversation the viewer may see ----
  app.get('/api/wa/inbox', (req, res) => {
    const [w, p] = scope(req.user)
    res.json(all(`SELECT l.id lead_id, c.name, l.status, au.name agent_name, last.body, last.direction, last.created_at,
        (SELECT COUNT(*) FROM wa_messages x WHERE x.lead_id=l.id AND x.direction='in' AND x.read_at IS NULL) unread
      FROM wa_messages last JOIN leads l ON l.id=last.lead_id JOIN contacts c ON c.id=l.contact_id LEFT JOIN users au ON au.id=l.agent_id
      WHERE last.company_id=? AND last.id=(SELECT MAX(id) FROM wa_messages WHERE lead_id=l.id AND company_id=?) AND l.deleted=0 AND ${w}
      ORDER BY last.id DESC LIMIT 200`, co(req.user), co(req.user), ...p))
  })

  // ---- Settings › WhatsApp (admins) ----
  const siteBase = req => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
  app.get('/api/wa/config', (req, res) => {
    if (!can(req.user, 'settings')) throw err(403, 'You do not have permission for this')
    const c = cfgOf(req.user) || {}
    res.json({ phone_number_id: c.phone_number_id || '', waba_id: c.waba_id || '', calling: !!c.calling, record_calls: !!c.record_calls, display_number: c.display_number || '', has_token: !!c.access_token, has_secret: !!c.app_secret,
      verify_token: c.verify_token || '', webhook_url: siteBase(req) + '/api/webhooks/whatsapp' })
  })
  app.put('/api/wa/config', (req, res) => {
    if (!can(req.user, 'settings')) throw err(403, 'You do not have permission for this')
    const b = req.body || {}, old = cfgOf(req.user) || {}, clean = (v, max) => String(v ?? '').trim().slice(0, max)
    if (b.phone_number_id && !/^\d{5,30}$/.test(clean(b.phone_number_id, 30))) throw err(400, 'Phone number ID is a number from WhatsApp Manager')
    if (b.waba_id && !/^\d{5,30}$/.test(clean(b.waba_id, 30))) throw err(400, 'Business account ID is a number from WhatsApp Manager')
    const taken = b.phone_number_id && one('SELECT company_id FROM wa_config WHERE phone_number_id=? AND company_id!=?', clean(b.phone_number_id, 30), co(req.user))
    if (taken) throw err(400, 'That WhatsApp number is already connected to another company')
    const next = {
      phone_number_id: clean(b.phone_number_id ?? old.phone_number_id, 30), waba_id: clean(b.waba_id ?? old.waba_id, 30),
      access_token: clean(b.access_token, 600) || old.access_token || null, app_secret: clean(b.app_secret, 100) || old.app_secret || null,
      verify_token: old.verify_token || crypto.randomBytes(16).toString('hex'), calling: b.calling ? 1 : 0, record_calls: b.record_calls ? 1 : 0, display_number: old.display_number || null,
    }
    run(`INSERT INTO wa_config(company_id,phone_number_id,waba_id,access_token,app_secret,verify_token,calling,record_calls,display_number,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(company_id) DO UPDATE SET phone_number_id=excluded.phone_number_id, waba_id=excluded.waba_id, access_token=excluded.access_token, app_secret=excluded.app_secret,
      verify_token=excluded.verify_token, calling=excluded.calling, record_calls=excluded.record_calls, display_number=excluded.display_number, updated_at=excluded.updated_at`,
    co(req.user), next.phone_number_id, next.waba_id, next.access_token, next.app_secret, next.verify_token, next.calling, next.record_calls, next.display_number, now())
    log(req, 'setting', 'whatsapp', co(req.user), { number: next.phone_number_id, calling: !!next.calling, recording: !!next.record_calls })
    res.json({ ok: true })
  })
  app.post('/api/wa/config/test', async (req, res) => {
    if (!can(req.user, 'settings')) throw err(403, 'You do not have permission for this')
    const cfg = need(req.user)
    const d = await graph(cfg, `${cfg.phone_number_id}?fields=display_phone_number,verified_name,quality_rating`, { method: 'GET' })
    run('UPDATE wa_config SET display_number=? WHERE company_id=?', d.display_phone_number || null, cfg.company_id)
    res.json({ number: d.display_phone_number, name: d.verified_name, quality: d.quality_rating })
  })
  return { state: u => configState(cfgOf(u)), tick }
}
