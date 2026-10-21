/**
 * Fotka na vyžádání — výpočty bez prohlížeče, ať jdou otestovat.
 *
 * V noci je pokoj tmavý a fotoaparát telefonu bez přisvícení vrátí skoro
 * černý snímek. Tmavou fotku proto zesvětlíme: průměrný jas vytáhneme
 * k ~110 (z 255), nejvýš 5×. Zrní to, ale je poznat, jestli dítě leží.
 */

export const CIL_JASU = 110
export const MAX_ZESILENI = 5
/** Delší strana posílané fotky v pixelech. */
export const MAX_STRANA = 960
/** Jak dlouho server drží poslední fotku v paměti. */
export const PLATNOST_MS = 5 * 60_000

/** Průměrný jas RGBA pole (0–255). */
export function prumernyJas(data) {
  let soucet = 0
  // Každý 4. pixel stačí a je to 4× rychlejší.
  let n = 0
  for (let i = 0; i < data.length; i += 16) {
    soucet += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    n++
  }
  return n ? soucet / n : 0
}

/** Zesvětlí tmavý snímek na místě. Vrátí použité zesílení (1 = beze změny). */
export function zesvetli(data) {
  const jas = prumernyJas(data)
  if (jas >= CIL_JASU * 0.8) return 1
  const zesileni = Math.min(MAX_ZESILENI, CIL_JASU / Math.max(jas, 1))
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.min(255, data[i] * zesileni)
    data[i + 1] = Math.min(255, data[i + 1] * zesileni)
    data[i + 2] = Math.min(255, data[i + 2] * zesileni)
  }
  return zesileni
}

/** Rozměry pro posílání: delší strana nejvýš MAX_STRANA. */
export function rozmery(sirka, vyska) {
  const k = Math.min(1, MAX_STRANA / Math.max(sirka, vyska, 1))
  return { sirka: Math.round(sirka * k), vyska: Math.round(vyska * k) }
}
