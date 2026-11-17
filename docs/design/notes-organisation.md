# Notitie-organisatie: mappen, geneste labels, notitielinks, teruglinks en sjablonen

Status: ontwerp, **niet af**. De controle in de draaiende app (§1.1) is geblokkeerd
en staat op escalatie. Geen code gewijzigd. Datum: 2026-11-16. Basis: branch
`bot/task-153-write-design-doc-for-folders-nested-labe` op `03df5ec`.

Dit document beschrijft (1) wat er nu in de code staat, (2) wat de gebruiker
krijgt, (3) het datamodel, (4) wat de server ziet, (5) sync en conflicten,
(6) migratie, (7) risico's, (8) mijlpalen en (9) de keuzes die de eigenaar moet
maken. De oudere specs `docs/NESTED_FOLDERS_SPEC.md` en
`docs/NOTES_ORGANIZATION_SPEC.md` blijven staan. Waar die iets anders zeggen dan
de code, volgt dit document de code. Zo is bijvoorbeeld de zin in
`NOTES_ORGANIZATION_SPEC.md` §1.9 "No UI yet" verouderd: de labelboom is al in de
app geladen.

**Harde regel (ongewijzigd):** de server ziet alleen ciphertext, uuid's,
tijdstippen en de sync-metadata van de tabel in §4. Mappen, labels, links en
sjablonen krijgen geen nieuwe leesbare velden, geen nieuw endpoint en geen nieuwe
kolom.

---

## 1. Inventaris van wat er nu is

Alle regelnummers zijn gelezen uit de werkboom op `03df5ec`. Functies zijn
gecontroleerd met `grep`, en de node-tests die erbij horen zijn uitgevoerd (§1.7).

### 1.1 Controle in de draaiende app: **niet uitgevoerd**

Het opdrachtpunt "controleer in de draaiende app (lokale server) wat labels
kunnen: aanmaken, hernoemen, filteren, verwijderen" is in deze sessie **niet
gehaald**. Stand van de poging, per stap:

| Stap | Resultaat |
| --- | --- |
| Start Flask (`python3 -m flask run --port 5071` vanuit `app/`, `NOTES_ROOT=/tmp/notes-task153-wegwerp`, zoals `tests/e2e_offline_vault.py`) | **Geblokkeerd.** Het commando werd door de goedkeuringsregel van de omgeving tegengehouden, ook in de achtergrond en via een los startscript. Daarom is het server-log niet verkregen. |
| In-process controle (`import app`, Flask test client) | **Geblokkeerd** door dezelfde regel. |
| Stap 1 t/m 5 uit de lijst hieronder | **Niet uitgevoerd.** Geen waarneming, dus geen bevestiging of correctie van de inventaris. |

Het escaleren van de sandbox is bewust niet gedaan. De omgeving moet de start
van de lokale server toestaan. Daarna kan dezelfde controle worden herhaald. De
inventaris hieronder is alleen uit de code en uit de node-tests opgemaakt. De
regelnummers in §1.2 en §1.3 zijn in deze sessie tegen de broncode gecontroleerd
(functies staan op de vermelde regels, of op de aanroep in de UI).

Controle die de eigenaar of een vervolgtaak nog moet doen (één Playwright-run
met een wegwerpinstantie):

1. Registreer, ontgrendel, maak labels `Werk` en daaronder `Projecten` (Manage tags,
   `app.js:18990` `createTag`). Verwacht: de boom toont `Werk > Projecten`.
2. Hernoem `Projecten` naar `Klanten` via de tag-balk (`app.js:9555`
   `renameTagPath`). Verwacht: de titel wordt `Werk / Klanten`.
3. Klik op `Werk` in de zijbalk. Verwacht: de lijst toont notities uit `Werk` én
   `Klanten` (`app.js:9212` `currentTagScope`).
4. Verwijder `Werk` met "sub-labels omhoog" (`app.js:10175` `deleteTag`). Verwacht:
   `Klanten` blijft bestaan, notities verliezen alleen het label.
5. Herhaal op een telefoonbreedte en controleer toetsenbordbediening (pijltjestoetsen
   in de boom, `labeltree.js:101` `navigate`).

### 1.2 Labels (geneste labels: werkt in de data-laag en in de UI)

**Datamodel-laag, `app/static/js/labels.js` (pure functies):**

| Onderdeel | Regel | Wat het doet |
| --- | --- | --- |
| `MAX_DEPTH = 8`, `MAX_LABELS = 2000`, `MAX_NAME = 64` | `labels.js:7-9` | Limieten. |
| `validateName` | `labels.js:26-33` | Weigert lege namen, namen > 64 tekens, en `/` (tenzij `allowSlash`). |
| `migrate` | `labels.js:124` | Leest een legacy label als `name = title`; idempotent. |
| `repair` | `labels.js:144` | Repareert wees-labels en cycli. |
| `planUpdate` | `labels.js:188` | Plant een wijziging (naam, ouder); weigert cycli en te diep nesten. |
| `planDelete` | `labels.js:217` | Plant verwijderen met `promote` (standaard) of `delete` voor subtakken. |

**Store-laag, `app/static/js/store.js`:**

| Functie | Regel | Opmerking |
| --- | --- | --- |
| `defaultTag` | `store.js:1081-1088` | Nieuw label: `type:'tag'`, `title`, `color`. |
| `listTags` | `store.js:5156-5160` | Gesorteerd op `title`. |
| `noteCountForTag` | `store.js:5162-5166` | Telt niet-verwijderde, niet-sjabloon-notities. |
| `renameTag` | `store.js:5177-5183` | Wijzigt de leafnaam via `planUpdate`. |
| `renameTagPath` | `store.js:5190-5208` | Hernoemen via het volledige pad, prefix van de ouder wordt weggehaald. |
| `createTag(name, parentId)` | `store.js:5211-5226` | Schrijft `name`, `parent_id`, `order`, `title_sync` en het volledige pad in `title`. |
| `moveTag` | `store.js:5230-5235` | Verplaatst via `planUpdate`. |
| `migrateLabels` | `store.js:5238-5242` | Schrijft de nieuwe vorm voor legacy-labels. **Wordt door de UI niet aangeroepen** (zie §6). |
| `repairLabels` | `store.js:5245-5248` | Repareert wees-labels en cycli. **Wordt door de UI niet aangeroepen.** |
| `setTagColor` | `store.js:5251-5257` | Kleur via `safeColor`. |
| `deleteTag(uuid, {children})` | `store.js:5260-5271` | Haalt het label uit notities, past de subtakken aan en tombstonet het label. |
| `mergeDuplicateTags` | `store.js:5274-5305` | Groepeert op `(parent_id, naam)`, niet op titel. |

**UI-laag:**

| Onderdeel | Regel | Opmerking |
| --- | --- | --- |
| Labelboom, WAI-ARIA tree | `labeltree.js:25-56` `childMap`, `:57` `visibleRows`, `:74` `html`, `:101` `navigate` | Breekt cycli en wees-labels alleen in het beeld; schrijft niets weg. |
| Open/dicht onthouden | `labeltree.js:140` `loadOpen`, `:149` `saveOpen` | In `localStorage`, alleen de open-status. |
| Doelen voor "verplaats naar" | `labeltree.js:132` `moveTargets` | Sluit het label zelf en zijn afstammelingen uit. |
| Aantallen per label, incl. subtakken | `app.js:9217-9227` `labelCounts` | Elke notitie telt één keer per label. |
| Filter op label, incl. subtakken | `app.js:9212` `currentTagScope` → `app.js:10070, 11049, 11061` | Zelfde scope als de boom. |
| Verplaatsen | `app.js:9288` `NotesStore.moveTag` | Via dialoog. |
| Hernoemen | `app.js:9555` `renameTagPath` | Via pad. |
| Aanmaken | `app.js:18990` `createTag` | Met optionele ouder. |
| Verwijderen, met subtakken | `app.js:10153-10189` | Dialoog met twee keuzes. |
| Dubbele labels samenvoegen | `app.js:7012`, `app.js:7227` `mergeDuplicateTags` | Na import. |

**Geladen in de pagina:** `app/templates/app.html:2941-2942` (`labels.js`,
`labeltree.js`) en `app/static/client-manifest.json` (regels 220-230).

**Legacy-labels in de inventaris:** een label zonder `name` is een platte label.
`NotesLabels.nameOf` (`labels.js:12`) gebruikt dan `title`.

### 1.3 Mappen (nog plat)

| Onderdeel | Regel | Opmerking |
| --- | --- | --- |
| `defaultFolder(title)` | `store.js:1071-1078` | Alleen `type:'folder'`, `title`, `created_at`, `updated_at`. Geen ouder, geen volgorde. |
| `listFolders` | `store.js:5112-5116` | Gesorteerd op `title`. |
| `notesInFolder` | `store.js:5118-5122` | Matcht `note.folder_id`; sluit trash en sjablonen uit. |
| `createFolder(title)` | `store.js:5124-5129` | **Controleert geen dubbele naam.** |
| `renameFolder` | `store.js:5131-5143` | Controleert dubbele naam, hoofdletterongevoelig. |
| `deleteFolder` | `store.js:5145-5154` | Zet `folder_id` van notities op `''` met `touchSyncOnly`, daarna `remove`. Notities worden niet gewist. |
| Aanmaken in UI | `app.js:18451`, `app.js:20253`, `app.js:20329` | Drie plekken. |
| Hernoemen in UI | `app.js:9670` | Bij `renameFolder`. |
| Verwijderen in UI | `app.js:9818` | Bij `deleteFolder`. |
| Filter in UI | `app.js:20672-20687` | Filterkeuze `folder`. |

Een notitie heeft één map: `note.folder_id` (een uuid of `''`). De notitie-
standaardwaarden (`store.js:1048-1067`) bevatten geen `folder_id`, en de code leest
het als `undefined`, dus als "geen map". Dat werkt, maar het is niet expliciet.

De map-tests: `tests/test_folder_tag_explain.js` (de uitleg "één map, meerdere
labels" in de UI). Geen test voor nesting, want die bestaat nog niet.

### 1.4 Notitielinks (werkt)

| Onderdeel | Regel | Opmerking |
| --- | --- | --- |
| Opslagvorm `[titel](dg-note:<uuid>)` | `notelinks.js:4` (commentaar), `:12` (`LINK_SRC`) | UUID in kleine letters, strikt patroon. |
| `buildLink` | `notelinks.js:30-33` | Titel wordt opgeschoond (geen `[]`, geen newlines). |
| `findLinks` | `notelinks.js:52-70` | Negeert links in code (`codeRanges`, `:36`). |
| `findTrigger` (het `[[`-trigger) | `notelinks.js:71` | Typeopdracht in de editor. |
| `searchNotes` | `notelinks.js:88` | Sluit de eigen notitie en sjablonen en getrashte notities uit. |
| `resolve` | `notelinks.js:119` | Titel uit de **live** notitie, niet uit de linktekst. |
| `anchorHtml` (dood en levend) | `notelinks.js:126-140` | Dode links krijgen een eigen status (`note-link-dead`). |
| `prepareRender` | `notelinks.js:143` | Wordt aangeroepen vanuit `app.js:1762-1763`. |
| `removeLink`, `relinkLink` | `notelinks.js:163`, `:170` | Bij verwijderen en hernoemen. |
| `attachPicker` | `notelinks.js:181`, aangeroepen in `app.js:20771` | Picker met toetsenbord. |

**Markdown-filter:** `markdown.js` laat links alleen door voor `https?:` en
`mailto:` (`NOTES_ORGANIZATION_SPEC.md` §0). De `dg-note:`-links worden via
`NotesLinks.prepareRender` apart verwerkt (`app.js:1762-1763`), vóór de
sanitizer.

### 1.5 Teruglinks (werkt, alleen in het geheugen)

| Onderdeel | Regel | Opmerking |
| --- | --- | --- |
| Modulekop: alleen geheugen | `backlinks.js:1-10` | "Memory only: never touches localStorage, sessionStorage, IndexedDB, caches or the network." |
| `scan` | `backlinks.js:36` | Zoekt `](dg-note:` in de tekst. |
| `update` (per notitie) | `backlinks.js:64` | Werkt alleen die notitie bij. |
| `build` (chunked, met yield) | `backlinks.js:124` | Bouwt de index opnieuw. |
| `linksTo`, `outgoingOf`, `snippet` | `backlinks.js:160`, `:171`, `:176` | Lezen uit de index. |
| `renderPanel` | `backlinks.js:212` | Paneel met context. |
| `connect` (koppelt aan sync) | `backlinks.js:286`, aangeroepen in `app.js:20748` | Debounce. |
| `clear` | `backlinks.js:191`; aangeroepen in `store.js:866` | Wordt bij vergrendelen gewist. |

### 1.6 Sjablonen (werkt, als vlag op een notitie)

| Onderdeel | Regel | Opmerking |
| --- | --- | --- |
| Sjabloon = notitie met `is_template: true` | `templates.js:2-3` (commentaar), `:43` `isTemplate` | Versleuteld in de notitie. |
| Variabelen | `templates.js:10-11` (standaardformaten), `:29` `fill` | Alleen toegestane tokens; de rest blijft staan zoals getypt. |
| `templateFromNote` | `templates.js:68-89` | Zet een notitie om naar sjabloon. |
| `noteFromTemplate` | `templates.js:91-110` | Nieuwe notitie; sluit `is_template` uit en behoudt alleen bestaande labels. |
| `saveAsTemplate` | `templates.js:119` | Via `app.js:18888`. |
| `listTemplates` | `templates.js:128` | Lijst voor de picker. |
| `createFromTemplate` | `templates.js:134` | Via dialoog. |
| `createDialog` | `templates.js:151` | Dialoog met toetsenbord (`role="option"`, `templates.js:198`). |
| UI-aansluiting | `app.js:18884-18930` | Opslaan en gebruiken. |
| Uitsluiten uit lijsten | `store.js:5120`, `:5164`; `app.js:1843`, `:2177`, `:9220`; `search.js:928-932`; `backlinks.js:71`; `notelinks.js:92` | Acht plekken checken `is_template`. |

### 1.7 Sync, export en server

| Onderdeel | Regel | Opmerking |
| --- | --- | --- |
| Versleuteling | `crypto.js:114-119` `encryptObject` | AES-256-GCM via noble, `JSON.stringify`, willekeurige IV, **zonder AAD** (de variant mét AAD staat op `crypto.js:145-146`). |
| Eén ciphertext per item | `store.js:1685-1725` `wrapItem` | `content_hash` = hash van de ciphertext (`store.js:1709`). |
| Serveritems | `app/db.py:88-101` (tabel `items`) | `user_id`, `item_uuid`, `content_version`, `ciphertext`, `content_hash`, `deleted`, `updated_at`. `blob_ciphertext` komt er via `ALTER` (`db.py:332-333`). |
| Upsert | `app/db.py:1847-1890` | Schrijft ciphertext en metadata, niets anders. |
| Endpoints | `app/app.py:3387` (GET items), `:3413` (pull), `:3441` (POST items), `:3260` (item) | Ontvangt `item_uuid` en `ciphertext` (`app.py:3455-3457`). |
| Conflicten, notities | `store.js:3653-3720` `resolvePushConflict` | Bij conflict met een notitie: `keepConflictCopy` (`store.js:1491-1544`), tenzij het lokale bewerk van hetzelfde apparaat is. |
| Conflicten, andere typen | `store.js:3720+` | Nieuwste bewerkingstijd wint (LWW). Labels en mappen vallen hieronder. |
| Vergrendelen | `store.js:866` | Wist de teruglinks-index. |
| Volledige backup | `app.js:24720` (formaat `deeperguard-backup-v1`), `app.js:23757-23788` (download `.dgbackup`) | Items als ciphertext. `user_email` en `kdf_salt` staan **onversleuteld** in het bestand. |
| Markdown-export per notitie | `app.js:13750-13760` `downloadNoteMarkdown` | Schrijft `# titel` + tekst. **Geen labels, geen map, geen links omgezet.** |
| Import | `store.js:7057` `importBackup`; Standard Notes-import `store.js:7068-7075` | |

**Tests die dit dekken en die ik in deze sessie heb uitgevoerd** (node, alles
`ok`): `tests/test_nested_labels.js`, `tests/test_label_tree.js`,
`tests/test_tag_manage_rename.js`, `tests/test_templates.js`,
`tests/test_templates_ui.js`, `tests/test_notelinks.js`,
`tests/test_note_title_links.js`, `tests/test_backlinks.js`,
`tests/test_backlinks_store.js`, `tests/test_folder_tag_explain.js`.

---

## 2. Wat de gebruiker krijgt

### 2.1 Doel

De gebruiker kan notities ordenen (mappen die in elkaar zitten, labels die in
elkaar zitten), notities aan elkaar koppelen en terugzien waar een notitie
vandaan wordt gebruikt, en sjablonen gebruiken. Dat gebeurt zonder dat de server
iets kan lezen.

### 2.2 Wat er nu al is, en wat er nog ontbreekt

| Functie | Nu | Ontbreekt |
| --- | --- | --- |
| Labels aanmaken, hernoemen, verplaatsen, verwijderen | Ja (§1.2) | Eén onderdeel: een actie om legacy-labels met `/` te ordenen. |
| Labels filteren op boom | Ja, incl. subtakken | Visuele controle in de app (§1.1). |
| Mappen aanmaken, hernoemen, verwijderen, filteren | Ja, maar **plat** | Nesting. |
| Notitie in een map | Ja (één map) | Verplaatsen met slepen en toetsenbord is niet gecontroleerd. |
| `[[`-links naar notities | Ja (§1.4) | Controle op delen (§7). |
| Teruglinks-paneel | Ja, in geheugen (§1.5) | Prestatiemeting op grote kluizen (`NOTES_ORGANIZATION_SPEC.md` §4.5). |
| Sjablonen | Ja, als vlag (§1.6) | Eigen type (zie §3.4). |
| Export met labels, map en links | Nee | Markdown-export is alleen tekst. |

### 2.3 Vergelijking met de concurrenten

> **Let op:** deze tabel komt uit **modelkennis**, niet uit een opzoeking op de
> sites van de aanbieders. Hij kan verouderd zijn of onjuist. Controleer de
> functies vóór er publieke tekst op gebaseerd wordt.

| Onderwerp | Standard Notes | Notesnook | Proton (Docs / Pass) | Deeperguard (nu / ontwerp) |
| --- | --- | --- | --- | --- |
| Mappen | Geen echte mappen; labels (tags) | Notitieboeken, met subboeken | Docs in Drive-mappen; Pass heeft vaults | Nu plat; ontwerp: genest via `parent_id` |
| Labels | Tags, met hiërarchie (modelkennis) | Tags, plat | Pass: geen notitielabels | Genest, pad-titel voor oude apps |
| Links tussen notities | Niet als kernfunctie (modelkennis) | Interne links (onzeker) | Docs: links naar documenten | `[titel](dg-note:uuid)`, id-gebaseerd |
| Teruglinks | Niet (modelkennis) | Onzeker | Niet bekend | In geheugen, nooit opgeslagen |
| Sjablonen | Niet als kernfunctie (modelkennis) | Ja (modelkennis) | Docs-sjablonen (modelkennis) | Ontwerp: eigen versleuteld type |
| Zero-knowledge | Ja | Ja | Ja (per aanbieder) | Ja, gecontroleerd in §4 |

**Wat we willen bereiken:** de organisatie van Obsidian (`[[`-flow, teruglinks),
de id-stabiliteit van Joplin en Evernote (links breken niet bij hernoemen), de
lage drempel van Notion (picker), en de zero-knowledge van de anderen zonder hun
beperkingen. Op de uitstraling en het gevoel: de labelboom en de picker moeten met
toetsenbord en op telefoonbreedte even goed werken. Dat is nog niet gecontroleerd
(§1.1).

---

## 3. Datamodel

Alles hieronder zit **binnen de bestaande AES-256-GCM-ciphertext** van een item,
behalve de uuid, de tijden en de `deleted`-vlag die de server al kent. Geen van
deze velden gaat als platte tekst naar de server.

### 3.1 Mappen: één versleuteld item per map (gekozen)

**Gekozen:** één item per map, `type: 'folder'`:

```
{
  type:       'folder',
  title:      string,   // naam; oude clients tonen dit als platte map
  parent_id:  string,   // uuid van de ouder, '' = root
  order:      number,   // fractioneel sorteersleutel, zoals labels (NotesLabels.nextOrder, labels.js:112)
  created_at, updated_at
}
```

**Motivatie.** De keuze tussen één item per map en één versleutelde boomblob:

- **Consistent met labels.** Labels zijn al een item per label met `parent_id` en
  `order` (`labels.js`). Dezelfde functies, dezelfde tests en dezelfde reparatie
  werken voor mappen.
- **Kleine schrijfacties.** Een map verplaatsen wijzigt één item. Bij een boomblob
  wordt de hele boom herschreven bij elke verplaatsing.
- **Conflicten per item.** Twee apparaten die verschillende mappen wijzigen,
  raken elkaar niet kwijt. Bij een blob verliest één van beiden de wijziging van de
  ander.
- **Schaalt mee.** Een boomblob groeit met de hele kluis; een item blijft klein.
- **Nadeel dat we accepteren:** wees-mappen en cycli kunnen ontstaan door twee
  apparaten. Dat repareren we bij het lezen, zoals bij labels (§5).

### 3.2 Geneste labels: `parent_id` (gekozen, al gebouwd)

Labels gebruiken `parent_id` (zie §1.2). De titel blijft het **volledige pad**
(`"Werk / Klanten"`), zodat oude clients geen twee takken met dezelfde bladnaam
kunnen samenvoegen (`mergeDuplicateTags` groepeert nu op `(parent_id, naam)` in
`store.js:5274-5284`).

Vorm, zoals de code het schrijft (`store.js:5211-5226`):

```
{
  type: 'tag',
  title:      string,  // volledig pad, voor oude clients
  name:       string,  // bladnaam, 1-64 tekens, zonder '/'
  parent_id:  string,  // '' = root
  order:      number,
  title_sync: string,  // titel die dit apparaat laatst schreef; zie §5
  color, created_at, updated_at
}
```

Waarom `parent_id` en geen pad als identiteit: een hernoemde ouder moet niet alle
kinderen herschrijven, en een pad is niet stabiel als identiteit (twee apparaten
die hernoemen maken dubbelen). `parent_id` met een uuid is stabiel.

### 3.3 Notitie naar map: veld in de notitie (gekozen, al gebouwd)

`note.folder_id` (een uuid of `''`) staat in de versleutelde notitie. Eén map per
notitie. Verwijderen van een map zet `folder_id` op `''` (`store.js:5145-5154`).

Veld niet expliciet in `defaultNote` (`store.js:1048-1067`). Voorstel: toevoegen
als `folder_id: ''` in de standaardwaarden. Dat is een klein, veilig
wijziging: bestaande notities missen het veld, en de code leest het als `''`.

### 3.4 Notitielinks en teruglinks

**Syntax: `[titel](dg-note:<uuid>)` (gekozen, al gebouwd).**

- De link wordt opgeslagen in de versleutelde tekst van de notitie
  (`notelinks.js:12`).
- Het `[[`-triggert alleen de picker (`notelinks.js:71`). Wat in de tekst staat, is
  de markdown-vorm met het uuid.
- Het uuid is stabiel: hernoemen van de doelnotitie breekt de link niet.
- De weergave gebruikt de **live** titel van de doelnotitie (`notelinks.js:119`).
  De titel in de linktekst is alleen een terugvaloptie.

**Waarom niet `[[titel]]`:** de titel is de identiteit, dus hernoemen breekt
links, en twee notities met dezelfde titel zijn niet te onderscheiden. Dat is de
fout die Obsidian oplost met een herschrijving bij hernoemen. Met een uuid is dat
niet nodig.

**Teruglinks: alleen een lokale index in het geheugen (gekozen, al gebouwd).**
`backlinks.js` bouwt de index uit ontsleutelde notities. Hij wordt nooit
opgeslagen, en `store.js:866` wist hem bij vergrendelen.

### 3.5 Sjablonen: eigen versleuteld type (aanbevolen, nog te bouwen)

Nu is een sjabloon een notitie met `is_template: true` (`templates.js:43`, `:68-89`).
De opdracht vraagt een eigen type. Aanbeveling:

```
{
  type:  'template',
  title: string,       // naam van het sjabloon
  body:  string,       // tekst met variabelen ({{date}}, {{time}}, {{title}})
  tags:  [uuid],       // labels die bij een nieuwe notitie horen
  created_at, updated_at
}
```

**Waarom een eigen type en niet de vlag:** de vlag wordt op acht plekken
gecontroleerd (§1.6, laatste regel). Een eigen type maakt uitsluiten uit lijsten,
zoekopdrachten, aantallen en teruglinks één controle, en het voorkomt dat een
sjabloon per ongeluk als gewone notitie gesynchroniseerd of getoond wordt. Dat
hoeft niet met de vlag. Gebruik van het sjabloon is hetzelfde als nu: een nieuwe
notitie met de tekst na het invullen van variabelen (`templates.js:29` `fill`).

Migratie van bestaande `is_template`-notities staat in §6.

---

## 4. Wat de server ziet

Alle velden hieronder komen van de code. "Versleuteld" betekent: zit in de
ciphertext van het item en is voor de server niet leesbaar.

| Gegeven | Waar opgeslagen | Versleuteld? | Wat de server ziet |
| --- | --- | --- | --- |
| Mapnaam | `folder`-item-ciphertext | **Ja** | Niets; alleen de lengte van de ciphertext. |
| Map: ouder (`parent_id`) | `folder`-item-ciphertext | **Ja** | Niets. |
| Map: volgorde (`order`) | `folder`-item-ciphertext | **Ja** | Niets. |
| Aantal mappen | Aantal `items` met een `item_uuid` | **Nee** (als aantal) | Aantal items, en wanneer ze gewijzigd worden. |
| Notitie in map (`folder_id`) | notitie-ciphertext | **Ja** | Niets; wel dat de notitie is gewijzigd op dat moment. |
| Labelnaam, kleur, pad | `tag`-item-ciphertext | **Ja** | Niets. |
| Label: ouder en volgorde | `tag`-item-ciphertext | **Ja** | Niets. |
| Labels per notitie (`note.tags`) | notitie-ciphertext | **Ja** | Niets. |
| Boomvorm (wie onder wie) | Verspreid over `tag`-items | **Ja** | Niets van de vorm; wel een burst van schrijfacties bij een grote verplaatsing (aantal items gewijzigd tegelijk). |
| Notitielinks (`dg-note:uuid`) | notitie-tekst | **Ja** | Niets; wel de grootte van de notitie. |
| Doel van een link (uuid) | notitie-tekst | **Ja** | Niets. |
| Teruglinks-index | Alleen browsergeheugen | n.v.t. | **Niets**; wordt nooit verzonden of opgeslagen. |
| Sjabloon (vlag of type) | notitie- of sjabloon-ciphertext | **Ja** | Niets van het sjabloon; wel het aantal items en hun grootte. |
| Sjabloontekst en variabelen | sjabloon-ciphertext | **Ja** | Niets. |
| Item-uuid (per item) | `items.item_uuid` | **Nee** | Ja. Een willekeurige v4-uuid. Hij zegt niets over de inhoud, maar hij maakt het aantal en de timing zichtbaar. |
| `content_version`, `deleted`, `rev`, `updated_at` | `items` (`db.py:88-101`, upsert `db.py:1847-1890`) | **Nee** | Ja. Tijdstempels en de tombstone-vlag. |
| `content_hash` | `items.content_hash` (`store.js:1709`) | **Nee** | Ja. Het is een hash van de **ciphertext**, niet van de inhoud. |
| Grootte van de ciphertext | `items.ciphertext` | **Nee** (afgeleid) | Ja. Ongeveer de grootte van de inhoud plus een vaste AES-GCM-overhead. |
| Herinnering op een notitie: uuid en tijdstip | `note_reminders` (`db.py:119-131`, `db.py:2667-2680`) | **Nee** | Ja: welke notitie (uuid) en wanneer. De titel wordt niet opgeslagen (`title = ''`). |
| Backup-bestand: `user_email`, `kdf_salt` | `.dgbackup`-download (`app.js:24720`) | **Nee** | Niet op de server, maar wel in het bestand dat de gebruiker downloadt. Dat bestand moet de gebruiker zelf bewaren. |
| Markdown-export per notitie | Lokaal bestand (`app.js:13750-13760`) | **Nee** | Niet op de server. Bevat titel en tekst in het klaar, zonder labels, map of links. |

**Conclusie:** er komen geen nieuwe leesbare velden bij. Wat de server wel kan
afleiden: het aantal items, hun grootte, wanneer ze gewijzigd worden, en welke
notities herinneringen hebben. Dat is ook zo bij de bestaande labels en notities.

---

## 5. Sync en conflicten

De huidige code en het ontwerp naast elkaar. Alles wat de server oplost, gebeurt
op basis van tijdstempels of ciphertext, niet op inhoud.

| Scenario | Nu | Ontwerp |
| --- | --- | --- |
| **A: twee apparaten verplaatsen dezelfde map naar verschillende ouders** | LWW per item (`store.js:3720+`): één verplaatsing wint, geen gegevensverlies in de tekst. De winnaar hangt af van de klok. | Zelfde LWW, met een vaste tiebreak op uuid zodat elk apparaat dezelfde uitkomst kiest. |
| **B: apparaat 1 verplaatst notitie N naar map X, apparaat 2 bewerkt de tekst van N** | Notitieconflict: `keepConflictCopy` maakt een "(conflict copy)"-notitie (`store.js:3712`, `:1491-1544`). Dat is onwenselijk voor een verplaatsing. | Als het enige verschil metadata is (`folder_id`, `tags`, `order`), voeg de metadata samen (nieuwste per veld) en maak **geen** conflictkopie. Bij een echte tekstwijziging blijft de huidige regel. Dit gebeurt alleen op de client, na ontsleuteling. |
| **C: apparaat 1 maakt B onder A, apparaat 2 maakt A onder B** (cykel) | Op één apparaat weigert `planUpdate` cycli (`labels.js:188`). Over twee apparaten heen blijft de cykel staan. De boomweergave breekt hem alleen in het beeld (`labeltree.js:25-56`). `repairLabels` wordt niet aangeroepen, dus de cykel wordt niet weggeschreven. | Repareer bij elke ontsleuteling of sync-pull, en schrijf de reparatie één keer weg. Deterministisch: het label met de oudste ouder-koppeling wordt root (`NOTES_ORGANIZATION_SPEC.md` §1.6). |
| **D: apparaat 1 verwijdert map M, apparaat 2 zet een nieuwe notitie in M** | `deleteFolder` heeft M niet meer. De nieuwe notitie houdt `folder_id = M`. `notesInFolder` vindt M niet, dus de notitie valt buiten de mappen. Niets gaat verloren, maar de notitie is onzichtbaar in de boom. | Een notitie met een onbekende `folder_id` telt als root; schrijf `''` één keer weg (vergelijkbaar met labels). Niets wordt verwijderd. |
| **E: map M met notities verwijderen** | `deleteFolder` zet de notities op root met `touchSyncOnly` en tombstonet M (`store.js:5145-5154`). Notities blijven bestaan. | Zo laten, met de keuze uit §9-3 voor submappen. |
| **F: twee mappen met dezelfde naam, op één apparaat** | `createFolder` laat dit toe (`store.js:5124-5129`), `renameFolder` niet (`store.js:5136-5139`). Inconsistent. | Dubbele namen onder **dezelfde ouder** weigeren, zoals labels (`NotesLabels.siblingNameTaken`, `labels.js:87`). Namen in verschillende takken mogen. |
| **G: een oude client hernoemt een label met kinderen** | Titel wordt herschreven; de bladnaam volgt niet. | `title !== title_sync` wordt herkend en de nieuwe titel wordt de bladnaam (`NOTES_ORGANIZATION_SPEC.md` §1.6). Dit staat nog niet als wetenschappelijk gecontroleerd test. Zie §7. |

**Zero-knowledge-effect van de sync:** alle samenvoegingen gebeuren in de client, na
ontsleuteling. De server ziet alleen een nieuwe ciphertext en een nieuwe klok, net als
nu.

---

## 6. Migratie van bestaande labels (en andere typen)

**Huidige aanpak (labels):** lazy. `NotesLabels.migrate` (`labels.js:124`) leest een
legacy-label als `name = title`. Het wordt pas naar de nieuwe vorm geschreven bij
bewerken (hernoemen, verplaatsen, kleur, kind toevoegen). Dat is veilig: geen
bulk-schrijfactie bij unlock, geen synchronisatiestorm.

**Probleem:** `migrateLabels` (`store.js:5238-5242`) en `repairLabels`
(`store.js:5245-5248`) worden door de UI **niet aangeroepen**. Ze bestaan, maar
draaien nooit. Dat is geen dataverlies, maar de reparatie van cykli en wees-labels
gebeurt dan alleen in het beeld, niet op de schijf.

**Voorstel:**

1. Labels: houd lazy als standaard. Voeg een expliciete actie "Organiseer labels"
   toe voor legacy-labels die `/` of `>` in de naam hebben. Die toont eerst een
   voorbeeld en telt het aantal, en past dan alles in één stap toe. Die actie
   wordt door de gebruiker gestart, niet bij unlock.
2. Reparatie: roep `repairLabels` aan na het ontsleutelen en na elke sync-pull,
   alleen als er iets te repareren is. Schrijf de reparatie één keer weg.
3. Mappen: geen migratie nodig. Een map zonder `parent_id` is root; een map zonder
   `order` is alfabetisch tot de gebruiker handmatig sorteert
   (`NOTES_ORGANIZATION_SPEC.md` §8, eerste vraag).
4. Sjablonen: `is_template: true`-notities worden bij M3 omgezet naar `type:
   'template'`. Per notitie, idempotent, zonder de tekst te wijzigen. Oude clients
   zien de notitie dan als gewone notitie. Dat is acceptabel, want ze kunnen niets
   aanmaken dat de nieuwe client niet kan lezen.
5. Oude clients die labels of mappen lezen: zie §7.

**Terugdraaien:** elke stap schrijft alleen velden toe; geen velden worden
verwijderd. Een terugdraai is dus het negeren van de nieuwe velden.

---

## 7. Risico's

| Risico | Waarschijnlijkheid | Impact | Maatregel |
| --- | --- | --- | --- |
| **AAD ontbreekt bij item-versleuteling.** `encryptObject` (`crypto.js:114-119`) bindt geen item-uuid of type aan de ciphertext. Een server (of een aanvaller met toegang tot de opslag) zou de ciphertext van item A onder uuid B kunnen zetten. | Laag, maar niet nagegaan | Hoog: een map of label kan een andere inhoud krijgen. | **Controleren** voordat M1 start. Bij bevestiging: AAD met uuid en type (de variant op `crypto.js:145-146` bestaat al). |
| Ciphertext-grootte en aantal items verraden structuur | Zeker | Laag-middel | Bekend en beschreven (`NOTES_ORGANIZATION_SPEC.md` §5.2). Geen padding. |
| Teruglinks-index te groot voor het geheugen | Middel bij grote kluizen | Middel | Limiet per notitie (1 MB, 2000 links) en meting (`NOTES_ORGANIZATION_SPEC.md` §4.5). |
| Deelfunctie (Secure Send, deelbare notitie) lekt `dg-note:`-uuids naar ontvangers van notities die niet gedeeld zijn | Middel | Middel | De spec eist dat zulke links als tekst worden getoond. **Niet gecontroleerd** in deze sessie. Eerst nagaan. |
| XSS via titel of linktekst | Laag | Hoog | Titels gaan via `escapeHtml` (`notelinks.js:15`); link-uuid's moeten het strikte patroon volgen (`notelinks.js:21`, `isValidId`). Dit moet zo blijven, met tests. |
| Oude client maakt een nieuwe map van een verplaatste map plat | Zeker | Laag | Oude clients tonen alleen de bladnaam; geen gegevensverlies. Duplicaten van bladnamen zijn mogelijk en zichtbaar. |
| Oude client verwijdert een ouder-map met kinderen | Middel | Middel | Kinderen worden wees-mappen; de nieuwe client repareert ze bij het lezen (§5-D). |
| Markdown-export verliest labels, map en links | Zeker | Middel | Eerlijk benoemen in de UI, of de export uitbreiden (§9-4). |
| Grote veranderingen in één keer (map met veel notities verwijderen) geven een burst van schrijfacties | Middel | Laag | Batch van schrijfacties; het aantal is zichtbaar voor de server, niet wat ze betekenen. |
| Er is geen browsercontrole gedaan (§1.1) | Zeker, in deze sessie | Middel | Voor M1 eerst de vijf stappen uit §1.1 uitvoeren. |
| Nesting in de UI is onbruikbaar met toetsenbord of op telefoonbreedte | Middel | Hoog voor de doelgroep | ARIA-boom (`labeltree.js`) en toetsenbordtests zijn er al voor labels. Dezelfde eisen voor mappen. |

---

## 8. Mijlpalen

Elke mijlpaal is een eigen PR met tests. Er is één bouwtaak per mijlpaal;
bouwtaken hangen af van dit document ("after"). De eerste stap (AAD, §7) staat
vóór M1.

### M1: mappen en geneste labels

**Wat er al is:** geneste labels in data-laag en UI (§1.2). Mappen zijn plat (§1.3).

**Wat nog moet:**

1. Mappen krijgen `parent_id` en `order` (§3.1). Geen wijziging in `note.folder_id`.
2. Mapboom in de zijbalk, met dezelfde ARIA-boom als labels (`labeltree.js`).
3. `repairLabels` en de reparatie van mappen worden aangeroepen bij unlock en pull (§6-2).
4. `createFolder` controleert dubbele namen onder dezelfde ouder (§5-F).
5. Optionele actie "Organiseer labels" voor legacy-labels met `/` (§6-1).
6. Verwijderen van een map met submappen: dialoog zoals bij labels (§9-3).

**Tests:** node-tests die de boom bouwen zonder DOM, zoals `test_nested_labels.js`.
Dekking: cykel en wees-map deterministisch over twee gesimuleerde apparaten; twee
apparaten die een map verplaatsen; dubbele naam onder dezelfde ouder geweigerd, in
andere takken toegestaan; een lege map; een map met honderden notities.
Browsertest met de stappen uit §1.1 met de echte app.

**Klaar als:** alle stappen uit §1.1 werken in de draaiende app, op telefoon- en
desktopbreedte, in licht en donker, en met toetsenbord.

### M2: notitielinks en teruglinks

**Wat er al is:** links, picker, dode links en teruglinks-paneel (§1.4, §1.5).

**Wat nog moet:**

1. Controle dat deelfuncties `dg-note:`-links naar niet-gedeelde notities als tekst tonen (§7).
2. Markdown-export die links omzet naar titels, zodat de export leesbaar blijft (§9-4).
3. Prestatiemeting van de index op een grote kluis, zoals `NOTES_ORGANIZATION_SPEC.md` §4.5.
4. Dode links: tekst en toetsenbord controleren.

**Tests:** renderer accepteert alleen het strikte patroon (andere schema's en
ongeldige uuid's worden geweigerd); hernoemen van de doelnotitie houdt de link
werkend; dood als verwijderd, in de prullenbak of onbekend; links in code worden
genegeerd; de index is gelijk aan een opbouw vanaf nul na willekeurige
bewerkingen; vergrendelen wist de index.

**Klaar als:** deelfuncties bevestigd, en de meting staat in de PR.

### M3: sjablonen als eigen type

**Wat er al is:** sjablonen als `is_template`-vlag (§1.6).

**Wat nog moet:**

1. Eigen type `template` (§3.5). Oude vlag wordt omgezet (§6-4).
2. Uitsluiten uit lijsten, zoeken, aantallen en teruglinks op één plek.
3. Variabelen controleren: datums in lokale tijd, zomertijd, escape, onbekende
   variabelen blijven staan zoals getypt.

**Tests:** variabelen vervangen (`test_templates.js` bestaat al); nieuwe notitie
wist de sjabloon-markering en neemt de labels over; sjablonen komen niet in
lijsten of teruglinks; oude client behoudt het sjabloon bij synchronisatie.

**Klaar als:** sjablonen werken in de app, bestaande sjablonen zijn omgezet,
en de tests slagen.

---

## 9. Keuzes voor de eigenaar

1. **Maximale nestingdiepte van mappen.** De labels gebruiken 8 (`labels.js:7`).
   `NESTED_FOLDERS_SPEC.md` §3.1 kiest 5. **Aanbeveling: 8**, zodat mappen en
   labels dezelfde regel volgen en er maar één limiet te onthouden is.

2. **Sjablonen: eigen type of de bestaande vlag.** De opdracht vraagt een eigen
   type, en dat is het voorstel (§3.5). Het kost een migratie van bestaande
   sjablonen. **Aanbeveling: eigen type `template`**, omdat de vlag nu op acht
   plekken gecontroleerd wordt.

3. **Map verwijderen met submappen en notities.** Nu: notities gaan naar root,
   submappen moeten nog gekozen worden. **Aanbeveling: submappen gaan naar de
   bovenliggende map** (zoals labels met "sub-labels omhoog"), en de dialoog toont
   het aantal notities dat verplaatst wordt. Notities worden nooit verwijderd.

4. **Samenvoegen bij gelijktijdige metadata-wijzigingen.** Nu: een verplaatsing op
   het ene apparaat en een tekstwijziging op het andere geeft een conflictkopie
   (§5-B). **Aanbeveling: ja, samenvoegen zonder conflictkopie wanneer het enige
   verschil in map, labels of volgorde zit.** Bij een echte tekstwijziging blijft
   de huidige regel. Dit is een productkeuze: de gebruiker ziet dan geen
   "(conflict copy)" meer voor een verplaatsing.

5. **Legacy-labels: lazy of een expliciete actie.** Nu: alleen bij bewerken, en
   `migrateLabels` wordt niet aangeroepen (§6). **Aanbeveling: lazy als standaard,
   plus een expliciete actie "Organiseer labels" voor labels met `/` of `>`, met
   voorbeeld en teller.** Zo wordt er niets zonder de gebruiker geschreven, en de
   bestaande labels blijven bruikbaar.

---

*Dit document wijzigt geen code. De bestaande specs
(`docs/NESTED_FOLDERS_SPEC.md`, `docs/NOTES_ORGANIZATION_SPEC.md`) zijn niet
aangepast; hun verouderde zinnen (bijvoorbeeld "No UI yet") worden door dit document
gecorrigeerd en kunnen later worden bijgewerkt.*
