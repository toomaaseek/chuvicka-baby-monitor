/**
 * Spánkový souhrn z událostí hlídání — bez prohlížeče, ať jde otestovat.
 *
 * Bere poslední hlídání (od „zahájeno" do „ukončeno", nebo do teď)
 * a z upozornění ozývá se / pláče spočítá probuzení: upozornění blíž
 * než 10 minut od sebe jsou jedno probuzení (dítě se ozve, rodič přijde,
 * dítě se ještě chvíli vrtí). Nejdelší klid je nejdelší úsek bez
 * upozornění. „Klid od" je začátek první půlhodiny bez upozornění —
 * odhad usnutí, ne měření.
 */

export const SPOJIT_MIN = 10
export const KLID_MIN = 30

const MIN = 60_000

export function souhrnSpanku(udalosti, ted) {
  const serazene = [...udalosti].sort((a, b) => a.kdy - b.kdy)
  const zacatky = serazene.filter((u) => u.druh === "zahajeno")
  const zacatek = zacatky.at(-1)
  if (!zacatek) return null
  const konecUdalost = serazene.find((u) => u.kdy > zacatek.kdy && (u.druh === "ukonceno" || u.druh === "ukonceno_rodicem"))
  const od = zacatek.kdy
  const do_ = konecUdalost?.kdy ?? ted
  const hlasite = serazene.filter((u) => u.kdy >= od && u.kdy <= do_ && (u.druh === "ozyva" || u.druh === "place"))

  // Probuzení: shluky upozornění.
  const probuzeni = []
  for (const u of hlasite) {
    const posledni = probuzeni.at(-1)
    if (posledni && u.kdy - posledni.do < SPOJIT_MIN * MIN) {
      posledni.do = u.kdy
      posledni.place ||= u.druh === "place"
    } else probuzeni.push({ od: u.kdy, do: u.kdy, place: u.druh === "place" })
  }

  // Úseky klidu mezi začátkem, probuzeními a koncem.
  const hranice = [{ do: od }, ...probuzeni, { od: do_ }]
  const klidy = []
  for (let i = 1; i < hranice.length; i++) klidy.push({ od: hranice[i - 1].do, do: hranice[i].od })
  const nejdelsi = klidy.reduce((a, k) => (!a || k.do - k.od > a.do - a.od ? k : a), null)
  const prvni = klidy.find((k) => k.do - k.od >= KLID_MIN * MIN)

  return {
    od,
    do: do_,
    probiha: !konecUdalost,
    probuzeni: probuzeni.length,
    sPlacem: probuzeni.filter((p) => p.place).length,
    nejdelsiKlid: nejdelsi && nejdelsi.do - nejdelsi.od >= MIN ? nejdelsi : null,
    klidOd: prvni ? prvni.od : null,
  }
}

/** „10 h 32 min", „45 min". */
export function delka(ms) {
  const m = Math.round(ms / MIN)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}
