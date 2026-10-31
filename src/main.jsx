import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './style.css'

createRoot(document.getElementById('root')).render(<App />)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Reload once when a new service worker takes over, so a deploy never leaves a stale bundle running
    const hadController = !!navigator.serviceWorker.controller
    let reloaded = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return
      reloaded = true
      window.location.reload()
    })
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.log('SW registration error:', err)
    })
  })
}
