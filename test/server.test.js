import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import WebSocket from "ws"

const PORT = 18000 + Math.floor(Math.random() * 1000)
const URL_ = `http://127.0.0.1:${PORT}`
let proces

before(async () => {
  const db = join(mkdtempSync(join(tmpdir(), "chuvicka-")), "test.db")
  proces = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    // Hlídání zvuku zkrácené, ať test „neslyší" netrvá minutu.
    env: { ...process.env, PORT: String(PORT), DB: db, CHUVICKA_LIMIT_ZVUKU_MS: "1500", CHUVICKA_KONTROLA_MS: "300", CHUVICKA_LIMIT_SPOJENI_MS: "1000", CHUVICKA_MAX_ZVUK_MB: "1", CHUVICKA_MAX_ZVUKY_MB: "2", CHUVICKA_IP_HLAVICKA: "cf-connecting-ip" },
    stdio: "inherit",
  })
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${URL_}/api/zdravi`)
      if (r.ok) {
        const { verze } = await r.json()
        assert.match(verze, /^\d+\.\d+\.\d+$/)
        // Aplikace bere verzi z modulu, který server skládá z package.json.
        assert.equal(await (await fetch(`${URL_}/js/verze.js`)).text(), `export const VERZE = "${verze}"\n`)
        // Soubory aplikace se pokaždé ověřují — jinak telefon zůstane na staré verzi.
        const app = await fetch(`${URL_}/js/app.js`)
        assert.equal(app.headers.get("cache-control"), "no-cache")
        const znovu = await fetch(`${URL_}/js/app.js`, { headers: { "If-None-Match": app.headers.get("etag") } })
        assert.equal(znovu.status, 304)
        // Stránka smí jen vlastní skripty a spojení.
        const csp = (await fetch(`${URL_}/`)).headers.get("content-security-policy")
        assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/)
        assert.match(csp, /frame-ancestors 'none'/)
        return
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("server nenaběhl")
})
after(() => proces.kill())

// ip: vlastní adresa testu — registrace a párování mají limit 10 pokusů
// za 10 minut z jedné adresy a testy by ho jinak společně vyčerpaly.
async function api(cesta, telo, z, ip) {
  const r = await fetch(URL_ + cesta, {
    method: telo ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(z ? { "X-Zarizeni": `${z.id}:${z.tajemstvi}` } : {}),
      ...(ip ? { "CF-Connecting-IP": ip } : {}),
    },
    body: telo ? JSON.stringify(telo) : undefined,
  })
  return { kod: r.status, data: await r.json() }
}

function pripoj(z) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const zpravy = []
    ws.on("message", (d, bin) => zpravy.push(bin ? d : JSON.parse(d.toString())))
    ws.on("open", () => ws.send(JSON.stringify({ typ: "prihlasit", id: z.id, tajemstvi: z.tajemstvi })))
    ws.on("error", reject)
    ws.on("close", (k) => reject(new Error(`spojení zavřeno ${k}`)))
    const cekej = setInterval(() => {
      if (zpravy.some((m) => m.typ === "prihlaseno")) {
        clearInterval(cekej)
        resolve({ ws, zpravy, posli: (m) => ws.send(typeof m === "string" || Buffer.isBuffer(m) ? m : JSON.stringify(m)) })
      }
    }, 20)
  })
}

const pockej = async (fn, ms = 3000) => {
  for (let t = 0; t < ms; t += 25) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error("nedočkal jsem se")
}

test("celý průběh: registrace, párování, hladina, událost, nastavení, příposlech", async () => {
  const ch = (await api("/api/registrace", { role: "chuvicka", nazev: "Pokojíček" })).data
  const ro = (await api("/api/registrace", { role: "rodic" })).data

  // Bez tajemství nic.
  assert.equal((await api("/api/ja", null, { id: ch.id, tajemstvi: "spatne" })).kod, 401)

  const kod = (await api("/api/kod", {}, ch)).data
  assert.match(kod.kod, /^[A-Z2-9]{6}$/)
  assert.match(kod.qr, /^<svg/)
  // Rodič se páruje kódem — jednorázovým.
  assert.equal((await api("/api/sparovat", { kod: kod.kod.toLowerCase() }, ro)).kod, 200)
  assert.equal((await api("/api/sparovat", { kod: kod.kod }, ro)).kod, 400)
  assert.equal((await api("/api/ja", null, ro)).data.sparovano[0].nazev, "Pokojíček")

  const c = await pripoj(ch)
  const r = await pripoj(ro)
  await pockej(() => r.zpravy.find((m) => m.typ === "stav" && m.online))

  // Rodič se dívá → chůvička hlásí živě; přestane → zase šetří baterii.
  r.posli({ typ: "divam", zapnout: true })
  await pockej(() => c.zpravy.find((m) => m.typ === "zive" && m.zapnout))
  r.posli({ typ: "divam", zapnout: false })
  await pockej(() => c.zpravy.filter((m) => m.typ === "zive").at(-1)?.zapnout === false)

  // Hladina a událost dojdou rodiči.
  c.posli({ typ: "hladina", h: 42.4 })
  await pockej(() => r.zpravy.find((m) => m.typ === "hladina" && m.h === 42))
  c.posli({ typ: "udalost", druh: "place", hladina: 70, trvani: 9 })
  await pockej(() => r.zpravy.find((m) => m.typ === "udalost" && m.druh === "place"))

  // Nastavení od rodiče dojde chůvičce, oříznuté do rozsahů.
  r.posli({ typ: "nastaveni", chuvicka: ch.id, data: { prahOzyva: 30, pauza: 999 } })
  const n = await pockej(() => c.zpravy.find((m) => m.typ === "nastaveni" && m.data.prahOzyva === 30))
  assert.equal(n.data.pauza, 10)

  // Příposlech: chůvička dostane pokyn, zvuk jde rodiči.
  r.posli({ typ: "poslech", chuvicka: ch.id, zapnout: true })
  await pockej(() => c.zpravy.find((m) => m.typ === "poslech" && m.zapnout))
  c.posli(Buffer.from([1, 2, 3]))
  await pockej(() => r.zpravy.find((m) => Buffer.isBuffer(m) && m[0] === 1))

  // Vysílačka: hlas rodiče jde chůvičce.
  r.posli({ typ: "mluvit", chuvicka: ch.id, zapnout: true })
  await pockej(() => c.zpravy.find((m) => m.typ === "hlas" && m.zapnout))
  r.posli(Buffer.from([9, 9]))
  await pockej(() => c.zpravy.find((m) => Buffer.isBuffer(m) && m[0] === 9))

  // Cizí rodič chůvičku neovládne.
  const cizi = (await api("/api/registrace", { role: "rodic" })).data
  const rc = await pripoj(cizi)
  rc.posli({ typ: "nastaveni", chuvicka: ch.id, data: { prahOzyva: 5 } })
  await new Promise((s) => setTimeout(s, 300))
  assert.ok(!c.zpravy.some((m) => m.typ === "nastaveni" && m.data.prahOzyva === 5))

  // Historie má událost a změnu prahů: výchozí (45) a nová (30).
  const hist = (await api(`/api/historie?chuvicka=${ch.id}&hodin=1`, null, ro)).data
  assert.equal(hist.udalosti.find((u) => u.druh === "place").trvani, 9)
  assert.deepEqual(hist.prahy.map((p) => p.prahOzyva), [45, 30])
  assert.equal(hist.prahy[0].kdy, 0)

  // Chůvička odpojena → rodič to vidí.
  c.ws.close()
  await pockej(() => r.zpravy.find((m) => m.typ === "stav" && m.online === false))
  r.ws.close()
  rc.ws.close()
})

test("zrušení spojení rodičem zruší i chůvičku, když nezbude jiný rodič", async () => {
  const ch = (await api("/api/registrace", { role: "chuvicka", nazev: "Ložnice" }, null, "10.0.0.2")).data
  const r1 = (await api("/api/registrace", { role: "rodic" }, null, "10.0.0.2")).data
  const r2 = (await api("/api/registrace", { role: "rodic" }, null, "10.0.0.2")).data
  for (const r of [r1, r2]) {
    const { kod } = (await api("/api/kod", {}, ch)).data
    assert.equal((await api("/api/sparovat", { kod }, r, "10.0.0.2")).kod, 200)
  }
  const c = await pripoj(ch)
  let zavreno = null
  c.ws.on("close", (k) => (zavreno = k))

  // Odejde první rodič — druhý dál hlídá, chůvička zůstává.
  await api("/api/zrusit", {}, r1)
  await pockej(() => c.zpravy.find((m) => m.typ === "rodice" && m.pocet === 1))
  assert.equal(zavreno, null)

  // Odejde poslední — chůvička se zruší a vrátí na začátek.
  const w2 = await pripoj(r2)
  await api("/api/zrusit", {}, r2)
  await pockej(() => zavreno === 4001)
  assert.equal((await api("/api/ja", null, ch)).kod, 401)
  w2.ws.close()
})

test("chůvička zruší spojení → rodiči zmizí", async () => {
  const ch = (await api("/api/registrace", { role: "chuvicka", nazev: "Pokoj" }, null, "10.0.0.3")).data
  const ro = (await api("/api/registrace", { role: "rodic" }, null, "10.0.0.3")).data
  const { kod } = (await api("/api/kod", {}, ch)).data
  await api("/api/sparovat", { kod }, ro, "10.0.0.3")
  const r = await pripoj(ro)
  await api("/api/zrusit", {}, ch)
  await pockej(() => r.zpravy.find((m) => m.typ === "odparovano" && m.chuvicka === ch.id))
  r.ws.close()
})

test("hlídá, ale nechodí zvuk → rodič se dozví, že chůvička neslyší", async () => {
  const ip = "10.0.0.4"
  const ch = (await api("/api/registrace", { role: "chuvicka", nazev: "Dětský" }, null, ip)).data
  const ro = (await api("/api/registrace", { role: "rodic" }, null, ip)).data
  const { kod } = (await api("/api/kod", {}, ch)).data
  await api("/api/sparovat", { kod }, ro, ip)
  const c = await pripoj(ch)
  const r = await pripoj(ro)

  // Hlídá a posílá jen stav (jako 7. 10. ráno), zvuk nechodí.
  c.posli({ typ: "stav", hlida: true, baterie: 0.5, nabiji: false })
  await pockej(() => r.zpravy.find((m) => m.typ === "stav" && m.chuvicka === ch.id && m.neslysi === true), 5000)

  // Zvuk zase chodí → stav se vrátí a v historii je výpadek i návrat.
  c.posli({ typ: "hladina", h: 40 })
  await pockej(() => r.zpravy.findLast((m) => m.typ === "stav" && m.chuvicka === ch.id)?.neslysi === false)
  const hist = (await api(`/api/historie?chuvicka=${ch.id}&hodin=1`, null, ro)).data
  assert.deepEqual(
    hist.udalosti.filter((u) => u.druh === "neslysi" || u.druh === "slysi").map((u) => u.druh),
    ["neslysi", "slysi"],
  )
  c.ws.close()
  r.ws.close()
})

test("výpadek během hlídání je poplach, zavření po ukončení hlídání ne", async () => {
  const ip = "10.0.0.5"
  const ch = (await api("/api/registrace", { role: "chuvicka", nazev: "Pokojík" }, null, ip)).data
  const ro = (await api("/api/registrace", { role: "rodic" }, null, ip)).data
  const { kod } = (await api("/api/kod", {}, ch)).data
  await api("/api/sparovat", { kod }, ro, ip)
  const r = await pripoj(ro)
  const druhy = async () =>
    (await api(`/api/historie?chuvicka=${ch.id}&hodin=1`, null, ro)).data.udalosti.map((u) => u.druh)

  // Hlídá a spojení spadne → „offline".
  let c = await pripoj(ch)
  c.posli({ typ: "stav", hlida: true })
  c.posli({ typ: "hladina", h: 40 })
  await pockej(async () => (await druhy()).includes("zahajeno"))
  c.ws.terminate()
  await pockej(async () => (await druhy()).includes("offline"), 5000)

  // Znovu připojená a hlídá dál — to není nové zahájení.
  c = await pripoj(ch)
  c.posli({ typ: "stav", hlida: true })
  c.posli({ typ: "hladina", h: 40 })
  await new Promise((s) => setTimeout(s, 300))
  assert.equal((await druhy()).filter((d) => d === "zahajeno").length, 1)

  // Ukončí hlídání a zavře aplikaci → „ukonceno", žádný další „offline".
  c.posli({ typ: "stav", hlida: false })
  await pockej(() => r.zpravy.findLast((m) => m.typ === "stav" && m.chuvicka === ch.id)?.ukonceno === true)
  c.ws.close()
  await pockej(() => r.zpravy.findLast((m) => m.typ === "stav" && m.chuvicka === ch.id)?.online === false)
  await new Promise((s) => setTimeout(s, 1800))
  const d = await druhy()
  assert.equal(d.filter((x) => x === "offline").length, 1, d.join(","))
  assert.equal(d.at(-1), "ukonceno", d.join(","))
  assert.equal(r.zpravy.findLast((m) => m.typ === "stav" && m.chuvicka === ch.id).ukonceno, true)
  r.ws.close()
})

test("rodič ukončí hlídání na dálku → chůvička dostane pokyn, historie ví kdo", async () => {
  const ip = "10.0.0.6"
  const ch = (await api("/api/registrace", { role: "chuvicka", nazev: "Postýlka" }, null, ip)).data
  const ro = (await api("/api/registrace", { role: "rodic" }, null, ip)).data
  const { kod } = (await api("/api/kod", {}, ch)).data
  await api("/api/sparovat", { kod }, ro, ip)
  const c = await pripoj(ch)
  const r = await pripoj(ro)

  // Nehlídá → pokyn se vůbec nepošle.
  r.posli({ typ: "ukoncit", chuvicka: ch.id })
  await new Promise((s) => setTimeout(s, 300))
  assert.ok(!c.zpravy.some((m) => m.typ === "ukoncit"))

  c.posli({ typ: "stav", hlida: true })
  c.posli({ typ: "hladina", h: 40 })
  await pockej(() => r.zpravy.findLast((m) => m.typ === "stav" && m.chuvicka === ch.id)?.hlida === true)
  r.posli({ typ: "ukoncit", chuvicka: ch.id })
  await pockej(() => c.zpravy.find((m) => m.typ === "ukoncit"))
  c.posli({ typ: "stav", hlida: false })
  const stav = await pockej(() => r.zpravy.findLast((m) => m.typ === "stav" && m.chuvicka === ch.id && m.ukonceno))
  assert.equal(stav.ukoncenoRodicem, true)
  const hist = (await api(`/api/historie?chuvicka=${ch.id}&hodin=1`, null, ro)).data
  assert.equal(hist.udalosti.at(-1).druh, "ukonceno_rodicem")
  c.ws.close()
  r.ws.close()
})

async function nahraj(z, data, nazev, typ = "audio/mpeg") {
  const r = await fetch(`${URL_}/api/zvuky`, {
    method: "POST",
    headers: { "Content-Type": typ, "X-Nazev": encodeURIComponent(nazev), "X-Zarizeni": `${z.id}:${z.tajemstvi}` },
    body: data,
  })
  return { kod: r.status, data: await r.json() }
}

test("nahrané zvuky: jen zvuk, do limitu, nahrává spárovaný rodič, vidí je každé registrované zařízení", async () => {
  const ip = "10.0.0.7"
  const ch = (await api("/api/registrace", { role: "chuvicka", nazev: "Zvuky" }, null, ip)).data
  const ro = (await api("/api/registrace", { role: "rodic" }, null, ip)).data
  const jiny = (await api("/api/registrace", { role: "rodic" }, null, ip)).data
  const { kod } = (await api("/api/kod", {}, ch)).data
  assert.equal((await api("/api/sparovat", { kod }, ro, ip)).kod, 200)
  const r = await pripoj(jiny)

  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(2000, 7)])
  const ok = await nahraj(ro, mp3, "Ranní písnička 🌞")
  assert.equal(ok.kod, 200)
  assert.equal(ok.data.zvuk.nazev, "Ranní písnička 🌞")
  assert.equal(ok.data.zvuk.mime, "audio/mpeg")
  const id = ok.data.zvuk.id
  // Ostatní se o novém zvuku dozví hned.
  await pockej(() => r.zpravy.find((m) => m.typ === "zvuky" && m.zvuky.some((z) => z.id === id)))

  // Text převlečený za mp3, příliš velký soubor a chůvička jako nahrávač neprojdou.
  assert.equal((await nahraj(ro, Buffer.from("tohle není zvuk, jen text"), "x")).kod, 415)
  assert.equal((await nahraj(ro, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(1100 * 1024)]), "velký")).kod, 413)
  assert.equal((await nahraj(ch, mp3, "od chůvičky")).kod, 404)
  // Nespárovaný rodič (registrace je otevřená komukoli) nahrávat ani mazat nesmí.
  assert.equal((await nahraj(jiny, mp3, "cizí")).kod, 404)
  assert.equal((await api(`/api/zvuky/${id}/smazat`, {}, jiny)).kod, 404)

  // Stáhnout ho může každé registrované zařízení, neznámé ne.
  const f = await fetch(`${URL_}/api/zvuky/${id}`, { headers: { "X-Zarizeni": `${ch.id}:${ch.tajemstvi}` } })
  assert.equal(f.status, 200)
  assert.equal(f.headers.get("content-type"), "audio/mpeg")
  assert.deepEqual(Buffer.from(await f.arrayBuffer()), mp3)
  assert.equal((await fetch(`${URL_}/api/zvuky/${id}`)).status, 401)
  assert.ok((await api("/api/zvuky", null, ch)).data.zvuky.some((z) => z.id === id))

  assert.equal((await api(`/api/zvuky/${id}/smazat`, {}, ro)).kod, 200)
  assert.equal((await fetch(`${URL_}/api/zvuky/${id}`, { headers: { "X-Zarizeni": `${ro.id}:${ro.tajemstvi}` } })).status, 404)

  // Dohromady víc než CHUVICKA_MAX_ZVUKY_MB (2) neprojde; chyba v jazyce telefonu.
  const kus = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(900 * 1024)])
  const prvni = (await nahraj(ro, kus, "první")).data.zvuk.id
  const druhy = (await nahraj(ro, kus, "druhý")).data.zvuk.id
  const plno = await fetch(`${URL_}/api/zvuky`, {
    method: "POST",
    headers: { "Content-Type": "audio/mpeg", "X-Jazyk": "en", "X-Zarizeni": `${ro.id}:${ro.tajemstvi}` },
    body: kus,
  })
  assert.equal(plno.status, 413)
  assert.match((await plno.json()).chyba, /no room for more sounds/)
  for (const x of [prvni, druhy]) await api(`/api/zvuky/${x}/smazat`, {}, ro)
  r.ws.close()
})

test("jazyk telefonu: výchozí název, chyby a uložený jazyk pro upozornění", async () => {
  const ip = "10.0.0.9"
  const en = (await api("/api/registrace", { role: "rodic", jazyk: "en" }, null, ip)).data
  assert.equal(en.nazev, "Parent")
  const ro = (await api("/api/registrace", { role: "rodic" }, null, ip)).data
  assert.equal(ro.nazev, "Rodič")
  const ch = (await api("/api/registrace", { role: "chuvicka" }, null, ip)).data
  const { kod } = (await api("/api/kod", {}, ch)).data
  await api("/api/sparovat", { kod }, ro, ip)
  const jazykRodice = async () => (await api("/api/ja", null, ch)).data.sparovano[0].jazyk
  assert.equal(await jazykRodice(), "cs")
  // Přihlášení s jinou volbou jazyk uloží — v něm pak chodí upozornění.
  const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  await new Promise((ok) => s.on("open", ok))
  s.send(JSON.stringify({ typ: "prihlasit", id: ro.id, tajemstvi: ro.tajemstvi, jazyk: "en" }))
  await new Promise((ok) => s.on("message", ok))
  s.close()
  assert.equal(await jazykRodice(), "en")
  const chyba = await fetch(`${URL_}/api/historie?chuvicka=x`, { headers: { "X-Zarizeni": `${ro.id}:${ro.tajemstvi}`, "X-Jazyk": "en" } })
  assert.equal((await chyba.json()).chyba, "Not found.")
})
