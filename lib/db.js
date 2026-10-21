import { DatabaseSync } from "node:sqlite"
import { createHash, randomBytes } from "node:crypto"
import { srovnejNastaveni, VYCHOZI } from "../public/js/detekce.js"

/**
 * Úložiště chůvičky — SQLite ve vestavěném `node:sqlite`.
 *
 * Bez účtů: každé zařízení má náhodné id a tajemství (v databázi jen
 * jeho otisk SHA-256). Párování jednorázovým kódem z QR. Zvuk se
 * neukládá nikdy — jen průběh hlasitosti po minutách a události.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS zarizeni (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('chuvicka', 'rodic')),
  otisk TEXT NOT NULL,
  nazev TEXT NOT NULL,
  vytvoreno INTEGER NOT NULL,
  naposledy INTEGER NOT NULL,
  jazyk TEXT NOT NULL DEFAULT 'cs'
);
CREATE TABLE IF NOT EXISTS par (
  chuvicka TEXT NOT NULL REFERENCES zarizeni(id) ON DELETE CASCADE,
  rodic TEXT NOT NULL REFERENCES zarizeni(id) ON DELETE CASCADE,
  vytvoreno INTEGER NOT NULL,
  PRIMARY KEY (chuvicka, rodic)
);
CREATE TABLE IF NOT EXISTS kod (
  kod TEXT PRIMARY KEY,
  chuvicka TEXT NOT NULL REFERENCES zarizeni(id) ON DELETE CASCADE,
  plati_do INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS odber (
  endpoint TEXT PRIMARY KEY,
  rodic TEXT NOT NULL REFERENCES zarizeni(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nastaveni (
  chuvicka TEXT PRIMARY KEY REFERENCES zarizeni(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  pozastaveno_do INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS udalost (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chuvicka TEXT NOT NULL REFERENCES zarizeni(id) ON DELETE CASCADE,
  kdy INTEGER NOT NULL,
  druh TEXT NOT NULL,
  hladina REAL,
  trvani REAL
);
CREATE INDEX IF NOT EXISTS udalost_kdy ON udalost (chuvicka, kdy);
CREATE TABLE IF NOT EXISTS zmena_prahu (
  chuvicka TEXT NOT NULL REFERENCES zarizeni(id) ON DELETE CASCADE,
  kdy INTEGER NOT NULL,
  prah_ozyva REAL NOT NULL,
  prah_place REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS zmena_prahu_kdy ON zmena_prahu (chuvicka, kdy);
CREATE TABLE IF NOT EXISTS zvuk (
  id TEXT PRIMARY KEY,
  nazev TEXT NOT NULL,
  mime TEXT NOT NULL,
  velikost INTEGER NOT NULL,
  vytvoreno INTEGER NOT NULL,
  nahral TEXT
);
CREATE TABLE IF NOT EXISTS hladina (
  chuvicka TEXT NOT NULL REFERENCES zarizeni(id) ON DELETE CASCADE,
  minuta INTEGER NOT NULL,
  max REAL NOT NULL,
  prumer REAL NOT NULL,
  PRIMARY KEY (chuvicka, minuta)
);
`

/** Kód z QR: bez znaků, které se pletou (0/O, 1/I/L). */
const ABECEDA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

export const otisk = (tajemstvi) => createHash("sha256").update(tajemstvi).digest("hex")

export function otevriDb(soubor) {
  const db = new DatabaseSync(soubor)
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
  db.exec(SCHEMA)
  // 0.4.4: baterie chůvičky ke každé minutě (historie noci).
  if (!db.prepare("PRAGMA table_info(hladina)").all().some((s) => s.name === "baterie"))
    db.exec("ALTER TABLE hladina ADD COLUMN baterie REAL; ALTER TABLE hladina ADD COLUMN nabiji INTEGER;")
  // 0.7.0: jazyk zařízení — v něm chodí upozornění.
  if (!db.prepare("PRAGMA table_info(zarizeni)").all().some((s) => s.name === "jazyk"))
    db.exec("ALTER TABLE zarizeni ADD COLUMN jazyk TEXT NOT NULL DEFAULT 'cs';")
  const ted = () => Date.now()

  const q = {
    vloz: db.prepare("INSERT INTO zarizeni (id, role, otisk, nazev, vytvoreno, naposledy, jazyk) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    najdi: db.prepare("SELECT * FROM zarizeni WHERE id = ?"),
    videno: db.prepare("UPDATE zarizeni SET naposledy = ? WHERE id = ?"),
    prejmenuj: db.prepare("UPDATE zarizeni SET nazev = ? WHERE id = ?"),
    nastavJazyk: db.prepare("UPDATE zarizeni SET jazyk = ? WHERE id = ?"),
    smazZarizeni: db.prepare("DELETE FROM zarizeni WHERE id = ?"),
    vlozKod: db.prepare("INSERT INTO kod (kod, chuvicka, plati_do) VALUES (?, ?, ?)"),
    najdiKod: db.prepare("SELECT * FROM kod WHERE kod = ?"),
    smazKod: db.prepare("DELETE FROM kod WHERE kod = ?"),
    stareKody: db.prepare("DELETE FROM kod WHERE plati_do < ?"),
    sparuj: db.prepare("INSERT OR IGNORE INTO par (chuvicka, rodic, vytvoreno) VALUES (?, ?, ?)"),
    rozparuj: db.prepare("DELETE FROM par WHERE chuvicka = ? AND rodic = ?"),
    rodice: db.prepare(
      "SELECT z.id, z.nazev, z.naposledy, z.jazyk FROM par p JOIN zarizeni z ON z.id = p.rodic WHERE p.chuvicka = ? ORDER BY p.vytvoreno",
    ),
    chuvicky: db.prepare(
      "SELECT z.id, z.nazev, z.naposledy FROM par p JOIN zarizeni z ON z.id = p.chuvicka WHERE p.rodic = ? ORDER BY p.vytvoreno",
    ),
    jePar: db.prepare("SELECT 1 FROM par WHERE chuvicka = ? AND rodic = ?"),
    ulozOdber: db.prepare(
      "INSERT INTO odber (endpoint, rodic, data) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET rodic = excluded.rodic, data = excluded.data",
    ),
    odbery: db.prepare("SELECT endpoint, data FROM odber WHERE rodic = ?"),
    smazOdber: db.prepare("DELETE FROM odber WHERE endpoint = ?"),
    nastaveni: db.prepare("SELECT data, pozastaveno_do FROM nastaveni WHERE chuvicka = ?"),
    ulozNastaveni: db.prepare(
      "INSERT INTO nastaveni (chuvicka, data) VALUES (?, ?) ON CONFLICT(chuvicka) DO UPDATE SET data = excluded.data",
    ),
    pozastav: db.prepare(
      "INSERT INTO nastaveni (chuvicka, data, pozastaveno_do) VALUES (?, ?, ?) ON CONFLICT(chuvicka) DO UPDATE SET pozastaveno_do = excluded.pozastaveno_do",
    ),
    udalost: db.prepare("INSERT INTO udalost (chuvicka, kdy, druh, hladina, trvani) VALUES (?, ?, ?, ?, ?)"),
    udalosti: db.prepare("SELECT kdy, druh, hladina, trvani FROM udalost WHERE chuvicka = ? AND kdy >= ? ORDER BY kdy"),
    posledniHlidani: db.prepare(
      "SELECT druh FROM udalost WHERE chuvicka = ? AND druh IN ('zahajeno', 'ukonceno', 'ukonceno_rodicem') ORDER BY kdy DESC, rowid DESC LIMIT 1",
    ),
    hladina: db.prepare(
      `INSERT INTO hladina (chuvicka, minuta, max, prumer, baterie, nabiji) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chuvicka, minuta) DO UPDATE SET max = max(hladina.max, excluded.max), prumer = excluded.prumer,
         baterie = excluded.baterie, nabiji = excluded.nabiji`,
    ),
    hladiny: db.prepare("SELECT minuta, max, prumer, baterie, nabiji FROM hladina WHERE chuvicka = ? AND minuta >= ? ORDER BY minuta"),
    uklidUdalosti: db.prepare("DELETE FROM udalost WHERE kdy < ?"),
    maZmenu: db.prepare("SELECT 1 FROM zmena_prahu WHERE chuvicka = ? LIMIT 1"),
    zmenaPrahu: db.prepare("INSERT INTO zmena_prahu (chuvicka, kdy, prah_ozyva, prah_place) VALUES (?, ?, ?, ?)"),
    // Změny v okně a k tomu poslední před ním — co platilo na začátku grafu.
    prahy: db.prepare(
      `SELECT kdy, prah_ozyva AS prahOzyva, prah_place AS prahPlace FROM zmena_prahu
       WHERE chuvicka = ? AND kdy >= coalesce((SELECT max(kdy) FROM zmena_prahu WHERE chuvicka = ? AND kdy <= ?), 0)
       ORDER BY kdy`,
    ),
    uklidPrahu: db.prepare(
      `DELETE FROM zmena_prahu WHERE kdy < ? AND rowid NOT IN
         (SELECT max(rowid) FROM zmena_prahu GROUP BY chuvicka)`,
    ),
    uklidHladin: db.prepare("DELETE FROM hladina WHERE minuta < ?"),
    vlozZvuk: db.prepare("INSERT INTO zvuk (id, nazev, mime, velikost, vytvoreno, nahral) VALUES (?, ?, ?, ?, ?, ?)"),
    zvuky: db.prepare("SELECT id, nazev, mime, velikost, vytvoreno FROM zvuk ORDER BY nazev COLLATE NOCASE, vytvoreno"),
    zvuk: db.prepare("SELECT id, nazev, mime, velikost, vytvoreno FROM zvuk WHERE id = ?"),
    smazZvuk: db.prepare("DELETE FROM zvuk WHERE id = ?"),
    vsechnaNastaveni: db.prepare("SELECT chuvicka FROM nastaveni"),
  }

  return {
    db,
    registruj(role, nazev, jazyk = "cs") {
      const id = randomBytes(12).toString("base64url")
      const tajemstvi = randomBytes(32).toString("base64url")
      q.vloz.run(id, role, otisk(tajemstvi), nazev, ted(), ted(), jazyk)
      return { id, tajemstvi }
    },
    /** Zařízení podle id a tajemství, nebo null. */
    over(id, tajemstvi) {
      if (typeof id !== "string" || typeof tajemstvi !== "string") return null
      const z = q.najdi.get(id)
      if (!z || z.otisk !== otisk(tajemstvi)) return null
      q.videno.run(ted(), id)
      return z
    },
    zarizeni: (id) => q.najdi.get(id) ?? null,
    prejmenuj: (id, nazev) => q.prejmenuj.run(nazev, id),
    nastavJazyk: (id, jazyk) => q.nastavJazyk.run(jazyk, id),
    smazZarizeni: (id) => q.smazZarizeni.run(id),

    novyKod(chuvicka, platnostMs = 10 * 60 * 1000) {
      q.stareKody.run(ted())
      for (;;) {
        const kod = Array.from(randomBytes(6), (b) => ABECEDA[b % ABECEDA.length]).join("")
        if (q.najdiKod.get(kod)) continue
        const platiDo = ted() + platnostMs
        q.vlozKod.run(kod, chuvicka, platiDo)
        return { kod, platiDo }
      }
    },
    /** Platí kód (existuje a nevypršel)? Nespotřebuje ho. */
    platnyKod(kod) {
      const k = q.najdiKod.get(String(kod).toUpperCase().replace(/[^A-Z0-9]/g, ""))
      return Boolean(k && k.plati_do >= ted())
    },
    /** Spáruje rodiče podle kódu (jednorázový). Vrací id chůvičky, nebo null. */
    pouzijKod(kod, rodic) {
      const k = q.najdiKod.get(String(kod).toUpperCase().replace(/[^A-Z0-9]/g, ""))
      if (!k || k.plati_do < ted()) return null
      q.smazKod.run(k.kod)
      q.sparuj.run(k.chuvicka, rodic, ted())
      return k.chuvicka
    },
    rozparuj: (chuvicka, rodic) => q.rozparuj.run(chuvicka, rodic),
    rodice: (chuvicka) => q.rodice.all(chuvicka),
    chuvicky: (rodic) => q.chuvicky.all(rodic),
    jePar: (chuvicka, rodic) => Boolean(q.jePar.get(chuvicka, rodic)),

    ulozOdber: (rodic, odber) => q.ulozOdber.run(odber.endpoint, rodic, JSON.stringify(odber)),
    odbery: (rodic) => q.odbery.all(rodic).map((r) => JSON.parse(r.data)),
    smazOdber: (endpoint) => q.smazOdber.run(endpoint),

    nastaveni(chuvicka) {
      const r = q.nastaveni.get(chuvicka)
      return {
        ...srovnejNastaveni(r ? JSON.parse(r.data) : VYCHOZI),
        pozastavenoDo: r?.pozastaveno_do ?? 0,
      }
    },
    ulozNastaveni(chuvicka, data) {
      const pred = this.nastaveni(chuvicka)
      const n = srovnejNastaveni({ ...pred, ...data })
      q.ulozNastaveni.run(chuvicka, JSON.stringify(n))
      // Historie prahů — graf noci kreslí, co v kterou chvíli platilo.
      // Při první změně se uloží i dosavadní prahy jako „odjakživa".
      if (n.prahOzyva !== pred.prahOzyva || n.prahPlace !== pred.prahPlace) {
        if (!q.maZmenu.get(chuvicka)) q.zmenaPrahu.run(chuvicka, 0, pred.prahOzyva, pred.prahPlace)
        q.zmenaPrahu.run(chuvicka, ted(), n.prahOzyva, n.prahPlace)
      }
      return this.nastaveni(chuvicka)
    },
    /** Prahy v čase od `od`: první záznam je to, co platilo na začátku. */
    prahy(chuvicka, od) {
      const r = q.prahy.all(chuvicka, chuvicka, od)
      if (r.length) return r
      const n = this.nastaveni(chuvicka)
      return [{ kdy: 0, prahOzyva: n.prahOzyva, prahPlace: n.prahPlace }]
    },
    pozastav(chuvicka, doKdy) {
      q.pozastav.run(chuvicka, JSON.stringify(this.nastaveni(chuvicka)), doKdy)
    },

    /** „zahajeno", „ukonceno", „ukonceno_rodicem", nebo null — jak hlídání naposledy skončilo či začalo. */
    posledniHlidani: (chuvicka) => q.posledniHlidani.get(chuvicka)?.druh ?? null,
    zapisUdalost: (chuvicka, druh, hladina = null, trvani = null) =>
      q.udalost.run(chuvicka, ted(), druh, hladina, trvani),
    udalosti: (chuvicka, od) => q.udalosti.all(chuvicka, od),
    zapisHladinu: (chuvicka, minuta, max, prumer, baterie = null, nabiji = null) =>
      q.hladina.run(chuvicka, minuta, max, prumer, baterie ?? null, nabiji === null || nabiji === undefined ? null : Number(nabiji)),
    hladiny: (chuvicka, odMinuty) => q.hladiny.all(chuvicka, odMinuty),

    /** Nahrané zvuky (ukolébavky, budíčky) — sdílené všemi zařízeními. */
    pridejZvuk(id, nazev, mime, velikost, nahral) {
      q.vlozZvuk.run(id, nazev, mime, velikost, ted(), nahral)
      return q.zvuk.get(id)
    },
    zvuky: () => q.zvuky.all(),
    zvuk: (id) => q.zvuk.get(id) ?? null,
    smazZvuk: (id) => q.smazZvuk.run(id),
    /** Id chůviček s uloženým nastavením — kvůli budíčkům se smazaným zvukem. */
    chuvickySNastavenim: () => q.vsechnaNastaveni.all().map((r) => r.chuvicka),

    /** Historie se drží týden. */
    uklid(dnu = 7) {
      const hranice = ted() - dnu * 86400_000
      q.uklidUdalosti.run(hranice)
      q.uklidHladin.run(Math.floor(hranice / 60000))
      q.uklidPrahu.run(hranice)
      q.stareKody.run(ted())
    },
  }
}
