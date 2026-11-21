# Ontgrendeltijd na herladen: meting en diagnose (idee #236, taak 515)

Alleen onderzoek. Er is **geen app-code, geen Argon2id-parameter, geen SRP- en geen AES-GCM-code
gewijzigd** (Argon2id blijft `t=3, m=65536, p=2, dkLen=32`, `app/static/js/crypto-worker.js:6`).
Dit bouwt voort op `docs/UNLOCK_CHECKING_DIAG.md` (taken #96/#118), dat al een watchdog en een
`finally` in `submitUnlockForm` heeft opgeleverd; hier is opnieuw gemeten of daarna nog iets hangt.

## Conclusie

**Geen fout, alleen traag.** In 5 van 5 metingen na herladen rondde de afleiding af en kwam de
kluis open; de knop stond de hele tijd op `Checking…` (uitgeschakeld) met `Deriving key…` en komt
daarna vanzelf terug. De derivatie draait in een Web Worker, maar als **pure JS** (geen WASM),
en dat kost 3,6–4,7 s op deze machine. Op een tragere telefoon of drukke browser duurt dezelfde
afleiding evenredig langer; dat is niet gemeten en is de waarschijnlijke verklaring voor de
"blijft hangen" van de beta-tester.

## Meetopzet

- Headless Chromium (Playwright, `chromium.launch(headless=True)`), tijdelijke lokale server via
  `start_server` uit `tests/e2e_signup_autounlock.py`, registreren via `/register`
  (`complete_recovery_key_step`), daarna per meting: `#btn-lock-now` → herladen van `/app` →
  wachtwoord invullen → klik op `#unlock-submit` → wachten tot `NotesStore.isUnlocked()` en
  `body.unlocked`. De tijd loopt van klik tot ontgrendeld (`time.perf_counter`).
- Instrumentatie via `add_init_script`: elke `new Worker(...)` (URL, `postMessage`, antwoorden,
  `error`-events), `unhandledrejection`/`error` op de pagina, en een `MutationObserver` op de
  knop. Het meetscript staat niet in de repo. Eén machine, geen CPU-throttling.

## Gemeten tijden (klik → ontgrendeld)

| # | totaal (ms) | worker `postMessage` (ms na klik) | antwoord van worker (ms na klik) |
|---|---|---|---|
| 1 | 4554 | 76 | 3595 |
| 2 | 4521 | 65 | 3586 |
| 3 | 4916 | 66 | 3927 |
| 4 | 4962 | 58 | 3985 |
| 5 | 5892 | 67 | 4738 |

Min / mediaan / max: **4521 / 4916 / 5892 ms**. Een eerdere run van dezelfde opzet gaf
4721, 4557, 4591, 4651, 4525 ms (min/mediaan/max 4525 / 4591 / 4721). Het verschil tussen totaal
en workerantwoord (≈ 0,9–1,2 s) is lokale kluis-ontsleuteling, `/api/health` + `/api/account` en
UI-opbouw.

## (a) Welke implementatie draaide

- `app/static/js/crypto-worker.0f28b964f018c3fb.js` (de gehashte kopie van `crypto-worker.js`)
  werd aangemaakt en kreeg `postMessage`; antwoord kwam van de worker. Dus: **worker, niet de
  hoofdthread-terugval**, in alle metingen (precies één Worker per ontgrendeling, 0 `error`-events).
- De afleiding zelf is **pure JS**: `crypto-worker.js:2` laadt `vendor/noble-argon2.js`. Er is
  geen WASM-bestand in `app/static/js` en `crypto*.js`/`store.js` verwijzen niet naar
  `WebAssembly`. Er is dus niets dat na herladen "niet start" en niets dat terugvalt van WASM naar
  JS; de trage JS-versie ís de normale route.
- De hoofdthread-terugval bestaat wel (`store.js:512-515` roept `NotesCrypto.deriveKey` aan als de
  worker faalt), maar is niet geraakt.

## (b) Kan de afleiding ooit niet afronden?

- In de metingen: nee. 5 van 5 rondden af; geen `unhandledrejection`, geen `pageerror`, geen
  worker-`error`.
- Theoretisch alleen als de worker stil verdwijnt zonder `error`. `workerCall`
  (`crypto.js:407`) heeft sinds taak #118 een watchdog van 90 s (`WORKER_TIMEOUT_MS`,
  `crypto.js:363`) die de waiter rejected en de worker beëindigt; `store.js` valt dan terug op de
  hoofdthread. Een volledig oneindige hang is dus uitgesloten; de slechtste vorm is ≈ 90 s
  wachten gevolgd door een nog tragere hoofdthread-afleiding.
- Dubbele klik: de knop is al `disabled` en `unlockInFlight` (`app.js:7652`, `9302`)
  dedupliceert; eerder gemeten (zie `UNLOCK_CHECKING_DIAG.md`) één afleiding, één ontgrendeling.

## (c) Wordt de knop bij een fout vrijgegeven

Ja. In een zesde ontgrendeling in dezelfde sessie weigerde de server met "Too many unlock
attempts. Wait a few minutes and try again." (rate limit, `app.js:8365`/`9435`/`9622`). Na de
afleiding (3,7 s) stond de knop weer op `Unlock`, enabled, met de foutmelding in `#unlock-error`;
het slotscherm bleef zichtbaar. De `catch` in `submitUnlockForm` (`app.js:9785-9795`) en het
`finally` (`app.js:9797-9801`) doen dit. Let op dat die zesde poging dus pas na de volle
Argon2id-afleiding faalt: de gebruiker wacht ≈ 4 s vóór hij de rate-limit ziet.

## Wat de volgende taak moet aanpassen

De app mist geen foutafhandeling meer; de enige zichtbare winst zit in snelheid en uitleg.

1. **Snelheid (vraagt een aparte beslissing over de beveiligingsmarge, parameters blijven gelijk):**
   vervang de pure-JS-afleiding door een WASM-Argon2id met dezelfde `t/m/p/dkLen` en identieke
   uitvoer. Bestanden: `app/static/js/crypto-worker.js` (`importScripts` op regel 2 en de
   Argon2-aanroep rond regel 6), `app/static/js/vendor/noble-argon2.js`, `app/static/js/crypto.js`
   `deriveKey` (regel ≈ 79, hoofdthread-terugval) en de vendoring/`THIRD_PARTY.md`. Test: gelijke
   afgeleide sleutel als de huidige JS voor vaste invoer (`tests/test_vault_kdf_unlock.js`,
   `tests/test_kdf_unlock_after_reload.js`).
2. **Voortgang/uitleg tijdens de ±4 s:** `app/static/js/app.js` `renderLoginProgressFrame`
   (regel 7735) en het label rond regel 7697/7739 (`Deriving key…`): na een drempel een tekst als
   "Dit kan op een telefoon een halve minuut duren" in `#unlock-status`.
3. **Rate-limit sneller melden:** controleer in `verifyAndUnlock` (`app.js:9284`, de takken op
   `9435`/`9622`) of de server-check vóór de Argon2id-afleiding kan lopen, zodat de gebruiker de
   limiet niet pas na ≈ 4 s ziet.

De bestaande watchdog-test `tests/test_unlock_worker_watchdog.js` dekt de hang-paden al; er is
daarom in deze taak geen extra reproductietest toegevoegd.

## Wijziging (taak 516)

**Oorzaak.** De diagnose hierboven blijft staan: geen belofte die niet afrondt, geen worker die na
herladen niet start, en geen trage terugval terwijl WASM beschikbaar is (er is geen WASM). De
traagheid is de pure-JS Argon2id zelf. Die sneller maken (punt 1 hierboven) betekent nieuwe
crypto-code en een nieuwe vendored bibliotheek; deze taak eist dat Argon2id-parameters en
crypto-code ongewijzigd blijven, dus dat is hier **niet** gedaan en blijft een aparte beslissing.
`crypto.js`, `crypto-worker.js` en `vendor/` zijn niet aangeraakt; SRP ook niet.

Wat wel veranderd is:

- **Verstreken tijd, geen percentage.** Tijdens `Deriving key…` toont de status `Deriving key… N s`
  (`renderLoginProgressFrame`, `app/static/js/app.js:7771`). Een timer van 1 s start in
  `beginLoginProgress` (`app.js:7901`) en stopt in `dismissLoginProgress` (`app.js:7934`). Het
  getal staat in een `aria-hidden` span, zodat de `aria-live`-status niet elke seconde voorleest.
- **Ruime grens: `UNLOCK_DERIVE_TIMEOUT_MS = 300000` (5 min, `app.js:7681`).** Eén
  `NotesStore.unlock` kan meerdere Argon2id-runs doen (beide KDF-versies scoren, alt-sleutel bij een
  gemengde kluis). De grens ligt daarom ruim boven de worker-watchdog van 90 s
  (`crypto.js:363`), zodat watchdog plus hoofdthread-terugval eerst hun kans krijgen; gemeten is
  4,5–5,9 s per ontgrendeling op deze machine. Een apparaat dat meer dan 5 min nodig heeft, krijgt
  de melding; dat is niet gemeten op echte trage hardware.
- **Afbreken in plaats van doorlaten.** `unlockWithDeadline` (`app.js:7703`) begrenst de vier
  `NotesStore.unlock`-aanroepen in de ontgrendelflow. Bij de grens roept het
  `NotesStore.cancelUnlock()` (`store.js:521`) aan: de poging wordt als geannuleerd gemarkeerd en
  de crypto-worker wordt beëindigd (`NotesCrypto.terminateWorker`), zodat een nieuwe poging niet
  achter de oude Argon2-run wacht. De knop komt terug op `Unlock` met "Unlocking took too long.
  Your vault is still locked. Try again." in `#unlock-error`.
- **Een late poging raakt de kluis niet.** Elke `unlock()` krijgt een eigen poging-object
  (`store.js:789`). Na elke `await` op het ontgrendelpad wordt gecontroleerd of de poging
  geannuleerd is; een geannuleerde poging start geen hoofdthread-terugval (`store.js:542`) en
  schrijft nooit `cryptoKey`, `altCryptoKey`, `kdfVersion` of `kdfProbeMixed`. De sleutelstatus
  wordt pas op één commit-punt na alle afleidingen gezet (`store.js:829`). Er is dus geen late
  `lock()` meer nodig. Een nieuwe `unlock()` annuleert een oudere die nog afleidt, en `lock()`
  (`store.js:899`) annuleert een lopende afleiding. Een poging die al gecommit heeft, kan niet meer
  geannuleerd worden; dan wacht `unlockWithDeadline` gewoon op het einde.
- **Beperking.** Als de worker al faalde en de hoofdthread-terugval loopt, kan die run niet
  onderbroken worden; het resultaat wordt alleen weggegooid.

Tests: `tests/test_unlock_cancel.js` (node: annuleren, worker beëindigd zonder terugval, late
uitkomst laat een nieuwere ontgrendeling en `lockEpoch` ongemoeid, `lock()` tijdens afleiding) en
`tests/e2e_unlock_derive_progress.py` (Playwright, echte worker: oplopende seconden na herladen,
gesimuleerde fout geeft de knop vrij met kluis vergrendeld, en een te late afleiding met verkeerd
wachtwoord die in dezelfde pagina wordt overgedaan: worker beëindigd, kluis blijft daarna open met
dezelfde sleutel, en een nieuwe notitie wordt opgeslagen en gesynchroniseerd).
