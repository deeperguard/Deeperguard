# Ontwerp: opgemaakte Markdown-editor, weergave en zoeken in de app

Status: voorstel, nog niet gebouwd. Er is geen code gewijzigd. Dit document hoort bij idee #52 en is de
eerste taak; de bouwtaken (sectie 6) volgen pas na de keuzes van de eigenaar (sectie 7). De XSS-testvectoren
waaraan elke bouwtaak moet voldoen staan in [rich-editor-tests.md](rich-editor-tests.md).

Gelezen code (paden onder `app/`): `static/js/markdown.js` (huidige renderer), `static/js/sanitize.js`,
`static/js/app.js` (preview `NotesMarkdown.render`, `highlightCode`, zoekbalk `find-bar`),
`static/js/search.js` (zoekindex per notitie, OCR-tekst), `static/js/store.js` (notitie-item, bijlagen),
`static/js/crypto.js` (AES-256-GCM), `static/js/idb.js`, `auth.py` (CSP), `app.py` (worker-CSP),
`scripts/build-client-manifest.py`, `static/js/vendor/`. Ook gelezen: `docs/PRIVACY.md`, `docs/LOCAL_CACHE.md`.

## 0. Uitgangspunt: wat er nu al is

1. **Opslag.** Een notitie is een JSON-object (`type: 'note'`, `title`, `body`, `ocr_text`, ...,
   `store.js:1048`). Het hele object wordt in de browser met AES-256-GCM versleuteld (`crypto.js`,
   `encryptObject`) en als ciphertext naar de server gesynct en in IndexedDB bewaard (`idb.js`). `body` is
   gewone tekst; er is geen apart rich-text-formaat.
2. **Weergave.** `markdown.js` is een eigen, kleine renderer (kopjes, nadruk, lijsten, taken, tabellen,
   codeblokken, links). Alle invoer wordt eerst met `escapeHtml` ontdaan van `<`, `>` en `&`; links worden
   alleen toegelaten als `http(s):`, `mailto:` of `#anker`. Er is dus **geen ruwe HTML** in de weergave en
   geen externe bibliotheek. Resultaat wordt via `innerHTML` in de preview gezet (`app.js:1746`).
3. **Codekleuring.** `highlightCode` in `app.js:1677` is een lichte eigen kleurder (strings, commentaar,
   sleutelwoorden); `markdown.js` roept die aan via `window.NotesMarkdownHighlight`. Er is nog geen
   kopieerknop en geen taalspecifieke kleuring.
4. **Zoeken.** `search.js` bouwt per notitie een tekstblob (titel, body, tags, map, bijlagenamen en de
   OCR-tekst van bijlagen) in het geheugen, met vouwen van hoofdletters/diakrieten, frasen en een
   handtekening (`indexSignature`) om herbouwen goedkoop te houden. De bestaande zoekbalk (`find-bar`) zoekt
   binnen één notitie. Er is geen server-side zoekopdracht.
5. **CSP** (`auth.py:1115`): `default-src 'self'`, `script-src 'self' 'nonce-…' 'wasm-unsafe-eval'`,
   `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, `object-src 'none'`,
   `frame-src 'self'`, `worker-src 'self' blob:`. **Let op:** `style-src` bevat vandaag `'unsafe-inline'`.
   Er is geen `unsafe-inline` of `unsafe-eval` voor scripts. Dat blijft zo (sectie 4).
6. **Build.** Er is geen bundler. De frontend is platte JS/CSS onder `app/static/`; gevendorde bibliotheken
   staan in `app/static/js/vendor/` (noble, pdf.js, jsPDF, tesseract, jsQR, heic2any, qrcode-generator).
   `scripts/build-client-manifest.py` hasht elk bestand (SHA-256 + SRI) naar `client-manifest.json` en kan
   met `--check-repro` bewijzen dat een tweede build bit-identiek is. Elke nieuwe bibliotheek moet dus een
   los, vooraf gebouwd bestand zijn dat in de repo staat.

## 1. Wat de gebruiker krijgt

Per onderdeel, in de volgorde van de mijlpalen.

### 1.1 Veilige Markdown-weergave
De huidige renderer wordt uitgebreid (CommonMark + GFM: tabellen, takenlijsten, doorhalen, voetnoten,
autolinks) en de uitvoer gaat altijd door een sanitizer met allowlist (sectie 4.1). Ruwe HTML in Markdown
wordt **als tekst getoond**, niet uitgevoerd. Afbeeldingen alleen uit eigen bijlagen (`blob:`/`data:`), nooit
extern (geen tracking-pixels). Links openen met `rel="noopener noreferrer"`.

### 1.2 Codeblokken met kleuring en kopieerknop
Omheinde blokken (```` ```taal ````) krijgen taalkleuring voor een vaste lijst gangbare talen, een
taalbadge en een kopieerknop (toetsenbord-bereikbaar, met `aria-live`-melding "Gekopieerd"). De knop kopieert
de ruwe broncode, niet de opgemaakte tekst. Kopiëren loopt via het bestaande `clipboard-sensitive.js`, zodat
de wis-na-timeout-afspraak voor het klembord gelijk blijft. Onbekende taal: gewone monospace, geen fout.

### 1.3 Tabellen en tabeleditor
Weergave van GFM-tabellen met uitlijning (`:---`, `:---:`, `---:`) en horizontaal scrollen op smalle
schermen. Tabeleditor: cursor in een tabel toont een werkbalk om rij/kolom boven/onder/links/rechts toe te
voegen, te verwijderen, te verplaatsen, en kolomuitlijning te zetten; Tab/Shift+Tab loopt door de cellen.
De editor schrijft altijd terug als nette GFM-pipetabel (kolombreedtes uitgelijnd alleen als de oorspronkelijke
tabel dat al was, zie round-trip, sectie 2.2).

### 1.4 Ctrl+F binnen een notitie
Ctrl/Cmd+F opent de bestaande zoekbalk, nu ook in de weergave en WYSIWYG-modus: alle treffers gemarkeerd
(met `<mark>`, zonder de DOM-structuur te breken), "3 van 12", Enter/Shift+Enter = volgende/vorige, Esc sluit
en zet de cursor terug. Zoeken negeert hoofdletters en diakrieten (zelfde vouwing als `search.js`). Alleen als
de focus in de notitie staat nemen we Ctrl+F over; anders blijft de browser-zoekfunctie bruikbaar.

### 1.5 Zoeken in alle notities en in OCR-tekst van bijlagen
Bestaat deels (`search.js`). Nieuw: treffers met een fragment en markering, filter "alleen in bijlagen",
duidelijk label of de treffer in de tekst of in een bijlage (OCR) zit, en direct openen op de plek
(`search_open_note` bestaat al). Alles gebeurt **uitsluitend client-side** op het ontsleutelde geheugen
(sectie 3).

### 1.6 WYSIWYG-modus met wissel naar bron-Markdown
Een schakelaar (en sneltoets) wisselt tussen "Opgemaakt" en "Bron". Opgemaakt: kopjes, nadruk, lijsten,
taken, tabellen, codeblokken en links direct bewerkbaar, met Markdown-sneltekens (`## `, `**`, `- [ ] `,
```` ``` ````) en een compacte werkbalk. Bron: de huidige tekstvakweergave. De wissel behoudt cursor en
scrollpositie zo goed mogelijk. Beide modi bewerken dezelfde `body`-string.

### 1.7 Mermaid-diagrammen
Een blok ```` ```mermaid ```` wordt als diagram getoond, gerenderd in een geïsoleerd iframe (sectie 4.4). Bij
een fout of als Mermaid uit staat blijft de bron als codeblok zichtbaar met een korte melding.

### 1.8 Hoe anderen het doen, en waar wij beter willen zijn
*Uit algemene kennis, niet opnieuw geverifieerd; details verschillen per versie en per plugin. Controleer
vóór je ze extern citeert.*

| App | Globaal gedrag (algemene kennis) |
|---|---|
| Standard Notes | Een notitie heeft een "editor" als plugin: gewone tekst, Markdown (split-weergave bron/preview), een rich-text- en een code-editor, deels betaald. Zoeken is client-side in de ontsleutelde gegevens; zoeken in bijlagen is beperkt. |
| Notesnook | Eén rich-text-editor (gebaseerd op Tiptap/ProseMirror) met tabellen, codeblokken met kleuring, bijlagen en Markdown-sneltekens; opslag intern als HTML-achtig document, export naar Markdown. Zoeken client-side. |
| Proton (Drive/Docs/Notes) | Opgemaakte editor in de browser, e2e-versleuteld; Markdown-ondersteuning en zoekfuncties verschillen per product en zijn jonger. |

Waar wij beter willen zijn:

- **Snelheid.** Geen zware editor-kern bij het openen van een notitie: weergave is een string-naar-DOM-pad
  zonder framework; de editor wordt pas geladen bij eerste bewerking (lazy-load, sectie 5). Doel: notitie
  van 50 kB zichtbaar < 100 ms, toetsaanslag-latentie < 16 ms (budgetten in 4.5).
- **Undo/redo.** Eén doorlopende undo-geschiedenis die óók de wissel tussen Bron en Opgemaakt overleeft, per
  notitie, in het geheugen. Tabelbewerkingen, plakken en opmaakacties zijn elk één undo-stap. Geen verlies
  van undo bij autosave of sync-samenvoegen van dezelfde notitie.
- **Sneltoetsen.** Een vaste, gedocumenteerde set (Ctrl+B/I/K, Ctrl+Shift+7/8/9 voor lijsten, Ctrl+Alt+1-3
  voor kopjes, Ctrl+E inline code, Ctrl+/ wissel modus, Ctrl+F zoeken), zichtbaar in een hulpvenster (`?`),
  zonder conflict met schermlezers en met Cmd-varianten op macOS.
- **Opslag zonder lock-in.** Anders dan een eigen documentformaat blijft de notitie leesbare Markdown, ook
  in een export of bij een mislukte editorlaad.
- **Uiterlijk.** Zelfde ontwerptaal als de rest van de app (typografie, donker/licht, ruimte), geen
  "plugin"-gevoel; werkbalk verschijnt in context en verdwijnt bij lezen.

## 2. Datamodel

### 2.1 Markdown blijft het opslagformaat
**Het veld `body` van een notitie blijft een Markdown-string; er komt geen tweede opslagformaat bij.** Geen
HTML, geen ProseMirror-JSON, geen cache van gerenderde uitvoer in het kluisitem. Editor, weergave, zoeken,
export, geschiedenis (`note-history.js`), conflictkopieën en import (`snimport.js`) blijven op dezelfde
string werken. Er is geen schemawijziging en geen migratie. Oudere clients zonder editor lezen de notitie
ongewijzigd. Eventuele nieuwe voorkeuren (standaardmodus, Mermaid aan/uit) staan in de bestaande versleutelde
instellingen (`settings-sync.js`), niet in het notitie-item.

### 2.2 Round-trip-garantie
De regel: **openen, niets wijzigen en sluiten (of wisselen van modus) laat `body` byte-voor-byte gelijk.**
Een bewerking verandert alleen de tekst van het bewerkte gedeelte.

Hoe we dat afdwingen:

1. **Bron-bewarende editor.** De WYSIWYG-laag houdt voor elk blok het oorspronkelijke bronbereik bij
   (offset begin/eind). Bij serialiseren worden onaangeroerde blokken **letterlijk** uit de bron
   teruggeschreven; alleen gewijzigde blokken worden opnieuw gegenereerd. Dat voorkomt stille wijzigingen
   als `*` → `_`, `-` → `*`, `1.` hernummeren, tabelbreedtes herschrijven, regeleinden (CRLF/LF), 
   trailing spaces, harde regeleinden (`␠␠`), `<br>`, of koppen in setext-stijl (`===`).
2. **Normalisatie alleen op verzoek.** Er is geen automatische "opschonen". Een expliciete actie
   "Markdown opschonen" mag normaliseren, met voorbeeld van de wijziging en undo.
3. **Gewijzigde blokken** gebruiken de stijl van de omgeving (zelfde bullet-teken, zelfde nadrukteken als
   het bestaande document); anders de standaard (`-`, `**`, `_`).
4. **Geen schrijven bij laden.** Het openen van een notitie mag nooit een opslag-/sync-actie starten
   (`updated_at` verandert niet door alleen kijken of van modus wisselen).
5. **Test (verplicht voor de WYSIWYG-mijlpaal):** een corpus van echte en vijandige Markdown (CRLF, tabs,
   geneste lijsten, HTML-blokken, voetnoten, front matter, kapotte tabellen, Unicode, 1 MB-notitie). Voor
   elk bestand: `serialize(parse(x)) === x` zonder bewerking, en na één bewerking verschilt alleen het
   bewerkte blok (diff-assertie). Zie sectie 6, mijlpaal 5.

### 2.3 Onbekende of niet-ondersteunde syntaxis
Alles wat de editor niet begrijpt (ruwe HTML-blokken, front matter, wiki-/ID-links, `$$`-formules,
definitielijsten, onbekende fenced-talen, toekomstige syntaxis) wordt een **opaak blok**: bij bewerken
getoond als bron in een gemarkeerd vak ("Niet-ondersteunde opmaak, wordt ongewijzigd bewaard"), bij
serialiseren letterlijk teruggeschreven. Inline onbekende syntaxis blijft tekst. De editor mag zulke tekst
nooit verwijderen, escapen of herschrijven. ID-notitielinks (`notelinks.js`) en backlinks blijven werken
omdat ze in de bron staan. Onbekend is nooit een fout; het is veilig weergeven als tekst.

## 3. Wat de server wel en niet ziet

**Niets nieuws: de server ziet alleen ciphertext, net als nu.** Dit ontwerp voegt geen route, geen veld en
geen metadata toe.

- Notitietekst, opmaak, tabellen, codeblokken, Mermaid-bron, OCR-tekst en bijlagen blijven binnen het
  AES-256-GCM-pakket. Wissel van modus en bewerken gebeuren lokaal; alleen het bestaande gesyncte
  ciphertext-item verandert.
- **Zoeken is uitsluitend client-side.** Er gaat geen zoekterm, geen index, geen treffer en geen
  "zoekanalyse" naar de server. Er komt geen server-side zoekroute. (Bestaande server-OCR is standaard uit;
  zie `PRIVACY.md`.)
- **De zoekindex bestaat alleen in het geheugen** van het open tabblad en wordt bij vergrendelen, uitloggen
  en tabblad sluiten gewist, net als de sleutel. Dit is het huidige gedrag van `search.js`.
- **Persistentie van de index** (sneller opstarten bij grote kluizen) is optioneel en staat in sectie 7
  als keuze. Aanbeveling: *niet bewaren* in de eerste versie. Als het toch komt: alleen als apart
  IndexedDB-record, versleuteld met AES-256-GCM onder een sleutel afgeleid van de kluissleutel (eigen
  HKDF-label), met versienummer en AAD (account + index-versie), gewist bij uitloggen/wachtwoordwissel. Een
  platte index (termen → notitie) zou de inhoud lekken aan wie het apparaat inspecteert, dus nooit
  onversleuteld; ook geen hash per woord (is raadbaar).
- Mermaid en codekleuring draaien lokaal; er wordt niets van een CDN geladen.
- Afbeeldingen in notities komen alleen uit eigen versleutelde bijlagen; externe URL's worden niet
  opgehaald (anders ziet een derde IP en leestijd).
- Klembord: kopieerknop gebruikt het bestaande gedrag; niets gaat naar de server.

## 4. Risico's en maatregelen

### 4.1 XSS
- **Sanitizer met allowlist** na elke render, als laatste stap vóór `innerHTML`/`replaceChildren`. Alleen
  toegestane elementen (`h1-h6, p, br, hr, strong, em, del, code, pre, blockquote, ul, ol, li, input[type=checkbox disabled], table/thead/tbody/tr/th/td, a, img, span, div, mark, button` voor eigen knoppen)
  en attributen (`href, src, title, alt, class, id, align, colspan, rowspan, data-*` uit een vaste lijst).
  Alles anders wordt verwijderd; `on*`, `style`, `srcset`, `formaction`, `xlink:href` nooit.
- **URL-allowlist:** `href` alleen `https:`, `http:`, `mailto:`, `#anker` en interne notitielinks; `src`
  alleen `blob:` of `data:image/(png|jpeg|gif|webp)`. Geen `javascript:`, `vbscript:`, `data:text/html`,
  `data:image/svg+xml`. URL wordt genormaliseerd vóór de test (HTML-entiteiten, controletekens, witruimte,
  hoofdletters).
- **Ruwe HTML in Markdown** wordt niet geparsed maar escaped; `<script>`, `<svg onload>`, `<img onerror>`
  verschijnen als tekst. SVG komt er niet in (ook niet als bijlage-voorbeeld in de notitie).
- **Parser zonder HTML-modus** (`html: false`), dus de sanitizer is tweede verdedigingslinie, niet de enige.
- **Trusted Types** (`require-trusted-types-for 'script'`) als aanvullende maatregel is aanbevolen te
  onderzoeken in mijlpaal 1; niet verplicht.
- **CSP.** Scripts blijven `'self'` + nonce, **zonder `unsafe-inline` en zonder `unsafe-eval`**
  (`wasm-unsafe-eval` is al nodig voor Argon2/tesseract en is geen JS-eval). Dit ontwerp voegt geen
  `script-src`-uitzondering toe. Dus: geen bibliotheek die `eval`/`new Function` gebruikt in het hoofdvenster
  (dat sluit sommige templating- en oude highlighter-versies uit; Mermaid draait daarom apart, 4.4).
  `style-src` heeft nu `'unsafe-inline'`; nieuwe code gebruikt **geen** inline `style=`-attributen en voegt
  geen nieuwe afhankelijkheid daarvan toe (klassen en CSS-variabelen via `CSSOM`), zodat een latere
  aanscherping mogelijk blijft. Een eigen taak om `style-src` aan te scherpen valt buiten dit ontwerp.
- **Tests:** alle vectoren in [rich-editor-tests.md](rich-editor-tests.md), in elke mijlpaal en in zowel
  weergave als WYSIWYG, ook na plakken en na "bron → opgemaakt → bron".

### 4.2 Supply chain
- Alles **gevendord** in `app/static/js/vendor/<naam>/` als vooraf gebouwd, onverkleinde-of-gedocumenteerd
  verkleind bestand; geen CDN, geen `npm install` bij build, geen bundler.
- **Gepind:** exacte versie + upstream-tag/commit + SHA-256 van het upstream-artefact in
  `docs/THIRD_PARTY.md` (nieuw bestand in de eerste bouwtaak; dit ontwerp maakt het nog niet aan). Per
  bibliotheek: naam, versie, licentie (SPDX), bron-URL, hashes, doel, datum van laatste controle, hoe het
  bestand is gereproduceerd (bouwcommando uit de upstream-tag).
- **Hashes:** `build-client-manifest.py` neemt elk gevendord bestand al mee (SHA-256 + SRI); een test
  controleert dat het bestand overeenkomt met de hash in `THIRD_PARTY.md` én met `client-manifest.json`, en
  `--check-repro` blijft groen.
- **Licenties:** alleen permissief (MIT, BSD, Apache-2.0, ISC) en compatibel met BSL 1.1 van dit project;
  geen (A)GPL. Licentietekst staat naast het bestand. Een test faalt als een nieuw vendor-bestand niet in
  `THIRD_PARTY.md` staat.
- **Updates** alleen via een bewuste PR met diff van de upstream-release, lijst van wijzigingen en nieuwe
  hash; geen automatische updates.
- **Minimaliseren:** liever kleine, enkelvoudige bibliotheken met weinig transitieve code; elke bibliotheek
  die HTML of URL's verwerkt krijgt de XSS-vectoren als regressietest.

### 4.3 Prestaties bij grote notities
- Budgetten: 50 kB-notitie weergeven < 100 ms; 1 MB-notitie bruikbaar (scrollen vloeiend, typen < 50 ms
  latentie); zoeken in 10.000 notities < 100 ms per toetsaanslag na eerste opbouw.
- Weergave in chunks per blok en lazy voor zware onderdelen (codekleuring en Mermaid pas als het blok in
  beeld komt, `IntersectionObserver`); boven een drempel (bijv. 500 kB of 20.000 regels) valt de notitie
  terug op Bron-modus zonder opmaak, met melding.
- Editor lazy geladen (eerste bewerking of wissel), niet bij openen. Parser draait incrementeel op het
  gewijzigde blok, niet de hele notitie per toetsaanslag; zware bewerkingen en indexopbouw in een worker
  (`worker-src 'self' blob:` staat al toe).
- Zoekindex: incrementeel per notitie (bestaande `indexSignature`), opbouw in idle-tijd, begrensd
  geheugen voor OCR-tekst (kapt per bijlage af op een vaste limiet, gedocumenteerd).
- Mermaid: maximale bronlengte, maximale rendertijd (time-out, iframe wordt vernietigd), één render tegelijk.
- Meting: een benchmarkscript in `tests/` met vaste fixtures; regressie boven budget faalt de test niet
  hard maar meldt (om flaky CI te vermijden), handmatig getoetst per mijlpaal.

### 4.4 Mermaid in een sandbox-iframe
- Mermaid (en alle code die eval of dynamische stijl nodig heeft) draait in een `<iframe sandbox="allow-scripts">`
  **zonder `allow-same-origin`**, dus met een opaque origin: geen toegang tot cookies, IndexedDB, de
  kluissleutel, het DOM van de app of `window.parent` buiten `postMessage`. Geen `allow-forms`,
  `allow-popups`, `allow-top-navigation`, `allow-modals`.
- Het iframe laadt een eigen statisch document (`/static/mermaid-sandbox.html`) met een **eigen strikte CSP**
  (`default-src 'none'; script-src 'self'; style-src 'self'; img-src data:`; connect geblokkeerd), geleverd
  met een header op die route (zoals nu al voor de workers in `app.py:573`). Als Mermaid `unsafe-eval` zou
  vereisen, geldt die uitzondering alleen voor dit document, niet voor de app.
  *Vóór mijlpaal 6 moet dit met de gekozen Mermaid-versie worden aangetoond; zo niet, dan valt Mermaid af
  of wordt een eval-vrij alternatief gekozen.*
- Communicatie alleen via `postMessage` met strikte schema's: ouder → iframe `{id, source, theme}`; iframe →
  ouder `{id, svg | error}`. De ouder controleert `event.source` (de eigen iframe-referentie) en `id`;
  `origin` is `"null"` bij een sandbox, dus geen vertrouwen op origin-strings.
- **SVG-uitvoer wordt in de ouder opnieuw gesaneerd** (SVG-allowlist: geen `script`, `foreignObject`,
  `on*`, `href` buiten `#`, geen `style` met `url()`) en daarna als `<img src="blob:…">`/geïsoleerd
  getoond, niet inline met `innerHTML` in de app-DOM. Aanbevolen: tonen als `<img>` van een `blob:`-SVG
  (scripts in een SVG-in-`img` draaien niet).
- Mermaid-instellingen: `securityLevel: 'strict'`, `htmlLabels` uit, `click`-handlers en `javascript:`/
  `callback`-interacties uitgeschakeld; `%%{init}%%`-directives in de bron worden genegeerd of gefilterd
  (vector in de testdocument). Links in diagrammen zijn uit.
- Geen netwerk: iframe-CSP blokkeert `connect-src`; lettertypen lokaal.

### 4.5 Toegankelijkheid
- Volledig toetsenbord-bedienbaar: werkbalk met roving tabindex, tabeleditor met pijltjes/Tab, kopieerknop
  bereikbaar, geen toetsenbordval in de editor (Esc, dan Tab verlaat de editor, gedocumenteerd).
- Semantische HTML (`h1-h6`, `table` met `th scope`, `pre/code`), `aria-label`s op alle iconenknoppen,
  `aria-live="polite"` voor "Gekopieerd", "3 van 12 treffers", en fouten.
- Zoekmarkering niet alleen met kleur: ook onderstreping/contrast ≥ 4.5:1; actieve treffer extra
  gemarkeerd; respecteert `prefers-contrast`, `prefers-reduced-motion` en donker/licht.
- Mermaid: elk diagram krijgt een tekstalternatief (de bron in een uitklapbaar `<details>`, `role="img"`
  met `aria-label`); bij fout blijft de bron leesbaar.
- Schermlezer: de WYSIWYG-modus gebruikt `contenteditable` met `role="textbox" aria-multiline="true"`;
  wisselknop meldt de actieve modus. Test met VoiceOver en NVDA minimaal in mijlpaal 5; axe-check in CI voor
  statische onderdelen.
- Touch: doelen ≥ 44 px, werkbalk bruikbaar op mobiel met schermtoetsenbord.

## 5. Bibliotheekkeuze

Criteria: gebundelde grootte (min.+gzip), licentie, onderhoud, **werkt zonder bundler als los, vooraf gebouwd
bestand**, geen eval in het hoofdvenster, en of het onze round-trip-eis (2.2) haalt. Cijfers zijn
orde-van-grootte uit algemene kennis en moeten bij het vendoren worden gemeten.

### 5.1 Markdown-parser
| Optie | Licentie | Grootte (ca.) | Opmerking |
|---|---|---|---|
| Eigen renderer (nu) | eigen | klein | Geen afhankelijkheid, maar geen volledige CommonMark/GFM; elke uitbreiding is eigen onderhoud en bugrisico. |
| **markdown-it** (+ gfm-plugins) | MIT | ~35 kB gz | Volwassen, `html:false`, token-stream met bronregels (`token.map`), beschikbaar als UMD-bestand; goed voor bron-bewarende blokken. |
| marked | MIT | ~12 kB gz | Klein en snel, historisch minder strikt over CommonMark en geeft geen bronbereiken per blok. |
| micromark / remark | MIT | groter, ESM-only graaf | Zeer correct, maar veel pakketten en bundler-gericht. |
| commonmark.js | BSD-2 | ~30 kB gz | Referentie-implementatie, geen GFM-tabellen standaard. |

**Aanbeveling: markdown-it** (UMD, gevendord), met bronposities voor de round-trip. De eigen renderer blijft
als terugval en voor de zeer lichte lijstpreview.

### 5.2 Sanitizer
| Optie | Licentie | Grootte | Opmerking |
|---|---|---|---|
| Eigen allowlist-walker | eigen | zeer klein | Risicovol: sanitizers zijn bekend moeilijk (mXSS). |
| **DOMPurify** | Apache-2.0 / MPL-2.0 (dubbel) | ~8 kB gz | De de-facto standaard, actief onderhouden en door veel beveiligingsonderzoek bekeken; draait zonder bundler als los bestand. Kies de Apache-2.0-licentie. |
| Sanitizer API (`setHTML`) | n.v.t. | 0 | Browserondersteuning nog ongelijk; als verbetering later, niet als basis. |

**Aanbeveling: DOMPurify** met vaste allowlist-configuratie, `RETURN_TRUSTED_TYPE` waar beschikbaar, en
hook die URL-schema's controleert. De eigen `sanitize.js` (escape-helpers) blijft bestaan.

### 5.3 Codekleuring
| Optie | Licentie | Grootte | Opmerking |
|---|---|---|---|
| Eigen `highlightCode` (nu) | eigen | klein | Taalonafhankelijk, beperkt. |
| **highlight.js** (kern + gekozen talen) | BSD-3 | kern ~10 kB gz + ~1 kB/taal | Als los bestand met alleen gekozen talen; geen eval; lazy te laden. |
| Prism | MIT | klein | Minder actief onderhouden de laatste jaren; plugin-model mikt op bundlers/DOM. |
| Shiki | MIT | zeer groot (WASM/grammatica's) | Mooiste kleuring, te zwaar voor ons. |
| CodeMirror 6 (parsers) | MIT | per taal | Deelt code met editorkeuze 5.4. |

**Aanbeveling: highlight.js met ~15 talen** (js, ts, json, python, bash, html/xml, css, sql, yaml, go, rust,
java, c/cpp, markdown, diff), gevendord als eigen build; onbekend → bestaande lichte kleurder.

### 5.4 Editor
| Optie | Licentie | Grootte | Zonder bundler? | Round-trip | Opmerking |
|---|---|---|---|---|---|
| ProseMirror (kern) / Tiptap | MIT | ~100-150 kB gz | Zelf te bundelen tot één vooraf gebouwd bestand; **dat is een build-stap die we nu niet hebben** | Document is een boom; Markdown → boom → Markdown is verliesgevend tenzij we bronbereiken toevoegen | Rijk, goede undo, tabellen-plugin. Zwaarste optie; Tiptap-extensies zijn deels commercieel (Pro). |
| **CodeMirror 6** | MIT | ~150-250 kB gz met Markdown-taal en decoraties | Idem: ESM-pakketten, vooraf bundelen nodig | **Document blijft de Markdown-string**; opmaak is decoratie/widgets over de bron | Natuurlijk "live preview"-model (zoals Obsidian): geen verliesgevende conversie. Goede undo, zoeken, toegankelijkheid is redelijk (contenteditable). |
| Milkdown / Lexical / Quill / Slate | MIT | wisselend | Allen bundler-gericht | Boom-gebaseerd (verliesgevend) | Niet aanbevolen. |
| **Eigen lichte laag** (contenteditable of textarea+overlay) | eigen | klein | Ja, geen build | Volledig onder eigen controle (bron-bewarend) | Veel werk: IME, undo, selectie, mobiel, schermlezers zijn de bekende valkuilen. Het project heeft al een textarea-overlay (`link-overlay.js`, `superscript.js`). |

De harde beperking is "geen bundler". Elke serieuze editor vereist eenmalig bundelen. Voorstel: een
**gedocumenteerde, reproduceerbare vendor-build buiten de runtime** (`scripts/vendor/<naam>/build.sh` met
vastgepinde `package-lock`, draait alleen bij het vernieuwen van de bibliotheek, de uitvoer wordt
ingecheckt met hash). De app-build zelf blijft bundler-vrij; `--check-repro` blijft hetzelfde bewijzen.

**Aanbeveling: CodeMirror 6 in "live preview"-stijl**, gevendord als één vooraf gebouwd bestand. Reden: het
document ís de Markdown-string, dus de round-trip-garantie (2.2) is structureel en niet iets dat we
moeten afdwingen; ingebouwde undo/redo, zoeken en sneltoetsen; lazy te laden. ProseMirror/Tiptap geeft een
"echter" WYSIWYG-gevoel maar maakt Markdown een export en de round-trip tot permanent risico. Alternatief
bij bezwaar tegen de bundelgrootte: eigen lichte laag voor milestone 5 beperkt tot kopjes/nadruk/lijsten/
taken, met CodeMirror alleen voor codeblokken. De eigenaar kiest (sectie 7).

### 5.5 Mermaid
Mermaid (MIT) is groot (~600 kB-1 MB min.; sommige diagramtypen lazy chunks) en historisch het
meest XSS-gevoelig deel (labels, `click`, init-directives); daarom sandbox-iframe en standaard uit
(sectie 7). Alternatief: geen Mermaid, of alleen een kleine subset zelf renderen; niet aanbevolen.

### 5.6 Samenvatting aanbeveling
markdown-it + DOMPurify + highlight.js (lazy) + CodeMirror 6 (lazy, live preview) + Mermaid (lazy, in
sandbox-iframe, standaard uit). Totale extra download alleen bij gebruik; de notitielijst en de
weergave van korte notities blijven licht. Alles gevendord, gepind en gehasht (4.2).

## 6. Mijlpalen

Volgorde: weergave, codeblokken, tabellen, zoeken, WYSIWYG, Mermaid. Elke mijlpaal is zelfstandig te
leveren en voert de XSS-vectoren uit [rich-editor-tests.md](rich-editor-tests.md) uit. Na elke wijziging in
`app/static` draait `python3 scripts/build-client-manifest.py` (en `--check-repro`). Bestandsnamen zijn
voorstellen.

| # | Mijlpaal | Bestanden (nieuw/wijzigen) | Tests |
|---|---|---|---|
| 1 | **Weergave**: markdown-it + DOMPurify, ruwe HTML als tekst, URL-allowlist, afbeeldingen alleen uit bijlagen | `app/static/js/vendor/markdown-it/`, `vendor/dompurify/`, `docs/THIRD_PARTY.md`, `static/js/markdown.js` (adapter, oude renderer als terugval), `static/js/sanitize.js`, `static/js/app.js` (preview), `static/css/*`, `client-manifest.json` | `tests/test_markdown.js`, `tests/test_sanitize.js` uitbreiden; nieuw `tests/test_rich_xss_vectors.js` (alle vectoren), `tests/test_vendor_hashes.py` (hash/licentie/THIRD_PARTY), `tests/test_per_route_csp.py` (geen unsafe-inline/eval voor scripts), manifest-reproduceerbaarheid |
| 2 | **Codeblokken**: kleuring per taal, taalbadge, kopieerknop | `vendor/highlightjs/`, `static/js/code-blocks.js`, `markdown.js`, `clipboard-sensitive.js` (hergebruik), CSS, `THIRD_PARTY.md` | nieuw `tests/test_code_blocks.js` (taal, onbekende taal, kopiëren = ruwe bron, XSS in taalnaam en code), `test_markdown.js`, `test_vendor_hashes.py`, axe/ARIA-check |
| 3 | **Tabellen + tabeleditor** | `static/js/table-editor.js`, `markdown.js`, `app.js` (werkbalk), CSS | nieuw `tests/test_table_editor.js` (rij/kolom +/−, uitlijning, round-trip van tabeltekst, kapotte tabellen, cel met `\|` en HTML), `test_markdown.js`, vectoren in cellen |
| 4 | **Zoeken**: Ctrl+F met markeren en vorige/volgende; zoeken in alle notities en OCR-tekst met fragmenten en filter | `static/js/find-in-note.js`, `static/js/search.js`, `app.js` (find-bar, zoeklijst), CSS | `tests/test_search.js`, `test_search_terms.js`, `test_attachment_search_isolation.js` uitbreiden; nieuw `tests/test_find_in_note.js` (markeren zonder DOM te breken, volgende/vorige, diakrieten, XSS in zoekterm); e2e `tests/e2e_search_highlight.py`; test dat er **geen netwerkverzoek** met zoektermen ontstaat |
| 5 | **WYSIWYG** + wissel naar Bron, undo/redo, sneltoetsen | `vendor/codemirror/` (of keuze eigenaar), `static/js/rich-editor.js`, `static/js/editor-shortcuts.js`, `app.js`, `settings-sync.js` (modusvoorkeur), CSS, `THIRD_PARTY.md` | nieuw `tests/test_rich_roundtrip.js` (corpus, `serialize(parse(x))===x`, onbekende syntaxis, opaque blokken), `tests/test_rich_undo.js`, `tests/test_rich_shortcuts.js`, vectoren bij plakken en typen, e2e wissel Bron↔Opgemaakt zonder `updated_at`-wijziging, toegankelijkheid |
| 6 | **Mermaid** (in sandbox-iframe, standaard volgens keuze eigenaar) | `vendor/mermaid/`, `static/mermaid-sandbox.html`, `static/js/mermaid-host.js`, `app/app.py` (CSP-header voor sandbox-route, in een aparte taak buiten dit design), `THIRD_PARTY.md` | nieuw `tests/test_mermaid_sandbox.js` (sandbox-attribuut zonder `allow-same-origin`, postMessage-schema, `event.source`-check, uitvoer gesaneerd, time-out), `tests/test_per_route_csp.py` voor de sandbox-route, vectoren mermaid-click/init/`javascript:`, handmatige controle op eval-vrij |

Buiten de mijlpalen: wijziging van `style-src`, server-zijdige zoekfuncties (niet gepland) en persistente
zoekindex (alleen na keuze, 7.3).

## 7. Open keuzes voor de eigenaar

Per keuze een aanbeveling; de bouwtaken wachten hierop.

1. **Editorbibliotheek.** Opties: CodeMirror 6 (live preview, document = Markdown), ProseMirror/Tiptap
   (boomdocument), eigen lichte laag. **Aanbeveling: CodeMirror 6**, vanwege de structurele round-trip en
   undo/zoeken ingebouwd; accepteert een gedocumenteerde vendor-build-stap (5.4).
2. **Toelaten van een eenmalige vendor-build-stap** (node + vastgepinde lockfile, alleen bij vernieuwen van
   een bibliotheek, uitvoer ingecheckt). Zonder dit is alleen de eigen lichte laag mogelijk.
   **Aanbeveling: ja.**
3. **Mermaid standaard aan?** **Aanbeveling: standaard uit**, aan te zetten in Instellingen, per apparaat
   of per notitie; bron blijft leesbaar. Reden: grootste aanvalsoppervlak en grootste download; wordt pas
   geladen als een blok wordt weergegeven.
4. **Zoekindex versleuteld bewaren?** **Aanbeveling: nee in de eerste versie** (alleen geheugen, opnieuw
   opbouwen bij ontgrendelen, opbouw incrementeel in idle-tijd). Heroverwegen als metingen laten zien dat
   opstarten bij grote kluizen te traag is; dan alleen versleuteld volgens sectie 3.
5. **Standaardmodus (Opgemaakt of Bron).** **Aanbeveling: Opgemaakt voor nieuwe notities, Bron voor
   bestaande notities tot de gebruiker wisselt**; keuze per gebruiker onthouden in versleutelde instellingen.
   Zo verandert niets onverwacht voor huidige gebruikers, en de round-trip-garantie wordt pas relevant als
   iemand er zelf voor kiest.
6. **Ruwe HTML in Markdown.** **Aanbeveling: altijd als tekst tonen**, ook niet via een "vertrouwde"
   schakelaar. Wie HTML wil, gebruikt codeblokken.
7. **Externe afbeeldingen.** **Aanbeveling: nooit automatisch laden**; een link of eigen bijlage. Optioneel
   later: klik-om-te-laden met uitleg over IP-lek.
8. **Drempel grote notities** (terugval naar Bron). **Aanbeveling: 500 kB of 20.000 regels**, instelbaar.
9. **Aanscherpen `style-src`** (weg met `'unsafe-inline'`). **Aanbeveling: apart traject**, buiten dit punt,
   maar nieuwe code mag er niet van afhangen.
