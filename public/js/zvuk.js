import { hladinaZRms } from "./detekce.js"
import { VZORKOVANI, RAMEC, zakodujPole, dekodujPole, prevzorkuj } from "./mulaw.js"

/** Kontext zvuku s připravenými procesory. Volat po klepnutí (iOS). */
export async function kontext() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  await ctx.audioWorklet.addModule("/js/zvuk-worklet.js")
  if (ctx.state === "suspended") await ctx.resume()
  return ctx
}

/**
 * Mikrofon bez úprav prohlížeče: automatické zesílení by z ticha udělalo
 * hluk a potlačení šumu by spolklo tiché zakňourání.
 */
export async function mikrofon(ctx, { prirozeny = false } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: prirozeny
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  })
  const zdroj = ctx.createMediaStreamSource(stream)
  // Hukot (lednice, auto za oknem) pod 120 Hz hladinu jen zkresluje.
  const filtr = ctx.createBiquadFilter()
  filtr.type = "highpass"
  filtr.frequency.value = 120
  zdroj.connect(filtr)
  const snimac = new AudioWorkletNode(ctx, "snimac")
  filtr.connect(snimac)
  // Snímač musí být v grafu, jinak ho Safari nespouští — přes ztlumení.
  const ticho = ctx.createGain()
  ticho.gain.value = 0
  snimac.connect(ticho).connect(ctx.destination)
  return {
    stream,
    snimac,
    zastav() {
      stream.getTracks().forEach((t) => t.stop())
      snimac.disconnect()
      zdroj.disconnect()
    },
  }
}

/**
 * Napojí snímač: hladinu (10× za sekundu, spočítanou ve zvukovém vlákně)
 * a při vysílání kóduje zvuk do rámců 20 ms μ-law 16 kHz. Vlastnost
 * `vysilat` přepne snímač — mimo vysílání neposílá surové vzorky vůbec.
 */
export function zpracujMikrofon(mic, vzorkovani, { naHladinu, naRamec }) {
  const vstupNaRamec = Math.round((RAMEC * vzorkovani) / VZORKOVANI)
  let zasobnik = new Float32Array(0)
  let vysilat = false
  mic.snimac.port.onmessage = (e) => {
    if (e.data && e.data.rms !== undefined) return naHladinu(hladinaZRms(e.data.rms))
    if (!vysilat) return
    const vzorky = e.data
    const spojeno = new Float32Array(zasobnik.length + vzorky.length)
    spojeno.set(zasobnik)
    spojeno.set(vzorky, zasobnik.length)
    let od = 0
    while (spojeno.length - od >= vstupNaRamec) {
      const kus = spojeno.subarray(od, od + vstupNaRamec)
      naRamec(zakodujPole(prevzorkuj(kus, vzorkovani, VZORKOVANI).subarray(0, RAMEC)))
      od += vstupNaRamec
    }
    zasobnik = spojeno.slice(od)
  }
  return {
    get vysilat() {
      return vysilat
    },
    set vysilat(v) {
      if (v === vysilat) return
      vysilat = v
      zasobnik = new Float32Array(0)
      mic.snimac.port.postMessage({ vysilat: v })
    },
  }
}

/** Přehrávání příchozího zvuku (příposlech u rodiče, hlas rodiče u dítěte). */
export function prehravac(ctx, hlasitost = 1) {
  const uzel = new AudioWorkletNode(ctx, "prehravac", { outputChannelCount: [1] })
  const zesileni = ctx.createGain()
  zesileni.gain.value = hlasitost
  uzel.connect(zesileni).connect(ctx.destination)
  return {
    prijmi(bajty) {
      uzel.port.postMessage(prevzorkuj(dekodujPole(bajty), VZORKOVANI, ctx.sampleRate))
    },
    hlasitost(v) {
      zesileni.gain.value = v
    },
    stop() {
      uzel.port.postMessage("stop")
    },
    odpoj() {
      uzel.disconnect()
      zesileni.disconnect()
    },
  }
}
