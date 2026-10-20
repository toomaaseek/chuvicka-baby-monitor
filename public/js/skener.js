import { el } from "./dom.js"

/**
 * Skener QR přímo v aplikaci. Fotoaparát telefonu by otevřel odkaz
 * v prohlížeči — a na iPhonu je aplikace přidaná na plochu oddělená od
 * prohlížeče, takže by se spárovalo něco jiného, než co dostává
 * upozornění. jsQR (Apache 2.0) se načte, až když je potřeba.
 */
let nacteno = null
function nactiJsQR() {
  nacteno ??= new Promise((ok, chyba) => {
    const s = el("script", { src: "/vendor/jsQR.js" })
    s.onload = () => ok(window.jsQR)
    s.onerror = chyba
    document.head.append(s)
  })
  return nacteno
}

/** Kód z obsahu QR: celá adresa s #sparovat=…, nebo jen kód. */
export function kodZQr(text) {
  const m = /sparovat=([A-Za-z0-9]{6})/.exec(text) ?? /^\s*([A-Za-z0-9]{6})\s*$/.exec(text)
  return m ? m[1].toUpperCase() : null
}

export async function skenuj(video, naKod) {
  const jsQR = await nactiJsQR()
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 } },
    audio: false,
  })
  video.srcObject = stream
  video.setAttribute("playsinline", "")
  video.muted = true
  await video.play()
  const platno = document.createElement("canvas")
  const kresli = platno.getContext("2d", { willReadFrequently: true })
  let bezi = true
  const krok = () => {
    if (!bezi) return
    if (video.videoWidth) {
      const sirka = 480
      const vyska = Math.round((video.videoHeight / video.videoWidth) * sirka)
      platno.width = sirka
      platno.height = vyska
      kresli.drawImage(video, 0, 0, sirka, vyska)
      const nalez = jsQR(kresli.getImageData(0, 0, sirka, vyska).data, sirka, vyska, { inversionAttempts: "dontInvert" })
      const kod = nalez && kodZQr(nalez.data)
      if (kod) {
        zastav()
        naKod(kod)
        return
      }
    }
    setTimeout(krok, 200)
  }
  const zastav = () => {
    bezi = false
    stream.getTracks().forEach((t) => t.stop())
  }
  krok()
  return zastav
}
