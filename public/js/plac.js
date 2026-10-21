/**
 * Rozpoznání pláče — rozhodování bez prohlížeče, ať jde otestovat.
 *
 * Hlasitost spustí upozornění; než odejde, posoudí model YAMNet (zvuky
 * z AudioSetu) poslední 3 s zvuku. Pravidlo je schválně opatrné:
 * zmeškaný pláč je horší než planý poplach. Upozornění se potlačí, jen
 * když v klipu není nic dětského a zvuk model jasně pozná jako něco
 * jiného — řeč dospělých (někdo už je u dítěte), hudbu, televizi,
 * vysavač, psa… Když si model jistý není, upozornění odejde.
 */

/** Dětské zvuky — kterýkoli stačí, aby upozornění odešlo. */
export const DETSKE = [
  "Baby cry, infant cry",
  "Crying, sobbing",
  "Whimper",
  "Baby laughter",
  "Babbling",
  "Child speech, kid speaking",
  "Screaming",
  "Wail, moan",
  "Cough",
  "Sneeze",
]

/** Zvuky, kvůli kterým se nemá budit rodič. */
export const NEDETSKE = [
  "Speech",
  "Male speech, man speaking",
  "Female speech, woman speaking",
  "Conversation",
  "Music",
  "Television",
  "Radio",
  "Vacuum cleaner",
  "Hair dryer",
  "Blender",
  "Mechanical fan",
  "Air conditioning",
  "Vehicle",
  "Car",
  "Dog",
  "Bark",
  "Cat",
  "Door",
  "Knock",
  "Dishes, pots, and pans",
  "Typing",
  "Water tap, faucet",
  "Toilet flush",
  "White noise",
  "Pink noise",
  "Noise",
  "Static",
]

/** Nad tímhle součtem dětských zvuků upozornění vždy odejde. */
export const PRAH_DITE = 0.1
/** Tak jistý si musí model být, že jde o něco jiného. */
export const PRAH_JINE = 0.35

/**
 * Posudek klipu z kategorií modelu ({ nazev, skore }, nejvyšší skóre
 * z oken klipu). Vrátí { potlacit, dite, nejvic }.
 */
export function posudKlip(kategorie) {
  const skore = new Map()
  for (const k of kategorie) skore.set(k.nazev, Math.max(skore.get(k.nazev) ?? 0, k.skore))
  const dite = DETSKE.reduce((a, n) => a + (skore.get(n) ?? 0), 0)
  let nejvic = null
  for (const [nazev, s] of skore) if (!nejvic || s > nejvic.skore) nejvic = { nazev, skore: s }
  const jine = NEDETSKE.map((n) => ({ nazev: n, skore: skore.get(n) ?? 0 })).reduce((a, b) => (b.skore > a.skore ? b : a))
  const potlacit = dite < PRAH_DITE && jine.skore >= PRAH_JINE
  return { potlacit, dite, nejvic: potlacit ? jine : nejvic }
}
