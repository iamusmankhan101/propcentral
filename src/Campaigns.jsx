import { useApi, fmtParts } from './api.js'

const pct = n => (n == null ? '—' : n + '%')

// Leads rolled up by the campaign and form they arrived from (Facebook/Instagram lead forms)
export default function Campaigns() {
  const [d, , error] = useApi('/campaigns')
  if (error) return <p className="error">{error}</p>
  const rows = d?.rows || []
  return (
    <section>
      <div className="row between">
        <h2>Campaigns {d && <span className="count">{rows.length}</span>}</h2>
        {d?.page_name && <span className="muted">Facebook page: <b>{d.page_name}</b></span>}
      </div>
      {!d ? <p className="muted pad">Loading…</p> : (
        <div className="card scroll">
          <table>
            <thead><tr><th>Campaign</th><th>Form ID</th><th>Source</th><th>Project</th><th>Leads</th><th>Open</th><th>Won</th><th>Conversion</th><th>Last lead</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={(r.campaign ?? '') + '\u0000' + (r.form_id ?? '')}>
                  <td><b>{r.campaign || '—'}</b></td>
                  <td>{r.form_id || '—'}</td>
                  <td>{r.source || '—'}</td>
                  <td>{r.project || '—'}</td>
                  <td>{r.leads}</td>
                  <td>{r.open}</td>
                  <td>{r.won}</td>
                  <td>{pct(r.conversion)}</td>
                  <td className="nowrap">{fmtParts(r.last_lead_at)[0]}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan="9" className="muted">No campaign leads yet. Leads from your Facebook lead forms appear here with their campaign and form.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
