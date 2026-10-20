import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { EN } from "../public/js/texty-en.js"
import { prelozit } from "../public/js/i18n.js"
import { ZVUKY } from "../public/js/zvuky.js"

const koren = new URL("../", import.meta.url)
const soubory = [
  "server.js",
  ...readdirSync(new URL("public/js/", koren))
    .filter((f) => f.endsWith(".js") && f !== "texty-en.js")
    .map((f) => `public/js/${f}`),
]

/** Všechny texty předané překladači jako literál: t("…") a prelozit(jazyk, "…"). */
function klice() {
  const vse = new Map()
  for (const f of soubory) {
    const kod = readFileSync(new URL(f, koren), "utf8")
    for (const m of kod.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) vse.set(JSON.parse(`"${m[1]}"`), f)
    for (const m of kod.matchAll(/\bprelozit\([^"]*?,\s*"((?:[^"\\]|\\.)*)"/g)) vse.set(JSON.parse(`"${m[1]}"`), f)
  }
  return vse
}

test("každý přeložitelný text má anglický překlad", () => {
  const chybi = [...klice()].filter(([k]) => !(k in EN)).map(([k, f]) => `${f}: ${k}`)
  // Názvy vestavěných zvuků se překládají přes proměnnou.
  for (const z of ZVUKY) if (!(z.nazev in EN)) chybi.push(`zvuky.js: ${z.nazev}`)
  assert.deepEqual(chybi, [])
})

test("ve slovníku nejsou zapomenuté texty", () => {
  const pouzite = new Set([...klice().keys(), ...ZVUKY.map((z) => z.nazev)])
  assert.deepEqual(Object.keys(EN).filter((k) => !pouzite.has(k)), [])
})

test("překlad má stejné zástupce jako originál", () => {
  for (const [k, v] of Object.entries(EN)) {
    if (typeof v !== "string") continue
    const zastupci = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    assert.deepEqual(zastupci(v), zastupci(k), k)
  }
})

test("prelozit dosadí parametry a bez překladu vrátí češtinu", () => {
  assert.equal(prelozit("cs", "Pláče — {nazev}", { nazev: "Pokojík" }), "Pláče — Pokojík")
  assert.equal(prelozit("en", "Pláče — {nazev}", { nazev: "Pokojík" }), "Crying — Pokojík")
  assert.equal(prelozit("en", "text, který ve slovníku není"), "text, který ve slovníku není")
  assert.equal(prelozit("xx", "Pláče — {nazev}", { nazev: "A" }), "Pláče — A")
})

test("service worker má v mezipaměti všechny moduly aplikace", () => {
  const sw = readFileSync(new URL("public/sw.js", koren), "utf8")
  const chybi = readdirSync(new URL("public/js/", koren))
    .filter((f) => f.endsWith(".js") && !sw.includes(`"/js/${f}"`))
  assert.deepEqual(chybi, [])
})
