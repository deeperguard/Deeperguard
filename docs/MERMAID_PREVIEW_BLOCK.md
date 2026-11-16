# Mermaid-preview: geblokkeerde resource in de iframe

Diagnose van taak 218, gemeten op code `58daf3f`. Er is voor deze analyse geen app-code gewijzigd.

## Uitkomst in het kort

- **Het diagram wordt niet getekend.** In een echte Chromium-run staat er in de sandbox-iframe geen `<svg>`
  (`#out svg` bestaat niet), de iframe heeft hoogte 0 en `.md-mermaid` krijgt nooit `is-rendered` of
  `is-error`. Zichtbaar blijft alleen de uitklapregel "Bron van het diagram".
- **Oorzaak:** de app stuurt `Cross-Origin-Resource-Policy: same-origin` op elk antwoord, ook op de twee
  scripts die de Mermaid-sandbox laadt. De iframe heeft `sandbox="allow-scripts"` zonder `allow-same-origin`,
  dus een **opake origin**. Voor zo'n document is elke request naar de eigen server cross-origin, en CORP
  `same-origin` laat Chromium die scriptrequests afbreken met `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`.
  Het sandbox-document zelf laadt wel (navigatie valt niet onder CORP), maar zijn scripts niet. Daardoor
  draait `mermaid-sandbox.js` nooit, komt `dg-mermaid-ready` nooit, en wordt er niets getekend.

## Bewijs (echte browserrun)

Opzet: de echte app (`gunicorn app:app`, dezelfde `_headers`-hook als productie) op `127.0.0.1:8765`;
Playwright/Chromium op die origin. Alleen `/` is vervangen door een lege hostpagina met `<div id="preview">`.
Daarna zijn de echte `/static/js/*`-bestanden geladen (`markdown.js`, `mermaid-view.js`, `preview.js`, ...) en
is `NotesMarkdown.render` + `NotesPreview.decorateCodeBlocks` aangeroepen met een ` ```mermaid `-blok
(`graph TD` / `A[Start] --> B[Einde]`), twee keer achter elkaar (Preview, leegmaken = Edit, opnieuw Preview).
De volledige UI-flow (inloggen, "New note", type Markdown, Preview, Edit, Preview) is dus niet doorlopen; de code die het diagram
opbouwt is wel dezelfde als in de app. Open vervolgpunt: de run via de echte UI, en uitzoeken waarom
`tests/test_mermaid_sandbox_browser.py` de fout mist (nog niet gedaan).

Console en netwerk, bij beide rondes (de log bevat dezelfde twee fouten twee keer):

```
requestfailed http://127.0.0.1:8765/static/js/vendor/mermaid/mermaid.min.js  net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin
requestfailed http://127.0.0.1:8765/static/js/mermaid-sandbox.js             net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin
console.error "Failed to load resource: net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin"  (zelfde twee URL's)
```

**Geblokkeerde URL's:**

1. `/static/js/vendor/mermaid/mermaid.min.js`
2. `/static/js/mermaid-sandbox.js`

Beide staan als `<script src>` in `app/static/mermaid-sandbox.html`.

Resultaat per ronde:

```
ROUND 1  iframe sandbox="allow-scripts"  src=/static/mermaid-sandbox.html  hoogte=0  svg=null  class="md-mermaid"
ROUND 2  idem
```

**Response-headers** (gemeten; de geblokkeerde scripts zelf leverden geen response-object aan de browser,
maar ze krijgen dezelfde `security_headers()` als het gemeten statische bestand `mermaid-view.js`):

| Antwoord | Cross-Origin-Resource-Policy | Cross-Origin-Embedder-Policy | Content-Security-Policy | Overig |
|---|---|---|---|---|
| `/static/mermaid-sandbox.html` | `same-origin` | niet gezet | `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'` | `X-Frame-Options: SAMEORIGIN`, COOP `same-origin-allow-popups` |
| `/static/js/mermaid-view.js` (representatief voor alle `/static/*`) | `same-origin` | niet gezet | app-CSP (`default-src 'self'; ... frame-ancestors 'none'; frame-src 'self'`) | `X-Frame-Options: DENY` |

Bron van de headers: `app/auth.py:1135-1145` (`security_headers()`, regel `Cross-Origin-Resource-Policy:
same-origin`) en `app/app.py:576-604` (sandbox-CSP). COEP komt nergens in de app voor, dus COEP is niet de
oorzaak. De sandbox-CSP (`script-src 'self'`) staat de scripts juist toe; de blokkade komt van CORP, niet van CSP.

**Iframe-instellingen** (`app/static/js/mermaid-view.js`): `sandbox="allow-scripts"` (zonder
`allow-same-origin`), `src=/static/mermaid-sandbox.html`, titel "Mermaid-diagram". De `frame-ancestors`-regel
uit de bugmelding is in mijn run niet opgedoken en is niet de oorzaak: het sandbox-document zelf werd
geladen (`frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` staan het framen door de app toe); alleen
de scripts erin werden geblokkeerd.

## Voorgestelde fix (zonder iets te versoepelen)

Geef alleen de twee eigen, publieke sandbox-assets `Cross-Origin-Resource-Policy: cross-origin`, en laat al
het andere op `same-origin`:

- In `_headers` (`app/app.py`), vóór de `setdefault`-lus over `auth.security_headers()`, voor precies
  `/static/js/vendor/mermaid/mermaid.min.js` en `/static/js/mermaid-sandbox.js` (en hun content-hashed
  varianten via `client_assets.resolve_hashed_static`) `response.headers["Cross-Origin-Resource-Policy"] =
  "cross-origin"` zetten. Dezelfde aanpak als de bestaande uitzonderingen voor de worker-CSP's.
- Niet aanpassen: de app-CSP, de sandbox-CSP, `frame-ancestors` / `X-Frame-Options`, COEP (staat niet aan) en
  `sandbox="allow-scripts"`. De opake origin blijft, dus het diagram heeft nog steeds geen toegang tot
  cookies, localStorage of de app.
- Waarom dit veilig is: beide bestanden zijn publieke, niet-geheime code die al zonder login bereikbaar is
  (alleen toegestaan voor `NOTES_ALLOWED_CIDRS`-clients zoals de rest). `cross-origin` laat dus alleen
  andere sites toe ze als `<script>` te insluiten; dat levert geen data op die niet al publiek is. Het
  document met notitiedata en alle API-antwoorden houden `same-origin`.

Alternatief dat de load weghaalt (meer werk): het sandbox-document bij het serveren zelf met inline script
(CSP-hash) uitleveren zodat er geen subresource-request meer uit de opake origin komt. Dit vraagt een
hash-gebaseerde `script-src` en het sandbox-document inline in de pagina; daarom is de per-asset CORP de kleinste fix.
Niet gemeten: de grootte van dat inline-document.

## Test die dit moet afvangen

De bestaande test `tests/test_mermaid_sandbox_browser.py` serveert de statische bestanden via
`route.fulfill` in plaats van over een echte HTTP-verbinding (ik heb niet onderzocht waarom hij de fout niet
vangt). De regressietest hoort tegen een echte HTTP-server te draaien (zoals
hierboven) en te eisen dat in de iframe `#out svg` bestaat, dat `.md-mermaid.is-rendered` gezet wordt en dat
er geen `ERR_BLOCKED_BY_RESPONSE` in de console staat. Zonder de fix faalt die test (svg = null).
