# Security

*Česky níže.*

## Reporting a vulnerability

Please report security issues privately through
[GitHub security advisories](https://github.com/toomaaseek/chuvicka-baby-monitor/security/advisories/new),
not in a public issue. Only the latest version is supported.

## What the app protects

- **Pairing:** a parent phone can join a baby unit only with a one-time
  code shown on the baby unit (valid 10 minutes, attempts are limited per
  client address).
- **Devices:** each phone has a random secret; the database stores only
  its SHA-256 hash.
- **Audio:** nothing from the microphone is stored. Listening in streams
  only while a parent is listening.
- **Photos:** a photo on request stays in the server's memory for 5
  minutes, never on disk.
- **The page:** strict Content Security Policy (own scripts only, no
  third-party connections), `frame-ancestors 'none'`.
- **Crying recognition** runs on the baby unit; MediaPipe's usage
  statistics to Google are dropped.

## What you need to take care of

- **HTTPS.** Run the app only behind HTTPS. Audio and settings travel
  between the phones and the server encrypted by TLS, but they are not
  end-to-end encrypted: whoever controls the server can listen in.
- **Who can add a phone.** Without `CHUVICKA_HESLO`, anyone who knows the
  address can register a phone. They can't reach a baby unit without a
  pairing code, but they can see and upload shared sounds. Set a password
  for a server reachable from the internet.
- **Client address behind a proxy.** Set `CHUVICKA_IP_HLAVICKA` to the
  header your reverse proxy sets, otherwise the attempt limit counts the
  proxy's address. Never set it without a proxy: a client could forge it.
- **Backups** of the `data` volume contain device secrets' hashes and the
  night history; keep them private.

---

# Bezpečnost

## Hlášení zranitelnosti

Bezpečnostní chyby hlaste prosím neveřejně přes
[GitHub security advisories](https://github.com/toomaaseek/chuvicka-baby-monitor/security/advisories/new),
ne ve veřejném issue. Podporovaná je jen poslední verze.

## Co aplikace chrání

- **Párování:** telefon rodiče se k chůvičce připojí jen jednorázovým
  kódem z chůvičky (platí 10 minut, pokusy z jedné adresy jsou omezené).
- **Zařízení:** každý telefon má náhodné tajemství, databáze zná jen jeho
  otisk SHA-256.
- **Zvuk:** z mikrofonu se nic neukládá. Příposlech běží, jen když rodič
  poslouchá.
- **Fotky:** fotka na vyžádání zůstává jen v paměti serveru 5 minut,
  nikdy na disku.
- **Stránka:** přísná Content Security Policy (jen vlastní skripty, žádná
  spojení ven), `frame-ancestors 'none'`.
- **Rozpoznání pláče** běží v telefonu u dítěte; statistiky MediaPipe pro
  Google se zahazují.

## Na co si dát pozor

- **HTTPS.** Aplikaci provozujte jen za HTTPS. Zvuk i nastavení jdou mezi
  telefony a serverem šifrované TLS, ale ne koncově: kdo ovládá server,
  může poslouchat.
- **Kdo přidá telefon.** Bez `CHUVICKA_HESLO` zaregistruje telefon
  kdokoli, kdo zná adresu. K chůvičce se bez kódu nedostane, ale uvidí
  a může nahrávat společné zvuky. Pro server dostupný z internetu
  nastavte heslo.
- **Adresa klienta za proxy.** Nastavte `CHUVICKA_IP_HLAVICKA` na
  hlavičku od vaší reverzní proxy, jinak limit pokusů počítá adresu proxy.
  Bez proxy ji nenastavujte: klient by ji mohl podvrhnout.
- **Zálohy** svazku `data` obsahují otisky tajemství zařízení a historii
  nocí; nedávejte je z ruky.
