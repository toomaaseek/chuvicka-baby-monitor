import { EN } from "./texty-en.js"

/**
 * Jazyk aplikace — čeština a angličtina.
 *
 * Klíčem překladu je český text (jako gettext): kód zůstane čitelný
 * a čeština nepotřebuje slovník. Anglický slovník je v texty-en.js;
 * test hlídá, že v něm nic nechybí.
 *
 * Volba se pamatuje v telefonu; bez ní rozhoduje jazyk telefonu
 * (čeština a slovenština → česky, jinak anglicky). Server dostane jazyk
 * při přihlášení zařízení a posílá podle něj upozornění.
 */

export const JAZYKY = ["cs", "en"]
const KLIC = "chuvicka-jazyk"

export const platnyJazyk = (j) => (JAZYKY.includes(j) ? j : "cs")

/**
 * Překlad českého textu. Text může mít {zástupce}; anglický překlad
 * může být i funkce parametrů (množné číslo).
 */
export function prelozit(jazyk, text, p = {}) {
  const s = jazyk === "en" ? (EN[text] ?? text) : text
  if (typeof s === "function") return s(p)
  return s.replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? `{${k}}`).toString())
}

let aktualni = null

/** Jazyk tohoto telefonu. */
export function jazyk() {
  if (aktualni) return aktualni
  // Mimo prohlížeč (server, testy) česky — server překládá přes `prelozit`.
  if (typeof window === "undefined") return "cs"
  let ulozeny = null
  try {
    ulozeny = localStorage.getItem(KLIC)
  } catch {}
  if (JAZYKY.includes(ulozeny)) return (aktualni = ulozeny)
  const telefon = typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : []
  return (aktualni = telefon.some((l) => /^(cs|sk)\b/i.test(l ?? "")) ? "cs" : "en")
}

/** Přepne jazyk a načte aplikaci znovu (všechny obrazovky se postaví v novém jazyce). */
export function nastavJazyk(j) {
  try {
    localStorage.setItem(KLIC, platnyJazyk(j))
  } catch {}
  location.reload()
}

export const t = (text, p) => prelozit(jazyk(), text, p)

/** Locale pro data a časy. */
export const locale = () => (jazyk() === "cs" ? "cs-CZ" : "en-GB")
