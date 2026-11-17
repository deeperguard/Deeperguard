# Ontwerp: fijner servervenster voor herinneringen (opt-in, 5 minuten)

Status: ontwerp met de eerste bouwstap. Idee #196, vervolg op #106 (`docs/design/reminders.md`, keuze K1).
Dit document herhaalt die ontwerpen niet; het legt vast wat een fijner venster de gebruiker oplevert, wat
de server daardoor extra ziet, wat gebouwd is en welke keuzes bij de eigenaar liggen.

## 1. Wat bestond al (niet opnieuw gebouwd)

| Onderdeel | Waar | Tijd die de server ziet |
| --- | --- | --- |
| E-mailherinnering bij een afspraak (Pro) | `agenda-reminders.js`, `/api/agenda-reminders/sync`, `db.sync_agenda_reminders` | venster van 15 minuten; de server rondt zelf ook af |
| Push bij een afspraak (Pro) | zelfde route, kanaal `push` | exacte seconde plus het label met de begintijd (zie `reminders.md` §3, K1e) |
| Vensterpush voor taken en notities (Pro) | `agenda-task-reminders.js`, `note-reminders.js`, `/api/push-windows` | venster van 15 minuten en een willekeurig id; de server weigert iets anders |
| Verzending | `warning_cron.py`, elke 5 minuten | n.v.t. |
| Lokale herinnering (app open) | `agenda-local-reminders.js` | niets; exact op de minuut |

Het gat: wie een herinnering wil terwijl de app dicht is, krijgt e-mail en vensterpush tot 15 minuten te
vroeg. "10 minuten van tevoren" kan zo 25 minuten van tevoren worden.

## 2. Wat de gebruiker krijgt

In Agenda-instellingen, bij "Event reminders" (Pro), staat een keuzelijst **"Timing when Deeperguard is
closed"**: "Within 15 minutes (default)" of "Within 5 minutes".

- Standaard blijft 15 minuten. Niemand krijgt een fijner venster zonder het zelf te kiezen.
- De keuze geldt per browser (ze staat in de lokale voorkeuren, net als de kanaalkeuzes) en raakt
  e-mailherinneringen van afspraken en de vensterpush van taken en notities die vanuit die browser worden
  gepland. Afspraak-push verandert niet: die gebruikt nu al de exacte tijd.
- Met 5 minuten komt een herinnering hoogstens 5 minuten te vroeg in plaats van 15.
- Bij het wisselen worden afspraken en taken opnieuw gepland (oude vensters ingetrokken, nieuwe geüpload).
  Een notitie houdt haar venster tot de herinnering van die notitie opnieuw wordt opgeslagen. Zonder
  verbinding gebeurt het herplannen bij het volgende bezoek aan de Agenda.
- De teksten die "15 minuten" noemen (wat de server ziet, de uitleg bij e-mail, de hint bij een notitie
  en bij een taak) tonen 5 minuten zodra de keuze 5 is.
- De uitleg onder de keuzelijst zegt wat het kost: de server leert het tijdstip van elke zulke herinnering
  tot op 5 minuten in plaats van 15 en kan zien dat deze keuze is gemaakt; de mailrelay en de
  mailprovider, of de pushdienst van de browser, zien het verzendmoment even nauwkeurig; titels, locaties
  en notities gaan nog steeds nooit mee.

**Waarom geen 1 minuut.** De verzender draait elke 5 minuten. Een venster van 1 minuut zou de server de
minuut laten zien zonder dat de melding preciezer aankomt: wel de privacyprijs, niet de winst. Dat is
daarom niet gebouwd en wordt niet aangeboden (zie K2). Voor de exacte minuut blijft de lokale herinnering
met de app open het antwoord.

## 3. Datamodel en protocol

Geen nieuwe tabel of kolom.

- Lokale voorkeur `reminder_window_min` in `deeperguard-prefs`: afwezig (15) of `5`. Elke andere waarde
  telt als 15.
- `POST /api/push-windows` en `POST /api/agenda-reminders/sync` aanvaarden een optioneel veld
  `window_sec` met waarde `900` of `300`; iets anders geeft HTTP 400 en er wordt niets opgeslagen.
  - Zonder het veld blijft alles zoals het was: `window_start` moet een veelvoud van 900 zijn en
    e-mailtijden worden naar beneden afgerond op 900 s.
  - Met `window_sec: 300` mag `window_start` een veelvoud van 300 zijn en rondt de server e-mailtijden
    af op 300 s.
- De client stuurt het veld alleen mee als een tijd in de aanvraag het nodig heeft (geen veelvoud van
  900). Een herinnering die toevallig op een kwartier valt, gaat dus ook na de opt-in zonder veld weg.
- De ontdubbeling tussen lokale melding en push (`reminders.md` §4) herkent een opgeslagen venster als het
  het kwartier- of het 5-minutenvenster van de herinnering is.

## 4. Wat de server wel en niet ziet

| Gegeven | Standaard (15 min) | Na opt-in (5 min) |
| --- | --- | --- |
| Tijdstip van een e-mailherinnering of vensterpush | begin van het kwartier | begin van het 5-minutenvenster |
| Dat de fijnere keuze is gemaakt | n.v.t. | ja: het veld `window_sec` in de aanvraag en tijden die niet op een kwartier vallen. Het wordt niet als apart gegeven opgeslagen; het is af te leiden uit de opgeslagen tijden en uit logs van aanvragen |
| Exacte minuut, titel, locatie, tekst, welk item | nooit | nooit |
| Mailrelay en mailprovider (e-mail), pushdienst (push) | verzendmoment, op het kwartier | verzendmoment, op 5 minuten |

Het zero-knowledge-model (versleutelde inhoud) verandert niet. Wat verandert is tijdstip-metadata: drie
keer zo fijn, en dus een scherper patroon van iemands dag voor wie de database of de logs kan lezen.

## 5. Risico's

| # | Risico | Maatregel |
| --- | --- | --- |
| R1 | Fijnere tijden zijn beter te koppelen aan andere activiteit van het account | Standaard uit; de uitleg noemt het bij de keuze; niet fijner dan 5 minuten |
| R2 | De keuze zelf is zichtbaar voor de server | Staat in de uitleg ("can tell that you chose this") |
| R3 | Na terugzetten naar 15 minuten staan er nog fijne vensters op de server | Afspraken en taken worden direct herpland; een notitie pas bij opnieuw opslaan, en dat staat in de uitleg |
| R4 | Verzender loopt achter of mist een ronde: de melding komt later dan het venster | Bestaand gedrag: een rij die meer dan 30 minuten te laat is, wordt niet meer verstuurd. Het venster belooft "hoogstens zoveel te vroeg", geen exacte aankomst |
| R5 | Publieke tekst zegt "15 minuten" waar het voor een deel van de gebruikers 5 is | `docs/PRIVACY.md` noemt de opt-in; de teksten in de app volgen de keuze |
| R6 | Oudere client op een ander apparaat plant dezelfde afspraak met 15 minuten | De herinnerings-id is dezelfde, dus de laatste upload bepaalt het venster; er ontstaan geen dubbele mails |

## 6. Vergelijking met concurrenten

Zoals in de vergelijkingstabel van `agenda-completion.md` (modelkennis, niet nagelopen, geen feit voor publiek gebruik): Proton
Calendar stuurt push en e-mail op het tijdstip zelf, waarvoor de server tijdstippen kent; Notesnook
gebruikt lokale meldingen zonder server-push. Dit ontwerp zit daartussen: standaard grof, op verzoek
fijner, met in de instellingen per stap wat de server erdoor leert. Een exacte server-herinnering voor
taken en notities bieden we bewust niet aan.

## 7. Mijlpalen

1. **M1 (gebouwd met dit document)**: voorkeur en keuzelijst met uitleg, `window_sec` in beide routes,
   planners voor e-mail, taken en notities, meebewegende teksten, ontdubbeling, tests
   (`tests/test_reminder_fine_window*.{js,py}`), `docs/PRIVACY.md`.
2. **M2 (na keuze K1)**: de keuze met het account laten meereizen (versleuteld in de kluis) in plaats van
   per browser.
3. **M3 (na keuze K2 en K3)**: alleen als de eigenaar het wil: de verzender vaker laten draaien en dan
   een venster van 1 minuut aanbieden; afspraak-push op hetzelfde venstermodel (K1e uit `reminders.md`).

## 8. Keuzes voor de eigenaar

| # | Keuze | Opties | Privacy-effect | Aanbeveling |
| --- | --- | --- | --- | --- |
| K1 | Geldt de keuze per browser of per account? | (a) per browser (gebouwd); (b) versleuteld in de kluis, voor alle apparaten | geen verschil in wat de server per herinnering ziet; (b) voorkomt dat twee apparaten verschillend plannen | (a) nu; (b) als vervolg |
| K2 | 1 minuut aanbieden? | (a) nee (gebouwd); (b) ja, met de verzender elke minuut | (b) laat de server de minuut zien, vrijwel gelijk aan exact | (a); wie de minuut wil, houdt de app open |
| K3 | Afspraak-push ook op vensters (15 of 5) in plaats van exact | zie `reminders.md` K1e | de server ziet dan de exacte starttijd van push-afspraken niet meer | ja, als aparte taak |
| K4 | Mag de publieke tekst zeggen "standaard 15 minuten, 5 minuten alleen als je het zelf kiest"? | ja / nee | geen | ja, na bevestiging van de retentie (`reminders.md` K7) |
