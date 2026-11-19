# pCloud-back-up zonder leesbaar geheim op de server (ontwerp, idee #108)

Status: **voorstel, wacht op keuzes van de eigenaar** (§7). Dit document verandert geen code.
De bouwtaken (§6) hangen hiervan af.

Doel: de geplande pCloud-back-up in Pro blijft bestaan, maar de server bewaart geen geheim
waarmee het pCloud-account van de gebruiker te openen is, of zo weinig mogelijk daarvan. Het
zero-knowledge-model voor notities verandert niet: de back-up bevat alleen versleutelde items.

Dit document claimt geen audit. Het is een ontwerp; een onafhankelijke audit staat apart op de
roadmap en is niet gedaan.

## 1. Huidige toestand (gecontroleerd in de code)

**Het wachtwoord zelf wordt al niet meer bewaard.** De taakomschrijving (en het auditdocument
`docs/security-audit-2026-10-28.md` regels 6, 14, 24) beschrijft nog de oude toestand met
`keys/pcloud-password-*`. In de code van nu:

- `save_pcloud_settings` weigert een wachtwoord met een fout: `app/backup_pcloud.py:273-300`.
  De route geeft dan een generieke 400: `app/app.py:3393-3429`.
- `pcloud_password_set` geeft altijd `False`: `app/config.py:446`.
- Oude `pcloud-password-*`- en `pcloud-rclone-*.conf`-bestanden worden verwijderd bij opslaan
  (`pcloud_credentials.migrate_user_pcloud_secrets`), bij het opstarten (`app/app.py:4765`) en
  aan het begin van elke run (`run_pcloud_backups`, `app/backup_pcloud.py:312`). Zie
  `app/pcloud_credentials.py:84-161`. Let op: dit stopt stil als de sleutel
  `NOTES_PCLOUD_CREDENTIALS_KEY` niet gezet is (`migrate_all_pcloud_secrets`, `app/pcloud_credentials.py:137-141`).
- De aanwijzing in `docs/PCLOUD_CREDENTIALS_MIGRATION.md` (operatorstappen, gebruikers mailen,
  sleutelrotatie) bestaat al.

**Wat er nog wel staat is een bewaard OAuth-token dat de server zelf kan ontsleutelen:**

| Wat | Waar | Opmerking |
|---|---|---|
| rclone-OAuth-token (JSON met `access_token`) | `keys/pcloud-token-<user_id>`, geschreven door `write_pcloud_token` (`app/config.py:414-427`), geladen door `pcloud_token` (`app/config.py:430-439`) | AES-256-GCM, envelop `dg-pcloud-v1:` (`app/pcloud_credentials.py:19`, `:56-77`), bestandsmodus 0600 |
| Sleutel | omgevingsvariabele `NOTES_PCLOUD_CREDENTIALS_KEY` (`app/pcloud_credentials.py:20`, `:38-41`), voorbeeld in `deploy/deeperguard.env.example:85` | Buiten de database en buiten `keys/`, maar op dezelfde server als het proces dat hem leest |
| Token in het rclone-proces | `rclone_remote_env` (`app/backup_pcloud.py:106-119`) zet `RCLONE_CONFIG_DEEPERGUARD_TOKEN` in de omgeving van het kindproces; `--config` is `os.devnull` (`:122-134`) | Geen configbestand op schijf; wel zichtbaar voor root en voor het proces zolang rclone draait (tot de time-out uit `NOTES_PCLOUD_RCLONE_TIMEOUT`, standaard 7200 s, `app/backup_pcloud.py:27`). Let op: `deploy/deeperguard.env.example:87` toont `NOTES_PCLOUD_RCLONE_TIMEOUT=3600` als uitgecommentarieerd voorbeeld. Dat is niet de standaard; de standaard in de code is 7200 s. Het voorbeeld corrigeren is een aparte opruimtaak (deploy/ valt buiten dit ontwerp) |
| Metadata | tabel `users`: `pcloud_enabled`, `pcloud_username`, `pcloud_remote_path`, `pcloud_region`, `pcloud_last_sync_*` (`app/db.py:178-203`) | Niet geheim, wel gegevens over de gebruiker |
| Plan-poort | `_plan_block(user, "pcloud_backup")` bij inschakelen (`app/app.py:3407`), plan `app/plans.py:119` | Alleen Pro |

**Back-upjob.** `deploy/cron/deeperguard-backup` draait `app/backup_cron.py`. `run_backups`
(`:25-46`) neemt de `maintenance_lock`, doet eerst pCloud (`run_pcloud_backups`), dan de beheerde
service-pCloud (`run_managed_backups`), dan e-mail. Per gebruiker met `pcloud_enabled` roept
`run_pcloud_backups` (`app/backup_pcloud.py:312-339`) `sync_user_backup` aan (`:217-270`): het
streamt of hergebruikt de lokale versleutelde back-up (`ensure_local_full_backup`,
`app/backup_mail.py:62`), laat `rclone copy` uploaden, snoeit oude bestanden
(`PCLOUD_RETENTION_DAYS`, standaard 7) en schrijft status in `users` en `backup_log`. Bij een
fout gaat er een e-mail (`notify_pcloud_backup_failure`, `:87-103`). Handmatig:
`POST /api/backup/pcloud/sync` (`app/app.py:3518-3536`). De cron draait zonder gebruiker, dus de
server **moet** het token zelf kunnen ontsleutelen. Dat is de kern van het resterende gat.

**Logs.** `_format_rclone_error` (`app/backup_pcloud.py:153-169`) geeft rclone-uitvoer door,
afgekapt op 500 tekens, en vervangt bekende fouten door vaste tekst. Het token wordt niet
bewust gelogd, maar rclone-stderr is niet gegarandeerd vrij van het token; dat is niet
gecontroleerd voor alle foutpaden. De fout komt in `users.pcloud_last_sync_detail` en in de
foutmail.

**Parallel pad: beheerde service-pCloud** (`docs/MANAGED_PCLOUD_BACKUP.md`). Daar gebruikt de
gebruiker geen eigen pCloud; de server schrijft naar een eigen service-account. Het token staat
versleuteld in tabel `pcloud_service_token` (`app/db.py:138`) met een sleutelbestand in
`KEYS_DIR` (`app/pcloud_service_token.py:1-30`). Dat is een server-geheim van de operator, niet
van de gebruiker, en valt buiten dit ontwerp.

**Controle tegen de draaiende code.** Ik heb de bestaande tests gedraaid:
`tests/test_pcloud_credentials.py` en `tests/test_no_readable_backup_secret.py` (11 geslaagd).
Een volledige run met een lokale server en een echt pCloud-account is **niet** gedaan; de
omgeving heeft geen pCloud-account en geen rclone-toegang tot pCloud. Bevindingen hierboven
komen dus uit code en tests, niet uit een live upload.

**Vervolgtaak (nog open, niet gedaan):** met een testaccount een echte run doen: lokale server,
pCloud koppelen, `POST /api/backup/pcloud/sync` draaien en daarna per punt vastleggen (datum,
versie, uitkomst):

- of het token voorkomt in rclone-stderr bij een geslaagde run, bij een 401- of 409-fout en bij een
  time-out. `_format_rclone_error` (`app/backup_pcloud.py:153-169`) geeft stderr tot 500 tekens door
  aan `pcloud_last_sync_detail` (`app/db.py:2465`) en aan de foutmail (`:87-103`);
- of rclone bij een uitgebreide logmodus (`-vv`) of bij een fout het token afdrukt;
- of het token tijdens de run leesbaar is in de omgeving van het rclone-kindproces
  (`/proc/<pid>/environ`, alleen voor root en de eigenaar van het proces).

Tot die run is gedaan geldt: het token in rclone-uitvoer is **niet gecontroleerd**.

**Het echte resterende gat, kort:**

1. Het bewaarde token is een rclone-OAuth-token. Volgens modelkennis (niet in de repo
   geverifieerd) geeft `rclone authorize pcloud` toegang tot het hele pCloud-account, niet tot een
   app-map. Een gestolen token opent dus alle bestanden van de gebruiker, niet alleen de back-ups.
2. Sleutel en ciphertext staan op één machine; wie de server overneemt, heeft beide.
3. De gebruiker moet `rclone` lokaal draaien en JSON plakken; dat is voor niet-technische
   gebruikers een drempel en leidt tot het plakken van een breed token.
4. Het auditdocument en `SECURITY.md` beschrijven het oude wachtwoordrisico nog als open; die
   tekst loopt achter op de code (review-taak, §6).

## 2. Opties

### Optie A: OAuth-token met alleen app-maptoegang, versleuteld met een sleutel uit de omgeving

- Deeperguard registreert één OAuth-app bij pCloud, geconfigureerd voor toegang tot alleen een
  eigen app-map (te bevestigen bij registratie: of pCloud dit per app aanbiedt en hoe het heet
  is modelkennis, niet geverifieerd).
- De gebruiker klikt "Koppel pCloud", doorloopt pCloud's toestemmingsscherm, en Deeperguard
  ontvangt een token. Geen rclone op de computer van de gebruiker, geen wachtwoord, geen JSON plakken.
- De server bewaart alleen dat token, AES-256-GCM, met een sleutel uit de omgeving (bestaande
  `pcloud_credentials.py`). Het wachtwoord van de gebruiker raakt de server nooit.
- De geplande job blijft zoals nu werken (rclone met het token, of directe API-aanroepen).

### Optie B: alleen back-ups vanuit de ontgrendelde browser

- De browser heeft de kluis ontgrendeld, haalt de versleutelde back-up op en uploadt zelf naar
  pCloud (patroon: de bestaande in-browser cloudback-up, zie `docs/design/security-fixes-82.md`
  §2.1 voor de eerder voorgestelde vorm). Het token staat alleen in de browser van de gebruiker
  (lokale opslag, bij voorkeur versleuteld met de kluissleutel).
- Geen server-geheim, geen planning zonder open sessie. Dichtgeklapte laptop = geen back-up.
- Browser-CORS en pCloud-API-beperkingen kunnen een doorgeefproxy nodig maken. Die mag het
  token niet bewaren of loggen; dat moet getest worden voor het gebouwd wordt.

### Optie C: A en B als keuze voor de gebruiker

- Instellingen tonen twee modi: "Automatisch (server, token met app-maptoegang)" en "Alleen vanuit
  mijn browser (geen server-geheim)". De standaard is een keuze van de eigenaar (§7).
- Kost de meeste bouw- en testtijd: beide paden, twee statussen in de UI, één migratie.

## 3. Wat de server ziet en wat niet, en de risico's

| | A | B | C (A-modus / B-modus) |
|---|---|---|---|
| Server ziet | versleutelde back-up, tijdstip, grootte, pCloud-gebruikersnaam en -pad, **het token in geheugen tijdens een run** | versleutelde back-up wanneer de browser die ophaalt; geen pCloud-gegevens, tenzij een proxy ze doorgeeft | als A / als B |
| Server ziet niet | pCloud-wachtwoord, notitie-inhoud, kluissleutel | pCloud-token, pCloud-wachtwoord, notitie-inhoud, kluissleutel | idem |
| Server bewaart | token (versleuteld) + sleutel in env | niets | token alleen bij A-modus |
| Planning zonder gebruiker | ja | nee | alleen A-modus |

**Gestolen database.** A: bevat geen token (staat in `keys/`) en de sleutel staat in env; de DB
alleen levert gebruikersnaam, pad en status. B: niets om te stelen. Nu (huidige toestand): idem,
want het token staat niet in de DB.

**Gestolen server (root, schijf plus env of proces).** A: aanvaller kan het token ontsleutelen en
de app-map van elke gebruiker lezen en wissen, maar niet de rest van hun pCloud en niet de notities
(alleen ciphertext, kluissleutel nooit op de server). Dat is een echte verbetering ten opzichte van
een token met toegang tot het hele account. Huidig: dezelfde aanval opent het hele pCloud van
elke gebruiker. B: de server heeft niets; de aanvaller kan alleen de ciphertext-back-ups uit de
Deeperguard-opslag zelf nemen.

**Gestolen browser/apparaat.** B: het token op dat apparaat is bruikbaar. Mitigatie: token
versleutelen met de kluissleutel zodat het alleen bij ontgrendelde kluis leesbaar is, en
herroepen (hieronder).

**Intrekken.** A: de gebruiker trekt toegang in via de pCloud-accountinstellingen; Deeperguard
meldt bij de volgende run `auth`-fout en zet de verbinding op "opnieuw koppelen". Ook moet
Deeperguard zelf een "Ontkoppel"-knop hebben die het token wist. B: ontkoppelen wist het lokale
token; herroepen aan pCloud-zijde werkt hetzelfde. Sleutelrotatie van `NOTES_PCLOUD_CREDENTIALS_KEY`
maakt alle opgeslagen tokens onleesbaar; dat is de bestaande "opnieuw koppelen"-route
(`docs/PCLOUD_CREDENTIALS_MIGRATION.md`, sectie Key rotation).

**Restrisico's A:** sleutel en ciphertext op één machine; token tijdens de run in de
proces-omgeving; pCloud kan app-maptoegang anders implementeren dan hier aangenomen.

## 4. Aanbeveling en vergelijking

**Aanbeveling: A nu, B als latere optie (dus C in twee stappen).** A bewaart wat de eigenaar wil
(geplande back-ups in Pro) en verkleint de schade van een gestolen server van "hele pCloud" tot
"alleen de back-upmap". B is de sterkste privacy-keuze maar levert geen echte planning en is bij
het beoogde gebruik (stille dagelijkse back-up) een duidelijke achteruitgang; als aanvullende optie
voor wie geen server-geheim wil, is het waardevol.

**Vergelijking met anderen. Alles in deze paragraaf is modelkennis, niet in deze repo of live
nagelezen; controleer het voordat het in marketingtekst komt.**

- **Proton:** voor zover bekend geen eigen back-up naar een door de gebruiker gekozen externe cloud
  vanuit de server; export gaat via de client of een export-tool op de eigen computer.
- **Ente:** exports lopen via de desktop-app of CLI op de computer van de gebruiker (lokale map);
  planning is dus aan de gebruiker en de server heeft geen toegang tot de externe bestemming.
- **Standard Notes:** back-ups via de client/desktop-app (lokaal of naar een eigen cloudmap), en
  een e-mailback-up als betaalde functie; ook daar komt het cloudtoken bij de client te liggen.

Lezing: de concurrenten kiezen in de praktijk voor B (client-kant), omdat dat geen server-geheim
oplevert. Wie beter wil zijn, biedt A met een smal token én B als keuze, en laat in Instellingen
eerlijk zien welke modus welk risico draagt.

## 5. Migratie

Wat er al gebeurt: wachtwoordbestanden en rclone-configs worden verwijderd (§1); tokenbestanden
zonder envelop worden versleuteld (`migrate_token_file`, `app/pcloud_credentials.py:117-128`).

Wat nog nodig is, afhankelijk van optie:

1. **Wachtwoorden wissen:** bevestigen dat er geen `keys/pcloud-password-*` of
   `keys/pcloud-rclone-*.conf` meer staat (operatorcheck in de uitrolnotitie), en de sleutel
   `NOTES_PCLOUD_CREDENTIALS_KEY` verplicht zetten in productie (nu stopt de opruiming stil zonder).
2. **Oude brede tokens uitfaseren (A of C):** na uitrol van de nieuwe OAuth-koppeling alle
   `keys/pcloud-token-*` overschrijven en wissen, `pcloud_enabled` laten staan maar de verbinding
   op status "opnieuw koppelen" zetten (nieuwe waarde voor `pcloud_last_sync_status`, geen
   nieuwe kolom nodig). De run slaat zulke gebruikers over zonder foutmail-storm: één mail.
3. **Gebruiker ziet het:** banner in Instellingen → pCloud-back-up ("Koppel opnieuw; het oude
   token wordt niet meer gebruikt") en een eenmalige e-mail naar `backup_email`/`email`
   (zelfde ontvangerlogica als `pcloud_failure_recipient`, `app/backup_pcloud.py:83`). De mail
   vraagt ook het oude rclone-token en eventueel het pCloud-wachtwoord te herroepen/wijzigen;
   zie `docs/PCLOUD_CREDENTIALS_MIGRATION.md` stap 7.
4. **Melden:** changelog en `SECURITY.md` bijwerken; auditdocument corrigeren dat H-PCLOUD in
   de vorm "wachtwoord leesbaar" niet meer geldt en wat er nog resteert.
5. **B:** geen serverdata om te migreren; gebruikers die B kiezen wissen hun serverkant via
   "Ontkoppel".
6. **Terugdraaien:** de oude route blijft tot na een volledige run bestaan; per gebruiker kan het
   oude token pas gewist worden als de nieuwe koppeling een succesvolle run heeft gehad.

Randgevallen: gebruiker met `pcloud_enabled` maar zonder token (staat nu al als fout in
`run_pcloud_backups`); gebruiker op het beheerde service-pad (die wordt overgeslagen, `app/backup_pcloud.py:321`);
sleutel ontbreekt; dubbel koppelen (idempotent: laatste token wint).

## 6. Mijlpalen (passen bij de vervolgtaken)

1. **Backend OAuth:** pCloud-OAuth-app registreren (§7), start- en callback-route voor "Koppel
   pCloud", `state` en CSRF-controle, token versleuteld opslaan met bestaande `encrypt_at_rest`,
   ontkoppel-route, geen token in logs of foutteksten. Tests met een nep-pCloud-server.
2. **Back-upjob:** `run_pcloud_backups` en `sync_user_backup` laten werken met het nieuwe token,
   `auth`-fout → status "opnieuw koppelen", token-vrije foutafhandeling in `_format_rclone_error`.
3. **Migratie:** §5 uitvoeren (statusovergang, eenmalige mail, wissen oude tokens), met test voor
   herhaald draaien (twee keer is niets nieuws).
4. **Instellingen-UI:** "Koppel pCloud"-knop, status (verbonden / opnieuw koppelen / niet
   gekoppeld), ontkoppelen, uitleg wat de server wel/niet ziet; toetsenbord, focus, donker/licht,
   telefoonbreedte; vervangt het plakveld voor rclone-JSON. Bij C: moduskeuze en B-pad.
5. **Review-doc:** `SECURITY.md`, `docs/security-audit-2026-10-28.md` en
   `docs/PCLOUD_CREDENTIALS_MIGRATION.md` bijwerken; geen auditclaim zolang er geen
   onafhankelijke audit is.

## 7. Keuzes voor de eigenaar

1. **Optie A, B of C?** Aanbeveling: A nu, B later (zie §4). Gevolg bij B alleen: geen
   onbewaakte dagelijkse upload.
2. **Wie registreert de pCloud-OAuth-app en onder welk account?** Dit is een operatoractie bij
   pCloud (redirect-URL, app-maptoegang aanzetten, client-id en geheim in `deeperguard.env`
   zetten). Zonder die registratie kan A en C niet gebouwd worden. Voorstel: de eigenaar doet
   het onder een zakelijk pCloud-account en niet onder een persoonlijk account.
3. **Wat te doen met bestaande tokens:** hard afkappen op een datum (voorstel), of een
   overgangsperiode waarin het oude token blijft werken?
4. **Bij C: welke modus is de standaard?** Voorstel: A, met B duidelijk zichtbaar.
5. **Moet `NOTES_PCLOUD_CREDENTIALS_KEY` verplicht worden** (app start niet zonder) in plaats van
   stil niets doen?
