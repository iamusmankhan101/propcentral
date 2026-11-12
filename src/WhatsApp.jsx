import { useEffect, useRef, useState } from 'react'
import { api, useApi, useMeta, useAction, formData, fmt, readFile } from './api.js'

// One main WhatsApp number (server/whatsapp.js): a thread on every lead, calls placed from the browser, a shared inbox
// and the connection settings. Nothing here appears until an admin connects the number in Settings › WhatsApp.

const waitForIce = (pc, ms = 4000) => new Promise(done => {
  if (pc.iceGatheringState === 'complete') return done()
  const finish = () => { pc.removeEventListener('icegatheringstatechange', check); done() }
  const check = () => pc.iceGatheringState === 'complete' && finish()
  pc.addEventListener('icegatheringstatechange', check)
  setTimeout(finish, ms)
})
const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// Records both sides of a call in the agent's browser (Meta does not record). Only used when an admin switched recording on.
function makeRecorder(local) {
  if (!window.MediaRecorder || !window.AudioContext) return null
  try {
    const ctx = new AudioContext(), dest = ctx.createMediaStreamDestination()
    ctx.createMediaStreamSource(local).connect(dest)
    const rec = new MediaRecorder(dest.stream, MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : undefined), chunks = []
    rec.ondataavailable = e => e.data.size && chunks.push(e.data)
    return {
      addRemote: stream => ctx.createMediaStreamSource(stream).connect(dest),
      start: () => rec.state === 'inactive' && rec.start(2000),
      stop: () => new Promise(done => { rec.onstop = () => { ctx.close().catch(() => {}); done(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })) }; rec.state !== 'inactive' ? rec.stop() : done(null) }),
    }
  } catch { return null }
}

// Browser side of a WhatsApp call (outgoing or answering a customer): microphone <-> WebRTC <-> the server <-> Meta.
// Meta's SDP answer for an outgoing call arrives by webhook and is polled here; for an incoming call the browser makes the answer.
export function useWaCall(recording, onChange = () => {}) {
  const [state, setState] = useState({ phase: 'idle' }) // idle | starting | ringing | connected | ended
  const ref = useRef({})
  const release = () => {
    clearInterval(ref.current.poll); clearInterval(ref.current.tick)
    ref.current.pc?.close(); ref.current.stream?.getTracks().forEach(t => t.stop())
  }
  useEffect(() => () => { release(); ref.current = {} }, [])
  // stop everything, save the recording if there was a conversation, and show how it ended
  const finish = async (patch, connected) => {
    const { rec, id } = ref.current
    const blob = rec ? await rec.stop() : null
    release(); ref.current = {}
    setState({ phase: 'ended', ...patch }); onChange()
    if (blob && connected && blob.size > 500 && id) {
      const data = (await readFile(blob)).split(',')[1]
      api(`/wa/calls/${id}/recording`, { body: { data, mime: blob.type } }).catch(() => {})
    }
  }
  const prepare = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('This browser cannot place calls. Use a current Chrome, Edge or Safari over https.')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => { throw new Error('Allow the microphone to take calls.') })
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    const rec = recording ? makeRecorder(stream) : null
    ref.current = { pc, stream, rec }
    stream.getTracks().forEach(t => pc.addTrack(t, stream))
    const audio = Object.assign(document.createElement('audio'), { autoplay: true })
    pc.ontrack = e => { audio.srcObject = e.streams[0]; rec?.addRemote(e.streams[0]) }
    return pc
  }
  const watch = (id, connectedAlready) => {
    let answered = connectedAlready, seconds = 0
    const connected = pc => {
      ref.current.rec?.start()
      ref.current.tick = setInterval(() => setState(s => (s.phase === 'connected' ? { ...s, seconds: ++seconds } : s)), 1000)
      setState({ phase: 'connected', id, seconds: 0 })
    }
    if (connectedAlready) connected()
    ref.current.poll = setInterval(async () => {
      const c = await api('/wa/calls/' + id).catch(() => null)
      if (!c) return
      if (c.sdp_answer && !answered) { // outgoing: Meta answered
        answered = true
        await ref.current.pc?.setRemoteDescription({ type: 'answer', sdp: c.sdp_answer }).catch(() => {})
        connected()
      }
      if (c.status === 'ended' || c.status === 'failed' || c.status === 'missed') finish({ failed: c.status !== 'ended', error: c.error, seconds: c.duration || seconds }, answered)
    }, 1000)
    return () => answered
  }
  const start = async leadId => { // outgoing
    setState({ phase: 'starting' })
    try {
      const pc = await prepare()
      await pc.setLocalDescription(await pc.createOffer())
      await waitForIce(pc)
      const { id } = await api(`/leads/${leadId}/wa/call`, { body: { sdp: pc.localDescription.sdp } })
      ref.current.id = id
      setState({ phase: 'ringing', id })
      ref.current.answered = watch(id, false)
    } catch (e) { await finish({ failed: true, error: e.message }, false) }
  }
  const answer = async callId => { // a customer is calling
    setState({ phase: 'starting' })
    try {
      const pc = await prepare()
      const { sdp } = await api(`/wa/calls/${callId}/offer`)
      await pc.setRemoteDescription({ type: 'offer', sdp })
      await pc.setLocalDescription(await pc.createAnswer())
      await waitForIce(pc)
      await api(`/wa/calls/${callId}/accept`, { body: { sdp: pc.localDescription.sdp } })
      ref.current.id = callId
      ref.current.answered = watch(callId, true)
    } catch (e) { await finish({ failed: true, error: e.message }, false) }
  }
  const hangup = async () => {
    const id = ref.current.id, was = state.phase === 'connected', secs = state.seconds || 0
    if (id) await api(`/wa/calls/${id}/hangup`, { body: {} }).catch(() => {})
    await finish({ failed: !was, seconds: secs }, was)
  }
  return { state, start, answer, hangup, reset: () => setState({ phase: 'idle' }) }
}

// Banner for a customer calling in. Mounted once for the whole app, so an agent can answer from any page.
export function IncomingCalls() {
  const m = useMeta()
  const [ringing, setRinging] = useState([])
  const call = useWaCall(m.wa?.recording)
  const live = ['starting', 'connected'].includes(call.state.phase)
  useEffect(() => {
    if (!m.wa?.calling) return
    let alive = true
    const poll = () => api('/wa/incoming').then(r => alive && setRinging(r), () => {})
    poll(); const t = setInterval(poll, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [m.wa?.calling])
  const decline = id => api(`/wa/calls/${id}/reject`, { body: {} }).catch(() => {}).then(() => setRinging(r => r.filter(x => x.id !== id)))
  const box = { position: 'fixed', top: 70, right: 16, zIndex: 50, display: 'grid', gap: 8, maxWidth: 340 }
  const card = { background: '#111827', color: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 8px 30px rgba(0,0,0,.3)' }
  if (!live && call.state.phase !== 'ended' && ringing.length === 0) return null
  return (
    <div style={box} role="alert">
      {!live && ringing.map(r => (
        <div key={r.id} style={card}>
          <b>{r.name}</b> is calling you on WhatsApp
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => { setRinging([]); call.answer(r.id) }}>Answer</button>
            <button className="ghost" onClick={() => decline(r.id)}>Decline</button>
          </div>
        </div>
      ))}
      {live && (
        <div style={card}>
          {call.state.phase === 'starting' ? 'Connecting…' : `On a WhatsApp call · ${clock(call.state.seconds || 0)}`}
          <div className="row" style={{ marginTop: 8 }}><button className="danger" onClick={call.hangup}>End call</button></div>
        </div>
      )}
      {call.state.phase === 'ended' && (
        <div style={card}>
          {call.state.failed ? (call.state.error || 'The call ended.') : `Call ended · ${clock(call.state.seconds || 0)}. Logged on the lead.`}
          <div className="row" style={{ marginTop: 8 }}><button className="ghost" onClick={call.reset}>Dismiss</button></div>
        </div>
      )}
    </div>
  )
}

function PlayRecording({ id }) {
  const [url, setUrl] = useState(null), [err, setErr] = useState('')
  const load = async () => {
    try {
      const r = await fetch(`/api/wa/calls/${id}/recording`, { headers: { authorization: 'Bearer ' + (localStorage.token || '') } })
      if (!r.ok) throw new Error('Recording not available')
      setUrl(URL.createObjectURL(await r.blob()))
    } catch (e) { setErr(e.message) }
  }
  return url ? <audio src={url} controls autoPlay style={{ height: 30, verticalAlign: 'middle' }} /> : <button className="ghost" onClick={load}>{err || 'Play recording'}</button>
}

function Thread({ d }) {
  const end = useRef()
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [d.messages.length])
  return (
    <div className="wa-thread" style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 2px' }}>
      {d.messages.length === 0 && <p className="muted">No WhatsApp messages yet.</p>}
      {d.messages.map(m => (
        <div key={m.id} style={{ alignSelf: m.direction === 'out' ? 'flex-end' : 'flex-start', maxWidth: '82%', background: m.direction === 'out' ? '#dcf8c6' : '#f1f3f5', borderRadius: 10, padding: '6px 10px' }}>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
          <small className="muted">{m.direction === 'out' && m.sender ? m.sender + ' · ' : ''}{fmt(m.created_at)}{m.direction === 'out' && m.status ? ' · ' + m.status : ''}{m.error ? ' · ' + m.error : ''}</small>
        </div>
      ))}
      <div ref={end} />
    </div>
  )
}

export function WaPanel({ leadId, onActivity }) {
  const m = useMeta()
  const [d, reload, error] = useApi(`/leads/${leadId}/wa`)
  const [tpls, setTpls] = useState(null)
  const { run, error: err, busy } = useAction()
  const call = useWaCall(d?.recording, () => { reload(); onActivity?.() })
  useEffect(() => { const t = setInterval(reload, 6000); return () => clearInterval(t) }, [reload])
  if (error) return <p className="error">{error}</p>
  if (!d) return <div className="card"><h3>WhatsApp</h3><p className="muted">Loading…</p></div>
  const send = e => { const form = e.target, body = formData(e); run(async () => { await api(`/leads/${leadId}/wa/send`, { body }); form.reset(); reload(); onActivity?.() }) }
  const loadTpls = () => run(async () => setTpls(await api('/wa/templates')))
  const sendTpl = e => {
    const f = formData(e), t = tpls.find(x => x.name === f.template)
    run(async () => { await api(`/leads/${leadId}/wa/template`, { body: { name: t.name, language: t.language, params: Array.from({ length: t.params }, (_, i) => f['p' + i]) } }); reload() })
  }
  const askPermission = () => run(async () => { await api(`/leads/${leadId}/wa/call-permission`, { body: {} }); reload() })
  const live = ['starting', 'ringing', 'connected'].includes(call.state.phase)
  return (
    <div className="card">
      <div className="row between">
        <h3>WhatsApp {d.display_number && <small className="muted">via {d.display_number}</small>}</h3>
        {d.calling && (live
          ? <button className="danger" onClick={call.hangup}>End call</button>
          : d.permission === 'granted'
            ? <button onClick={() => call.start(leadId)}>Call on WhatsApp</button>
            : <button className="ghost" onClick={askPermission} disabled={busy || !d.window_open} title={d.window_open ? '' : 'Possible only within 24 hours of the customer writing'}>
              {d.permission === 'rejected' ? 'Customer declined calls' : 'Ask permission to call'}</button>)}
      </div>
      {live && d.recording && call.state.phase === 'connected' && <p className="warn"><small>This call is being recorded.</small></p>}
      {live && <p className="ok">{call.state.phase === 'connected' ? `On call · ${clock(call.state.seconds || 0)}` : call.state.phase === 'starting' ? 'Preparing…' : 'Ringing…'}</p>}
      {call.state.phase === 'ended' && <p className={call.state.failed ? 'error' : 'ok'}>{call.state.failed ? (call.state.error || 'Call not answered.') : `Call ended · ${clock(call.state.seconds || 0)}. It is logged in the timeline.`} <a href="#" onClick={e => { e.preventDefault(); call.reset() }}>Dismiss</a></p>}
      {d.calling && d.permission === 'none' && <p className="muted"><small>The customer must allow calls before you can ring them. Send the request, then call once they accept.</small></p>}
      {d.calling && d.permission === 'expired' && <p className="muted"><small>Their call permission expired. Ask again.</small></p>}
      <Thread d={d} />
      {d.calls.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary className="muted">Calls ({d.calls.length})</summary>
          {d.calls.map(c => (
            <p key={c.id} style={{ margin: '4px 0' }}><small>{c.direction === 'in' ? 'Incoming' : 'Outgoing'} · {c.status}{c.duration ? ` · ${clock(c.duration)}` : ''} · {fmt(c.created_at)}</small> {c.has_recording ? <PlayRecording id={c.id} /> : null}</p>
          ))}
        </details>
      )}
      {err && <p className="error">{err}</p>}
      {d.window_open ? (
        <form className="row" onSubmit={send}>
          <input name="text" placeholder="Write a WhatsApp message" maxLength={4000} required autoComplete="off" style={{ flex: 1 }} />
          <button disabled={busy}>Send</button>
        </form>
      ) : !tpls ? (
        <p className="muted">More than 24 hours since the customer wrote. WhatsApp only allows an approved template now. <a href="#" onClick={e => { e.preventDefault(); loadTpls() }}>Choose a template</a></p>
      ) : (
        <form className="grid" onSubmit={e => { e.preventDefault(); sendTpl(e) }}>
          <TemplatePicker tpls={tpls} busy={busy} />
        </form>
      )}
    </div>
  )
}

function TemplatePicker({ tpls, busy }) {
  const [name, setName] = useState(tpls[0]?.name || '')
  const t = tpls.find(x => x.name === name)
  if (!tpls.length) return <p className="muted wide">No approved templates found. Create one in WhatsApp Manager.</p>
  return <>
    <label className="wide">Template<select name="template" value={name} onChange={e => setName(e.target.value)}>{tpls.map(x => <option key={x.name} value={x.name}>{x.name} ({x.language})</option>)}</select></label>
    {t && <p className="muted wide"><small>{t.text}</small></p>}
    {t && Array.from({ length: t.params }, (_, i) => <label key={name + i}>Value {`{{${i + 1}}}`}<input name={'p' + i} required /></label>)}
    <div className="wide"><button disabled={busy}>Send template</button></div>
  </>
}

export function WaInbox() {
  const m = useMeta()
  const [rows, reload, error] = useApi('/wa/inbox')
  useEffect(() => { const t = setInterval(reload, 8000); return () => clearInterval(t) }, [reload])
  if (!m.wa?.connected) return <div className="card"><h3>WhatsApp</h3><p className="muted">WhatsApp is not connected yet. An admin can connect the main number in Settings › WhatsApp.</p></div>
  return (
    <section>
      <div className="card scroll">
        <h3>WhatsApp inbox {rows && <span className="count">{rows.length}</span>}</h3>
        {error && <p className="error">{error}</p>}
        <table>
          <thead><tr><th>Customer</th><th>Last message</th><th>Agent</th><th>When</th></tr></thead>
          <tbody>
            {rows?.map(r => (
              <tr key={r.lead_id} onClick={() => { location.hash = '#/leads/' + r.lead_id }} style={{ cursor: 'pointer' }}>
                <td><b>{r.name}</b>{r.unread > 0 && <span className="count" style={{ marginLeft: 6 }}>{r.unread}</span>}<small className="muted"><br />{r.status}</small></td>
                <td>{r.direction === 'out' ? 'You: ' : ''}{(r.body || '').slice(0, 90)}</td>
                <td>{r.agent_name || 'Unassigned'}</td>
                <td className="nowrap">{fmt(r.created_at)}</td>
              </tr>
            ))}
            {rows?.length === 0 && <tr><td colSpan="4" className="muted">No conversations yet. They appear here when a customer writes to your WhatsApp number.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function WaSettings() {
  const m = useMeta()
  const [c, reload, error] = useApi('/wa/config')
  const { run, error: err, busy } = useAction()
  const [msg, setMsg] = useState('')
  if (error) return <p className="error">{error}</p>
  if (!c) return <p className="muted">Loading…</p>
  const save = e => { const body = { ...formData(e), calling: e.target.calling.checked, record_calls: e.target.record_calls.checked }; run(async () => { await api('/wa/config', { method: 'PUT', body }); setMsg('Saved'); reload(); m.reloadMeta() }) }
  const test = () => run(async () => { const r = await api('/wa/config/test', { body: {} }); setMsg(`Connected: ${r.number}${r.name ? ' · ' + r.name : ''}${r.quality ? ' · quality ' + r.quality : ''}`); reload(); m.reloadMeta() })
  const copy = v => navigator.clipboard?.writeText(v)
  return (
    <div>
      <form className="card grid" onSubmit={save} onChange={() => setMsg('')}>
        <p className="muted wide">Connect your company's one main WhatsApp number (official WhatsApp Business Cloud API). Agents then chat with leads and call them on WhatsApp from the CRM. Get the values below from your Meta developer app and WhatsApp Manager.</p>
        <label>Phone number ID<input name="phone_number_id" defaultValue={c.phone_number_id} inputMode="numeric" placeholder="e.g. 104567890123456" /></label>
        <label>WhatsApp Business Account ID<input name="waba_id" defaultValue={c.waba_id} inputMode="numeric" placeholder="needed to list templates" /></label>
        <label>Access token {c.has_token && <small className="ok">saved</small>}<input name="access_token" type="password" autoComplete="off" placeholder={c.has_token ? 'Leave empty to keep the saved token' : 'Permanent system-user token'} /></label>
        <label>App secret {c.has_secret && <small className="ok">saved</small>}<input name="app_secret" type="password" autoComplete="off" placeholder={c.has_secret ? 'Leave empty to keep the saved secret' : 'Used to check webhook signatures'} /></label>
        <label className="wide row"><input type="checkbox" name="calling" defaultChecked={c.calling} style={{ width: 18, height: 18 }} /> Calling is switched on for this number in WhatsApp Manager</label>
        <label className="wide row"><input type="checkbox" name="record_calls" defaultChecked={c.record_calls} style={{ width: 18, height: 18 }} /> Record calls (saved from the agent's browser; tell customers they may be recorded)</label>
        {(err) && <p className="error wide">{err}</p>}
        <div className="wide row">
          <button disabled={busy}>Save</button>
          <button type="button" className="ghost" onClick={test} disabled={busy || !c.has_token || !c.phone_number_id}>Test connection</button>
          {msg && <span className="ok">{msg}</span>}
        </div>
      </form>
      <div className="card">
        <h3>Webhook for your Meta app</h3>
        <p className="muted">In your Meta app › WhatsApp › Configuration, set these and subscribe to the <b>messages</b> and <b>calls</b> fields.</p>
        <p>Callback URL <code>{c.webhook_url}</code> <button className="ghost" onClick={() => copy(c.webhook_url)}>Copy</button></p>
        <p>Verify token <code>{c.verify_token || 'Save the settings once to generate it'}</code> {c.verify_token && <button className="ghost" onClick={() => copy(c.verify_token)}>Copy</button>}</p>
        <p className="muted"><small>Customers must accept a call request before agents can ring them, and free-form messages work only within 24 hours of the customer writing (otherwise an approved template). Business-initiated calling is not available in every country: check Meta's list for yours.</small></p>
      </div>
    </div>
  )
}
