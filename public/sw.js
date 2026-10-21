/**
 * Service worker chůvičky: aplikace se otevře i bez sítě (ukáže, že
 * spojení chybí) a hlavně doručuje upozornění, i když je telefon zamčený.
 */
// Při vydání nové verze zvednout spolu s package.json — změna názvu
// mezipaměti donutí telefony stáhnout soubory znovu.
const VERZE = "chuvicka-v0.8.0"
const SOUBORY = [
  "/",
  "/app.css",
  "/manifest.webmanifest",
  "/js/app.js",
  "/js/verze.js",
  "/js/dom.js",
  "/js/spojeni.js",
  "/js/chuvicka.js",
  "/js/rodic.js",
  "/js/detekce.js",
  "/js/mulaw.js",
  "/js/zvuk.js",
  "/js/zvuk-worklet.js",
  "/js/zvuky.js",
  "/js/budik.js",
  "/js/nastaveni.js",
  "/js/skener.js",
  "/js/i18n.js",
  "/js/spanek.js",
  "/js/fotka.js",
  "/js/plac.js",
  "/js/rozpoznani.js",
  "/js/texty-en.js",
  "/ikony/ikona-192.png",
  "/ikony/ikona-96.png",
]

self.addEventListener("install", (e) => {
  // cache: "reload" — jinak by do nové mezipaměti mohly přijít staré soubory.
  e.waitUntil(
    caches
      .open(VERZE)
      .then((c) => c.addAll(SOUBORY.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((klice) => Promise.all(klice.filter((k) => k !== VERZE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// Napřed síť (ať se aktualizace dostane hned), bez sítě z mezipaměti.
// Skripty a styly vždy s ověřením: Cloudflare přidává max-age 4 h a
// prohlížeč by jinak po vydání podstrčil staré. Navigace jde beze změny
// (Request s režimem navigate nejde s volbami znovu sestavit).
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url)
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname === "/ws") return
  e.respondWith(
    fetch(e.request.mode === "navigate" ? e.request : new Request(e.request, { cache: "no-cache" }))
      .then((r) => {
        if (r.ok) caches.open(VERZE).then((c) => c.put(e.request, r.clone()))
        return r
      })
      .catch(() => caches.match(e.request).then((r) => r ?? caches.match("/"))),
  )
})

self.addEventListener("push", (e) => {
  let d = {}
  try {
    d = e.data.json()
  } catch {
    d = { titulek: "Chůvička", text: e.data?.text() ?? "" }
  }
  const dulezite = d.uroven === "place" || d.uroven === "offline"
  e.waitUntil(
    self.registration.showNotification(d.titulek ?? "Chůvička", {
      body: d.text ?? "",
      tag: d.tag ?? "chuvicka",
      renotify: true,
      // Pláč a výpadek spojení zůstanou na obrazovce, dokud je rodič neodklepne.
      requireInteraction: dulezite,
      vibrate: dulezite ? [600, 200, 600, 200, 600] : [250],
      icon: "/ikony/ikona-192.png",
      badge: "/ikony/ikona-96.png",
      data: { url: "/" },
    }),
  )
})

self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((okna) => {
      const okno = okna.find((o) => new URL(o.url).origin === location.origin)
      return okno ? okno.focus() : self.clients.openWindow("/")
    }),
  )
})
