// Stáhne model YAMNet pro rozpoznání pláče (při běhu bez Dockeru; Dockerfile
// to dělá sám). Ověří kontrolní součet. Použití: npm run model
import { createHash } from "node:crypto"
import { writeFile, mkdir } from "node:fs/promises"

const URL_ = "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite"
const SHA256 = "4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf"
const CIL = new URL("../public/vendor/yamnet.tflite", import.meta.url)

const r = await fetch(URL_)
if (!r.ok) throw new Error(`Stažení selhalo: ${r.status}`)
const data = Buffer.from(await r.arrayBuffer())
const otisk = createHash("sha256").update(data).digest("hex")
if (otisk !== SHA256) throw new Error(`Nesedí kontrolní součet: ${otisk}`)
await mkdir(new URL(".", CIL), { recursive: true })
await writeFile(CIL, data)
console.log(`Model uložen: ${CIL.pathname} (${Math.round(data.length / 1024)} kB)`)
