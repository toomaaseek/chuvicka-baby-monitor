import { el } from "./dom.js"
import { ROZSAHY } from "./detekce.js"
import { t } from "./i18n.js"

/** Ukazatel hladiny s čarami prahů. */
export function ukazatel() {
  const naplni = el("div", { class: "naplni" })
  const ozyva = el("div", { class: "prah ozyva", title: t("práh: ozývá se") })
  const place = el("div", { class: "prah place", title: t("práh: pláče") })
  const prvek = el("div", { class: "hladina", role: "meter", "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": t("Hladina zvuku") }, naplni, ozyva, place)
  return {
    prvek,
    hladina(h) {
      naplni.style.clipPath = `inset(0 ${100 - Math.max(0, Math.min(100, h))}% 0 0)`
      prvek.setAttribute("aria-valuenow", String(Math.round(h)))
    },
    prahy(n) {
      ozyva.style.left = `${n.prahOzyva}%`
      place.style.left = `${n.prahPlace}%`
    },
  }
}

/** Pauza: levá polovina posuvníku 0–60 s po 5 s, pravá 1–10 min po minutách. */
const PAUZA = {
  min: 0,
  max: 1000,
  naHodnotu(poz) {
    if (poz <= 500) return Math.round((poz / 500) * 12) / 12
    return Math.round(1 + ((poz - 500) / 500) * 9)
  },
  naPozici(v) {
    return v <= 1 ? v * 500 : 500 + ((v - 1) / 9) * 500
  },
  text: (v) => (v < 1 ? `${Math.round(v * 60)} s` : `${Math.round(v)} min`),
}

/**
 * „pod"/„nad": hodnota musí zůstat pod/nad jiným polem. Pásmo, které
 * druhá úroveň zabírá, je na posuvníku šedé a jezdec do něj nepustí.
 */
const POLE = () => [
  { klic: "prahOzyva", nazev: t("Ozývá se — citlivost"), krok: 1, barva: "--ozyva", pod: "prahPlace", popis: t("Čím nižší práh, tím tišší zvuk stačí.") },
  { klic: "trvaniOzyva", nazev: t("Ozývá se — jak dlouho"), jednotka: " s", krok: 1, barva: "--ozyva", nad: "trvaniPlace", popis: t("Tiché zvuky často samy utichnou, proto se čeká déle než u pláče.") },
  { klic: "prahPlace", nazev: t("Pláče — citlivost"), krok: 1, barva: "--place", nad: "prahOzyva" },
  { klic: "trvaniPlace", nazev: t("Pláče — jak dlouho"), jednotka: " s", krok: 1, barva: "--place", pod: "trvaniOzyva" },
  { klic: "pauza", nazev: t("Pauza po upozornění"), stupnice: PAUZA, popis: t("Tak dlouho se stejné upozornění znovu neposílá.") },
  { klic: "hlasitost", nazev: t("Hlasitost hlasu a ukolébavky"), krok: 0.05, text: (v) => `${Math.round(v * 100)} %` },
]

/**
 * Posuvníky nastavení. Změna se ohlásí až po puštění (a s krátkou
 * prodlevou), ať se po síti neposílá každý pixel tažení.
 */
export function panelNastaveni(nastaveni, naZmenu) {
  let cekani
  // Změny z víc posuvníků se sbírají a odešlou dohromady — společná
  // prodleva by jinak poslala jen tu poslední.
  let zmeny = {}
  const stav = { ...nastaveni }
  const pole = POLE().map((p) => {
    const [min, max] = ROZSAHY[p.klic]
    const st = p.stupnice ?? { min, max, naHodnotu: (x) => x, naPozici: (v) => v }
    const text = p.stupnice?.text ?? p.text ?? ((v) => `${v}${p.jednotka ?? ""}`)
    const vypis = el("span", { class: "hodnota" })
    const meze = () => [
      p.nad ? Math.max(min, stav[p.nad] + p.krok) : min,
      p.pod ? Math.min(max, stav[p.pod] - p.krok) : max,
    ]
    const vstup = el("input", {
      type: "range",
      min: st.min,
      max: st.max,
      step: p.krok ?? 1,
      id: `nast-${p.klic}`,
      style: p.barva ? { "--povoleno": `var(${p.barva})` } : {},
      oninput: (e) => {
        const [od, do_] = meze()
        const v = Math.min(do_, Math.max(od, st.naHodnotu(Number(e.target.value))))
        if (!p.stupnice) e.target.value = String(v)
        nastav(v)
        prekresliPasma()
        zmeny[p.klic] = v
        clearTimeout(cekani)
        cekani = setTimeout(() => {
          const odeslat = zmeny
          zmeny = {}
          naZmenu(odeslat)
        }, 350)
      },
      // Nelineární stupnice: po puštění jezdec doskočí na zvolenou hodnotu.
      onchange: p.stupnice ? (e) => (e.target.value = String(st.naPozici(stav[p.klic]))) : null,
    })
    const nastav = (v) => {
      stav[p.klic] = v
      vypis.textContent = text(v)
    }
    const pasmo = () => {
      const [od, do_] = meze()
      // Poloha středu jezdce; bez omezení stopa sahá až na kraj.
      const mez = (v, kraj) => {
        const k = (st.naPozici(v) - st.min) / (st.max - st.min)
        return k <= 0 || k >= 1 ? kraj : `calc(var(--palec) / 2 + (100% - var(--palec)) * ${k})`
      }
      vstup.style.setProperty("--mez-od", mez(od, "0%"))
      vstup.style.setProperty("--mez-do", mez(do_, "100%"))
    }
    nastav(nastaveni[p.klic])
    vstup.value = String(st.naPozici(nastaveni[p.klic]))
    return {
      p,
      vstup,
      pasmo,
      zvenku(v) {
        if (document.activeElement === vstup) return
        nastav(v)
        vstup.value = String(st.naPozici(v))
      },
      prvek: el(
        "label",
        { class: "pole", for: `nast-${p.klic}` },
        el("span", { class: "radek mezi" }, el("span", { text: p.nazev }), vypis),
        vstup,
        p.popis ? el("span", { class: "slabe mala", text: p.popis }) : null,
      ),
    }
  })
  const prekresliPasma = () => pole.forEach((f) => f.pasmo())
  prekresliPasma()
  return {
    prvek: el("div", { style: { display: "grid", gap: "14px" } }, ...pole.map((f) => f.prvek)),
    aktualizuj(n) {
      for (const f of pole) if (f.p.klic in n) f.zvenku(n[f.p.klic])
      prekresliPasma()
    },
  }
}

/** Výsledek kalibrace ticha jako text (zpráva z chůvičky, starší posílá rovnou text). */
export function textKalibrace(m) {
  if (m.duvod === "budik") return t("Hraje budíček, ticho teď změřit nejde.")
  if (m.duvod === "ukolebavka") return t("Hraje ukolébavka, ticho teď změřit nejde.")
  if (m.duvod === "mikrofon") return t("Chůvička nemá povolený mikrofon.")
  if (m.duvod === "nemeri") return t("Chůvička neměří. Klepni na ní na Hlídat nebo Kalibrovat.")
  if (Number.isFinite(m.ticho)) return t("Ticho {ticho} → prahy {ozyva} a {place}", { ticho: Math.round(m.ticho), ozyva: m.prahOzyva, place: m.prahPlace })
  return m.text ?? ""
}
