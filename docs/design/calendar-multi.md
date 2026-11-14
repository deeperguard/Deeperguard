# Ontwerp: meerdere agenda's, tijdzone per afspraak en herinneringen

Status: voorstel, nog niet gebouwd. Er is geen code gewijzigd. Dit document hoort bij idee #51 en is de
eerste taak; de bouwtaken (zie "Mijlpalen") volgen pas na de keuzes van de eigenaar (sectie 8).

Gelezen code (paden onder `app/`): `static/js/store.js` (agenda-pack, samenvoegen, abonnementen),
`static/js/agenda.js` (UI, editor, kleuren), `agenda-recurrence.js`, `agenda-occurrence.js`,
`agenda-ics.js`, `agenda-reminders.js`, `crypto.js`, `agenda_reminder_cron.py`, `app.py`
(`/api/agenda-reminders/*`) en `db.py` (`items`, `agenda_scheduled_reminders`). Ook gelezen:
`docs/PRIVACY.md`, `docs/ICS_SUBSCRIBE_SPEC.md`, `docs/CALENDAR_SHARING_DESIGN.md`.

## 0. Uitgangspunt: wat er nu al is (en wat dit document corrigeert)

Drie dingen wijken af van wat de taakomschrijving veronderstelde:

1. **Afspraken zijn geen aparte items.** Alle afspraken zitten in één versleuteld kluisitem, `agenda_pack`
   met vaste uuid `AGENDA_PACK_UUID` (`store.js:1773`). Daarin staan `events` (id → `agenda_event`),
   `deleted_events` (tombstones, 60 dagen, `AGENDA_TOMBSTONE_TTL_MS`) en `subscriptions` (zie
   `ICS_SUBSCRIBE_SPEC.md`). Conflicten tussen twee apparaten worden per afspraak samengevoegd door
   `mergeAgendaPacks` (aangeroepen op `store.js:3324`): de nieuwste `updated_at` per afspraak wint, een
   verwijdering wint van een oudere bewerking.
2. **Herinneringen bestaan al**, inclusief e-mail en push via de server, alleen voor Pro
   (`agenda-reminders.js`, `agenda_reminder_cron.py`, `plans.py`). Het veld `reminders` is nu een lijst met
   preset-sleutels (`at_start`, `m5`, `m10`, `m15`, `m30`, `h1`, `d1`), geen minuten. De server krijgt per
   herinnering alleen `{id, fire_at, channel, local_time_label}` (`AGENDA_REMINDER_ALLOWED_KEYS`,
   `app.py:2588`; tabel `agenda_scheduled_reminders`, `db.py:337`). Sectie 5 beschrijft daarom niet
   "e-mail en push bouwen" maar "wat de bestaande route lekt en wat de eigenaar daarvan wil houden".
3. **Tijden zijn UTC-instants (ISO-string) zonder tijdzone.** Een afspraak over de hele dag is nu `start` =
   lokale middernacht van het apparaat als instant en `end` = middernacht van de dag erna
   (`agenda.js:2318-2340`). Dat schuift een dag als het apparaat van tijdzone wisselt (risico R4). Alleen
   geïmporteerde afspraken hebben `source_tz` (`agenda-ics.js:659`, `store.js:1980`).

Een afspraak heeft nu: `type`, `version`, `title`, `location`, `notes`, `webcall_url`, `attendees`, `color`,
`start`, `end`, `all_day`, `rrule`, `ical_uid`, `ics_exdates`, `ics_occurrence_overrides`, `reminders`,
`scheduled_reminder_ids`, `updated_at` (bij import ook `imported_at`, `source`, `source_tz`). Kleur is nu
per afspraak, uit acht vaste tinten (`EVENT_COLORS`, `agenda.js:6`).

## 1. Wat de gebruiker krijgt

- **Meerdere agenda's** (bijv. Privé, Werk, Familie), elk met naam en kleur uit een vast palet met
  gecontroleerd contrast (de bestaande hulp `tests/agenda_contrast_utils.js` hergebruiken). Per agenda
  aan/uit (zichtbaarheid) en volgorde aanpasbaar (slepen én knoppen). Een nieuwe afspraak kiest de agenda in
  de editor. De standaardagenda heet "Agenda"; ze kan hernoemd worden en de laatste agenda kan niet
  verwijderd worden.
- **Tijdzone per afspraak**: standaard die van het apparaat, in de editor als compacte regel
  ("Europe/Amsterdam") die opent naar een zoekbare lijst. Bij een afwijkende zone toont de detailweergave
  beide tijden ("09:00 Amsterdam · 03:00 jouw tijd"). Afspraken over de hele dag hebben geen zone.
- **Herinneringen met duidelijke instellingen**: meerdere per afspraak, in minuten (presets plus eigen
  waarde), een standaard per agenda, en per kanaal een heldere uitleg wie wat te zien krijgt (sectie 5).
  Kanalen staan standaard uit.

### Vergelijking

Bronnen staan alleen hier in de tekst; er gaan geen claims naar buiten. De tabel komt uit eigen kennis van
de publieke documentatie van de aanbieders en is tijdens het schrijven niet opnieuw nagelopen: vóór gebruik
in marketing of op de site eerst controleren.

| | Proton Calendar | Notesnook | Standard Notes | Deeperguard nu | Dit ontwerp |
|---|---|---|---|---|---|
| Agenda in de app | ja, E2EE | nee (herinneringen aan notities) | nee | ja, E2EE | ja |
| Meerdere agenda's met kleur | ja | n.v.t. | n.v.t. | nee (kleur per afspraak) | ja |
| Tijdzone per afspraak | ja (ook aparte eindzone) | n.v.t. | n.v.t. | nee | ja, één zone per afspraak; aparte eindzone niet in v1 |
| Herinneringen | meldingen, e-mail en push | lokale meldingen bij notities | geen agenda | e-mail/push via server (Pro), alleen id + tijd | lokaal eerst; server-kanalen opt-in met uitleg |

Notesnook en Standard Notes hebben geen agenda; daar valt dus niets te evenaren en ze zijn vooral het
referentiepunt voor "herinneringen zonder dat de server inhoud ziet". Proton is de maatstaf voor functies.
Waar dit ontwerp beter wil zijn is eerlijkheid en gevoel: de app zegt per kanaal in gewone taal wat de
server en derden zien, op de plek waar je het kanaal aanzet.

## 2. Datamodel

Alle nieuwe gegevens leven binnen de bestaande versleutelde envelop (sectie 4). Er verandert niets aan
`items`, `ciphertext` of de sync-API.

### 2.1 Agenda (nieuw type `agenda_calendar`)

Keuze K1 voor de eigenaar: waar woont een agenda?

- **Optie A (aanbevolen): als map `calendars` binnen `agenda_pack`**, naast `events` en `subscriptions`.
  Zelfde patroon als abonnementen (`mergeAgendaSubscriptions`, `deleted_subscriptions`): per entry
  samenvoegen op `updated_at`, tombstones in `deleted_calendars`. Voordeel: één sync-eenheid, de bestaande
  conflictlogica en tests worden uitgebreid, geen migratie. Nadeel: de pack groeit.
- **Optie B: elke agenda en elke afspraak een eigen kluisitem** (wat de taakomschrijving veronderstelde).
  Voordelen: kleinere uploads, conflicten per afspraak via de server-`rev`. Nadelen: grote migratie van
  bestaande packs, en het aantal afspraken wordt direct afleesbaar als aantal items (sectie 4). Alleen
  kiezen als de packgrootte aantoonbaar een probleem wordt (`tests/bench_agenda_scale.js` meet dat al).

Dit document werkt optie A uit.

```
agenda_calendar = {
  type: 'agenda_calendar',
  version: 1,
  name: string (1..60 tekens, alleen tekst),
  color: palet-sleutel ('blue', 'teal', ...),   // sleutel, geen vrije hex
  visible: boolean,
  order: number,                  // fractionele index, zie R3
  default_reminders: [minuten],
  is_default: boolean,            // alleen de lazy aangemaakte standaardagenda
  updated_at: ISO-string
}
```

De kleur is een **sleutel uit een vast palet** van 8-10 tinten met gecontroleerd contrast, geen vrije hex.
De bestaande `EVENT_COLORS` (`agenda.js:6`) wordt het uitgangspunt; een afspraakkleur die er nu al in zit
blijft werken als override. Een onbekende sleutel (nieuwere app) valt terug op de eerste tint en blijft
bewaard.

### 2.2 Afspraak (uitbreiding van `agenda_event`)

| Veld | Type | Betekenis |
|---|---|---|
| `calendarId` | string | id in `calendars`; ontbreekt = standaardagenda |
| `tz` | string | IANA-naam (`Europe/Amsterdam`); ontbreekt = tijdzone van het apparaat; afwezig bij hele dag |
| `reminders` | lijst minuten (int >= 0, uniek, max 8) | vóór de start; vervangt de preset-sleutels |
| `start` / `end` | ISO-UTC instant (`...Z`) | ongewijzigd voor afspraken met tijd |
| `start_date` / `end_date` | `YYYY-MM-DD` | alleen bij `all_day`: lokale datum zonder zone; `end_date` inclusief |

Regels:

- **Tijd = UTC-instant plus `tz`.** De instant sorteert en voedt herinneringen; `tz` bepaalt de weergave en
  hoe een herhaling (`rrule`) over een tijdwissel wordt uitgerekend (wandkloktijd in `tz`, niet vaste 24
  uur; zie R1 en R2).
- **Hele dag = lokale datum zonder zone.** "1 mei" blijft 1 mei op elk apparaat. Een oude afspraak zonder
  `start_date` krijgt de datum bij lezen afgeleid uit `start` in de zone van het apparaat (best effort,
  R4) en legt die vast bij de eerstvolgende bewerking.
- **`reminders`**: preset-sleutels worden bij lezen vertaald (`at_start`=0, `m5`=5, `h1`=60, `d1`=1440, ...)
  en bij opslaan als minuten geschreven. Een oudere app filtert onbekende waarden weg
  (`normalizeOffsets`, `agenda-reminders.js:71`): de herinnering verdwijnt daar stil, de data blijft staan.
- `scheduled_reminder_ids` blijft; de id's blijven afgeleid van (afspraak-id, slot, offset, kanaal), zodat
  twee apparaten nooit dubbele herinneringen maken.

## 3. Achterwaartse compatibiliteit

- **Ontbrekend `calendarId` = standaardagenda.** Elke bestaande afspraak blijft werken zonder migratie van
  de afspraken zelf.
- **Standaardagenda lazy, idempotent, zonder dubbelen bij sync vanaf twee apparaten.** De standaardagenda
  krijgt een **vast, deterministisch id** (een constante `DEFAULT_CALENDAR_ID`, zoals `AGENDA_PACK_UUID`),
  geen willekeurige uuid. Twee apparaten die voor het eerst openen schrijven dus dezelfde sleutel
  `calendars[DEFAULT_CALENDAR_ID]`; de samenvoeging ziet één entry en kiest op `updated_at`. Er kunnen er
  niet twee ontstaan. Schrijven gebeurt alleen als de sleutel ontbreekt (`ensureDefaultCalendar`, naar
  voorbeeld van `ensureAgendaPack`, `store.js:1791`). Een alleen-lezen weergave van een pack zonder
  `calendars` toont dezelfde standaardagenda in het geheugen en uploadt niets. Hernoemen op twee apparaten
  tegelijk volgt de gewone `updated_at`-regel, zonder duplicaat.
- **Ontbrekende `tz` = tijdzone van het apparaat**: het gedrag van nu, dus oude afspraken veranderen nooit
  stilzwijgend van weergave. Een geïmporteerde afspraak met `source_tz` krijgt die waarde als `tz` bij de
  eerste bewerking, niet eerder.
- **Onbekende velden blijven bewaard.** De schrijfpaden doen nu al `{...content, ...}`
  (`upsertAgendaEvent`, `store.js:1812`) en de pack-merge `{...remote, ...local}`. Dit wordt een expliciete
  regel met test, op afspraak, agenda en pack: velden die de app niet kent gaan onveranderd terug naar de
  server. Een oudere app kan zo een afspraak bewerken zonder `calendarId` of `tz` te wissen. `agenda_pack.version`
  blijft 1 tenzij een oude app aantoonbaar schade zou doen (M1).
- **Agenda verwijderen: de gebruiker kiest in een bevestigingsdialoog** (met aantal afspraken):
  1. *Afspraken verplaatsen naar* een andere agenda (standaard: de standaardagenda). Elke afspraak krijgt
     nieuwe `calendarId` en `updated_at`; daarna wordt de agenda getombstoned.
  2. *Afspraken mee verwijderen.* Elke afspraak gaat via `removeAgendaEvent` (tombstone); herinneringen
     worden bij de server verwijderd (bestaande `syncEventReminders`); er is een Undo-toast zoals nu bij een
     afspraak (`agenda.js:~2508`).

  Voorgeselecteerd is *verplaatsen*; *mee verwijderen* vraagt bij meer dan 20 afspraken de agendanaam als
  bevestiging. Abonnement-agenda's volgen `ICS_SUBSCRIBE_SPEC.md` (afspraken van het abonnement gaan mee).
  Race: apparaat B maakt een afspraak in agenda X terwijl A agenda X verwijdert. Na samenvoegen verwijst de
  afspraak naar een agenda met tombstone; de weergave toont hem dan in de standaardagenda (zonder te
  schrijven), zodat er nooit een onzichtbare afspraak is.

## 4. Wat de server wel en niet ziet

Het mechanisme bestaat al: de client versleutelt het hele kluisitem met `NotesCrypto.encryptObject`
(AES-GCM, `crypto.js:114`, aangeroepen vanuit `store.js:1678`) en stuurt alleen `ciphertext` via
`/api/sync/items` (`store.js:3044`); de server bewaart dat in `items.ciphertext` (`db.py:88-93`, upsert rond
`db.py:1738`). Omdat alle onderstaande velden in `agenda_pack.content` zitten, worden ze **alleen
versleuteld opgeslagen** via dat pad. Er komt geen nieuwe tabel, kolom of API.

| Nieuw veld | Waar | Server ziet | Bestaande code die het versleutelt |
|---|---|---|---|
| `calendars` (naam, kleur, volgorde, zichtbaarheid, `default_reminders`, `is_default`) | in `agenda_pack` | alleen ciphertext | `encryptObject` `crypto.js:114`, `store.js:1678`; opslag `db.py:88` |
| `deleted_calendars` | in `agenda_pack` | alleen ciphertext | idem; model: `deleted_subscriptions` `store.js:2149` |
| `calendarId` | in `agenda_event` | alleen ciphertext | idem |
| `tz` | in `agenda_event` | alleen ciphertext | idem |
| `reminders` (minuten) | in `agenda_event` | alleen ciphertext | idem; bestaand veld `reminders` |
| `start_date` / `end_date` | in `agenda_event` | alleen ciphertext | idem |

**Blijft zichtbaar voor de server (ongewijzigd, bewust niet verborgen):** de grootte van het item
(`_item_storage_size`, `db.py:2387`, limiet `SYNC_MAX_ITEM_BYTES`), het aantal items, `rev`, `updated_at` en
het synchronisatiemoment. Omdat alle afspraken in één pack zitten, lekt het aantal afspraken nu niet
direct, maar de packgrootte groeit wel met agenda's en afspraken. Optie B zou het aantal wél afleesbaar
maken: een reden voor optie A. Padding is een aparte keuze (K7).

De herinneringsroute (sectie 5) blijft een **uitzondering** op "alleen ciphertext", zoals ook de
ICS-doorgeefroute (`PRIVACY.md`). Dit ontwerp voegt daar geen metadata aan toe: `tz`, `calendarId`,
agendanaam en kleur worden nooit meegestuurd (de server weigert al onbekende velden,
`_validate_agenda_reminder_payload`, `app.py:2599`).

## 5. Herinneringen

### 5.1 Fase 1: lokaal, zonder server

- **Notification API en een melding in de app.** De client berekent vuurmomenten uit dezelfde uitbreiding
  van afspraken die de agenda tekent (`agenda-reminders.js` doet dat al, zodat een herinnering nooit afgaat
  voor een datum die niet getoond wordt). Eén timer naar de eerstvolgende herinnering. Bij vuren: een
  `Notification` (alleen met toestemming; eerst een eigen uitleg, dan de browservraag) en altijd een banner
  in de app. De titel mag in een lokale melding, want die verlaat het apparaat niet; een instelling "titel
  verbergen in meldingen" houdt het vergrendelscherm schoon ("Afspraak om 09:00").
- **Wat er bij een gesloten tab gebeurt: niets.** Een webpagina kan zonder open tab of actieve proces niet
  op een tijdstip wakker worden; de Notification API plant geen toekomstige meldingen en de
  Notification-Triggers-aanpak is niet breed beschikbaar. Er komt dus alleen een herinnering als de app
  open is (tab of draaiende PWA) én de kluis ontgrendeld is: zonder sleutel kent de client titel en tijd
  niet. Bij het volgende openen toont de app "gemiste herinneringen" (laatste 24 uur) in plaats van ze
  te negeren. Dit staat ook in de instelling zelf, zonder kleine lettertjes.
- Een gebruiker die op herinneringen moet kunnen vertrouwen heeft bij een gesloten tab niets aan fase 1.
  Daarom is 5.2 een keuze voor de eigenaar en geen detail.

### 5.2 Fase 2: e-mail en push via de server (bestaat al; keuze voor de eigenaar)

**Wat de server van Deeperguard bij beide kanalen krijgt en bewaart** (`agenda_scheduled_reminders`):

- `id`: ondoorzichtige afgeleide waarde (van een kluis-id die de server niet kent);
- `fire_at`: **het exacte vuurmoment** (UTC) van elke herinnering;
- `channel` (`email` of `push`);
- `local_time_label`: de lokale tijd van de afspraak ("09:00"), alleen bij afspraken met tijd;
- `created_at`, `updated_at`, `sent_at`.

Dat is meer dan "iets bestaat": uit `fire_at` en het label volgt de **starttijd van de afspraak** (de
offset is een van enkele presets) en bij benadering de tijdzone van de gebruiker. Het aantal rijen toont
hoeveel afspraken en herhalingen herinnerd worden. Niet zichtbaar: titel, locatie, notities, deelnemers,
agenda, kleur, `tz`-naam.

**E-mail** (`send_plain_email`, `agenda_reminder_cron.py`):

- Server ziet: bovenstaande, het **geverifieerde e-mailadres** (staat al bij het account) en het
  verzendmoment.
- Derde partijen: de **uitgaande mailprovider of SMTP-relay** van de operator ziet ontvanger, onderwerp
  ("Deeperguard: upcoming event"), tekst ("You have an event at 09:00") en tijdstip. De **ontvangende
  mailprovider** van de gebruiker (Gmail, Outlook, enz.) leest, indexeert en bewaart de mail. E-mail is
  onderweg niet end-to-end versleuteld. Metadata die zo bij derden komt: dat de gebruiker een
  Deeperguard-account heeft, en dat er op een bepaalde dag een afspraak is op een bepaalde lokale tijd. Geen
  titel. Dat bij een mailprovider is niet terug te draaien en valt buiten ons bereik.

**Push** (Web Push via `pywebpush`, `try_send_push`):

- Server ziet: bovenstaande plus de **push-endpoint-URL** en sleutels van het apparaat
  (`web_push_subscriptions`, `db.py:353`). De endpoint is per browser en apparaat uniek: een stabiele
  apparaat-identiteit.
- Derde partij: de **push-dienst van de browserleverancier** (Google FCM, Mozilla autopush, Apple
  `web.push.apple.com`, Windows WNS; de server post alleen naar die hosts, `push_endpoint_allowed`) ziet
  endpoint, tijdstip, berichtgrootte en het IP van onze server, en kan koppelen welk apparaat wanneer een
  bericht kreeg. De payload is bij Web Push versleuteld naar het apparaat (RFC 8291) en bevat alleen
  generieke tekst ("You have an event at 09:00"). Het lek is dus timing per apparaat.
- Op het apparaat toont de service worker de melding (`sw.js:462`). Dit werkt wel bij een gesloten tab,
  mits de browser of PWA push toestaat.

**Variant "generieke tekst en vaag tijdvenster"** (aanbevolen als de eigenaar server-herinneringen houdt):

> **Stand (2026-11-14), e-mail:** gebouwd. E-mail gebruikt een venster van 15 minuten (naar beneden afgerond, UTC, zonder willekeurige verschuiving: elk apparaat moet hetzelfde venster uploaden voor dezelfde id, anders wordt `sent_at` gereset en kan een mail dubbel gaan), geen `local_time_label`, en de tekst "You have an event coming up soon." De server rondt zelf af en wist het label (oudere apps). Alle offsets blijven bruikbaar; ze komen tot 15 minuten te vroeg. Push via deze tabel is ongewijzigd (push gebruikt de vensterroute uit `docs/PUSH_REMINDERS_DESIGN.md`).

- De client uploadt niet het exacte `fire_at` maar een **venster** (afgerond op het kwartier of uur, met een
  willekeurige verschuiving per herinnering) en laat `local_time_label` weg.
- De melding zegt alleen "Je hebt binnenkort een afspraak. Open Deeperguard." zonder tijd.
- Effect: de server kan de starttijd nog maar tot op het venster schatten; mailprovider en push-dienst zien
  alleen "rond dit uur". Prijs: een herinnering kan tot een venster te vroeg of te laat komen en "5 minuten
  voor" vervalt (alleen 15 min, 1 uur, 1 dag). Dat is een echt functioneel verlies; vandaar keuze K3.
- Patronen (hoe vaak, welke dagen) blijven zichtbaar. Het is dus verkleining van metadata, geen anonimiteit,
  en de UI-tekst moet dat zo zeggen.

**Alternatief zonder server-planning (niet voorgesteld):** de server stuurt op het vuurmoment een lege
wake-up-push en de service worker bouwt de melding uit een lokaal bewaarde afspraak. De push-dienst ziet dan
alleen timing. Dit vereist dat de service worker bij een gesloten app bij de kluissleutel kan, wat het
vergrendelmodel (`docs/LOCK_SPEC.md`) verzwakt.

### 5.3 Keuzes in de UI

Per kanaal een aparte schakelaar, standaard uit, met naast "E-mail" en "Push" een korte zin over wie wat
ziet (de tekst uit 5.2, ingekort). Aanzetten vraagt bevestiging met die lijst. `docs/PRIVACY.md` moet
mee-bijgewerkt worden zodra K3 is beslist.

## 6. Risico's

- **R1 Zomer- en wintertijd.** "09:00 Amsterdam" is 08:00Z in de winter en 07:00Z in de zomer. Regel:
  rekenen met `Intl.DateTimeFormat` in `tz`; nooit een vast aantal uren optellen voor "morgen zelfde tijd".
  Niet-bestaande wandkloktijden (02:30 op de dag dat de klok vooruit gaat) schuiven naar het eerstvolgende
  geldige moment; dubbele (bij terugdraaien) kiezen de eerste. De editor waarschuwt ("deze tijd bestaat niet
  / komt twee keer voor"). Tests met vaste datums (2026-03-29 en 2026-10-25 voor Europe/Amsterdam;
  2026-03-08 en 2026-11-01 voor America/New_York).
- **R2 Herhalende afspraken over een tijdwissel.** `agenda-recurrence.js` rekent nu in de zone van het
  apparaat. Met `tz` per afspraak moet de uitbreiding in `tz` rekenen: een wekelijkse "09:00" blijft 09:00
  wandkloktijd en de UTC-instants verschillen. Uitzonderingssleutels (`ics_exdates`,
  `ics_occurrence_overrides`) en reminder-slots hangen aan `recurrenceIdForStart` (`agenda-occurrence.js:7`)
  en moeten voor bestaande afspraken stabiel blijven (zonder `tz` dezelfde afleiding als nu) of krijgen een
  migratiestap. Dit is het grootste technische risico en heeft een eigen mijlpaal (M3).
- **R3 Conflicten bij sync.** Per-afspraak LWW op `updated_at` (nu) heeft twee zwakke punten die dit ontwerp
  groter maakt: (a) twee apparaten bewerken verschillende velden van dezelfde afspraak, de nieuwste wint
  volledig; (b) apparaatklokken lopen uiteen. Voorstel: LWW houden, maar de verliezende kopie 30 dagen als
  conflictkopie bewaren en in het synclog tonen (`logSync('conflict-agenda-merge')` bestaat; voor notities is
  er al `conflict-copy.js`). Agenda's: LWW per agenda; `order` als fractionele index zodat twee herordeningen
  elkaar niet vernietigen, bij gelijke waarde beslist het id. Verwijderde agenda tegenover bewerkte afspraak:
  zie sectie 3.
- **R4 Hele-dag-afspraken en oude data.** De huidige opslag (lokale middernacht als instant) schuift een
  dag bij een apparaat in een andere zone; afleiden bij lezen is best effort. Nieuwe en bewerkte afspraken
  schrijven `start_date`, oude blijven zoals ze zijn.
- **R5 Planning versus tijdzone.** `fire_at` volgt uit de berekende start. Bij wijziging van `tz`, of een
  update van de IANA-database, moet de planning opnieuw berekend worden (`topUp` doet dat nu elke 12 uur
  voor 60 dagen; behouden).
- **R6 Oudere app-versies.** Een oude app negeert `calendarId` en `tz` en toont de afspraak in de
  apparaatzone zonder agenda; de velden blijven bewaard, maar de weergave verschilt tijdelijk. Mitigatie:
  bestaande updatecontrole; zie M1 voor de pack-`version`.
- **R7 Lekken via UI-keuzes.** Agendanamen ("Dokter") zijn ciphertext en mogen nooit in mail, push,
  `localStorage` of console. De payload-allowlist van de server blijft de bewaker; test erbij.

## 7. Mijlpalen

Elke mijlpaal is een eigen taak met tests. M1 hangt af van K1 en K2.

1. **M1 Datamodel.** `calendars` en `deleted_calendars` in de pack, `DEFAULT_CALENDAR_ID`,
   `ensureDefaultCalendar`, merge van agenda's, velden `calendarId`, `tz`, `reminders` (minuten) en
   `start_date`/`end_date` met leesmigratie, onbekende velden bewaren. Geen UI. Tests: twee apparaten zonder
   `calendars` die samenvoegen geven één standaardagenda; oude pack blijft ongewijzigd; onbekende velden
   overleven een bewerking door een oude app.
2. **M2 Agenda-UI.** Agendalijst met kleur (palet, contrast), zichtbaarheid, volgorde, hernoemen, verwijderen
   met keuze verplaatsen/meeverwijderen, agendakeuze in de editor, afspraakkleur volgt de agenda.
   Toegankelijk (toetsenbord, `aria`, niet alleen kleur), mobiel eerst, in de bestaande stijl
   (`agenda.js`, `css/app.css`).
3. **M3 Tijdzones.** Zoekbare zonelijst, weergave in twee zones, hele dag zonder zone, herhaling en
   uitbreiding in `tz` (R1, R2), tests rond de DST-datums.
4. **M4 Lokale herinneringen.** Keuze in minuten, lokale Notification en banner, gemiste herinneringen, uitleg
   bij gesloten tab (5.1). Daarna, afhankelijk van K3, aanpassing van de server-route (venster, tekst).

## 8. Open keuzes voor de eigenaar

- **K1 Opslagvorm** (2.1): optie A (map in `agenda_pack`, aanbevolen) of optie B (één kluisitem per afspraak
  en per agenda).
- **K2 Agenda verwijderen** (sectie 3): standaard *verplaatsen* (aanbevolen) of *mee verwijderen*; en of de
  laatste agenda onverwijderbaar is (aanbevolen: ja).
- **K3 Server-herinneringen** (5.2): (a) laten zoals nu (exact `fire_at` en lokaal tijdlabel), (b) de variant
  met generieke tekst en vaag venster (aanbevolen), (c) alleen lokaal en de server-kanalen uitzetten. Raakt
  de belofte op de site en `PRIVACY.md`.
- **K4 E-mail als kanaal** behouden of schrappen: e-mail lekt meer naar derden dan push (hele
  mailproviderketen, niet end-to-end, bewaard). Aanbeveling: behouden als opt-in met uitleg, tenzij "geen
  derde partij ziet afspraakmetadata" zwaarder weegt.
- **K5 Plan:** blijven herinneringen alleen Pro (`agenda_reminders` in `plans.py`)? Lokale herinneringen
  (fase 1) kosten de server niets; aanbevolen: gratis.
- **K6 Aparte eindzone** (Proton heeft die): niet in v1 (aanbevolen).
- **K7 Padding van de pack** tegen zichtbare grootte: nu niet (aanbevolen), en in `PRIVACY.md` eerlijk blijven
  zeggen dat grootte en aantal items zichtbaar zijn.
- **K8 Delen van agenda's** valt buiten dit ontwerp; onderzoek staat in `docs/CALENDAR_SHARING_DESIGN.md`. Dat
  document gaat nog uit van één agenda en moet bij M1 worden bijgewerkt naar `calendarId` als basis voor een
  toekomstige agendasleutel.
