/**
 * G.711 μ-law — zvuk pro příposlech a vysílačku. 16 kHz × 8 bitů =
 * 16 kB/s: řeč i pláč srozumitelné, přes mobilní data bez potíží.
 * Kódování je bez knihoven a stejné v prohlížeči i v testech.
 */

export const VZORKOVANI = 16000
/** Vzorků v jednom rámci (20 ms). */
export const RAMEC = 320

const BIAS = 0x84
const CLIP = 32635

export function zakoduj(vzorek) {
  // vzorek: −1…1
  let s = Math.round(Math.max(-1, Math.min(1, vzorek)) * 32767)
  const znamenko = s < 0 ? 0x80 : 0
  if (s < 0) s = -s
  if (s > CLIP) s = CLIP
  s += BIAS
  let exponent = 7
  for (let maska = 0x4000; (s & maska) === 0 && exponent > 0; maska >>= 1) exponent--
  const mantisa = (s >> (exponent + 3)) & 0x0f
  return ~(znamenko | (exponent << 4) | mantisa) & 0xff
}

export function dekoduj(bajt) {
  const u = ~bajt & 0xff
  const znamenko = u & 0x80
  const exponent = (u >> 4) & 0x07
  const mantisa = u & 0x0f
  let s = ((mantisa << 3) + BIAS) << exponent
  s -= BIAS
  return (znamenko ? -s : s) / 32768
}

export function zakodujPole(vzorky) {
  const out = new Uint8Array(vzorky.length)
  for (let i = 0; i < vzorky.length; i++) out[i] = zakoduj(vzorky[i])
  return out
}

export function dekodujPole(bajty) {
  const out = new Float32Array(bajty.length)
  for (let i = 0; i < bajty.length; i++) out[i] = dekoduj(bajty[i])
  return out
}

/**
 * Převzorkování lineární interpolací (48 kHz → 16 kHz a zpět). Na řeč
 * a pláč stačí; filtr proti aliasingu dělá vysokopásmová/dolní propust
 * v grafu před záznamem.
 */
export function prevzorkuj(vzorky, z, na) {
  if (z === na) return vzorky
  const pomer = z / na
  const delka = Math.floor(vzorky.length / pomer)
  const out = new Float32Array(delka)
  for (let i = 0; i < delka; i++) {
    const p = i * pomer
    const a = Math.floor(p)
    const b = Math.min(a + 1, vzorky.length - 1)
    const f = p - a
    out[i] = vzorky[a] * (1 - f) + vzorky[b] * f
  }
  return out
}
