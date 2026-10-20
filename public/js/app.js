import { el, obrazovka, nazevAplikace, volbaJazyka } from "./dom.js"
import { VERZE } from "./verze.js"
import { api } from "./spojeni.js"
import { spustChuvicku } from "./chuvicka.js"
import { spustRodice } from "./rodic.js"
import { t, jazyk } from "./i18n.js"

document.documentElement.lang = jazyk()

/**
 * Vstup: telefon si pamatuje, čím je (chůvička, nebo rodič). Napoprvé
 * se zeptá. Odkaz z QR (#sparovat=KÓD) otevře rovnou rodiče.
 */
const KLIC = "chuvicka-zarizeni"

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})

let instalace = null
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault()
  instalace = e
  document.querySelector("[data-instalace]")?.removeAttribute("hidden")
})

function nactiZarizeni() {
  try {
    return JSON.parse(localStorage.getItem(KLIC) ?? "null")
  } catch {
    return null
  }
}

function kodZAdresy() {
  const m = /sparovat=([A-Za-z0-9]{6})/.exec(location.hash)
  if (m) history.replaceState(null, "", location.pathname)
  return m ? m[1].toUpperCase() : null
}

async function registruj(role) {
  const z = await api("/api/registrace", null, { role, jazyk: jazyk() })
  localStorage.setItem(KLIC, JSON.stringify(z))
  return z
}

function znovu() {
  localStorage.removeItem(KLIC)
  start()
}

function instalacniTlacitko() {
  const ios = /iPhone|iPad/.test(navigator.userAgent)
  const nainstalovano = matchMedia("(display-mode: standalone)").matches || navigator.standalone
  if (nainstalovano) return null
  if (ios) {
    return el("p", { class: "slabe", text: t("Tip: na iPhonu přidej aplikaci na plochu (Sdílet › Přidat na plochu) — jinak nechodí upozornění.") })
  }
  return el(
    "button",
    {
      "data-instalace": "",
      hidden: !instalace,
      onclick: async () => {
        await instalace?.prompt()
        instalace = null
      },
    },
    t("Nainstalovat aplikaci"),
  )
}

function volbaRole(kod) {
  const chyba = el("p", { class: "chyba" })
  const vyber = async (role) => {
    try {
      const z = await registruj(role)
      spust(z, kod)
    } catch (e) {
      chyba.textContent = e.message
    }
  }
  obrazovka(
    nazevAplikace(),
    el("p", { class: "slabe", text: t("Jeden telefon leží u dítěte a poslouchá. Druhý má rodič — chodí na něj upozornění a může poslouchat a mluvit.") }),
    kod ? el("p", { text: t("Otevřel jsi kód z chůvičky — tenhle telefon bude rodičovský.") }) : null,
    el("section", { class: "karta" }, el("h2", { text: t("Tenhle telefon bude…") }),
      el("button", { class: "hlavni velke", onclick: () => vyber("rodic") }, t("U rodiče")),
      kod ? null : el("button", { class: "velke", onclick: () => vyber("chuvicka") }, t("U dítěte (chůvička)")),
    ),
    instalacniTlacitko(),
    volbaJazyka(),
    chyba,
  )
}

function spust(z, kod = null) {
  if (z.role === "chuvicka") spustChuvicku(z, { naZruseni: znovu })
  else spustRodice(z, { naZruseni: znovu, kodKParovani: kod })
}

async function start() {
  const kod = kodZAdresy()
  const z = nactiZarizeni()
  if (!z) return volbaRole(kod)
  // Zařízení mohlo být zrušené z druhé strany nebo databáze smazaná.
  try {
    const ja = await api("/api/ja", z)
    z.nazev = ja.nazev
  } catch (e) {
    if (e.status === 401) return znovu()
  }
  spust(z, z.role === "rodic" ? kod : null)
}

start()

// Otevřená aplikace může běžet se starým kódem — server už má novější.
// Telefon ji drží v paměti celé dny, proto i po každém návratu do popředí.
function zkontrolujVerzi() {
  api("/api/zdravi")
    .then((z) => {
      if (z.verze === VERZE) return
      document.getElementById("verze").replaceChildren(
        el("button", { class: "odkaz", onclick: () => location.reload() }, t("Je nová verze v{verze} — načíst", { verze: z.verze })),
      )
    })
    .catch(() => {})
}
zkontrolujVerzi()
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && zkontrolujVerzi())
