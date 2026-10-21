import { test } from "node:test"
import assert from "node:assert/strict"
import { souhrnSpanku, delka } from "../public/js/spanek.js"

const h = (hod, min = 0) => Date.UTC(2026, 9, 20, hod, min) - (hod >= 12 ? 86_400_000 : 0)
const u = (druh, hod, min) => ({ druh, kdy: h(hod, min) })

test("noc: probuzení ze shluků, nejdelší klid, klid od", () => {
  const s = souhrnSpanku(
    [
      u("zahajeno", 20, 30),
      u("ozyva", 20, 40), // ještě usíná
      u("ozyva", 2, 15),
      u("place", 2, 18), // týž shluk → jedno probuzení s pláčem
      u("pozastaveno", 2, 19),
      u("ozyva", 5, 50),
      u("ukonceno", 7, 0),
      u("ozyva", 8, 0), // po ukončení se nepočítá
    ],
    h(9),
  )
  assert.equal(s.probuzeni, 3)
  assert.equal(s.sPlacem, 1)
  assert.equal(s.probiha, false)
  assert.equal(s.od, h(20, 30))
  assert.equal(s.do, h(7, 0))
  assert.deepEqual(s.nejdelsiKlid, { od: h(20, 40), do: h(2, 15) })
  assert.equal(s.klidOd, h(20, 40))
})

test("bez hlídání nic; probíhající hlídání končí teď", () => {
  assert.equal(souhrnSpanku([u("ozyva", 1, 0)], h(2)), null)
  const s = souhrnSpanku([u("zahajeno", 21, 0)], h(23))
  assert.equal(s.probiha, true)
  assert.equal(s.do, h(23))
  assert.equal(s.probuzeni, 0)
  assert.deepEqual(s.nejdelsiKlid, { od: h(21), do: h(23) })
  assert.equal(s.klidOd, h(21))
})

test("bere poslední hlídání", () => {
  const s = souhrnSpanku([u("zahajeno", 13, 0), u("ozyva", 13, 30), u("ukonceno", 15, 0), u("zahajeno", 20, 0)], h(22))
  assert.equal(s.od, h(20))
  assert.equal(s.probuzeni, 0)
})

test("délka", () => {
  assert.equal(delka(45 * 60_000), "45 min")
  assert.equal(delka(632 * 60_000), "10 h 32 min")
})
