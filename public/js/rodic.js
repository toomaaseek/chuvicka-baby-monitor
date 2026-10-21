import { el, obrazovka, okno, cas, datum, predChvili, nazevAplikace, volbaJazyka, zalozky } from "./dom.js"
import { Spojeni, api } from "./spojeni.js"
import { kontext, mikrofon, zpracujMikrofon, prehravac } from "./zvuk.js"
import { panelNastaveni, ukazatel, textKalibrace } from "./nastaveni.js"
import { ZVUKY, nazevVestaveneho } from "./zvuky.js"
import { DNY, nazevDne, srovnejBudik, popisBudiku, idSouboru, SVITANI } from "./budik.js"
import { skenuj } from "./skener.js"
import { souhrnSpanku, delka } from "./spanek.js"
import { t, jazyk, nastavJazyk } from "./i18n.js"

/** Popis události pro seznam — v jazyce telefonu, proto až při vykreslení. */
const popisUdalosti = (druh) =>
  ({
    ozyva: t("Ozývá se"),
    place: t("Pláče"),
    offline: t("Chůvička bez spojení"),
    online: t("Chůvička znovu připojená"),
    neslysi: t("Chůvička neslyší (mikrofon stojí)"),
    zahajeno: t("Hlídání zahájeno"),
    ukonceno: t("Hlídání ukončeno u dítěte"),
    ukonceno_rodicem: t("Hlídání ukončeno z telefonu rodiče"),
    slysi: t("Chůvička zase slyší"),
    baterie: t("Málo baterie"),
    pozastaveno: t("Upozornění pozastavena"),
    obnoveno: t("Upozornění obnovena"),
    budik: t("Zvonil budíček"),
    potlaceno: t("Hluk, ne pláč — neohlášeno"),
  })[druh] ?? druh

/** „Ozývá se · 12 s" — druh a délka. */
const radekUdalosti = (u) =>
  `${popisUdalosti(u.druh)}${u.trvani ? ` · ${Math.round(u.trvani)}${u.druh === "pozastaveno" ? " min" : " s"}` : ""}`

/** Největší nahraný zvuk — stejně jako na serveru. */
const MAX_ZVUK_MB = 20

/** Historie noci: kolik hodin zpátky jde graf posunout. */
const HODIN_HISTORIE = 24

/**
 * Telefon rodiče: přehled chůvičky, příposlech, vysílačka, ukolébavka,
 * budíček, vlastní zvuky, pozastavení, nastavení na dálku a historie noci.
 */
export function spustRodice(zarizeni, { naZruseni, kodKParovani }) {
  /** id → poslední stav ze serveru */
  const chuvicky = new Map()
  let vybrana = null
  let online = false
  // Události: při otevření a po obnovení spojení se načte posledních
  // 12 hodin ze serveru, nové přibývají živě. Dřív jen „od otevření" —
  // po zavření a otevření aplikace byl seznam prázdný, i když se dělo.
  const udalosti = []
  const nacteno = new Set()
  const meric = ukazatel()
  let ctx = null
  let poslech = null // { prehravac }
  let vysilacka = null // { mic, zpracovani }
  // Prst na tlačítku Mluvit. Poprvé se telefon ptá na mikrofon — kdo mezitím
  // pustil, nesmí po odsouhlasení zůstat „mluvící" (chůvička by do té doby
  // nehlídala).
  let drziMluvit = false
  // Překreslení odložené na puštění tlačítka Mluvit. Celá obrazovka se
  // staví znovu při každé změně stavu — a stav se mění hned po stisku
  // (server hlásí „mluví"). Nové tlačítko pod prstem by puštění prstu
  // vzalo jako konec mluvení, takže mluvení se vypínalo hned po startu.
  let vykreslitPoPusteni = false
  // Prohlížeč stisk zrušil (gesto, systémové okno…), prst ale možná
  // pořád drží. Mluvení pak nekončí — tlačítko přepne na „klepni pro
  // konec" a další klepnutí ho ukončí. Pojistka: nejdéle 2 minuty.
  let zamceneMluveni = false
  let zamceneDo = null
  const ZAMCENE_NEJDELE = 120_000
  // Nezhasínat obrazovku: volba se pamatuje v telefonu, zámek (Wake Lock)
  // prohlížeč pustí při každém odchodu aplikace do pozadí — po návratu znovu.
  const KLIC_SVITIT = "chuvicka-nezhasinat"
  let svitit = false
  try {
    svitit = localStorage.getItem(KLIC_SVITIT) === "1"
  } catch {}
  let zamekObrazovky = null
  let otevreneNastaveni = null // { chuvicka, panel, kalibraceTl } — otevřené okno nastavení
  let otevrenaFotka = null // { chuvicka, prisla(zprava) } — otevřené okno fotky
  /** Nahrané zvuky (sdílené všemi zařízeními) a co se má překreslit, když se změní. */
  let zvuky = []
  let naZmenuZvuku = null
  const nactiZvuky = () =>
    api("/api/zvuky", zarizeni)
      .then((r) => {
        zvuky = r.zvuky
        naZmenuZvuku?.()
      })
      .catch(() => {})

  const spojeni = new Spojeni(zarizeni, {
    naStav(o, kod) {
      online = o
      if (o) nacteno.clear()
      if (kod === 4001) return zruseno()
      if (o) spojeni.posli({ typ: "divam", zapnout: document.visibilityState === "visible" })
      if (o) nactiZvuky()
      if (!o && poslech) zastavPoslech()
      vykresli()
    },
    naZpravu(m) {
      if (m.typ === "stav") {
        chuvicky.set(m.chuvicka, m)
        vybrana ??= m.chuvicka
        if (!nacteno.has(m.chuvicka)) {
          nacteno.add(m.chuvicka)
          nactiUdalosti(m.chuvicka)
        }
        if (poslech && poslech.chuvicka === m.chuvicka && !m.online) zastavPoslech()
        if (otevreneNastaveni?.chuvicka === m.chuvicka) otevreneNastaveni.panel.aktualizuj(m.nastaveni)
        vykresli()
      } else if (m.typ === "hladina" && m.chuvicka === vybrana) {
        meric.hladina(m.h)
      } else if (m.typ === "udalost") {
        pridejUdalost({ ...m, kdy: m.kdy ?? Date.now() })
        if (document.visibilityState === "visible" && (m.druh === "ozyva" || m.druh === "place")) navigator.vibrate?.(m.druh === "place" ? [400, 150, 400] : 200)
        vykresliUdalosti()
      } else if (m.typ === "odparovano") {
        // Chůvička spojení zrušila (nebo byla zrušena) — ze seznamu pryč.
        chuvicky.delete(m.chuvicka)
        nacteno.delete(m.chuvicka)
        if (vybrana === m.chuvicka) vybrana = chuvicky.keys().next().value ?? null
        if (otevreneNastaveni?.chuvicka === m.chuvicka) document.querySelector(".okno")?.remove()
        vykresli()
      } else if (m.typ === "zvuky") {
        zvuky = m.zvuky
        naZmenuZvuku?.()
      } else if (m.typ === "fotka" && otevrenaFotka?.chuvicka === m.chuvicka) {
        otevrenaFotka.prisla(m)
      } else if (m.typ === "kalibrace" && otevreneNastaveni?.chuvicka === m.chuvicka) {
        const tl = otevreneNastaveni.kalibraceTl
        tl.disabled = m.stav === "meri"
        tl.textContent = m.stav === "meri" ? t("Měřím ticho… {s}", { s: m.zbyva }) : textKalibrace(m)
      }
    },
    naBinarni(data) {
      poslech?.prehravac.prijmi(data)
    },
  })

  // Chůvička posílá hladinu každou sekundu jen, když se rodič dívá.
  document.addEventListener("visibilitychange", () => {
    spojeni.posli({ typ: "divam", zapnout: document.visibilityState === "visible" })
    if (document.visibilityState === "visible") drzSviceni()
  })

  async function drzSviceni() {
    if (!svitit || zamekObrazovky || document.visibilityState !== "visible" || !("wakeLock" in navigator)) return
    try {
      zamekObrazovky = await navigator.wakeLock.request("screen")
      zamekObrazovky.addEventListener("release", () => {
        zamekObrazovky = null
        vykresli()
      })
    } catch {}
    vykresli()
  }

  function prepniSviceni() {
    svitit = !svitit
    try {
      localStorage.setItem(KLIC_SVITIT, svitit ? "1" : "0")
    } catch {}
    if (svitit) return drzSviceni()
    zamekObrazovky?.release().catch(() => {})
    zamekObrazovky = null
    vykresli()
  }

  // Upozornění: odběr obnovit při každém startu (prohlížeč ho občas vymění).
  obnovOdber()

  async function obnovOdber() {
    try {
      if (Notification.permission !== "granted") return
      const reg = await navigator.serviceWorker.ready
      const odber = await reg.pushManager.getSubscription()
      if (odber) await api("/api/odber", zarizeni, odber.toJSON())
    } catch {}
  }

  async function zapniUpozorneni(tlacitko) {
    const ios = /iPhone|iPad/.test(navigator.userAgent)
    const nainstalovano = matchMedia("(display-mode: standalone)").matches || navigator.standalone
    if (!("PushManager" in window) || !("serviceWorker" in navigator)) {
      return info(
        t("Upozornění tady nejdou"),
        ios && !nainstalovano
          ? t("Na iPhonu chodí upozornění jen aplikaci přidané na plochu: Sdílet › Přidat na plochu. Pak ji otevři z plochy a spáruj chůvičku znovu.")
          : t("Tenhle prohlížeč push upozornění neumí. Zkus Chrome (Android) nebo Safari s aplikací na ploše (iPhone)."),
      )
    }
    const povoleni = await Notification.requestPermission()
    if (povoleni !== "granted") return info(t("Upozornění jsou zakázaná"), t("Povol je v nastavení prohlížeče pro tuto stránku."))
    const reg = await navigator.serviceWorker.ready
    const { klic } = await api("/api/vapid")
    const odber =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64NaBajty(klic) }))
    await api("/api/odber", zarizeni, odber.toJSON())
    tlacitko.textContent = t("Upozornění zapnutá ✓")
    await api("/api/zkouska", zarizeni, {})
  }

  // ─── Příposlech a vysílačka ─────────────────────────────────────────

  async function prepniPoslech() {
    if (poslech) return zastavPoslech()
    ctx ??= await kontext()
    if (ctx.state === "suspended") await ctx.resume()
    poslech = { chuvicka: vybrana, prehravac: prehravac(ctx, 1) }
    spojeni.posli({ typ: "poslech", chuvicka: vybrana, zapnout: true })
    vykresli()
  }

  function zastavPoslech() {
    if (!poslech) return
    spojeni.posli({ typ: "poslech", chuvicka: poslech.chuvicka, zapnout: false })
    poslech.prehravac.stop()
    poslech.prehravac.odpoj()
    poslech = null
    vykresli()
  }

  /**
   * Mikrofon rodiče je otevřený jen při mluvení. Dřív zůstal po prvním
   * stisku otevřený napořád (jen přestal vysílat) — telefon pak hlásil,
   * že aplikace pořád poslouchá, a bral to baterii. Po puštění se zavře
   * za chvíli (rychlé „tam a zpátky" nečeká na nové otevření), při
   * odchodu z aplikace hned.
   */
  const ZAVRIT_MIKROFON_PO = 5000
  let zavritMikrofon = null
  function uvolniMikrofon() {
    clearTimeout(zavritMikrofon)
    zavritMikrofon = null
    if (!vysilacka || vysilacka.zpracovani.vysilat) return
    vysilacka.mic.zastav()
    vysilacka = null
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return
    if (mluvTl) prestanMluvit(mluvTl)
    uvolniMikrofon()
  })

  async function zacniMluvit(tlacitko) {
    clearTimeout(zavritMikrofon)
    try {
      ctx ??= await kontext()
      if (!vysilacka) {
        // Tady se úpravy prohlížeče hodí: potlačení ozvěny a šumu.
        const mic = await mikrofon(ctx, { prirozeny: true })
        const zpracovani = zpracujMikrofon(mic, ctx.sampleRate, {
          naHladinu: () => {},
          naRamec: (r) => spojeni.posliBinarni(r),
        })
        vysilacka = { mic, zpracovani }
      }
    } catch {
      return info(t("Mikrofon není povolený"), t("Bez mikrofonu nejde k dítěti mluvit. Povol ho v nastavení prohlížeče."))
    }
    if (!drziMluvit) return
    spojeni.posli({ typ: "mluvit", chuvicka: vybrana, zapnout: true })
    vysilacka.zpracovani.vysilat = true
    tlacitko.classList.add("aktivni")
    tlacitko.textContent = zamceneMluveni ? t("Mluvíš… (klepni pro konec)") : t("Mluvíš… (pusť pro konec)")
  }

  function zamkniMluveni(tlacitko, proc) {
    if (!drziMluvit || zamceneMluveni) return
    zamceneMluveni = true
    zamceneDo = setTimeout(() => prestanMluvit(tlacitko), ZAMCENE_NEJDELE)
    if (vysilacka?.zpracovani.vysilat) tlacitko.textContent = t("Mluvíš… (klepni pro konec)")
    spojeni.posli({ typ: "diag", text: `mluvení: ${proc}` })
  }

  function prestanMluvit(tlacitko) {
    drziMluvit = false
    zamceneMluveni = false
    clearTimeout(zamceneDo)
    if (vykreslitPoPusteni) queueMicrotask(vykresli)
    clearTimeout(zavritMikrofon)
    zavritMikrofon = setTimeout(uvolniMikrofon, ZAVRIT_MIKROFON_PO)
    if (!vysilacka?.zpracovani.vysilat) return
    vysilacka.zpracovani.vysilat = false
    spojeni.posli({ typ: "mluvit", chuvicka: vybrana, zapnout: false })
    tlacitko.classList.remove("aktivni")
    tlacitko.textContent = t("Mluvit (podrž)")
  }

  // ─── Okna ───────────────────────────────────────────────────────────

  function info(titulek, text) {
    const o = okno(el("h2", { text: titulek }), el("p", { text }), el("button", { onclick: () => o.remove() }, t("Rozumím")))
  }

  /** Název zvuku pro výpis: vestavěný, nebo nahraný soubor. */
  function nazevZvuku(klic) {
    const id = idSouboru(klic)
    if (!id) return nazevVestaveneho(ZVUKY.find((z) => z.klic === klic))
    return zvuky.find((z) => z.id === id)?.nazev ?? t("Nahraný zvuk")
  }

  /** Volby pro výběr zvuku: vestavěné a pod nimi nahrané. */
  function volbyZvuku(vestavene, vybrano) {
    return [
      ...vestavene.map((z) => el("option", { value: z.klic, text: nazevVestaveneho(z), selected: z.klic === vybrano })),
      zvuky.length
        ? el(
            "optgroup",
            { label: t("Nahrané") },
            ...zvuky.map((z) => el("option", { value: `soubor:${z.id}`, text: z.nazev, selected: `soubor:${z.id}` === vybrano })),
          )
        : null,
    ]
  }

  /** Okno se samo uklidí ze zvukového obnovování, až ho někdo zavře. */
  function sledujZvuky(o, prekresli) {
    naZmenuZvuku = () => (o.isConnected ? prekresli() : (naZmenuZvuku = null))
  }

  function oknoUkolebavka(c) {
    const vyber = el("select", { "aria-label": t("Zvuk") })
    const prekresli = () => {
      const pred = vyber.value || "ukolebavka"
      vyber.replaceChildren(...volbyZvuku(ZVUKY, pred).filter(Boolean))
    }
    prekresli()
    const minuty = el("select", { "aria-label": t("Jak dlouho") }, ...[10, 20, 30, 45, 60, 90].map((m) => el("option", { value: m, text: `${m} min`, selected: m === 20 })))
    const o = okno(
      el("h2", { text: t("Ukolébavka a šum") }),
      c.ukolebavka
        ? el("p", { class: "slabe", text: t("Hraje: {zvuk}, do {cas}.", { zvuk: nazevZvuku(c.ukolebavka.zvuk), cas: cas(c.ukolebavka.do) }) })
        : el("p", { class: "slabe", text: t("Hraje na chůvičce, na konci se postupně ztiší. Hlasitost je v nastavení.") }),
      el("div", { class: "mrizka-2" }, vyber, minuty),
      el(
        "button",
        {
          class: "hlavni",
          onclick: () => {
            spojeni.posli({ typ: "ukolebavka", chuvicka: c.chuvicka, zvuk: vyber.value, minut: Number(minuty.value) })
            o.remove()
          },
        },
        t("Pustit"),
      ),
      c.ukolebavka
        ? el("button", { onclick: () => (spojeni.posli({ typ: "ukolebavka", chuvicka: c.chuvicka, zvuk: null }), o.remove()) }, t("Zastavit"))
        : null,
      el("p", { class: "slabe mala", text: t("Vlastní ukolébavku nahraješ v Nastavení › Zvuky. Nahraná hraje dokola.") }),
    )
    sledujZvuky(o, prekresli)
  }

  /**
   * Fotka na vyžádání: chůvička na chvíli zapne kameru a pošle jeden
   * snímek. Kamera se pamatuje v tomhle telefonu (zadní / přední).
   */
  function oknoFotky(c) {
    const KLIC_KAMERA = "chuvicka-kamera"
    let kamera = "zadni"
    try {
      kamera = localStorage.getItem(KLIC_KAMERA) === "predni" ? "predni" : "zadni"
    } catch {}
    const obraz = el("img", { class: "fotka", alt: t("Fotka z chůvičky") })
    const stav = el("p", { class: "slabe", "aria-live": "polite" })
    let cekani = null
    let url = null
    const vyber = el(
      "select",
      { "aria-label": t("Kamera"), onchange: (e) => {
        kamera = e.target.value
        try {
          localStorage.setItem(KLIC_KAMERA, kamera)
        } catch {}
      } },
      el("option", { value: "zadni", text: t("Zadní kamera"), selected: kamera === "zadni" }),
      el("option", { value: "predni", text: t("Přední kamera"), selected: kamera === "predni" }),
    )
    const vyfotit = () => {
      stav.className = "slabe"
      stav.textContent = t("Fotím…")
      clearTimeout(cekani)
      cekani = setTimeout(() => (stav.textContent = t("Chůvička neodpověděla. Zkus to znovu.")), 15000)
      spojeni.posli({ typ: "fotka", chuvicka: c.chuvicka, kamera })
    }
    const znovu = el("button", { class: "hlavni", onclick: vyfotit }, t("Vyfotit znovu"))
    const o = okno(
      el("h2", { text: t("Fotka z chůvičky") }),
      obraz,
      stav,
      el("div", { class: "mrizka-2" }, vyber, znovu),
      el("p", { class: "slabe mala", text: t("Fotka se nikam neukládá. Ve tmě ji chůvička zesvětlí, bude zrnitá.") }),
      el("button", { onclick: () => o.remove() }, t("Zavřít")),
    )
    obraz.hidden = true
    otevrenaFotka = {
      chuvicka: c.chuvicka,
      async prisla(m) {
        clearTimeout(cekani)
        if (m.chyba) {
          stav.className = "chyba"
          stav.textContent =
            m.chyba === "povoleni"
              ? t("Chůvička nemá povolenou kameru. Povol ji na telefonu u dítěte (Povolit kameru pro fotku).")
              : t("Kamera na chůvičce nejde zapnout.")
          return
        }
        try {
          const r = await fetch(`/api/fotka?chuvicka=${encodeURIComponent(c.chuvicka)}`, {
            headers: { "X-Zarizeni": `${zarizeni.id}:${zarizeni.tajemstvi}` },
          })
          if (!r.ok) throw new Error(t("Chyba {kod}", { kod: r.status }))
          if (url) URL.revokeObjectURL(url)
          url = URL.createObjectURL(await r.blob())
          obraz.src = url
          obraz.hidden = false
          stav.className = "slabe"
          stav.textContent = t("Vyfoceno v {cas}", { cas: cas(m.kdy) })
        } catch (e) {
          stav.className = "chyba"
          stav.textContent = e.message
        }
      },
    }
    new MutationObserver((_, p) => {
      if (o.isConnected) return
      if (otevrenaFotka?.chuvicka === c.chuvicka) otevrenaFotka = null
      clearTimeout(cekani)
      if (url) URL.revokeObjectURL(url)
      p.disconnect()
    }).observe(document.body, { childList: true })
    vyfotit()
  }

  function oknoPozastavit(c) {
    const pozastaveno = c.nastaveni.pozastavenoDo > Date.now()
    const posli = (minut) => {
      spojeni.posli({ typ: "pozastavit", chuvicka: c.chuvicka, minut })
      o.remove()
    }
    // Vlastní počet minut: celé číslo 1–1440 (server víc než den nepřijme).
    const vlastni = el("input", {
      type: "number",
      id: "pauza-minut",
      inputmode: "numeric",
      min: 1,
      max: 1440,
      step: 1,
      placeholder: t("Jiný počet minut"),
      "aria-label": t("Jiný počet minut"),
    })
    const platne = () => {
      const m = Number(vlastni.value)
      return Number.isInteger(m) && m >= 1 && m <= 1440 ? m : null
    }
    const vlastniTl = el("button", { class: "hlavni", disabled: true, onclick: () => platne() && posli(platne()) }, t("Pozastavit"))
    vlastni.addEventListener("input", () => (vlastniTl.disabled = !platne()))
    vlastni.addEventListener("keydown", (e) => e.key === "Enter" && platne() && posli(platne()))
    // Ukončení hlídání na dálku — jen když chůvička je připojená a hlídá.
    // Dvoukrokové: omylem ukončené hlídání by se v noci nepoznalo.
    const ukoncit = el("div", { class: "ukoncit-hlidani" })
    const nabidniUkonceni = () =>
      ukoncit.replaceChildren(
        el("h2", { text: t("Ukončit hlídání") }),
        el("p", { class: "slabe", text: t("Chůvička přestane poslouchat a telefon u dítěte za chvíli zhasne a zamkne se.") }),
        el("button", { disabled: !c.online || !c.hlida, onclick: potvrd }, c.online && c.hlida ? t("Ukončit hlídání…") : t("Chůvička teď nehlídá")),
      )
    const potvrd = () =>
      ukoncit.replaceChildren(
        el("h2", { text: t("Opravdu ukončit hlídání?") }),
        el("p", { class: "slabe", text: t("Upozornění pak chodit nebudou. Znovu se hlídání zapíná na telefonu u dítěte.") }),
        el(
          "div",
          { class: "mrizka-2" },
          el("button", { onclick: nabidniUkonceni }, t("Zpět")),
          el(
            "button",
            {
              class: "nebezpecne",
              onclick: () => {
                spojeni.posli({ typ: "ukoncit", chuvicka: c.chuvicka })
                o.remove()
              },
            },
            t("Ano, ukončit"),
          ),
        ),
      )
    nabidniUkonceni()
    const o = okno(
      el("h2", { text: t("Pozastavit upozornění") }),
      el("p", { class: "slabe", text: t("Chůvička dál poslouchá a zapisuje, jen nechodí upozornění — třeba když jdeš k dítěti.") }),
      el("div", { class: "mrizka-3" }, ...[3, 7, 15].map((m) => el("button", { onclick: () => posli(m) }, `${m} min`))),
      el("div", { class: "vlastni-pauza" }, vlastni, vlastniTl),
      pozastaveno ? el("button", { class: "hlavni", onclick: () => posli(0) }, t("Zrušit pozastavení")) : null,
      ukoncit,
    )
  }

  function oknoNastaveni(c) {
    const panel = panelNastaveni(c.nastaveni, (zmena) => spojeni.posli({ typ: "nastaveni", chuvicka: c.chuvicka, data: zmena }))
    const budikSekce = sekceBudik(c)
    const zvukySekce = sekceZvuky()
    const kalibraceTl = el(
      "button",
      {
        disabled: !c.online,
        onclick: () => {
          kalibraceTl.disabled = true
          kalibraceTl.textContent = t("Spouštím měření…")
          spojeni.posli({ typ: "kalibrovat", chuvicka: c.chuvicka })
        },
      },
      t("Kalibrovat ticho (10 s)"),
    )
    otevreneNastaveni = { chuvicka: c.chuvicka, panel, kalibraceTl }
    const nazev = el("input", { type: "text", value: c.nazev, maxlength: 40, "aria-label": t("Název chůvičky") })
    nazev.addEventListener("change", () => spojeni.posli({ typ: "prejmenovat", chuvicka: c.chuvicka, nazev: nazev.value }))
    const odparovat = el(
      "button",
      {
        class: "odkaz",
        onclick: async () => {
          await api("/api/rozparovat", zarizeni, { chuvicka: c.chuvicka })
          chuvicky.delete(c.chuvicka)
          vybrana = chuvicky.keys().next().value ?? null
          o.remove()
          vykresli()
        },
      },
      t("Odpárovat tuto chůvičku"),
    )
    const o = okno(
      el("h2", { text: t("Nastavení chůvičky") }),
      ...zalozky("nastaveni", [
        {
          id: "citlivost",
          nazev: t("Citlivost"),
          obsah: [
            kalibraceTl,
            el("p", { class: "slabe mala", text: t("Chůvička změří ticho v pokoji a prahy nastaví nad něj. Během měření buď potichu.") }),
            panel.prvek,
          ],
        },
        { id: "budik", nazev: t("Budíček"), obsah: [budikSekce.prvek] },
        { id: "zvuky", nazev: t("Zvuky"), obsah: [zvukySekce.prvek] },
        { id: "obecne", nazev: t("Obecné"), obsah: [el("label", { class: "pole" }, t("Název"), nazev), volbaJazyka(), odparovat] },
      ]),
      el("button", { onclick: () => o.remove() }, t("Hotovo")),
    )
    sledujZvuky(o, () => {
      budikSekce.prekresli()
      zvukySekce.prekresli()
    })
    const pozorovatel = new MutationObserver(() => {
      if (o.isConnected) return
      zvukySekce.zastavUkazku()
      pozorovatel.disconnect()
    })
    pozorovatel.observe(document.body, { childList: true })
  }

  /** Budíček chůvičky: zapnutí, čas, dny (nebo jen jednou) a písnička. */
  function sekceBudik(c) {
    let b = srovnejBudik(c.nastaveni.budik)
    // Hlasitost budíčku — zvlášť od hlasu a ukolébavky, ukládá se hned po puštění.
    const procenta = (v) => `${Math.round(v * 100)} %`
    const hlasitostVstup = el("input", {
      type: "range",
      id: "budik-hlasitost",
      min: 0,
      max: 1,
      step: 0.05,
      style: { "--povoleno": "var(--akcent)", "--mez-od": "0%", "--mez-do": "100%" },
    })
    hlasitostVstup.value = String(c.nastaveni.hlasitostBudiku ?? c.nastaveni.hlasitost ?? 0.7)
    const hlasitostText = el("span", { class: "hodnota", text: procenta(Number(hlasitostVstup.value)) })
    hlasitostVstup.addEventListener("input", () => (hlasitostText.textContent = procenta(Number(hlasitostVstup.value))))
    hlasitostVstup.addEventListener("change", () =>
      spojeni.posli({ typ: "nastaveni", chuvicka: c.chuvicka, data: { hlasitostBudiku: Number(hlasitostVstup.value) } }),
    )
    const hlasitostPole = el(
      "label",
      { class: "pole", for: "budik-hlasitost" },
      el("span", { class: "radek mezi" }, el("span", { text: t("Hlasitost budíčku") }), hlasitostText),
      hlasitostVstup,
    )
    const zapnuto = el("input", { type: "checkbox", checked: b.zapnuto })
    const casPole = el("input", { type: "time", value: b.cas, "aria-label": t("Čas budíčku") })
    const jednou = el("input", { type: "checkbox", checked: b.jednou })
    const dny = DNY.map((d, i) => el("input", { type: "checkbox", value: String(i + 1), checked: b.dny.includes(i + 1), "aria-label": nazevDne(d) }))
    const nastavDny = (seznam) => dny.forEach((x) => (x.checked = seznam.includes(Number(x.value))))
    const zamkniDny = () => dny.forEach((x) => (x.disabled = jednou.checked))
    jednou.addEventListener("change", zamkniDny)
    zamkniDny()
    const vyber = el("select", { "aria-label": t("Písnička k buzení") })
    const svitaniVyber = el(
      "select",
      { id: "budik-svitani" },
      ...SVITANI.map((m) =>
        el("option", { value: m, text: m ? t("{n} min před budíčkem", { n: m }) : t("Ne"), selected: m === b.svitani }),
      ),
    )
    const prekresli = () =>
      vyber.replaceChildren(...volbyZvuku([{ klic: "ukolebavka", nazev: t("Ukolébavka (vestavěná)") }], vyber.value || b.zvuk).filter(Boolean))
    prekresli()
    const zprava = el("p", { class: "slabe mala", "aria-live": "polite" })
    const uloz = () => {
      const novy = srovnejBudik({
        zapnuto: zapnuto.checked,
        cas: casPole.value,
        jednou: jednou.checked,
        dny: dny.filter((x) => x.checked).map((x) => Number(x.value)),
        zvuk: vyber.value,
        svitani: Number(svitaniVyber.value),
      })
      if (novy.zapnuto && !novy.jednou && !novy.dny.length) {
        zprava.className = "chyba mala"
        zprava.textContent = t("Vyber aspoň jeden den, nebo zaškrtni Jen jednou.")
        return
      }
      b = novy
      spojeni.posli({ typ: "nastaveni", chuvicka: c.chuvicka, data: { budik: b } })
      zprava.className = "slabe mala"
      zprava.textContent = !b.zapnuto
        ? t("Uloženo, budíček je vypnutý.")
        : t("Uloženo: {budik}.", { budik: popisBudiku(b) }) + (chuvicky.get(c.chuvicka)?.hlida ? "" : " " + t("Chůvička teď nehlídá — zazvoní, jen když bude hlídat."))
    }
    return {
      prekresli,
      prvek: el(
        "div",
        { style: { display: "grid", gap: "12px" }, "data-budik": "" },
        el("p", {
          class: "slabe mala",
          text: t("Zvoní na chůvičce u dítěte, když hlídá. Začne potichu, za půl minuty hraje nastavenou hlasitostí, nejdéle 15 minut. Vypneš ho tady na kartě nebo u dítěte po odemknutí obrazovky."),
        }),
        el("label", { class: "prepinac" }, zapnuto, t("Budíček zapnutý")),
        el("label", { class: "pole" }, t("Čas"), casPole),
        el("div", { class: "dny", role: "group", "aria-label": t("Dny v týdnu") }, ...DNY.map((d, i) => el("label", {}, dny[i], nazevDne(d)))),
        el(
          "div",
          { class: "mrizka-2" },
          el("button", { type: "button", onclick: () => ((jednou.checked = false), zamkniDny(), nastavDny([1, 2, 3, 4, 5, 6, 7])) }, t("Každý den")),
          el("button", { type: "button", onclick: () => ((jednou.checked = false), zamkniDny(), nastavDny([1, 2, 3, 4, 5])) }, t("Po–Pá")),
        ),
        el("label", { class: "prepinac" }, jednou, t("Jen jednou (po zazvonění se sám vypne)")),
        el("label", { class: "pole" }, t("Písnička"), vyber),
        hlasitostPole,
        el(
          "label",
          { class: "pole", for: "budik-svitani" },
          t("Východ slunce na obrazovce chůvičky"),
          svitaniVyber,
          el("span", {
            class: "slabe mala",
            text: t("Černá obrazovka se před budíčkem postupně rozsvítí do teplé barvy. Jas telefonu u dítěte nech kvůli tomu trochu nad minimem."),
          }),
        ),
        el("button", { class: "hlavni", onclick: uloz }, t("Uložit budíček")),
        zprava,
      ),
    }
  }

  const velikost = (b) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} kB` : `${(b / 1048576).toFixed(1).replace(".", jazyk() === "cs" ? "," : ".")} MB`)

  /** Nahrané zvuky: seznam, přehrání na zkoušku v tomto telefonu, nahrání a smazání. */
  function sekceZvuky() {
    const seznam = el("ul", { class: "zvuky-seznam" })
    const zprava = el("p", { class: "slabe mala", "aria-live": "polite" })
    let ukazka = null // { id, audio, url }
    const zastavUkazku = () => {
      if (!ukazka) return
      ukazka.audio.pause()
      URL.revokeObjectURL(ukazka.url)
      ukazka = null
    }
    async function prehraj(z) {
      const stejny = ukazka?.id === z.id
      zastavUkazku()
      if (stejny) return prekresli()
      try {
        const r = await fetch(`/api/zvuky/${z.id}`, { headers: { "X-Zarizeni": `${zarizeni.id}:${zarizeni.tajemstvi}` } })
        if (!r.ok) throw new Error(t("Zvuk se nepodařilo stáhnout ({kod}).", { kod: r.status }))
        const url = URL.createObjectURL(await r.blob())
        const audio = new Audio(url)
        audio.addEventListener("ended", () => (zastavUkazku(), prekresli()))
        ukazka = { id: z.id, audio, url }
        await audio.play()
      } catch (e) {
        zastavUkazku()
        zprava.className = "chyba mala"
        zprava.textContent = e.name === "NotSupportedError" ? t("Tenhle telefon tento formát neumí přehrát.") : e.message
      }
      prekresli()
    }
    function radek(z) {
      let potvrdit = false
      const smaz = el(
        "button",
        {
          onclick: async () => {
            if (!potvrdit) {
              potvrdit = true
              smaz.textContent = t("Opravdu?")
              smaz.classList.add("nebezpecne")
              return
            }
            if (ukazka?.id === z.id) zastavUkazku()
            try {
              await api(`/api/zvuky/${z.id}/smazat`, zarizeni, {})
              zprava.className = "slabe mala"
              zprava.textContent = t("Smazáno: {nazev}. Budíček s ním hraje vestavěnou ukolébavku.", { nazev: z.nazev })
            } catch (e) {
              zprava.className = "chyba mala"
              zprava.textContent = e.message
            }
          },
        },
        t("Smazat"),
      )
      return el(
        "li",
        { "data-zvuk": z.nazev },
        el("button", { "aria-label": `${ukazka?.id === z.id ? t("Zastavit") : t("Přehrát")} ${z.nazev}`, onclick: () => prehraj(z) }, ukazka?.id === z.id ? "■" : "▶"),
        el("span", { class: "nazev" }, z.nazev, el("span", { class: "slabe mala", text: ` · ${velikost(z.velikost)}` })),
        smaz,
      )
    }
    const prekresli = () =>
      seznam.replaceChildren(...(zvuky.length ? zvuky.map(radek) : [el("li", { class: "slabe", text: t("Zatím žádný nahraný zvuk.") })]))
    const tlacitko = el("button", { onclick: () => vstup.click() }, t("Nahrát zvuk…"))
    const vstup = el("input", {
      type: "file",
      accept: "audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac",
      hidden: true,
      "aria-label": t("Zvukový soubor"),
      onchange: async () => {
        const f = vstup.files[0]
        if (!f) return
        if (f.size > MAX_ZVUK_MB * 1048576) {
          zprava.className = "chyba mala"
          zprava.textContent = t("Soubor je větší než {mb} MB.", { mb: MAX_ZVUK_MB })
          vstup.value = ""
          return
        }
        const nazev = f.name.replace(/\.[^.]+$/, "").slice(0, 60) || t("Zvuk")
        tlacitko.disabled = true
        zprava.className = "slabe mala"
        zprava.textContent = t("Nahrávám {nazev}…", { nazev })
        try {
          const r = await fetch("/api/zvuky", {
            method: "POST",
            headers: {
              "Content-Type": f.type || "application/octet-stream",
              "X-Nazev": encodeURIComponent(nazev),
              "X-Zarizeni": `${zarizeni.id}:${zarizeni.tajemstvi}`,
              "X-Jazyk": jazyk(),
            },
            body: f,
          })
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.chyba ?? t("Chyba {kod}", { kod: r.status }))
          zprava.textContent = t("Nahráno: {nazev}. Najdeš ho v ukolébavce i v budíčku.", { nazev: d.zvuk.nazev })
          await nactiZvuky()
        } catch (e) {
          zprava.className = "chyba mala"
          zprava.textContent = e.message
        } finally {
          tlacitko.disabled = false
          vstup.value = ""
        }
      },
    })
    prekresli()
    return {
      prekresli,
      zastavUkazku,
      prvek: el(
        "div",
        { style: { display: "grid", gap: "12px" }, "data-vlastni-zvuky": "" },
        el("p", {
          class: "slabe mala",
          text: t("Ukolébavky a písničky k buzení. Uvidí je všechny telefony s Chůvičkou. mp3, m4a, wav nebo ogg, nejvýš {mb} MB.", { mb: MAX_ZVUK_MB }),
        }),
        seznam,
        vstup,
        tlacitko,
        zprava,
      ),
    }
  }

  async function oknoHistorie(c) {
    const platno = el("canvas", { class: "graf", width: 640, height: 220, "aria-label": t("Hlasitost za posledních 24 hodin") })
    const rozsah = el("span", { class: "slabe mala", "aria-live": "polite" })
    const volby = el("div", { class: "rozsah-grafu", role: "group", "aria-label": t("Zobrazený úsek") })
    const seznam = el("ul", { class: "udalosti" })
    const souhrn = el("p", { class: "souhrn" })
    const o = okno(
      el("h2", { text: t("Posledních 24 hodin") }),
      el("div", { class: "radek mezi" }, rozsah, volby),
      platno,
      el("p", { class: "slabe mala", text: t("Roztáhni nebo stáhni dvěma prsty, posouvej tažením. Dvojí klepnutí vrátí posledních 12 hodin.") }),
      el(
        "p",
        { class: "slabe mala" },
        t("Šedá: nejhlasitější zvuk v každé minutě. Žlutá a červená čára: prahy, jak v danou chvíli platily. Tečky: upozornění. Zelená: baterie chůvičky (přerušovaná = nabíjí se). Červený pruh dole: bez spojení nebo bez zvuku."),
      ),
      souhrn,
      seznam,
      el("button", { onclick: () => o.remove() }, t("Zavřít")),
    )
    try {
      const h = await api(`/api/historie?chuvicka=${encodeURIComponent(c.chuvicka)}&hodin=${HODIN_HISTORIE}`, zarizeni)
      grafSPosunem(platno, h, c, { rozsah, volby })
      souhrn.replaceChildren(...souhrnNoci(h, c))
      // Změny citlivosti v okně patří do seznamu — vysvětlují schody v grafu.
      const zmeny = (h.prahy ?? [])
        .filter((p) => p.kdy >= h.od)
        .map((p) => ({ kdy: p.kdy, druh: "citlivost", text: t("Citlivost: ozývá se {ozyva}, pláče {place}", { ozyva: p.prahOzyva, place: p.prahPlace }) }))
      const posledni = [...h.udalosti, ...zmeny].sort((a, b) => b.kdy - a.kdy).slice(0, 40)
      seznam.replaceChildren(
        ...(posledni.length
          ? posledni.map((u) =>
              el(
                "li",
                { class: `u-${u.druh}` },
                el("time", { text: cas(u.kdy) }),
                el("span", { text: u.text ?? radekUdalosti(u) }),
              ),
            )
          : [el("li", { class: "slabe", text: t("Klidná noc — žádné upozornění.") })]),
      )
    } catch (e) {
      seznam.replaceChildren(el("li", { class: "chyba", text: e.message }))
    }
  }

  /**
   * Výpadky spojení z událostí: „offline" se zapíše minutu po ztrátě
   * signálu, konec je „online", nebo první další hladina (restart serveru
   * „online" nezapíše), jinak trvá.
   */
  function vypadky(h, c) {
    // Začátek se zapíše až po limitu (spojení 60 s, zvuk 45 s) — o ten
    // se pruh posune zpátky. Konec je párová událost, nebo první další
    // hladina (restart serveru párovou událost nezapíše).
    const PARY = {
      offline: { konec: "online", posun: 60_000, trva: () => !c.online, druh: "spojení" },
      neslysi: { konec: "slysi", posun: 45_000, trva: () => c.online && c.neslysi, druh: "zvuk" },
    }
    const vysledek = []
    for (const [i, u] of h.udalosti.entries()) {
      const par = PARY[u.druh]
      if (!par) continue
      const zpet = h.udalosti.slice(i + 1).find((x) => x.druh === par.konec)?.kdy
      const hladina = h.hladiny.find((r) => r.minuta * 60000 > u.kdy)?.minuta * 60000
      const konec = Math.min(zpet ?? Infinity, hladina ?? Infinity)
      vysledek.push({
        od: u.kdy - par.posun,
        do: Number.isFinite(konec) ? konec : par.trva() ? Date.now() : u.kdy,
        druh: par.druh,
      })
    }
    return vysledek
  }

  function souhrnNoci(h, c) {
    const s = h.hladiny.filter((r) => r.baterie !== null && r.baterie !== undefined)
    const pct = (b) => `${Math.round(b * 100)} %`
    const baterie = s.length
      ? t("Baterie {od} → {do}", { od: pct(s[0].baterie), do: pct(s.at(-1).baterie) }) + (s.at(-1).nabiji ? ` (${t("nabíjí se")})` : "")
      : t("Baterie: telefon ji neposílá")
    const v = vypadky(h, c)
    const minut = Math.round(v.reduce((a, x) => a + (x.do - x.od), 0) / 60000)
    const kolik = (druh) => v.filter((x) => x.druh === druh).length
    const spojeni = v.length
      ? t("Výpadky: {co}, celkem {minut} min", {
          co: [kolik("spojení") && t("spojení {n}×", { n: kolik("spojení") }), kolik("zvuk") && t("zvuk {n}×", { n: kolik("zvuk") })].filter(Boolean).join(", "),
          minut,
        })
      : t("Spojení i zvuk bez výpadku")
    return [...radkySpanku(h), el("span", { text: baterie }), el("span", { class: v.length ? "u-place" : "", text: spojeni })]
  }

  /** Spánkový souhrn posledního hlídání (`spanek.js`). */
  function radkySpanku(h) {
    const s = souhrnSpanku(h.udalosti, Date.now())
    if (!s) return []
    const hlidani = s.probiha
      ? t("Hlídá od {od} ({delka})", { od: cas(s.od), delka: delka(s.do - s.od) })
      : t("Hlídání {od}–{do} ({delka})", { od: cas(s.od), do: cas(s.do), delka: delka(s.do - s.od) })
    const probuzeni = !s.probuzeni
      ? t("Bez probuzení")
      : t("Probuzení: {n}×", { n: s.probuzeni }) + (s.sPlacem ? ", " + t("z toho s pláčem {n}×", { n: s.sPlacem }) : "")
    const klid = [
      s.klidOd ? t("klid od {cas}", { cas: cas(s.klidOd) }) : null,
      s.nejdelsiKlid
        ? t("nejdelší klid {delka} ({od}–{do})", {
            delka: delka(s.nejdelsiKlid.do - s.nejdelsiKlid.od),
            od: cas(s.nejdelsiKlid.od),
            do: cas(s.nejdelsiKlid.do),
          })
        : null,
    ].filter(Boolean)
    return [
      el("strong", { text: hlidani }),
      el("span", { class: "plny", text: [probuzeni, ...klid].join(" · ") }),
    ]
  }

  /**
   * Graf historie: roztažení dvěma prsty (nebo kolečkem myši) a posun
   * tažením, nejvýš 24 hodin zpátky. Výchozí pohled: posledních 12 hodin.
   */
  function grafSPosunem(platno, h, c, { rozsah, volby }) {
    const NEJKRATSI = 15 * 60_000
    const VYCHOZI = 12 * 3600_000
    const konec = () => Date.now()
    /** Úsek oříznutý do načtených dat a rozumné délky. */
    const omez = (od, do_) => {
      const delka = Math.min(Math.max(do_ - od, NEJKRATSI), konec() - h.od)
      const zacatek = Math.max(h.od, Math.min(od, konec() - delka))
      return { od: zacatek, do: zacatek + delka }
    }
    let pohled = omez(konec() - VYCHOZI, konec())
    const tlacitka = [1, 3, 12, 24].map((hod) =>
      el("button", { type: "button", class: "mala", onclick: () => nastav(omez(konec() - hod * 3600_000, konec())) }, `${hod} h`),
    )
    volby.replaceChildren(...tlacitka)
    const popis = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? cas(ms) : `${datum(ms)} ${cas(ms)}`)
    function kresli() {
      kresliGraf(platno, h, c.nastaveni, c, pohled)
      rozsah.textContent = `${popis(pohled.od)} – ${popis(pohled.do)}`
      const delka = pohled.do - pohled.od
      tlacitka.forEach((b, i) => b.setAttribute("aria-pressed", String(Math.abs(delka - [1, 3, 12, 24][i] * 3600_000) < 60_000 && konec() - pohled.do < 60_000)))
    }
    const nastav = (p) => {
      pohled = p
      kresli()
    }
    const sirka = () => platno.getBoundingClientRect()
    /** Čas pod bodem obrazovky (x v pixelech okna). */
    const casNa = (x, p = pohled) => {
      const r = sirka()
      return p.od + ((x - r.left) / r.width) * (p.do - p.od)
    }

    // Tažení jedním prstem posouvá, dvěma roztahuje. Výchozí bod se
    // přepočítá při každém přidání a zvednutí prstu.
    const prsty = new Map()
    let start = null
    const zacni = () => (start = { pohled: { ...pohled }, prsty: new Map(prsty) })
    platno.addEventListener("pointerdown", (e) => {
      try {
        platno.setPointerCapture(e.pointerId)
      } catch {}
      prsty.set(e.pointerId, e.clientX)
      zacni()
    })
    platno.addEventListener("pointermove", (e) => {
      if (!prsty.has(e.pointerId) || !start) return
      prsty.set(e.pointerId, e.clientX)
      const r = sirka()
      const delka0 = start.pohled.do - start.pohled.od
      if (prsty.size === 1) {
        const posun = ((e.clientX - start.prsty.get(e.pointerId)) / r.width) * delka0
        nastav(omez(start.pohled.od - posun, start.pohled.do - posun))
        return
      }
      const [a, b] = [...prsty.keys()]
      if (!start.prsty.has(a) || !start.prsty.has(b)) return
      const vzdalenost0 = Math.abs(start.prsty.get(a) - start.prsty.get(b))
      const vzdalenost = Math.abs(prsty.get(a) - prsty.get(b))
      if (vzdalenost0 < 10 || vzdalenost < 10) return
      // Čas pod středem prstů zůstává pod středem prstů.
      const stred0 = casNa((start.prsty.get(a) + start.prsty.get(b)) / 2, start.pohled)
      const delka = (delka0 * vzdalenost0) / vzdalenost
      const k = ((prsty.get(a) + prsty.get(b)) / 2 - r.left) / r.width
      nastav(omez(stred0 - k * delka, stred0 - k * delka + delka))
    })
    const pustit = (e) => {
      prsty.delete(e.pointerId)
      zacni()
    }
    platno.addEventListener("pointerup", pustit)
    platno.addEventListener("pointercancel", pustit)
    platno.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault()
        const kolem = casNa(e.clientX)
        const f = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.002)))
        nastav(omez(kolem - (kolem - pohled.od) * f, kolem + (pohled.do - kolem) * f))
      },
      { passive: false },
    )
    platno.addEventListener("dblclick", () => nastav(omez(konec() - VYCHOZI, konec())))
    kresli()
  }

  /** Popisky osy: krok, při kterém jsou od sebe aspoň 48 px. */
  const KROKY_MIN = [5, 10, 15, 30, 60, 120, 180, 360]

  function kresliGraf(platno, h, n, c, pohled) {
    const dpr = devicePixelRatio || 1
    const sirka = platno.clientWidth || 320
    const vyska = platno.clientHeight || 160
    platno.width = sirka * dpr
    platno.height = vyska * dpr
    const g = platno.getContext("2d")
    g.scale(dpr, dpr)
    const styl = getComputedStyle(document.documentElement)
    const barva = (v) => styl.getPropertyValue(v).trim()
    const { od, do: doKdy } = pohled
    const x = (t) => ((t - od) / (doKdy - od)) * sirka
    const y = (v) => vyska - 14 - (v / 100) * (vyska - 22)
    // Osa času: krok podle přiblížení, zarovnaný na místní hodiny.
    g.fillStyle = barva("--slabe")
    g.font = "11px system-ui"
    g.strokeStyle = barva("--okraj")
    g.lineWidth = 1
    const krokMin = KROKY_MIN.find((m) => ((m * 60_000) / (doKdy - od)) * sirka >= 48) ?? 720
    const znacka = new Date(od)
    znacka.setMinutes(0, 0, 0)
    if (krokMin >= 60) znacka.setHours(Math.floor(znacka.getHours() / (krokMin / 60)) * (krokMin / 60))
    for (let okamzik = znacka.getTime(); okamzik < doKdy; okamzik += krokMin * 60_000) {
      if (okamzik < od) continue
      const xx = Math.round(x(okamzik)) + 0.5
      g.beginPath()
      g.moveTo(xx, 0)
      g.lineTo(xx, vyska - 14)
      g.stroke()
      const d = new Date(okamzik)
      g.fillText(krokMin >= 60 ? String(d.getHours()) : `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`, xx + 2, vyska - 2)
    }
    // Co je mimo úsek, se ořízne.
    g.save()
    g.beginPath()
    g.rect(0, 0, sirka, vyska)
    g.clip()
    // Hladiny.
    g.fillStyle = "#59607a"
    const sloupec = Math.max(1, (60_000 / (doKdy - od)) * sirka)
    for (const r of h.hladiny) {
      const okamzik = r.minuta * 60000
      if (okamzik >= od - 60_000 && okamzik <= doKdy) g.fillRect(x(okamzik), y(r.max), sloupec, vyska - 14 - y(r.max))
    }
    // Prahy jako schody — co v kterou chvíli platilo (citlivost se během
    // noci mohla měnit).
    const prahy = h.prahy?.length ? h.prahy : [{ kdy: 0, prahOzyva: n.prahOzyva, prahPlace: n.prahPlace }]
    for (const [klic, b] of [["prahOzyva", "--ozyva"], ["prahPlace", "--place"]]) {
      g.strokeStyle = barva(b)
      g.lineWidth = 2
      g.setLineDash([6, 4])
      g.beginPath()
      prahy.forEach((p, i) => {
        const x0 = Math.max(0, x(Math.max(p.kdy, od)))
        const x1 = i + 1 < prahy.length ? x(prahy[i + 1].kdy) : sirka
        if (i === 0) g.moveTo(x0, y(p[klic]))
        else g.lineTo(x0, y(p[klic]))
        g.lineTo(x1, y(p[klic]))
      })
      g.stroke()
    }
    g.setLineDash([])
    // Baterie na stejné stupnici 0–100. Úseky se stejným nabíjením jako
    // jedna čára (po minutách by se čárkování pokaždé začalo znovu);
    // mezera delší než 5 min čáru přeruší.
    g.strokeStyle = barva("--ok")
    g.lineWidth = 1.5
    const body = h.hladiny.filter((r) => r.baterie !== null && r.baterie !== undefined)
    const useky = []
    for (const [i, r] of body.entries()) {
      const pred = body[i - 1]
      const navazuje = pred && r.minuta - pred.minuta <= 5
      const u = useky.at(-1)
      if (navazuje && u && Boolean(u.nabiji) === Boolean(r.nabiji)) u.body.push(r)
      else useky.push({ nabiji: r.nabiji, body: navazuje ? [pred, r] : [r] })
    }
    for (const u of useky) {
      if (u.body.length < 2) continue
      g.setLineDash(u.nabiji ? [4, 3] : [])
      g.beginPath()
      u.body.forEach((r, i) => g[i ? "lineTo" : "moveTo"](x(r.minuta * 60000), y(r.baterie * 100)))
      g.stroke()
    }
    g.setLineDash([])
    // Výpadky spojení: pruh nad osou hodin.
    g.fillStyle = barva("--place")
    for (const v of vypadky(h, c)) {
      const x0 = Math.max(0, x(v.od))
      g.fillRect(x0, vyska - 18, Math.max(2, x(v.do) - x0), 4)
    }
    // Události.
    for (const u of h.udalosti) {
      if (u.druh !== "ozyva" && u.druh !== "place") continue
      g.fillStyle = barva(u.druh === "place" ? "--place" : "--ozyva")
      g.beginPath()
      g.arc(x(u.kdy), 8, 4, 0, Math.PI * 2)
      g.fill()
    }
    g.restore()
  }

  function oknoPridat() {
    const video = el("video", { class: "skener", playsinline: true, muted: true })
    const zprava = el("p", { class: "slabe" })
    const pole = el("input", { type: "text", maxlength: 6, placeholder: t("KÓD"), "aria-label": t("Kód z chůvičky"), style: { textTransform: "uppercase", letterSpacing: "0.2em", textAlign: "center", fontSize: "1.3rem" } })
    let zastavKameru = null
    const o = okno(
      el("h2", { text: t("Přidat chůvičku") }),
      el("p", { class: "slabe", text: t("Na telefonu u dítěte zvol Spárovat telefon rodiče a namiř fotoaparát na QR kód.") }),
      video,
      zprava,
      el("div", { class: "mrizka-2" }, pole, el("button", { class: "hlavni", onclick: () => sparuj(pole.value) }, t("Spárovat kódem"))),
      el("button", { onclick: () => (zastavKameru?.(), o.remove()) }, t("Zrušit")),
    )
    skenuj(video, (kod) => sparuj(kod))
      .then((z) => (zastavKameru = z))
      .catch(() => {
        video.remove()
        zprava.textContent = t("Fotoaparát není dostupný — opiš kód z chůvičky.")
      })
    async function sparuj(kod) {
      try {
        const r = await api("/api/sparovat", zarizeni, { kod })
        zastavKameru?.()
        o.remove()
        vybrana = r.chuvicka.id
        vykresli()
      } catch (e) {
        zprava.textContent = e.message
        zprava.className = "chyba"
      }
    }
  }

  // ─── Přehled ────────────────────────────────────────────────────────

  const seznamUdalosti = el("ul", { class: "udalosti" })
  /** Událost do seznamu — bez dvojic (živá i načtená z historie). */
  function pridejUdalost(u) {
    const stejna = udalosti.some((x) => x.chuvicka === u.chuvicka && x.druh === u.druh && Math.abs(x.kdy - u.kdy) < 2000)
    if (stejna) return
    udalosti.push(u)
    udalosti.sort((a, b) => b.kdy - a.kdy)
    udalosti.length = Math.min(udalosti.length, 60)
  }

  async function nactiUdalosti(chuvickaId) {
    try {
      const h = await api(`/api/historie?chuvicka=${encodeURIComponent(chuvickaId)}&hodin=12`, zarizeni)
      for (const u of h.udalosti) pridejUdalost({ ...u, chuvicka: chuvickaId })
      vykresliUdalosti()
    } catch {}
  }

  function kdy(ms) {
    const d = new Date(ms)
    return d.toDateString() === new Date().toDateString() ? cas(ms) : `${datum(ms)} ${cas(ms)}`
  }

  function vykresliUdalosti() {
    const moje = udalosti.filter((u) => u.chuvicka === vybrana).slice(0, 8)
    seznamUdalosti.replaceChildren(
      ...(moje.length
        ? moje.map((u) =>
            el(
              "li",
              { class: `u-${u.druh}` },
              el("time", { text: kdy(u.kdy) }),
              el("span", { text: radekUdalosti(u) }),
            ),
          )
        : [el("li", { class: "slabe", text: t("Za posledních 12 hodin nic.") })]),
    )
  }

  function stavStitek(c) {
    const kdy = c.naposledy ? ` · ${predChvili(c.naposledy)}` : ""
    // Hlídání ukončil někdo u dítěte — žádný poplach, jen informace.
    if (c.ukonceno)
      return el("span", {
        class: "stitek pozor",
        text: `${c.ukoncenoRodicem ? t("Hlídání ukončeno z telefonu rodiče") : t("Hlídání ukončeno u dítěte")}${c.online ? "" : kdy}`,
      })
    if (!c.online) return el("span", { class: "stitek spatne", text: `${t("Bez spojení")}${kdy}` })
    if (!c.hlida) return el("span", { class: "stitek pozor", text: t("Připojená, nehlídá") })
    if (c.neslysi) return el("span", { class: "stitek spatne", text: t("Neslyší — mikrofon stojí") })
    return el("span", { class: "stitek ok", text: t("Hlídá") })
  }

  let mluvTl = null
  function vykresli() {
    if (drziMluvit) {
      vykreslitPoPusteni = true
      return
    }
    vykreslitPoPusteni = false
    const c = vybrana ? chuvicky.get(vybrana) : null
    const upozorneniOk = "Notification" in window && Notification.permission === "granted"
    if (!c) {
      obrazovka(
        el("header", { class: "radek mezi" }, nazevAplikace(), el("span", { class: "stitek ok", text: t("rodič") })),
        el("section", { class: "karta" }, el("h2", { text: t("Zatím žádná chůvička") }), el("p", { class: "slabe", text: t("Na telefonu u dítěte otevři Chůvičku a zvol, že bude u dítěte. Pak ji tady přidej přes QR kód.") }), el("button", { class: "hlavni", onclick: oknoPridat }, t("Přidat chůvičku"))),
        upozorneniOk ? null : el("button", { onclick: (e) => zapniUpozorneni(e.currentTarget).catch((err) => info(t("Nepovedlo se"), err.message)) }, t("Zapnout upozornění")),
        volbaJazyka(),
        el("button", { class: "odkaz", onclick: zrusit }, t("Zrušit spojení")),
      )
      return
    }
    meric.prahy(c.prahy ?? c.nastaveni)
    const zvednuto = c.prahy && c.prahy.prahOzyva > c.nastaveni.prahOzyva
    const pozastaveno = c.nastaveni.pozastavenoDo > Date.now()
    mluvTl = el("button", { class: "mluvit", disabled: !c.online }, t("Mluvit (podrž)"))
    const tl = mluvTl
    tl.addEventListener("pointerdown", (e) => {
      e.preventDefault()
      // Klepnutí ukončí mluvení, které zůstalo po zrušeném stisku.
      if (zamceneMluveni) return prestanMluvit(tl)
      try {
        tl.setPointerCapture(e.pointerId)
      } catch {}
      drziMluvit = true
      zacniMluvit(tl)
    })
    tl.addEventListener("pointerup", () => {
      if (drziMluvit && !zamceneMluveni) prestanMluvit(tl)
    })
    tl.addEventListener("pointercancel", () => zamkniMluveni(tl, "pointercancel"))
    tl.addEventListener("contextmenu", (e) => e.preventDefault())
    obrazovka(
      el(
        "header",
        { class: "radek mezi" },
        nazevAplikace(c.nazev),
        chuvicky.size > 1
          ? el("select", { "aria-label": t("Chůvička"), onchange: (e) => ((vybrana = e.target.value), vykresli()) }, ...[...chuvicky.values()].map((x) => el("option", { value: x.chuvicka, text: x.nazev, selected: x.chuvicka === vybrana })))
          : null,
      ),
      el(
        "div",
        { class: "radek" },
        stavStitek(c),
        c.baterie !== null ? el("span", { class: `stitek ${c.baterie < 0.2 && !c.nabiji ? "spatne" : "ok"}`, text: `${Math.round(c.baterie * 100)} %${c.nabiji ? " ⚡" : ""}` }) : null,
        pozastaveno ? el("span", { class: "stitek pozor", text: t("Pozastaveno do {cas}", { cas: cas(c.nastaveni.pozastavenoDo) }) }) : null,
        c.budik
          ? el("span", { class: "stitek pozor", text: t("Budíček zvoní") })
          : c.nastaveni.budik?.zapnuto
            ? el("span", { class: "stitek", title: t("Budíček na chůvičce"), text: t("Budíček {budik}", { budik: popisBudiku(c.nastaveni.budik) }) })
            : null,
        zvednuto && !c.ukolebavka && !c.budik
          ? el("span", {
              class: "stitek",
              title: t("Chůvička slyší stálý šum (ventilátor, čistička) a prahy zvedla nad něj."),
              text: t("Prahy nad šumem +{n}", { n: c.prahy.prahOzyva - c.nastaveni.prahOzyva }),
            })
          : null,
        online ? null : el("span", { class: "stitek spatne", text: t("Telefon bez internetu") }),
      ),
      c.budik
        ? el("button", { class: "hlavni velke", onclick: () => spojeni.posli({ typ: "budikVypnout", chuvicka: c.chuvicka }) }, t("Vypnout budíček"))
        : null,
      el("section", { class: "karta" }, meric.prvek, el("p", { class: "slabe mala", text: t("Žlutá čára: ozývá se, červená: pláče.") })),
      el(
        "div",
        { class: "mrizka-2" },
        el("button", { class: `velke ${poslech ? "aktivni" : ""}`, disabled: !c.online && !poslech, onclick: prepniPoslech }, poslech ? t("Poslouchám ■") : t("Poslouchat")),
        mluvTl,
        el("button", { disabled: !c.online, onclick: () => oknoUkolebavka(c) }, c.ukolebavka ? t("Ukolébavka hraje") : t("Ukolébavka")),
        el("button", { onclick: () => oknoPozastavit(c) }, pozastaveno ? t("Pozastaveno") : t("Pozastavit / ukončit")),
        el("button", { disabled: !c.online, onclick: () => oknoFotky(c) }, t("Fotka")),
        el("button", { onclick: () => oknoHistorie(c) }, t("Historie noci")),
        el("button", { class: "cely", onclick: () => oknoNastaveni(c) }, t("Nastavení")),
      ),
      "wakeLock" in navigator
        ? el(
            "button",
            { class: svitit ? "aktivni" : "", "aria-pressed": String(svitit), onclick: prepniSviceni },
            svitit ? t("Obrazovka nezhasne ■") : t("Nezhasínat obrazovku"),
          )
        : null,
      svitit
        ? el("p", {
            class: "slabe mala",
            text: zamekObrazovky
              ? t("Telefon nezhasne ani se nezamkne, dokud je Chůvička otevřená. Bere to víc baterie, dej ho na nabíječku.")
              : t("Telefon to teď nedovolil (třeba úsporný režim). Zkusí se to znovu po návratu do aplikace."),
          })
        : null,
      el("section", { class: "karta" }, el("h2", { text: t("Poslední události") }), seznamUdalosti),
      upozorneniOk
        ? null
        : el("section", { class: "karta" }, el("h2", { text: t("Upozornění jsou vypnutá") }), el("p", { class: "slabe", text: t("Bez nich se o pláči dozvíš, jen když máš aplikaci otevřenou.") }), el("button", { class: "hlavni", onclick: (e) => zapniUpozorneni(e.currentTarget).catch((err) => info(t("Nepovedlo se"), err.message)) }, t("Zapnout upozornění"))),
      el("div", { class: "radek mezi" }, el("button", { class: "odkaz", onclick: oknoPridat }, t("Přidat další chůvičku")), el("button", { class: "odkaz", onclick: zrusit }, t("Zrušit spojení"))),
    )
    vykresliUdalosti()
  }

  function zrusit() {
    const o = okno(
      el("h2", { text: t("Zrušit spojení?") }),
      el("p", { text: t("Tenhle telefon se odpáruje od všech chůviček a přestanou chodit upozornění. Chůvička, ke které už nebude spárovaný žádný jiný telefon, se zruší taky.") }),
      el("div", { class: "mrizka-2" }, el("button", { onclick: () => o.remove() }, t("Ne")), el("button", { class: "hlavni", onclick: async () => (await api("/api/zrusit", zarizeni, {}).catch(() => {}), o.remove(), zruseno()) }, t("Zrušit"))),
    )
  }

  function zruseno() {
    spojeni.zavri()
    vysilacka?.mic.zastav()
    naZruseni()
  }

  vykresli()
  drzSviceni()
  if (kodKParovani) {
    api("/api/sparovat", zarizeni, { kod: kodKParovani })
      .then((r) => {
        vybrana = r.chuvicka.id
        vykresli()
      })
      .catch((e) => info(t("Spárování se nepovedlo"), e.message))
  }
}

function base64NaBajty(b64) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}
