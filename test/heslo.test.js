import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Server s CHUVICKA_HESLO: nový telefon jen s heslem, rodič z QR i bez něj. */
const PORT = 19000 + Math.floor(Math.random() * 1000)
const URL_ = `http://127.0.0.1:${PORT}`
let proces

before(async () => {
  const db = join(mkdtempSync(join(tmpdir(), "chuvicka-heslo-")), "test.db")
  proces = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    env: { ...process.env, PORT: String(PORT), DB: db, CHUVICKA_HESLO: "tajne-heslo", CHUVICKA_IP_HLAVICKA: "cf-connecting-ip" },
    stdio: "inherit",
  })
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${URL_}/api/zdravi`)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("server nenaběhl")
})
after(() => proces.kill())

let ip = 0
async function registruj(telo, z) {
  const r = await fetch(`${URL_}/api/registrace`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.1.0.${++ip}` },
    body: JSON.stringify(telo),
  })
  return { kod: r.status, data: await r.json() }
}

test("server hlásí, že chce heslo", async () => {
  assert.equal((await (await fetch(`${URL_}/api/zdravi`)).json()).heslo, true)
})

test("bez hesla a se špatným heslem telefon nepřidá", async () => {
  const bez = await registruj({ role: "chuvicka" })
  assert.equal(bez.kod, 403)
  assert.equal(bez.data.heslo, true)
  assert.match(bez.data.chyba, /potřeba heslo/)
  const spatne = await registruj({ role: "chuvicka", heslo: "tajne-hesl" })
  assert.equal(spatne.kod, 403)
  assert.match(spatne.data.chyba, /nesouhlasí/)
})

test("s heslem projde; rodič s platným kódem z QR i bez hesla", async () => {
  const ch = await registruj({ role: "chuvicka", heslo: "tajne-heslo" })
  assert.equal(ch.kod, 200)
  const k = await fetch(`${URL_}/api/kod`, { method: "POST", headers: { "Content-Type": "application/json", "X-Zarizeni": `${ch.data.id}:${ch.data.tajemstvi}` }, body: "{}" })
  const { kod } = await k.json()
  assert.equal((await registruj({ role: "rodic", kod: kod.toLowerCase() })).kod, 200)
  // Kód jen otevírá registraci rodiče — chůvičku s ním nepřidáš, a smyšlený neplatí.
  assert.equal((await registruj({ role: "chuvicka", kod })).kod, 403)
  assert.equal((await registruj({ role: "rodic", kod: "ZZZZZZ" })).kod, 403)
})
