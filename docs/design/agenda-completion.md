# Ontwerp: agenda afmaken (meerdere agenda's, tijdzones, herinneringen, push, e-mail, webcal)

Status: ontwerp voor de eigenaar. Met dit document verandert er niets aan code, schema of UI-tekst.
Idee #84, eerste taak; de bouwtaken volgen na de keuzes in sectie 7.

Dit document vervangt de eerdere voorstellen niet maar corrigeert ze met wat er nu feitelijk in de
code staat: `docs/design/calendar-multi.md` (idee #51), `docs/design/push-reminders.md` (idee #75),
`docs/PUSH_REMINDERS_DESIGN.md` en `docs/ICS_SUBSCRIBE_SPEC.md`. Een groot deel daarvan is sindsdien
gebouwd. De taakomschrijving van #84 noemt vier onderdelen "ontbrekend of half"; de inventaris hieronder
laat zien dat dat voor meerdere agenda's en tijdzones niet meer klopt.

## 1. Inventaris van wat er nu is

**Hoe dit gecontroleerd is.** Er zijn twee bronnen gebruikt: de code (paden onder `app/`) en de
draaiende app. Een lokale server met een lege tijdelijke datamap en een wegwerpaccount (Free-plan),
bestuurd met Playwright/Chromium op 2026-11-17, apparaat-tijdzone Europe/Amsterdam. In de app zijn een
tweede agenda "Werk" aangemaakt, twee afspraken opgeslagen (één met tijdzone America/New_York en
herinneringen "20, 120", één hele-dag-afspraak), de instellingen en de editor bekeken, een
webcal://-link in het abonnementsformulier ingevoerd en de .ics-export gedownload. De opgeslagen
afspraken zijn uitgelezen via `NotesStore.listAgendaEvents()`. Wat niet kon: bezorging van echte push of
e-mail (geen VAPID-sleutels, Free-plan, geen mailrelay) en echte OS-meldingen (in de testbrowser
staat meldingstoestemming op "geblokkeerd"). Per rij zegt de kolom **Bron** wat er in de app is gezien en wat alleen uit
code komt.

Kolom **Bron**: **app** = in de draaiende app gezien; **app + code** = een deel in de app gezien, het
rest alleen uit code; **code** = alleen uit de code gelezen, niet in de app gezien.

Kolom **Status** beoordeelt de code: **werkt** = functie is aanwezig en werkt volgens de code;
**half** = werkt maar mist iets wat de taak vraagt; **ontbreekt** = niet aanwezig. Een status
**werkt** of **half** zegt dus niet dat bezorging, afgaan of ophalen is gezien; dat staat in Bron.

| Onderdeel | Status | Bron | Bevinding | Bestand:regel |
|---|---|---|---|---|
| Opslag van afspraken | werkt | app | Alle afspraken in één versleuteld item `agenda_pack` (vaste uuid); server ziet alleen ciphertext. | `app/static/js/store.js:1807`, `:1901` |
| Meerdere agenda's: model | werkt | app | `calendars` in de versleutelde pack met `type`, `name`, `color` (sleutel), `visible`, `order`, `default_reminders`, `is_default`. Standaardagenda met vaste id. Gezien in de app: "Agenda" (blauw) en "Werk" (teal). | `store.js:1950-1976`, `:2009`, `:2038`, `:2566` (samenvoegen) |
| Meerdere agenda's: UI | werkt | app | Paneel "My calendars": nieuw, hernoemen, kleur (9 vaste tinten, radio-knoppen), aan/uit, verwijderen. Native knoppen en labels. In de editor een keuzelijst "Calendar". | `app/static/js/agenda-calendars.js:15-26`, `:281-357`; `app/templates/app.html:1537-1540`, `:2841` |
| Kleuren | werkt | app + code | Kleur per agenda uit een vaste palet-lijst (contrasttest bestaat). Oude per-afspraak-kleur (`EVENT_COLORS`) bestaat nog naast de agendakleur. | `agenda-calendars.js:15`; `app/static/js/agenda.js:6` |
| Agenda-id op afspraak | werkt | app | `calendarId` op de afspraak; zonder id geldt de standaardagenda (alleen in het geheugen, niets herschreven). Gezien: nieuwe afspraak kreeg de id van "Werk". | `store.js:2001`; `agenda.js:3001`, `:3034-3044` |
| Tijdzone per afspraak | werkt | app | Optioneel veld `tz` (IANA) naast een UTC-instant; invoerveld met 419 zones in een datalist, standaard de apparaatzone; een hele-dag-afspraak heeft geen zone (rij verborgen, `tz: null` opgeslagen). Gezien: `tz: "America/New_York"`. | `app/static/js/agenda-tz.js:1-9`; `agenda.js:2535-2551`, `:3011`; `app.html:2837` |
| Tijdzone: tijd in andere zone tonen | werkt | code | Detailweergave toont de originele tijd naast jouw tijd. | `agenda-tz.js:134`; `agenda.js:2172` |
| Zwevende afspraken (floating) | ontbreekt | code | Er is geen "zonder zone"-modus voor afspraken met tijd. Een afspraak zonder `tz` is een vaste UTC-instant en volgt de apparaatzone alleen bij het tonen. Alleen import leest zwevende ICS-tijden, en maakt er direct een instant van. | `agenda-ics.js:139-170` |
| Hele-dag-afspraken | half | app | Opgeslagen als lokale middernacht van het apparaat als instant (`start: 2026-11-16T23:00Z`, `end: 2026-11-17T23:00Z` op een Amsterdamse apparaatzone). Wisselt het apparaat van zone, dan schuift de dag. | `agenda.js:2884-2893`; gezien in de app |
| Herinneringen instellen | werkt | app | `reminders` is een lijst minuten vooraf (gezien: `[20, 120]`), presets (op tijd, 5, 10, 15, 30 min, 1 uur, 1 dag) plus eigen waarden 0-40320, en een standaardlijst per agenda (`default_reminders`). | `app.html:2813-2831`; `agenda.js:2556`, `:2727`; `store.js:1960` |
| Herinneringen lokaal | werkt (code + UI) | app + code | Planner leest de ontsleutelde afspraken, vuurt elke herinnering één keer (Web Lock tussen tabs), toont een banner in de app en een `Notification` als de gebruiker toestemming geeft. Gemiste herinneringen (tot 24 uur) komen eenmalig als "Missed", zonder OS-melding. Gezien in de app: uitleg en de status "Browser notifications are blocked"; het afgaan zelf is niet in de app uitgelokt. | `app/static/js/agenda-local-reminders.js:52-80`, `:105`, `:231-240`; `app.html:1566-1571` |
| Herinneringen lokaal via service worker | ontbreekt | code | De lokale melding gebruikt `new Notification(...)`, niet `registration.showNotification`; sommige mobiele browsers staan dat alleen via de service worker toe (de code vangt de fout op en toont dan alleen de banner). | `agenda-local-reminders.js:231-240` |
| E-mailherinneringen | half | app + code | Server-route, tabel en cron bestaan; alleen Pro (`agenda_reminders`). Gezien: op Free staan de vinkvakken uitgeschakeld met "Event reminders are included with Pro". Bezorging niet gezien. De server krijgt per herinnering `id`, `fire_at` (exacte seconde), `channel`, `local_time_label`; de mailtekst is generiek. | `app/app.py:2616`, `:2639-2690`; `app/db.py:372-386`; `app/agenda_reminder_cron.py:80-92`, `:144`; `app/plans.py:129`; `app.html:1578-1583` |
| Push (per herinnering) | half | code | Pro-kanaal: client schrijft in via `pushManager.subscribe`, server bewaart het endpoint en stuurt via pywebpush; alleen als VAPID is ingesteld. Payload bevat een generieke titel/tekst en `reminder_id`. Niet gezien in de draaiende app (geen VAPID). | `app/static/js/agenda-reminders.js:525-547`; `app.py:2691-2737`; `agenda_reminder_cron.py:100-130` |
| Push (venster-opt-in uit #75) | half | code | Server-kant bestaat: tabel `push_reminder_windows` (id + 15-minutenvenster), routes `/api/push-windows`, cron `run_push_windows` met lege push, service worker toont vaste tekst. Er is **geen client** die die routes aanroept (geen verwijzing in `app/static/js`). | `db.py:398-411`; `app.py:2739-2794`; `agenda_reminder_cron.py:192-200`; `app/static/sw.js:540-552` |
| ICS-import | werkt | code | Bestand kiezen of laten vallen, voorbeeldweergave vóór opslaan; leest TZID en bewaart `source_tz`; VALARM en VTIMEZONE worden overgeslagen. | `app/static/js/agenda-ics.js:3`, `:566`, `:659`; `app.html:1547` |
| ICS-export | half | app + code | Eén bestand met alle afspraken van alle agenda's (gezien); geen onderscheid per agenda, geen agendanaam of -kleur. Afspraken met tijdzone worden bij herhaling met TZID + VTIMEZONE geschreven, maar een enkele afspraak met `tz` ging als UTC-instant (gezien); herinneringen worden niet als VALARM geschreven. Bestand is onversleuteld, en dat staat in de UI. | `agenda-ics.js:385-516`, `:480-490`; `agenda.js:406`, `:1051-1060`; `app.html:1564` |
| Abonneren op een webcal-/https-feed | werkt | app + code | Abonnementen in de versleutelde pack; `webcal://` wordt naar `https://` omgezet; de browser haalt de feed zelf op; bij een CORS-blokkade keuze "Fetch via server" via een relay die niets opslaat. Gezien: een onbereikbare feed gaf de relay-keuze. Het ophalen van een echte feed is niet geprobeerd (geen netwerk). | `app/static/js/agenda-subscriptions.js:40-43`; `app/ics_relay.py:1-25`; `app.py:1038`; `app.html:1550-1561` |
| Eigen agenda als webcal-feed aanbieden | ontbreekt | code | Er is geen route die een agenda als leesbare feed publiceert. Alleen de eenmalige .ics-export. | n.v.t. (gezocht in `app.py`, `agenda-ics.js`) |

Samengevat: de rest van "meerdere agenda's met kleuren" en "tijdzone per afspraak" is af en blijft staan.
Open zijn: zwevende en hele-dag-afspraken, meldingen via de service worker, een client voor de
venster-push, betere export (per agenda, TZID, VALARM) en de beslissing over e-mail/push/webcal.

## 2. Datamodel

Wat er is, blijft: de versleutelde `agenda_pack` met `events`, `calendars`, `deleted_calendars`,
`subscriptions`, `deleted_events`. De server ziet daar niets van behalve de ciphertext en de grootte.

**Agenda-entiteit (bestaat):** `{type:'agenda_calendar', version:1, id, name, color, visible, order,
default_reminders:[minuten], is_default, updated_at}`. `color` is een paletsleutel; onbekende sleutels
vallen terug op de eerste tint en blijven bewaard (`agenda-calendars.js:30-33`).

**Afspraak (bestaat):** `calendarId`, `tz` (optioneel IANA-naam), `reminders` (minuten vooraf, oplopend
verwerkt in `agenda-local-reminders.js:31`). Wat het ontwerp toevoegt, steeds optioneel zodat een oud
apparaat de pack nog kan lezen:

| Veld | Doel | Standaard bij ontbreken |
|---|---|---|
| `floating: true` | Zwevende afspraak: wandtijd zonder zone | `false` |
| `start_local`, `end_local` | Wandtijd `YYYY-MM-DDTHH:mm` (zwevend) of `YYYY-MM-DD` (hele dag) | afgeleid uit `start`/`end` |
| `all_day` (bestaat) | Hele dag; geen `tz` | `false` |

### Migratie van bestaande afspraken

- **Standaardagenda.** Die is er al: een afspraak zonder `calendarId` hoort bij de agenda met
  `is_default` (`store.js:2001`), en de pack wordt daarbij niet herschreven (gecontroleerd: een pack
  zonder `calendars` toont de standaardagenda in het geheugen). Er is dus geen datamigratie nodig voor
  M1; een eenmalige schrijf-migratie is niet nodig en wordt ook niet voorgesteld, omdat elke schrijf een
  samenvoegconflict tussen apparaten kan geven.
- **Verwijderen van een agenda** laat de keuze "verplaats naar een andere agenda" of "verwijder
  afspraken" (`store.js:2038`); verplaatste afspraken krijgen een nieuwe `updated_at`, zodat
  samenvoegen ze meeneemt.
- **Tijdzone.** Bestaande afspraken zonder `tz` blijven wat ze zijn: een instant die in de apparaatzone
  wordt getoond. Niet automatisch een zone toekennen: dat zou een raden zijn en verandert niets aan de
  weergave.

### Zwevende en hele-dag-afspraken

- **Hele dag** (nu `half`): opslaan als datum (`start_local: '2026-11-17'`, einddatum exclusief) en
  `start`/`end` nog steeds meeschrijven als instants van de apparaatzone, voor oudere clients. Lezers
  die `start_local` kennen, gebruiken uitsluitend de datum, dus de dag schuift niet bij een zonewissel.
  Een hele-dag-afspraak heeft geen `tz`; herinneringen ervoor lopen vanaf lokale middernacht van de dag
  in de dan geldende apparaatzone.
- **Zwevend** (ontbreekt): wandtijd zonder zone ("elke dag 07:00, waar ik ook ben"). `floating: true`,
  `start_local`/`end_local`, geen `tz`. Weergave en herinneringstijd volgen de apparaatzone van het
  moment. In ICS-export: tijd zonder `Z` en zonder TZID (RFC 5545 "floating"). In de UI een duidelijke
  keuze in de zone-regel: "Volgt mijn tijdzone".
- **Zone-afspraak met herhaling:** wandtijd in de zone blijft leidend (zoals de export nu al doet voor
  herhalende afspraken, `agenda-ics.js:429`); de instant verschuift mee met zomer-/wintertijd.
- **Randgevallen:** overgang naar zomertijd (niet-bestaand uur: `zonedToInstant`, `agenda-tz.js:93-102`,
  valt dan terug op de offset van een dag eerder; of dat de gewenste keuze is, moet M2 met een test vastleggen),
  onbekende zone-naam uit een nieuwere app (bewaren, tonen in apparaatzone), en een zone die het
  apparaat niet kent (idem).

## 3. Lokale herinneringen (Notification API + service worker)

Het uitgangspunt is wat er al is: de planner in `agenda-local-reminders.js` draait alleen als de app of
PWA open is en de kluis ontgrendeld is, en doet geen netwerkverzoek. De uitbreiding:

1. **Melding via de service worker.** Als `Notification.permission === 'granted'` en er een
   registratie is, `registration.showNotification(...)` gebruiken in plaats van `new Notification`.
   Dat werkt ook op mobiele browsers die de constructor weigeren en laat `notificationclick`
   (`sw.js:567`) de app focussen. Titel en tekst komen uit de ontsleutelde afspraak in de pagina, dus
   de service worker hoeft de kluis niet te kennen. Terugval blijft de banner.
2. **Toestemming alleen na een klik** ("Allow browser notifications", al zo, `app.html:1570`).
3. **Eén melding per herinnering**: de bestaande Web Lock + gehashte "al getoond"-sleutels blijven.
4. **Dubbele bezorging voorkomen** als de gebruiker later ook push of e-mail aanzet: de planner slaat
   een herinnering over die al via een ander kanaal als bezorgd is gemarkeerd; dat vraagt een veld
   per herinnering in de pack (M4), niet in de server.

**De beperking, eerlijk.** Een gesloten tabblad of een afgesloten browser krijgt geen melding, en een
service worker kan zonder push of de nog experimentele geplande-meldingen-API (`showTrigger`, niet in
alle browsers) niet zelf op een tijdstip wakker worden. Een PWA op de achtergrond mag door het
besturingssysteem bevroren worden; op iOS werken meldingen alleen voor een aan het beginscherm
toegevoegde app. Een tabblad op de achtergrond vertraagt timers, daarom telt een herinnering die meer
dan 5 minuten te laat komt als "gemist" (`agenda-local-reminders.js:21`). De UI zegt dit al
("Reminders only work while Deeperguard is open", `app/templates/app.html:1575`) en moet dat blijven zeggen. Dit
platformgedrag komt uit algemene kennis van de standaarden en is op echte apparaten niet nagelopen: **verify**.

## 4. Wat ziet de server? (de drie opties die op de eigenaar wachten)

Alle drie hebben **tijd** nodig bij een partij die niet de browser is. Inhoud (titel, plaats, notities,
agenda-naam) gaat in geen van de opties in klare tekst naar de server, behalve bij een webcal-feed.

| | Tijdstip | Adres / endpoint | Inhoud | Wat de server nog meer weet |
|---|---|---|---|---|
| **Lokaal (nu, zonder server)** | Niets | Niets | Niets | Niets; alleen ciphertext van de pack |
| **Web Push, per herinnering (bestaat, Pro)** | Exacte `fire_at` (seconden) per herinnering, plus een kanaalnaam | Push-endpoint van de browserdienst (FCM, Mozilla, Apple, Windows) en de sleutels, gekoppeld aan het account | Generieke tekst + `reminder_id`; geen titel | Aantal herinneringen, patroon van tijden, welke pushdienst/apparaat; de pushdienst zelf ziet dat er een bericht is en wanneer |
| **Web Push, vensters (server bestaat, client ontbreekt)** | Alleen een 15-minutenvenster per herinnering (`window_start` deelbaar door 900), willekeurige id | Hetzelfde endpoint | Lege push; de service worker toont een vaste tekst. Optioneel in de toekomst een versleutelde payload (zie `push-reminders.md` §3) | Aantal vensters en grove tijden, geen koppeling met een afspraak |
| **E-mail (bestaat, Pro)** | Exacte `fire_at` per herinnering | E-mailadres van het account (staat er al); de mailrelay en de mailprovider zien het adres en de verzendtijd | Generieke tekst: "upcoming event", geen titel, geen tijd (`agenda_email_body`) | Idem als push; plus bewaarde kopieën bij de mailprovider en eventuele back-ups daarvan. E-mail is niet end-to-end versleuteld |
| **Webcal: eigen agenda als feed** (ontbreekt) | Alle begin- en eindtijden van de gekozen agenda, in klare tekst | Een geheime URL; de abonnerende app (Apple Agenda, Thunderbird) haalt hem op; de server ziet elk IP-adres en elke ophaaltijd | **Titel, plaats, notities, deelnemers** staan leesbaar in de feed, anders is hij niet te gebruiken | Alles in die agenda in klaartekst, en de sleutel (de URL) staat in de server. Zero-knowledge vervalt voor die agenda |
| **Eenmalige .ics-export, client-side (bestaat, `half`)** | Geen verbinding met de server; het bestand wordt in de browser gebouwd | Geen | Het bestand is onversleuteld op het apparaat van de gebruiker | Niets; de server ziet de export niet. Bestand kan lekken via downloadmap of back-ups; dat staat in de UI |

### Risico's en advies per optie

**Web Push.** Risico's: (1) het exacte tijdstip is metadata die het ritme van iemands dag verraadt; (2) de
pushdienst (Google/Apple/Mozilla/Microsoft) ziet het bestaan en de timing van elke push; (3) een lege of
generieke push is voor iOS soms een reden om het abonnement te laten vervallen, daarom toont de service
worker altijd iets; (4) bezorging is "best effort" en kan 15 minuten te vroeg komen (venstermodel);
(5) het endpoint is door de gebruiker aangeleverd en de server stuurt er verkeer naartoe, daarom de
host-lijst (`agenda_reminder_cron.py:37-41`). **Advies: ja, maar alleen het venstermodel** als
standaard voor wie push aanzet: afronden op 15 minuten, willekeurige id, lege push, standaard uit,
uitleg vóór de browser-vraag. Het per-herinnering-model met exacte tijd bestaat al; voorstel is dat uit te
faseren zodra de venster-client er is, of de eigenaar de exacte tijd als kanaal te laten kiezen.

**E-mail.** Risico's: (1) adres en tijd bij het relay en de mailprovider, zonder dat wij die kunnen
terugroepen; (2) mail is niet versleuteld en wordt bewaard; (3) e-mail kan als phishing-patroon worden
gezien, dus de tekst blijft generiek en zonder link naar een afspraak; (4) bezorging is
trager dan push. **Advies: houden als uitdrukkelijk gekozen, Pro-only kanaal met de huidige generieke
tekst**, en nooit een titel in de mail zetten. Als de eigenaar het zero-knowledge-beeld zuiver wil
houden, dan is "e-mail uit" een eerlijke keuze (zie vraag 3).

**Webcal.** Risico's: (1) voor die agenda vervalt zero-knowledge: de server kan titels lezen, en wie de
URL kent, ziet alles; (2) de URL is een bearer-geheim dat in browsergeschiedenis, agenda-apps van derden
en back-ups terechtkomt, dus intrekken ("nieuwe URL maken") is verplicht; (3) de feed moet door de
server opnieuw worden opgebouwd uit gegevens die hij niet kan ontsleutelen, dus de client moet
klaartekst uploaden (een tweede opslag buiten de pack, met eigen verwijder- en intrekregels); (4) het
bevestigt "geen kennis" in de marketing niet meer voor wie dit gebruikt. **Advies: nu niet bouwen.**
Aanbieden we toch iets, dan is de eerlijke minimale vorm de bestaande eenmalige client-side .ics-export
(verbeterd in M5), en bij een echte feed alleen per afzonderlijke agenda, standaard uit, met een
waarschuwing die in gewone taal zegt "de server kan deze agenda lezen".

## 5. Vergelijking met Proton Calendar en Notesnook

Dit is modelkennis (publieke documentatie van de aanbieders zoals bekend bij het schrijven), niet
nagelopen en dus **geen** feit voor publiek gebruik; vóór gebruik op de site of in marketing eerst
controleren.

| | Proton Calendar | Notesnook | Deeperguard (dit ontwerp) |
|---|---|---|---|
| Agenda zelf | Ja, versleuteld; meerdere agenda's met kleur, tijdzone per afspraak, herinneringen per afspraak en een standaard per agenda | Geen agenda; herinneringen aan notities | Ja, versleuteld; meerdere agenda's, kleur, zone per afspraak |
| Herinneringen als app dicht is | Pushmeldingen in de mobiele apps, e-mail naar het adres; de server kent daarvoor tijdstippen | Lokale meldingen op het apparaat, geen server-push | Lokaal standaard; push in vensters en generieke e-mail alleen op keuze |
| Webcal | Een agenda delen via een geheime link is mogelijk, met de bijbehorende waarschuwing dat die link leesbaar is; abonneren op andermans link kan | Niet van toepassing | Abonneren werkt; eigen feed alleen na een keuze van de eigenaar |
| Wat wij beter willen doen | Duidelijk tonen wat de server ziet, per kanaal, in de instellingen | Idem | Vensterpush en een eerlijke tabel; geen belofte dat een gesloten tabblad meldingen krijgt |

## 6. Mijlpalen (in de volgorde van de taken)

| # | Mijlpaal | Afhankelijkheid | Klaar als |
|---|---|---|---|
| M1 | Inventaris en ontwerp (dit document) | geen | Document goedgekeurd; keuzes in sectie 7 beantwoord |
| M2 | Hele-dag- en zwevende afspraken: `start_local`/`end_local`/`floating` in de editor, weergave, expansie en import/export | M1 | Wissel van apparaatzone verschuift geen hele-dag-afspraak (test met twee zones); zomertijdgrens getest |
| M3 | Lokale herinneringen via de service worker (`showNotification`), dubbele-bezorging-marker | M1 | Test: melding komt na toestemming, banner als terugval, één per herinnering over twee tabs |
| M4 | Export per agenda met TZID, VALARM en agendanaam; import van VALARM naar `reminders` | M2 | Rondreis export → import behoudt zone, herinneringen en agenda |
| M5 | Venster-push: client voor `/api/push-windows`, aan/uit per apparaat, "Test melding", statusregel | M1, keuze 1 | Server ziet alleen id + venster (test op de aanvraag); uitzetten wist de vensters |
| M6 | E-mail: alleen aanpassingen die uit keuze 3 volgen (bijv. vervallen van `local_time_label`) | M1, keuze 3 | Volgens keuze |
| M7 | Webcal-feed van een eigen agenda | M1, keuze 4 | Alleen na "ja"; intrekken en waarschuwing getest |

## 7. Keuzes voor de eigenaar

Elke vraag is met ja of nee te beantwoorden; achter de vraag staat mijn advies.

1. **Web Push met vensters** (15 minuten, willekeurige id, lege push) aanbieden aan alle gebruikers, niet alleen
   Pro, standaard uit? *Advies: ja.*
2. **De bestaande push met exacte tijd per herinnering** (Pro) laten vervallen zodra de venstermodus
   er is? *Advies: ja; het exacte tijdstip is overbodige metadata.*
3. **E-mailherinneringen** (generieke tekst, Pro) houden? *Advies: ja, met de huidige tekst; "nee" is
   verdedigbaar als zero-knowledge zuiver moet blijven.*
4. **Een eigen agenda als webcal-feed** (leesbaar voor de server, geheime URL) bouwen? *Advies: nee.*
5. Als 4 "nee" is: de eenmalige client-side .ics-export per agenda verbeteren (M4) en dat de enige
   uitwisseling naar buiten laten zijn? *Advies: ja.*
6. **Zwevende afspraken** ("zonder tijdzone") aanbieden naast de zone-afspraken? *Advies: ja.*
7. **De oude per-afspraak-kleur** uitfaseren ten gunste van de agendakleur (de bestaande waarden blijven
   leesbaar)? *Advies: ja.*
8. Mogen we publiek zeggen "zelfs de tijdstippen van je herinneringen zijn gegrofd tot 15 minuten"
   alleen als de tabel in sectie 4 per kanaal klopt en op echte apparaten is nagelopen? *Advies: ja,
   pas na M5 en met die controle.*
