// TOTP two-factor codes (RFC 6238: 30s steps, 6 digits, SHA-1), the format Google Authenticator, Authy and 1Password expect
import { createHmac, randomBytes } from 'node:crypto'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32(buf) {
  const bits = [...buf].map(b => b.toString(2).padStart(8, '0')).join('')
  return bits.match(/.{1,5}/g).map(c => B32[parseInt(c.padEnd(5, '0'), 2)]).join('')
}
const unbase32 = s => Buffer.from(([...s.toUpperCase()].map(c => B32.indexOf(c).toString(2).padStart(5, '0')).join('').match(/.{8}/g) || []).map(b => parseInt(b, 2)))

export const newSecret = () => base32(randomBytes(20))
export function totp(secret, at = Date.now()) {
  const step = Buffer.alloc(8)
  step.writeBigUInt64BE(BigInt(Math.floor(at / 30000)))
  const h = createHmac('sha1', unbase32(secret)).update(step).digest()
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0')
}
// accepts the previous and next 30s window too, for phone clock drift
export const checkTotp = (secret, code, at = Date.now()) => !!secret && [-1, 0, 1].some(w => totp(secret, at + w * 30000) === String(code ?? '').replace(/\s/g, ''))
