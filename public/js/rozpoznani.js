/**
 * Model YAMNet (MediaPipe Audio Classifier) v telefonu u dítěte.
 *
 * Načítá se jednou, líně a jen když je rozpoznávání pláče zapnuté:
 * ~11 MB (WASM a model), prohlížeč si je pak drží v mezipaměti. Když
 * načtení nevyjde (starý telefon, bez WebAssembly SIMD), chůvička hlídá
 * dál jen podle hlasitosti jako dřív.
 */

let slib = null

/**
 * MediaPipe posílá Googlu anonymní statistiky používání. Z pokoje dítěte
 * nemá odcházet nic: CSP by je zablokovala, tady se zahodí dřív (bez
 * hlášek v konzoli).
 */
const TELEMETRIE = "odml.pa.googleapis.com"
if (typeof window !== "undefined" && !window.fetch.bezTelemetrie) {
  const puvodni = window.fetch.bind(window)
  const fetchBezTelemetrie = (vstup, volby) => {
    const url = typeof vstup === "string" ? vstup : vstup?.url ?? String(vstup)
    if (url.includes(TELEMETRIE)) return Promise.resolve(new Response(null, { status: 204 }))
    return puvodni(vstup, volby)
  }
  fetchBezTelemetrie.bezTelemetrie = true
  window.fetch = fetchBezTelemetrie
}

export function nactiRozpoznani() {
  slib ??= (async () => {
    const { FilesetResolver, AudioClassifier } = await import("/vendor/mediapipe/audio_bundle.mjs")
    const sada = await FilesetResolver.forAudioTasks("/vendor/mediapipe/wasm")
    return AudioClassifier.createFromOptions(sada, {
      baseOptions: { modelAssetPath: "/vendor/yamnet.tflite" },
      maxResults: -1,
      scoreThreshold: 0.02,
    })
  })()
  slib.catch(() => (slib = null))
  return slib
}

/** Kategorie ze všech oken klipu: [{ nazev, skore }]. */
export function klasifikuj(klasifikator, vzorky, vzorkovani) {
  const vysledky = klasifikator.classify(vzorky, vzorkovani)
  return vysledky.flatMap((v) => (v.classifications?.[0]?.categories ?? []).map((c) => ({ nazev: c.categoryName, skore: c.score })))
}
