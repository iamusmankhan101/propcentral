import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import Icon from './Icon.jsx'

const STORE = 'assistant-chat'
const loadChat = () => { try { return JSON.parse(sessionStorage.getItem(STORE)) || [] } catch { return [] } }

export default function Assistant() {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState(loadChat)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const log = useRef()

  useEffect(() => { sessionStorage.setItem(STORE, JSON.stringify(msgs.slice(-30))) }, [msgs])
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }) }, [msgs, busy, open])
  useEffect(() => {
    if (!open) return
    const esc = e => e.key === 'Escape' && setOpen(false)
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [open])

  const send = async e => {
    e.preventDefault()
    const q = text.trim()
    if (!q || busy) return
    setText('')
    setError('')
    const history = [...msgs, { role: 'user', content: q }]
    setMsgs(history)
    setBusy(true)
    try {
      const r = await api('/assistant', { body: { messages: history } })
      setMsgs([...history, { role: 'assistant', content: r.reply }])
    } catch (err) {
      setError(err.message || 'The assistant is unavailable.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="assistant">
      {open && (
        <section className="assistant-panel" aria-label="Assistant">
          <header>
            <b><Icon name="ask" size={16} /> Assistant</b>
            <button className="ghost small" onClick={() => { setMsgs([]); setError('') }}>Clear</button>
            <button className="ghost small" onClick={() => setOpen(false)} aria-label="Close assistant">✕</button>
          </header>
          <div className="assistant-log" ref={log}>
            {!msgs.length && <p className="muted">Ask about your floor: “How many leads came in this week?”, “Who booked the most this month?”, “What is my commission total so far?”</p>}
            {msgs.map((m, i) => <p key={i} className={`assistant-msg ${m.role}`}>{m.content}</p>)}
            {busy && <p className="assistant-msg assistant-thinking">Thinking…</p>}
            {error && <p className="error">{error}</p>}
          </div>
          <form className="assistant-input" onSubmit={send}>
            <input value={text} onChange={e => setText(e.target.value)} placeholder="Ask about sales, agents, commissions…" maxLength={500} disabled={busy} autoFocus />
            <button className="btn primary" disabled={busy || !text.trim()} aria-label="Send question">Send</button>
          </form>
        </section>
      )}
      <button className="assistant-fab" onClick={() => setOpen(!open)} aria-label="Assistant" aria-expanded={open}>
        <Icon name="ask" size={22} />
      </button>
    </div>
  )
}
