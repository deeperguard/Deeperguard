# Agenda-sync: dataverlies tussen apparaten (taak #90)

Status: **gereproduceerd op main (v0.65.70), nog niet opgelost.** Dit document legt de
oorzaak vast. Productcode is in deze taak niet gewijzigd.

Melding: na synchronisatie zijn agenda-items niet zichtbaar op andere apparaten, de inhoud
raakt op alle apparaten kwijt en ook de import-links (URL's) van weblink-agenda's verdwijnen.

Reproductie: `tests/test_sync_agenda_two_devices.js`, in CI aangeroepen via
`tests/test_round60_client_integrity.py`:

- `test_sync_agenda_two_devices_known_bug`: slaagt zolang de bug reproduceert. Faalt met
  `UNEXPECTED PASS` zodra het verlies weg is; dan deze test en de marker hieronder opruimen.
- `test_sync_agenda_two_devices_contract`: strikte versie (`AGENDA_SYNC_STRICT=1`),
  gemarkeerd met `@unittest.expectedFailure`.

## 1. Datastroom

| Wat | Waar |
| --- | --- |
| Recordtype | Eén vault-item `agenda_pack` met vaste UUID `AGENDA_PACK_UUID = a6da67da-67da-4000-8000-000000000001` (`app/static/js/store.js:1788`). |
| Velden in het pakket | `type`, `version`, `events{id → agenda_event}`, `deleted_events{id → iso}` (tombstones, TTL 60 dagen, `store.js:2035`), `subscriptions{id → {id,name,url,mode,last_refresh,…,updated_at}}`, `deleted_subscriptions`, `calendars`, `created_at`, `updated_at`, plus `__fid`/`__fv` (freshness-versie, `freshness.js`). |
| Weblink-URL's | Staan **alleen** in `pack.content.subscriptions[*].url` (`store.js:2230`, `addAgendaSubscription` `store.js:2353-2377`). Niet in localStorage (`agenda-subscriptions.js:4` verbiedt dat zelfs). Ze delen dus het lot van het pakket. |
| Versleuteling | Het hele pakket wordt client-side versleuteld (`wrapItemForPush`, `store.js:3682`). De server ziet alleen `ciphertext`, `content_hash`, `updated_at`, `deleted` en `rev`. |
| Versie/tijd | Client: `item.updated_at` (seconden, klok van het apparaat) en `item.rev` (laatste server-revisie die het apparaat kent). Push stuurt `base_rev` **alleen als `item.rev` bekend is** (`store.js:3685`). Server: `rev` per item, `synced_at` als pull-cursor (`_plan_sync_item`, `app/db.py:1918-2014`). |
| Volgorde in `sync()` | Eerst `pushDirty` (`store.js:4551`), daarna pull. |

## 2. Oorzaak

Eén keten, die op een nieuw (of gewist) apparaat begint:

1. **Leeg pakket vóór de eerste pull.** Na `loadLocal` start `scheduleUnlockMaintenance`
   (`store.js:3039`). `runUnlockMaintenance` roept `ensureAgendaPack()` aan
   (`store.js:2485`). Op een apparaat zonder lokaal pakket maakt dat een **leeg** pakket
   (`store.js:1807-1810`, `defaultAgendaPack` `store.js:1790-1799`) via `upsert`: dirty, met
   `updated_at = nu` en **zonder `rev`** (`store.js:5393-5399`, dirty op `5404`).
   Hetzelfde gebeurt als de gebruiker een afspraak of abonnement toevoegt voordat de eerste
   pull klaar is (`upsertAgendaEvent` `store.js:1827`, `addAgendaSubscription` `store.js:2354`).
2. **Push zonder `base_rev`.** `sync()` pusht eerst (`store.js:4551`). Omdat `item.rev`
   ontbreekt, gaat de push zonder `base_rev` (`store.js:3685`).
3. **Server doet last-write-wins op het hele pakket.** Zonder `base_rev` valt
   `_plan_sync_item` terug op klokvergelijking (`app/db.py:1955-1972`): alleen als de
   inkomende `updated_at` *ouder* is volgt `stale`. Het lege pakket is "nu" en dus nieuwer:
   status `ok`, het serverpakket (met alle afspraken en abonnement-URL's) wordt
   **overschreven**. Er komt geen `conflict`, dus `mergeAgendaPacks` (`store.js:2053`,
   PR #356) draait nooit.
4. **Pull kiest ook op klok.** Komt het serverpakket binnen terwijl het lokale pakket geen
   `rev` heeft, dan beslist `localCopyWins` op `updated_at` (`store.js:3875-3885`, regel 3884): het
   jongere lokale (lege of kleine) pakket wint. Het pull-pad heeft geen agenda-merge (alleen
   notes, search_index en attachments, `store.js:3978-4028`); in de andere tak wordt het
   pakket in z'n geheel overgenomen (`store.js:4029-4043`, regel 4042).
5. **Andere apparaten nemen het verlies over.** Een schoon apparaat met een oudere `rev`
   neemt het nieuwe serverpakket over (`store.js:3880-3882`, daarna `store.js:4042`). Alleen de freshness-check
   (`freshness.js:206-218`) houdt dat tegen als het binnenkomende `__fv` lager is dan wat
   het apparaat al zag. Dat is toeval: in scenario 3 hieronder heeft B meer bewerkingen
   gedaan, is `__fv` hoger en verliest A alles.
6. **Elk nieuw apparaat herhaalt het.** Apparaat C (of A na wissen van sitegegevens of een
   herinstallatie) pusht opnieuw een leeg pakket zonder `base_rev` (zie `server pushes` in de
   uitvoer: rev 3, `base_rev: null`, apparaat C).

Weblink-URL's verdwijnen om precies dezelfde reden: ze staan alleen in het versleutelde
pakket (`subscriptions`), en dat pakket wordt in z'n geheel vervangen door een kopie
zonder `subscriptions`. Ze staan niet ergens anders (localStorage) waaruit ze terug kunnen
komen.

Bijkomend (niet nodig voor deze reproductie, wel hetzelfde patroon): in
`resolvePushConflict` wint voor onbekende itemtypes nog steeds de klok
(`store.js:3553`). Clients van vóór PR #356 doen dat ook voor `agenda_pack`.
Het idee-ticket vermoedde een verouderde client als oorzaak. Dat is mogelijk, maar
**ook de huidige client** verliest data, zie hierboven.

## 3. Reproductie (werkelijke uitvoer op main)

Elk apparaat draait in een eigen Node-proces met eigen IndexedDB-, meta- en
localStorage-stub (bewaard in een tijdelijke map) en de echte `store.js`, `crypto.js` en
`freshness.js`. De nep-server volgt de push-regels van `_plan_sync_item` in `app/db.py` (`rev`, `base_rev` →
`conflict`, zonder `base_rev` last-write-wins → `stale`). Elke stap wordt apart
gecontroleerd; een fout stopt het scenario niet.

```
scenario A-creates-then-B-syncs
  A after create+sync: events=["Dentist","Team lunch"] feeds=["https://calendar.example.org/team.ics"] dirty=0
  B after first sync: events=[] feeds=[] dirty=0  <-- DATA LOSS
  A after re-sync: events=["Dentist","Team lunch"] feeds=["https://calendar.example.org/team.ics"] dirty=0
  B after re-sync: events=[] feeds=[] dirty=0  <-- DATA LOSS
  C (fresh) after sync: events=[] feeds=[] dirty=0  <-- DATA LOSS
  server pushes: [{"uuid":"a6da67da-…0001","rev":1,"base_rev":null,"device":"A"},{"uuid":"a6da67da-…0001","rev":2,"base_rev":null,"device":"B"},{"uuid":"a6da67da-…0001","rev":3,"base_rev":null,"device":"C"}]
scenario B-first-empty-then-A
  A after create+sync: events=["Dentist","Team lunch"] feeds=["https://calendar.example.org/team.ics"] dirty=0
  B after sync: events=["Dentist","Team lunch"] feeds=["https://calendar.example.org/team.ics"] dirty=0
  A after re-sync: events=["Dentist","Team lunch"] feeds=["https://calendar.example.org/team.ics"] dirty=0
  C (fresh) after sync: events=[] feeds=[] dirty=0  <-- DATA LOSS
  server pushes: [{…"rev":1,"base_rev":null,"device":"B"},{…"rev":2,"base_rev":null,"device":"A"},{…"rev":3,"base_rev":null,"device":"C"}]
scenario A-creates-B-adds-offline-then-syncs
  B after first sync: events=["B: dinner","B: gym","B: school","B: train"] feeds=[] dirty=0  <-- DATA LOSS
  A after re-sync: events=["B: dinner","B: gym","B: school","B: train"] feeds=[] dirty=0  <-- DATA LOSS
  C (fresh) after sync: events=[] feeds=[] dirty=0  <-- DATA LOSS
  server pushes: [{…"rev":1,"base_rev":null,"device":"A"},{…"rev":2,"base_rev":null,"device":"B"},{…"rev":3,"base_rev":null,"device":"C"}]
agenda two devices: 14 data-loss findings
agenda two devices: KNOWN BUG reproduced (docs/AGENDA_SYNC_BUG.md)
```

(De UUID's zijn hier ingekort. Draai `node tests/test_sync_agenda_two_devices.js` voor de
volledige uitvoer.)

Wat dit laat zien:

- Scenario 1: B ziet niets. A houdt z'n lokale kopie alleen dankzij de freshness-check,
  maar het serverpakket is leeg (C ziet niets).
- Scenario 2 (B eerst leeg, dan A): A wint hier toevallig op klok, maar C overschrijft
  daarna alsnog met een leeg pakket.
- Scenario 3: B voegt zelf iets toe vóór de eerste sync. Daarna zijn A's afspraken én de
  weblink-URL **op alle apparaten** weg. Dit is precies de melding.

## 4. Reparatievoorstel (zero-knowledge blijft intact)

Uitgangspunten: geen plaintext naar de server, verwijderen alleen via tombstones
(`deleted_events`, `deleted_subscriptions`, `deleted_calendars`), en nooit blind
last-write-wins over het hele pakket.

1. **Geen pakket vóór de eerste pull.** `ensureAgendaPack` mag geen dirty pakket maken
   zolang deze vault nog geen volledige pull heeft gedaan (`lastSync == 0`). Gebruik dan
   een lokaal, niet-dirty pakket (`skipDirty`), of bewaar bewerkingen in een wachtrij die
   na de pull via `mergeAgendaPacks` op het serverpakket wordt toegepast. Haal
   `ensureAgendaPack` uit `runUnlockMaintenance` (`store.js:2485`); lezen werkt ook zonder
   pakket (`listAgendaEvents` geeft dan `[]`).
2. **Agendapakket altijd met `base_rev`.** Een `agenda_pack` zonder bekende `rev` pusht
   met `base_rev: 0` ("ik ken geen serverversie"). De server geeft dan `conflict` +
   `server_item` als er al een rij is (`app/db.py:1955-1962` doet dat al voor elke
   `base_rev != existing_rev`), en de client voegt samen met `mergeAgendaPacks`
   (`store.js:3539-3545`). De server leest daarbij niets van de inhoud.
3. **Samenvoegen ook bij pull.** In `applySyncPayload` (`store.js:3978`) krijgt
   `agenda_pack` dezelfde behandeling als `search_index`: lokaal dirty of zonder `rev`, dan
   `mergeAgendaPacks(local, remote)`, lokaal dirty laten en opnieuw pushen. Nooit het hele
   pakket op klok kiezen (`localCopyWins`, `store.js:3884`).
4. **Krimp-vangnet in de client.** Vóór een push van `agenda_pack`: verdwijnen er
   `events`, `subscriptions` of `calendars` ten opzichte van het laatst bekende serverpakket
   zonder bijbehorende tombstone, dan eerst het serverpakket ophalen (`refetchSyncItems`)
   en samenvoegen in plaats van pushen. Verwijderen gebeurt alleen via een tombstone; een
   ontbrekende sleutel betekent "onbekend", niet "verwijderd".
5. **Server weigert pushes zonder `base_rev` van oude clients.** Een push zonder `base_rev`
   valt nu terug op last-write-wins (`app/db.py:1967-1972`). Voorstel: de client stuurt zijn
   release-tag mee; de server antwoordt `update_required` op pushes onder een minimumversie
   of zonder `base_rev`, op basis van alleen metadata (UUID, aanwezigheid van `base_rev`).
   De client toont dan een verplichte updatemelding en pusht niets. Zo kan een verouderde
   client (vóór PR #356) het pakket niet meer wegschrijven.
6. **Tests.** Haal de `expectedFailure`-marker en `test_sync_agenda_two_devices_known_bug`
   weg uit `tests/test_round60_client_integrity.py` zodra alle drie scenario's slagen. Voeg
   een scenario toe met een verwijdering op A (tombstone) die op B en C moet doorkomen.

Herstel van al verloren data valt buiten deze taak (volgens de eigenaar niet nodig).
Apparaten die nog een volle lokale kopie hebben (zoals A in scenario 1) zetten die met
punt 2 en 3 bij hun volgende bewerking via een merge terug op de server.
