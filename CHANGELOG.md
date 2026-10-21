# Změny

Verze se zvedá v `package.json` a v `public/sw.js` (název mezipaměti),
commit nese verzi v názvu a dostane tag `vX.Y.Z`. Aplikace verzi ukazuje
v hlavičce vedle názvu.

## 0.8.0 — 20. 10. 2026
Nápady z ostatních projektů chůviček na GitHubu.
- **Rozpoznání pláče.** Než upozornění odejde, chůvička posoudí poslední
  3 s modelem YAMNet (MediaPipe, běží v telefonu). Řeč dospělých, hudba,
  televize, vysavač, pes nebo šumítko upozornění nepošlou — do historie
  se zapíše „Hluk, ne pláč — neohlášeno" a chůvička 30 s počká (ne celou
  pauzu, ať se hned následující pláč ohlásí). Když si model není jistý,
  nebo se nenačte, upozornění odejde jako dřív. Je ve výchozím stavu
  vypnuté, zapíná se v Nastavení › Citlivost (model se pak stáhne). Model se do gitu nedává: Dockerfile ho stáhne a ověří,
  bez Dockeru `npm run model`. Statistiky MediaPipe pro Google se zahazují.
- **Prahy podle stálého šumu.** Detektor každých 10 s pozná vyrovnaný
  zvuk (ventilátor, čistička) a prahy drží nad ním (rezerva jako
  kalibrace, nejvýš +20). Pláč ani řeč šum nezvednou. Rodič vidí štítek
  „Prahy nad šumem +N" a skutečné prahy na ukazateli. Vypínatelné.
- **Fotka na vyžádání.** Rodič klepne na Fotka, chůvička na chvíli zapne
  kameru (zadní nebo přední), snímek zmenší, ve tmě zesvětlí a pošle.
  Server ho drží jen v paměti 5 minut. Kameru jde na chůvičce povolit
  předem.
- **Spánkový souhrn** v historii noci: od kdy do kdy se hlídalo, počet
  probuzení (upozornění do 10 min od sebe = jedno), z toho s pláčem,
  „klid od" a nejdelší klid.
- **Nastavení v záložkách:** Citlivost, Budíček, Zvuky, Obecné. Na
  telefonu u dítěte je nastavení sbalené, když je spárovaný rodič
  (nastavuje se u něj).
- **Budíček:** vlastní hlasitost (dřív hrál hlasitostí hlasu; starší
  nastavení ji převezme) a **východ slunce** — černá obrazovka chůvičky
  se 10–30 min před budíčkem postupně rozsvítí do teplé barvy.
- Posuvník se mění jen tažením za jezdec: při posouvání nastavení prstem
  se dřív hodnota přeskočila tam, kam prst dopadl.
- **Heslo pro přidání telefonu** (`CHUVICKA_HESLO`, volitelné). Telefon
  rodiče, který otevře QR kód chůvičky, ho nepotřebuje.
- Repozitář: SECURITY.md, „vyzkoušejte za 2 minuty", GitHub Actions
  (testy včetně prohlížeče) a ve veřejném repozitáři hotový obraz
  `ghcr.io/toomaaseek/chuvicka-baby-monitor` pro amd64 i arm64.

## 0.7.0 — 20. 10. 2026
- **Angličtina.** Aplikace mluví česky nebo anglicky podle jazyka
  telefonu; přepínač „Jazyk / Language" je na úvodní obrazovce,
  v nastavení chůvičky i na telefonu u dítěte. Server si jazyk telefonu
  pamatuje a posílá v něm upozornění i chybové hlášky. Klíčem překladu
  je český text, anglický slovník `public/js/texty-en.js` hlídá test.
- **Historie noci za 24 hodin.** Graf jde roztáhnout dvěma prsty
  (na počítači kolečkem), posunout tažením a přepnout na 1 / 3 / 12 / 24 h;
  dvojí klepnutí vrátí posledních 12 hodin. Osa času se zjemní až na
  pět minut, nad grafem je zobrazený úsek.
- Kalibrace na dálku posílá rodiči čísla místo hotové věty — text si
  složí telefon rodiče ve svém jazyce.
- Bezpečnost pro veřejné nasazení: zvuky nahrává a maže jen rodič
  spárovaný s chůvičkou, všechny dohromady nejvýš 200 MB
  (`CHUVICKA_MAX_ZVUKY_MB`); adresu klienta pro limit pokusů bere server
  z hlavičky proxy jen s `CHUVICKA_IP_HLAVICKA` (dřív věřil
  `cf-connecting-ip` vždy); stránka má Content-Security-Policy;
  `VAPID_SUBJECT` je povinný (bez něj push nejde).
- README v angličtině i češtině s návodem na nasazení, licence MIT,
  `docker-compose.example.yml` a `.env.example`.

## 0.6.0 — 16. 10. 2026
- **Budíček.** V Nastavení chůvičky: zapnutí, čas, dny v týdnu (zkratky
  „Každý den" a „Po–Pá") nebo „Jen jednou" a písnička. Zvoní na chůvičce
  podle jejích hodin, když hlídá; začne potichu, za 30 s hraje naplno
  (hlasitost z nastavení), nejdéle 15 minut. Rodič vidí na kartě
  „Budíček 6:30 · Po–Pá", během zvonění „Budíček zvoní" a tlačítko
  „Vypnout budíček"; u dítěte ho vypne odemknutí obrazovky. Jednorázový
  se po zazvonění sám vypne. V historii „Zvonil budíček".
- **Vlastní zvuky.** Nastavení › Vlastní zvuky: nahrát (do 20 MB, typ
  se pozná podle obsahu souboru), přehrát na zkoušku v telefonu rodiče,
  smazat. Server je drží v `data/zvuky` a dává je všem registrovaným
  zařízením. Nahrané jdou pustit jako ukolébavka (hraje dokola) i jako
  budíček; smazaný zvuk budíček nahradí vestavěnou ukolébavkou.
- Hrající ukolébavka i budíček nespustí poplach: hlasitost se měří
  po náběhu a pak každých 15 s a prahy se zvednou nad ni (dřív jen
  jednou na začátku — budíček s pozvolným náběhem by sílil nad práh).
- Chůvička si zvuk budíčku stáhne předem (ráno nemusí být síť)
  a přehrávač odemkne už při „Začít hlídat" — iPhone jinak zvuk bez
  klepnutí nepustí.

## 0.5.1 — 9. 10. 2026
- Tlačítko Mluvit se při držení nevypíná: během mluvení se obrazovka
  rodiče nepřekresluje (každá změna stavu chůvičky dřív vyměnila
  tlačítko pod prstem), na tlačítku nejde vybrat text ani vyvolat
  nabídku dlouhým stiskem.
- Když prohlížeč stisk zruší, mluvení pokračuje a tlačítko ukáže
  „klepni pro konec" (nejdéle 2 minuty). Zrušení se zapíše do logu
  serveru (`diag`), ať je vidět, jak často a proč.

## 0.5.0 — 8. 10. 2026
- Rodič může ukončit hlídání na dálku: tlačítko „Pozastavit / ukončit",
  v okně pod pozastavením „Ukončit hlídání…" s potvrzením. Chůvička
  přestane hlídat, zastaví ukolébavku, zavře mikrofon a přestane držet
  obrazovku — telefon pak zhasne a zamkne se podle svého nastavení
  (zamknout ho webová aplikace sama neumí). Znovu se hlídá u dítěte.
- Historie a štítek rozlišují „ukončeno u dítěte" a „ukončeno
  z telefonu rodiče"; upozornění dostanou ostatní rodiče, ne ten, kdo
  ukončil.
- Otevřený odemykací panel už po 20 s nezačne hlídat znovu, když
  hlídání mezitím ukončil rodič.

## 0.4.9 — 7. 10. 2026
- Mikrofon rodiče je otevřený jen při mluvení: po puštění „Mluvit" se
  zavře za 5 s, při odchodu z aplikace hned. Dřív zůstal po prvním
  stisku otevřený napořád a telefon hlásil, že aplikace pořád poslouchá.

## 0.4.8 — 7. 10. 2026
- Ukončení hlídání na telefonu u dítěte (podržení 3 s) už není výpadek:
  rodiči přijde „Hlídání ukončeno" (informace, ne poplach), štítek
  „Hlídání ukončeno u dítěte" i po zavření aplikace. Poplach „Chůvička
  neodpovídá" jen když spojení spadne **během hlídání**.
- Historie: „Hlídání zahájeno" a „Hlídání ukončeno u dítěte"; zahájení
  se po obnoveném spojení nezapisuje znovu.

## 0.4.7 — 7. 10. 2026
- Hlídání zvuku, ne jen spojení. 7. 10. ráno se v telefonu u dítěte
  zastavilo zpracování zvuku (5:54–7:45), stránka dál posílala stav
  baterie a server hlásil „hlídá". Teď: chůvička hlídá a 45 s nepřijde
  hladina → důležité upozornění „Chůvička neslyší", událost do historie
  (výpadek zvuku v grafu a souhrnu), štítek „Neslyší" u rodiče;
  po návratu zvuku „Chůvička zase slyší".
- Telefon u dítěte zvuk sám obnovuje: při pozastavení zvukového
  kontextu, ukončení mikrofonu nebo 8 s bez hladiny ho rozběhne znovu
  (bez chybového okna, zkouší dokola, dokud hlídá).
- Mrtvý nebo ztlumený mikrofon posílá digitální ticho (hladina 0) —
  za slyšení se počítá jen hladina nad 2 (místnost má i v noci ~30).
- Důležitá upozornění (pláč, bez spojení, neslyší) vibrují stejně dlouze.

## 0.4.6 — 6. 10. 2026
- Pozastavení upozornění: 3, 7, 15 min a vlastní počet minut (1–1440).

## 0.4.5 — 6. 10. 2026
- Rodič: tlačítko „Nezhasínat obrazovku" (Wake Lock). Telefon nezhasne
  ani se nezamkne, dokud je aplikace otevřená; volba se pamatuje
  a po návratu z pozadí se zámek obnoví.

## 0.4.4 — 6. 10. 2026
- Verze i u rodiče se spárovanou chůvičkou (vedle jejího jména).
- „Zrušit zařízení" → „Zrušit spojení". Když rodič zruší spojení a
  chůvičce nezůstane žádný jiný rodič, zruší se i chůvička (vrátí se na
  začátek). Když zruší chůvička, rodiči hned zmizí ze seznamu.
- Historie noci: baterie chůvičky (zelená čára, přerušovaná při nabíjení)
  a výpadky spojení (červený pruh), souhrn nad seznamem. Baterie se
  ukládá ke každé minutě hladiny (nové sloupce `hladina.baterie/nabiji`).
- Ukazatel hladiny: barevná škála leží pevně přes celou šířku a hluk
  z ní odkrývá sloupec (dřív se celá škála natahovala a smršťovala).

## 0.4.3 — 6. 10. 2026
- Cloudflare posílá prohlížeči u `.js`/`.css` `max-age=14400` bez ohledu
  na server. Service worker proto skripty a styly stahuje s
  `cache: "no-cache"` (ověří se proti serveru, 304 když se nezměnily).

## 0.4.2 — 6. 10. 2026
- Telefony zůstávaly na staré verzi: skripty měly 5 min v mezipaměti
  prohlížeče a service worker si je při instalaci bral odtud. Teď se vše
  pokaždé ověří (ETag → 304) a instalace stahuje načisto.
- Kontrola nové verze i po návratu aplikace do popředí, nejen při startu.

## 0.4.1 — 6. 10. 2026
- Číslo verze v hlavičce vedle názvu — verze kódu, který v telefonu
  opravdu běží (`/js/verze.js` generuje server z `package.json`). Když má
  server novější, dole se nabídne „Je nová verze — načíst".

## 0.4.0 — 6. 10. 2026
- Kalibraci ticha jde spustit i z telefonu rodiče (Nastavení); průběh
  a výsledek se ukazují na tlačítku.
- „Ozývá se" má vždy nižší práh a delší dobu než „pláče". Posuvník
  ukazuje šedě pásmo, které zabírá druhá úroveň, a jezdec do něj nepustí.
  Výchozí doby jsou nově ozývá se 8 s, pláče 3 s; uložená nastavení
  v obráceném pořadí se prohodí.
- Pauza po upozornění: levá polovina posuvníku 0–60 s, pravá 1–10 min.

## 0.3.2 — 6. 10. 2026
- Historie noci: prahy v grafu jako schody podle toho, co v kterou
  chvíli platilo; změny citlivosti v seznamu událostí. Server ukládá
  každou změnu prahů (`zmena_prahu`).

## 0.3.1 — 6. 10. 2026
- Rodič: „Poslední události" se při otevření a po obnovení spojení
  načtou za posledních 12 hodin (dřív jen od otevření aplikace —
  po novém otevření byl seznam prázdný).

## 0.3.0 — 6. 10. 2026
- Úspora baterie na chůvičce: hladina se počítá ve zvukovém vlákně
  (10 zpráv/s místo ~375), na server každou sekundu jen když se rodič
  dívá nebo je hlučno, jinak po 10 s; černá obrazovka se nepřekresluje.
- Verze v aplikaci a v `/api/zdravi`.

## 0.2.0 — 6. 10. 2026
- Detekce posuvným oknem: zvuk nad prahem aspoň polovinu nastavené doby
  (pláč s nádechy dřív nespustil nic).
- Vysílačka neuvízne při dotazu na mikrofon; chůvička sama ukončí hlas
  po 3 s bez rámců.
- Změny víc posuvníků se odešlou dohromady.

## 0.1.0 — 6. 10. 2026
- První verze: chůvička a rodič, párování QR, dvě úrovně upozornění,
  kalibrace, černá obrazovka se zámkem, hlídání spojení, baterie,
  příposlech, vysílačka, ukolébavka a šum, pozastavení, historie,
  víc rodičů i chůviček.
