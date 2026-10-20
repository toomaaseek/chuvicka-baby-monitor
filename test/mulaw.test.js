import { test } from "node:test"
import assert from "node:assert/strict"
import { zakoduj, dekoduj, zakodujPole, dekodujPole, prevzorkuj } from "../public/js/mulaw.js"

test("μ-law: ticho a krajní hodnoty", () => {
  assert.equal(zakoduj(0), 0xff)
  assert.ok(Math.abs(dekoduj(zakoduj(0))) < 0.001)
  assert.ok(dekoduj(zakoduj(1)) > 0.97)
  assert.ok(dekoduj(zakoduj(-1)) < -0.97)
})

test("μ-law: chyba je relativně malá v celém rozsahu", () => {
  for (const v of [0.01, 0.05, 0.2, 0.5, -0.3, -0.02]) {
    const z = dekoduj(zakoduj(v))
    assert.ok(Math.abs(z - v) <= Math.abs(v) * 0.07 + 0.0005, `${v} → ${z}`)
  }
})

test("pole tam a zpět, převzorkování 48 → 16 kHz", () => {
  const sinus = Float32Array.from({ length: 480 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000))
  const mensi = prevzorkuj(sinus, 48000, 16000)
  assert.equal(mensi.length, 160)
  const zpet = dekodujPole(zakodujPole(mensi))
  assert.ok(zpet.every((v, i) => Math.abs(v - mensi[i]) < 0.03))
})
