import { test } from "node:test"
import assert from "node:assert/strict"
import { zesvetli, prumernyJas, rozmery, MAX_ZESILENI } from "../public/js/fotka.js"

const snimek = (jas, px = 100) => {
  const d = new Uint8ClampedArray(px * 4)
  for (let i = 0; i < d.length; i += 4) d.set([jas, jas, jas, 255], i)
  return d
}

test("světlá fotka zůstane", () => {
  const d = snimek(150)
  assert.equal(zesvetli(d), 1)
  assert.equal(d[0], 150)
})

test("tmavá fotka se zesvětlí, nejvýš 5×, průhlednost beze změny", () => {
  const d = snimek(40)
  assert.ok(Math.abs(zesvetli(d) - 110 / 40) < 0.01)
  assert.ok(Math.abs(prumernyJas(d) - 110) < 1)
  assert.equal(d[3], 255)
  const tma = snimek(5)
  assert.equal(zesvetli(tma), MAX_ZESILENI)
  assert.equal(tma[0], 25)
})

test("rozměry: delší strana nejvýš 960, malé se nezvětšují", () => {
  assert.deepEqual(rozmery(1920, 1080), { sirka: 960, vyska: 540 })
  assert.deepEqual(rozmery(1080, 1920), { sirka: 540, vyska: 960 })
  assert.deepEqual(rozmery(640, 480), { sirka: 640, vyska: 480 })
})
