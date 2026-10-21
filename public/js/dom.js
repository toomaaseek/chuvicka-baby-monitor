import { VERZE } from "./verze.js"
import { t, jazyk, nastavJazyk, locale, JAZYKY } from "./i18n.js"

/**
 * Tvorba prvků bez innerHTML — názvy zařízení přicházejí z druhého
 * telefonu, nesmí se vykonat jako HTML.
 */
export function el(tag, vlastnosti = {}, ...deti) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(vlastnosti ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === "class") e.className = v
    else if (k === "text") e.textContent = v
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === "style" && typeof v === "object")
      for (const [vl, h] of Object.entries(v)) vl.startsWith("--") ? e.style.setProperty(vl, h) : (e.style[vl] = h)
    else if (k in e && typeof v !== "string") e[k] = v
    else e.setAttribute(k, v === true ? "" : v)
  }
  for (const d of deti.flat()) if (d !== null && d !== undefined && d !== false) e.append(d instanceof Node ? d : String(d))
  return e
}

/** Nadpis s verzí, která v telefonu opravdu běží (u rodiče jméno chůvičky). */
export const nazevAplikace = (text = "Chůvička") => el("h1", {}, text, el("span", { class: "verze-cislo", text: `v${VERZE}` }))

export function obrazovka(...obsah) {
  const main = document.getElementById("aplikace")
  main.replaceChildren(...obsah.flat().filter(Boolean))
  return main
}

export function okno(...obsah) {
  const o = el("div", { class: "okno", onclick: (e) => e.target === o && o.remove() }, el("div", { class: "karta" }, ...obsah))
  document.body.append(o)
  return o
}

export const cas = (ms) =>
  new Date(ms).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })

/** Den bez roku: „20. 10." / „20 Oct". */
export const datum = (ms) => new Date(ms).toLocaleDateString(locale(), { day: "numeric", month: jazyk() === "cs" ? "numeric" : "short" })

export function predChvili(ms) {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return t("před chvílí")
  if (s < 3600) return t("před {n} min", { n: Math.round(s / 60) })
  return t("v {cas}", { cas: cas(ms) })
}

const NAZVY_JAZYKU = { cs: "Čeština", en: "English" }

/** Přepínač jazyka (popisek v obou jazycích — ať ho najde i ten, kdo nerozumí). */
export function volbaJazyka() {
  const vyber = el(
    "select",
    { id: "jazyk", onchange: (e) => nastavJazyk(e.target.value) },
    ...JAZYKY.map((j) => el("option", { value: j, text: NAZVY_JAZYKU[j], selected: j === jazyk() })),
  )
  return el("label", { class: "pole", for: "jazyk" }, "Jazyk / Language", vyber)
}

/** Naposledy otevřená záložka každé sady — po novém otevření okna stejná. */
const posledniZalozka = new Map()

/**
 * Záložky jako v docházce: lišta nahoře, pod ní jen vybraný obsah.
 * `polozky`: [{ id, nazev, obsah: [prvky] }].
 */
export function zalozky(sada, polozky) {
  let vybrana = polozky.some((p) => p.id === posledniZalozka.get(sada)) ? posledniZalozka.get(sada) : polozky[0].id
  const tlacitka = polozky.map((p) =>
    el("button", { type: "button", role: "tab", id: `zal-${sada}-${p.id}`, "aria-controls": `pan-${sada}-${p.id}`, onclick: () => ukaz(p.id) }, p.nazev),
  )
  const panely = polozky.map((p) =>
    el("div", { role: "tabpanel", id: `pan-${sada}-${p.id}`, "aria-labelledby": `zal-${sada}-${p.id}`, class: "zalozka" }, ...p.obsah),
  )
  function ukaz(id) {
    vybrana = id
    posledniZalozka.set(sada, id)
    polozky.forEach((p, i) => {
      const ano = p.id === id
      tlacitka[i].setAttribute("aria-selected", String(ano))
      tlacitka[i].tabIndex = ano ? 0 : -1
      panely[i].hidden = !ano
    })
  }
  ukaz(vybrana)
  // Šipky mezi záložkami (klávesnice, čtečka obrazovky).
  const lista = el("div", { class: "zalozky", role: "tablist" }, ...tlacitka)
  lista.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
    const i = polozky.findIndex((p) => p.id === vybrana)
    const j = (i + (e.key === "ArrowRight" ? 1 : -1) + polozky.length) % polozky.length
    ukaz(polozky[j].id)
    tlacitka[j].focus()
  })
  return [lista, ...panely]
}
