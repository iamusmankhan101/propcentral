import app from '../server/server.js'

// Vercel strips the function route in some setups; make sure Express always sees /api/*
export default function handler(req, res) {
  const url = req.url || '/'
  if (!/^\/api(\/|$|\?)/.test(url)) req.url = '/api' + (url.startsWith('/') ? url : '/' + url)
  return app(req, res)
}
