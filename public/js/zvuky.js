/**
 * Zvuky na chůvičce: vestavěné se vyrábějí přímo v telefonu (bílý,
 * růžový a hnědý šum a Brahmsova ukolébavka, volné dílo), nahrané
 * soubory hraje jeden `<audio>` prvek napojený do zvukového kontextu.
 */

import { t } from "./i18n.js"

export const ZVUKY = [
  { klic: "bily", nazev: "Bílý šum" },
  { klic: "ruzovy", nazev: "Růžový šum" },
  { klic: "hnedy", nazev: "Hnědý šum (hlubší)" },
  { klic: "ukolebavka", nazev: "Ukolébavka" },
]

/** Název vestavěného zvuku v jazyce telefonu (český název je klíčem překladu). */
export const nazevVestaveneho = (z) => (z ? t(z.nazev) : "")

function sum(ctx, druh) {
  const delka = ctx.sampleRate * 4
  const buffer = ctx.createBuffer(1, delka, ctx.sampleRate)
  const d = buffer.getChannelData(0)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, posledni = 0
  for (let i = 0; i < delka; i++) {
    const w = Math.random() * 2 - 1
    if (druh === "bily") d[i] = w * 0.5
    else if (druh === "ruzovy") {
      // Paul Kellet: růžový šum ze sady filtrů.
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
      b6 = w * 0.115926
    } else {
      posledni = (posledni + 0.02 * w) / 1.02
      d[i] = posledni * 3.5
    }
  }
  const zdroj = ctx.createBufferSource()
  zdroj.buffer = buffer
  zdroj.loop = true
  return zdroj
}

// Brahms, Wiegenlied — (nota, délka v dobách).
const C4 = 261.63, D4 = 293.66, E4 = 329.63, F4 = 349.23, G4 = 392, A4 = 440, B4 = 493.88, C5 = 523.25
const MELODIE = [
  [E4, 0.5], [E4, 0.5], [G4, 2],
  [E4, 0.5], [E4, 0.5], [G4, 2],
  [E4, 0.5], [G4, 0.5], [C5, 1], [B4, 1.5], [A4, 0.5], [A4, 1], [G4, 1],
  [D4, 0.5], [E4, 0.5], [F4, 1], [D4, 1], [D4, 0.5], [E4, 0.5], [F4, 2],
  [D4, 0.5], [F4, 0.5], [B4, 0.5], [A4, 0.5], [G4, 1], [B4, 1], [C5, 2],
  [C4, 0.5], [C4, 0.5], [C5, 2], [A4, 0.5], [F4, 0.5], [G4, 2],
  [E4, 0.5], [C4, 0.5], [F4, 1], [G4, 1], [A4, 1], [G4, 2],
  [C4, 0.5], [C4, 0.5], [C5, 2], [A4, 0.5], [F4, 0.5], [G4, 2],
  [E4, 0.5], [C4, 0.5], [F4, 1], [E4, 1], [D4, 1], [C4, 3],
]
const DOBA = 0.62

function ukolebavka(ctx, vystup) {
  let zastaveno = false
  let dalsi = ctx.currentTime + 0.2
  let i = 0
  const tikac = setInterval(() => {
    // Plánuje se vždy na 2 s dopředu — přesně, i když se stránka zpomalí.
    while (!zastaveno && dalsi < ctx.currentTime + 2) {
      const [f, doby] = MELODIE[i % MELODIE.length]
      const trvani = doby * DOBA
      for (const [nasobek, sila] of [[1, 1], [2, 0.15]]) {
        const osc = ctx.createOscillator()
        osc.type = "sine"
        osc.frequency.value = f * nasobek
        const obalka = ctx.createGain()
        obalka.gain.setValueAtTime(0, dalsi)
        obalka.gain.linearRampToValueAtTime(0.35 * sila, dalsi + 0.05)
        obalka.gain.exponentialRampToValueAtTime(0.0001, dalsi + trvani * 0.95)
        osc.connect(obalka).connect(vystup)
        osc.start(dalsi)
        osc.stop(dalsi + trvani)
      }
      dalsi += trvani
      i++
      // Pauza mezi slokami.
      if (i % MELODIE.length === 0) dalsi += DOBA * 2
    }
  }, 250)
  return () => {
    zastaveno = true
    clearInterval(tikac)
  }
}

/** Krátké ticho jako WAV — na odemčení `<audio>` klepnutím. */
function ticho() {
  const vzorku = 800
  const b = new DataView(new ArrayBuffer(44 + vzorku * 2))
  const text = (o, t) => [...t].forEach((z, i) => b.setUint8(o + i, z.charCodeAt(0)))
  text(0, "RIFF"), b.setUint32(4, 36 + vzorku * 2, true), text(8, "WAVEfmt ")
  b.setUint32(16, 16, true), b.setUint16(20, 1, true), b.setUint16(22, 1, true)
  b.setUint32(24, 8000, true), b.setUint32(28, 16000, true), b.setUint16(32, 2, true), b.setUint16(34, 16, true)
  text(36, "data"), b.setUint32(40, vzorku * 2, true)
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }))
}

/**
 * Přehrávač nahraných souborů. iPhone pustí `<audio>` bez klepnutí jen
 * tehdy, když ho klepnutím už jednou spustil — proto `odemkni()` při
 * „Začít hlídat" a pak se týž prvek používá pořád (budíček ráno).
 */
export function prehravacSouboru() {
  const a = new Audio()
  a.loop = true
  a.preload = "auto"
  let zdroj = null
  let tiche = null
  return {
    /** Volat synchronně v obsluze klepnutí. */
    odemkni() {
      // Hraje (budíček, ukolébavka) — už je odemčený, nepřerušovat.
      if (!a.paused) return
      tiche ??= ticho()
      a.src = tiche
      a.play().then(() => a.pause()).catch(() => {})
    },
    /** Pustí soubor do `vystup` (uzel zvukového kontextu). */
    async hraj(ctx, vystup, url) {
      zdroj ??= ctx.createMediaElementSource(a)
      zdroj.disconnect()
      zdroj.connect(vystup)
      a.src = url
      a.currentTime = 0
      await a.play()
    },
    zastav() {
      a.pause()
      zdroj?.disconnect()
    },
  }
}

/**
 * Pustí zvuk s časovačem: `nabeh` sekund zesiluje, poslední půlminutu
 * postupně ztiší, ať dítě nevzbudí náhlé ticho. Nahraný soubor
 * (`soubor: { prehravac, url }`) hraje dokola; když ho telefon pustit
 * nedokáže, zahraje vestavěnou ukolébavku. Vrací funkci na zastavení.
 */
export function pustZvuk(ctx, druh, { minut = 20, hlasitost = 0.5, nabeh = 3, soubor = null, naKonec } = {}) {
  const hlavni = ctx.createGain()
  hlavni.gain.value = 0
  hlavni.connect(ctx.destination)
  const t = ctx.currentTime
  hlavni.gain.setValueAtTime(0.0001, t)
  hlavni.gain.linearRampToValueAtTime(hlasitost, t + nabeh)
  const konec = t + minut * 60
  hlavni.gain.setValueAtTime(hlasitost, Math.max(t + nabeh, konec - 30))
  hlavni.gain.linearRampToValueAtTime(0, konec)

  let zastavZdroj
  if (soubor) {
    let nahradni = null
    soubor.prehravac.hraj(ctx, hlavni, soubor.url).catch((e) => {
      console.warn("soubor nejde pustit, hraje vestavěná ukolébavka", e)
      if (!hotovo) nahradni = ukolebavka(ctx, hlavni)
    })
    zastavZdroj = () => {
      soubor.prehravac.zastav()
      nahradni?.()
    }
  } else if (druh === "ukolebavka") zastavZdroj = ukolebavka(ctx, hlavni)
  else {
    const zdroj = sum(ctx, druh)
    zdroj.connect(hlavni)
    zdroj.start()
    zastavZdroj = () => zdroj.stop()
  }
  let hotovo = false
  const zastav = () => {
    if (hotovo) return
    hotovo = true
    clearTimeout(casovac)
    const ted = ctx.currentTime
    hlavni.gain.cancelScheduledValues(ted)
    hlavni.gain.setValueAtTime(hlavni.gain.value, ted)
    hlavni.gain.linearRampToValueAtTime(0, ted + 1.5)
    setTimeout(() => {
      zastavZdroj()
      hlavni.disconnect()
      naKonec?.()
    }, 1600)
  }
  const casovac = setTimeout(zastav, minut * 60_000)
  return zastav
}
