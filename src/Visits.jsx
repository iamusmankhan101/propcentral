import { useState } from 'react'
import { api, useApi, useMeta, useAction, formData, toIso } from './api.js'
import { Select, When } from './Leads.jsx'

const here = () => new Promise((ok, fail) =>
  navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), () => fail(new Error('Allow location access to check in')), { enableHighAccuracy: true, timeout: 15000 }))

export default function Visits() {
  const [rows, reload] = useApi('/visits')
  const [open, setOpen] = useState()
  return (
    <section>
      <h2>Site visits</h2>
      <div className="card scroll">
        <table>
          <thead><tr><th>When</th><th>Customer</th><th>Site</th><th>Agent</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows?.map(v => (
              <tr key={v.id}>
                <When d={v.scheduled_at} />
                <td><a href={'#/leads/' + v.lead_id}>{v.name}</a></td>
                <td>{v.site}{v.distance_m != null && <small> · {v.distance_m} m</small>}</td>
                <td>{v.agent_name}</td>
                <td>
                  <b className={v.status === 'verified' ? 'ok' : 'warn'}>{v.status}</b>
                  {!!v.unverified && <small className="error"> · unverified</small>}
                  {!!v.feedback_overdue && <small className="error"> · feedback overdue</small>}
                </td>
                <td>{(v.status !== 'verified' || !v.has_feedback) && <button className="ghost" onClick={() => setOpen(open === v.id ? null : v.id)}>{open === v.id ? 'Close' : 'Open'}</button>}</td>
              </tr>
            ))}
            {rows?.length === 0 && <tr><td colSpan="6" className="muted">No visits yet. Schedule one from a lead.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && <VisitActions v={rows.find(r => r.id === open)} reload={reload} />}
    </section>
  )
}

function VisitActions({ v, reload }) {
  const { me } = useMeta()
  const { run, error, busy } = useAction()
  const mine = v.agent_id === me.id
  const checkin = () => run(async () => { await api(`/visits/${v.id}/checkin`, { body: await here() }); reload() })
  const verify = e => { const body = formData(e); run(async () => { await api(`/visits/${v.id}/verify`, { body }); reload() }) }
  const feedback = e => {
    const body = formData(e)
    run(async () => { await api(`/visits/${v.id}/feedback`, { body: { ...body, next_action_at: toIso(body.next_action_at) } }); reload() })
  }
  return (
    <div className="card">
      <h3>{v.name} at {v.site}</h3>
      {v.status === 'scheduled' && (mine
        ? <><p className="muted">At the site, check in. Your GPS must be inside the site radius; the customer then receives an SMS code.</p><button disabled={busy} onClick={checkin}>Check in with GPS</button></>
        : <p className="muted">Only {v.agent_name} can check in.</p>)}
      {v.status === 'checked_in' && (
        <form className="row" onSubmit={verify}>
          <input name="otp" inputMode="numeric" pattern="\d{6}" placeholder="6-digit code from customer" required />
          <button disabled={busy}>Verify</button>
          <button type="button" className="ghost" disabled={busy} onClick={checkin}>Resend (check in again)</button>
        </form>
      )}
      {v.status === 'verified' && !v.has_feedback && (
        <form className="grid" onSubmit={feedback}>
          <label>Interest *<Select name="interest" options={['Hot', 'Warm', 'Cold']} required /></label>
          <label>Units shown<input name="units_shown" /></label>
          <label className="wide">Objections<textarea name="objections" rows="2" /></label>
          <label>Next step *<input name="next_step" required /></label>
          <label>Follow-up date *<input name="next_action_at" type="datetime-local" required /></label>
          <div className="wide"><button disabled={busy}>Save feedback</button></div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
