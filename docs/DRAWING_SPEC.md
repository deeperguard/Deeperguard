# Tekeningen in notities — ontwerpspecificatie

Status: ontwerp (idee #68). Er is **nog geen code** gebouwd; dit document is de opdracht voor de bouwtaak.
Alle verwijzingen `bestand:regel` zijn gemeten op `main` bij commit `e0b8278`. Regels verschuiven; zoek bij bouwen op de functienaam.

## 0. Samenvatting

| Vraag | Antwoord |
|---|---|
| Is er al een bijlagemodel? | **Ja.** `type: 'attachment'`-items met versleutelde bytes (`file_enc`), gesynchroniseerd als aparte `blob_ciphertext`. Foto's, scans en PDF's gebruiken het al. |
| Moet het notitieformaat veranderen? | **Nee.** Een tekening is een gewone PNG-bijlage met één extra, optioneel metadataveld `drawing`. |
| Moet de CSP versoepeld worden? | **Nee, geen enkele aanpassing.** `img-src 'self' data: blob:` staat al in de CSP; canvas heeft geen CSP-richtlijn nodig. |
| Kan de server de inhoud lezen? | Nee. PNG-bytes worden client-side met de vault-sleutel versleuteld vóór upload, net als alle andere bijlagen. |
| Maximum | 2048 × 2048 px, ≤ 1 MiB PNG per tekening; ≤ 10 tekeningen en ≤ 8 MiB aan tekeningen per notitie. |

## 1. Opslag, versleuteling en bijlagemodel (bevindingen)

### 1.1 Notitie-inhoud

- Een notitie is een JSON-object `type: 'note'` met o.a. `content` (tekst), `attachments: []` (lijst bijlage-uuid's), `revisions`, `editor`; standaardvorm in `app/static/js/store.js:1045-1065` (`defaultNote`, `attachments: []` op `store.js:1053`).
- Het hele object wordt in `wrapItem` (`store.js:1671-1711`) met `NotesCrypto.encryptObject(state.cryptoKey, wrapContent)` versleuteld (`store.js:1693`), als JSON-string in `ciphertext` gezet en met `content_version: 1` (`store.js:1699`) naar de server gestuurd. De server ziet alleen `ciphertext`, `blob_ciphertext`, `content_hash`, `deleted`, `updated_at`.
- Server-opslag: tabel met `content_version INTEGER NOT NULL DEFAULT 1` (`app/db.py:92`); push-normalisatie `app/db.py:2001`. De server interpreteert de inhoud niet.
- Ontsleutelen: `unwrapItem` (`store.js:1733-1770`) → `decryptCipherPayload` (`store.js:1714`).
- Er is **geen** `schema_version` in de notitie zelf. Versiebeheer van velden loopt via `NotesFreshness` (`__fv`/`__fid`, `app/static/js/freshness.js:116-173`) en via het tolerant doorgeven van onbekende velden (object-spread, bv. `store.js:1436`, `store.js:1451`).

### 1.2 Bijlagemodel (bestaat al)

- Metadata-item: `defaultAttachment` (`store.js:1089-1108`): `type: 'attachment'`, `note_id`, `filename`, `mime`, `size`, `content_sha256`, `file_enc`, `ocr_text`, `ocr_method`.
- De notitie verwijst via `note.content.attachments` (uuid-lijst); koppelen: `linkNoteAttachment` (`store.js:5463`), toevoegen: `addAttachment` (`store.js:5547-5600`), importeren: `importAttachment` (`store.js:5482`), lezen: `getAttachmentBytes` (`store.js:5861`), lijst: `listAttachments` (`store.js:5317`).
- Versleuteling: `NotesCrypto.encryptBytes(state.cryptoKey, raw)` (`store.js:5564`) → `file_enc`. `sealAttachmentContent` (`store.js:5430`) versleutelt achtergebleven platte `data_b64`.
- Synchronisatie: `splitAttachmentBlob` (`store.js:1436-1446`) haalt `file_enc` uit het metadata-item; het metadata-item gaat versleuteld in `ciphertext`, de bytes als `blob_ciphertext`. Terug: `mergeAttachmentBlob` (`store.js:1448-1459`). Lazy download via `/api/sync/blobs` (`store.js:962-995`), lokaal in IndexedDB (`NotesIDB.putBlob`, `store.js:1375`).
- Bestaande gebruikers van dit model: foto/scan-flow in `app/static/js/app.js` (canvas → `toBlob('image/png')` op `app.js:12322`; scan-dialog `app/templates/app.html:2406`), OCR (`ocr_method`, `app.js:11656`), bijlagelijst `renderAttachments` (`app.js:11382`), inline weergave `renderDocInline` (`app.js:13218`, container `app.html:1463`), bestandskeuze `app.html:1473-1474`.
- Dubbelen: `findDuplicateAttachment` (`store.js:1140`) weigert identieke bytes (`store.js:5561`, `5495`).

**Conclusie:** bijlage- en afbeeldingsmodel bestaan en zijn al end-to-end versleuteld en gesynchroniseerd. Een tekening hergebruikt dat model volledig; er komt geen nieuw item-type en geen nieuw synchronisatiepad.

### 1.3 Opslagformaat voor een tekening

Een tekening = één `attachment`-item met:

```jsonc
{
  "type": "attachment",
  "note_id": "<note uuid>",
  "filename": "tekening-2026-11-14-1530.png",
  "mime": "image/png",
  "size": 48213,                 // bytes van de PNG
  "content_sha256": "...",
  "file_enc": { /* encryptBytes(PNG) -> blob_ciphertext bij sync */ },
  "ocr_method": "",              // geen OCR (zie §6); bouwtaak controleert in de OCR-wachtrij dat dit niet alsnog wordt opgepakt
  "drawing": {                   // NIEUW, optioneel
    "v": 1,                      // formaatversie van dit veld
    "w": 1200, "h": 800,         // pixelafmetingen
    "alt": "Schets van de keukenindeling"  // alt-tekst, versleuteld mee
  }
}
```

- De PNG zit in de bestaande versleutelde bijlage-blob. Het `drawing`-veld zit in het versleutelde metadata-item. De server leert niets (geen afmetingen, geen alt-tekst).
- Geen wijziging in de notitie-payload: de notitie verwijst al via `attachments` naar de uuid. `content_version` blijft `1`.
- Bewerken = opnieuw laden van de PNG als achtergrond in het tekenvlak (rasterbewerking; geen vectorgeschiedenis opgeslagen — houdt de payload klein en het formaat simpel). Opslaan vervangt de bytes van hetzelfde attachment-uuid (nieuwe `file_enc`, nieuwe `content_sha256`, `updated_at` omhoog) in plaats van een nieuw item te maken. Hiervoor is een kleine nieuwe store-functie nodig (`replaceAttachmentBytes`, zie §8) omdat `addAttachment` dubbelen weigert.

### 1.4 Versie en achterwaartse compatibiliteit

- **Oude clients** zien een gewoon `attachment` met `mime: 'image/png'`; `kindFromMeta` (`app/static/js/preview.js:74-83`) classificeert dit als `image` en toont/downloadt het zoals elke foto. Het onbekende `drawing`-veld wordt genegeerd en blijft behouden bij spread-kopieën. Er is geen foutpad: geen nieuw `type`, geen nieuwe `content_version`.
- **Nieuwe client, oud item:** `drawing` ontbreekt → gewone afbeelding, niet bewerkbaar als tekening (optioneel: "Bewerken als tekening" mag later; niet in deze taak).
- **Risico om te testen:** een oude client die het attachment bewerkt/opnieuw wrapt kan `drawing` laten vallen als een codepad een whitelist gebruikt. De bouwtaak moet bevestigen dat `upsert`/`strippedAttachmentContent` (`store.js:1581`) onbekende velden behouden (test: roundtrip van een attachment met `drawing`). Verlies is onschadelijk (item degradeert naar gewone PNG).
- Toekomstige `drawing.v > 1`: client toont de PNG gewoon en schakelt "Bewerken" uit als `v` onbekend is.

## 2. Content-Security-Policy

Bron: `content_security_policy()` in `app/auth.py:1061-1131`, ingevoegd als `<meta http-equiv="Content-Security-Policy" content="{{ csp_policy | e }}">` in `app/templates/app.html:6`; `csp_policy` komt uit `app/app.py:150`. Het service worker herinjecteert dezelfde CSP (`app/static/sw.js:186-212`). Letterlijk (app-shell, zonder optionele Google/Dropbox/Turnstile/Stripe/GitHub-uitbreidingen; `<nonce>` per respons):

```
default-src 'self'; script-src 'self' 'nonce-<nonce>' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; frame-src 'self'; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'
```

(`app/auth.py:1115-1130`; `img-src` op `auth.py:1118`.)

Beoordeling:

- `<canvas>` en 2D-context vallen niet onder een CSP-richtlijn. Bestaand gebruik: `app.js:3587`, `12157`, `15912`.
- Tekening tonen als `<img src="blob:…">` mag via `img-src ... blob:`. `data:` mag ook, maar `blob:` heeft de voorkeur.
- `canvas.toBlob('image/png')` en `URL.createObjectURL` zijn vrij van CSP (bestaand: `app.js:3603-3608`, `12322-12325`).
- **Conclusie: tekenen kan zonder enige versoepeling. Geen wijziging aan `auth.py` nodig.** Als de implementatie iets anders blijkt te eisen, is het enige toegestane maximum `img-src` (alleen `blob:`/`data:`, die er al staan); `script-src`, `style-src`, `default-src` en `connect-src` blijven onaangeroerd. Een test (zie §8) controleert dat de CSP-string ongewijzigd is.

## 3. Limieten (bestaand en nieuw)

Bestaand:

| Limiet | Waarde | Plek |
|---|---|---|
| Max. bijlagegrootte client | 50 MiB | `store.js:3`, gebruikt op `5485`, `5549` |
| Max. itemgrootte sync (server) | 75 MiB (`NOTES_SYNC_MAX_ITEM_BYTES`) → status `too_large` | `app/db.py:1824`, `1975` |
| Max. request-body | 80 MiB | `app/app.py:140` |
| Sync-pagina | 3,5 MB (`NOTES_SYNC_PAGE_BYTES`) | `app/app.py:3253` |
| Opslagquota per plan | Free 50 MB, Basic 100 MB, Pro 5120 MB | `app/plans.py:34`, `43`, `52`; afdwingen in `db.py` (push, `quota_exceeded`) |
| Secure Send bijlagen | 50 MB | `secure-send-note-attachments.js:72` |

Nieuw (alleen client-side afgedwongen bij aanmaken én bij laden; de server blijft blind):

| Limiet | Waarde | Reden |
|---|---|---|
| Afmetingen tekenvlak | standaard 1200 × 800; max **2048 × 2048** px (max. 4 Mpx) | begrenst canvasgeheugen op mobiel (iOS-canvaslimiet), houdt PNG klein |
| PNG-grootte per tekening | max **1 MiB (1 048 576 bytes)** na `toBlob('image/png')` | past ruim binnen sync-pagina (3,5 MB) en Free-quota (50 MB ≈ 50+ tekeningen) |
| Aantal tekeningen per notitie | max **10** | voorkomt lange bijlagelijsten |
| Totaal tekeningbytes per notitie | max **8 MiB** | begrenst sync-gewicht per notitie |
| Te grote PNG | eerst verkleinen (stapjes 100% → 75% → 50% van de afmetingen, nooit onder 400 px breed); lukt het dan niet: foutmelding "Tekening te groot" en niet opslaan | PNG kent geen kwaliteitsregel; schalen is de enige hefboom |

Plan: tekeningen tellen mee voor de bestaande opslagquota van elk plan (het zijn bijlagen); er komt **geen** plan-gating (beschikbaar op Free, Basic, Pro). Geen server-wijziging nodig.

## 4. UX

- **Knop "Tekening toevoegen"** in de bijlagesectie (naast "Add file", `app.html:1473`) en in de editor-toolbar (`app.html:1243` e.v.); echte `<button type="button">` met zichtbaar label.
- **Tekenvlak**: modale dialog volgens het patroon van `scan-dialog` (`app.html:2406`, `role="dialog" aria-modal="true" aria-labelledby`). `<canvas>` met Pointer Events (`pointerdown/move/up/cancel`, `setPointerCapture`, `touch-action: none`) voor pen, touch en muis; druk (`pressure`) wordt voor lijndikte gebruikt als aanwezig; `getCoalescedEvents` indien beschikbaar. Geen aparte touch-/mouse-paden.
- **Gereedschap**: pen (3 dikten, kleurkeuze uit klein palet met voldoende contrast), gum (wist naar witte achtergrond), **ongedaan maken / opnieuw** (snapshotstack van max. 30 `ImageData`-stappen of strokes-lijst in geheugen; niet opgeslagen), **Wissen** (met bevestiging), **Opslaan**, **Annuleren** (bij niet-opgeslagen wijzigingen: bevestiging).
- **Achtergrond**: wit gevuld (leesbaar in donkere modus, kleinere PNG dan transparant met antialias).
- **Weergave in de notitie**: als `<img>` in de bestaande bijlagelijst en `renderDocInline` (`app.js:13218`), met `alt` uit `drawing.alt` (valt terug op "Tekening"). Knoppen per tekening: **Bewerken** (opent dialog met PNG als achtergrond) en **Verwijderen** (bestaande bijlage-verwijderflow, `deletedocs`/trash volgt de huidige bijlagelogica).
- **Toegankelijkheid**: knoppen bereikbaar met Tab, tekenvlak zelf is `role="img"` met `aria-label`; invoerveld "Beschrijving (alt-tekst)" in de dialog (verplicht aangemoedigd, niet verplicht gemaakt); focus gaat bij openen naar de dialogtitel/eerste knop, blijft gevangen (focus trap) en keert bij sluiten terug naar de "Tekening toevoegen"-knop; Esc = Annuleren; toetsen voor Ongedaan maken (Ctrl/⌘+Z) en Opnieuw. Resultaat wordt aangekondigd via de bestaande `toast`/live-region ("Tekening opgeslagen"). Toolbarknoppen hebben `aria-pressed` voor de actieve tool. Opmerking: tekenen zelf vereist een aanwijsapparaat; het alternatief voor toetsenbord/schermlezer is de alt-tekst die de inhoud beschrijft.
- **Export**: tekening gaat mee als PNG-bestand bij bijlage-export/zip en download (`downloadAttachment`, `app.js:13699`) onder de bestandsnaam `tekening-*.png`. Markdown-export (`downloadNoteMarkdown`, `app.js:13660`) bevat alleen tekst; geen inline `![]()` toevoegen (zou data/blob-URL's in tekst lekken).
- **Delen**: Secure Send / deellink stagedt bijlagen al via `secure-send-note-attachments.js` (zip bij meerdere, limiet 50 MB, `:72`); tekeningen volgen dat pad ongewijzigd, ook voor E2E-sleutelhandling (`docs/SHARE_LINK_CRYPTO.md`).
- **Preview / zoek**: `preview.js` toont PNG als `image` (`preview.js:74-83`); tekeningen krijgen daar geen aparte route. Lijstthumbnails: bestaand `observeThumb`-pad.
- **Vergrendelde notities**: tekeningen worden niet getoond of bewerkt zolang de notitie vergrendeld is (zelfde gating als `renderAttachments`, `app.js:11388-11399`).
- **Read-only** (`prevent_edit`): knoppen Bewerken/Verwijderen/Toevoegen uitgeschakeld.

## 5. Veiligheid

1. **Alleen PNG.** Geen SVG, geen HTML, geen JPEG/WebP voor tekeningen. Opslaan gebruikt uitsluitend `canvas.toBlob(cb, 'image/png')`. Let op: `preview.js:79` rekent SVG voor gewone bijlagen wel als `image`; dat gedrag voor reguliere bestanden blijft buiten deze taak, maar een bijlage met `drawing` wordt **alleen** als PNG geaccepteerd.
2. **Nooit `innerHTML` voor tekeninginhoud.** Element maken met `document.createElement('img')`, `img.src = URL.createObjectURL(new Blob([bytes], {type: 'image/png'}))`, `img.alt = <alt-tekst als textContent/attribuut>`. Alt-tekst en bestandsnaam gaan nooit ongeëscapet in een HTML-string (bestaande `escapeHtml`/`escapeAttr` blijven verplicht waar sjablonen worden gebruikt). Geen `data:`-URL's van potentieel grote tekeningen in DOM-strings.
3. **Validatie bij laden** (ook voor tekeningen uit import, Secure Send/deellink, sync van een ander apparaat, of een kapotte lokale cache), vóór `createObjectURL`:
   - bytes beginnen met PNG-magic `89 50 4E 47 0D 0A 1A 0A`;
   - lengte ≤ 1 MiB (limiet uit §3), en ≥ 67 bytes (kleinste geldige PNG);
   - IHDR-afmetingen (bytes 16–23, big-endian) ≤ 2048 × 2048 en > 0, en komen overeen met `drawing.w/h` (bij afwijking: `drawing` negeren, niet crashen);
   - bij falen: placeholder "Tekening kan niet worden getoond" met de bestaande downloadknop uitgeschakeld voor deze bijlage; geen uitzondering naar de gebruiker, wel `console.warn`.
   - `mime` wordt niet vertrouwd; de magic bytes beslissen. Een `drawing`-bijlage met `mime` ≠ `image/png` wordt behandeld als gewoon bestand zonder tekenfuncties.
4. Object-URL's worden ingetrokken (`URL.revokeObjectURL`) bij sluiten dialog en bij verlaten notitie (bestaand patroon `app.js:3220`).
5. Geen netwerkverzoeken, geen externe bibliotheken, geen `eval`/Function; CSP ongewijzigd (§2). Geen nieuwe server-endpoints.
6. Canvas-fouten (`toBlob` retourneert `null`, geheugentekort): melding tonen, bestaande notitie en bijlagen onaangeroerd laten. Eerst `persistLocal` slagen, dan pas de notitie wijzigen (zoals `addAttachment` doet, `store.js:5578-5584`).
7. Privacy: de server ziet alleen versleutelde blobs; alt-tekst en afmetingen zitten in het versleutelde metadata-item. Geen telemetrie over tekeningen.

## 6. Buiten scope

Uitdrukkelijk **niet** in deze taak (en niet in de eerste versie):

- **Mermaid**-diagrammen (renderen van code blocks).
- **Excalidraw** (of vergelijkbare vectoreditor/embed).
- **Handschriftherkenning** (stylus → tekst).
- **OCR op tekeningen** (tekeningen worden overgeslagen door de OCR-wachtrij, `app/static/js/ocr.js`, `app/ocr_jobs.py`; zie `ocr_method` in `app.js:11656`).
- Vectoropslag/lagen, gedeeld samen-tekenen, SVG-import/-export, plan-gating, achtergrondafbeelding-annotatie van foto's.

## 7. Tests (voor de bouwtaak)

- Unit (Node, volgens bestaande `tests/*.js`): PNG-validator (magic, lengte, IHDR, mismatch `drawing.w/h`); limietfuncties (schaalstappen, 10 per notitie, 8 MiB totaal).
- Store-roundtrip: attachment met `drawing`-veld → `wrapItem`/`unwrapItem` behoudt het veld; oude-client-simulatie (veld genegeerd) toont nog een `image`-kind via `kindFromMeta`.
- CSP-test: `auth.content_security_policy()` bevat nog steeds `img-src 'self' data: blob:` en is niet verruimd (geen `unsafe-eval`, geen extra `script-src`).
- Beveiligingstest: een bijlage met `mime: image/svg+xml` of HTML-bytes en `drawing`-veld wordt niet als tekening getoond.
- Na wijzigingen onder `app/static`: `python scripts/build-client-manifest.py`.

## 8. Implementatielijst (bouwtaak)

Bestanden en functies:

1. **`app/static/js/drawing.js`** (nieuw; ladenbaar zoals andere `*.js` in `app/templates/app.html`, met nonce-script):
   - `createDrawingPad(container, { width, height, background })`: Pointer Events, pen/gum, undo/redo-stack, `clear()`, `toPngBlob()`.
   - `validatePng(bytes, { maxBytes, maxDim })` → `{ ok, width, height, reason }` (magic bytes, grootte, IHDR).
   - `fitToLimits(canvas)`: schaalstappen voor PNG ≤ 1 MiB.
   - `showDrawingDialog({ noteId, attId? })` met focus trap, alt-tekstveld, Opslaan/Annuleren.
2. **`app/static/js/store.js`**:
   - `addDrawing(noteId, pngBlob, { alt, w, h })`: dunne laag over `addAttachment` (`store.js:5547`) die `mime: 'image/png'`, `drawing: {v:1,w,h,alt}` zet, limieten (§3) controleert en geen OCR start.
   - `replaceAttachmentBytes(uuid, pngBlob, drawingMeta)`: nieuwe `file_enc`/`content_sha256`, `upsert` met `touchUpdatedAt`; geen dubbelencontrole tegen zichzelf.
   - Limiet-constanten naast `MAX_ATTACHMENT_BYTES` (`store.js:3`): `MAX_DRAWING_BYTES`, `MAX_DRAWING_DIM`, `MAX_DRAWINGS_PER_NOTE`, `MAX_DRAWING_BYTES_PER_NOTE`; exporteren naast `maxAttachmentBytes` (`store.js:7137`).
   - `importAttachment` (`store.js:5482`): bij `drawing`-veld of PNG-bijlage met `drawing` de validator toepassen; verwijder veld bij falen.
   - Bevestigen dat `strippedAttachmentContent` (`store.js:1581`) `drawing` bewaart.
3. **`app/static/js/app.js`**:
   - `renderAttachments` (`app.js:11382`) en `renderDocInline` (`app.js:13218`): tekening als `<img>` via `createElement` + blob-URL, `alt` uit `drawing.alt`; knoppen Bewerken/Verwijderen; validator vóór tonen.
   - Nieuwe handler voor de knop "Tekening toevoegen" (bind in de UI-init rond `ui.attachmentInput`, `app.js:151`); respecteer vergrendeld/`prevent_edit`.
   - OCR-wachtrij: tekeningen overslaan (bestaande `ocrPending`-aanroep niet gebruiken; check `attachmentOcrBusy`, `app.js:1333`).
4. **`app/static/js/preview.js`**: geen wijziging nodig voor weergave (`kindFromMeta`, `preview.js:74`); optioneel: voor `drawing`-bijlagen SVG uitsluiten.
5. **`app/templates/app.html`**: knop "Tekening toevoegen" (`app.html:~1473` en toolbar `~1243`), dialog-markup naar patroon `scan-dialog` (`app.html:2406`), `<script src=… nonce>` voor `drawing.js`.
6. **CSS** (bestaande stylesheet in `app/static`): tekenvlak (`touch-action: none`), dialog, toolbar.
7. **`app/auth.py`**: **geen wijziging** (CSP blijft zoals in §2).
8. **Tests**: `tests/` (nieuwe testbestanden volgens §7); `docs/RELEASE_NOTES.md`-regel volgens projectconventie.
9. `python scripts/build-client-manifest.py` uitvoeren na wijzigingen onder `app/static`.
