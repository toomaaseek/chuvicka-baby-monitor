import { test } from "node:test"
import assert from "node:assert/strict"
import { srovnejBudik, maZvonit, popisBudiku, VYCHOZI_BUDIK, idSouboru } from "../public/js/budik.js"
import { srovnejNastaveni } from "../public/js/detekce.js"

// Místní čas (jako na telefonu); 13. 10. 2026 je úterý.
const d = (den, hod, min, s = 0) => new Date(2026, 9, den, hod, min, s)

test("budíček zvoní v nastavený čas jen ve vybrané dny", () => {
  const b = srovnejBudik({ zapnuto: true, cas: "6:30", dny: [1, 2, 3, 4, 5] })
  assert.equal(b.cas, "06:30")
  assert.equal(maZvonit(b, d(13, 6, 30, 5), null), "2026-10-13")
  assert.equal(maZvonit(b, d(13, 6, 29, 59), null), null, "ještě ne")
  assert.equal(maZvonit(b, d(13, 6, 33), null), null, "okno 2 min minulo")
  assert.equal(maZvonit(b, d(17, 6, 30, 5), null), null, "sobota není ve dnech")
  assert.equal(maZvonit(b, d(13, 6, 31), "2026-10-13"), null, "týž den podruhé ne")
  assert.equal(maZvonit({ ...b, zapnuto: false }, d(13, 6, 30, 5), null), null)
})

test("jednorázový budíček zvoní kterýkoli den", () => {
  const b = srovnejBudik({ zapnuto: true, cas: "07:15", dny: [], jednou: true })
  assert.equal(maZvonit(b, d(17, 7, 15, 30), null), "2026-10-17")
  assert.equal(popisBudiku(b), "7:15 · jednou")
})

test("nastavení budíčku se ořízne do platných hodnot", () => {
  assert.deepEqual(srovnejBudik(null), VYCHOZI_BUDIK)
  const b = srovnejBudik({ zapnuto: "ano", cas: "25:00", dny: [7, 1, 1, 9, "3"], zvuk: "../etc/passwd", nesmysl: 1 })
  assert.equal(b.zapnuto, false)
  assert.equal(b.cas, VYCHOZI_BUDIK.cas)
  assert.deepEqual(b.dny, [1, 3, 7])
  assert.equal(b.zvuk, "ukolebavka")
  assert.equal("nesmysl" in b, false)
  assert.equal(srovnejBudik({ zvuk: "soubor:AbCdEfGh12345678" }).zvuk, "soubor:AbCdEfGh12345678")
  assert.equal(idSouboru("soubor:AbCdEfGh12345678"), "AbCdEfGh12345678")
  assert.equal(idSouboru("ukolebavka"), null)
})

test("popis budíčku", () => {
  const b = (dny) => popisBudiku(srovnejBudik({ cas: "06:05", dny }))
  assert.equal(b([1, 2, 3, 4, 5, 6, 7]), "6:05 · každý den")
  assert.equal(b([1, 2, 3, 4, 5]), "6:05 · Po–Pá")
  assert.equal(b([6, 7]), "6:05 · víkend")
  assert.equal(b([1, 3]), "6:05 · Po, St")
})

test("budíček je součástí nastavení chůvičky", () => {
  const n = srovnejNastaveni({ budik: { zapnuto: true, cas: "06:00", dny: [1] } })
  assert.equal(n.budik.zapnuto, true)
  assert.deepEqual(srovnejNastaveni({}).budik, VYCHOZI_BUDIK)
})
