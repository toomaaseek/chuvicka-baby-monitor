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
 *
 * Stálý šum (ventilátor, čistička, šum zapnutý v noci) prahy zvedne:
 * detektor si každých 10 s všimne, jestli zvuk byl vyrovnaný, a z
 * posledních vyrovnaných úseků odhadne hladinu šumu. Prahy pak drží
 * nad ní stejnou rezervou jako kalibrace — nejvýš o 20 nad nastavení,
 * nikdy pod něj. Pláč ani řeč šum nezvednou: kolísají (nádechy, pauzy).
 */

import { srovnejBudik, VYCHOZI_BUDIK } from "./budik.js"

export const VYCHOZI = {
  prahOzyva: 45,
  trvaniOzyva: 8,
  prahPlace: 60,
  trvaniPlace: 3,
  /** Minuty po upozornění, kdy se další stejné úrovně neposílá (0,5 = 30 s). */
  pauza: 3,
  /** Hlasitost hlasu rodiče a ukolébavky na chůvičce, 0–1. */
  hlasitost: 0.7,
  /** Hlasitost budíčku, 0–1 — zvlášť, budit má být slyšet víc než uspávat. */
  hlasitostBudiku: 0.7,
  /** Prahy se zvednou nad stálý šum v místnosti (viz výš). */
  prizpusobitSumu: true,
  /**
   * Před upozorněním posoudit, jestli zvuk vydává dítě (`plac.js`).
   * Zapíná si ho uživatel sám — stahuje se kvůli němu ~11 MB.
   */
  rozpoznatPlac: false,
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
  hlasitostBudiku: [0, 1],
}

/** Nastavení orezané do rozsahů; neznámé klíče pryč. */
export function srovnejNastaveni(vstup = {}) {
  const n = { ...VYCHOZI }
  // Starší nastavení hlasitost budíčku nemá — budíček hrál hlasitostí hlasu.
  if (vstup.hlasitostBudiku === undefined && vstup.hlasitost !== undefined) vstup = { ...vstup, hlasitostBudiku: vstup.hlasitost }
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
  for (const k of ["prizpusobitSumu", "rozpoznatPlac"]) if (typeof vstup[k] === "boolean") n[k] = vstup[k]
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
export const REZERVA_OZYVA = 12
export const REZERVA_PLACE = 25

export function prahyZKalibrace(tichoHladina) {
  const zaklad = Math.round(tichoHladina)
  return {
    prahOzyva: Math.min(95, zaklad + REZERVA_OZYVA),
    prahPlace: Math.min(98, zaklad + REZERVA_PLACE),
  }
}

/** Odhad stálého šumu: délka úseku, kolik úseků, povolené kolísání, strop zvýšení. */
export const SUM = { usek: 10, useku: 6, kolisani: 6, maxZvyseni: 20 }

/**
 * Prahy pro danou hladinu šumu: nad šum s rezervou kalibrace, nikdy
 * pod nastavení a nejvýš o `SUM.maxZvyseni` nad ně.
 */
export function prahyNadSumem(n, sum) {
  if (!n.prizpusobitSumu || sum === null || sum === undefined) return { prahOzyva: n.prahOzyva, prahPlace: n.prahPlace }
  const nad = (prah, rezerva) => Math.min(prah + SUM.maxZvyseni, Math.max(prah, Math.round(sum + rezerva)))
  const prahPlace = Math.min(99, nad(n.prahPlace, REZERVA_PLACE))
  const prahOzyva = Math.min(prahPlace - 1, nad(n.prahOzyva, REZERVA_OZYVA))
  return { prahOzyva, prahPlace }
}

export function vytvorDetektor(nastaveni = VYCHOZI) {
  let n = srovnejNastaveni(nastaveni)
  const stav = {
    ozyva: { okno: [], umlcenoDo: 0 },
    place: { okno: [], umlcenoDo: 0 },
    sum: { usek: [], zacatek: null, vyrovnane: [], hladina: null },
    posledniT: 0,
  }

  /** Další vzorek do odhadu stálého šumu. */
  function sumKrok(hladina, t) {
    const s = stav.sum
    if (s.zacatek === null || t < s.zacatek) s.zacatek = t
    s.usek.push(hladina)
    if (t - s.zacatek < SUM.usek) return
    const v = s.usek.sort((a, b) => a - b)
    s.usek = []
    s.zacatek = t
    if (v.length < 5) return
    const kvantil = (q) => v[Math.floor(q * (v.length - 1))]
    // Kolísá — řeč, pláč, kroky. Šum je vyrovnaný.
    if (kvantil(0.9) - kvantil(0.1) > SUM.kolisani) return
    s.vyrovnane.push(kvantil(0.5))
    if (s.vyrovnane.length > SUM.useku) s.vyrovnane.shift()
    const u = [...s.vyrovnane].sort((a, b) => a - b)
    s.hladina = u[Math.floor(u.length / 2)]
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
    /** Prahy, které teď opravdu platí (nastavení, případně zvednuté nad šum). */
    get prahy() {
      return prahyNadSumem(n, stav.sum.hladina)
    },
    /** Odhad stálého šumu, nebo null. */
    get sum() {
      return stav.sum.hladina
    },
    /**
     * Další vzorek hladiny (čas v sekundách). Vrátí událost, nebo null.
     */
    /**
     * Upozornění se neposlalo (rozpoznání: není to dítě) — místo celé
     * pauzy jen krátké ticho, ať se pláč, který začne hned potom, ohlásí.
     */
    odloz(druh, sekund) {
      const do_ = stav.posledniT + sekund
      stav[druh].umlcenoDo = do_
      if (druh === "place") stav.ozyva.umlcenoDo = do_
    },
    krok(hladina, t) {
      stav.posledniT = t
      sumKrok(hladina, t)
      const p = prahyNadSumem(n, stav.sum.hladina)
      const place = uroven("place", p.prahPlace, n.trvaniPlace, hladina, t)
      if (place !== null) {
        const do_ = t + n.pauza * 60
        stav.place.umlcenoDo = do_
        stav.ozyva.umlcenoDo = Math.max(stav.ozyva.umlcenoDo, do_)
        stav.ozyva.okno = []
        return { druh: "place", trvani: Math.round(place), hladina: Math.round(hladina) }
      }
      const ozyva = uroven("ozyva", p.prahOzyva, n.trvaniOzyva, hladina, t)
      if (ozyva !== null) {
        stav.ozyva.umlcenoDo = t + n.pauza * 60
        return { druh: "ozyva", trvani: Math.round(ozyva), hladina: Math.round(hladina) }
      }
      return null
    },
  }
}
