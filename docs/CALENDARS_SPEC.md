# Meerdere benoemde, gekleurde agenda's met zichtbaarheid — ontwerpspec

Status: alleen ontwerp/documentatie, geen codewijzigingen. Idee #81 (agenda's met
eigen naam en kleur, en een aan/uit-schakelaar in de agenda-instellingen).

**Belangrijk bij het lezen:** de inventaris (§1) laat zien dat een groot deel hiervan al
in de app zit (`docs/design/calendar-multi.md`, mijlpalen M1 en M2). Deze spec legt het
model vast zoals het nu is, benoemt de regels die taken 2 t/m 4 moeten bewaken, en
noemt de gaten (§8). Wie bouwt, controleert eerst de regelnummers; die kunnen
verschuiven.

**Zero-knowledge-regel (geldt voor alles hieronder):** de **naam, kleur en
zichtbaarheid** van een agenda, en de **`calendarId`** van een afspraak, worden
**alleen versleuteld opgeslagen**, binnen de AES-GCM-payload van het
`agenda_pack`-item. De server krijgt er geen leesbare kolom, veld, label of
logregel voor en kan ze niet afleiden.

## 1. Inventaris: wat bestaat er nu?

Alle bestanden staan onder `app/static/js/` tenzij anders vermeld.

**Opslag en sync, `store.js`**
- `AGENDA_PACK_UUID` (`a6da67da-67da-4000-8000-000000000001`): één versleuteld
  item `agenda_pack` met `events`, `deleted_events`, `subscriptions`,
  `deleted_subscriptions`, `calendars`, `deleted_calendars`.
- `defaultAgendaPack()`, `agendaPackRecord()`, `ensureAgendaPack()`.
- Afspraken: `listAgendaEvents()`, `upsertAgendaEvent()`, `removeAgendaEvent()`.
  `upsertAgendaEvent` schrijft `{...content, type, updated_at}`, dus een
  `calendarId` in `content` blijft behouden.
- Agenda's: `DEFAULT_CALENDAR_ID` (`a6da67da-67da-4000-8000-0000000000ca`),
  `defaultAgendaCalendar()`, `agendaPackCalendars()`, `listAgendaCalendars()`
  (alleen lezen; toont de standaardagenda in het geheugen als het pack die nog
  niet heeft), `ensureDefaultCalendar()`, `agendaEventCalendarId()`,
  `upsertAgendaCalendar()`, `removeAgendaCalendar()`.
- Sync-samenvoeging: `mergeAgendaPacks()` roept `mergeAgendaSubscriptions()` en
  `mergeAgendaCalendars()` aan; `AGENDA_TOMBSTONE_TTL_MS` ruimt tombstones op.

**Instellingen-UI, `agenda-calendars.js`** (`window.NotesAgendaCalendars`)
- `PALETTE` (9 vaste kleursleutels met tekstkleur), `paletteEntry()`, `NAME_MAX`
  (60), `cleanName()`.
- Lezen/weergave: `listCalendars()`, `calendarMap()`, `calendarForEvent()`,
  `isEventVisible()`, `labelHtml()`, `eventCounts()`.
- Acties: `createCalendar()`, `updateCalendar()`, `renameCalendar()`,
  `setCalendarColor()`, `setCalendarVisible()`, `deleteCalendar()`.
- Rendering: `renderHtml()`, `renderList()`, `colorPickerHtml()`, `editFormHtml()`,
  `deleteFormHtml()`, `rowHtml()`, `wire()`.

**Agendaweergave, `agenda.js`**
- `visibleAgendaEvents()` filtert verborgen agenda's uit `buildOccurrences()`.
- `eventAccentColor()`, `calendarLabelHtml()`, `calendarNameForEvent()`.
- Editor: `calendarDefaultReminders()`, de agendakeuze (`readCalendarSelect()`,
  een `<select>` met de naam als optietekst) en `calendarId` in het
  opgeslagen event.

**Herinneringen/export:** `agenda-reminders.js` en `agenda-local-reminders.js`
lezen `listAgendaEvents()` rechtstreeks (geen zichtbaarheidsfilter); de
ICS-export bevat ook verborgen agenda's.

**Server:** `app/app.py`, `app/db.py` en `app/agenda_reminder_cron.py` hebben
**geen** agenda-, kleur- of zichtbaarheidskolom. De server bewaart alleen het
versleutelde pack.

**Bestaande tests:** `tests/test_agenda_calendars.js` (model, migratie, merge,
verwijderen), `tests/test_agenda_calendars_ui.js` (UI, contrast, toetsenbord),
`tests/test_agenda_calendar_default_reminders.js`, `tests/test_sync_agenda_merge.js`,
`tests/test_sync_agenda_two_devices.js`, `tests/agenda_contrast_utils.js`
(`parseCssColor`, `contrastRatio`).

## 2. Datamodel

Agenda-object, opgeslagen in `pack.content.calendars[id]`:

```
{ type: 'agenda_calendar', version: 1,
  name, color, visible, is_default, order, default_reminders, updated_at }
```

Dit komt overeen met de gevraagde `{id, naam, kleur, zichtbaar, isStandaard}`:
`id` is de sleutel in de map (de lijstfuncties voegen hem toe), `name` = naam,
`color` = paletsleutel (geen vrije hex), `visible` = zichtbaar (`false` is
verborgen, alles anders is zichtbaar), `is_default` = isStandaard. De velden
`order`, `default_reminders` en `version` zijn extra en blijven. Veldnamen zijn
snake_case, zoals elders in de pack.

Afspraak: `calendarId` staat **in** het versleutelde event binnen `pack.content.events[id]`.
Ontbreekt het, of wijst het naar een onbekende of verwijderde agenda, dan hoort
de afspraak bij de standaardagenda (`agendaEventCalendarId()`,
`calendarForEvent()`).

**Waarom geen leesbare serverkolom:** een kolom `calendar_id`, `color` of
`calendar_name` zou de server (en een databaselek, back-up of logbestand) laten
zien hoeveel agenda's iemand heeft, hoe ze heten ("Werk", "Therapie") en welke
afspraak waar bij hoort. Dat breekt de zero-knowledge-belofte van de rest van de
agenda (titel, tijd en locatie zijn ook alleen versleuteld). De server heeft het
ook niet nodig: filteren, kleuren en verbergen gebeuren op de client na het
ontsleutelen. Zoeken op de server naar agenda is dus bewust niet mogelijk.
Regels voor taken 2 t/m 4: geen nieuwe kolom in `app/db.py`, geen veld in een
API-payload buiten het versleutelde blob, geen naam of kleur in `localStorage`,
console, foutmeldingen of serverlogs.

## 3. Migratie

Doel: bestaande afspraken zonder `agendaId`/`calendarId` horen bij een automatisch
aangemaakte standaardagenda, zonder dat iemand iets hoeft te doen. (De code
noemt het veld `calendarId`; "agendaId" in de opdracht is hetzelfde veld.
Hernoem niet.)

**Bij het ontgrendelen.** `migrateAgendaCalendars()` draait in de
unlock-onderhoudsstap (`runUnlockMaintenance()`), na `ensureAgendaPack()`. Heeft
het pack afspraken of agenda's, dan (1) maakt hij de standaardagenda aan als
`DEFAULT_CALENDAR_ID` ontbreekt (naam 'Agenda', kleur `blue`), (2) geeft hij elke
afspraak zonder `calendarId`, of met een onbekende of verwijderde agenda, de
`calendarId` van de standaardagenda, en (3) voegt hij dubbele standaardagenda's
samen (zie hieronder). Er verdwijnt geen afspraak; alleen `calendarId` verandert.
De `updated_at` van een afspraak blijft gelijk (boekhouding, zoals bij
herinnering-ids), zodat de migratie nooit een echte wijziging van een ander
apparaat overschrijft bij het samenvoegen. Een leeg pack wordt niet herschreven;
`listAgendaCalendars()` toont de standaardagenda dan alleen in het geheugen.
Het resultaat gaat versleuteld mee in `agenda_pack`, net als afspraken.

**Idempotent.** De logica zit in de pure functie `normalizeAgendaCalendars()`,
die `null` teruggeeft als er niets verandert; dan wordt er niets geschreven.
Een tweede run (ook na een onderbroken run) verandert dus niets.
`ensureDefaultCalendar()` schrijft de standaardagenda alleen als de sleutel
ontbreekt (`upsertAgendaCalendar()` roept hem aan).

**Oudere clients behouden het onbekende veld.** Een oude client leest het pack
als JSON-object en schrijft `{...pack.content, events, ...}` terug
(zie `upsertAgendaEvent()`). `calendars`, `deleted_calendars` en `calendarId`
op events blijven daardoor staan. `mergeAgendaPacks()` spreidt `...remote,
...local` eerst, dus ook een oude client zonder `mergeAgendaCalendars` verliest
de map niet door een merge. Eigen velden die een nieuwere app aan een
agenda toevoegt blijven bewaard doordat `upsertAgendaCalendar()` met
`{...prev, ...content}` samenvoegt. Een onbekende kleursleutel valt in de UI
terug op de eerste tint, maar de opgeslagen sleutel blijft ongewijzigd
(`paletteEntry()`). Beperking: wat een oude client aan een event wijzigt, kan
`calendarId` niet kwijtraken, tenzij die client het event zelf opnieuw opbouwt
zonder spread; neem dat op in de regressietest (§7).

**Dubbele standaardagenda's na gelijktijdige sync.** Gekozen: een
**deterministisch id**. De standaardagenda heeft het vaste id
`DEFAULT_CALENDAR_ID`. Twee apparaten die offline allebei de standaardagenda
aanmaken, schrijven dezelfde sleutel. `mergeAgendaCalendars()` voegt per id
samen op `updated_at` (het nieuwste wint; gelijke stempel wint lokaal) en
de standaardagenda wordt nooit door een tombstone weggehaald
(`id !== DEFAULT_CALENDAR_ID`-controle). Daardoor ontstaat er nooit een tweede
standaardagenda en is er geen aparte samenvoegregel op naam nodig.

Rest-risico: een oudere of afwijkende client die de standaardagenda met een
**ander** id aanmaakt (bijvoorbeeld een toekomstige build zonder de vaste
constante) zou een duplicaat opleveren. Voor dat geval geldt als vangnet de
samenvoegregel: bij het samenvoegen, voor elke agenda met `is_default === true`
en een id ongelijk aan `DEFAULT_CALENDAR_ID`: (1) zet de afspraken met dat
`calendarId` om naar `DEFAULT_CALENDAR_ID` met een nieuwe `updated_at`;
(2) neem naam en kleur over van de agenda met het nieuwste
`updated_at` naar `DEFAULT_CALENDAR_ID`; (3) zet een tombstone voor het
overbodige id. Het resultaat is voor alle apparaten gelijk, ongeacht
de volgorde. Gebouwd: `mergeAgendaPacks()` past deze regel na elke merge toe
(`normalizeAgendaCalendars(..., { assignEvents: false })`) en de
unlock-migratie ook. Afwijking: de `updated_at` van verplaatste afspraken blijft
gelijk; omdat de regel na elke merge opnieuw draait, komen apparaten toch op
hetzelfde uit. Test: `tests/test_agenda_calendar_migration.js`.

Een gewone (niet-standaard) agenda die op twee apparaten met hetzelfde id
bestaat, wordt per entry op `updated_at` samengevoegd; de nieuwste volledige
entry wint (naam, kleur en zichtbaarheid wisselen dus samen).

## 4. Zichtbaarheid

- `visible` staat in het versleutelde agenda-object, dus het gaat mee met de
  sync en geldt op elk apparaat. Het is niet apparaat-lokaal en staat niet in
  `localStorage`.
- Verbergen is alleen een weergavefilter: `visibleAgendaEvents()` in
  `agenda.js` laat afspraken van verborgen agenda's niet tekenen.
- Verbergen verandert **geen data** (afspraken blijven staan, ook in de ICS-export)
  en **geen herinneringen**: `agenda-reminders.js` en
  `agenda-local-reminders.js` lezen `listAgendaEvents()` zonder filter, dus een
  verborgen agenda blijft herinneren. Dat is bewust, zodat verbergen geen
  gemiste afspraak veroorzaakt. Taken 2 t/m 4 mogen dit niet veranderen.
  De UI-tekst bij de schakelaar moet dit zeggen.
- De zoekfunctie (`filterEvents` op `visibleAgendaEvents()`) toont ook geen
  verborgen afspraken; zo blijft het gedrag voorspelbaar.
- De standaardagenda mag verborgen worden. Een afspraak aanmaken in een
  verborgen agenda moet de gebruiker zien: de agendakeuze in de editor toont
  een "verborgen"-markering.

## 5. Verwijderen

- Alleen na bevestiging: de knop "Delete" opent een inline formulier
  (`deleteFormHtml()`); pas "Delete calendar" voert uit (`deleteCalendar()` →
  `removeAgendaCalendar()`). Escape of "Cancel" sluit zonder wijziging.
  `removeAgendaCalendar()` weigert zonder expliciete `mode`.
- De afspraken gaan standaard naar de standaardagenda (`mode: 'move'`, het
  doel staat vooraf op `DEFAULT_CALENDAR_ID`; een ander doel is te kiezen). Een
  tweede, uitdrukkelijke keuze `mode: 'delete'` verwijdert de afspraken mee
  (met tombstones en `cancelEventReminders`). Het formulier toont het aantal
  afspraken.
- De standaardagenda is niet te verwijderen: de UI toont geen knop en
  `removeAgendaCalendar()` geeft `{ ok: false }` voor `DEFAULT_CALENDAR_ID`.
  Daardoor bestaat er altijd minstens één agenda.
- De verwijdering zet een tombstone in `deleted_calendars`; een afspraak die
  toch nog naar de verdwenen agenda wijst (bijvoorbeeld door een gelijktijdige
  bewerking op een ander apparaat) valt terug op de standaardagenda.
- Voorstel voor de open vraag: een Undo-melding (zoals `test_agenda_undo_delete.js`
  voor afspraken) is nuttig, maar valt buiten deze taak.

## 6. Toegankelijkheid

- Kleur is nooit het enige signaal: `labelHtml()` toont de agendanaam als tekst
  naast de kleur; de lijst toont naam + kleurnaam voor schermlezers
  (`sr-only`: "Blue, hidden"); de editorkeuze gebruikt de naam als optietekst.
- Vaste kleurenset: `PALETTE` met 9 sleutels (`blue`, `teal`, `green`,
  `amber`, `orange`, `red`, `pink`, `purple`, `slate`), allemaal wit op de
  achtergrondkleur met contrast ≥ 4,5:1 (WCAG AA voor normale tekst), gecontroleerd in
  `tests/test_agenda_calendars_ui.js` met `tests/agenda_contrast_utils.js`.
  Geen vrije hex: nieuwe tinten moeten dezelfde test halen.
- Alle bediening is native (`button`, `input`, `radio`, `select`), dus
  toetsenbord en schermlezer werken zonder eigen toetsenlogica; Escape sluit
  een open inline formulier eerst; `announce()` meldt acties via een
  live-region ("Calendar X hidden").
- De kleurenkiezer is een `fieldset` met `legend` en radio's; de focus wordt
  na elke actie op een zinnig element teruggezet.
- Verborgen status mag niet alleen uit doorhalen/dimmen blijken: het selectievakje
  heeft een label ("Show X").

## 7. Testplan voor taken 2 t/m 4

Alle tests zijn Node-scripts zonder netwerk, in de stijl van de bestaande
`tests/test_agenda_*.js`.

**Taak 2 — datamodel en migratie** (`tests/test_agenda_calendars.js`)
1. Pack zonder `calendars`: `listAgendaCalendars()` geeft precies de
   standaardagenda en schrijft niets (pack ongewijzigd).
2. `ensureDefaultCalendar()` twee keer: eerste `true`, tweede `false`, één sleutel.
3. Afspraak zonder `calendarId`, met onbekend id en met verwijderd id → standaardagenda.
4. Een nieuwe afspraak slaat `calendarId` op; roundtrip via `upsertAgendaEvent`.
5. Een pack met onbekende velden op agenda en event overleeft `upsertAgendaCalendar`,
   `upsertAgendaEvent` en `mergeAgendaPacks` (veld blijft staan).
6. Een "oude client"-simulatie: zet een pack zonder `calendars` terug door
   `mergeAgendaPacks` en controleer dat `calendars` van de andere kant blijft.
7. Privacy: serialiseer het opgeslagen item (zoals de server het ziet) en
   controleer dat agendanaam, kleur en `calendarId` niet in leesbare velden staan;
   `grep` op `app/db.py` en `app/app.py` toont geen agenda-kolom.

**Taak 3 — sync en samenvoegen** (`tests/test_sync_agenda_merge.js`,
`tests/test_sync_agenda_two_devices.js`)
1. Twee apparaten maken offline allebei de standaardagenda; na sync in beide
   volgordes precies één, met hetzelfde resultaat.
2. De tombstone van de standaardagenda wordt genegeerd.
3. Rename op A, kleur op B, zelfde agenda: de nieuwste entry wint volledig;
   documenteer dit in de test (zie §8).
4. Verwijderen op A, bewerking op B: de nieuwste stempel wint; afspraken met
   een verdwenen agenda vallen terug op de standaardagenda.
5. Als het vangnet uit §3 is gebouwd: een afwijkend standaard-id wordt
   samengevoegd, afspraken verhuizen, de uitkomst is volgordeonafhankelijk.
6. Tombstones ouder dan `AGENDA_TOMBSTONE_TTL_MS` worden opgeruimd.

**Taak 4 — UI: zichtbaarheid, verwijderen, toegankelijkheid**
(`tests/test_agenda_calendars_ui.js`)
1. Een verborgen agenda: `buildOccurrences()` bevat zijn afspraken niet, de
   afspraken staan nog in `listAgendaEvents()` en in de ICS-export, en de
   herinneringen (`agenda-reminders.js`) blijven gepland.
2. `visible` gaat mee via een tweede client (pack-roundtrip met merge).
3. Verwijderen: zonder bevestiging gebeurt niets; `move` zet `calendarId` op de
   standaardagenda; `delete` zet tombstones en annuleert herinneringen; de
   standaardagenda heeft geen knop en `removeAgendaCalendar()` geeft `ok: false`.
4. Contrast: elke `PALETTE`-kleur ≥ 4,5:1 met zijn tekstkleur.
5. Toegankelijkheid: elke weergave van een afspraak bevat de agendanaam als
   tekst; de lijstrij bevat naam en `sr-only` kleurnaam; alle bedieningen zijn
   `button`/`input`/`select`; Escape sluit het inline formulier.
6. Geen lekken: naam en kleur komen niet in `localStorage` of `console` terecht.

Handmatig (één keer per release): met schermlezer en alleen toetsenbord een agenda
aanmaken, verbergen, hernoemen en verwijderen; controleren op een telefoonscherm
(zie `docs/AGENDA_PWA_VISUAL_AUDIT.md`).

## 8. Gaten en open punten

1. De vangnetregel voor een duplicaat-standaardagenda met afwijkend id (§3) is
   gebouwd (`normalizeAgendaCalendars()`), maar laat de `updated_at` van
   verplaatste afspraken staan; zie §3.
2. `mergeAgendaCalendars()` voegt per hele entry samen: gelijktijdig hernoemen
   op het ene en omkleuren of verbergen op het andere apparaat verliest een van de
   twee. Per-veld-samenvoegen (met een `updated_at` per veld) is mogelijk, maar
   bewust uitgesteld.
3. De zichtbaarheid van de standaardagenda, een Undo bij verwijderen en een
   markering "verborgen" bij een nieuwe afspraak in een verborgen agenda zijn
   niet door tests afgedekt.
4. `docs/design/calendar-multi.md` is het oorspronkelijke ontwerp (met tijdzone en
   herinneringen); dit document is de bindende samenvatting voor agenda's,
   kleur en zichtbaarheid.
