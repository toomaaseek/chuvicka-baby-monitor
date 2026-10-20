import { test } from "node:test"
import assert from "node:assert/strict"
import { vytvorDetektor, hladinaZRms, prahyZKalibrace, srovnejNastaveni } from "../public/js/detekce.js"

/** Pustí průběh hladiny po 100 ms a vrátí události s časem. */
function prehraj(detektor, useky) {
  const udalosti = []
  let t = 0
  for (const [hladina, sekund] of useky) {
    for (let i = 0; i < sekund * 10; i++) {
      const u = detektor.krok(hladina, t)
      if (u) udalosti.push({ ...u, t: Math.round(t) })
      t += 0.1
    }
  }
  return udalosti
}

const N = { prahOzyva: 40, trvaniOzyva: 3, prahPlace: 60, trvaniPlace: 2, pauza: 2 }

test("krátké zakvíknutí pod trváním nic nespustí", () => {
  assert.deepEqual(prehraj(vytvorDetektor(N), [[20, 5], [50, 1], [20, 5]]), [])
})

test("ozývání po 3 s nad prahem", () => {
  const u = prehraj(vytvorDetektor(N), [[20, 2], [50, 4], [20, 2]])
  assert.equal(u.length, 1)
  assert.equal(u[0].druh, "ozyva")
  assert.equal(u[0].t, 5)
})

test("pláč s nádechy: 2 s nahlas, 1,5 s ticho — dlouhé trvání se splní", () => {
  // Dřívější „souvisle nad prahem" by tohle při 20 s nespustilo nikdy.
  const vzlyky = Array.from({ length: 10 }, () => [[70, 2], [30, 1.5]]).flat()
  const u = prehraj(vytvorDetektor({ ...N, trvaniOzyva: 20, trvaniPlace: 20 }), vzlyky)
  assert.ok(u.some((x) => x.druh === "place"), JSON.stringify(u))
})

test("občasné zvuky (pod polovinu času) nic nespustí", () => {
  const zvuky = Array.from({ length: 10 }, () => [[50, 1], [20, 3]]).flat()
  assert.deepEqual(prehraj(vytvorDetektor({ ...N, trvaniOzyva: 10 }), zvuky), [])
})

test("dlouhý hlasitý pláč: rovnou pláč, ozývání i další pláč umlčí pauza", () => {
  const u = prehraj(vytvorDetektor(N), [[70, 30]])
  assert.deepEqual(u.map((x) => x.druh), ["place"])
  assert.equal(u[0].t, 2)
})

test("ozývání pod prahem pláče, pak pláč", () => {
  const u = prehraj(vytvorDetektor(N), [[50, 4], [70, 3]])
  assert.deepEqual(u.map((x) => x.druh), ["ozyva", "place"])
})

test("po pauze se znovu ozve; s nulovou pauzou opakovaně", () => {
  const u = prehraj(vytvorDetektor({ ...N, pauza: 1 }), [[50, 4], [20, 60], [50, 4]])
  assert.equal(u.filter((x) => x.druh === "ozyva").length, 2)
  const bezPauzy = prehraj(vytvorDetektor({ ...N, pauza: 0 }), [[50, 10]])
  assert.ok(bezPauzy.filter((x) => x.druh === "ozyva").length >= 3)
})

test("hladina z RMS, kalibrace a rozsahy", () => {
  assert.equal(hladinaZRms(0), 0)
  assert.equal(hladinaZRms(1), 100)
  assert.ok(Math.abs(hladinaZRms(0.001) - 33.3) < 0.1) // −60 dBFS
  assert.deepEqual(prahyZKalibrace(20), { prahOzyva: 32, prahPlace: 45 })
  assert.equal(srovnejNastaveni({ prahPlace: 500, nesmysl: 1 }).prahPlace, 99)
  assert.equal("nesmysl" in srovnejNastaveni({ nesmysl: 1 }), false)
})

test("ozývá se má nižší práh a delší dobu než pláče", () => {
  // Starší výchozí 3 s / 8 s se prohodí.
  const stare = srovnejNastaveni({ prahOzyva: 45, trvaniOzyva: 3, prahPlace: 60, trvaniPlace: 8 })
  assert.equal(stare.trvaniOzyva, 8)
  assert.equal(stare.trvaniPlace, 3)
  const obracene = srovnejNastaveni({ prahOzyva: 70, prahPlace: 50 })
  assert.deepEqual([obracene.prahOzyva, obracene.prahPlace], [50, 70])
  const stejne = srovnejNastaveni({ prahOzyva: 99, prahPlace: 99, trvaniOzyva: 5, trvaniPlace: 5 })
  assert.deepEqual([stejne.prahOzyva, stejne.prahPlace, stejne.trvaniOzyva, stejne.trvaniPlace], [98, 99, 6, 5])
})
