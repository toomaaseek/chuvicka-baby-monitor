/**
 * Snímač počítá hladinu přímo ve zvukovém vlákně a hlavnímu vláknu ji
 * posílá 10× za sekundu. Surové vzorky (pro příposlech a vysílačku) jen
 * když se vysílá — jinak by hlavní vlákno budilo ~375 zpráv za sekundu
 * a telefon u dítěte by zbytečně jedl baterii.
 *
 * Posledních pár sekund drží snímač v kruhovém zásobníku a na požádání
 * je pošle (klip pro rozpoznání pláče) — jen při upozornění, ne stále.
 *
 * Přehrávač hraje vzorky z fronty; když se fronta nahromadí (výpadek
 * sítě), starší zahodí — příposlech má být živý, ne zpožděný.
 */
class Snimac extends AudioWorkletProcessor {
  constructor() {
    super()
    this.blok = Math.round(sampleRate / 10)
    this.soucet = 0
    this.pocet = 0
    this.vysilat = false
    this.kruh = new Float32Array(Math.round(sampleRate * 3))
    this.zapis = 0
    this.naplneno = false
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.vysilat === "boolean") this.vysilat = e.data.vysilat
      if (e.data && e.data.klip !== undefined) {
        // Od nejstaršího po nejnovější.
        const k = this.kruh
        const klip = this.naplneno
          ? Float32Array.from({ length: k.length }, (_, i) => k[(this.zapis + i) % k.length])
          : k.slice(0, this.zapis)
        this.port.postMessage({ klip: e.data.klip, vzorky: klip, vzorkovani: sampleRate })
      }
    }
  }
  process(inputs) {
    const kanal = inputs[0] && inputs[0][0]
    if (!kanal) return true
    for (let i = 0; i < kanal.length; i++) {
      this.kruh[this.zapis] = kanal[i]
      if (++this.zapis >= this.kruh.length) {
        this.zapis = 0
        this.naplneno = true
      }
      this.soucet += kanal[i] * kanal[i]
      if (++this.pocet >= this.blok) {
        this.port.postMessage({ rms: Math.sqrt(this.soucet / this.pocet) })
        this.soucet = 0
        this.pocet = 0
      }
    }
    if (this.vysilat) this.port.postMessage(kanal.slice(0))
    return true
  }
}

class Prehravac extends AudioWorkletProcessor {
  constructor() {
    super()
    this.fronta = []
    this.pozice = 0
    this.port.onmessage = (e) => {
      if (e.data === "stop") {
        this.fronta = []
        this.pozice = 0
        return
      }
      this.fronta.push(e.data)
      let celkem = -this.pozice
      for (const b of this.fronta) celkem += b.length
      while (celkem > sampleRate * 0.6 && this.fronta.length > 1) {
        celkem -= this.fronta.shift().length - this.pozice
        this.pozice = 0
      }
    }
  }
  process(_vstupy, vystupy) {
    const out = vystupy[0][0]
    for (let i = 0; i < out.length; i++) {
      if (!this.fronta.length) {
        out[i] = 0
        continue
      }
      const b = this.fronta[0]
      out[i] = b[this.pozice++]
      if (this.pozice >= b.length) {
        this.fronta.shift()
        this.pozice = 0
      }
    }
    for (let k = 1; k < vystupy[0].length; k++) vystupy[0][k].set(out)
    return true
  }
}

registerProcessor("snimac", Snimac)
registerProcessor("prehravac", Prehravac)
