# Ontwerp: open High-bevinding en lopende veiligheidsfixes (idee #82)

Status: ontwerp ter goedkeuring door de eigenaar. Bij deze taak is **geen code gewijzigd**.
Peildatum van de regelverwijzingen: commit `c3adc17` (branch `main`). Regelnummers schuiven mee met
latere wijzigingen; zoek dan op de functienaam.

## 0. Doel en wat behouden blijft

Zonder deze fixes is de zero-knowledge-belofte niet waar te maken. De volgorde is: eerst de open
High-bevinding (back-upgeheim), dan sleutel wissen bij vergrendelen, dan levende blobs, dan deellinks.

Behouden en **niet** aanraken in deze reeks:

- SRP-6a-login (`app/srp_auth.py`, `app/static/js/srp-auth.js`).
- Argon2id-kluissleutel in de browser (`app/static/js/crypto.js:79`, `crypto-worker.js:58`).
- AES-256-GCM in de browser (`crypto.js:117-128`); de server bewaart alleen ciphertext (`db.py` `items.ciphertext`, `blob_ciphertext`).
- Bestaande back-upcode (`backup_mail.py`, `backup_cron.py`, `cloud-backup.js`), vergrendelcode (`vaultlock.js`, `lockVault`, `store.lock`) en Secure Send (`secure_send.py`, `secure-send.js`, `secure-send-receive.js`).

Alle voorstellen hieronder zijn **aanvullingen of vervangingen van één schakel**, geen herbouw.

---

## 1. Inventaris (huidige code)

### 1a. pCloud-wachtwoord en andere back-upgeheimen op de server

| Wat | Waar | Hoe opgeslagen / wie kan het lezen |
|---|---|---|
| rclone-OAuth-token van de gebruiker | `app/config.py:382` (`pcloud_token_path`), `:386` (`write_pcloud_token`), `:402` (`pcloud_token`) | Bestand `keys/pcloud-token-<id>`, mode 0600, AES-256-GCM met een sleutel uit de omgevingsvariabele `NOTES_PCLOUD_CREDENTIALS_KEY` (`app/pcloud_credentials.py:18`, `:38-77`). |
| Sleutel voor dat bestand | `pcloud_credentials.py:38` (`credentials_encryption_key`) | Staat in het env-bestand van de server. Het proces dat de cron en de webapp draait leest het; ook elke beheerder/root met toegang tot server of procesomgeving. |
| Tijdelijke rclone-config met het token **in leesbare tekst** | `backup_pcloud.py:102-118` (`write_rclone_config`), gebruikt in `:228` en `:249`, gewist in `:241-246` en `:256-261` | Bestand in `KEYS_DIR`, 0600, bestaat tijdens elke upload (tot 2 uur, `RCLONE_TIMEOUT_SECONDS` `:23`). Token ook zichtbaar voor het rclone-proces. |
| Oude wachtwoordbestanden (legacy) | `pcloud_credentials.py:84-114`, `config.py:418` (`pcloud_password_set` is altijd false) | Worden bij opslaan en opstarten verwijderd; `backup_pcloud.py:297-302` weigert een wachtwoord. Al afgehandeld; blijft als opruimcode. |
| Gebruikersnaam, pad, regio | `backup_pcloud.py:219-226`, tabel `users` | Niet geheim, wel metadata over de gebruiker. |
| Plaatsing in de cron | `backup_cron.py:33` (`run_pcloud_backups`), `backup_pcloud.py:322-333` | Cron draait zonder gebruiker aanwezig, dus de server **moet** het token zelf kunnen ontsleutelen. |
| Wat er geüpload wordt | `backup_mail.py:62` (`ensure_local_full_backup`), `db.py:2496` (`iter_backup_items`), bestand `*.enc.json.gz` | Alleen ciphertext uit `items`; het bestand zelf lekt geen notitie-inhoud. |
| Dropbox-tokens (andere route) | `app.js:4262-4268`, `cloud-backup.js` | Alleen in kluisvoorkeuren (versleuteld) en geheugen; worden bij vergrendelen gewist. Geen serverkopie. |

Conclusie 1a: het server-naar-pCloud-pad is een **bewaarde, door de server ontsleutelbare toegangssleutel tot het
pCloud-account van de gebruiker**. Het blijft de resterende High (zie `docs/security-audit-2026-10-28.md`,
H-PCLOUD): versleuteling in rust met een sleutel op dezelfde machine beschermt tegen een weggelekte schijf of
back-up van `keys/`, niet tegen iemand met toegang tot het draaiende systeem. Dat is precies wat zero-knowledge
wil uitsluiten. De notities zelf blijven veilig; de schade is toegang tot (en verwijderen van) het cloudaccount.

### 1b. Wat er bij vergrendelen gebeurt

`lockVault` (`app.js:4197`) roept `NotesStore.lock()` (`store.js:837`) aan. Controle per onderdeel:

| Onderdeel | Gedrag nu | Bewijs |
|---|---|---|
| Kluissleutel (`state.cryptoKey`, `altCryptoKey`) | `raw` wordt met `fill(0)` genuld, daarna referentie weg | `store.js:828-855` |
| Laatst afgeleide sleutel (`lastDerivedKdf`) | genuld en weg | `store.js:856-860` |
| Sleutelcopie in de crypto-worker | Worker wordt beëindigd (`terminateWorker`); in de worker staat de sleutel als base64-string (`crypto-worker.js:66-69`, `:72`), dus **niet nulbaar** — alleen door beëindigen vrijgegeven | `store.js:~873`, `crypto-worker.js` |
| Ontsleutelde notities | `state.items.clear()`, backlink-index, `unlockedNotes.clear()`, notitielijst leeg | `store.js:859-865`, `app.js:4251-4257` |
| 2FA-geheimen | Staan in de ontsleutelde items; verdwijnen met `state.items.clear()`. Klokken/zoekveld gestopt (`stopTotpClock`, `app.js:~4294`). JS-strings van geheimen zijn niet te nullen | `store.js:859`, `totp.js` |
| Wachtwoorden in geheugen | `NotesVaultSecrets.clearSecrets()` zet strings op `''` (kopieën in de JS-heap blijven tot GC) | `vault-secrets.js:312-316`, `store.js:~871` |
| Zoekindex | `NotesSearch.clearMemoryIndex()` | `store.js:~872` |
| Caches met plaintext | `clearPreviewCache()` (`app.js:12000`) en `clearListThumbCache()` (`app.js:12141`) herroepen hun object-URL's | `app.js:4258-4259` |
| `sessionStorage` | `notes_unlocked` en `notes_kdf_cache` verwijderd; de KDF-cache bevat alleen salt/versie/encoding, **geen sleutel** | `store.js:478-482`, `:866-871` |
| Apparaatwachtwoord | `devicePasswordCache` blijft bij lock bestaan (`app.js:2289-2307`); bij "apparaat onthouden" staat het via `NotesVaultSecrets.saveDevicePassword` opgeslagen, in de oude fallback in `localStorage` (`app.js:2317`) | Bewuste keuze voor auto-unlock; moet worden beoordeeld (zie 2.2) |
| Dropbox-tokens | op `''`/`false` gezet | `app.js:4262-4270` |

Er is al een test: `tests/test_lock_evicts_key.js`. Open punten (gaten): (i) sleutel in de worker als niet-nulbare
string, (ii) `devicePasswordCache` blijft na lock, (iii) geen `crypto.subtle`-niet-extraheerbare sleutel — de sleutel
is een gewone `Uint8Array`, (iv) caches buiten `previewCache`/`listThumbCache` (zie 1d).

### 1c. Openbare deellinks (Secure Send) nu

| Aspect | Gedrag | Bewijs |
|---|---|---|
| Waar de sleutel staat | In het URL-fragment: `#v1.<sleutel>` of `#v1p.<salt>.<fragsleutel>`; verlaat de browser niet | `secure-send.js:151-164`, `secure-send-receive.js:23` |
| Wat de server ontvangt | Alleen `{iv, data}` ciphertext, `expires_in`, `max_views`, optioneel `open_verifier`; sleutelachtige velden worden geweigerd (400) | `app.py:3731-3750`, `secure_send.py:67` |
| Bestandsnaam/MIME/grootte | Binnen de ciphertext; server ziet alleen de totale lengte | `secure-send.js:140-146`, `app.py:3747` |
| Verloopdatum | **Bestaat**: min 5 min, standaard en maximum 7 dagen | `secure_send.py:14-16`, `:51-56`, `app.py:3748`; UI `app.js:22620` |
| Aantal opens | **Bestaat**: 1 standaard, max 10, door de server afgedwongen | `secure_send.py:13`, `:17`, `:59-64`; `app.js:22621` |
| Wachtwoord | **Optioneel**: Argon2id-passphrase gecombineerd met de fragmentsleutel (`contentKey = SHA-256(frag ‖ argon2id)`); `open_verifier` laat de server pogingen tellen zonder het wachtwoord te kennen; 5 mislukte pogingen blokkeren | `secure-send.js:63`, `:154-160`, `secure_send.py:21`, `:148`, `db.py:3030` |
| Intrekken | Eigenaar kan annuleren | `app.py:3795-3806`, `db.py:3127` |
| Opruimen | Verlopen ciphertext wordt gewist bij opvragen en bij aanmaken | `app.py:3925-3927`, `db.py:3176` |
| Wat de server ziet | Afzender-id, tijden, aantal opens, ciphertext-lengte, of er een verifier is, IP bij rate-limit (`app.py:3821-3826`) | `db.py:410-428` (tabel `secure_sends`) |
| Bekende beperkingen | Zonder wachtwoord is de link de sleutel; actieve server kan code vervangen; ontvanger kan kopiëren | `SECURITY.md` §"Secure Send links…" |

Gat: wachtwoord is optioneel en staat standaard uit; de standaard-looptijd is de maximale (7 dagen); het fragment
blijft in de browsergeschiedenis van de ontvanger en de ontvangstpagina wist het niet na gebruik
(`secure-send-receive.js` gebruikt geen `history.replaceState`).

### 1d. Levende `blob:`-URL's en ontsleutelde blobs na vergrendelen of navigatie

| Plek | Wat leeft er | Wordt het herroepen? | Bewijs |
|---|---|---|---|
| `previewCache` (documentviewer) | `blob:` van ontsleutelde bijlage | Ja bij lock (`clearPreviewCache`), niet bij `pagehide` | `app.js:11985-12015`, `:12000`, `:4259` |
| `listThumbCache` | `blob:`-miniaturen (JPEG/PNG) van bijlagen | Ja bij lock | `app.js:12037`, `:12141`, `:12325` |
| `data-doc-enhance-url` (verbeterde scan in viewer) | `blob:` van bewerkte afbeelding | Alleen via `releaseDocEnhanceObjects` in `closeDocPreview`; `lockVault` roept `closeDocPreview()` aan (`app.js:4244`), dus ja bij lock, maar niet bij losse paden `app.js:3606-3609` waar de `img` al ontkoppeld is | `app.js:3490-3514`, `:3600-3610`, `:13607` |
| Afbeeldings-hydratie in de editor | `blob:` voor inline bijlagen (via `hydrateThumb` en bewerker) | **Niet gegarandeerd**: er is geen centrale lijst; alleen caches boven worden gewist. Elementen in de DOM blijven na `ui.editor.hidden = true` in leven | `app.js:12150`, `:17744`, `:17931` |
| `NotesPreview.blobUrl` | Algemene PDF/afbeelding-URL's | Alleen door de aanroeper | `preview.js:166` |
| PDF-worker (`workerBlobUrl`) | blob van publiek script | Niet geheim; blijft | `preview.js:49` |
| Downloads/exports | tijdelijk `blob:` voor `.ics`, back-up, Secure Send-bijlage | Ja, na 1,5–2,5 s met `setTimeout`; faalt als de pagina eerder sluit | `agenda.js:1062-1071`, `cloud-backup.js:215-223`, `secure-send-receive.js:191-199`, `app.js:13669-13720`, `:23613` |
| Plaatje voor OCR/import | `createObjectURL(file)` | Deels herroepen | `app.js:5319`, `client-ocr-engine.js:314-330`, `:225` |
| Navigatie / `pagehide` | `pagehide` stopt alleen QR-scan (`app.js:22836`) en online-herstel (`:25475`) | **Geen** herroeping van blob-URL's of wissen van caches; bfcache (`pageshow`, `:25483`) kan een eerder zichtbare pagina terugbrengen | `app.js:22836`, `:25475-25513` |

Opmerking: een `blob:`-URL is alleen binnen dezelfde origin en hetzelfde document bruikbaar; het risico is
(a) lang geheugengebruik van plaintext, (b) een XSS of extensie die ze nog kan ophalen na lock, (c) bfcache-herstel.

---

## 2. Per onderwerp: gat, oplossing, wat de server (niet) ziet, risico, bewijs

### 2.1 Back-upgeheim (H-PCLOUD)

- **Gat:** de server bewaart een door hem zelf ontsleutelbaar toegangstoken tot het pCloud-account van de gebruiker
  (1a). Ook het leesbare tijdelijke configbestand en het door de server bepaalde tijdstip van uploaden maken
  dat de server een actieve aanvaller of beheerder is die toegang kan misbruiken.
- **Oplossing (aanbevolen, keuze A in §3):** het pad server → pCloud **schrappen**. In de plaats daarvan
  - blijft de e-mailback-up (`backup_mail.py`) ongewijzigd (alleen versleutelde bijlage);
  - komt een **in-browser pCloud-upload** naar het voorbeeld van Dropbox (`cloud-backup.js`): het token staat alleen in de
    versleutelde kluisvoorkeuren en in geheugen, wordt bij lock gewist, en de browser uploadt het (al versleutelde) back-upbestand;
  - bij uitrol: `NOTES_PCLOUD_CREDENTIALS_KEY`, `keys/pcloud-token-*`, `write_rclone_config`, route `/api/backup/pcloud/*` (`app.py:2877`, `:2928`) en cron-onderdeel `run_pcloud_backups` (`backup_cron.py:33`) verwijderen; bestaande tokenbestanden **overschrijven en wissen**; gebruikers mailen dat ze het pCloud-token herroepen.
- **Alternatief (keuze B):** server-naar-pCloud behouden, maar het token inpakken met een sleutel die alleen de client heeft
  (kluissleutel-afgeleide wrapping key). De server kan dan nooit zelf uploaden; een upload vereist dat de client het
  uitgepakte token meegeeft (per sessie, bijvoorbeeld bij ontgrendelen). Geen onbeheerde cron meer.
- **Server ziet wel:** het back-upbestand als ciphertext (zoals nu), tijdstip, grootte, pCloud-gebruikersnaam/-pad (A: niet eens dat; die gaan naar kluisvoorkeuren).
  **Server ziet niet:** pCloud-token, pCloud-wachtwoord, inhoud van de notities.
- **Risico's:** A verliest de volledig onbewaakte dagelijkse upload (alleen als de app open is of via e-mail); gebruikers die er nu op rekenen krijgen een melding en een
  overgangsperiode. Browser-CORS/pCloud-API-beperkingen kunnen een proxy nodig maken (die mag het token alleen doorgeven, niet bewaren; test dat).
  B bewaart complexiteit en een server die elk token tijdens een sessie ziet.
- **Test die het aantoont:**
  1. Python (naast `tests/test_pcloud_credentials.py`): na de fix bestaat `write_pcloud_token`/`write_rclone_config` niet meer of gooit; geen bestand `pcloud-*` in `KEYS_DIR` na opslaan; route geeft 404/410.
  2. Python: scan van `KEYS_DIR` en database na een volledige back-upcyclus op token-achtige strings (dummywaarde) — geen treffers.
  3. JS (naast `tests/test_cloud_backup.js`): token zit alleen in kluisvoorkeuren, niet in `localStorage`; na `lock()` is het weg.

### 2.2 Sleutel wissen bij vergrendelen

- **Gat:** zie 1b: de sleutel in de worker is een base64-string die niet te nullen is; `devicePasswordCache` blijft; `Uint8Array`-nulling is alleen best-effort; er
  is geen gedocumenteerd model van wat wél en niet gewist wordt.
- **Oplossing:**
  1. Houd de sleutel in de worker als `Uint8Array`, nul die bij `terminateWorker` en bij lock via een expliciete `wipe`-boodschap vóór `terminate()`.
  2. Gebruik waar het kan een niet-extraheerbare `CryptoKey` (WebCrypto AES-GCM) voor de gewone versleuteling; de ruwe bytes bestaan dan alleen kort tijdens afleiding (Argon2id levert bytes, dus eenmalig `importKey` en direct nullen). Dit raakt `crypto.js` en is het grootste risico; alleen doen als de test voor huidig gedrag eerst staat.
  3. Wis `devicePasswordCache` bij lock tenzij "apparaat onthouden" aan staat; leg die uitzondering in `SECURITY.md` vast.
  4. Voeg een expliciete lijst "wat lock wist" toe aan de code (één functie `wipeAll()` die elk onderdeel van 1b aanroept) zodat nieuwe caches niet vergeten worden.
  5. Wis ook bij `pagehide` indien `persisted === false`, en bij time-out-lock zonder `skipSync`-uitstel van sleutelwissen: **sleutel eerst wissen, daarna pas netwerk**, want `lockVault` wacht nu tot `LOCK_FLUSH_WAIT_MS` (`app.js:4237-4243`) met sleutel nog in geheugen.
- **Server ziet:** niets nieuws; geen sleutel- of wachtwoordmateriaal verlaat de browser.
- **Risico's:** JS kan geheugen niet garanderen wissen (GC, kopieën, strings); we beloven dus "best effort + minder aanvalsoppervlak", niet "gegarandeerd". Het eerst-wissen kan ontgrendelen na lock trager maken (afgeleide sleutel opnieuw). Niet-extraheerbare sleutels breken code die `key.raw` gebruikt (`crypto.js:37`, `:117`, `:126`, `:140`, `store.js:828`).
- **Test:** breid `tests/test_lock_evicts_key.js` uit: na `lock()` zijn (a) alle sleutelbuffers nul, (b) worker beëindigd na `wipe`, (c) `sessionStorage`/`localStorage` bevatten geen sleutel- of wachtwoordstring (dummywaarde), (d) `NotesStore.get()` geeft niets terug, (e) de sleutel is weg **voor** de eerste netwerkaanroep van `lockVault`.

### 2.3 Levende blobs

- **Gat:** zie 1d: inline afbeeldingen in de editor, `docEnhanceUrl`-paden buiten de viewer en bfcache blijven; er is geen register van alle `createObjectURL`-aanroepen.
- **Oplossing:**
  1. Eén klein register `NotesBlobUrls` (`create(blob, {scope})`, `revoke(url)`, `revokeAll()` en `revokeScope()`), gebruikt door elke plek in 1d; de aanroepen in `app.js`, `preview.js`, `client-ocr-engine.js` en `agenda.js` worden vervangen door één regel.
  2. `lockVault` roept `NotesBlobUrls.revokeAll()` aan en zet alle `img`/`iframe`/`video` met `blob:`-bron in de DOM op een leeg `src` (naar een `data:`-pixel).
  3. Bij `pagehide` en `visibilitychange` naar hidden: `revokeAll()` voor plaintext-bereik (niet voor het publieke PDF-script).
  4. Kortlevende downloads: herroepen via `a.click()` + `setTimeout` blijft, maar ook via register zodat ze bij lock nooit overleven.
- **Server ziet:** niets; dit is zuiver clientgedrag.
- **Risico's:** te vroeg herroepen laat een zichtbare afbeelding leeg worden (gebruiker ziet "kapotte afbeelding" na terugkeren uit bfcache); downloads kunnen afbreken als de herroeping te snel komt. Daarom blijven de downloadvertragingen en wordt alleen **bij lock/pagehide** forceren.
- **Test:** JS-test met nep-`URL.createObjectURL`/`revokeObjectURL`: open een bijlage, maak miniatuur, verbeter scan, lock → `revokeAll` heeft elke aangemaakte URL herroepen (aantal creates = aantal revokes), en de DOM bevat geen `blob:`-`src`. Plus een statische test die faalt als er in `app/static/js` een `createObjectURL` is buiten het register (met een allowlist voor de downloadhulpjes).

### 2.4 Deellinks (Secure Send)

- **Gat:** wachtwoord optioneel en standaard uit; standaard-looptijd 7 dagen (de maximale); fragment blijft in geschiedenis; geen duidelijke zichtbaarheid van "wat de server ziet" in de interface; ontvanger-pagina zet decrypt-bestand in `blob:` zonder register (zie 2.3).
- **Oplossing:**
  1. Voorstel standaard: **verloop 24 uur**, opens 1, maximum blijft 7 dagen / 10 (`secure_send.py:14-17`). Wijzig `DEFAULT_EXPIRES_SECONDS` en de UI-standaard in `app.js:22620`; bestaande links ongemoeid.
  2. Wachtwoord: UI vraagt er standaard om (aangevinkt), met een duidelijke uitleg en één-klik opt-out, en de server kan afdwingen bij bestanden of bij gevoelige bijlagen niet; zie keuze in §3.
  3. De ontvangstpagina haalt het fragment na lezen uit de adresbalk (`history.replaceState`) en zet `Referrer-Policy: no-referrer` voor `/receive/*` (controleren/toevoegen in `app.py:3898`).
  4. Intrekken (`app.py:3795`) en lijst van eigen links blijven; voeg "verloopt over …" toe in de interface.
  5. Wachtwoord blijft Argon2id gecombineerd met het fragment (`secure-send.js:63`); géén server-side hash van het wachtwoord, alleen de bestaande `open_verifier`.
- **Server ziet wel:** ciphertext-lengte, tijden, aantal opens, mislukte pogingen, afzender-id, `open_verifier` (afgeleid van de contentsleutel; staat niet los uit te lezen tot het wachtwoord).
  **Server ziet niet:** inhoud, titel, bestandsnaam, MIME, wachtwoord, fragmentsleutel.
- **Risico's:** hoe korter de standaard, hoe meer ontvangers een verlopen link zien (support); verplicht wachtwoord remt gebruik en leidt tot wachtwoord in dezelfde chat als de link (dan geen tweede factor — UI waarschuwt: stuur het apart). Een kwaadwillende server kan nog steeds script wisselen; blijft in `SECURITY.md`, mitigatie via de bestaande client-integriteit (`release-integrity.js`).
- **Test:** uitbreiden van `tests/test_round_d2_secure_send.py` en `.js`: (a) server weigert sleutel-/wachtwoordvelden (bestaat), (b) standaard `expires_in` is het nieuwe getal, (c) payload bevat geen fragment (er is al een controle in `secure-send.js:217-221`), (d) ontvangstpagina verwijdert het fragment uit `location` en stuurt `Referrer-Policy`, (e) bij verplicht wachtwoord: aanmaken zonder wachtwoord faalt in de UI-logica, (f) databasedump bevat de dummysleutel/-wachtwoord niet.

---

## 3. Ontwerpkeuzes voor de eigenaar

| # | Keuze | Opties | Aanbeveling |
|---|---|---|---|
| K1 | Back-up naar pCloud | **A**: server → pCloud schrappen, in-browser pCloud-upload (+ bestaande e-mailback-up). **B**: server → pCloud houden met token dat alleen de client kan ontsleutelen (geen cron). **C**: houden zoals nu. | **A.** Het enige model waarin de server geen cloudtoegang van de gebruiker heeft. Verlies: onbewaakt dagelijks uploaden; dat wordt gecompenseerd door e-mailback-up en een herinnering als de laatste back-up oud is. C blijft de High. |
| K2 | Wachtwoord op deellink | Verplicht / optioneel (standaard aan) / optioneel (standaard uit, zoals nu) | **Optioneel, standaard aan**, met expliciete opt-out per link. Verplicht frustreert (bijv. wachtwoord naar zelf, link naar zelf); standaard uit laat de meeste links ongeborgd. Uitzondering: bij een bijgevoegd bestand de waarschuwing luider. |
| K3 | Standaard verlooptermijn | 1 uur / 24 uur / 7 dagen (nu) | **24 uur**; maximum blijft 7 dagen, opens standaard 1. |
| K4 | Wat lock wist | Alleen geheugen / plus apparaatwachtwoord bij "onthouden" | Wis alles; behoud apparaatwachtwoord alleen als de gebruiker "apparaat onthouden" bewust koos, en zeg dat in `SECURITY.md`. |
| K5 | Niet-extraheerbare `CryptoKey` | Nu doen / later | **Later**, na milestone 2, met een eigen testset; hoogste regressierisico. |
| K6 | Bestaande tokens bij uitfasering | Stil wissen / eerst mailen | Eerst mailen, 14 dagen overgang, dan wissen met overschrijven. |

---

## 4. Mijlpalen (in volgorde)

1. **Back-upgeheim** (H-PCLOUD): K1 beslissen; verwijderen resp. omzetten; migratie/mail; tests 2.1; `SECURITY.md` en auditdocument bijwerken, High sluiten.
2. **Sleutel wissen**: `wipeAll()`, sleutel-eerst-wissen, worker-wipe, apparaatwachtwoord-beleid (K4); tests 2.2.
3. **Live blobs**: register `NotesBlobUrls`, vervang aanroepen, `pagehide`-gedrag; tests 2.3. Daarna eventueel K5.
4. **Deellinks**: standaardverloop, wachtwoordstandaard, fragment wissen, referrer-beleid; tests 2.4; kopie in de UI.

Elke mijlpaal is een eigen PR; bij wijzigingen onder `app/static` het clientmanifest opnieuw genereren met
`scripts/build-client-manifest.py`. Eerst de tests schrijven die het huidige gedrag vastleggen, dan wijzigen.

---

## 5. Vergelijking met Standard Notes, Proton en Ente

*Gemarkeerd als **modelkennis** (niet live gecontroleerd; kan achterhaald zijn).*

- **Standard Notes** (modelkennis): end-to-end versleuteld, sleutel uit wachtwoord; vergrendelen met toegangscode/biometrie op het apparaat; notities delen kan als publieke link in sommige plannen met een sleutel in de URL; geen server-naar-cloud-upload met bewaard cloudtoken (back-ups gaan via de app/extensie op het apparaat).
- **Proton** (modelkennis): Proton Drive/Pass/Mail delen via link met optioneel wachtwoord (bij Drive) en verloopdatum; wachtwoord is dan deel van de sleutelafleiding; de server ziet metadata. Vergrendelen van apps via pincode/biometrie op mobiel; web-sessie via uitloggen.
- **Ente** (modelkennis): Photos/Auth/Locker, publieke albumlinks met sleutel in het fragment, optioneel wachtwoord en verloopdatum, intrekken; app-lock op apparaat met pincode/wachtwoord en sleutel in de beveiligde opslag van het besturingssysteem.

Wat Deeperguard hieruit meeneemt: standaard een wachtwoord op de link, korte verlooptijd, intrekken, geen cloudtoken dat de server kan lezen.
Waar Deeperguard beter kan zijn: één duidelijke uitleg *in de interface* van wat de server ziet, en zichtbaar bewijs bij vergrendelen
(bijvoorbeeld "sleutel gewist, bijlagen losgelaten") in plaats van alleen een slot-scherm. Uiterlijk en gevoel: dezelfde rustige stijl als bestaand
(`secure-send-panel`), met een duidelijke samenvatting bovenaan het deelpaneel: link, wachtwoord, verloopt, opens.

---

## 6. Aannames en open punten

- Regelnummers met "~" zijn bij benadering; de functienaam is leidend.
- Geen secrets, tokens of interne adressen staan in dit document; de naam van de omgevingsvariabele is geen waarde.
- Niet onderzocht: serverlogs, reverse-proxy-logging van `/receive/*`-paden (het fragment komt daar niet voor, de `send_id` wel).
