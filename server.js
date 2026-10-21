import http from "node:http"
import { readFile, writeFile, unlink } from "node:fs/promises"
import { readFileSync, mkdirSync, createReadStream } from "node:fs"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { dirname, extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer } from "ws"
import webpush from "web-push"
import QRCode from "qrcode"
import { otevriDb } from "./lib/db.js"
import { srovnejNastaveni } from "./public/js/detekce.js"
import { idSouboru } from "./public/js/budik.js"
import { prelozit, platnyJazyk, JAZYKY } from "./public/js/i18n.js"
import { PLATNOST_MS as PLATNOST_FOTKY } from "./public/js/fotka.js"

/**
 * Chůvička — server.
 *
 * Telefon u dítěte (chůvička) posílá po WebSocketu hladinu hluku a
 * události, při příposlechu zvuk; server je rozesílá spárovaným
 * rodičům a při události jim pošle push notifikaci. Rodič posílá
 * zpátky nastavení (i budíček), pozastavení, ukolébavku a svůj hlas.
 *
 * Bez účtů a bez přihlášení: zařízení se registruje samo a páruje se
 * jednorázovým kódem z QR. Zvuk z mikrofonu se nikam neukládá; ukládají
 * se jen soubory, které rodič sám nahraje (ukolébavky, budíčky).
 */

const KOREN = fileURLToPath(new URL(".", import.meta.url))
const VEREJNE = join(KOREN, "public")
const PORT = Number(process.env.PORT ?? 8080)
/** Verze z package.json — ukazuje ji aplikace, ať jde poznat, co běží. */
const VERZE = JSON.parse(readFileSync(join(KOREN, "package.json"), "utf8")).version
const SOUBOR_DB = process.env.DB ?? join(KOREN, "data", "chuvicka.db")
const db = otevriDb(SOUBOR_DB)
/** Nahrané zvuky leží vedle databáze (ve volume `data`). */
const ADR_ZVUKY = process.env.ZVUKY ?? join(dirname(SOUBOR_DB), "zvuky")
mkdirSync(ADR_ZVUKY, { recursive: true })
const MAX_ZVUK = (Number(process.env.CHUVICKA_MAX_ZVUK_MB) || 20) * 1024 * 1024
/** Všechny nahrané zvuky dohromady — ať cizí zařízení nezaplní disk. */
const MAX_ZVUKY_CELKEM = (Number(process.env.CHUVICKA_MAX_ZVUKY_MB) || 200) * 1024 * 1024
/**
 * Hlavička s adresou klienta od reverzní proxy (třeba `cf-connecting-ip`
 * za Cloudflare, `x-real-ip` za nginx). Bez ní se bere adresa spojení —
 * hlavičce od klienta bez proxy věřit nejde (obešel by limit pokusů).
 */
const IP_HLAVICKA = (process.env.CHUVICKA_IP_HLAVICKA ?? "").trim().toLowerCase()
/**
 * Heslo pro přidání nového telefonu. Bez něj si telefon zaregistruje
 * každý, kdo zná adresu serveru (k chůvičce se tím ale nedostane —
 * párování chce jednorázový kód). Telefon rodiče s platným kódem z QR
 * heslo nepotřebuje: kód sám dokazuje, že ho pustila chůvička.
 */
const HESLO = process.env.CHUVICKA_HESLO ?? ""
const otisk = (s) => createHash("sha256").update(String(s)).digest()
const spravneHeslo = (s) => typeof s === "string" && timingSafeEqual(otisk(s), otisk(HESLO))

const VAPID = {
  verejny: process.env.VAPID_PUBLIC_KEY ?? "",
  soukromy: process.env.VAPID_PRIVATE_KEY ?? "",
  // Kontakt pro push služby (mailto: nebo https:) — Apple bez platného odmítá.
  kontakt: process.env.VAPID_SUBJECT ?? "",
}
const pushPripraven = Boolean(VAPID.verejny && VAPID.soukromy && VAPID.kontakt)
if (pushPripraven) webpush.setVapidDetails(VAPID.kontakt, VAPID.verejny, VAPID.soukromy)
else console.warn("Chybí VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY nebo VAPID_SUBJECT — push notifikace se nebudou posílat.")

// ─── Push ───────────────────────────────────────────────────────────────

/**
 * Upozornění všem rodičům chůvičky, každému v jazyce jeho telefonu.
 * `zprava(t)` dostane překladač a vrátí { titulek, text, uroven, tag }.
 * `krome` — rodič, kterému se nic neposílá (sám to udělal).
 */
async function oznam(chuvickaId, zprava, { krome = null } = {}) {
  if (!pushPripraven) return
  let odeslano = 0
  let celkem = 0
  let uroven = ""
  for (const rodic of db.rodice(chuvickaId)) {
    if (rodic.id === krome) continue
    const obsah = zprava((s, p) => prelozit(rodic.jazyk, s, p))
    uroven = obsah.uroven
    for (const odber of db.odbery(rodic.id)) {
      celkem++
      try {
        await webpush.sendNotification(odber, JSON.stringify(obsah), { TTL: 120, urgency: "high" })
        odeslano++
      } catch (e) {
        // Prohlížeč odběr zrušil (odinstalovaná aplikace, nové zařízení).
        if (e.statusCode === 404 || e.statusCode === 410) db.smazOdber(odber.endpoint)
        else console.warn(`Push selhal (${e.statusCode ?? "?"}): ${e.message}`)
      }
    }
  }
  // Do logu jen počty — ať jde poznat „nevzniklo" od „nedoručilo se".
  console.log(`push ${uroven} ${chuvickaId.slice(0, 6)}: ${odeslano}/${celkem}`)
}

// ─── Živá spojení ───────────────────────────────────────────────────────

/** Chůvičky online: id → { ws, stav, posluchaci: Set<ws>, mluvi: ws|null, minuta } */
const chuvicky = new Map()
/** Rodiče online: id → Set<ws> */
const rodice = new Map()
/** Kdy chůvička naposledy dala vědět a co se už nahlásilo — pro hlídání spojení. */
const hlidani = new Map()
/**
 * Poslední fotka každé chůvičky: id → { data, kdy }. Jen v paměti a jen
 * pár minut — fotky z pokoje dítěte se nikam neukládají.
 */
const fotky = new Map()
setInterval(() => {
  for (const [id, f] of fotky) if (Date.now() - f.kdy > PLATNOST_FOTKY) fotky.delete(id)
}, 60_000).unref()

function posli(ws, zprava) {
  if (ws.readyState === ws.OPEN) ws.send(typeof zprava === "string" || Buffer.isBuffer(zprava) ? zprava : JSON.stringify(zprava))
}

function rodicumChuvicky(chuvickaId, zprava) {
  const text = JSON.stringify({ ...zprava, chuvicka: chuvickaId })
  for (const r of db.rodice(chuvickaId)) for (const ws of rodice.get(r.id) ?? []) posli(ws, text)
}

/**
 * Zrušení chůvičky: telefon u dítěte se vrátí na začátek (4001), rodičům
 * zmizí ze seznamu. Párování a historie odejdou kaskádou v databázi.
 */
function zrusChuvicku(chuvickaId) {
  for (const r of db.rodice(chuvickaId)) for (const ws of rodice.get(r.id) ?? []) posli(ws, { typ: "odparovano", chuvicka: chuvickaId })
  db.smazZarizeni(chuvickaId)
  hlidani.delete(chuvickaId)
  fotky.delete(chuvickaId)
  chuvicky.get(chuvickaId)?.ws.close(4001, "zrušeno")
}

/** Po odchodu rodiče: chůvička bez rodičů nemá komu hlídat, zruší se taky. */
function poOdparovani(chuvickaId) {
  if (!db.zarizeni(chuvickaId)) return
  if (db.rodice(chuvickaId).length === 0) return zrusChuvicku(chuvickaId)
  const c = chuvicky.get(chuvickaId)
  if (c) posli(c.ws, { typ: "rodice", pocet: db.rodice(chuvickaId).length })
}

function stavChuvicky(chuvickaId) {
  const c = chuvicky.get(chuvickaId)
  const n = db.nastaveni(chuvickaId)
  const z = db.zarizeni(chuvickaId)
  return {
    typ: "stav",
    chuvicka: chuvickaId,
    nazev: z?.nazev ?? "Chůvička",
    online: Boolean(c),
    hlida: c?.stav.hlida ?? false,
    /** Hlídání naposledy někdo ukončil (ne výpadek) — u dítěte, nebo rodič na dálku. */
    ukonceno: !c?.stav.hlida ? (db.posledniHlidani(chuvickaId) ?? "").startsWith("ukonceno") : false,
    ukoncenoRodicem: !c?.stav.hlida && db.posledniHlidani(chuvickaId) === "ukonceno_rodicem",
    /** Hlídá, ale nechodí zvuk (mikrofon stojí). */
    neslysi: c?.neslysi ?? false,
    baterie: c?.stav.baterie ?? null,
    nabiji: c?.stav.nabiji ?? null,
    ukolebavka: c?.stav.ukolebavka ?? null,
    /** Budíček právě zvoní: { od }. Nastavení budíčku je v `nastaveni.budik`. */
    budik: c?.stav.budik ?? null,
    /** Prahy, které teď platí; null = jak v nastavení. */
    prahy: c?.stav.hlida ? (c.stav.prahy ?? null) : null,
    naposledy: hlidani.get(chuvickaId)?.naposledy ?? z?.naposledy ?? null,
    nastaveni: n,
  }
}

const rozesliStav = (chuvickaId) => rodicumChuvicky(chuvickaId, stavChuvicky(chuvickaId))

/** Rodiče, kteří mají aplikaci na obrazovce — chůvička pak hlásí hladinu živě. */
function aktualizujZive(chuvickaId) {
  const c = chuvicky.get(chuvickaId)
  if (!c) return
  const zive = db.rodice(chuvickaId).some((r) => [...(rodice.get(r.id) ?? [])].some((ws) => ws.diva))
  if (zive !== c.zive) {
    c.zive = zive
    posli(c.ws, { typ: "zive", zapnout: zive })
  }
}

function aktualizujPoslech(chuvickaId) {
  const c = chuvicky.get(chuvickaId)
  if (c) posli(c.ws, { typ: "poslech", zapnout: c.posluchaci.size > 0 })
}

function zapisMinutu(chuvickaId, c) {
  if (c.minuta && c.minuta.vzorky.length) {
    const v = c.minuta.vzorky
    db.zapisHladinu(chuvickaId, c.minuta.cislo, Math.max(...v), v.reduce((a, b) => a + b, 0) / v.length, c.stav.baterie, c.stav.nabiji)
  }
}

function zpravaChuvicky(z, c, data) {
  let m
  try {
    m = JSON.parse(data)
  } catch {
    return
  }
  const h = hlidani.get(z.id)
  if (h) h.naposledy = Date.now()

  if (m.typ === "hladina" && Number.isFinite(m.h)) {
    const hladina = Math.max(0, Math.min(100, m.h))
    const cislo = Math.floor(Date.now() / 60000)
    if (c.minuta?.cislo !== cislo) {
      zapisMinutu(z.id, c)
      c.minuta = { cislo, vzorky: [] }
    }
    c.minuta.vzorky.push(hladina)
    // Mrtvý mikrofon posílá digitální ticho (0) — to není slyšení.
    // Skutečná místnost má i v noci kolem 30.
    if (hladina > 2) c.posledniHladina = Date.now()
    if (c.neslysi && hladina > 2) {
      c.neslysi = false
      db.zapisUdalost(z.id, "slysi")
      console.log(`slyší ${z.id.slice(0, 6)}: zvuk zase chodí`)
      oznam(z.id, (t) => ({ titulek: t("Chůvička zase slyší — {nazev}", { nazev: z.nazev }), text: t("Mikrofon se rozběhl, hlídání pokračuje."), uroven: "info", tag: `chuvicka-zvuk-${z.id}` }))
      rozesliStav(z.id)
    }
    rodicumChuvicky(z.id, { typ: "hladina", h: Math.round(hladina) })
  } else if (m.typ === "udalost" && (m.druh === "ozyva" || m.druh === "place")) {
    db.zapisUdalost(z.id, m.druh, Number(m.hladina) || null, Number(m.trvani) || null)
    console.log(`událost ${m.druh} ${z.id.slice(0, 6)}: hladina ${m.hladina}, ${m.trvani} s`)
    rodicumChuvicky(z.id, { typ: "udalost", druh: m.druh, hladina: m.hladina, trvani: m.trvani, kdy: Date.now() })
    if (db.nastaveni(z.id).pozastavenoDo > Date.now()) return
    const place = m.druh === "place"
    const s = Math.round(m.trvani)
    oznam(z.id, (t) => ({
      titulek: place ? t("Pláče — {nazev}", { nazev: z.nazev }) : t("Ozývá se — {nazev}", { nazev: z.nazev }),
      text: place ? t("Hlasitě už {s} s.", { s }) : t("Zvuk {s} s.", { s }),
      uroven: m.druh,
      tag: `chuvicka-${z.id}`,
    }))
  } else if (m.typ === "udalost" && m.druh === "potlaceno") {
    // Rozpoznání pláče: hlasité, ale ne dítě — do historie, bez upozornění.
    db.zapisUdalost(z.id, "potlaceno", Number(m.hladina) || null, Number(m.trvani) || null)
    console.log(`neohlášeno ${z.id.slice(0, 6)}: ${String(m.zvuk ?? "").replace(/[^\p{L} ,]/gu, "").slice(0, 40)}`)
    rodicumChuvicky(z.id, { typ: "udalost", druh: "potlaceno", hladina: m.hladina, trvani: m.trvani, kdy: Date.now() })
  } else if (m.typ === "nastaveni" && m.data && typeof m.data === "object") {
    // Nastavení jde měnit i přímo na chůvičce (kalibrace, posuvníky).
    const n = db.ulozNastaveni(z.id, platnyZvuk(srovnejNastaveni({ ...db.nastaveni(z.id), ...m.data })))
    posli(c.ws, { typ: "nastaveni", data: n })
    rozesliStav(z.id)
  } else if (m.typ === "kalibrace" && ["meri", "hotovo", "nelze"].includes(m.stav)) {
    // Průběh kalibrace spuštěné z telefonu rodiče. Text si skládá telefon
    // rodiče ve svém jazyce; `text` posílá jen starší chůvička.
    const cislo = (v) => (Number.isFinite(v) ? Math.round(v) : undefined)
    rodicumChuvicky(z.id, {
      typ: "kalibrace",
      stav: m.stav,
      zbyva: Number(m.zbyva) || 0,
      duvod: ["budik", "ukolebavka", "mikrofon", "nemeri"].includes(m.duvod) ? m.duvod : undefined,
      ticho: cislo(m.ticho),
      prahOzyva: cislo(m.prahOzyva),
      prahPlace: cislo(m.prahPlace),
      text: m.text === undefined ? undefined : String(m.text).slice(0, 200),
    })
  } else if (m.typ === "fotka" && ["kamera", "povoleni"].includes(m.chyba)) {
    // Fotka nevyšla — rodič se dozví proč.
    rodicumChuvicky(z.id, { typ: "fotka", chyba: m.chyba })
  } else if (m.typ === "prejmenovat" && typeof m.nazev === "string") {
    db.prejmenuj(z.id, m.nazev.trim().slice(0, 40) || "Chůvička")
    z.nazev = db.zarizeni(z.id).nazev
    rozesliStav(z.id)
  } else if (m.typ === "stav") {
    const pred = c.stav
    // Začátek hlídání: zvuk se začne čekat až od teď (ne od připojení).
    if (m.hlida && !pred.hlida) {
      c.posledniHladina = Date.now()
      // Po výpadku se chůvička připojí znovu a hlídá dál — to není nové
      // zahájení, do historie jen jednou.
      if (db.posledniHlidani(z.id) !== "zahajeno") db.zapisUdalost(z.id, "zahajeno")
    }
    // Konec hlídání na telefonu u dítěte (podržení 3 s). Rodič se to dozví
    // jako informaci — a když pak někdo aplikaci zavře, už to není výpadek.
    if (!m.hlida && pred.hlida) {
      // Ukončil rodič na dálku (pokyn „ukoncit"), nebo někdo u dítěte.
      const rodic = c.ukoncujeRodic
      c.ukoncujeRodic = null
      db.zapisUdalost(z.id, rodic ? "ukonceno_rodicem" : "ukonceno")
      oznam(
        z.id,
        (t) => ({
          titulek: t("Hlídání ukončeno — {nazev}", { nazev: z.nazev }),
          text: rodic ? t("Hlídání ukončil rodič ze svého telefonu.") : t("Na telefonu u dítěte někdo ukončil hlídání."),
          uroven: "info",
          tag: `chuvicka-spojeni-${z.id}`,
        }),
        { krome: rodic },
      )
    }
    // Konec hlídání: neslyšící mikrofon už nikoho nezajímá.
    if (!m.hlida) c.neslysi = false
    c.stav = {
      ...pred,
      hlida: Boolean(m.hlida),
      baterie: Number.isFinite(m.baterie) ? m.baterie : pred.baterie,
      nabiji: typeof m.nabiji === "boolean" ? m.nabiji : pred.nabiji,
      ukolebavka: m.ukolebavka ?? null,
      budik: m.budik ?? null,
      // Prahy, které chůvička opravdu používá (zvednuté nad stálý šum).
      prahy:
        m.prahy && Number.isFinite(m.prahy.prahOzyva) && Number.isFinite(m.prahy.prahPlace)
          ? { prahOzyva: Math.round(m.prahy.prahOzyva), prahPlace: Math.round(m.prahy.prahPlace) }
          : null,
    }
    if (c.stav.budik && !pred.budik) {
      db.zapisUdalost(z.id, "budik")
      rodicumChuvicky(z.id, { typ: "udalost", druh: "budik", kdy: Date.now() })
    }
    // Málo baterie bez nabíječky — jednou, znovu až po nabití.
    if (h && c.stav.baterie !== null && c.stav.baterie < 0.2 && c.stav.nabiji === false && !h.baterieHlasena) {
      h.baterieHlasena = true
      db.zapisUdalost(z.id, "baterie", Math.round(c.stav.baterie * 100))
      const procent = Math.round(c.stav.baterie * 100)
      oznam(z.id, (t) => ({
        titulek: t("Chůvička má málo baterie — {nazev}", { nazev: z.nazev }),
        text: t("{procent} %. Připoj ji k nabíječce.", { procent }),
        uroven: "baterie",
        tag: `chuvicka-baterie-${z.id}`,
      }))
    }
    if (h && (c.stav.nabiji || c.stav.baterie > 0.3)) h.baterieHlasena = false
    rozesliStav(z.id)
  }
}

function zpravaRodice(z, ws, data, binarni) {
  if (binarni) {
    // Hlas rodiče do chůvičky, které právě mluví.
    if (ws.mluviDo) {
      const c = chuvicky.get(ws.mluviDo)
      if (c && c.mluvi === ws) posli(c.ws, data)
    }
    return
  }
  let m
  try {
    m = JSON.parse(data)
  } catch {
    return
  }
  if (m.typ === "diag" && typeof m.text === "string") {
    // Co se děje na telefonu rodiče (např. proč skončilo mluvení) — jen do logu.
    console.log(`diag ${z.id.slice(0, 6)}: ${m.text.replace(/[^\p{L}\p{N} .,:;()/_-]/gu, "").slice(0, 120)}`)
    return
  }
  if (m.typ === "divam") {
    ws.diva = Boolean(m.zapnout)
    for (const ch of db.chuvicky(z.id)) aktualizujZive(ch.id)
    return
  }
  const chuvickaId = m.chuvicka
  if (typeof chuvickaId !== "string" || !db.jePar(chuvickaId, z.id)) return
  const c = chuvicky.get(chuvickaId)

  if (m.typ === "poslech") {
    if (!c) return
    if (m.zapnout) {
      // Jeden rodičovský socket poslouchá jednu chůvičku.
      for (const jina of chuvicky.values()) jina.posluchaci.delete(ws)
      c.posluchaci.add(ws)
      ws.poslouchaChuvicku = chuvickaId
    } else {
      c.posluchaci.delete(ws)
      ws.poslouchaChuvicku = null
    }
    aktualizujPoslech(chuvickaId)
  } else if (m.typ === "mluvit") {
    if (!c) return
    if (m.zapnout) {
      c.mluvi = ws
      ws.mluviDo = chuvickaId
      posli(c.ws, { typ: "hlas", zapnout: true })
    } else if (c.mluvi === ws) {
      c.mluvi = null
      ws.mluviDo = null
      posli(c.ws, { typ: "hlas", zapnout: false })
    }
  } else if (m.typ === "nastaveni") {
    const n = db.ulozNastaveni(chuvickaId, platnyZvuk(srovnejNastaveni({ ...db.nastaveni(chuvickaId), ...m.data })))
    if (c) posli(c.ws, { typ: "nastaveni", data: n })
    rozesliStav(chuvickaId)
  } else if (m.typ === "pozastavit") {
    const minut = Math.max(0, Math.min(24 * 60, Number(m.minut) || 0))
    db.pozastav(chuvickaId, minut ? Date.now() + minut * 60000 : 0)
    db.zapisUdalost(chuvickaId, minut ? "pozastaveno" : "obnoveno", null, minut || null)
    rozesliStav(chuvickaId)
  } else if (m.typ === "ukolebavka") {
    if (!c) return
    const vestaveny = ["bily", "ruzovy", "hnedy", "ukolebavka"].includes(m.zvuk)
    const soubor = idSouboru(m.zvuk) && db.zvuk(idSouboru(m.zvuk))
    const zvuk = vestaveny || soubor ? m.zvuk : null
    const minut = Math.max(1, Math.min(120, Number(m.minut) || 20))
    posli(c.ws, { typ: "ukolebavka", zvuk, minut })
  } else if (m.typ === "fotka") {
    // Fotka na vyžádání; nejvýš jednou za 5 s, ať se kamera nezapíná dokola.
    if (!c || Date.now() - (c.fotkaZadana ?? 0) < 5000) return
    c.fotkaZadana = Date.now()
    posli(c.ws, { typ: "fotka", kamera: m.kamera === "predni" ? "predni" : "zadni" })
  } else if (m.typ === "budikVypnout") {
    if (c) posli(c.ws, { typ: "budikVypnout" })
  } else if (m.typ === "kalibrovat") {
    if (c) posli(c.ws, { typ: "kalibrovat" })
  } else if (m.typ === "ukoncit") {
    // Ukončení hlídání z telefonu rodiče. Událost a upozornění vzniknou,
    // až chůvička pošle stav „nehlídá" — tak se zapíše jen skutečný konec.
    if (!c?.stav.hlida) return
    c.ukoncujeRodic = z.id
    posli(c.ws, { typ: "ukoncit" })
  } else if (m.typ === "prejmenovat" && typeof m.nazev === "string") {
    db.prejmenuj(chuvickaId, m.nazev.trim().slice(0, 40) || "Chůvička")
    rozesliStav(chuvickaId)
  }
}

function pripojeno(ws, z) {
  ws.zarizeni = z
  if (z.role === "chuvicka") {
    // Druhé okno téže chůvičky přebírá — starší spojení končí.
    chuvicky.get(z.id)?.ws.close(4000, "nahrazeno")
    const c = {
      ws,
      stav: { hlida: false, baterie: null, nabiji: null, ukolebavka: null, budik: null },
      posluchaci: new Set(),
      mluvi: null,
      minuta: null,
      // Kdy naposledy přišel zvuk — spojení může žít i s mrtvým mikrofonem.
      posledniHladina: Date.now(),
      neslysi: false,
    }
    chuvicky.set(z.id, c)
    const h = hlidani.get(z.id)
    if (h?.offlineHlaseno) {
      db.zapisUdalost(z.id, "online")
      oznam(z.id, (t) => ({ titulek: t("Chůvička je zase připojená — {nazev}", { nazev: z.nazev }), text: t("Hlídání pokračuje."), uroven: "info", tag: `chuvicka-spojeni-${z.id}` }))
    }
    hlidani.set(z.id, { naposledy: Date.now(), offlineOd: null, offlineHlaseno: false, baterieHlasena: h?.baterieHlasena ?? false })
    posli(ws, { typ: "nastaveni", data: db.nastaveni(z.id) })
    posli(ws, { typ: "rodice", pocet: db.rodice(z.id).length })
    c.zive = null
    aktualizujZive(z.id)
    ws.on("message", (data, binarni) => {
      if (binarni) {
        for (const p of c.posluchaci) posli(p, data)
        return
      }
      zpravaChuvicky(z, c, data.toString())
    })
    ws.on("close", () => {
      if (chuvicky.get(z.id)?.ws !== ws) return
      chuvicky.delete(z.id)
      for (const p of c.posluchaci) p.poslouchaChuvicku = null
      // Zrušená chůvička: zapisovat ani hlásit už není komu (a zápis by
      // narazil na cizí klíč).
      if (!db.zarizeni(z.id)) return
      zapisMinutu(z.id, c)
      const hl = hlidani.get(z.id)
      if (hl) {
        hl.offlineOd = Date.now()
        // Poplach „bez spojení" jen když v tu chvíli hlídala. Zavřená
        // aplikace po ukončení hlídání je v pořádku.
        hl.hlidalaPriOdpojeni = c.stav.hlida
      }
      rozesliStav(z.id)
    })
    rozesliStav(z.id)
  } else {
    if (!rodice.has(z.id)) rodice.set(z.id, new Set())
    rodice.get(z.id).add(ws)
    for (const ch of db.chuvicky(z.id)) posli(ws, stavChuvicky(ch.id))
    ws.on("message", (data, binarni) => zpravaRodice(z, ws, binarni ? data : data.toString(), binarni))
    ws.on("close", () => {
      rodice.get(z.id)?.delete(ws)
      for (const ch of db.chuvicky(z.id)) aktualizujZive(ch.id)
      for (const [id, c] of chuvicky) {
        if (c.posluchaci.delete(ws)) aktualizujPoslech(id)
        if (c.mluvi === ws) {
          c.mluvi = null
          posli(c.ws, { typ: "hlas", zapnout: false })
        }
      }
    })
  }
}

/**
 * Hlídání spojení: chůvička posílá hladinu každou sekundu. Když přes
 * minutu nic, je to výpadek (baterie, Wi-Fi, zavřená aplikace) — rodiče
 * to musí vědět, jinak by ticho mohlo znamenat i nefunkčnost.
 */
const LIMIT_TICHA = Number(process.env.CHUVICKA_LIMIT_SPOJENI_MS) || 60_000
/**
 * Chůvička hlídá, spojení žije, ale nechodí zvuk. Stalo se 7. 10. 2026:
 * v telefonu se zastavilo zpracování zvuku (nejspíš budík nebo jiná
 * aplikace vzala mikrofon), stránka dál posílala stav baterie, a tak
 * server skoro dvě hodiny hlásil „hlídá". Hladina chodí nejméně jednou
 * za 10 s; 45 s bez ní znamená, že chůvička neslyší.
 */
const LIMIT_ZVUKU = Number(process.env.CHUVICKA_LIMIT_ZVUKU_MS) || 45_000
const KONTROLA = Number(process.env.CHUVICKA_KONTROLA_MS) || 10_000
setInterval(() => {
  const ted = Date.now()
  for (const [id, h] of hlidani) {
    const c = chuvicky.get(id)
    // Spojení visí, ale nic nechodí — uzavřít, ať se počítá jako výpadek.
    // Hladina chodí nejméně jednou za 10 s (bez rodiče u obrazovky).
    if (c && ted - h.naposledy > 45_000) c.ws.terminate()
    if (c && c.stav.hlida && !c.neslysi && ted - c.posledniHladina > LIMIT_ZVUKU) {
      const z = db.zarizeni(id)
      if (z) {
        c.neslysi = true
        db.zapisUdalost(id, "neslysi")
        console.log(`neslyší ${id.slice(0, 6)}: ${Math.round((ted - c.posledniHladina) / 1000)} s bez zvuku`)
        oznam(id, (t) => ({
          titulek: t("Chůvička neslyší — {nazev}", { nazev: z.nazev }),
          text: t("Spojení je, ale nechodí zvuk — mikrofon se zastavil (budík, hovor, jiná aplikace?). Zkontroluj telefon u dítěte."),
          uroven: "offline",
          tag: `chuvicka-zvuk-${id}`,
        }))
        rozesliStav(id)
      }
    }
    const offlineOd = c ? null : (h.offlineOd ?? ted)
    if (!c && h.hlidalaPriOdpojeni && !h.offlineHlaseno && ted - offlineOd > LIMIT_TICHA && db.rodice(id).length) {
      h.offlineHlaseno = true
      const z = db.zarizeni(id)
      if (!z) {
        hlidani.delete(id)
        continue
      }
      db.zapisUdalost(id, "offline")
      oznam(id, (t) => ({
        titulek: t("Chůvička neodpovídá — {nazev}", { nazev: z.nazev }),
        text: t("Spojení se ztratilo. Zkontroluj telefon u dítěte (baterie, Wi-Fi, otevřená aplikace)."),
        uroven: "offline",
        tag: `chuvicka-spojeni-${id}`,
      }))
    }
  }
}, KONTROLA).unref()

setInterval(() => db.uklid(), 3600_000).unref()

// ─── Nahrané zvuky ──────────────────────────────────────────────────────

/** Budíček se smazaným (nebo neznámým) souborem hraje vestavěnou melodii. */
function platnyZvuk(n) {
  const id = idSouboru(n.budik?.zvuk)
  if (id && !db.zvuk(id)) n.budik = { ...n.budik, zvuk: "ukolebavka" }
  return n
}

/** Druh souboru podle prvních bajtů — přípona ani hlavička nic nezaručí. */
function druhZvuku(b) {
  if (b.length < 12) return null
  const text = (od, do_) => b.subarray(od, do_).toString("latin1")
  if (text(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg"
  if (text(0, 4) === "RIFF" && text(8, 12) === "WAVE") return "audio/wav"
  if (text(4, 8) === "ftyp") return "audio/mp4"
  if (text(0, 4) === "OggS") return "audio/ogg"
  if (text(0, 4) === "fLaC") return "audio/flac"
  return null
}

const souborZvuku = (id) => join(ADR_ZVUKY, id)

/** Seznam zvuků všem připojeným — výběr v nastavení se hned obnoví. */
function rozesliZvuky() {
  const zprava = JSON.stringify({ typ: "zvuky", zvuky: db.zvuky() })
  for (const sady of rodice.values()) for (const ws of sady) posli(ws, zprava)
  for (const c of chuvicky.values()) posli(c.ws, zprava)
}

async function nahrajZvuk(req, res, z, t) {
  const velky = () => json(res, 413, { chyba: t("Soubor je větší než {mb} MB.", { mb: MAX_ZVUK / 1048576 }) })
  if (Number(req.headers["content-length"]) > MAX_ZVUK) return velky()
  const kusy = []
  let velikost = 0
  for await (const kus of req) {
    velikost += kus.length
    if (velikost > MAX_ZVUK) return velky()
    kusy.push(kus)
  }
  const data = Buffer.concat(kusy)
  const obsazeno = db.zvuky().reduce((a, x) => a + x.velikost, 0)
  if (obsazeno + data.length > MAX_ZVUKY_CELKEM)
    return json(res, 413, { chyba: t("Na serveru už není místo pro další zvuky (nejvýš {mb} MB). Nějaký smaž.", { mb: MAX_ZVUKY_CELKEM / 1048576 }) })
  const mime = druhZvuku(data)
  if (!mime) return json(res, 415, { chyba: t("Tohle není zvukový soubor (mp3, m4a, wav, ogg nebo flac).") })
  let nazev = ""
  try {
    nazev = decodeURIComponent(String(req.headers["x-nazev"] ?? ""))
  } catch {}
  nazev = nazev.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || t("Zvuk")
  const id = randomBytes(12).toString("base64url")
  await writeFile(souborZvuku(id), data)
  const zvuk = db.pridejZvuk(id, nazev, mime, data.length, z.id)
  console.log(`zvuk nahrán ${id.slice(0, 6)}: ${mime}, ${Math.round(data.length / 1024)} kB`)
  rozesliZvuky()
  return json(res, 200, { zvuk })
}

async function smazZvuk(res, id, t) {
  if (!db.zvuk(id)) return json(res, 404, { chyba: t("Zvuk už není.") })
  db.smazZvuk(id)
  await unlink(souborZvuku(id)).catch(() => {})
  // Budíčky s tímhle zvukem přejdou na vestavěnou melodii.
  for (const chuvickaId of db.chuvickySNastavenim()) {
    const n = db.nastaveni(chuvickaId)
    if (idSouboru(n.budik.zvuk) !== id) continue
    const nove = db.ulozNastaveni(chuvickaId, { budik: { ...n.budik, zvuk: "ukolebavka" } })
    const c = chuvicky.get(chuvickaId)
    if (c) posli(c.ws, { typ: "nastaveni", data: nove })
    rozesliStav(chuvickaId)
  }
  rozesliZvuky()
  return json(res, 200, { ok: true })
}

function posliZvuk(res, id, t) {
  const zvuk = db.zvuk(id)
  if (!zvuk) return json(res, 404, { chyba: t("Zvuk už není.") })
  res.writeHead(200, {
    "Content-Type": zvuk.mime,
    "Content-Length": zvuk.velikost,
    // Pod jedním id se obsah nikdy nemění.
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  })
  createReadStream(souborZvuku(id)).on("error", () => res.destroy()).pipe(res)
}

// ─── HTTP ───────────────────────────────────────────────────────────────

const TYPY = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".tflite": "application/octet-stream",
}

/**
 * Rozpoznání pláče: knihovna MediaPipe z npm balíčku (ne z gitu — ~20 MB)
 * pod /vendor/mediapipe/. Jen vyjmenované soubory.
 */
const MEDIAPIPE = join(KOREN, "node_modules", "@mediapipe", "tasks-audio")
const MEDIAPIPE_SOUBORY = new Set([
  "audio_bundle.mjs",
  "wasm/audio_wasm_internal.js",
  "wasm/audio_wasm_internal.wasm",
  "wasm/audio_wasm_nosimd_internal.js",
  "wasm/audio_wasm_nosimd_internal.wasm",
])

function json(res, kod, data) {
  res.writeHead(kod, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(JSON.stringify(data))
}

async function telo(req) {
  let s = ""
  for await (const kus of req) {
    s += kus
    if (s.length > 16_384) throw new Error("moc velké")
  }
  return s ? JSON.parse(s) : {}
}

function prihlaseny(req) {
  const [id, tajemstvi] = String(req.headers["x-zarizeni"] ?? "").split(":")
  return db.over(id, tajemstvi)
}

/** Kdo zkouší kódy naslepo: z jedné adresy nejvýš 10 pokusů za 10 minut. */
const pokusy = new Map()
setInterval(() => {
  const ted = Date.now()
  for (const [ip, p] of pokusy) if (p.every((t) => ted - t >= 600_000)) pokusy.delete(ip)
}, 600_000).unref()
function prilisPokusu(ip) {
  const ted = Date.now()
  const p = (pokusy.get(ip) ?? []).filter((t) => ted - t < 600_000)
  p.push(ted)
  pokusy.set(ip, p)
  return p.length > 10
}

/** Jazyk požadavku: hlavička X-Jazyk z aplikace, jinak Accept-Language prohlížeče. */
function jazykPozadavku(req) {
  const j = String(req.headers["x-jazyk"] ?? "")
  if (JAZYKY.includes(j)) return j
  const prohlizec = String(req.headers["accept-language"] ?? "")
  // Bez jazyka (skript, „*") česky jako dřív.
  if (/^\s*(cs|sk)\b/i.test(prohlizec) || !/^\s*[a-z]{2}\b/i.test(prohlizec)) return "cs"
  return "en"
}

async function api(req, res, cesta) {
  const ip = String((IP_HLAVICKA && req.headers[IP_HLAVICKA]) || req.socket.remoteAddress).split(",")[0].trim()
  const jazyk = jazykPozadavku(req)
  const t = (s, p) => prelozit(jazyk, s, p)
  if (cesta === "/api/vapid" && req.method === "GET") return json(res, 200, { klic: VAPID.verejny })
  if (cesta === "/api/zdravi") return json(res, 200, { ok: true, verze: VERZE, heslo: Boolean(HESLO) })

  if (cesta === "/api/registrace" && req.method === "POST") {
    const b = await telo(req)
    const role = b.role === "chuvicka" ? "chuvicka" : b.role === "rodic" ? "rodic" : null
    if (!role) return json(res, 400, { chyba: t("Neznámá role.") })
    if (prilisPokusu(ip)) return json(res, 429, { chyba: t("Moc pokusů, zkus to za chvíli.") })
    if (HESLO && !spravneHeslo(b.heslo) && !(role === "rodic" && typeof b.kod === "string" && db.platnyKod(b.kod))) {
      return json(res, 403, {
        chyba: b.heslo ? t("Heslo nesouhlasí.") : t("Na tomhle serveru je k přidání telefonu potřeba heslo."),
        heslo: true,
      })
    }
    const jazykZarizeni = platnyJazyk(b.jazyk ?? jazyk)
    const vychozi = role === "chuvicka" ? prelozit(jazykZarizeni, "Chůvička") : prelozit(jazykZarizeni, "Rodič")
    const nazev = String(b.nazev ?? "").trim().slice(0, 40) || vychozi
    return json(res, 200, { ...db.registruj(role, nazev, jazykZarizeni), role, nazev })
  }

  const z = prihlaseny(req)
  if (!z) return json(res, 401, { chyba: t("Zařízení není registrované.") })

  if (cesta === "/api/zvuky" && req.method === "GET") return json(res, 200, { zvuky: db.zvuky() })
  // Nahrávat a mazat smí jen rodič spárovaný s nějakou chůvičkou — samotná
  // registrace (tu zvládne kdokoli s adresou serveru) na to nestačí.
  const smiZvuky = z.role === "rodic" && db.chuvicky(z.id).length > 0
  if (cesta === "/api/zvuky" && req.method === "POST" && smiZvuky) return nahrajZvuk(req, res, z, t)
  const zvukCesta = /^\/api\/zvuky\/([A-Za-z0-9_-]{8,40})(\/smazat)?$/.exec(cesta)
  if (zvukCesta && !zvukCesta[2] && req.method === "GET") return posliZvuk(res, zvukCesta[1], t)
  if (zvukCesta && zvukCesta[2] && req.method === "POST" && smiZvuky) return smazZvuk(res, zvukCesta[1], t)

  if (cesta === "/api/fotka" && req.method === "POST" && z.role === "chuvicka") {
    const kusy = []
    let velikost = 0
    for await (const kus of req) {
      velikost += kus.length
      if (velikost > 2 * 1048576) return json(res, 413, { chyba: t("Soubor je větší než {mb} MB.", { mb: 2 }) })
      kusy.push(kus)
    }
    const data = Buffer.concat(kusy)
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) return json(res, 415, { chyba: "JPEG" })
    const kdy = Date.now()
    fotky.set(z.id, { data, kdy })
    rodicumChuvicky(z.id, { typ: "fotka", kdy })
    return json(res, 200, { ok: true })
  }
  if (cesta.startsWith("/api/fotka") && req.method === "GET" && z.role === "rodic") {
    const chuvickaId = new URL(req.url, "http://x").searchParams.get("chuvicka") ?? ""
    const f = db.jePar(chuvickaId, z.id) ? fotky.get(chuvickaId) : null
    if (!f || Date.now() - f.kdy > PLATNOST_FOTKY) return json(res, 404, { chyba: t("Nenalezeno.") })
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": f.data.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Porizeno": String(f.kdy),
    })
    return res.end(f.data)
  }
  if (cesta === "/api/ja" && req.method === "GET") {
    return json(res, 200, {
      id: z.id,
      role: z.role,
      nazev: z.nazev,
      sparovano: z.role === "chuvicka" ? db.rodice(z.id) : db.chuvicky(z.id),
      nastaveni: z.role === "chuvicka" ? db.nastaveni(z.id) : undefined,
    })
  }
  if (cesta === "/api/kod" && req.method === "POST" && z.role === "chuvicka") {
    const k = db.novyKod(z.id)
    const url = `https://${req.headers.host}/#sparovat=${k.kod}`
    const qr = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
    return json(res, 200, { ...k, url, qr })
  }
  if (cesta === "/api/sparovat" && req.method === "POST" && z.role === "rodic") {
    if (prilisPokusu(ip)) return json(res, 429, { chyba: t("Moc pokusů, zkus to za chvíli.") })
    const b = await telo(req)
    const chuvickaId = db.pouzijKod(b.kod ?? "", z.id)
    if (!chuvickaId) return json(res, 400, { chyba: t("Kód neplatí — vygeneruj na chůvičce nový.") })
    const c = chuvicky.get(chuvickaId)
    if (c) posli(c.ws, { typ: "rodice", pocet: db.rodice(chuvickaId).length })
    for (const ws of rodice.get(z.id) ?? []) posli(ws, stavChuvicky(chuvickaId))
    return json(res, 200, { chuvicka: { id: chuvickaId, nazev: db.zarizeni(chuvickaId).nazev } })
  }
  if (cesta === "/api/rozparovat" && req.method === "POST") {
    const b = await telo(req)
    if (z.role === "rodic") {
      db.rozparuj(b.chuvicka, z.id)
      poOdparovani(b.chuvicka)
    } else {
      db.rozparuj(z.id, b.rodic)
      for (const ws of rodice.get(b.rodic) ?? []) posli(ws, { typ: "odparovano", chuvicka: z.id })
    }
    return json(res, 200, { ok: true })
  }
  if (cesta === "/api/odber" && req.method === "POST" && z.role === "rodic") {
    const b = await telo(req)
    if (typeof b.endpoint !== "string" || !b.keys) return json(res, 400, { chyba: t("Neplatný odběr.") })
    db.ulozOdber(z.id, b)
    return json(res, 200, { ok: true })
  }
  if (cesta === "/api/zkouska" && req.method === "POST" && z.role === "rodic") {
    for (const odber of db.odbery(z.id)) {
      await webpush
        .sendNotification(odber, JSON.stringify({ titulek: t("Zkouška upozornění"), text: t("Takhle bude vypadat upozornění z chůvičky."), uroven: "ozyva", tag: "zkouska" }), { TTL: 60, urgency: "high" })
        .catch(() => {})
    }
    return json(res, 200, { ok: true, odberu: db.odbery(z.id).length })
  }
  if (cesta.startsWith("/api/historie") && req.method === "GET" && z.role === "rodic") {
    const u = new URL(req.url, "http://x")
    const chuvickaId = u.searchParams.get("chuvicka") ?? ""
    if (!db.jePar(chuvickaId, z.id)) return json(res, 404, { chyba: t("Nenalezeno.") })
    const hodin = Math.max(1, Math.min(168, Number(u.searchParams.get("hodin")) || 12))
    const od = Date.now() - hodin * 3600_000
    return json(res, 200, {
      od,
      hladiny: db.hladiny(chuvickaId, Math.floor(od / 60000)),
      udalosti: db.udalosti(chuvickaId, od),
      prahy: db.prahy(chuvickaId, od),
    })
  }
  if (cesta === "/api/zrusit" && req.method === "POST") {
    if (z.role === "chuvicka") {
      zrusChuvicku(z.id)
    } else {
      const jeho = db.chuvicky(z.id).map((ch) => ch.id)
      db.smazZarizeni(z.id)
      for (const ws of rodice.get(z.id) ?? []) ws.close(4001, "zrušeno")
      for (const id of jeho) poOdparovani(id)
    }
    return json(res, 200, { ok: true })
  }
  return json(res, 404, { chyba: t("Nenalezeno.") })
}

/** WebSocket výslovně — starší Safari pod 'self' nepočítá wss:. */
function wsZdroj(req) {
  const host = String(req.headers.host ?? "")
  return /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? ` wss://${host} ws://${host}` : ""
}

async function soubor(req, res, cesta) {
  // Verze kódu pro aplikaci — číslo se drží jen v package.json.
  if (cesta === "/js/verze.js") {
    res.writeHead(200, { "Content-Type": TYPY[".js"], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" })
    return res.end(`export const VERZE = ${JSON.stringify(VERZE)}\n`)
  }
  let rel = normalize(decodeURIComponent(cesta)).replace(/^(\.\.[/\\])+/, "")
  if (rel === "/" || !extname(rel)) rel = "/index.html"
  const mp = rel.startsWith("/vendor/mediapipe/") ? rel.slice("/vendor/mediapipe/".length) : null
  if (mp !== null && !MEDIAPIPE_SOUBORY.has(mp)) rel = "/neni"
  try {
    const data = await readFile(mp !== null && MEDIAPIPE_SOUBORY.has(mp) ? join(MEDIAPIPE, mp) : join(VEREJNE, rel))
    const etag = `"${createHash("sha1").update(data).digest("base64url").slice(0, 16)}"`
    // Vše se pokaždé ověří (ETag → 304). S max-age prohlížeč po vydání
    // míchal starý skript s novou stránkou a telefon zůstal na staré verzi.
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" })
      return res.end()
    }
    const hlavicky = {
      "Content-Type": TYPY[extname(rel)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "microphone=(self), camera=(self)",
      // Jen vlastní skripty a spojení; zvuky a QR z blob:/data:.
      "Content-Security-Policy":
        `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'${wsZdroj(req)}; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`,
    }
    res.writeHead(200, hlavicky)
    res.end(data)
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Nenalezeno")
  }
}

const server = http.createServer(async (req, res) => {
  const cesta = new URL(req.url, "http://x").pathname
  try {
    if (cesta.startsWith("/api/")) return await api(req, res, cesta)
    return await soubor(req, res, cesta)
  } catch (e) {
    console.error(e)
    json(res, 500, { chyba: prelozit(jazykPozadavku(req), "Chyba serveru.") })
  }
})

// ─── WebSocket ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 })
wss.on("connection", (ws) => {
  ws.isAlive = true
  ws.on("pong", () => (ws.isAlive = true))
  // První zpráva je přihlášení; tajemství nejde do adresy (logy proxy).
  const limit = setTimeout(() => ws.close(4001, "bez přihlášení"), 10_000)
  ws.once("message", (data, binarni) => {
    clearTimeout(limit)
    let m = {}
    try {
      m = binarni ? {} : JSON.parse(data.toString())
    } catch {}
    const z = m.typ === "prihlasit" ? db.over(m.id, m.tajemstvi) : null
    if (!z) return ws.close(4001, "neznámé zařízení")
    // Jazyk telefonu — v něm mu chodí upozornění (přepnout jde kdykoli).
    if (JAZYKY.includes(m.jazyk) && m.jazyk !== z.jazyk) {
      db.nastavJazyk(z.id, m.jazyk)
      z.jazyk = m.jazyk
    }
    posli(ws, { typ: "prihlaseno", role: z.role })
    pripojeno(ws, z)
  })
})
// Ping drží spojení přes proxy (Cloudflare zavírá nečinná po 100 s)
// a odhalí mrtvá spojení telefonu, který usnul.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 20_000).unref()

server.listen(PORT, () => console.log(`Chůvička v${VERZE} na :${PORT}`))
