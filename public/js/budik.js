/**
 * Budíček na chůvičce — bez prohlížeče, ať jde otestovat.
 *
 * Nastavuje ho rodič, ukládá server (v nastavení chůvičky), zvoní telefon
 * u dítěte podle svých hodin. Zvoní jen když chůvička hlídá: přehrávat
 * zvuk smí stránka až po klepnutí a to je „Začít hlídat".
 */

import { t, jazyk } from "./i18n.js"

/** Dny v týdnu podle ISO: 1 = pondělí … 7 = neděle. */
export const DNY = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"]

const DNY_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/**
 * Zkratka dne v jazyce telefonu. Mimo slovník: české „Ne" (neděle)
 * by se ve slovníku potkalo s „Ne" (tlačítko).
 */
export const nazevDne = (d) => (jazyk() === "en" ? (DNY_EN[DNY.indexOf(d)] ?? d) : d)

export const VYCHOZI_BUDIK = {
  zapnuto: false,
  /** „HH:MM" v čase telefonu u dítěte. */
  cas: "06:30",
  dny: [1, 2, 3, 4, 5],
  /** Zazvoní při nejbližším „cas" bez ohledu na den a pak se vypne. */
  jednou: false,
  /** „ukolebavka" (vestavěná melodie), nebo „soubor:<id>" z nahraných. */
  zvuk: "ukolebavka",
  /** Východ slunce: kolik minut před budíčkem se obrazovka začne rozsvěcet (0 = ne). */
  svitani: 0,
}

/** Volby východu slunce v minutách. */
export const SVITANI = [0, 10, 15, 20, 30]

/** Jak dlouho budíček nejdéle hraje a za kolik sekund zesílí naplno. */
export const DELKA_MINUT = 15
export const NABEH_S = 30

/** Okno, ve kterém se budíček ještě spustí (telefon mohl chvíli spát). */
const OKNO_MS = 2 * 60_000

export const jeZvukSouboru = (zvuk) => typeof zvuk === "string" && /^soubor:[A-Za-z0-9_-]{8,40}$/.test(zvuk)
export const idSouboru = (zvuk) => (jeZvukSouboru(zvuk) ? zvuk.slice(7) : null)

/** Budíček oříznutý do platných hodnot; neznámé klíče pryč. */
export function srovnejBudik(vstup) {
  const b = { ...VYCHOZI_BUDIK, dny: [...VYCHOZI_BUDIK.dny] }
  if (!vstup || typeof vstup !== "object") return b
  b.zapnuto = vstup.zapnuto === true
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(vstup.cas ?? ""))
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) b.cas = `${m[1].padStart(2, "0")}:${m[2]}`
  if (Array.isArray(vstup.dny)) b.dny = [...new Set(vstup.dny.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
  b.jednou = vstup.jednou === true
  if (vstup.zvuk === "ukolebavka" || jeZvukSouboru(vstup.zvuk)) b.zvuk = vstup.zvuk
  if (SVITANI.includes(Number(vstup.svitani))) b.svitani = Number(vstup.svitani)
  return b
}

/** Klíč dne v čase telefonu — jeden budíček za den, i když se okno překryje. */
export const klicDne = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

/**
 * Má teď budíček zvonit? Vrací klíč dne, nebo null. `posledni` je klíč
 * dne, kdy už zazvonil — podruhé týž den ne.
 */
export function maZvonit(budik, ted, posledni) {
  if (!budik?.zapnuto) return null
  const [h, m] = budik.cas.split(":").map(Number)
  const zacatek = new Date(ted)
  zacatek.setHours(h, m, 0, 0)
  const rozdil = ted - zacatek
  if (rozdil < 0 || rozdil > OKNO_MS) return null
  const den = zacatek.getDay() || 7
  if (!budik.jednou && !budik.dny.includes(den)) return null
  const klic = klicDne(zacatek)
  return klic === posledni ? null : klic
}

/**
 * Východ slunce: jak daleko je rozsvěcení (0–1), nebo null, když se
 * nesvítá. Stejné dny jako budíček; `posledni` = den, kdy už zazvonil.
 */
export function svitani(budik, ted, posledni) {
  if (!budik?.zapnuto || !budik.svitani) return null
  const [h, m] = budik.cas.split(":").map(Number)
  const zvoneni = new Date(ted)
  zvoneni.setHours(h, m, 0, 0)
  const zacatek = zvoneni.getTime() - budik.svitani * 60_000
  if (ted < zacatek || ted >= zvoneni.getTime()) return null
  const den = zvoneni.getDay() || 7
  if (!budik.jednou && !budik.dny.includes(den)) return null
  if (klicDne(zvoneni) === posledni) return null
  return (ted - zacatek) / (budik.svitani * 60_000)
}

/**
 * Barva rozsvěcené obrazovky: černá → tmavě červená → oranžová → teplá
 * bílá, jako svítání. `p` 0–1.
 */
const BARVY_SVITANI = [
  [0, [0, 0, 0]],
  [0.25, [40, 4, 0]],
  [0.55, [140, 40, 4]],
  [0.8, [235, 140, 60]],
  [1, [255, 236, 205]],
]
export function barvaSvitani(p) {
  const x = Math.max(0, Math.min(1, p))
  let i = 1
  while (i < BARVY_SVITANI.length - 1 && x > BARVY_SVITANI[i][0]) i++
  const [a, ca] = BARVY_SVITANI[i - 1]
  const [b, cb] = BARVY_SVITANI[i]
  const k = (x - a) / (b - a)
  return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * k)).join(", ")})`
}

/** „6:30 · Po–Pá", „7:00 · každý den", „6:45 · jednou". */
export function popisBudiku(budik) {
  const [h, m] = budik.cas.split(":")
  const cas = `${Number(h)}:${m}`
  if (budik.jednou) return `${cas} · ${t("jednou")}`
  const d = budik.dny
  if (d.length === 7) return `${cas} · ${t("každý den")}`
  if (d.length === 0) return `${cas} · ${t("žádný den")}`
  if (d.join() === "1,2,3,4,5") return `${cas} · ${t("Po–Pá")}`
  if (d.join() === "6,7") return `${cas} · ${t("víkend")}`
  return `${cas} · ${d.map((x) => nazevDne(DNY[x - 1])).join(", ")}`
}
