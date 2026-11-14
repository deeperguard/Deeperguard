# Ontwerp: opt-in Web Push-herinneringen met versleutelde payload en minimale metadata

Status: ontwerp voor de eigenaar. Er verandert niets aan code, schema of UI-tekst met dit document.
Idee #75, vervolg op #51 (agenda) en #54 (push). Dit document bouwt voort op
`docs/PUSH_REMINDERS_DESIGN.md` (opties A, B en C, de privacyclaim en de controles) en
`docs/REMINDERS_TASKS_SPEC.md`; het herhaalt die niet, maar voegt toe: wat de gebruiker krijgt, een
versleutelde payload (optie B+), het datamodel, de vergelijking met concurrenten, risico's en mijlpalen.
Platformgedrag (iOS, Android, pushdiensten) is uit algemene kennis van de Web Push-standaarden en moet op
echte apparaten worden nagelopen: **verify**.

## 1. Wat de gebruiker krijgt

1. **Standaard lokaal** (optie C): herinneringen gaan af zolang de app of PWA draait. Niets gaat naar de
   server. Bij openen toont de app wat gemist is.
2. **Optie "Herinneringen als de app dicht is"**, per apparaat, standaard uit, met een uitleg in gewone
   taal vóór de toestemmingsvraag van de browser (zin uit `PUSH_REMINDERS_DESIGN.md` §7.2).
3. **Melding met tekst** (tweede, aparte schakelaar, standaard uit): de melding toont de titel van het
   item in plaats van "Je hebt een herinnering". De tekst reist versleuteld (zie §3) en de server kan hem
   niet lezen.
4. **Eerlijke tijdsaanduiding**: "kan tot 15 minuten eerder komen als de app dicht is". Geen belofte van
   aflevering; de UI zegt "best effort" en wijst bij iOS op "Zet op beginscherm".
5. **Aanvoelen**: één rij in Instellingen met een schakelaar, een statusregel ("Aan op dit apparaat,
   3 herinneringen gepland") en een knop "Test melding". Uitzetten werkt direct en toont wat er van de
   server verdwijnt. Geen prompt bij het laden van de pagina.

## 2. Wat concurrenten doen (algemene kennis, **verify**)

| Product | Closed-app herinnering | Wat de aanbieder ziet |
| --- | --- | --- |
| Google Agenda, Outlook | Server-push/mail met titel in klaartekst | Alles: titel, tijd, deelnemers |
| Apple Agenda/Herinneringen | Lokale melding + iCloud-sync (versleuteld bij Advanced Data Protection) | Zonder ADP: alles; met ADP: weinig |
| Proton Calendar | Meldingen vooral lokaal op apparaat; mail-herinnering beperkt | Versleutelde events, maar tijd van mail/push is bij de verzender bekend |
| Tuta (Tutanota) Calendar | Lokale meldingen; push alleen als wekker voor sync | Versleuteld, geen titel in push |
| Standard Notes / Notesnook | Herinneringen lokaal of via app-melding | Geen tijd op de server (lokaal) |

Positie: wie closed-app levert, geeft de server de tijd in klaartekst. Wij bieden als enige een
**gegrofde tijd (venster) met willekeurige id en een versleutelde melding-tekst**, en zeggen er ook bij wat
wél zichtbaar blijft. Dat is de wedstrijd: gelijke gemak, aantoonbaar minder metadata.

## 3. Versleutelde payload (optie B+)

Probleem: een service worker kan bij een gesloten app de kluissleutel niet gebruiken, en dat moet zo blijven.
Oplossing zonder de kluis te verzwakken:

- Bij het aanzetten maakt het apparaat een aparte **meldingssleutel** (AES-256-GCM, `extractable: false`,
  `CryptoKey` in IndexedDB). Die is niet afgeleid van het wachtwoord of de kluissleutel en geeft nergens
  toegang toe behalve tot meldingsteksten van dit apparaat.
- Per herinnering versleutelt de client `{titel, item-ref}` met die sleutel (vers 96-bit IV, padding naar
  vaste lengtes van 256 of 512 bytes) en uploadt `{id, window_start, blob}`.
- **Eenvoudigste variant, aanbevolen:** de blob wordt helemaal **niet** naar de server gestuurd. De tekst
  blijft versleuteld in de lokale IndexedDB onder de meldingssleutel; de push is leeg. De service worker
  zoekt bij een push de herinneringen met `window_start <= nu` lokaal op, ontsleutelt de tekst en toont die.
  De server ziet dus nooit tekst, ook geen ciphertext, en lengte lekt niet.
- Reisregel: de payload van de push zelf is leeg (of een vaste constante); Web Push versleutelt bovendien
  tussen server en browser (RFC 8291).
- Afweging: wie het apparaat in handen heeft zonder de kluis te ontgrendelen kan de meldingstitels lezen
  (ook op het vergrendelscherm). Daarom is "melding met tekst" een aparte schakelaar, standaard uit, en
  geeft de UI die waarschuwing. De kluis zelf blijft dicht.
- Als de lokale blob ontbreekt (opslag gewist): generieke tekst "Je hebt een herinnering".

## 4. Datamodel

Server (nieuwe tabel; exact deze kolommen, een extra kolom breekt de schema-test tot de claim is herzien):

| Kolom | Inhoud |
| --- | --- |
| `id` | 16 willekeurige bytes (`crypto.getRandomValues`), niet afgeleid van item of tijd |
| `user_id` | account (cascade bij verwijderen) |
| `device_id` | koppeling aan de bestaande push-abonnementsrij (cascade) |
| `window_start` | epoch-seconden, veelvoud van 900; server geeft 400 anders |
| `created_at` | uploadmoment (genoemd in de claim) |

Na verzending wordt de rij direct verwijderd; geen `sent_at`. Plafond per account (bv. 50 open vensters).
De bestaande tabellen `web_push_subscriptions` (endpoint, sleutels, max. 10) blijven zoals ze zijn.

Client (versleuteld, in het sync-schema of lokaal): per item een optioneel veld
`reminders: [{rid, at, push: bool}]` met de echte tijd `at`. De koppeling `rid <-> item` bestaat alleen in
het versleutelde item. Een nieuw veld in een versleuteld item raakt het sync-schema: veld optioneel, oude
clients negeren het, schemaversie ophogen (zie `docs/design/calendar-multi.md` voor de agenda-velden).
Lokaal (alleen IndexedDB, niet gesynct): meldingssleutel en de ontsleutelbare meldingstekst per `rid`.

## 5. Wat de server wel en niet ziet

Ziet: account, endpoint en pushsleutels van het apparaat, IP, uploadmoment, aantal herinneringen,
het 15-minutenvenster per herinnering. Ziet niet: titel, tekst, welk item, de exacte minuut, de
meldingssleutel. De pushdienst (Google, Apple, Mozilla) ziet dat er rond het venster een melding komt.
De volledige tabel per partij en de claimtekst staan in `PUSH_REMINDERS_DESIGN.md` §4 en §7 en gelden
ongewijzigd; de aanvulling "melding met tekst" verandert die tabel niet, omdat er niets extra de server
bereikt.

## 6. Risico's

| # | Risico | Mitigatie |
| --- | --- | --- |
| R1 | Gebruiker denkt dat push "volledig privé" is | Claimtekst letterlijk uit §7.2 van het push-document; tests op de claim |
| R2 | Titels leesbaar op vergrendelscherm / bij apparaatdiefstal | Aparte schakelaar standaard uit; waarschuwing; optie "alleen generieke tekst" |
| R3 | iOS: alleen PWA op beginscherm, lege pushes laten het abonnement vervallen | Elke push toont altijd een melding; geen stille cover traffic; hulptekst |
| R4 | Aflevering niet gegarandeerd (Doze, batterijbesparing) | "Best effort" in UI; missed-reminders bij openen |
| R5 | Dubbele melding (lokaal én push) | `tag` per `rid` in `showNotification` |
| R6 | Meldingssleutel lekt of wordt gewist | Niet-extraheerbaar; bij verlies generieke tekst; kluis ongemoeid |
| R7 | Nieuwe kolom lekt metadata ongemerkt | Schema-test met exacte kolomset; strikte allow-list op upload |
| R8 | Oude exact-tijdkanalen blijven bestaan naast B | Duidelijk gelabeld; eigenaar kiest uitfaseren (K5) |
| R9 | Logs/backups bevatten uploadtijd en venster | Retentiegetallen in `docs/PRIVACY.md` bevestigen |

## 7. Mijlpalen

1. **M1 Server**: tabel + endpoints (aanmaken, intrekken, uitzetten per apparaat), 900 s-validatie,
   verzenden met lege push en rij wissen, cascade en plafond. Tests: schema, 400 bij niet-veelvoud,
   geen logging van bodies.
2. **M2 Client en service worker**: toggle met toestemmingsflow, `push`-handler voor `data == null`,
   venster berekenen (naar beneden afronden), `tag` tegen duplicaten, test met gemockte `fetch` dat de
   exacte tijd nooit wordt verstuurd.
3. **M3 Melding met tekst**: meldingssleutel, lokale ontsleuteling in de service worker, fallback.
4. **M4 UI en teksten**: instellingenrij, uitleg, websitetekst, byte-identieke claim-test.
5. **M5 Apparaattest** op Android Chrome/Firefox, iOS-PWA, desktop (alle **verify**-punten), daarna pas
   de claim publiceren.

## 8. Keuzes voor de eigenaar

- K1 Optie B (venster, opt-in) goedkeuren met C als standaard? (Aanbevolen: ja.)
- K2 Venster van 15 minuten? (Aanbevolen: 15.)
- K3 "Melding met tekst" aanbieden (lokale ontsleuteling, §3), of alleen generieke tekst? (Aanbevolen:
  aanbieden, standaard uit.)
- K4 Accepteren dat account, endpoint, IP en aantal zichtbaar blijven en dat stille cover traffic niet kan.
- K5 Exact-tijdkanalen (e-mail en push) houden met label of uitfaseren zodra B bestaat.
- K6 iOS alleen via beginscherm acceptabel in de UI-tekst?
- K7 Retentiegetallen voor backups en logs bevestigen voor de claimtekst.
