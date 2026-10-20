import { jazyk, t } from "./i18n.js"

/**
 * Spojení se serverem: WebSocket s přihlášením první zprávou a samo se
 * obnovuje — telefon u dítěte musí vydržet výpadek Wi-Fi i restart serveru.
 */
export class Spojeni {
  constructor(zarizeni, { naZpravu, naBinarni, naStav }) {
    this.zarizeni = zarizeni
    this.naZpravu = naZpravu ?? (() => {})
    this.naBinarni = naBinarni ?? (() => {})
    this.naStav = naStav ?? (() => {})
    this.prodleva = 1000
    this.online = false
    this.konec = false
    this.pripoj()
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.online) this.pripoj()
    })
    addEventListener("online", () => !this.online && this.pripoj())
  }

  pripoj() {
    if (this.konec) return
    clearTimeout(this.znovu)
    try {
      this.ws?.close()
    } catch {}
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`)
    ws.binaryType = "arraybuffer"
    this.ws = ws
    ws.onopen = () =>
      ws.send(JSON.stringify({ typ: "prihlasit", id: this.zarizeni.id, tajemstvi: this.zarizeni.tajemstvi, jazyk: jazyk() }))
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return this.naBinarni(new Uint8Array(e.data))
      const m = JSON.parse(e.data)
      if (m.typ === "prihlaseno") {
        this.online = true
        this.prodleva = 1000
        this.naStav(true)
        return
      }
      this.naZpravu(m)
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      this.online = false
      this.naStav(false, e.code)
      if (e.code === 4001) return // neznámé zařízení — znovu nemá smysl
      this.znovu = setTimeout(() => this.pripoj(), this.prodleva)
      this.prodleva = Math.min(this.prodleva * 2, 10000)
    }
  }

  posli(zprava) {
    if (this.online && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(zprava))
  }

  posliBinarni(data) {
    if (this.online && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 256 * 1024) this.ws.send(data)
  }

  zavri() {
    this.konec = true
    this.ws?.close()
  }
}

export async function api(cesta, zarizeni, telo) {
  const r = await fetch(cesta, {
    method: telo === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Jazyk": jazyk(),
      ...(zarizeni ? { "X-Zarizeni": `${zarizeni.id}:${zarizeni.tajemstvi}` } : {}),
    },
    body: telo === undefined ? undefined : JSON.stringify(telo),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.chyba ?? t("Chyba {kod}", { kod: r.status })), { status: r.status })
  return data
}
