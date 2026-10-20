import { el, obrazovka, okno, cas, nazevAplikace, volbaJazyka } from "./dom.js"
import { Spojeni, api } from "./spojeni.js"
import { kontext, mikrofon, zpracujMikrofon, prehravac } from "./zvuk.js"
import { vytvorDetektor, prahyZKalibrace, VYCHOZI } from "./detekce.js"
import { pustZvuk, prehravacSouboru, ZVUKY } from "./zvuky.js"
import { maZvonit, idSouboru, DELKA_MINUT, NABEH_S } from "./budik.js"
import { panelNastaveni, ukazatel, textKalibrace } from "./nastaveni.js"
import { t } from "./i18n.js"

/**
 * Telefon u dítěte. Poslouchá mikrofon, hlásí hladinu a události,
 * na pokyn rodiče vysílá zvuk, přehrává jeho hlas a ukolébavku,
 * ráno zvoní budíčkem.
 *
 * Při hlídání je obrazovka černá a dotyky nic nedělají — odemkne se
 * podržením prstu na 3 s, ať si s telefonem nezačne hrát dítě.
 */
export function spustChuvicku(zarizeni, { naZruseni }) {
  let nastaveni = { ...VYCHOZI }
  let rodicu = 0
  let online = false
  let ctx = null
  let mic = null
  let zpracovani = null
  const detektor = vytvorDetektor(nastaveni)
  let hlida = false
  let maxSekundy = 0
  let posledniOdeslani = 0
  let kalibrace = null
  let hlas = null
  let posledniHlas = 0
  let ukolebavka = null // { zvuk, do, zastav }
  let budik = null // zvoní: { od, zastav }
  let posunPrahu = 0 // zvýšení prahů, dokud hraje ukolébavka nebo budíček
  let mereniHrani = null // hladiny během hraní — o kolik zvednout prahy
  const prehravacZvuku = prehravacSouboru()
  /** Nahrané zvuky stažené předem: id → adresa v paměti (budíček nesmí čekat na síť). */
  const soubory = new Map()
  const KLIC_BUDIKU = "chuvicka-budik-posledni"
  let wakeLock = null
  let poslechChce = false
  // Rodič má aplikaci otevřenou — hladinu chce vidět živě (každou sekundu).
  // Jinak stačí jednou za 10 s: šetří baterii (Wi-Fi se nebudí pořád)
  // a na hlídání spojení to stačí.
  let zive = false
  let posledniHlasite = -Infinity
  const meric = ukazatel()

  const spojeni = new Spojeni(zarizeni, {
    naStav(o, kod) {
      online = o
      if (kod === 4001) return zruseno()
      vykresliStav()
      if (o) posliStav()
    },
    naZpravu(m) {
      if (m.typ === "nastaveni") {
        nastaveni = m.data
        pouzijNastaveni()
        panel?.aktualizuj(nastaveni)
        // Zvuk budíčku stáhnout hned — ráno může vypadnout Wi-Fi.
        if (nastaveni.budik?.zapnuto && idSouboru(nastaveni.budik.zvuk)) stahniSoubor(idSouboru(nastaveni.budik.zvuk)).catch(() => {})
      } else if (m.typ === "rodice") {
        const pred = rodicu
        rodicu = m.pocet
        vykresliStav()
        if (rodicu > pred) document.querySelector(".okno[data-parovani]")?.remove()
      } else if (m.typ === "zive") {
        zive = m.zapnout
      } else if (m.typ === "poslech") {
        poslechChce = m.zapnout
        nastavVysilani()
      } else if (m.typ === "hlas") {
        if (m.zapnout && ctx) {
          hlas = prehravac(ctx, nastaveni.hlasitost)
          posledniHlas = performance.now()
        } else if (!m.zapnout && hlas) {
          const h = hlas
          hlas = null
          setTimeout(() => h.odpoj(), 1000)
        }
        nastavVysilani()
      } else if (m.typ === "ukolebavka") {
        spustUkolebavku(m.zvuk, m.minut)
      } else if (m.typ === "budikVypnout") {
        budik?.zastav()
      } else if (m.typ === "kalibrovat") {
        kalibrovat()
      } else if (m.typ === "ukoncit") {
        ukoncenoNaDalku()
      }
    },
    naBinarni(data) {
      posledniHlas = performance.now()
      hlas?.prijmi(data)
    },
  })

  function pouzijNastaveni() {
    detektor.nastav({
      ...nastaveni,
      prahOzyva: Math.min(99, nastaveni.prahOzyva + posunPrahu),
      prahPlace: Math.min(99, nastaveni.prahPlace + posunPrahu),
    })
    meric.prahy(nastaveni)
  }

  // Když mluví rodič, zvuk se nevysílá — slyšel by se sám zpátky.
  function nastavVysilani() {
    if (zpracovani) zpracovani.vysilat = poslechChce && !hlas
  }

  function posliStav() {
    spojeni.posli({
      typ: "stav",
      hlida,
      baterie: baterie?.level ?? null,
      nabiji: baterie?.charging ?? null,
      ukolebavka: ukolebavka ? { zvuk: ukolebavka.zvuk, do: ukolebavka.do } : null,
      budik: budik ? { od: budik.od } : null,
    })
  }

  // Baterie (jen Android/Chrome; iPhone ji webu neprozradí).
  let baterie = null
  navigator.getBattery?.().then((b) => {
    baterie = b
    b.addEventListener("levelchange", posliStav)
    b.addEventListener("chargingchange", posliStav)
    posliStav()
  })
  setInterval(posliStav, 30_000)

  // Pojistka: když 3 s nepřijde hlas rodiče, „mluvení" končí a hlídání
  // pokračuje — po dobu hlasu je detekce vypnutá, nesmí uvíznout.
  setInterval(() => {
    if (hlas && performance.now() - posledniHlas > 3000) {
      const h = hlas
      hlas = null
      h.odpoj()
      nastavVysilani()
    }
  }, 1000)

  // ─── Zvuk ──────────────────────────────────────────────────────────

  /** `tise` — obnova na pozadí: bez okna s chybou, zkusí se to znovu. */
  async function zapniMikrofon({ tise = false } = {}) {
    if (mic) return true
    try {
      if (ctx?.state === "closed") ctx = null
      ctx ??= await kontext()
      // Systém zvuk pozastavil (budík, hovor) — hned zkusit rozběhnout.
      ctx.onstatechange = () => {
        if (ctx.state !== "running" && mic) ctx.resume().catch(() => {})
      }
      mic = await mikrofon(ctx)
      // Mikrofon si vzala jiná aplikace, nebo ho systém ukončil.
      for (const stopa of mic.stream.getAudioTracks()) {
        stopa.addEventListener("ended", () => obnovZvuk("mikrofon ukončen"))
        stopa.addEventListener("mute", () => obnovZvuk("mikrofon ztlumen"))
      }
    } catch (e) {
      if (!tise)
        alertOkno(
          t("Mikrofon není povolený"),
          t("Bez mikrofonu chůvička neslyší. Povol ho v nastavení prohlížeče pro tuto stránku a zkus to znovu."),
        )
      console.warn(e)
      return false
    }
    zpracovani = zpracujMikrofon(mic, ctx.sampleRate, {
      naHladinu,
      naRamec: (r) => spojeni.posliBinarni(r),
    })
    nastavVysilani()
    document.querySelector("[data-zapnout-mikrofon]")?.remove()
    return true
  }

  /**
   * Hlídač zvuku. 7. 10. 2026 se v telefonu zastavilo zpracování zvuku
   * (nejspíš budík) a chůvička skoro dvě hodiny neslyšela, i když
   * spojení žilo. Hladina chodí 10× za sekundu — 8 s bez ní znamená, že
   * zvuk stojí: zkusit rozběhnout kontext, a když to nestačí, mikrofon
   * otevřít znovu. Rodiči to mezitím ohlásí server (hlídá totéž).
   *
   * Mrtvý mikrofon hladinu posílá dál — dokonalé digitální ticho (0).
   * Skutečná místnost má i v noci kolem 30, takže hladina pod ŽIVÁ se
   * za slyšení nepočítá.
   */
  const ZIVA = 2
  let posledniHladina = performance.now()
  let obnovuji = false
  async function obnovZvuk(proc) {
    // Bez hlídání a bez mikrofonu není co obnovovat (mikrofon ještě nikdo nezapnul).
    if (obnovuji || (!mic && !hlida)) return
    obnovuji = true
    console.warn("obnovuji zvuk:", proc)
    try {
      if (mic) {
        if (ctx && ctx.state !== "running") await ctx.resume().catch(() => {})
        await new Promise((r) => setTimeout(r, 1500))
        if (performance.now() - posledniHladina < 3000) return
        zpracovani = null
        mic.zastav()
        mic = null
      }
      // Nepovede-li se, zkusí to hlídač za pár sekund znovu.
      await zapniMikrofon({ tise: true })
    } finally {
      obnovuji = false
    }
  }
  setInterval(() => {
    if ((mic || hlida) && performance.now() - posledniHladina > 8000) obnovZvuk("8 s bez hladiny")
  }, 4000)

  function naHladinu(h) {
    const ted = performance.now()
    if (h > ZIVA) posledniHladina = ted
    // Při hlídání je obrazovka černá — měřič se nepřekresluje vůbec,
    // tečka nejvýš jednou za 2 s.
    if (!hlida) meric.hladina(h)
    else if (tecka && ted - (naHladinu.tecka ?? 0) > 2000) {
      naHladinu.tecka = ted
      tecka(h)
    }
    maxSekundy = Math.max(maxSekundy, h)
    if (h >= nastaveni.prahOzyva - 5) posledniHlasite = ted
    if (kalibrace) kalibrace.push(h)
    if (mereniHrani) mereniHrani.push(h)
    if (hlida && !hlas) {
      const u = detektor.krok(h, ted / 1000)
      if (u) spojeni.posli({ typ: "udalost", ...u })
    }
    const interval = zive || !hlida || ted - posledniHlasite < 15_000 ? 1000 : 10_000
    if (ted - posledniOdeslani >= interval) {
      posledniOdeslani = ted
      spojeni.posli({ typ: "hladina", h: maxSekundy })
      maxSekundy = 0
    }
  }

  /**
   * Změří 10 s ticho a prahy nastaví nad něj. Spouští ji tlačítko tady
   * i rodič na dálku — průběh se mu posílá zpátky.
   */
  let kalibruje = false
  async function kalibrovat() {
    if (kalibruje) return
    const tlacitko = document.querySelector("[data-kalibrace]")
    const ohlas = (stav, data = {}) => spojeni.posli({ typ: "kalibrace", stav, ...data })
    if (ukolebavka || budik) return ohlas("nelze", { duvod: budik ? "budik" : "ukolebavka" })
    if (!(await zapniMikrofon())) return ohlas("nelze", { duvod: "mikrofon" })
    kalibruje = true
    if (tlacitko) tlacitko.disabled = true
    kalibrace = []
    for (let s = 10; s > 0; s--) {
      if (tlacitko) tlacitko.textContent = t("Měřím ticho… {s}", { s })
      ohlas("meri", { zbyva: s })
      await new Promise((r) => setTimeout(r, 1000))
    }
    const vzorky = kalibrace
    kalibrace = null
    kalibruje = false
    if (tlacitko) tlacitko.disabled = false
    // Spící zvukový kontext (bez klepnutí na chůvičku) neměří nic.
    if (vzorky.length < 20) {
      if (tlacitko) tlacitko.textContent = t("Kalibrovat ticho (10 s)")
      return ohlas("nelze", { duvod: "nemeri" })
    }
    // Medián — jedno zakašlání během měření práh nezvedne.
    const serazene = [...vzorky].sort((a, b) => a - b)
    const ticho = serazene[Math.floor(serazene.length / 2)] ?? 0
    const prahy = prahyZKalibrace(ticho)
    spojeni.posli({ typ: "nastaveni", data: prahy })
    const vysledek = { ticho: Math.round(ticho), prahOzyva: prahy.prahOzyva, prahPlace: prahy.prahPlace }
    if (tlacitko) tlacitko.textContent = textKalibrace(vysledek)
    ohlas("hotovo", vysledek)
  }

  /** Nahraný zvuk ze serveru do paměti telefonu (jednou, pak z paměti). */
  async function stahniSoubor(id) {
    if (soubory.has(id)) return soubory.get(id)
    const r = await fetch(`/api/zvuky/${id}`, { headers: { "X-Zarizeni": `${zarizeni.id}:${zarizeni.tajemstvi}` } })
    if (!r.ok) throw new Error(`zvuk ${r.status}`)
    const url = URL.createObjectURL(await r.blob())
    // Drží se nejvýš pár souborů — paměť telefonu u dítěte je pro hlídání.
    if (soubory.size >= 3) {
      const [stary, staraUrl] = soubory.entries().next().value
      URL.revokeObjectURL(staraUrl)
      soubory.delete(stary)
    }
    soubory.set(id, url)
    return url
  }

  /** Vestavěný zvuk, nebo nahraný soubor; nedostupný soubor → vestavěná ukolébavka. */
  async function zdrojZvuku(zvuk) {
    const id = idSouboru(zvuk)
    if (!id) return { druh: zvuk, soubor: null }
    try {
      return { druh: zvuk, soubor: { prehravac: prehravacZvuku, url: await stahniSoubor(id) } }
    } catch (e) {
      console.warn("nahraný zvuk nejde stáhnout", e)
      return { druh: "ukolebavka", soubor: null }
    }
  }

  /**
   * Hraje-li ukolébavka nebo budíček, mikrofon ho slyší a spustil by
   * poplach. Hladina se proto měří (poprvé po náběhu, pak každých 15 s
   * — vlastní písnička i budíček s pozvolným náběhem sílí) a prahy se
   * zvednou nad ni. Nikdy se nesníží, dokud se hraje.
   */
  function hlidejHrani(hraje) {
    const zmer = () => {
      if (!hraje()) return
      const vzorky = []
      mereniHrani = vzorky
      setTimeout(() => {
        if (mereniHrani === vzorky) mereniHrani = null
        if (!hraje()) return
        const s = [...vzorky].sort((a, b) => a - b)
        const hlasitost = s[Math.floor(s.length / 2)] ?? 0
        posunPrahu = Math.max(posunPrahu, Math.round(hlasitost + 8 - nastaveni.prahOzyva))
        pouzijNastaveni()
        setTimeout(zmer, 12_000)
      }, 3000)
    }
    setTimeout(zmer, 4000)
  }

  function poHrani() {
    if (ukolebavka || budik) return
    posunPrahu = 0
    mereniHrani = null
    pouzijNastaveni()
  }

  async function spustUkolebavku(zvuk, minut) {
    ukolebavka?.zastav()
    ukolebavka = null
    poHrani()
    if (zvuk && ctx && !budik) {
      const { druh, soubor } = await zdrojZvuku(zvuk)
      const zastav = pustZvuk(ctx, druh, {
        minut,
        hlasitost: nastaveni.hlasitost * 0.6,
        soubor,
        naKonec: () => {
          if (ukolebavka?.zastav === zastav) {
            ukolebavka = null
            poHrani()
            posliStav()
          }
        },
      })
      ukolebavka = { zvuk, do: Date.now() + minut * 60_000, zastav }
      hlidejHrani(() => ukolebavka?.zastav === zastav)
    }
    posliStav()
  }

  /**
   * Budíček: zvoní podle hodin tohoto telefonu, jen když chůvička hlídá
   * (přehrávat smí stránka až po klepnutí na „Začít hlídat"). Začne
   * potichu, za půl minuty hraje naplno, nejdéle 15 minut. Vypne ho
   * rodič na dálku, nebo někdo u dítěte po odemknutí obrazovky.
   */
  setInterval(() => {
    if (!hlida || !ctx || budik) return
    let posledni = null
    try {
      posledni = localStorage.getItem(KLIC_BUDIKU)
    } catch {}
    const den = maZvonit(nastaveni.budik, new Date(), posledni)
    if (!den) return
    try {
      localStorage.setItem(KLIC_BUDIKU, den)
    } catch {}
    zazvon()
  }, 10_000)

  async function zazvon() {
    if (ukolebavka) {
      ukolebavka.zastav()
      ukolebavka = null
    }
    const nastaveny = nastaveni.budik
    const { druh, soubor } = await zdrojZvuku(nastaveny.zvuk)
    if (ctx.state !== "running") await ctx.resume().catch(() => {})
    const konec = () => {
      if (budik?.zastav !== zastav) return
      budik = null
      poHrani()
      // Jednorázový budíček se po zazvonění vypne.
      if (nastaveny.jednou) spojeni.posli({ typ: "nastaveni", data: { budik: { ...nastaveni.budik, zapnuto: false } } })
      napovedaHlidani?.(null)
      posliStav()
    }
    const zastav = pustZvuk(ctx, druh, {
      minut: DELKA_MINUT,
      nabeh: NABEH_S,
      hlasitost: nastaveni.hlasitost,
      soubor,
      naKonec: konec,
    })
    budik = { od: Date.now(), zastav }
    hlidejHrani(() => budik?.zastav === zastav)
    napovedaHlidani?.(t("Zvoní budíček. Vypnout: podrž prst 3 sekundy."))
    posliStav()
  }

  // ─── Hlídání: černá obrazovka se zámkem ────────────────────────────

  let tecka = null
  /** Text na černé obrazovce (null = výchozí nápověda). */
  let napovedaHlidani = null
  async function zacniHlidat() {
    // Ještě v obsluze klepnutí, před čekáním na mikrofon — jinak by
    // iPhone budíček ráno nepustil.
    prehravacZvuku.odemkni()
    if (!(await zapniMikrofon())) return
    hlida = true
    posliStav()
    await drzObrazovku()
    const kruh = el("div", { class: "kruh" })
    const bod = el("div", { class: "tecka" })
    const napoveda = el("div", {
      class: "napoveda",
      style: { color: "#777", transition: "color 4s" },
      text: t("Hlídám. Ztlum jas telefonu na minimum. Odemknutí: podrž prst 3 sekundy."),
    })
    setTimeout(() => (napoveda.style.color = "#262626"), 6000)
    const vychozi = napoveda.textContent
    napovedaHlidani = (text) => {
      napoveda.textContent = text ?? vychozi
      napoveda.style.color = text ? "#8a7a4a" : "#262626"
    }
    if (budik) napovedaHlidani(t("Zvoní budíček. Vypnout: podrž prst 3 sekundy."))
    const vrstva = el("div", { class: "hlidani", "data-hlidani": "" }, kruh, bod, napoveda)
    tecka = (h) => {
      const s = 1 + Math.max(0, h - 30) / 25
      bod.style.transform = `scale(${s})`
      bod.style.background = h >= nastaveni.prahPlace ? "#7a2a22" : h >= nastaveni.prahOzyva ? "#5a4a1a" : "#2a1512"
    }
    let drzeni
    const pust = () => {
      clearTimeout(drzeni)
      kruh.classList.remove("drzi")
    }
    vrstva.addEventListener("pointerdown", (e) => {
      e.preventDefault()
      kruh.classList.remove("drzi")
      void kruh.offsetWidth
      kruh.classList.add("drzi")
      drzeni = setTimeout(() => {
        pust()
        odemkni(vrstva)
      }, 3000)
    })
    for (const u of ["pointerup", "pointercancel", "pointerleave"]) vrstva.addEventListener(u, pust)
    vrstva.addEventListener("contextmenu", (e) => e.preventDefault())
    document.body.append(vrstva)
  }

  function odemkni(vrstva) {
    let zamek
    const panel = el(
      "div",
      { class: "karta", style: { width: "min(90vw, 22rem)" }, onpointerdown: (e) => e.stopPropagation() },
      el("h2", { text: t("Chůvička hlídá") }),
      el("p", { class: "slabe", text: online ? t("Spojeno, rodičů: {n}.", { n: rodicu }) : t("Bez spojení se serverem — zkouším se připojit.") }),
      budik ? el("button", { class: "hlavni", onclick: () => (budik?.zastav(), zamkni()) }, t("Vypnout budíček")) : null,
      el("button", { class: budik ? "" : "hlavni", onclick: () => zamkni() }, t("Zamknout")),
      el("button", { onclick: () => skonciHlidani(vrstva) }, t("Ukončit hlídání")),
    )
    vrstva.replaceChildren(panel)
    const zamkni = () => {
      clearTimeout(zamek)
      // Mezitím hlídání ukončil rodič na dálku — znovu nezačínat.
      if (!vrstva.isConnected) return
      vrstva.remove()
      zacniHlidatZnovu()
    }
    zamek = setTimeout(zamkni, 20_000)
  }

  function zacniHlidatZnovu() {
    hlida = false
    zacniHlidat()
  }

  function skonciHlidani(vrstva) {
    vrstva?.remove()
    napovedaHlidani = null
    budik?.zastav()
    hlida = false
    tecka = null
    wakeLock?.release().catch(() => {})
    wakeLock = null
    posliStav()
    vykresli()
  }

  /**
   * Rodič ukončil hlídání ze svého telefonu. Chůvička přestane hlídat
   * i poslouchat: mikrofon se zavře (nesvítí ukazatel, nebere baterii),
   * ukolébavka dohraje hned a obrazovka se přestane držet rozsvícená —
   * telefon pak zhasne a zamkne se podle svého nastavení. Zamknout ho
   * webová aplikace sama neumí.
   */
  function ukoncenoNaDalku() {
    if (!hlida) return
    if (ukolebavka) spustUkolebavku(null)
    skonciHlidani(document.querySelector("[data-hlidani]"))
    zpracovani = null
    mic?.zastav()
    mic = null
    vykresli()
    alertOkno(t("Hlídání ukončil rodič"), t("Chůvička už neposlouchá. Telefon za chvíli sám zhasne a zamkne se. Znovu hlídat: Začít hlídat."))
  }

  async function drzObrazovku() {
    try {
      wakeLock = await navigator.wakeLock?.request("screen")
    } catch {}
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && hlida) drzObrazovku()
    if (document.visibilityState === "hidden" && hlida) posliStav()
  })

  // ─── Příprava ───────────────────────────────────────────────────────

  const stavPrvek = el("p", { class: "slabe" })
  function vykresliStav() {
    stavPrvek.textContent = `${online ? t("Připojeno") : t("Připojuji…")} · ${
      rodicu ? t("spárované telefony rodičů: {n}", { n: rodicu }) : t("zatím bez telefonu rodiče")
    }`
  }

  function alertOkno(titulek, text) {
    const o = okno(el("h2", { text: titulek }), el("p", { text }), el("button", { onclick: () => o.remove() }, t("Rozumím")))
  }

  async function parovani() {
    const qr = el("div", { class: "qr" })
    const kod = el("div", { class: "kod" })
    const plati = el("p", { class: "slabe", style: { textAlign: "center" } })
    let casovac
    const nacti = async () => {
      try {
        const k = await api("/api/kod", zarizeni, {})
        const svg = new DOMParser().parseFromString(k.qr, "image/svg+xml").documentElement
        qr.replaceChildren(svg)
        kod.textContent = k.kod
        plati.textContent = t("Platí do {cas}, pak se ukáže nový.", { cas: cas(k.platiDo) })
        clearTimeout(casovac)
        casovac = setTimeout(nacti, k.platiDo - Date.now())
      } catch (e) {
        plati.textContent = e.message
      }
    }
    const o = okno(
      el("h2", { text: t("Spárovat telefon rodiče") }),
      el("p", {
        class: "slabe",
        text: t("Na telefonu rodiče otevři Chůvičku, zvol Přidat chůvičku a naskenuj kód. Nebo kód opiš."),
      }),
      qr,
      kod,
      plati,
      el("button", { onclick: () => o.remove() }, t("Hotovo")),
    )
    o.dataset.parovani = ""
    new MutationObserver(() => !o.isConnected && clearTimeout(casovac)).observe(document.body, { childList: true })
    nacti()
  }

  let panel = null
  function vykresli() {
    vykresliStav()
    meric.prahy(nastaveni)
    panel = panelNastaveni(nastaveni, (zmena) => spojeni.posli({ typ: "nastaveni", data: zmena }))
    const kalibraceTl = el("button", { "data-kalibrace": true, onclick: () => kalibrovat() }, t("Kalibrovat ticho (10 s)"))
    const nazev = el("input", { type: "text", value: zarizeni.nazev, maxlength: 40, "aria-label": t("Název chůvičky") })
    nazev.addEventListener("change", () => {
      zarizeni.nazev = nazev.value.trim() || t("Chůvička")
      localStorage.setItem("chuvicka-zarizeni", JSON.stringify(zarizeni))
      spojeni.posli({ typ: "prejmenovat", nazev: zarizeni.nazev })
    })
    obrazovka(
      el("header", { class: "radek mezi" }, nazevAplikace(), el("span", { class: "stitek pozor", text: t("u dítěte") })),
      stavPrvek,
      el("button", { class: "hlavni velke", onclick: zacniHlidat }, t("Začít hlídat")),
      el(
        "section",
        { class: "karta" },
        el("h2", { text: t("Telefony rodičů") }),
        el("button", { onclick: parovani }, t("Spárovat telefon rodiče (QR)")),
      ),
      el(
        "section",
        { class: "karta" },
        el("h2", { text: t("Citlivost") }),
        el("p", {
          class: "slabe",
          text: t("Ukazatel ukazuje hluk v místnosti. Žlutá čára: ozývá se, červená: pláče. Kalibrace změří ticho a prahy nastaví nad něj."),
        }),
        meric.prvek,
        mic ? null : el("button", { "data-zapnout-mikrofon": "", onclick: () => zapniMikrofon() }, t("Zapnout mikrofon")),
        kalibraceTl,
        panel.prvek,
      ),
      el(
        "section",
        { class: "karta" },
        el("h2", { text: t("Než začneš hlídat") }),
        el(
          "ul",
          { class: "slabe", style: { margin: 0, paddingLeft: "1.2em", display: "grid", gap: "6px" } },
          el("li", { text: t("Připoj telefon k nabíječce a nech ho na Wi-Fi.") }),
          el("li", { text: t("Ztlum jas obrazovky na minimum — aplikace ho sama změnit nesmí; při hlídání je obrazovka černá.") }),
          el("li", { text: t("Nech aplikaci otevřenou. Ať ji dítě nezavře: Android — Připnutí aplikace, iPhone — Asistovaný přístup (Nastavení › Zpřístupnění).") }),
          el("li", { text: t("Telefon dej aspoň metr od dítěte, mikrofonem k postýlce.") }),
        ),
      ),
      el(
        "section",
        { class: "karta" },
        el("label", { class: "pole" }, t("Název chůvičky (uvidí ho rodič)"), nazev),
        volbaJazyka(),
        el("button", { class: "odkaz", onclick: zrusit }, t("Zrušit spojení")),
      ),
    )
  }

  async function zrusit() {
    const o = okno(
      el("h2", { text: t("Zrušit spojení?") }),
      el("p", { text: t("Telefony rodičů se odpárují a historie se smaže.") }),
      el(
        "div",
        { class: "mrizka-2" },
        el("button", { onclick: () => o.remove() }, t("Ne")),
        el(
          "button",
          {
            class: "hlavni",
            onclick: async () => {
              await api("/api/zrusit", zarizeni, {}).catch(() => {})
              o.remove()
              zruseno()
            },
          },
          t("Zrušit"),
        ),
      ),
    )
  }

  function zruseno() {
    spojeni.zavri()
    mic?.zastav()
    naZruseni()
  }

  pouzijNastaveni()
  vykresli()
}

export { ZVUKY }
