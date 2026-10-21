# Chůvička

[![CI](https://github.com/toomaaseek/chuvicka-baby-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/toomaaseek/chuvicka-baby-monitor/actions/workflows/ci.yml)

*Čeština: [README.cs.md](README.cs.md)*

A baby monitor made of two phones and your own small server. One phone
stays in the baby's room and listens; the other one belongs to the parent.
It gets a push notification when the baby stirs or cries and can listen in,
talk to the baby, ask for a photo, play a lullaby or white noise and ring a
morning alarm with a sunrise. Optionally the baby unit recognises crying, so
adults talking, TV or a vacuum cleaner don't wake you up.

It is a web app (PWA). Nothing to install from a store, no accounts and no
cloud service in between: the phones talk to a server you run yourself.

**Chůvička** is Czech for a baby monitor (and a nanny). The app speaks
English and Czech and follows the phone's language; there is a switch in
the settings.

<table>
  <tr>
    <td align="center" valign="top"><img src="docs/screenshots/en-rodic.png" width="190" alt="Parent phone"><br><sub>Parent phone</sub></td>
    <td align="center" valign="top"><img src="docs/screenshots/en-historie.png" width="190" alt="Night history with sleep summary"><br><sub>Night history with sleep summary</sub></td>
    <td align="center" valign="top"><img src="docs/screenshots/en-fotka.png" width="190" alt="Photo on request"><br><sub>Photo on request</sub></td>
    <td align="center" valign="top"><img src="docs/screenshots/en-nastaveni.png" width="190" alt="Settings: crying recognition"><br><sub>Settings: crying recognition</sub></td>
  </tr>
  <tr>
    <td align="center" valign="top"><img src="docs/screenshots/en-budik.png" width="190" alt="Alarm with sunrise"><br><sub>Alarm with sunrise</sub></td>
    <td align="center" valign="top"><img src="docs/screenshots/en-chuvicka.png" width="190" alt="Baby unit"><br><sub>Baby unit</sub></td>
    <td align="center" valign="top"><img src="docs/screenshots/en-parovani.png" width="190" alt="Pairing with a QR code"><br><sub>Pairing with a QR code</sub></td>
  </tr>
</table>

*Example data and an illustration, not a real night or child.*

## Features

- **Two levels of alerts:** *stirring* (quiet, longer sounds) and *crying*
  (loud). Thresholds and durations are adjustable, or let the baby unit
  calibrate itself to the silence of the room.
- **Crying recognition on the phone** (opt-in): before an alert goes out, a small
  model (Google's YAMNet) checks the last 3 seconds. Adults talking, music,
  TV, a vacuum cleaner or a dog don't wake you up; when the model isn't
  sure, the alert goes out anyway. Nothing leaves the phone.
- **Thresholds that follow steady noise:** a fan or white noise machine
  switched on during the night raises the thresholds instead of setting
  off alerts.
- **Push notifications** even when the parent phone is locked, plus alerts
  when the baby unit goes offline, its microphone stops or its battery
  runs low.
- **Listen in** live and **talk** to the baby (hold to talk).
- **Lullaby and noise:** built-in white, pink and brown noise and a
  lullaby, or your own uploaded songs. Fades out at the end.
- **Alarm:** rings on the baby unit at a set time, on chosen days or once,
  with its own volume and an optional **sunrise**: the baby unit's screen
  slowly brightens to a warm colour before the alarm.
- **Night history:** a graph of the sound level over the last 24 hours
  (pinch to zoom, drag to move) with thresholds, notifications, battery
  and outages, a sleep summary (wake-ups, longest quiet stretch) and a
  list of events.
- **Photo on request:** the baby unit turns its camera on for a moment
  and sends one picture, brightened in the dark.
- **Pause notifications** for a while, or stop monitoring remotely.
- Several parent phones per baby unit and several baby units per parent.
- Pairing with a one-time QR code. No accounts, no e-mail addresses.

## Privacy

- Audio from the microphone is **never stored**. It only travels to a
  parent phone while that parent is listening.
- The server keeps the sound level per minute and the events for one week,
  then deletes them.
- The only files stored are the sounds parents upload themselves.
- A photo on request is kept only in the server's memory for 5 minutes,
  never on disk.
- Crying recognition runs on the baby unit. The MediaPipe library tries
  to send anonymous usage statistics to Google; the app drops them and
  the page's Content Security Policy would block them anyway.
- Devices identify themselves with a random secret stored on the phone.
  The database keeps only its SHA-256 hash.

## Try it in 2 minutes

On any computer with Docker, no phones and no HTTPS needed:

```sh
git clone https://github.com/toomaaseek/chuvicka-baby-monitor.git
cd chuvicka-baby-monitor
cp .env.example .env
docker compose -f docker-compose.example.yml up
```

Open <http://localhost:8080> twice: in two different browsers, or in a
normal and a private window (each phone keeps its identity in the
browser's storage, so two normal windows would be the same phone). Make
one the baby unit (it uses your computer's microphone) and the other the
parent, pair them with the code and start monitoring. Push notifications need the
keys from step 2 below; everything else works.

## Requirements

- A server that can run Docker (a Raspberry Pi is enough), or Node.js 22.5
  or newer.
- **HTTPS with a valid certificate.** Browsers allow the microphone, push
  notifications and service workers only on secure origins. Use a reverse
  proxy (Caddy, nginx, Traefik) or a tunnel (Cloudflare Tunnel, Tailscale
  Funnel). The proxy must pass WebSocket connections on `/ws`.
- Phones with a current browser: Chrome on Android, or Safari on iPhone
  (iOS 16.4+). On iPhone, the app must be added to the Home Screen
  (Share › Add to Home Screen) to receive notifications.

## Running it with Docker Compose

1. Get the code and create the configuration:

   ```sh
   git clone https://github.com/toomaaseek/chuvicka-baby-monitor.git
   cd chuvicka-baby-monitor
   cp .env.example .env
   ```

2. Generate the keys for push notifications and put them into `.env`
   together with a contact address (push services require one):

   ```sh
   docker run --rm node:22-alpine npx -y web-push generate-vapid-keys
   ```

   ```ini
   VAPID_PUBLIC_KEY=BK...
   VAPID_PRIVATE_KEY=...
   VAPID_SUBJECT=mailto:you@example.com
   ```

   Keep `.env` private. If you change the keys later, every parent phone
   has to turn notifications on again.

3. Start it:

   ```sh
   cp docker-compose.example.yml docker-compose.yml
   docker compose up -d
   ```

   This pulls a ready-made image (amd64 and arm64, so a Raspberry Pi works
   too). To build it yourself, uncomment `build: .` in the compose file
   and add `--build`.

   The app listens on port 8080 (bound to `127.0.0.1` in the example, so
   only the reverse proxy on the same machine can reach it).

4. Point your HTTPS reverse proxy to `http://127.0.0.1:8080`. For Caddy:

   ```
   babymonitor.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   For nginx, include the WebSocket upgrade headers:

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header X-Real-IP $remote_addr;
       proxy_read_timeout 1h;
   }
   ```

   Then set `CHUVICKA_IP_HLAVICKA=x-real-ip` (with Cloudflare:
   `cf-connecting-ip`) so the limit on pairing attempts counts real client
   addresses. Leave it empty when there is no proxy in front of the app:
   a header sent by a client cannot be trusted.

5. Open the address on both phones. Choose *With the baby* on one and
   *With the parent* on the other, then pair them with the QR code.

### Without Docker

```sh
npm ci --omit=dev
npm run model   # downloads the YAMNet model for crying recognition (4 MB)
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com \
  node --disable-warning=ExperimentalWarning server.js
```

Data goes to `data/` next to `server.js` unless you set `DB`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | — | Keys for push notifications. Without them the app works, but no notifications are sent. |
| `VAPID_SUBJECT` | — | Contact for push services, `mailto:` or `https:`. Required for notifications. |
| `PORT` | `8080` | HTTP port. |
| `DB` | `data/chuvicka.db` (`/data/chuvicka.db` in Docker) | SQLite database file. |
| `ZVUKY` | `zvuky/` next to the database | Folder for uploaded sounds. |
| `CHUVICKA_MAX_ZVUK_MB` | `20` | Largest uploaded sound. |
| `CHUVICKA_MAX_ZVUKY_MB` | `200` | All uploaded sounds together. |
| `CHUVICKA_IP_HLAVICKA` | — | Header with the client address set by your reverse proxy, e.g. `x-real-ip` or `cf-connecting-ip`. |
| `CHUVICKA_HESLO` | — | Password needed to add a new phone. A parent phone opening the QR code of a baby unit doesn't need it. Recommended for a server reachable from the internet. |

## Backup and updates

Everything lives in the `chuvicka-data` volume: the database and the
uploaded sounds. To copy it out for a backup:

```sh
docker compose cp chuvicka:/data ./backup-$(date +%F)
```

To update:

```sh
docker compose pull && docker compose up -d
```

(When you build yourself: `git pull && docker compose up -d --build`.)

Open phones notice the new version and offer to reload. Don't restart the
server while the baby unit is monitoring: the parent would get a
"baby unit offline" alert until it reconnects (usually within seconds).

## Good to know

- **One server is for one family** or a group of people who trust each
  other. Without `CHUVICKA_HESLO`, anyone who can reach the address can
  register a phone. That alone gives no access to any baby unit (pairing
  needs a one-time code shown on the baby unit), but they would see the
  uploaded sounds, which are shared by all phones on the server. Set a
  password and only people you give it to can add a phone.
- The baby unit has to keep the app open with the screen on (the app keeps
  the screen black and locked against touches). Keep it on a charger.
  To stop a child from leaving the app, use App pinning (Android) or
  Guided Access (iPhone).
- A monitor on Wi-Fi is not a medical device. Don't rely on it where a
  missed alert would be dangerous.

## Development

The app has no build step: `public/` is served as is (ES modules), the
server is a single `server.js` with SQLite from `node:sqlite`. The code
and comments are in Czech.

Tests (Node.js 22.5+):

```sh
npm test
```

The browser test runs two phones with a simulated microphone against a
running server. It needs Playwright with Chromium and a `localhost`
address (a secure context):

```sh
npm i --no-save playwright && npx playwright install chromium
node test/prohlizec.mjs http://localhost:8080
```

Translations: the Czech text in the code is the key, the English
dictionary is `public/js/texty-en.js`. `npm test` fails when a translation
is missing.

## Security

See [SECURITY.md](SECURITY.md): what the app protects, what you need to
take care of, and how to report a vulnerability.

## License

[MIT](LICENSE)

Crying recognition uses [MediaPipe Tasks Audio](https://www.npmjs.com/package/@mediapipe/tasks-audio)
and the [YAMNet](https://ai.google.dev/edge/mediapipe/solutions/audio/audio_classifier) model,
both by Google under the Apache License 2.0. The model is downloaded at
build time, not stored in this repository.
