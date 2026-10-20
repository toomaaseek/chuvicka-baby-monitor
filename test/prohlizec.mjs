/**
 * Zkouška v prohlížeči: dva telefony (chůvička a rodič) s napodobeným
 * mikrofonem. Spouští se proti běžícímu serveru:
 *   node test/prohlizec.mjs http://localhost:8080 [adresář na snímky]
 * Potřebuje Playwright s Chromiem (npm i --no-save playwright &&
 * npx playwright install chromium), nebo PLAYWRIGHT_Z=<projekt, kde ho má>.
 */
import { createRequire } from "node:module"
const require = createRequire(process.env.PLAYWRIGHT_Z ? `${process.env.PLAYWRIGHT_Z}/package.json` : import.meta.url)
const { chromium } = (() => {
  try {
    return require("playwright")
  } catch {
    return require("@playwright/test")
  }
})()

const URL_ = process.argv[2] ?? "http://localhost:8080"
const SNIMKY = process.argv[3]
const ok = (podminka, zprava) => {
  if (!podminka) throw new Error(`✗ ${zprava}`)
  console.log(`✓ ${zprava}`)
}

// Souvislý tón místo pípání Chromia (to trvá zlomek sekundy a podle
// pravidla „aspoň polovinu času" by událost nespustilo — správně).
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const wav = join(tmpdir(), "chuvicka-ton.wav")
{
  const vzorkovani = 48000
  const vzorku = vzorkovani * 10
  const b = Buffer.alloc(44 + vzorku * 2)
  b.write("RIFF", 0); b.writeUInt32LE(36 + vzorku * 2, 4); b.write("WAVEfmt ", 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(vzorkovani, 24); b.writeUInt32LE(vzorkovani * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write("data", 36); b.writeUInt32LE(vzorku * 2, 40)
  for (let i = 0; i < vzorku; i++) b.writeInt16LE(Math.round(0.05 * 32767 * Math.sin((2 * Math.PI * 600 * i) / vzorkovani)), 44 + i * 2)
  writeFileSync(wav, b)
}

// Vlastní písnička k nahrání: 4 s tónu 440 Hz.
const pisnicka = join(tmpdir(), "Písnička.wav")
{
  const vzorkovani = 22050
  const vzorku = vzorkovani * 4
  const b = Buffer.alloc(44 + vzorku * 2)
  b.write("RIFF", 0); b.writeUInt32LE(36 + vzorku * 2, 4); b.write("WAVEfmt ", 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(vzorkovani, 24); b.writeUInt32LE(vzorkovani * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write("data", 36); b.writeUInt32LE(vzorku * 2, 40)
  for (let i = 0; i < vzorku; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / vzorkovani)), 44 + i * 2)
  writeFileSync(pisnicka, b)
}

const prohlizec = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
    `--unsafely-treat-insecure-origin-as-secure=${URL_}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
})
const telefon = { viewport: { width: 400, height: 860 }, permissions: ["microphone", "camera"], locale: "cs-CZ" }
const dite = await (await prohlizec.newContext(telefon)).newPage()
const rodic = await (await prohlizec.newContext(telefon)).newPage()
// Mikrofony rodiče taky — po mluvení se mají zavřít.
await rodic.addInitScript(() => {
  const puvodni = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  window.__mikrofony = []
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await puvodni(c)
    if (c?.audio) window.__mikrofony.push(s)
    return s
  }
})
// Mikrofony chůvičky si test schová — „umře" je, jako by je vzal budík.
await dite.addInitScript(() => {
  const puvodni = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  window.__mikrofony = []
  window.__kontexty = []
  const Kontext = window.AudioContext
  window.AudioContext = class extends Kontext {
    constructor(...a) {
      super(...a)
      window.__kontexty.push(this)
    }
  }
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await puvodni(c)
    if (c?.audio) window.__mikrofony.push(s)
    return s
  }
})
// Prohlížeč bez obrazovky Wake Lock sám odmítne — povolit jako telefon.
{
  const cdp = await rodic.context().newCDPSession(rodic)
  const { targetInfo } = await cdp.send("Target.getTargetInfo")
  await cdp.send("Browser.grantPermissions", { origin: new URL(URL_).origin, permissions: ["wakeLockScreen"], browserContextId: targetInfo.browserContextId })
}

// Počítadla binárních rámců (zvuk) na obou stranách.
const binarni = { dite: 0, rodic: 0 }
const chybyStranky = []
for (const [kdo, page] of [["dite", dite], ["rodic", rodic]]) {
  page.on("websocket", (ws) => ws.on("framereceived", (f) => typeof f.payload !== "string" && binarni[kdo]++))
  page.on("pageerror", (e) => {
    chybyStranky.push(`${kdo}: ${e.message}`)
    console.log(`! ${kdo}: ${e.message}`)
  })
  // Porušení Content-Security-Policy hlásí prohlížeč jen do konzole.
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) chybyStranky.push(`${kdo} CSP: ${m.text()}`)
  })
}

try {
  await dite.goto(URL_)
  await dite.getByRole("button", { name: "U dítěte (chůvička)" }).click()
  await dite.getByRole("button", { name: "Začít hlídat" }).waitFor()
  await dite.getByRole("button", { name: "Spárovat telefon rodiče (QR)" }).click()
  await dite.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.querySelector(".kod")?.textContent ?? ""), null, { timeout: 10000 })
  const kod = (await dite.locator(".kod").textContent()).trim()
  ok(/^[A-Z2-9]{6}$/.test(kod) && (await dite.locator(".qr svg").count()) === 1, `chůvička ukazuje QR a kód ${kod}`)
  if (SNIMKY) await dite.screenshot({ path: `${SNIMKY}/ch-qr.png` })

  await rodic.goto(URL_)
  await rodic.getByRole("button", { name: "U rodiče" }).click()
  await rodic.getByRole("button", { name: "Přidat chůvičku" }).click()
  await rodic.getByLabel("Kód z chůvičky").fill(kod.toLowerCase())
  await rodic.getByRole("button", { name: "Spárovat kódem" }).click()
  await rodic.locator("h1", { hasText: "Chůvička" }).waitFor()
  await dite.locator(".okno").waitFor({ state: "detached", timeout: 10000 })
  ok(true, "rodič spárovaný, okno s QR na chůvičce se samo zavřelo")
  ok((await rodic.locator(".stitek", { hasText: "nehlídá" }).count()) === 1, "rodič vidí: připojená, nehlídá")
  const verze = await rodic.locator("h1 .verze-cislo").textContent()
  ok(/^v\d+\.\d+\.\d+$/.test(verze), `rodič se spárovanou chůvičkou vidí verzi ${verze}`)

  // Kalibrace ticha.
  await dite.getByRole("button", { name: "Kalibrovat ticho (10 s)" }).click()
  await dite.getByRole("button", { name: /Ticho \d+ → prahy/ }).waitFor({ timeout: 20000 })
  ok(true, `kalibrace: ${await dite.getByRole("button", { name: /Ticho/ }).textContent()}`)
  if (SNIMKY) await dite.screenshot({ path: `${SNIMKY}/ch-priprava.png`, fullPage: true })

  await dite.getByRole("button", { name: "Začít hlídat" }).click()
  await dite.locator("[data-hlidani]").waitFor()
  await rodic.locator(".stitek", { hasText: "Hlídá" }).waitFor({ timeout: 10000 })
  ok(true, "chůvička hlídá (černá obrazovka), rodič vidí Hlídá")

  await rodic.waitForFunction(() => Number(document.querySelector(".hladina")?.getAttribute("aria-valuenow")) > 0, null, { timeout: 10000 })
  ok(true, `živá hladina u rodiče: ${await rodic.locator(".hladina").getAttribute("aria-valuenow")}`)

  // Mikrofon za hlídání umře (stop nevyvolá „ended" — jako tichý výpadek
  // 7. 10.): hlídač ho do pár sekund otevře znovu a zvuk zase chodí.
  const predtim = await dite.evaluate(() => window.__mikrofony.length)
  await dite.evaluate(() => window.__mikrofony.at(-1).getTracks().forEach((t) => t.stop()))
  await dite.waitForFunction((n) => window.__mikrofony.length > n, predtim, { timeout: 20000 })
  await dite.waitForFunction(() => window.__mikrofony.at(-1).getAudioTracks().every((t) => t.readyState === "live"))
  const hladinPred = await rodic.evaluate(() => Number(document.querySelector(".hladina")?.getAttribute("aria-valuenow")))
  await rodic.waitForTimeout(3000)
  ok(true, `mrtvý mikrofon chůvička sama otevřela znovu (hladina u rodiče ${hladinPred} → ${await rodic.locator(".hladina").getAttribute("aria-valuenow")})`)
  ok((await rodic.locator(".stitek", { hasText: "Neslyší" }).count()) === 0, "rodič nedostal „Neslyší“ — obnova stihla limit serveru")

  // Systém zvuk uspí (budík, hovor): kontext stojí, hladina nechodí vůbec.
  await dite.evaluate(() => window.__kontexty.at(-1).suspend())
  await dite.waitForFunction(() => window.__kontexty.at(-1).state === "running", null, { timeout: 20000 })
  ok(true, "uspaný zvuk chůvička sama znovu rozběhla")

  // Kalibrace změřila tón jako „ticho" — prahy pod něj nastaví rodič na
  // dálku; tón pak musí vytvořit událost a ta dojít rodiči.
  await rodic.getByRole("button", { name: "Nastavení" }).click()
  await rodic.getByRole("button", { name: "Kalibrovat ticho (10 s)" }).click()
  await rodic.getByRole("button", { name: /Ticho \d+ → prahy/ }).waitFor({ timeout: 20000 })
  ok(true, `kalibrace z telefonu rodiče: ${await rodic.getByRole("button", { name: /Ticho/ }).textContent()}`)
  // Ozývá se musí zůstat pod pláčem a déle — posuvník do šedého nepustí.
  await rodic.locator("#nast-prahOzyva").evaluate((e) => {
    e.value = "99"
    e.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const omezeno = Number(await rodic.locator("#nast-prahOzyva").inputValue())
  const place = Number(await rodic.locator("#nast-prahPlace").inputValue())
  ok(omezeno === place - 1, `práh ozývá se zastaven pod pláčem: ${omezeno} < ${place}`)
  for (const [id, v] of [["prahPlace", 95], ["prahOzyva", 30], ["trvaniPlace", 2], ["trvaniOzyva", 3]]) {
    await rodic.locator(`#nast-${id}`).evaluate((e, hodnota) => {
      e.value = String(hodnota)
      e.dispatchEvent(new Event("input", { bubbles: true }))
    }, v)
  }
  await rodic.waitForTimeout(800)
  await rodic.getByRole("button", { name: "Hotovo" }).click()
  await dite.waitForFunction(() => document.querySelector("#nast-prahOzyva")?.value === "30", null, { timeout: 10000 })
  ok(true, "nastavení z telefonu rodiče došlo chůvičce")
  await rodic.locator(".udalosti li.u-ozyva, .udalosti li.u-place").first().waitFor({ timeout: 20000 })
  ok(true, `rodiči došla událost: ${await rodic.locator(".udalosti li").first().textContent()}`)

  // Příposlech.
  await rodic.getByRole("button", { name: "Poslouchat" }).click()
  await rodic.waitForTimeout(3000)
  ok(binarni.rodic > 50, `příposlech: rodiči došlo ${binarni.rodic} zvukových rámců za 3 s`)
  await rodic.getByRole("button", { name: /Poslouchám/ }).click()
  const poVypnuti = binarni.rodic
  await rodic.waitForTimeout(1500)
  ok(binarni.rodic - poVypnuti < 10, "po vypnutí příposlechu zvuk přestal chodit")

  // Vysílačka — se zapnutým příposlechem (dřív se při každé změně stavu
  // překreslila obrazovka a tlačítko pod prstem se vyměnilo; mluvení
  // pak končilo hned po startu).
  await rodic.getByRole("button", { name: "Poslouchat" }).click()
  const mluvit = rodic.getByRole("button", { name: "Mluvit (podrž)" })
  const box = await mluvit.boundingBox()
  await rodic.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await rodic.mouse.down()
  await rodic.waitForTimeout(1200)
  const tlacitka = await rodic.locator("button.aktivni").allTextContents()
  ok(tlacitka.some((t) => t.startsWith("Mluvíš")), `během držení tlačítko pořád mluví (${tlacitka.join(", ")})`)
  await rodic.waitForTimeout(1300)
  await rodic.mouse.up()
  ok(binarni.dite > 50, `vysílačka: chůvičce došlo ${binarni.dite} rámců hlasu`)
  await rodic.getByRole("button", { name: "Mluvit (podrž)" }).waitFor({ timeout: 5000 })
  ok(true, "po puštění tlačítko zpět na „Mluvit (podrž)\"")
  await rodic.getByRole("button", { name: /Poslouchám/ }).click()

  // Prohlížeč stisk zruší (gesto, systémové okno): mluvení nekončí,
  // tlačítko čeká na klepnutí.
  const pred = binarni.dite
  const box2 = await rodic.locator("button.mluvit").boundingBox()
  await rodic.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2)
  await rodic.mouse.down()
  await rodic.locator("button.mluvit.aktivni").waitFor({ timeout: 5000 })
  await rodic.locator("button.mluvit").dispatchEvent("pointercancel", { pointerId: 1, pointerType: "touch" })
  await rodic.mouse.up()
  await rodic.waitForTimeout(1500)
  ok((await rodic.locator("button.mluvit").textContent()) === "Mluvíš… (klepni pro konec)", "zrušený stisk: mluví dál, čeká na klepnutí")
  ok(binarni.dite - pred > 30, `zrušený stisk: hlas dál chodí (${binarni.dite - pred} rámců)`)
  await rodic.mouse.down()
  await rodic.mouse.up()
  await rodic.getByRole("button", { name: "Mluvit (podrž)" }).waitFor({ timeout: 5000 })
  const poKonci = binarni.dite
  await rodic.waitForTimeout(1000)
  ok(binarni.dite - poKonci < 5, "klepnutí mluvení ukončilo")
  // Po puštění se mikrofon rodiče zavře (dřív zůstal otevřený napořád).
  await rodic.waitForFunction(
    () => window.__mikrofony.length > 0 && window.__mikrofony.every((s) => s.getAudioTracks().every((t) => t.readyState === "ended")),
    null,
    { timeout: 10000 },
  )
  ok(true, "po puštění Mluvit se mikrofon rodiče zavřel")

  // Ukolébavka.
  await rodic.getByRole("button", { name: "Ukolébavka" }).click()
  await rodic.getByLabel("Zvuk", { exact: true }).selectOption("ruzovy")
  await rodic.getByRole("button", { name: "Pustit" }).click()
  await rodic.getByRole("button", { name: "Ukolébavka hraje" }).waitFor({ timeout: 10000 })
  ok(true, "ukolébavka hraje, rodič to vidí")

  // Vlastní zvuk: rodič ho nahraje v nastavení, pustí jako ukolébavku.
  await rodic.getByRole("button", { name: "Nastavení" }).click()
  await rodic.locator("[data-vlastni-zvuky] input[type=file]").setInputFiles(pisnicka)
  await rodic.locator("[data-zvuk='Písnička']").waitFor({ timeout: 10000 })
  ok(true, "rodič nahrál vlastní zvuk „Písnička“")
  if (SNIMKY) await rodic.screenshot({ path: `${SNIMKY}/rodic-nastaveni-zvuky.png`, fullPage: true })
  await rodic.getByRole("button", { name: "Hotovo" }).click()
  await rodic.getByRole("button", { name: "Ukolébavka hraje" }).click()
  await rodic.getByLabel("Zvuk", { exact: true }).selectOption({ label: "Písnička" })
  await rodic.getByRole("button", { name: "Pustit" }).click()
  await rodic.getByRole("button", { name: "Ukolébavka hraje" }).click()
  await rodic.locator(".okno", { hasText: "Hraje: Písnička" }).waitFor({ timeout: 10000 })
  ok(true, "vlastní zvuk hraje na chůvičce jako ukolébavka")
  await rodic.locator(".okno").getByRole("button", { name: "Zastavit" }).click()

  // Budíček na teď, jen jednou, s nahranou písničkou.
  const ted = await dite.evaluate(() => {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  })
  await rodic.getByRole("button", { name: "Nastavení" }).click()
  const budik = rodic.locator("[data-budik]")
  await budik.getByLabel("Budíček zapnutý").check()
  await budik.getByLabel("Čas budíčku").fill(ted)
  await budik.getByLabel("Jen jednou (po zazvonění se sám vypne)").check()
  ok(await budik.getByLabel("Po", { exact: true }).isDisabled(), "budíček jen jednou: dny se nevybírají")
  await budik.getByLabel("Písnička k buzení").selectOption({ label: "Písnička" })
  await budik.getByRole("button", { name: "Uložit budíček" }).click()
  await budik.getByText(/Uloženo: \d+:\d+ · jednou/).waitFor()
  if (SNIMKY) await rodic.locator("[data-budik]").screenshot({ path: `${SNIMKY}/rodic-budik.png` })
  await rodic.getByRole("button", { name: "Hotovo" }).click()
  await rodic.locator(".stitek", { hasText: "Budíček zvoní" }).waitFor({ timeout: 25000 })
  await dite.locator("[data-hlidani]", { hasText: "Zvoní budíček" }).waitFor({ timeout: 5000 })
  ok(true, `budíček v ${ted} zvoní na chůvičce, rodič to vidí`)
  await rodic.getByRole("button", { name: "Vypnout budíček" }).click()
  await rodic.locator(".stitek", { hasText: "Budíček zvoní" }).waitFor({ state: "detached", timeout: 10000 })
  await rodic.locator(".stitek", { hasText: /^Budíček / }).waitFor({ state: "detached", timeout: 10000 })
  ok(true, "rodič budíček vypnul; jednorázový se sám vypnul")
  await rodic.locator(".udalosti li.u-budik").waitFor({ timeout: 10000 })
  ok(true, "v událostech je „Zvonil budíček“")

  // Pozastavení.
  await rodic.getByRole("button", { name: "Pozastavit / ukončit" }).click()
  const okno = rodic.locator(".okno")
  for (const m of [3, 7, 15]) await okno.getByRole("button", { name: `${m} min` }).waitFor()
  // Vlastní počet minut: neplatné číslo tlačítko nepovolí.
  await okno.getByLabel("Jiný počet minut").fill("0")
  ok(await okno.getByRole("button", { name: "Pozastavit", exact: true }).isDisabled(), "pozastavení: 0 min nejde")
  await okno.getByLabel("Jiný počet minut").fill("30")
  await okno.getByRole("button", { name: "Pozastavit", exact: true }).click()
  const stitek = rodic.locator(".stitek", { hasText: "Pozastaveno do" })
  await stitek.waitFor({ timeout: 10000 })
  const ocekavano = await rodic.evaluate(() =>
    [0, 1].map((o) => new Date(Date.now() + (30 - o) * 60000).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })),
  )
  const text = await stitek.textContent()
  ok(ocekavano.some((t) => text.includes(t)), `upozornění pozastavená ručně na 30 min: ${text}`)

  // Nastavení na dálku dojde chůvičce (projeví se v jejím posuvníku).
  if (SNIMKY) await rodic.screenshot({ path: `${SNIMKY}/rodic.png`, fullPage: true })
  await rodic.getByRole("button", { name: "Historie noci" }).click()
  await rodic.locator("canvas.graf").waitFor()
  ok(true, "historie noci se otevřela")
  // Graf jde přiblížit (kolečko / dva prsty), posunout a vrátit na 24 h.
  const rozsahGrafu = rodic.locator(".okno .radek.mezi > span").first()
  const celyGraf = await rozsahGrafu.textContent()
  const g = await rodic.locator("canvas.graf").boundingBox()
  await rodic.mouse.move(g.x + g.width * 0.8, g.y + g.height / 2)
  await rodic.mouse.wheel(0, -400)
  const priblizeny = await rozsahGrafu.textContent()
  ok(priblizeny !== celyGraf, `kolečko graf přiblíží: ${celyGraf} → ${priblizeny}`)
  await rodic.mouse.down()
  await rodic.mouse.move(g.x + g.width * 0.2, g.y + g.height / 2, { steps: 5 })
  await rodic.mouse.move(g.x + g.width * 0.9, g.y + g.height / 2, { steps: 5 })
  await rodic.mouse.up()
  ok((await rozsahGrafu.textContent()) !== priblizeny, `tažení graf posune: ${await rozsahGrafu.textContent()}`)
  await rodic.getByRole("button", { name: "24 h" }).click()
  ok((await rodic.getByRole("button", { name: "24 h" }).getAttribute("aria-pressed")) === "true", "volba 24 h ukáže celý den")
  if (SNIMKY) await rodic.screenshot({ path: `${SNIMKY}/rodic-historie.png` })
  await rodic.getByRole("button", { name: "Zavřít" }).click()

  // Nezhasínat obrazovku: přepínač drží Wake Lock a volba přežije nové otevření.
  await rodic.getByRole("button", { name: "Nezhasínat obrazovku" }).click()
  await rodic.getByRole("button", { name: "Obrazovka nezhasne ■" }).waitFor()
  await rodic.locator("button[aria-pressed] + p", { hasText: "nezhasne ani se nezamkne" }).waitFor()
  ok(await rodic.evaluate(() => document.visibilityState === "visible"), "nezhasínat obrazovku: zámek obrazovky drží")

  // Po novém otevření aplikace rodič vidí dřívější události (z historie).
  await rodic.reload()
  await rodic.getByRole("button", { name: "Obrazovka nezhasne ■" }).waitFor()
  ok(true, "volba nezhasínat zůstala po novém otevření")
  await rodic.getByRole("button", { name: "Obrazovka nezhasne ■" }).click()
  await rodic.locator(".udalosti li.u-ozyva, .udalosti li.u-place").first().waitFor({ timeout: 15000 })
  ok(true, "po novém otevření jsou poslední události pořád vidět")

  // Ukončení hlídání z telefonu rodiče: chůvička přestane hlídat
  // a zavře mikrofon, rodič vidí, kdo hlídání ukončil.
  await rodic.getByRole("button", { name: /Pozastav/ }).click()
  await rodic.locator(".okno").getByRole("button", { name: "Ukončit hlídání…" }).click()
  await rodic.locator(".okno").getByRole("button", { name: "Ano, ukončit" }).click()
  await dite.getByRole("heading", { name: "Hlídání ukončil rodič" }).waitFor({ timeout: 10000 })
  ok((await dite.locator("[data-hlidani]").count()) === 0, "na dálku ukončené hlídání: černá obrazovka zmizela")
  await dite.waitForFunction(() => window.__mikrofony.every((s) => s.getAudioTracks().every((t) => t.readyState === "ended")))
  ok(true, "chůvička po ukončení na dálku zavřela mikrofon")
  await rodic.locator(".stitek", { hasText: "Hlídání ukončeno z telefonu rodiče" }).waitFor({ timeout: 10000 })
  ok(true, "rodič vidí „Hlídání ukončeno z telefonu rodiče“")
  // Znovu hlídat — dál se zkouší zámek.
  await dite.getByRole("button", { name: "Rozumím" }).click()
  await dite.getByRole("button", { name: "Začít hlídat" }).click()
  await dite.locator("[data-hlidani]").waitFor({ timeout: 10000 })
  await rodic.locator(".stitek", { hasText: /^Hlídá$/ }).waitFor({ timeout: 10000 })
  ok(true, "u dítěte jde hlídání znovu zapnout")

  // Zámek: krátký dotyk nic, podržení 3 s odemkne.
  const vrstva = dite.locator("[data-hlidani]")
  await vrstva.click()
  ok((await dite.getByRole("button", { name: "Ukončit hlídání" }).count()) === 0, "krátký dotyk zámek neodemkne")
  const v = await vrstva.boundingBox()
  await dite.mouse.move(v.width / 2, v.height / 2)
  await dite.mouse.down()
  await dite.waitForTimeout(3300)
  await dite.mouse.up()
  await dite.getByRole("button", { name: "Ukončit hlídání" }).click()
  await dite.getByRole("button", { name: "Začít hlídat" }).waitFor()
  await rodic.locator(".stitek", { hasText: "Hlídání ukončeno u dítěte" }).waitFor({ timeout: 10000 })
  ok(true, "podržení 3 s odemklo, hlídání skončilo a rodič vidí „Hlídání ukončeno u dítěte“")

  // Po ukončení hlídání aplikaci zavřít není výpadek: žádné „Bez spojení".
  await dite.close()
  await rodic.waitForTimeout(3000)
  ok((await rodic.locator(".stitek", { hasText: "Bez spojení" }).count()) === 0, "zavřená chůvička po ukončení → žádné „Bez spojení“")
  ok((await rodic.locator(".stitek", { hasText: "Hlídání ukončeno u dítěte" }).count()) === 1, "rodič dál vidí „Hlídání ukončeno u dítěte“")

  // Angličtina: telefon v angličtině dostane anglickou aplikaci,
  // přepínač jazyka ji přepne a volba se pamatuje.
  const anglicky = await (await prohlizec.newContext({ ...telefon, locale: "en-US" })).newPage()
  anglicky.on("pageerror", (e) => chybyStranky.push(String(e)))
  anglicky.on("console", (m) => /Content Security Policy/i.test(m.text()) && chybyStranky.push(`en CSP: ${m.text()}`))
  await anglicky.goto(URL_)
  await anglicky.getByRole("heading", { name: "This phone will be…" }).waitFor()
  ok((await anglicky.evaluate(() => document.documentElement.lang)) === "en", "telefon v angličtině: aplikace anglicky")
  await anglicky.getByLabel("Jazyk / Language").selectOption("cs")
  await anglicky.getByRole("heading", { name: "Tenhle telefon bude…" }).waitFor()
  await anglicky.reload()
  await anglicky.getByRole("heading", { name: "Tenhle telefon bude…" }).waitFor()
  ok(true, "přepnutí na češtinu se pamatuje")
  await anglicky.getByLabel("Jazyk / Language").selectOption("en")
  await anglicky.getByRole("button", { name: "With the parent" }).click()
  await anglicky.getByRole("heading", { name: "No baby unit yet" }).waitFor()
  const chybaEn = await anglicky.evaluate(() =>
    fetch("/api/sparovat", { method: "POST", headers: { "X-Jazyk": "en", "X-Zarizeni": "x:y" } }).then((r) => r.json()),
  )
  ok(chybaEn.chyba === "This device is not registered.", `chyby serveru v jazyce telefonu: ${chybaEn.chyba}`)

  ok(chybyStranky.length === 0, `žádná chyba stránky${chybyStranky.length ? `: ${chybyStranky.join("; ")}` : ""}`)
} finally {
  await prohlizec.close()
}
