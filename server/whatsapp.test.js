import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bodyOf, sdpOf } from './whatsapp.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const port = 61000 + (process.pid % 1000), fakePort = 62500 + (process.pid % 1000)

test('message text and call SDP are read from the shapes Meta sends', () => {
  assert.equal(bodyOf({ type: 'text', text: { body: 'hello' } }), 'hello')
  assert.equal(bodyOf({ type: 'image', image: { caption: 'plot' } }), '[image] plot')
  assert.equal(bodyOf({ type: 'interactive', interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'accept' } } }), '[call permission accept]')
  assert.equal(sdpOf({ session: { sdp: 'v=0 a' } }), 'v=0 a')
  assert.equal(sdpOf({ connection: { webrtc: { sdp: 'v=0 b' } } }), 'v=0 b')
  assert.equal(sdpOf({}), null)
})

test('WhatsApp: connect, inbound message, 24h rule, call permission and a full call against a fake Graph API', async t => {
  const sent = []
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c }); req.on('end', () => {
      const body = b ? JSON.parse(b) : null
      sent.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      res.setHeader('content-type', 'application/json')
      if (req.url.includes('/calls')) return res.end(JSON.stringify({ calls: [{ id: 'wacid.CALL' + sent.length }] }))
      if (req.url.includes('/messages')) return res.end(JSON.stringify({ messages: [{ id: 'wamid.OUT' + sent.length }] }))
      if (req.url.includes('message_templates')) return res.end(JSON.stringify({ data: [{ name: 'follow_up', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, any questions?' }] }, { name: 'pending_one', status: 'PENDING', components: [] }] }))
      res.end(JSON.stringify({ display_phone_number: '+92 300 1112233', verified_name: 'Demo Realty', quality_rating: 'GREEN' }))
    })
  })
  await new Promise(r => fake.listen(fakePort, r))
  const dbPath = path.join(os.tmpdir(), `estate-centric-wa-${port}.db`)
  const child = spawn(process.execPath, ['server/server.js'], { cwd: root, env: { ...process.env, DB_PATH: dbPath, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', PORT: String(port), VERCEL: '', WA_GRAPH_URL: `http://localhost:${fakePort}/v21.0` }, stdio: 'ignore' })
  t.after(async () => { child.kill(); fake.close(); await sleep(300); for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true }) })
  const base = `http://localhost:${port}/api`
  for (let i = 0; i < 240; i++) { try { if ((await fetch(base + '/health')).ok) break } catch {} await sleep(100) }
  const call = (m, p, tok, body, headers = {}) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
  const login = async e => (await (await call('POST', '/login', null, { email: e, password: 'password123' })).json()).token
  const admin = await login('admin@propcentral.local'), agent = await login('agent1@propcentral.local')

  assert.equal((await (await call('GET', '/wa/status', admin)).json()).connected, false, 'nothing is connected at first')
  assert.equal((await call('POST', '/leads/1/wa/send', admin, { text: 'hi' })).status, 400, 'sending needs a connection')
  assert.equal((await call('PUT', '/wa/config', agent, { phone_number_id: '111111' })).status, 403, 'only settings admins connect WhatsApp')
  assert.equal((await call('PUT', '/wa/config', admin, { phone_number_id: 'abc' })).status, 400)

  assert.equal((await call('PUT', '/wa/config', admin, { phone_number_id: '104567890', waba_id: '2020202020', access_token: 'EAAtoken', app_secret: 'shh-secret', calling: true })).status, 200)
  const cfg = await (await call('GET', '/wa/config', admin)).json()
  assert.ok(cfg.has_token && cfg.has_secret && cfg.verify_token && cfg.webhook_url.endsWith('/api/webhooks/whatsapp'))
  assert.ok(!JSON.stringify(cfg).includes('EAAtoken') && !JSON.stringify(cfg).includes('shh-secret'), 'secrets never come back')
  const test1 = await (await call('POST', '/wa/config/test', admin)).json()
  assert.equal(test1.number, '+92 300 1112233')
  assert.equal(sent.at(-1).auth, 'Bearer EAAtoken')

  // Meta verifies the webhook with the verify token
  assert.equal((await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${cfg.verify_token}&hub.challenge=777`)).status, 200)
  assert.equal((await fetch(`${base}/webhooks/whatsapp?hub.verify_token=wrong&hub.challenge=1`)).status, 403)

  const deliver = (payload, secret = 'shh-secret') => {
    const raw = JSON.stringify(payload)
    return call('POST', '/webhooks/whatsapp', null, raw, { 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') })
  }
  const wrap = value => ({ entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '104567890' }, ...value } }] }] })
  const inbound = { contacts: [{ wa_id: '923451234567', profile: { name: 'Hina Buyer' } }], messages: [{ from: '923451234567', id: 'wamid.IN1', type: 'text', text: { body: 'Is the plot available?' } }] }
  assert.equal((await deliver(wrap(inbound), 'wrong-secret')).status, 401, 'a forged delivery is refused')
  assert.equal((await deliver(wrap(inbound))).status, 200)
  assert.equal((await deliver(wrap(inbound))).status, 200, 'Meta retries; the message is stored once')

  const inbox = await (await call('GET', '/wa/inbox', admin)).json()
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].name, 'Hina Buyer'); assert.equal(inbox[0].unread, 1)
  const leadId = inbox[0].lead_id
  const thread = await (await call('GET', `/leads/${leadId}/wa`, admin)).json()
  assert.equal(thread.messages.length, 1); assert.equal(thread.window_open, true); assert.equal(thread.permission, 'none')
  assert.equal((await (await call('GET', '/wa/inbox', admin)).json())[0].unread, 0, 'opening the thread marks it read')

  // reply inside the window
  assert.equal((await call('POST', `/leads/${leadId}/wa/send`, admin, { text: 'Yes, it is.' })).status, 200)
  const out = sent.filter(s => s.url.includes('/messages')).at(-1)
  assert.equal(out.body.to, '923451234567'); assert.equal(out.body.text.body, 'Yes, it is.')
  assert.equal((await call('POST', `/leads/${leadId}/wa/send`, admin, { text: '   ' })).status, 400)

  // delivery status updates the stored message
  const wamid = sent.filter(s => s.url.includes('/messages')).length && (await (await call('GET', `/leads/${leadId}/wa`, admin)).json()).messages.at(-1)
  await deliver(wrap({ statuses: [{ id: 'wamid.OUT' + (sent.findIndex(s => s === out) + 1), status: 'read' }] }))
  assert.equal((await (await call('GET', `/leads/${leadId}/wa`, admin)).json()).messages.at(-1).status, 'read')

  // templates
  const tpls = await (await call('GET', '/wa/templates', admin)).json()
  assert.deepEqual(tpls.map(x => x.name), ['follow_up'], 'only approved templates are offered'); assert.equal(tpls[0].params, 1)
  assert.equal((await call('POST', `/leads/${leadId}/wa/template`, admin, { name: 'follow_up', language: 'en', params: ['Hina'] })).status, 200)
  assert.equal(sent.filter(s => s.url.includes('/messages')).at(-1).body.template.components[0].parameters[0].text, 'Hina')
  assert.equal((await call('POST', `/leads/${leadId}/wa/template`, admin, { name: 'Bad Name!' })).status, 400)

  // calling needs the customer's permission first
  const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
  const early = await call('POST', `/leads/${leadId}/wa/call`, admin, { sdp })
  assert.equal(early.status, 400); assert.equal((await early.json()).need_permission, true)
  assert.equal((await call('POST', `/leads/${leadId}/wa/call-permission`, admin, {})).status, 200)
  assert.equal(sent.filter(s => s.url.includes('/messages')).at(-1).body.interactive.type, 'call_permission_request')
  await deliver(wrap({ messages: [{ from: '923451234567', id: 'wamid.IN2', type: 'interactive', interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'accept', is_permanent: false } } }] }))
  assert.equal((await (await call('GET', `/leads/${leadId}/wa`, admin)).json()).permission, 'granted')
  assert.equal((await call('POST', `/leads/${leadId}/wa/call`, admin, { sdp: 'not sdp' })).status, 400)

  const started = await call('POST', `/leads/${leadId}/wa/call`, admin, { sdp })
  assert.equal(started.status, 200)
  const callId = (await started.json()).id
  const callSent = sent.filter(s => s.url.includes('/calls')).at(-1)
  const firstCallId = 'wacid.CALL' + (sent.indexOf(callSent) + 1)
  assert.equal(callSent.body.action, 'connect'); assert.equal(callSent.body.session.sdp_type, 'offer'); assert.equal(callSent.body.to, '923451234567')
  assert.equal((await call('POST', `/leads/${leadId}/wa/call`, admin, { sdp })).status, 400, 'one call at a time per agent')
  let st = await (await call('GET', `/wa/calls/${callId}`, admin)).json()
  assert.equal(st.status, 'ringing'); assert.equal(st.sdp_answer, null)

  // Meta answers: the SDP answer arrives by webhook, then the browser connects
  const callHook = c => deliver({ entry: [{ changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '104567890' }, calls: [c] } }] }] })
  await callHook({ id: firstCallId, event: 'connect', direction: 'BUSINESS_INITIATED', session: { sdp_type: 'answer', sdp: 'v=0\r\nanswer' } })
  st = await (await call('GET', `/wa/calls/${callId}`, admin)).json()
  assert.equal(st.status, 'connected'); assert.equal(st.sdp_answer, 'v=0\r\nanswer')
  await callHook({ id: firstCallId, event: 'terminate', direction: 'BUSINESS_INITIATED', status: 'COMPLETED', duration: 95 })
  st = await (await call('GET', `/wa/calls/${callId}`, admin)).json()
  assert.equal(st.status, 'ended'); assert.equal(st.duration, 95)
  const lead = await (await call('GET', `/leads/${leadId}`, admin)).json()
  assert.ok(lead.activities.some(a => a.type === 'call' && a.outcome === 'Connected' && /95 seconds/.test(a.notes)), 'the call lands in the lead timeline')

  // an unanswered call and a hang-up before answer
  const secondRes = await call('POST', `/leads/${leadId}/wa/call`, admin, { sdp })
  const second = await secondRes.json()
  assert.equal(secondRes.status, 200, JSON.stringify(second))
  assert.equal((await call('POST', `/wa/calls/${second.id}/hangup`, admin, {})).status, 200)
  assert.equal(sent.filter(s => s.url.includes('/calls')).at(-1).body.action, 'terminate')
  assert.equal((await (await call('GET', `/wa/calls/${second.id}`, admin)).json()).status, 'failed')

  // a customer calling in: the agent answers in the browser
  const offer = 'v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
  const ring = id => callHook({ id, event: 'connect', direction: 'USER_INITIATED', from: '923451234567', to: '104567890', session: { sdp_type: 'offer', sdp: offer } })
  // the lead belongs to one of the two seeded agents: that agent (and only that agent) is offered the call
  const owner = (await (await call('GET', `/leads/${leadId}`, admin)).json()).lead.agent_name
  const mine = await login(owner === 'Agent One' ? 'agent1@propcentral.local' : 'agent2@propcentral.local')
  const other = await login(owner === 'Agent One' ? 'agent2@propcentral.local' : 'agent1@propcentral.local')
  await ring('wacid.IN1')
  assert.equal((await (await call('GET', '/wa/incoming', other)).json()).length, 0, "another agent is not rung for someone else's lead")
  let inc = await (await call('GET', '/wa/incoming', mine)).json()
  assert.equal(inc.length, 1); assert.equal(inc[0].name, 'Hina Buyer')
  assert.equal(Object.hasOwn(inc[0], 'sdp_offer'), false, 'the list does not carry SDP')
  const inId = inc[0].id
  assert.equal((await (await call('GET', `/wa/calls/${inId}/offer`, mine)).json()).sdp, offer)
  assert.equal((await call('POST', `/wa/calls/${inId}/accept`, mine, { sdp: 'nope' })).status, 400)
  assert.equal((await call('POST', `/wa/calls/${inId}/accept`, mine, { sdp: 'v=0\r\nanswer' })).status, 200)
  const acc = sent.filter(s => s.url.includes('/calls')).at(-1).body
  assert.equal(acc.action, 'accept'); assert.equal(acc.call_id, 'wacid.IN1'); assert.equal(acc.session.sdp_type, 'answer')
  assert.equal((await call('POST', `/wa/calls/${inId}/accept`, mine, { sdp: 'v=0\r\nanswer' })).status, 400, 'a call can be answered once')
  assert.equal((await (await call('GET', '/wa/incoming', mine)).json()).length, 0)

  // recording is off until an admin switches it on, and only the agent on the call may save it
  const audio = Buffer.alloc(900, 7).toString('base64')
  assert.equal((await call('POST', `/wa/calls/${inId}/recording`, mine, { data: audio, mime: 'audio/webm;codecs=opus' })).status, 400, 'off by default')
  assert.equal((await call('PUT', '/wa/config', admin, { phone_number_id: '104567890', calling: true, record_calls: true })).status, 200)
  assert.equal((await (await call('GET', '/wa/config', admin)).json()).record_calls, true)
  assert.equal((await call('POST', `/wa/calls/${inId}/recording`, other, { data: audio })).status, 404, 'not visible to someone who cannot see the lead')
  assert.equal((await call('POST', `/wa/calls/${inId}/recording`, admin, { data: audio })).status, 403, 'only the agent on the call may save it')
  assert.equal((await call('POST', `/wa/calls/${inId}/recording`, mine, { data: audio, mime: 'video/mp4' })).status, 400)
  assert.equal((await call('POST', `/wa/calls/${inId}/recording`, mine, { data: 'AA==', mime: 'audio/webm' })).status, 400, 'an empty recording is refused')
  assert.equal((await call('POST', `/wa/calls/${inId}/recording`, mine, { data: audio, mime: 'audio/webm;codecs=opus' })).status, 200)
  assert.equal((await call('GET', `/wa/calls/${inId}/recording`, other)).status, 404)
  const rec = await call('GET', `/wa/calls/${inId}/recording`, admin)
  assert.equal(rec.status, 200); assert.equal(rec.headers.get('content-type'), 'audio/webm'); assert.equal((await rec.arrayBuffer()).byteLength, 900)
  assert.equal((await (await call('GET', `/leads/${leadId}/wa`, admin)).json()).calls.find(c => c.id === inId).has_recording, 1)
  await callHook({ id: 'wacid.IN1', event: 'terminate', direction: 'USER_INITIATED', status: 'COMPLETED', duration: 61 })
  const lead2 = await (await call('GET', `/leads/${leadId}`, admin)).json()
  assert.ok(lead2.activities.some(a => a.type === 'call' && /61 seconds/.test(a.notes)), 'an answered incoming call is logged with its length')

  // declined and missed calls
  await ring('wacid.IN2')
  const in2 = (await (await call('GET', '/wa/incoming', mine)).json())[0].id
  assert.equal((await call('POST', `/wa/calls/${in2}/reject`, mine, {})).status, 200)
  assert.equal(sent.filter(s => s.url.includes('/calls')).at(-1).body.action, 'reject')
  await ring('wacid.IN3'); await callHook({ id: 'wacid.IN3', event: 'terminate', direction: 'USER_INITIATED', status: 'FAILED' })
  const calls = (await (await call('GET', `/leads/${leadId}/wa`, admin)).json()).calls
  assert.equal(calls.filter(c => c.direction === 'in' && c.status === 'missed').length, 2, 'declined and hung-up-before-answer both count as missed')
  assert.equal((await (await call('GET', '/wa/incoming', mine)).json()).length, 0)

  // a number belongs to one company; another account cannot use it
  assert.equal((await call('PUT', '/wa/config', admin, { phone_number_id: '104567890' })).status, 200, 'the same company can re-save its own number')
})
