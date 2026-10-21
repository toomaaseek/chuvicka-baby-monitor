import { test } from "node:test"
import assert from "node:assert/strict"
import { posudKlip } from "../public/js/plac.js"

const k = (o) => Object.entries(o).map(([nazev, skore]) => ({ nazev, skore }))

test("pláč odejde", () => {
  assert.equal(posudKlip(k({ "Baby cry, infant cry": 0.6, Speech: 0.2 })).potlacit, false)
})

test("řeč dospělých bez dítěte se potlačí — rodič už je u dítěte", () => {
  const p = posudKlip(k({ Speech: 0.7, "Male speech, man speaking": 0.3 }))
  assert.equal(p.potlacit, true)
  assert.equal(p.nejvic.nazev, "Speech")
})

test("televize, vysavač nebo pes se potlačí", () => {
  for (const zvuk of ["Television", "Vacuum cleaner", "Dog", "Music", "White noise"]) assert.equal(posudKlip(k({ [zvuk]: 0.5 })).potlacit, true, zvuk)
})

test("i trocha dětského zvuku přes řeč upozornění pustí", () => {
  assert.equal(posudKlip(k({ Speech: 0.6, "Crying, sobbing": 0.06, Whimper: 0.05 })).potlacit, false)
})

test("nejistý model upozornění pustí", () => {
  assert.equal(posudKlip(k({ Speech: 0.2, Silence: 0.3 })).potlacit, false)
  assert.equal(posudKlip(k({ "Sine wave": 0.8 })).potlacit, false)
  assert.equal(posudKlip([]).potlacit, false)
})

test("víc oken klipu: počítá se nejvyšší skóre", () => {
  const p = posudKlip([...k({ Speech: 0.8 }), ...k({ "Baby cry, infant cry": 0.4 })])
  assert.equal(p.potlacit, false)
  assert.ok(p.dite >= 0.4)
})
