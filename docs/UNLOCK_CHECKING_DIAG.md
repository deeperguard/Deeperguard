# Diagnose: ontgrendelen blijft op "Checking…" staan (idee #96)

Status: onderzoek, alleen documentatie. Er is **geen app-code en geen KDF-parameter gewijzigd**
(Argon2id blijft `t=3, m=65536, p=2, dkLen=32`, `app/static/js/crypto.js:4` en
`app/static/js/crypto-worker.js:6`).

## Conclusie

**Alleen traag zonder voortgang. Geen deterministische fout in de app.**

- Alle 7 gemeten ontgrendelingen (6 normaal, 1 dubbele klik) eindigen vanzelf, de knop komt telkens
  terug op `Unlock` en het slotscherm verdwijnt. Totaal ≈ 3,9–4,1 s op een desktop-CPU.
- ≈ 93–95 % van die tijd is één Argon2id-afleiding in de crypto-worker (3,67–3,87 s). Netwerk
  (`/api/health` + `/api/account`) is samen ≈ 15 ms, het laden/ontsleutelen van de kluis ≈ 0,1 s.
- Tijdens die 3,8 s verandert er voor de gebruiker niets: de knop staat vast op `Checking…`
  (bewust, `app.js:6534-6536`) en er is geen zichtbaar voortgangslabel. Op een tragere telefoon of
  een bezette beta-browser duurt dezelfde afleiding evenredig langer; dat is niet gemeten, maar
  wel wat de tester als "blijft hangen" ervaart.
- Het is dus geen testartefact van de headless omgeving (de meting is zelf een echte Chromium) en
  geen reproduceerbare vaste hang. Er zijn wel **latente paden** waarin de knop echt vast kan
  blijven (zie "Codepaden"); die zijn in de metingen niet geraakt en kunnen de runs 28/33 niet
  bevestigen of uitsluiten. De logs van die runs zaten niet in deze omgeving.

## Meetopzet

- Echte headless Chromium (`/usr/bin/chromium`, Playwright, `bypass_csp` alleen zodat de harnas
  `evaluate` mag draaien), lokale Flask-server (`flask run`, eigen tempmap, `NOTES_SKIP_LOGIN=0`).
- Account geregistreerd via `/register`, 3 notities geseed en gesynct, daarna per meting: opgeslagen
  apparaatwachtwoord gewist, `/app` herladen, wachtwoord ingevuld, op `Unlock` geklikt.
- Instrumentatie via `add_init_script`: `Worker` (aanmaak, `postMessage`, antwoord), `fetch`
  (duur per request) en een `MutationObserver` op `#unlock-submit` en `#unlock-screen`.
  Tijden zijn ms vanaf de klik. De meetscripts staan niet in de repo.
- Eén CPU-klasse, één machine, geen throttling. Cijfers zijn dus een ondergrens voor wat een
  gebruiker met een tragere CPU ziet.
- Er is bij ontgrendelen **geen SRP-request**: SRP-6a gebeurt bij inloggen (`srp-auth.js`). Unlock
  doet alleen een lokale Argon2id-afleiding plus `/api/health` en `/api/account`. Er wordt geen
  WASM geladen: `vendor/noble-argon2.js` is pure JS in de worker, dus geen WASM-laadtijd.

## Meetwaarden per stap (ms vanaf klik)

| # | knop → `Checking…` | worker aangemaakt | Argon2id in worker (post→antwoord) | `/api/health` | `/api/account` | kluis ontsleuteld + UI (antwoord→klaar) | knop terug `Unlock` / slot weg |
|---|---|---|---|---|---|---|---|
| 1 | 31 | 88 | 3844 | 10 | 8 | 139 | 4071 |
| 2 | 41 | 94 | 3755 | 7 | 7 | 140 | 3989 |
| 3 | 30 | 85 | 3672 | 6 | 6 | 138 | 3895 |
| 4 | 30 | 84 | 3865 | 7 | 6 | 137 | 4086 |
| 5 | 27 | 80 | 3752 | 7 | 8 | 107 | 3939 |
| 6 | 36 | 89 | 3745 | 7 | 6 | 129 | 3964 |
| dubbele klik | 3 | 54 | 3817 | 8 | 7 | 150 | 4021 |

Aanvullend (zelfde run):

- De knop wordt binnen ≈ 30 ms op `Checking…` gezet, nog vóór de worker bestaat. De
  `yieldToPaint` voor de afleiding werkt (`app.js:8015`, `6463-6482`).
- De worker draait de afleiding op een aparte thread; de hoofdthread blijft vrij (de
  voortgangs-`creep` tikt elke 450 ms, 8 ticks in alle runs). Bij een gefaald worker-pad valt
  de code terug op de hoofdthread (zie pad B).
- Foutpaden, dezelfde omgeving:
  - Verkeerd wachtwoord: knop terug op `Unlock` na ≈ 4,0 s (één afleiding, v1-SHA is verwaarloosbaar).
  - `/api/account` geblokkeerd (`abort`): na 5,0 s ontgrendeld op lokale ciphertext, knop `Unlock`.
  - `/api/account` blijft hangen (nooit antwoord): na 8,0 s ontgrendeld, knop `Unlock` (de
    health-check heeft een eigen timeout van 3 s, `app.js:2766`).
  - Herladen tijdens afleiden: nieuwe pagina heeft knop `Unlock`, enabled; daarna ontgrendelen
    lukt gewoon.
  - Dubbele klik: tweede klik doet niets (knop is al `disabled`, en `unlockInFlight` dedupliceert,
    `app.js:8004`); één afleiding, één ontgrendeling.

## Codepaden: waar wordt de knop gezet en teruggezet

Zetten van `Checking…` / `disabled`:

- `app/static/js/app.js:8460-8463` — `submitUnlockForm`, direct na de klik.
- `app/static/js/app.js:8007-8012` — `verifyAndUnlock` (niet bij `silent` auto-unlock).
- `app/static/js/app.js:6533-6540` — `renderLoginProgressFrame` zet de knop **opnieuw** op
  `Checking…`/`disabled` bij elk frame zolang `loginProgressActive` waar is.

Terugzetten naar `Unlock`:

- `app.js:6659-6664` — `dismissLoginProgress()` (via `resetLoginProgress`, `app.js:6675`); dit is
  het centrale pad voor succes (`completeLoginProgress`) en voor de generieke fout in
  `abortUnlockAttempt` (`app.js:7461`).
- `app.js:7437-7442` (netwerk-timeout) en `7450-7455` (empty-device pending) in `abortUnlockAttempt`.
- `app.js:8470-8510` — de `catch` in `submitUnlockForm`: vijf takken, elk met eigen reset
  (sessie verlopen, empty-device pending, netwerk-stall, generieke fout).
- `app.js:8449-8454` — leeg wachtwoord.
- `app.js:6680-6681`, `6847-6848`, `24664-24667` — init/`showLockScreen`-herstel.

Paden waarin de knop **kan blijven staan** (zonder dat de meting ze raakte):

- **A. Worker antwoordt nooit.** `crypto.js:230-240` (`workerCall`) maakt een promise die alleen
  door `onmessage` of `onerror` (`crypto.js:207-225`) wordt afgehandeld; er is geen timeout. Wordt
  de worker stil afgebroken (geheugendruk bij `m=64 MiB`, browser die de worker bevriest of
  killt) dan komen `onmessage`/`onerror` niet, en `store.js:512` (`deriveKeyInWorker`) blijft voor
  altijd wachten. `app.js:8047` (`await NotesStore.unlock(...)`) heeft eveneens geen deadline;
  de 45 s-deadline (`UNLOCK_NETWORK_DEADLINE_MS`, `app.js:2569`, `raceUnlockDeadline` `2589`,
  gebruikt op `8063`) beschermt alleen de netwerkcheck, niet de afleiding. Resultaat: `Checking…`
  zonder einde, `loginProgressActive` blijft waar en `6533-6540` houdt de knop uitgeschakeld.
  **Dit is het enige pad dat een echte permanente hang kan geven.**
- **B. Worker faalt, terugval op hoofdthread.** `store.js:513-515`: bij een fout van de worker
  draait `NotesCrypto.deriveKey` (`crypto.js:79`) op de hoofdthread. Daardoor staan timers en de
  voortgangsanimatie stil voor de volle afleidingsduur; de knop lijkt bevroren. Het eindigt wel
  (de promise resolve't), dus: traag, geen hang.
- **C. Geen `finally` in `submitUnlockForm`.** `app.js:8464-8510` herstelt de knop alleen in de
  `catch`; bij een succesvolle `await verifyAndUnlock` (`8465`) vertrouwt hij erop dat
  `finishUnlocked`/`completeLoginProgress` de reset al deed. Dat klopt in elke gemeten run, maar
  een resolve die niet via die reset loopt (bijvoorbeeld de vroege `return` op `app.js:7999-8003`,
  of `silent` die de knop niet markeert maar `8460` hem wel uitschakelt) laat de knop dan
  uitgeschakeld. Niet gereproduceerd; hardening.
- **D. Netwerk zonder eind in de empty-device-route.** `app.js:8182`
  (`fetchEmptyDeviceProofWithRetry`) en `8366-8390` (nieuw apparaat, zonder lokale ciphertext)
  gebruiken retry-lussen. Hun totale duur is niet gemeten (de test-kluis had lokale ciphertext);
  de enige harde grens is de 45 s-deadline op `app.js:8063` voor de eerste serverCheck.
  Onbehandelde rejections: niet gevonden. `unlockInFlight` wordt altijd in een `finally`
  vrijgegeven (`app.js:8419-8421`), `submitUnlockForm().catch(() => {})` (`8516`, `8520`) en alle
  netwerkfouten die ik kon forceren (abort, hang) leiden tot een gereset knopstatus.

Geen onafgehandelde promise-rejection en geen netwerkfout zonder `catch` gevonden op het
normale pad. De enige echte "nooit afgehandeld"-kandidaat is A (een promise die nooit
settled, geen rejection).

## Herstelvoorstel (nog niet uitgevoerd)

1. **Zichtbare voortgang tijdens de afleiding.** Houd de knop op `Checking…` (bewuste keuze,
   `app.js:6534`), maar toon in `#unlock-status` / de bestaande voortgangsbalk een tekst als
   "Sleutel afleiden… dit kan op een telefoon een halve minuut duren" na bv. 2 s, met `aria-live`.
   De worker stuurt al voortgangsberichten (`crypto.js:210-215`, `__notesKdfProgress`,
   `app.js:6597`); koppel die aan een label in plaats van alleen aan de creep.
2. **Watchdog op de worker.** In `crypto.js` `workerCall` een timeout (bv. 60 s) die de waiter
   rejected en de worker beëindigt (`terminateWorker`), zodat `store.js:512-515` zichtbaar
   terugvalt of de flow een foutmelding krijgt. Parameters ongewijzigd.
3. **`finally` in `submitUnlockForm`.** Na de `try/catch` (`app.js:8464-8510`): als de kluis niet
   is ontgrendeld en `unlockInFlight` leeg is, de knop terugzetten. Vervangt de vijf gedupliceerde
   reset-blokken niet, maar sluit pad C.
4. **Test.** Eén test die `NotesCrypto.deriveKeyInWorker` laat hangen (nep-worker die nooit
   antwoordt) en bevestigt dat de knop na de watchdog weer `Unlock` toont met een foutmelding;
   plus een test dat het voortgangslabel verschijnt na de drempel. Bestaande structuur: JS-tests
   in `tests/test_round16_ui.js` / `test_round19_ui.js`, e2e's in `tests/e2e_*.py`.
5. **Niet in scope hier**: sneller maken van Argon2 (bv. WASM) of lagere kosten. Dat raakt de
   beveiligingsmarge en vraagt een aparte beslissing; de parameters blijven zoals ze zijn.

## Uitgevoerd (taak #118)

Diagnose was "traag zonder voortgang" plus latente hang-paden, dus geen NOOP_OK. Argon2id-parameters,
SRP-stappen en sleutelafhandeling zijn ongewijzigd. Wijzigingen:

- `crypto.js` `workerCall`: watchdog (90 s, `setWorkerTimeoutMs` voor tests) die de waiter
  rejected en de worker beëindigt; `store.js` valt dan terug op de bestaande hoofdthread-afleiding. (pad A)
- `app.js` `submitUnlockForm`: `finally` die de knop vrijgeeft als hij nog op `Checking…` staat. (pad C)
- Voortgangstekst tijdens afleiding: "Deriving key…" en daarna "Opening vault…" in `#unlock-status`.
- Test: `tests/test_unlock_worker_watchdog.js` (hangende/falende/crashende worker settelt binnen de
  tijdslimiet, normale afleiding slaagt, `finally` aanwezig).
