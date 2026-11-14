# XSS-testvectoren voor de rijke editor, weergave en zoeken

Status: specificatie, geen code. Hoort bij [rich-editor.md](rich-editor.md) (idee #52). **Elke latere taak
van dit punt (weergave, codeblokken, tabellen, zoeken, WYSIWYG, Mermaid) moet alle vectoren hieronder
doorstaan** en voegt ze toe aan de geautomatiseerde tests (voorstel: `tests/test_rich_xss_vectors.js`).

## Hoe te testen

Elke vector is Markdown-invoer (`body` van een notitie). Voer hem door elk pad dat tekst toont of
bewerkt: (a) preview/weergave, (b) WYSIWYG na "bron → opgemaakt", (c) plakken in de editor, (d) codeblok-
en tabelcellen, (e) zoekresultaten en zoekmarkering (fragment en `<mark>`), (f) Mermaid-iframe. Rendert de
uitvoer in een echte DOM (jsdom of browser-e2e) en controleer:

- **Geen uitvoering:** er wordt geen script uitgevoerd, `window.__xss` blijft `undefined` (elke payload
  zet `window.__xss = 1` of roept `alert` aan, die in de test is vervangen door een spion).
- **Geen gevaarlijke DOM:** `querySelector('script, iframe, object, embed, link, meta, base, form, style')`
  levert niets op buiten de eigen, vaste Mermaid-iframe; geen element heeft een attribuut dat begint met
  `on`; geen `href`/`src`/`xlink:href`/`action`/`formaction` met schema buiten de allowlist (`https:`,
  `http:`, `mailto:`, `#`, interne notitielink; voor `src` alleen `blob:` en `data:image/png|jpeg|gif|webp`).
- **Tekst blijft zichtbaar:** waar "als tekst" staat, bevat `textContent` de letterlijke payload (de
  gebruiker verliest geen gegevens; de bron wijzigt niet, zie round-trip).
- **Round-trip:** `body` is na weergave en na modus-wissel byte-gelijk aan de invoer.
- **Geen netwerk:** er is geen verzoek naar een externe host ontstaan (afbeeldingen, `<link>`, fonts).
- **Server:** geen enkel verzoek bevat de payload of een zoekterm in leesbare vorm.

## Vectoren

| # | Naam | Invoer (Markdown) | Verwacht resultaat |
|---|---|---|---|
| 1 | Script-tag | `<script>window.__xss=1</script>` | Letterlijke tekst `<script>window.__xss=1</script>` zichtbaar; geen `script`-element; `__xss` ongedefinieerd. |
| 2 | Script in alinea | `Hallo <script>alert(1)</script> wereld` | Hele regel als tekst, inclusief tags; geen uitvoering. |
| 3 | img onerror | `<img src=x onerror="window.__xss=1">` | Als tekst getoond; geen `img`-element met `onerror`; geen verzoek naar `x`. |
| 4 | Markdown-afbeelding met onerror-uitbraak | `![a"onerror="window.__xss=1](x)` en `![x](x" onerror="window.__xss=1)` | Hoogstens een `img` zonder `on*`-attribuut, en alleen als bron toegestaan is (`x` is geen toegestane bron: dan alleen alt-tekst of tekst). Aanhalingstekens in alt/title worden geëscaped. |
| 5 | javascript:-link | `[klik](javascript:window.__xss=1)` | Geen `<a href>` met `javascript:`; getoond als platte tekst `klik` (of link zonder `href`); klikken doet niets. |
| 6 | javascript:-link met verhulling | `[a](JaVa&#x09;Script:alert(1))`, `[a](&#106;avascript:alert(1))`, `[a](java\nscript:alert(1))`, `[a](  javascript:alert(1))`, `[a](<javascript:alert(1)>)` | Alle varianten worden na normalisatie (entiteiten, controletekens, witruimte, hoofdletters) geweigerd; geen `href` met `javascript:`. |
| 7 | data:-link | `[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)` en `[a](vbscript:msgbox(1))` | Geen link; schema's `data:`/`vbscript:` niet toegestaan voor `href`. |
| 8 | svg onload | `<svg onload="window.__xss=1"></svg>` en `<svg><script>window.__xss=1</script></svg>` | Als tekst; geen `svg`-element in de notitie-DOM; geen uitvoering. |
| 9 | SVG-afbeelding | `![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=)` | Geweigerd: `data:image/svg+xml` niet toegestaan als `src`; alleen alt-tekst of tekst. |
| 10 | HTML in Markdown (blokken) | `<div onclick="window.__xss=1">klik</div>`, `<iframe src="javascript:alert(1)"></iframe>`, `<object data="x">`, `<form action="javascript:alert(1)"><button>x</button></form>` | Alles als tekst; geen `div` met `onclick`, geen `iframe`/`object`/`form` uit gebruikersinvoer. |
| 11 | HTML in Markdown (inline) | `**vet** <b onmouseover=alert(1)>x</b> <a href="javascript:alert(1)">y</a>` | `vet` wordt `<strong>`; de rest als tekst; geen `onmouseover`, geen `javascript:`-href. |
| 12 | Attribuut-uitbraak in link | `[a](https://x.nl/"onmouseover="window.__xss=1)` en `[a](https://x.nl/ "title" onfocus=alert(1))` | Hoogstens een link met geëscapete URL/titel; geen extra attributen (`onmouseover`, `onfocus`). |
| 13 | Mermaid click (callback) | ```` ```mermaid ````<br>`graph TD`<br>`A-->B`<br>`click A call alert(1)`<br>```` ``` ```` | Geen klikbaar element met uitvoerbare code; `click`-regel wordt genegeerd of geeft een foutmelding; bron blijft zichtbaar; geen uitvoering. |
| 14 | Mermaid click (href) | ```` ```mermaid ````<br>`graph TD`<br>`A-->B`<br>`click A href "javascript:alert(1)"`<br>```` ``` ```` | Geen `href` met `javascript:` in de SVG-uitvoer (links in diagrammen staan uit); geen uitvoering. |
| 15 | Mermaid init-directive / HTML-label | ```` ```mermaid ````<br>`%%{init: {"securityLevel":"loose","htmlLabels":true}}%%`<br>`graph TD`<br>`A["<img src=x onerror=alert(1)>"]-->B`<br>```` ``` ```` | Directive genegeerd (`securityLevel` blijft `strict`); label als tekst; SVG bevat geen `onerror`, `foreignObject` of `script`; geen uitvoering. |
| 16 | Mermaid iframe-isolatie | Een diagram waarvan de uitvoer `parent.document` / `top.location` / `localStorage` / `indexedDB` benadert (in test: gemockte kwaadaardige iframe-inhoud) | Toegang geweigerd (opaque origin, `sandbox` zonder `allow-same-origin`); app-DOM, IndexedDB en sleutel ongewijzigd; `postMessage` met onjuist schema of ongeldige `event.source` wordt genegeerd. |
| 17 | Codeblok met HTML | ```` ```html ````<br>`<script>window.__xss=1</script>`<br>```` ``` ```` | Kleuring toont de tekst als tokens; geen `script`-element; kopieerknop kopieert de letterlijke ruwe bron. |
| 18 | Taalnaam-uitbraak | ```` ```js"onmouseover="window.__xss=1 ````<br>`x`<br>```` ``` ```` en ```` ```<img src=x onerror=alert(1)> ```` | Taalnaam wordt geëscaped of genegeerd (alleen `[a-z0-9+#-]` toegelaten voor klasse/badge); geen extra attributen of elementen. |
| 19 | Tabelcel | `\| a \| b \|`<br>`\|---\|---\|`<br>`\| <img src=x onerror=alert(1)> \| [x](javascript:alert(1)) \|` | Cellen als tekst, geen `img`, geen `javascript:`-href; tabelstructuur intact (`<table>`, 2 kolommen). |
| 20 | Tabeluitlijning-uitbraak | `\| a \|`<br>`\|:--" onclick="alert(1)\|`<br>`\| x \|` | Geen tabel of een tabel zonder `onclick`; uitlijning komt uit een vaste lijst (`left`/`center`/`right`), niet uit invoer; geen `style`-attribuut uit gebruikersinvoer. |
| 21 | Mutation-XSS (mXSS) | `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`, `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">`, `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">` | Alles als tekst; na sanitizing en opnieuw parsen (serialiseren → `innerHTML`) verschijnt geen `img onerror`; sanitizer-uitvoer is idempotent. |
| 22 | Zoekterm als HTML | In zoekbalk en globale zoekopdracht: `<img src=x onerror=alert(1)>` en `"><script>alert(1)</script>` | Term wordt als tekst getoond (placeholder, "geen treffers", fragment); `<mark>` wordt rond de literale tekst gezet; geen elementen uit de zoekterm. |
| 23 | Treffer-fragment met HTML | Notitie met `<img src=x onerror=alert(1)>` en zoekopdracht `onerror` | Fragment toont de tekst met `<mark>` rond `onerror`; fragment is geëscaped; geen `img`-element in de resultatenlijst. |
| 24 | OCR-tekst met HTML | `ocr_text` van een bijlage: `<script>window.__xss=1</script> factuur` en zoekopdracht `factuur` | OCR-tekst wordt nooit als HTML ingevoegd; fragment geëscaped; geen `script`. |
| 25 | Notitietitel/bijlagenaam | Titel `<img src=x onerror=alert(1)>` en bijlagenaam `"><svg onload=alert(1)>.png` | In lijst, zoekresultaat en WYSIWYG als tekst; geen elementen. |
| 26 | Externe afbeelding (tracking) | `![t](https://tracker.example/pixel.gif)` | Geen automatisch verzoek naar `tracker.example`; getoond als link of tekst (keuze eigenaar, 7.7); `img-src` van de CSP weigert het sowieso. |
| 27 | Autolink/bare URL | `<javascript:alert(1)>` en `https://x.nl/"><script>alert(1)</script>` | Eerste: tekst; tweede: link met geëscapete URL (of tekst), geen `script`. |
| 28 | Voetnoot / referentielink | `[a][1]`<br><br>`[1]: javascript:alert(1)` | Referentie met `javascript:` wordt geweigerd; geen `href`. |
| 29 | Plakken van HTML in WYSIWYG | Klembord `text/html`: `<img src=x onerror=alert(1)><script>…</script><b style="x:expression(alert(1))">x</b>` | Plakken gaat via sanitizer of als platte tekst (voorkeur: Markdown/tekst); geen script, geen `on*`, geen `style`; uitkomst in `body` is Markdown. |
| 30 | Opaak blok met onbekende syntaxis | Front matter `---`<br>`x: <script>alert(1)</script>`<br>`---` en `$$ <img src=x onerror=alert(1)> $$` | Weergegeven als tekst/opaak blok; letterlijk bewaard in `body` (round-trip); geen uitvoering. |
| 31 | Controletekens/Unicode | `[a](java​script:alert(1))` (met zero-width space), `[a](javascript :alert(1))`, bidi-override `‮` in linktekst | Geen `javascript:`-href na normalisatie; bidi-/zero-width-tekens in `href` leiden tot weigering; linktekst toont geen misleidende volgorde buiten de link. |
| 32 | Zeer diepe nesting (DoS) | 10.000× `>` geneste blockquotes, 5.000 geneste lijsten, 1 MB aaneengesloten `*` | Geen vastlopen of stack overflow: weergave breekt af op een diepte-/tijdslimiet en valt terug op platte tekst; UI blijft bruikbaar; geen uitvoering. |

## Aanvullende eisen per laag

- **CSP-test (elke mijlpaal):** de responsheaders van de app bevatten geen `'unsafe-eval'` en geen
  `'unsafe-inline'` in `script-src`; geen nieuwe bronnen in `default-src`, `script-src`, `connect-src`,
  `img-src`. De sandbox-route (Mermaid) heeft een eigen CSP met `default-src 'none'`.
- **Sandbox-test (Mermaid):** het iframe heeft `sandbox="allow-scripts"` en **geen** `allow-same-origin`,
  `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`.
- **Sanitizer-eigenschappen:** idempotent (`clean(clean(x)) === clean(x)`), en een fuzz-ronde (bijv. 10.000
  willekeurige/gemuteerde invoeren uit de vectoren) levert nooit een DOM op met een `on*`-attribuut, een
  `javascript:`-URL of een element buiten de allowlist.
- **Regressie:** een nieuwe gevonden bypass wordt eerst als vector 33, 34, … aan dit document en de test
  toegevoegd, daarna pas verholpen.
