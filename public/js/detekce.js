/**
 * Detekce zvuku u dítěte — bez prohlížeče, ať jde otestovat.
 *
 * Hladina je 0–100 (0 = ticho, 100 = maximum mikrofonu), počítá se
 * z RMS v decibelech: hladina = (dBFS + 90) · 100/90. Dvě úrovně:
 * „ozývá se" (nižší práh) a „pláče" (vyšší práh), každá s dobou trvání.
 *
 * Událost vznikne, když během nastavené doby byl zvuk nad prahem aspoň
 * polovinu času (posuvné okno). Pláč i mluvení mají nádechy a pauzy —
 * dřívější „souvisle nad prahem" je při delší době nesplnilo nikdy.
 * Po události mlčí po dobu pauzy; „pláče" umlčí i „ozývá se".
 *
 * „Ozývá se" má vždy nižší práh a delší dobu než „pláče": tiché zvuky
 * často samy utichnou, hlasitý pláč se má ohlásit hned.
 */

import { srovnejBudik, VYCHOZI_BUDIK } from "./budik.js"

export const VYCHOZI = {
  prahOzyva: 45,
  trvaniOzyva: 8,
  prahPlace: 60,
  trvaniPlace: 3,
  /** Minuty po upozornění, kdy se další stejné úrovně neposílá (0,5 = 30 s). */
  pauza: 3,
  /** Hlasitost hlasu rodiče, ukolébavky a budíčku na chůvičce, 0–1. */
  hlasitost: 0.7,
  /** Budíček — viz `budik.js`. */
  budik: VYCHOZI_BUDIK,
}

/** Rozsahy pro formuláře i kontrolu na serveru. */
export const ROZSAHY = {
  prahOzyva: [1, 98],
  trvaniOzyva: [2, 120],
  prahPlace: [2, 99],
  trvaniPlace: [1, 60],
  pauza: [0, 10],
  hlasitost: [0, 1],
}

/** Nastavení orezané do rozsahů; neznámé klíče pryč. */
export function srovnejNastaveni(vstup = {}) {
  const n = { ...VYCHOZI }
  for (const [k, [min, max]] of Object.entries(ROZSAHY)) {
    const v = Number(vstup[k])
    if (Number.isFinite(v)) n[k] = Math.min(max, Math.max(min, v))
  }
  // Obrácené pořadí (třeba uložené starší verzí) se prohodí, shodné
  // hodnoty rozestoupí. Rozsahy výš na to nechávají místo.
  if (n.prahOzyva > n.prahPlace) [n.prahOzyva, n.prahPlace] = [n.prahPlace, n.prahOzyva]
  if (n.prahOzyva === n.prahPlace) n.prahPlace++
  if (n.trvaniOzyva < n.trvaniPlace) [n.trvaniOzyva, n.trvaniPlace] = [n.trvaniPlace, n.trvaniOzyva]
  if (n.trvaniOzyva === n.trvaniPlace) n.trvaniOzyva++
  n.budik = srovnejBudik(vstup.budik)
  return n
}

/** Jakou část okna musí být zvuk nad prahem. */
export const PODIL = 0.5

export function hladinaZRms(rms) {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.max(0, Math.min(100, ((db + 90) * 100) / 90))
}

/**
 * Doporučené prahy z kalibrace ticha: průměrná hladina místnosti
 * a k ní rezerva, aby ventilátor nebo čistička nespouštěly poplach.
 */
export function prahyZKalibrace(tichoHladina) {
  const zaklad = Math.round(tichoHladina)
  return {
    prahOzyva: Math.min(95, zaklad + 12),
    prahPlace: Math.min(98, zaklad + 25),
  }
}

export function vytvorDetektor(nastaveni = VYCHOZI) {
  let n = srovnejNastaveni(nastaveni)
  const stav = {
    ozyva: { okno: [], umlcenoDo: 0 },
    place: { okno: [], umlcenoDo: 0 },
  }

  function uroven(klic, prah, trvani, hladina, t) {
    const s = stav[klic]
    s.okno.push({ t, nad: hladina >= prah })
    while (s.okno.length && t - s.okno[0].t > trvani) s.okno.shift()
    // Okno začíná prvním hlasitým okamžikem — ticho před zvukem by jinak
    // počítání zkrátilo (při „3 s" by stačilo půl druhé sekundy zvuku).
    while (s.okno.length && !s.okno[0].nad) s.okno.shift()
    if (t < s.umlcenoDo || !s.okno.length) return null
    // Okno musí být plné (zvuk se poslouchá celou dobu trvání) a končit
    // hlasitě — ať se neohlásí až dozvuk po utišení.
    const zacatek = s.okno[0].t
    if (t - zacatek < trvani * 0.95 || !s.okno[s.okno.length - 1].nad) return null
    const nad = s.okno.filter((v) => v.nad).length
    if (nad / s.okno.length < PODIL) return null
    s.okno = []
    return t - zacatek
  }

  return {
    nastav(nove) {
      n = srovnejNastaveni({ ...n, ...nove })
    },
    get nastaveni() {
      return n
    },
    /**
     * Další vzorek hladiny (čas v sekundách). Vrátí událost, nebo null.
     */
    krok(hladina, t) {
      const place = uroven("place", n.prahPlace, n.trvaniPlace, hladina, t)
      if (place !== null) {
        const do_ = t + n.pauza * 60
        stav.place.umlcenoDo = do_
        stav.ozyva.umlcenoDo = Math.max(stav.ozyva.umlcenoDo, do_)
        stav.ozyva.okno = []
        return { druh: "place", trvani: Math.round(place), hladina: Math.round(hladina) }
      }
      const ozyva = uroven("ozyva", n.prahOzyva, n.trvaniOzyva, hladina, t)
      if (ozyva !== null) {
        stav.ozyva.umlcenoDo = t + n.pauza * 60
        return { druh: "ozyva", trvani: Math.round(ozyva), hladina: Math.round(hladina) }
      }
      return null
    },
  }
}
