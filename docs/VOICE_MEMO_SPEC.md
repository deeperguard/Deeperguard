# Spraakmemo's: ontwerpspec (fase 1 opnemen, fase 2 transcriptie)

Status: ontwerp, nog niet gebouwd. Dit document bevat alleen tekst; er is geen code gewijzigd.
Achtergrond: idee #59 (spraakmemo's en vergadernotities). Gebruikers willen gesproken notities
vastleggen, ook offline, zonder dat de inhoud naar de cloud gaat en zonder dat de server de
inhoud kan lezen.

## 0. Wat er nu al is (controle van de code)

| Onderdeel | Stand | Bron |
|---|---|---|
| Opnemen met microfoon | Bestaat niet. Enige `getUserMedia` is de camera (`audio: false`). | `app/static/js/app.js:15457` |
| Bijlageroute (versleuteld) | Bestaat: `importAttachment` en `addAttachment` versleutelen de bytes met `NotesCrypto.encryptBytes` en slaan ze op als item van type `attachment`. | `app/static/js/store.js:5482`, `store.js:5546` |
| Groottelimiet | `MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024`, gecontroleerd in beide functies. | `app/static/js/store.js:3`, `store.js:5485`, `store.js:5549` |
| Permissions-Policy | `geolocation=(), microphone=(), camera=()`: microfoon is nu geblokkeerd. | `app/auth.py:1140` |
| CSP `media-src` | `media-src 'self' blob:` staat er al. | `app/auth.py:1123` |
| Audio afspelen | Bestaat niet. `kindFromMeta` kent alleen `text`, `pdf`, `image`, anders `other`. | `app/static/js/preview.js:74-83` |
| Audio als bijlage kiezen | Niet via de bestandskiezer (zie sectie 4). | `app/templates/app.html:1472` |

## 1. Fase 1: opnemen

### 1.1 Opname in de browser
- `MediaRecorder` op een `MediaStream` van `navigator.mediaDevices.getUserMedia({ audio: true })`.
- Formaatkeuze met `MediaRecorder.isTypeSupported`, in deze volgorde:
  1. `audio/webm;codecs=opus` (Chrome, Edge, Firefox)
  2. `audio/mp4` (Safari)
  3. Als geen van beide ondersteund wordt: de knop niet tonen en een korte melding geven.
- `audioBitsPerSecond: 32000` (spraak). Safari en sommige browsers mogen dit negeren; de spec mag
  daarom niet van exact 32 kbps uitgaan (zie 1.3).
- Opname in brokken (`timeslice`, bijv. 1000 ms) die in het geheugen worden verzameld; de som van de
  bytes wordt tijdens de opname bijgehouden.
- Bestandsnaam: `spraakmemo-JJJJ-MM-DD-UUMM.webm` of `.m4a`; MIME-type zoals de browser het meldt
  (zonder `;codecs=...`-deel opgeslagen is acceptabel).

### 1.2 Opslag
- Na het stoppen wordt de Blob omgezet naar een `File` en via de bestaande route opgeslagen:
  `NotesStore.addAttachment(noteId, file, ...)` (`store.js:5546`). Er komt geen nieuw opslagpad,
  geen nieuw itemtype en geen servercode; de server ziet alleen versleutelde bytes, net als bij
  andere bijlagen.
- Dubbele inhoud wordt door de bestaande hashcontrole geweigerd (`findDuplicateAttachment`); voor een
  opname is dat in de praktijk niet relevant.

### 1.3 Maximale opnameduur (berekening)
- Limiet: 50 MiB = 52.428.800 bytes (`store.js:3`).
- Bij 32 kbps = 4.000 bytes/s: 52.428.800 / 4.000 = 13.107 s, ruim 218 minuten. Dat is de theoretische
  grens bij exact 32 kbps zonder containeroverhead; daar zit te weinig marge in.
- Browsers kunnen de bitrate negeren of overschrijden (Safari/AAC, VBR). Rekenmarge: ga uit van
  maximaal 128 kbps = 16.000 bytes/s. Dan past 52.428.800 / 16.000 = 3.276 s, ruim 54 minuten, in de limiet.
- **Besluit: maximale opnameduur 45 minuten (2.700 s).**
  - Bij 32 kbps: 2.700 x 4.000 = 10,8 MB (ca. 21 % van de limiet).
  - Bij het ongunstige geval van 128 kbps: 2.700 x 16.000 = 43,2 MB (ca. 82 % van de limiet).
- **Waarschuwing** op 40 minuten (nog 5 minuten), zichtbaar en voorleesbaar (`aria-live`).
- **Netjes stoppen** op 45 minuten: `recorder.stop()`, de verzamelde brokken afronden en opslaan; geen
  verlies van de opname.
- **Tweede vangnet op bytes**: stop ook zodra het totaal 40 MiB (41.943.040 bytes) bereikt, ook als de
  tijdlimiet nog niet gehaald is, zodat een hoge bitrate nooit de 50 MiB-limiet raakt. Toon dezelfde
  waarschuwing vanaf 35 MiB.
- Open punt voor de implementatie: een item van tientallen MB wordt als base64 in JSON verstuurd
  (ca. 4/3 groter; 43 MB wordt ca. 58 MB). `MAX_CONTENT_LENGTH` staat op 80 MB
  (`app/app.py:140`). Controleer met een echte sync-test dat een opname van 40 MiB wordt
  doorgegeven; zo niet, verlaag de limiet in plaats van de serverlimiet te verhogen.

## 2. Beveiliging

### 2.1 Permissions-Policy
- Nu: `"Permissions-Policy": "geolocation=(), microphone=(), camera=()"` in `app/auth.py:1140`
  (functie `security_headers`).
- Wijziging bij bouwen: `microphone=()` wordt `microphone=(self)`. `geolocation=()` en `camera=()`
  blijven ongewijzigd. Dat geeft alleen de eigen origin toegang tot de microfoon; iframes van derden
  krijgen die niet.
- Let op: de camera-scan (`app.js:15457`) heeft geen audio nodig; die wijziging raakt hem niet.

### 2.2 CSP
Huidige CSP: functie `content_security_policy()` in `app/auth.py` (richtlijnen rond `auth.py:1115-1131`).
- Voor afspelen is `media-src 'self' blob:` nodig. Dat staat er al op `app/auth.py:1123`;
  er is geen CSP-wijziging nodig voor afspelen.
- `default-src 'self'` en `worker-src 'self' blob:` (`auth.py:1128`) blijven ongewijzigd voor fase 1.
- `connect-src` hoeft niet te veranderen: opnemen en afspelen gebruiken geen netwerk.
- Voor fase 2 kan een model van de eigen origin worden geladen via `connect-src 'self'`; er wordt
  geen externe host toegevoegd (zie sectie 5).
- De CSP wordt voor sommige worker-routes vervangen (`app/app.py:589-593`); die routes hebben geen
  microfoon nodig.
- Test: een test op de headers die controleert dat `media-src` `blob:` bevat en `microphone=(self)`
  precies zo in de header staat.

### 2.3 Gedragsregels voor de microfoon
1. Microfoontoegang wordt alleen gevraagd na een klik op de opneemknop (user gesture); nooit bij het
   laden van de pagina of bij het openen van een notitie.
2. Na het stoppen (of annuleren, fout, sluiten van de notitie, vergrendelen van de kluis) worden alle
   tracks van de stream direct gestopt (`stream.getTracks().forEach(t => t.stop())`) en wordt de
   `MediaRecorder` losgelaten.
3. Geen opname in de achtergrond: bij `visibilitychange` naar verborgen, `pagehide` of vergrendelen
   wordt de opname gestopt en (indien aanwezig) bewaard of verworpen volgens de keuze in 2.5; er is
   geen Service Worker of andere achtergrondlogica die de microfoon gebruikt.
4. Zichtbare opname-indicator zolang de microfoon open is: rode stip, tekst "Opname bezig" en
   een lopende timer, ook voor schermlezers. De indicator verdwijnt pas als de tracks zijn gestopt.
   Dit vult de indicator van het besturingssysteem/browser aan; het vervangt die niet.

### 2.4 Onversleutelde audio alleen in het geheugen
- Tijdens de opname staan de brokken alleen in JavaScript-geheugen (`Blob`-array). Niet naar
  `localStorage`, niet naar IndexedDB, niet naar Cache Storage en niet naar een Service Worker-cache,
  tenzij versleuteld.
- Opslag gaat uitsluitend via `addAttachment`, dat versleutelt vóór het wegschrijven.
- Na opslaan of weggooien: brokken en Blob-referenties vrijgeven (arrays leegmaken, variabelen op `null`).
- Grens van deze garantie, eerlijk benoemd: het geheugen van de pagina kan door het besturingssysteem
  naar swap worden weggeschreven en een kwaadaardige browserextensie kan meeluisteren. Dat kan de
  app niet voorkomen. De spec belooft alleen: niet in browseropslag zonder versleuteling.
- Opmerking over crashes: een opname die nog niet is opgeslagen is bij een crash of herladen weg.
  Dat is bewust; versleutelde tussentijdse opslag is een mogelijke latere uitbreiding.

### 2.5 Wat de server wel en niet ziet
De server ziet hetzelfde als bij elke bijlage: een versleutelde blob met een grootte en
tijdstempels. Hij ziet de inhoud niet. De grootte van het item verraadt wel ongeveer de duur van de
opname. Dit wordt in de gebruikersdocumentatie niet verzwegen.

## 3. Afspelen
1. De gebruiker kiest "afspelen" bij een audiobijlage (geen automatisch afspelen, ook niet bij
   previews of in lijsten).
2. De bijlage wordt ontsleuteld in het geheugen (bestaande ontsleutelroute voor bijlagen) naar een
   `Uint8Array`.
3. `new Blob([bytes], { type: mime })` en `URL.createObjectURL(blob)`; die URL gaat naar een
   `<audio controls>`-element. Dit valt onder `media-src blob:` (`auth.py:1123`).
4. Intrekken: `URL.revokeObjectURL(url)` zodra het afspelen stopt, de speler wordt gesloten, een
   andere bijlage wordt gekozen, de notitie wordt gesloten of de kluis wordt vergrendeld. Het
   `<audio>`-element krijgt dan ook `removeAttribute('src')` en `load()`, zodat de buffer vrijkomt.
5. Geen bewaring van de ontsleutelde bytes in een cache. De bestaande `previewCache`
   (`app.js:11995`) is voor afbeeldingen en documenten; audio wordt daar niet in opgenomen.
6. `kindFromMeta` (`preview.js:74`) krijgt een soort `audio` voor `audio/*` en de extensies
   `.webm`, `.m4a`, `.mp4`, `.ogg`, `.opus`, `.mp3`, `.wav`. Let op: een `.webm`-bestand kan ook video zijn;
   beslis op MIME-type `audio/...` en val voor extensies alleen terug als het MIME-type leeg is.

## 4. Kunnen audiobestanden nu al als bijlage worden geüpload?

Bevinding: **gedeeltelijk, alleen via omwegen; niet bruikbaar voor spraakmemo's.**
- De bestandskiezer voor bijlagen (`app/templates/app.html:1472`) heeft
  `accept="image/*,.heic,.heif,...,.pdf,.txt,.md,.json,.csv,.zip,.xml,.yaml,.yml,.docx,..."`. Audio
  (`audio/*`, `.m4a`, `.webm`, `.mp3`, `.wav`) staat er niet in. Op sommige platforms (vooral mobiel)
  kan de gebruiker audio dan niet kiezen; op desktop kan "Alle bestanden" soms nog wel.
- In `app.js` zit geen allowlist op MIME-type voor bijlagen: de `change`-handler
  (`app.js:21668`) geeft de bestanden door aan `ingestAttachmentFiles`, en `addAttachment` controleert
  alleen de grootte (`store.js:5549`). Ook sleep-en-neerzetten en plakken zijn niet getoetst op
  audio. Dat is te controleren bij het bouwen (testen met een `.m4a`).
- `importAttachment` slaat elke MIME op (`store.js:1096` valt terug op `application/octet-stream`).
- De server heeft geen type-filter voor bijlagen; alleen `MAX_CONTENT_LENGTH` van 80 MB
  (`app/app.py:140`).

Wat er moet veranderen voor fase 1:
1. `accept` in `app/templates/app.html:1472` uitbreiden met `audio/*,.m4a,.webm,.mp3,.wav,.ogg,.opus`
   (alleen nodig voor het kiezen van bestaande audio; voor opnemen niet, want die gebruikt `addAttachment` direct).
2. `kindFromMeta` in `preview.js` uitbreiden met `audio` (sectie 3.6) en de weergave in
   `app.js` (o.a. `app.js:48`, `app.js:3209`, `app.js:3287`) een audiospeler laten tonen in plaats van "other".
3. Dat audiobijlagen niet door OCR gaan: `attachmentIsIndexable` (`app.js:11694`) en het
   `unsupported`-pad (`app.js:18240`) moeten audio als niet-indexeerbaar behandelen; controleer dat
   er geen OCR-aanroep op audio wordt gedaan.
4. Na wijzigingen onder `app/static`: `scripts/build-client-manifest.py` opnieuw draaien.

## 5. Fase 2: transcriptie (alleen open punt, niets bouwen)

Doel: een opname lokaal omzetten naar tekst, zonder dat audio of tekst het apparaat verlaat.

Open vragen, nog niet beslist:
- **Model en origin**: een lokaal spraakmodel (bijv. een Whisper-variant via WebAssembly of WebGPU)
  dat door de eigen origin wordt geserveerd (`'self'`), niet van een CDN, zodat er geen derde partij
  bij de download is. CSP heeft al `'wasm-unsafe-eval'` voor scripts (`auth.py:1116`); controleren
  of dat volstaat of dat een model-worker extra rechten nodig heeft.
- **Worker**: uitvoeren in een Web Worker van de eigen origin (`worker-src 'self' blob:`) zodat de UI niet blokkeert.
- **Grootte**: modellen van bruikbare kwaliteit zijn tientallen tot honderden MB. Download één keer,
  met toestemming van de gebruiker en een voortgangsindicator; opslag van het model in de browsercache is
  niet geheim (het model bevat geen gebruikersdata) en mag dus onversleuteld, in tegenstelling tot audio.
  Precieze groottes en de invloed op `LOCAL_CACHE`-limieten moeten nog worden gemeten.
- **Kwaliteit in het Nederlands**: moet worden gemeten op echte Nederlandse vergaderspraak (accenten,
  Vlaams, vakjargon, meerdere sprekers). Kleine modellen presteren aanzienlijk slechter dan grote.
  Er is nog geen meting; geen belofte over nauwkeurigheid.
- **Snelheid en apparaat**: op oudere telefoons kan transcriptie langer duren dan de opname zelf; de
  gebruiker moet kunnen annuleren.
- **Eerlijk label**: het resultaat krijgt altijd het label "Automatisch getranscribeerd, kan fouten
  bevatten" en wordt als aparte, bewerkbare tekst bij de bijlage opgeslagen (versleuteld, als
  notitietekst), nooit stilzwijgend in de bestaande notitie gemengd.
- **Zoekindex**: of de transcriptie doorzoekbaar wordt, hangt af van de bestaande lokale zoekindex;
  aparte beslissing.
- Geen server- of cloudtranscriptie. Als dat later gewenst is, is het een andere beslissing met een
  andere privacyverklaring.

## 6. Tests die fase 1 moet hebben

Bestaande tests staan in `tests/` (bijv. `tests/test_store_attachments.js`); volg dat patroon.

Unit/logica (Node, zonder echte microfoon; `MediaRecorder` en `getUserMedia` stubben):
1. Formaatkeuze: webm/opus als ondersteund; anders `audio/mp4`; anders geen opneemknop.
2. Maximale duur: bij 45 minuten stopt de recorder en wordt de opname bewaard (nep-klok).
3. Waarschuwing verschijnt op 40 minuten en op 35 MiB; precies één keer.
4. Bytelimiet: bij 40 MiB aan brokken stopt de opname, ook als de tijd nog niet om is.
5. Opslag via `addAttachment`: bytes in het opgeslagen item zijn versleuteld (geen platte audiobytes
   terug te vinden in IndexedDB-stub of in de payload voor sync).
6. Een bestand boven `MAX_ATTACHMENT_BYTES` wordt geweigerd met de bestaande foutmelding.
7. Geen schrijven naar `localStorage`, `sessionStorage`, IndexedDB of Cache Storage tijdens de opname
   (spy op de stubs) vóór `addAttachment` wordt aangeroepen.
8. Tracks stoppen: na stop, annuleren, fout, `pagehide`, `visibilitychange` en vergrendelen is
   `track.stop` voor elke track aangeroepen en is de indicator verborgen.
9. Geen `getUserMedia`-aanroep zonder klik (bij het laden en bij het openen van een notitie).
10. Geweigerde toestemming (`NotAllowedError`) en geen microfoon (`NotFoundError`) geven een duidelijke
    melding en laten geen halve toestand achter.
11. Afspelen: `createObjectURL` wordt aangeroepen met de ontsleutelde Blob en `revokeObjectURL` bij
    stoppen, sluiten, ander item en vergrendelen; geen cache van ontsleutelde bytes.
12. `kindFromMeta`: `audio/webm`, `audio/mp4`, `.m4a` geven `audio`; `video/webm` niet; `image/*`, `pdf`, `text`
    ongewijzigd.
13. Audio wordt niet naar OCR gestuurd.

Server/headers (Python, bestaande testopzet voor headers):
14. `security_headers()` bevat `microphone=(self)`, `camera=()` en `geolocation=()`.
15. CSP bevat `media-src 'self' blob:` en geen `*`, geen externe hosts erbij voor fase 1.

Handmatig (checklist per release, niet te automatiseren):
16. Chrome, Firefox, Safari (macOS en iOS): opnemen, stoppen, afspelen, herstart, afspelen opnieuw.
17. Echte opname van 45 minuten: bestandsgrootte controleren tegen de berekening in 1.3, en dat
    sync met de server slaagt.
18. Offline opnemen en daarna synchroniseren.
19. Schermlezer: indicator en waarschuwing worden voorgelezen.
