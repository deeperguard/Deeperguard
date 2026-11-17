# Ontwerp: herinneringen afmaken (agenda, notities, taken, push zonder inhoud, preciezer dan 15 minuten)

Status: ontwerp voor de eigenaar. Er verandert niets aan code, schema of UI-tekst met dit document.
Idee #106 (roadmap, M). Dit is het kopdocument voor de bouwtaken; die hangen er via "after" van af.
Het bouwt voort op, en herhaalt niet:

- `docs/design/push-reminders.md` (opt-in venster-push, meldingssleutel, claim; idee #75),
- `docs/PUSH_REMINDERS_DESIGN.md` (opties A, B, C en de claimtekst),
- `docs/REMINDERS_TASKS_SPEC.md` (formaat van notitie-herinnering en taak, lokale herinneringen),
- `docs/design/calendar-multi.md` §5 (agenda-herinneringen: e-mail en lokaal).

Wat dit document toevoegt: één gecontroleerd overzicht van wat er nu **echt** is (§1, tegen de draaiende app
nagelopen), een tabel van wat de server per veld ziet (§3), de bezorging met ontdubbeling (§4) en de
keuzes en mijlpalen (§6, §7). Verwijzingen naar code noemen bestands-, functie-, constante- en tabelnamen, geen regelnummers; regelnummers verschuiven bij elke wijziging.

## 1. Wat er nu bestaat

### 1.1 Hoe dit is gecontroleerd

Op 2026-11-17 is de echte Flask-app gestart (`tests/run_agenda_editor_browser.py:start_server`, lege
datamap, `NOTES_STRICT_ZK=1`) en met Chromium (Playwright) bediend: account geregistreerd via `/register`,
plan in de database op Pro gezet en e-mailadres als bevestigd gemarkeerd, daarna
`NotesStore.upsertAgendaEvent` met titel "SECRET-TITLE", start over 3 uur en `reminders: [15, 60]`, en
`NotesAgendaReminders.syncEventReminders`. Alle `POST /api/*`-verzoeken van de pagina zijn opgevangen en
daarna zijn de tabellen in `notes.db` gelezen. Wat zo is gezien:

| Waargenomen | Resultaat |
| --- | --- |
| `POST /api/agenda-reminders/sync` met kanaal e-mail | body exact `{"reminders":[{"id":"<uuid>","fire_at":1794894300,"channel":"email"},{"id":"<uuid>","fire_at":1794891600,"channel":"email"}],"delete_ids":[]}`; beide `fire_at` deelbaar door 900 |
| Rij in `agenda_scheduled_reminders` | `id`, `fire_at`, `channel='email'`, `local_time_label=''`, `sent_at=0`, tijdstempels; geen titel, geen event-id |
| Event zelf (`POST /api/sync/items`) | alleen `item_uuid`, `ciphertext` (`{"v":1,"iv","data"}`), `content_hash`, `deleted`, `updated_at`; "SECRET-TITLE" komt nergens leesbaar voor |
| `GET /api/agenda-reminders/push-config` | `{"email_ready":true,"push_ready":false,"vapid_public_key":""}`: zonder VAPID-sleutels is het push-kanaal uit |
| `POST /api/push-windows` zonder push-abonnement | HTTP 404 `unknown device`: het endpoint bestaat en eist een abonnement |
| `POST /api/reminders` (notitie) | rij in `note_reminders`: `item_uuid`, `warn_at` (exacte seconde), `title=''` |
| `localStorage` na het synchroniseren | geen sleutel met "remind" (de wachtrij `agenda_reminder_pending_v1` bestaat pas na een mislukte sync) |

Het push-pad kon in de sandbox niet met een echte pushdienst (geen VAPID, geen browserabonnement). Dat is daarom
nagelopen door `try_send_push` en `run_push_windows` in-process aan te roepen met een nagebootste
`pywebpush.webpush` en de verzonden `data` te lezen:

| Pad | Wat `webpush(data=...)` kreeg |
| --- | --- |
| Agenda-push (`try_send_push`) | `{"title": "Deeperguard", "body": "You have an event at 14:30.", "url": "/app", "reminder_id": "<uuid>"}` |
| Venster-push (`run_push_windows`) | `None`: lege payload; de rij wordt daarna verwijderd |
| E-mail (`agenda_email_body`) | "You have an event coming up soon." plus vaste uitleg; geen tijd, titel of datum |

Niet nagelopen op een echt apparaat: aflevering via FCM/Mozilla/Apple, iOS, Android, Doze (alles **verify**,
zie §5).

### 1.2 Bestanden en functies

| Onderdeel | Waar | Wat het doet |
| --- | --- | --- |
| Plan-poort | `app/plans.py` (`reminders`, `agenda_reminders`) | Beide alleen Pro. Het notitie-kanaal (`reminders`) en het agenda-kanaal zijn aparte plan-rechten. |
| Agenda-herinneringen, client | `app/static/js/agenda-reminders.js`: `computePlannedReminders`, `syncEventReminders`, `flushPending`, `topUp`, `enablePushFromGesture`; `PLAN_HORIZON_DAYS = 60`, `MAX_ROWS_PER_EVENT = 150`, `TOP_UP_INTERVAL_MS` 12 uur | Plant per afspraak, per voorkomen en per offset een rij; id is een SHA-256 van `(event, slot, offset, kanaal)` zodat elk apparaat dezelfde id krijgt. E-mail wordt naar beneden afgerond op 900 s. Push niet (zie §3). |
| Agenda-herinneringen, API | `app/app.py`: `AGENDA_REMINDER_ALLOWED_KEYS` = `id, fire_at, channel, local_time_label`; `/api/agenda-reminders/sync`, `/push-config`, `/push-subscribe` | Strikte sleutellijst; push-endpoint alleen bij bekende pushdiensten (`push_endpoint_allowed`). |
| Agenda-herinneringen, opslag | `app/db.py`: tabel `agenda_scheduled_reminders`, `sync_agenda_reminders`, `AGENDA_REMINDER_PENDING_CAP = 500`, e-mail-afronding `AGENDA_EMAIL_WINDOW_SEC = 900` | Zie §3 voor de kolommen. |
| Bezorging | `app/agenda_reminder_cron.py`: `run_agenda_reminders`, `try_send_push`, `agenda_email_body`, `agenda_reminder_line`, `DEFAULT_MAX_LATE_SEC` 30 min | Een herinnering die meer dan 30 minuten te laat is, wordt gesloten zonder verzending. |
| Venster-push, server | `app/app.py` `PUSH_WINDOW_KEYS = {id, window_start}`, `/api/push-windows`, `/api/push-windows/delete`; `app/db.py` tabel `push_reminder_windows`, `put_push_windows`, `delete_push_windows`, `due_push_windows`, `PUSH_WINDOW_CAP = 50`; `app/agenda_reminder_cron.py:run_push_windows` | Willekeurige 32-hex id en een veelvoud van 900 s; lege push; rij weg na verzending. |
| Venster-push, client | **ontbreekt**: geen enkel bestand onder `app/static/js` roept `/api/push-windows` aan | De serverkant uit idee #75 bestaat, de client en de melding met tekst (M2 en M3 daar) nog niet. |
| Service worker | `app/static/sw.js`: `push`, `notificationclick`, `periodicsync` | Zonder data toont hij "You have a reminder" (tag `dg-window-reminder`). Met data toont hij `title`/`body` uit de payload. Een push voor een herinnering die een tab al toonde, vervangt die melding stil (§4). `periodicsync` stuurt alleen een bericht naar open vensters. |
| Lokale herinneringen (agenda) | `app/static/js/agenda-local-reminders.js`: `dueReminders`, `createPlanner`, `showNotification`; `TICK_MS = 15000`, `MISSED_WINDOW_MS` 24 uur | Draait in de tab, zonder netwerk; klokt elke 15 s; "al getoond" in `localStorage` als hash onder een Web Lock zodat één tab het toont; gemiste (< 24 uur) als "Missed" bij openen. `dueReminders` slaat `agenda_task` over; taken (`dueTaskReminders`) en notities (`dueNoteReminders`) vuren in dezelfde planner op de exacte minuut. Ontdubbeling met push: §4. |
| Notitie-herinnering | `app/static/js/app.js`: `noteReminderPayload`, `queueReminderOp`, `applyReminderOp`, `cancelNoteReminder`; veld `content.warn_at`; `app/app.py` `/api/reminders` (`api_reminders_list`, `api_reminders_upsert`); `app/db.py` tabel `note_reminders`; `app/warning_cron.py` | **Bestaat al**, met exacte tijd in klare vorm op de server (zie §3). De matrix zegt "ontbreekt"; correcter is: "bestaat, server-getimed, Pro, niet privé genoeg". |
| Taken in de agenda | `app/static/js/agenda-tasks.js`: `buildTask`, `normalizeTask`, `placeTasks`, `formatDue`, `accessibleName`; `app/static/js/store.js`: `listAgendaTasks`, `upsertAgendaTask`; renderen in `app/static/js/agenda.js` | Elke taak is een eigen versleuteld item `type: 'agenda_task'` met `due` (YYYY-MM-DD), `due_time`, `done_at`, `note_uuid`, `rrule`, `reminder: null`. **Het veld `reminder` is gereserveerd maar niets leest het**; taken hebben dus geen herinnering. |

### 1.3 Wat dit betekent voor de opdracht

- "Push zonder inhoud" geldt vandaag alleen voor het nog ongebruikte venster-pad. De werkelijke agenda-push
  stuurt wél een tekst (`You have an event at 14:30.`) en bewaart een exacte `fire_at` plus `local_time_label`
  in klare vorm. Dat is een afwijking van de belofte in de opdracht en van de e-mailregel in
  `docs/PRIVACY.md` (de bullet over agenda-e-mail, alleen e-mail). `docs/PRIVACY.md` noemt push en notitie-herinneringen niet.
  Dit is het belangrijkste gat (§3, §6 K1).
- "Preciezer dan 15 minuten" bestaat al lokaal (15 s-tik) en kan server-side alleen ten koste van privacy.
- Niet opnieuw bouwen: de lokale planner, de offset-voorinstellingen, de stabiele id's, de plan-poort, de
  venster-endpoints en `run_push_windows`. Wél bouwen: wat in §7 staat.

## 2. Wat de gebruiker krijgt

1. **Herinnering bij een notitie.** In de notitie een datum en tijd kiezen (de invoer bestaat, `warn_at`).
   Nieuw: de herinnering gaat standaard **lokaal** af (banner en, na toestemming, browsermelding) en uit het
   versleutelde notitieveld, zonder dat de server iets weet. "Ook sturen als de app dicht is" is een aparte,
   opt-in keuze per apparaat (§4, venster-pad). De bestaande exacte server-mail blijft bestaan voor wie
   dat al gebruikt, met label en afbouwpad (K2).
2. **Taken met datum en herinnering.** Een taak houdt zijn datum (en optionele tijd) en krijgt een
   herinnering ("op het tijdstip", "10 min", "1 uur", "1 dag" vooraf, dezelfde keuzelijst als voor
   afspraken). Een taak met alleen een datum herinnert op een vaste tijd die de gebruiker instelt (standaard
   09:00 lokaal). Afvinken annuleert de herinnering op alle apparaten.
3. **Exacte lokale herinnering zolang een tab open is.** De bestaande 15 s-planner wordt uitgebreid naar
   notities en taken. Hij werkt alleen als de kluis ontgrendeld is. Bij vergrendelen stopt hij; een
   gemiste herinnering verschijnt bij het volgende ontgrendelen als "Missed".
4. **Als de app dicht is**: opt-in per apparaat, "kan tot 15 minuten eerder komen", zonder tekst in de
   melding tenzij de gebruiker de aparte schakelaar "melding met tekst" aanzet (ontwerp #75 §3).
5. **Aanvoelen.** Eén herinneringenblok in Instellingen met drie duidelijke regels: "Lokaal (exact, alleen
   met de app open)", "Als de app dicht is (kan tot 15 min eerder, push zonder inhoud)" en, voor wie het
   al heeft, "E-mail (exacte tijd bij ons zichtbaar)". Geen toestemmingsvraag bij het laden van de pagina.
   Elke melding opent de bijbehorende notitie, taak of afspraak.

Doel: dezelfde gemakkelijke bediening als bij de bekende agenda-apps, met aantoonbaar minder zichtbare
metadata, en een duidelijk label waar dat niet kan. Een vergelijking met concurrenten is in dit document
niet opgenomen; die moet met bronnen worden onderzocht voordat ze hier komt.

## 3. Datamodel en wat de server ziet

### 3.1 Versleuteld, in het kluisobject

Alles hieronder staat in de ontsleutelde `content` van het item (AES-256-GCM). De server ziet van een item
alleen `item_uuid`, `ciphertext`, `content_hash`, `deleted`, `updated_at` (zo waargenomen in §1.1). Alle
nieuwe velden zijn optioneel; onbekende velden blijven behouden bij bewerken (oude clients wissen ze niet).

| Item | Veld | Inhoud |
| --- | --- | --- |
| `note` | `warn_at` | bestaat: ISO-tijd van de notitie-herinnering |
| `note` | `reminders` | nieuw: `[{rid, at, push}]`; `at` echte tijd, `push` bool, `rid` 16 willekeurige bytes (hex) alleen als `push` aan staat |
| `agenda_task` | `due`, `due_time` | bestaat |
| `agenda_task` | `reminder` | bestaat als `null`; wordt `{offsets: [minuten], time: "HH:MM", push: bool}` voor dateerbare taken |
| `agenda_task` | `reminder_windows` | gebouwd (M3): `[{id, window_start}]`, de `rid`'s en vensters die naar de server zijn gegaan, zodat ze bij afvinken, verwijderen of wijzigen kunnen worden ingetrokken |
| `agenda_event` | `reminders`, `scheduled_reminder_ids` | bestaan |

De koppeling `rid <-> item` staat alleen in het versleutelde item. Een nieuw veld raakt het sync-schema:
versie ophogen, oude clients negeren het (`docs/design/calendar-multi.md` voor de agenda-velden;
`docs/REMINDERS_TASKS_SPEC.md` §2.3).

### 3.2 Wat ziet de server

Eén rij per verzonden of opgeslagen veld, per kanaal. "Nu" is wat in §1.1 is gezien of uit de code is
gelezen; "Doel" is wat dit ontwerp vastlegt.

| Veld | Kanaal | Wie ziet het (klare vorm) | Waarom het verstuurd wordt | Nu | Doel |
| --- | --- | --- | --- | --- | --- |
| `id` (UUID, SHA-256 van event, slot, offset, kanaal) | agenda e-mail en push | onze server | dezelfde herinnering op elk apparaat herkennen, herplanning zonder dubbel | gezien | blijft; afleiding bevat geen klare data, maar is stabiel per herinnering (koppelbaar over dagen) |
| `fire_at` e-mail | agenda e-mail | onze server | wanneer de mail weg moet | afgerond op 900 s (gezien en server dwingt het af: `db.py` `AGENDA_EMAIL_WINDOW_SEC`) | blijft |
| `fire_at` push | agenda push | onze server | wanneer de push weg moet | **exacte seconde**, niet afgerond (`computePlannedReminders` in `agenda-reminders.js`) | afgerond op 900 s of via venster-pad (K1) |
| `local_time_label` | agenda push | onze server | tekst "event at HH:MM" in de push | opgeslagen als `HH:MM` van de starttijd van de afspraak; leeg bij e-mail | verdwijnt (K1) |
| `channel` | agenda | onze server | kiezen tussen e-mail en push | gezien | blijft |
| push-payload `title`, `body`, `url`, `reminder_id` | agenda push | onze server (bij verzending), pushdienst ziet alleen versleutelde bytes (RFC 8291) en het tijdstip | de melding tonen | `"You have an event at 14:30."` en het `reminder_id` | lege payload, de service worker toont eigen tekst |
| e-mailtekst | agenda e-mail | mailrelay, mailprovider van de gebruiker | de herinnering bezorgen | generiek, zonder tijd of titel | blijft; "kan tot 15 min eerder" blijft erin |
| `item_uuid`, `warn_at` | notitie-herinnering (bestaand) | onze server | server-mail "notitie is aan de beurt" | notitie-id plus exacte seconde in klare vorm, `title` leeg | label "exact, zichtbaar", afbouwen of vervangen door venster (K2) |
| `id` (32 hex), `window_start` | venster-push (nieuw gebruik, server bestaat) | onze server | de push een venster van 15 min bij benadering laten sturen | endpoint bestaat; client ontbreekt | bevestigd; `window_start` is een veelvoud van 900 en dwingt de server af (HTTP 400) |
| `created_at` | venster-push | onze server | opruiming | opgeslagen | blijft; genoemd in de claim |
| `user_id`, `device_id` (koppeling aan abonnement) | venster-push | onze server | bezorging op het juiste apparaat | opgeslagen | blijft |
| abonnement: `endpoint`, sleutels (max. 10 per account) | alle push | onze server, de pushdienst (Google, Mozilla, Apple) | de push bezorgen | opgeslagen | blijft |
| plan, e-mailadres, IP, aantal herinneringen | alle | onze server | toegang, bezorging, limieten | bekend | blijft; aantal is zichtbaar |
| titel, notitietekst, locatie, deelnemers, taaktitel, offset in minuten, `rid`-koppeling | alle | **alleen de gebruiker** (versleuteld in het kluisobject) | n.v.t. | niet verstuurd (gezien: geen titel in `agenda-reminders/sync`) | niet verstuurd |
| exacte tijd van een herinnering of afspraak | venster-pad en lokaal | **alleen de gebruiker** | n.v.t. | n.v.t. | niet verstuurd |

Betekenis voor push en e-mail: bij de e-mail ziet de server het venster van 15 minuten en niet de exacte
minuut. Bij de bestaande agenda-push ziet hij de exacte aanvangstijd van de afspraak. De server kan nu uit
`fire_at` en `local_time_label` bij push de starttijd afleiden. Dat is het gat dat dit ontwerp dicht.

## 4. Bezorging

**Servervenster van 15 minuten met ondoorzichtig id.** De client rondt de herinneringstijd naar beneden af op
een veelvoud van 900 s en uploadt alleen `{id, window_start}` (`POST /api/push-windows`, het bestaande
endpoint). Het `id` is 16 willekeurige bytes en niet afgeleid van item of tijd. De server stuurt een lege
push zodra `window_start <= nu` (`run_push_windows`), wist de rij en bewaart geen `sent_at`. Een venster
dat meer dan 30 minuten te laat is, wordt zonder verzending gewist. Een venster mag hoogstens 366 dagen na de upload liggen (`PUSH_WINDOW_MAX_AHEAD_SEC`, anders HTTP 400), zodat geen rij langer blijft staan. De service worker toont dan een melding.
Zonder meldingssleutel is dat de generieke tekst "You have a reminder"; met de sleutel (ontwerp #75 §3, M3)
zoekt hij het lokaal versleutelde bericht bij het `rid` en toont de titel.

**Lokale timer voor de exacte tijd.** Zolang een tab open is en de kluis ontgrendeld, draait de bestaande
planner (`createPlanner`, tik 15 s en `visibilitychange`) en toont de herinnering op de echte tijd, ook
voor notities en taken (uitbreiding van `dueReminders`, nu `agenda_task` expliciet overgeslagen).

**Ontdubbeling.** Een herinnering kan lokaal én als push aankomen, en op meerdere tabs en apparaten:

- Elke herinnering heeft een stabiele sleutel (`rid` of de bestaande `event|slot|offset`). Lokaal wordt hij
  gehasht en onder een Web Lock geclaimd (bestaand mechanisme in `agenda-local-reminders.js`), zodat één tab
  hem toont.
- De melding gebruikt `tag = rid` in `showNotification` en `new Notification`, zodat een tweede melding met
  dezelfde tag de eerste vervangt in plaats van erbij te komen.
- Komt de push binnen nadat een tab de herinnering al getoond heeft, dan geeft de service worker geen
  tweede melding. Gebouwd (M5) met IndexedDB `deeperguard-reminder-dedup` in plaats van een bericht
  naar open vensters, zodat het ook werkt als de tab intussen dicht is. De planner
  (`agenda-local-reminders.js`) schrijft daar alleen wat de server al kent: het push-`id` van een
  getoonde afspraak-herinnering, en voor taken en notities per venster het willekeurige `rid`, het begin
  van het venster en of alle herinneringen van dat venster lokaal getoond zijn. Geen titels.
  - Agenda-push: de payload heeft `reminder_id`; staat dat id in de lijst, dan is het dezelfde herinnering.
  - Lege venster-push: die heeft geen id. De worker behandelt hem alleen als getoond als de lijst van de
    tab alle vensters dekt waar hij bij kan horen (begin tot 2 uur terug, 5 minuten vooruit), er minstens
    één is, en elk daarvan volledig lokaal getoond is. Twee items in één venster waarvan één nog niet
    getoond is, of een ouder venster dat niet getoond is: dan de gewone melding.
  - Ook dan roept de worker `showNotification` aan (R3): staat de lokale melding er nog, dan toont hij
    die opnieuw met dezelfde `tag` en `silent: true` (vervangt hem op zijn plaats); is hij al weggeklikt,
    dan toont hij een stille melding en sluit die meteen.
  - Komt de push vóór de exacte tijd (het venster begint eerder), dan blijven er twee meldingen: eerst
    de generieke, daarna de lokale.
- Over apparaten heen: elk apparaat toont zijn eigen melding; dat is gewenst (telefoon en laptop). Een
  gesloten of afgevinkte taak intrekt het `rid` op de server en wist het lokale bericht.

## 5. Risico's

| # | Risico | Mitigatie |
| --- | --- | --- |
| R1 | **Tijdstip-metadata**: wie de database leest ziet `window_start` per account, aantal en spreiding. Ook op 15 minuten rond tonen veel herinneringen op een vaste tijd een patroon (slaaptijd, werkdag). `agenda_scheduled_reminders` heeft per push-rij de exacte starttijd. | Venster-pad voor alles wat de app dicht moet bereiken; agenda-push erop overzetten (K1); claimtekst noemt "tijdstip van het venster" en "aantal"; retentiegetallen in `docs/PRIVACY.md` bevestigen |
| R2 | **Koppelbaarheid van id's**: de agenda-id is een SHA-256 van vaste invoer en dus stabiel; hetzelfde id keert terug bij herplannen | Venster-id's zijn willekeurig en per voorkomen nieuw; bij herplannen wordt het oude id ingetrokken en een nieuw gemaakt |
| R3 | **iOS/Safari**: Web Push werkt alleen voor een PWA op het beginscherm (vanaf iOS 16.4), nooit in een gewone Safari-tab. Een push zonder zichtbare melding laat het abonnement vervallen. Gebruikers moeten de toestemming zelf vanuit een tik vragen. Achtergrondtimers worden geparkeerd; een lokale herinnering kan dus niet vuren als de app niet voorgrond is. | Elke push toont altijd een melding (al zo in de `push`-handler van `sw.js`); hulptekst "Zet op beginscherm"; geen belofte van aflevering; **verify** op een echt iPhone/iPad-apparaat |
| R4 | **Service worker**: de worker kan de kluissleutel niet gebruiken en mag dat niet; hij kan worden afgebroken, vervangen of door de browser vergeten (opslag wissen, "site-gegevens wissen"). Een nieuwe worker-versie moet het bestaande `push`-gedrag behouden; `sw.js` zit in de clientmanifest-controle. | Meldingssleutel apart (`extractable: false`, ontwerp #75 §3); bij verlies generieke tekst; tests op het gedrag van de `push`-handler; bij een worker-wijziging `scripts/build-client-manifest.py` draaien |
| R5 | **Best effort**: Doze en batterijbesparing vertragen of laten pushes vallen; Chrome kan pushes beperken bij een gesloten browser | "Best effort" in de UI; gemiste herinneringen bij openen tonen (bestaat, 24 uur) |
| R6 | **Dubbele melding** (lokaal én push, meerdere tabs) | §4: `tag`, Web Lock, onderdrukking |
| R7 | **Titels op het vergrendelscherm** bij "melding met tekst" | Aparte schakelaar, standaard uit, waarschuwing (ontwerp #75 §3) |
| R8 | **Plan-poort**: Pro-gebruikers die downgraden houden rijen | Bestaand: `update_user_plan` wist wachtende agenda-rijen; `update_user_plan` wist ook alle rijen in `push_reminder_windows`; `run_push_windows` wist daarnaast rijen van accounts zonder het recht |
| R9 | **Drie kanalen naast elkaar** (lokaal, venster, bestaande exacte) verwarren | Eén blok in Instellingen met labels; K1 en K2 beslissen over uitfaseren |
| R10 | **localStorage met tijden**: `agenda_reminder_pending_v1` bevat `fire_at` in klare vorm (wachtrij bij mislukte sync) | Verplaatsen naar versleutelde opslag (al genoemd in `REMINDERS_TASKS_SPEC.md` §1 en §9); niet in dit ontwerp opgelost |
| R11 | **Claim loopt achter**: `docs/PRIVACY.md` noemt agenda-e-mail maar geen push en geen notitie-herinneringen | Claim bijwerken voor de release van M5; byte-identieke claim-test (ontwerp #75 M4) |

## 6. Keuzes voor de eigenaar

Per keuze: aanbeveling en het effect op privacy. Het zero-knowledge-model (versleutelde inhoud) verandert bij
geen van deze keuzes; het gaat om tijdstip-metadata.

| # | Keuze | Opties | Privacy-effect | Aanbeveling |
| --- | --- | --- | --- | --- |
| K1 | **Fijnere of grovere servervensters** | (a) 15 minuten (nu, ontwerp #75); (b) 5 minuten; (c) 1 minuut of exact; (d) 60 minuten; (e) agenda-push ook naar vensters overzetten en `local_time_label` en de tekst in de push schrappen | (a) server ziet een kwartier; (b) en (c) onthullen de minuut en vergroten koppelbaarheid met activiteit (alleen de tijd van de melding, niet de inhoud); (d) minder zichtbaar, maar de melding komt tot een uur te vroeg, dat is voor taken en afspraken vaak onbruikbaar; (e) sluit het gat uit §3: de server ziet dan niet meer de exacte starttijd van push-afspraken | Houd 15 minuten; doe (e); voor "exact" geldt de lokale timer. Wie preciezer wil, kan dat alleen met de app open, of in een latere opt-in met 5 minuten waarbij de UI zegt dat de server de minuut leert |
| K2 | **Vallen notitie-herinneringen ook onder Pro?** | (a) ja, zoals nu (`plans.py`, `reminders` Pro); (b) lokale herinnering gratis, server-kanalen (venster-push en e-mail) Pro; (c) alles gratis | (a) en (b) verschillen niet voor privacy: de server ziet alleen iets bij de server-kanalen. (c) laat meer accounts `window_start`-rijen opbouwen (meer metadata, geen extra inhoud). De exacte `warn_at` op de server blijft hoe dan ook alleen voor het bestaande kanaal | (b): lokaal voor iedereen (geen server, geen metadata), server-kanalen Pro; het bestaande exacte kanaal labelen en afbouwen |
| K3 | **Bestaande exacte kanalen** (e-mail bij notities met `warn_at`; agenda-push met `fire_at` en label) | houden met label, naar venster omzetten, of uitfaseren | houden: de server blijft de exacte tijd van die items zien; omzetten of uitfaseren: dat verdwijnt | Notitie-mail houden met label "exacte tijd zichtbaar voor de server"; agenda-push omzetten (K1e) |
| K4 | **Melding met tekst** | alleen generiek, of titel via lokale meldingssleutel | titel verlaat het apparaat niet; wel zichtbaar op het vergrendelscherm bij diefstal | aanbieden, standaard uit |
| K5 | **iOS alleen via beginscherm** acceptabel in de UI-tekst? | ja / nee | geen effect op wat de server ziet | ja, met uitleg |
| K6 | **Taken zonder tijd**: vaste herinneringstijd (09:00) of op het moment van opening | vaste tijd per gebruiker | een vaste tijd per account komt terug in alle `window_start`-rijen en vormt een patroon | standaard 09:00 lokaal; per gebruiker aanpasbaar, willekeurig binnen het venster is niet nodig |
| K7 | **Retentie** van backups en logs voor de claim | getallen bevestigen | bepaalt hoe lang `created_at` en `window_start` bewaard blijven | bevestigen vóór de claim |

## 7. Mijlpalen (passen bij de vervolgtaken)

Elke mijlpaal is een bouwtaak die van dit document afhangt. Wat al bestaat (§1.2) wordt niet opnieuw gebouwd.

1. **M1 Venster-push in de client** (bestaat server-side). Instellingenrij, toestemming na een tik,
   pushabonnement, venster berekenen (naar beneden afronden op 900 s), `POST /api/push-windows`, intrekken
   via `/api/push-windows/delete`, `tag` tegen duplicaten, `push`-handler uit `sw.js` blijft. Test met een
   nagebootste `fetch` dat nooit een exacte tijd of titel de deur uitgaat, en dat het venster een veelvoud
   van 900 is.
2. **M2 Agenda-push op vensters** (K1e, K3). `local_time_label` en de push-tekst schrappen; `fire_at` voor
   push afronden zoals bij e-mail; test op de body van `/api/agenda-reminders/sync`. Bijwerken van
   `docs/PRIVACY.md`.
3. **M3 Taken met herinnering**. `agenda_task.reminder` invullen, editor met offsets en tijd, planner
   (`dueReminders`) laat taken toe, afvinken en verwijderen trekken `rid`'s in, test per hoek: leeg, één,
   veel, afgevinkt, dezelfde actie twee keer, vergrendelde kluis.
4. **M4 Notitie-herinnering lokaal en optioneel via venster** (K2). Nieuw veld `reminders` op de notitie,
   bestaand `warn_at` blijft gelezen (migratie bij bewerken), bestaand server-kanaal gelabeld. Test dat
   `POST /api/reminders` niet meer gebeurt zonder expliciete keuze.
5. **M5 Ontdubbeling over lokaal en push** (§4): bericht van tab naar service worker, `tag`, tests in een
   browser met twee tabs en een testpush.
6. **M6 Melding met tekst** (ontwerp #75 M3, K4): meldingssleutel, lokale ontsleuteling in de service
   worker, terugval.
7. **M7 Apparaattest en claim**: Android Chrome/Firefox, iOS-PWA, desktop (alle **verify**-punten uit §5),
   daarna de claimtekst en de claim-test publiceren (R11).
