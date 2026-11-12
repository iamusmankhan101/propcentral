import { useState } from 'react'
import { api, useApi, useAction, fmt } from './api.js'

// Calls handled by the company's own phone exchange (server/telephony.js). The exchange records them and sends the CRM the details;
// the recording stays with the exchange and is played from its link.
const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const label = c => `${c.direction === 'in' ? 'Incoming' : 'Outgoing'} · ${c.status}${c.duration ? ' · ' + clock(c.duration) : ''}`

function Recording({ url }) {
  const [on, setOn] = useState(false)
  if (!url) return null
  return on
    ? <span><audio src={url} controls autoPlay style={{ height: 30, verticalAlign: 'middle' }} /> <a href={url} target="_blank" rel="noreferrer">Open</a></span>
    : <button className="ghost" onClick={() => setOn(true)}>Play recording</button>
}

export function PhoneCallsCard({ leadId }) {
  const [rows, , error] = useApi(`/leads/${leadId}/phone-calls`)
  if (error || !rows || rows.length === 0) return null // shown only once the exchange has reported a call for this customer
  return (
    <div className="card">
      <h3>Phone calls <span className="count">{rows.length}</span></h3>
      {rows.map(c => (
        <p key={c.id} style={{ margin: '6px 0' }}>
          <small>{label(c)}{c.agent_name ? ' · ' + c.agent_name : ''} · {fmt(c.started_at || c.created_at)}</small> <Recording url={c.recording_url} />
        </p>
      ))}
    </div>
  )
}

export function PhoneCallsSettings() {
  const [c, reload, error] = useApi('/tel/config')
  const { run, error: err, busy } = useAction()
  const [shown, setShown] = useState(false)
  if (error) return <p className="error">{error}</p>
  if (!c) return <p className="muted">Loading…</p>
  const copy = v => navigator.clipboard?.writeText(v)
  const rotate = () => { if (confirm('Create a new key? The exchange stops working until you give it the new one.')) run(async () => { await api('/tel/config/rotate', { body: {} }); reload() }) }
  const sample = `curl -X POST ${c.endpoint} \\\n  -H "x-api-key: ${shown ? c.api_key : 'YOUR_KEY'}" -H "content-type: application/json" \\\n  -d '{"call_id":"1001","direction":"in","from":"03001234567","extension":"101","duration":125,"status":"answered","recording_url":"https://..."}'`
  return (
    <div>
      <div className="card">
        <p className="muted">Your phone exchange (the main number that rings your agents) records the calls. When a call ends, the exchange sends its details here, and the CRM adds it to the right lead with a link to the recording. Nothing is dialled from the CRM and no audio is stored here.</p>
        <p>Web address for the exchange <code>{c.endpoint}</code> <button className="ghost" onClick={() => copy(c.endpoint)}>Copy</button></p>
        <p>Key <code>{shown ? c.api_key : '••••••••••••••••••••••'}</code> <button className="ghost" onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show'}</button> <button className="ghost" onClick={() => copy(c.api_key)}>Copy</button> <button className="ghost" onClick={rotate} disabled={busy}>New key</button></p>
        {err && <p className="error">{err}</p>}
        <p className="muted"><small>Send the key as the <b>x-api-key</b> header. Give your exchange provider this page, or the example below.</small></p>
        <pre style={{ overflowX: 'auto', background: '#f4f6f8', padding: 10, borderRadius: 8, fontSize: 12 }}>{sample}</pre>
        <p className="muted"><small>Accepted fields (common alternatives work too): <b>call_id</b> (so retries are not counted twice), <b>direction</b> (in or out), <b>from</b>, <b>to</b>, <b>extension</b> or <b>agent_email</b>, <b>duration</b> (seconds), <b>status</b>, <b>recording_url</b>, <b>started_at</b>. An unknown number that calls you becomes a new lead; set each agent's extension under Users so the call goes to the right agent.</small></p>
      </div>
      <div className="card scroll">
        <h3>Recent calls {c.stats.total > 0 && <small className="muted">{c.stats.total} total · {c.stats.recorded} recorded{c.stats.unmatched ? ` · ${c.stats.unmatched} without a lead` : ''}{c.stats.no_agent ? ` · ${c.stats.no_agent} without an agent` : ''}</small>}</h3>
        <table>
          <thead><tr><th>When</th><th>Customer</th><th>Call</th><th>Agent</th><th></th></tr></thead>
          <tbody>
            {c.recent.map(r => (
              <tr key={r.id}>
                <td className="nowrap">{fmt(r.created_at)}</td>
                <td>{r.lead_id ? <a href={'#/leads/' + r.lead_id}>+{r.customer_phone}</a> : <>+{r.customer_phone} <small className="muted">no lead</small></>}</td>
                <td>{label(r)}</td>
                <td>{r.agent_name || <small className="warn">{r.agent_ref ? `unknown: ${r.agent_ref}` : 'unknown'}</small>}</td>
                <td><Recording url={r.recording_url} /></td>
              </tr>
            ))}
            {c.recent.length === 0 && <tr><td colSpan="5" className="muted">No calls received yet. Once your exchange is connected they appear here.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
