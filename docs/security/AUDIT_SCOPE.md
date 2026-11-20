# Auditomvang: wat een onafhankelijke audit zou moeten dekken

Datum: 2026-11-20. Basis: de code op branch `bot/task-421-close-pcloud-risk-in-security-review-doc`
(na `33ee676`). Bestanden en regelnummers zijn van die versie; ze verschuiven bij wijzigingen.

> **Er is GEEN onafhankelijke audit uitgevoerd.** Er is nog geen onafhankelijke beveiligingsaudit
> gedaan, en er is er ook geen gepubliceerd. Dit document beschrijft alleen waarop een audit zich
> zou moeten richten. Het is geen auditrapport, geen certificering en geen bewijs dat de app veilig is.

De interne code-review van 2026-10-28 ([security-audit-2026-10-28.md](../security-audit-2026-10-28.md))
is door de eigenaar en de ontwikkelaars gedaan, en is **geen** onafhankelijke audit. Dat geldt ook
voor de tests in de repository: die bewijzen gedrag van de code, geen ontwerp of implementatie door een
derde partij.

## 1. Wat een audit zou moeten dekken

Per onderdeel: wat de code doet, wat een auditor moet nagaan, welke bestaande tests erbij horen (alleen
als aanknopingspunt; de dekking is nog niet door een auditor beoordeeld), en de open vragen.

### 1.1 SRP-6a: inloggen zonder dat het wachtwoord de server bereikt

- **Code:** server-kant in `app/srp_auth.py` (SRP-6a, SHA-256, RFC 5054 2048-bit, zie regels 1-6).
  Routes: `api_auth_srp_challenge` (`app/app.py:1257`), `api_auth_srp_verify` (`app/app.py:1290`),
  KDF-upgrade (`app/app.py:1326`, `:1351`), opslag van de verifier in `app/db.py:632` (`create_user_srp`).
- **Wat te controleren:**
  - Verifierversies: v1 (SHA-256, legacy) wordt nog geaccepteerd; v2 gebruikt Argon2id
    (`app/srp_auth.py:5`). Is er een pad waarop een zwakke v1-verifier kan blijven bestaan?
  - Argon2id voor de SRP-verifier gebruikt andere parameters dan de kluis (`SRP_ARGON2_PARAMS`,
    `app/srp_auth.py:35-40`: t=2, 19 MiB, p=1; kluis: t=3, 64 MiB, p=2). Dat is bewust gekozen voor
    inloggen op telefoons (commentaar regel 35). De auditor moet beoordelen of dat voldoende is.
  - Degenerate waarden (A=0, lege of ongeldige M1): de client- en servercontroles.
  - Het legacy-pad: `password_hash` bestaat nog op accounts met SRP (zie open punten).
- **Bestaande tests:** `tests/test_srp_auth.py`, `tests/test_srp_server_challenge.py`,
  `tests/test_srp_kdf_upgrade.py`, `tests/test_srp_m2_e2e.js`, `tests/test_srp_login_requires_m2.js`,
  `tests/test_srp_client_degenerate.js`, `tests/test_round73_srp_no_plaintext.py`.

### 1.2 Argon2id: van wachtwoord naar kluissleutel

- **Code:** de client leidt de kluissleutel af met Argon2id, t=3, m=65536 KiB (64 MiB), p=2, 32 bytes:
  `app/static/js/crypto-worker.js:6` (en `app/static/js/crypto.js:4`). Op de server staan dezelfde
  waarden in `app/vault_crypto.py:14` voor de controle van het wachtwoord tegen voorbeeldversleutelde
  notities. Die controle wordt alleen uitgevoerd op de paden die hieronder bij open punten staan.
- **Wat te controleren:**
  - Zijn de parameters adequaat voor de bedreiging, en zijn ze overal gelijk waar de kluissleutel
    wordt afgeleid (client, `vault_crypto.py`, en de KDF-versie in de database)?
  - Het ontgrendelen rekent altijd opnieuw met Argon2id: `app/static/js/app.js:10344` hergebruikt geen
    eerder afgeleide sleutel.
  - Oude KDF-versies (v1) en het upgradepad.
- **Bestaande tests:** `tests/test_crypto.js`, `tests/test_recovery_key_crypto.js`,
  `tests/test_srp_kdf_upgrade.py`.

### 1.3 AES-GCM: versleuteling van notities, agenda, instellingen en tokens

- **Code:** client-kant `encryptObject` (`app/static/js/crypto.js:114`) met een willekeurige IV van
  12 bytes uit `crypto.getRandomValues` (`randomIv`, `app/static/js/crypto.js:105-112`). Als die
  functie ontbreekt, faalt de code (sinds de review van 2026-10-28; dat was het `Math.random`-pad).
  Instellingen-record: `app/static/js/settings-sync.js`, beschreven in [SECURITY.md](../../SECURITY.md).
  Server-kant voor het pCloud-token: `app/pcloud_credentials.py:55-77` (`encrypt_at_rest`,
  `decrypt_at_rest`, envelop `dg-pcloud-v1:`).
- **Wat te controleren:**
  - IV-uniciteit over alle apparaten en alle schrijfacties; sleutelgebruik per record.
  - Gebonden associated data (type en account) bij alle AES-GCM-aanroepen, zoals in `crypto.js:145`.
  - De sleutel is een JavaScript-bytearray, geen niet-exporteerbare `CryptoKey` (zie
    [SECURITY.md](../../SECURITY.md), "Key type"). Een auditor moet de gevolgen daarvan beoordelen.
  - De sleutel voor het server-geheim (`NOTES_PCLOUD_CREDENTIALS_KEY`) en de bestandsrechten.
- **Bestaande tests:** `tests/test_crypto.js`, `tests/test_settings_sync.js`,
  `tests/test_no_readable_backup_secret.py`.

### 1.4 Sync: de server ziet alleen ciphertext

- **Code:** routes `app/app.py:3851` (watermark), `:3897` (blobs), `:4003` (items), `:4029` (pull),
  `:4057` (push). Opslag van ciphertext en hashes in `app/db.py` (`upsert_items_batch` regel 2839,
  `list_items_by_uuid` regel 2987). Syncloggegevens zijn alleen tellingen en metadata:
  `_sync_log_line` (`app/app.py:987`).
- **Wat te controleren:**
  - Isolatie tussen gebruikers: elke lees- en schrijfactie gaat via de `uid` uit de sessie.
  - Terugrol-detectie: de client houdt hoge watermerken bij (zie `/verify`, `app/templates/verify.html`).
  - Welke metadata de server ziet (tijdstippen, groottes, hashes, item-id's, IP-adres); dat staat
    beschreven in `app/templates/verify.html` en in [SECURITY.md](../../SECURITY.md).
  - Gedeeltelijke pushes, herhaalde pushes en conflicten.
- **Bestaande tests:** `tests/test_sync_*.js` (onder andere `test_sync_rev_conflicts.js`,
  `test_sync_retry_idempotency.py`), `tests/test_sync_cursor.py`, `tests/test_sync_push_partial.py`,
  `tests/test_sync_log.js`.

### 1.5 Back-ups (e-mail, lokaal, pCloud, beheerde service-pCloud)

- **Lokale volledige back-up op de server:** `write_local_full_backup_streaming`
  (`app/backup_mail.py:72-100`) schrijft items uit `db.iter_backup_items` (`app/db.py:3319`). Die
  selecteert `ciphertext` en `blob_ciphertext`. Het bestand bevat ook `user_email`, `kdf_salt` en de
  exporttijd als platte tekst. Een auditor moet beoordelen of dat acceptabel is.
- **E-mailback-up:** `send_user_backup` (`app/backup_mail.py:265`) mailt het bestand uit de
  lokale back-up hierboven; de items in dat bestand zijn ciphertext.
- **Versleutelde back-up in de browser:** `app/static/js/cloud-backup.js` en `buildLocalBackup`
  (`app/static/js/app.js`, zie `docs/IMPORT_EXPORT_SPEC.md`).
- **pCloud van de gebruiker:** `app/backup_pcloud.py`, `app/pcloud_oauth.py`, opslag van het token in
  `app/config.py:414-439` (`write_pcloud_token`, `pcloud_token`). Het wachtwoord wordt niet meer
  geaccepteerd of opgeslagen (zie [security-audit-2026-10-28.md](../security-audit-2026-10-28.md),
  "Status update").
- **Beheerde service-pCloud:** `docs/MANAGED_PCLOUD_BACKUP.md`, `app/pcloud_service_token.py`. Het
  sleutelbestand staat in `KEYS_DIR`, op dezelfde server.
- **Wat te controleren:**
  - Het pCloud-token: welk bereik het heeft, en of het in rclone-uitvoer of logs kan belanden
    (`_format_rclone_error`, `app/backup_pcloud.py:245-261`, nog niet live gecontroleerd).
  - Retentie en opruiming, en of een back-up van een verwijderde notitie verdwijnt (zie
    `docs/DELETE_SPEC.md`).
  - Herstel: kan een gebruiker met alleen het wachtwoord de back-up openen?
- **Bestaande tests:** `tests/test_backup.py`, `tests/test_backup_mail.py`,
  `tests/test_cloud_backup.js`, `tests/test_managed_backup_run.py`, `tests/test_pcloud_credentials.py`,
  `tests/test_pcloud_password_migration.py`, `tests/test_no_readable_backup_secret.py`.

### 1.6 OCR op het apparaat

- **Code:** de OCR draait in de browser. `app/static/js/client-ocr-engine.js` (regel 2-3): "documents
  are decrypted and processed only in the browser … nothing is sent to the server for OCR". Tesseract.js
  (WebAssembly) en de taalbestanden `nld` en `eng` staan lokaal in `app/static/js/vendor/tesseract/`.
  Voorbewerking: `app/static/js/photo-ocr-preprocess.js`.
- **Legacy server-OCR:** `api_ocr` (`app/app.py:3651-3652`) verwerkt het document op de server. Dat staat
  alleen aan met `NOTES_SERVER_OCR=1` (`app/config.py:100-102`, standaard `0`). In dat geval ziet de server
  de platte tekst.
- **Wat te controleren:**
  - Dat `NOTES_SERVER_OCR` op productie uit staat (`deploy/PRODUCTION.md`) en dat de route geen
    tijdelijke bestanden achterlaat (`ocr_ephemeral`, `app/config.py`).
  - Of de meegeleverde Tesseract- en pdf.js-bestanden overeenkomen met de vermelde versies en bron
    ([docs/THIRD_PARTY.md](../THIRD_PARTY.md)).
  - Of de OCR-tekst in de zoekindex en in de cache van de app terechtkomt, en of die bij vergrendelen
    wordt gewist.
- **Bestaande tests:** `tests/test_client_ocr_engine.js`, `tests/test_ocr_quality.js`,
  `tests/test_photo_ocr_quality.py`, `tests/test_rescan_ocr.js`.

### 1.7 Overige onderdelen die in een audit horen

- Sessies, CSRF en herkomstcontrole (`app/auth.py`: `csrf_ok`, `request_is_same_origin`).
- Vergrendelen en geheugen in de browser (zie [SECURITY.md](../../SECURITY.md), "Locking the vault").
- Secure Send: de sleutel staat in het fragment van de URL (`app/secure_send.py`,
  `app/static/js/secure-send.js`).
- Agenda-abonnementen en de relay (`docs/ICS_SUBSCRIBE_SPEC.md`), Ask AI (`app/ai_relay.py`).
- Client-integriteit: `app/static/js/release-integrity.js`, `/verify`. Een controle van de app-bestanden
  die de browser laadt, is niet hetzelfde als een onafhankelijke verificatie van de build.
- Infrastructuur: deze review gaat niet over de productieserver, Cloudflare-regels of het hostingmodel.

## 2. Open punten

Dit is de lijst die de eigenaar en de ontwikkelaars nu kennen. Ze staan ook in
[SECURITY.md](../../SECURITY.md) of in de interne review. Geen van de punten is opgelost tenzij daar
anders staat.

| # | Onderwerp | Stand | Waar |
|---|-----------|-------|------|
| 1 | pCloud: de server bewaart een versleuteld OAuth-token (rclone) voor de geplande back-up; de sleutel staat op dezelfde host. Het wachtwoord is verwijderd. | Restrisico; reikwijdte van het token nog niet tegen live pCloud geverifieerd | [security-audit-2026-10-28.md](../security-audit-2026-10-28.md), "Status update" |
| 2 | Rclone-uitvoer en token in het proces: nog niet live gecontroleerd. | Open | `docs/design/pcloud-credentials.md` §1 |
| 3 | Paden die het vault-wachtwoord naar de server sturen (verify-vault, vault-recovery, legacy-login) werken alleen met `NOTES_STRICT_ZK=0`. Standaard is `1`. | Standaard veilig; de auditor moet controleren dat productie `1` gebruikt | `app/config.py:161-163`, `deploy/PRODUCTION.md:43` |
| 4 | Legacy `password_hash` kan naast SRP blijven bestaan. | Open | [SECURITY.md](../../SECURITY.md) |
| 5 | Verifier-v1 (SHA-256) wordt nog geaccepteerd. | Open | `app/srp_auth.py:1-6` |
| 6 | Uitschakelen van 2FA vereist geen wachtwoordbewijs voor SRP-accounts. | Open | `app/app.py` (`api_totp_disable`), [SECURITY.md](../../SECURITY.md) |
| 7 | Systemd-unit draait standaard als root. | Open, keuze van de eigenaar | `deploy/systemd/deeperguard.service` |
| 8 | Legacy server-OCR bestaat nog; uit in productie. | Open (standaard uit) | `app/app.py:3651`, `app/config.py:100-102` |
| 9 | Ask AI stuurt door de gebruiker gekozen platte tekst naar een externe aanbieder. | Bekend en gedocumenteerd | `app/ai_relay.py`, [docs/PRIVACY.md](../PRIVACY.md) |
| 10 | De kluissleutel is een JavaScript-bytearray. Met de optie "Wachtwoord onthouden" blijft het wachtwoord in lokale opslag. | Bekend | [SECURITY.md](../../SECURITY.md), "Locking the vault" |
| 11 | Zonder `NOTES_SECURE_COOKIES=1` op WAN ontbreken `__Host-`-sessie en HSTS. | Operatorkeuze | `app/config.py`, `deploy/PRODUCTION.md` |
| 12 | Back-upbestanden op de server bevatten `user_email` en `kdf_salt` als platte tekst. | Nog niet beoordeeld | `app/backup_mail.py:72-100` |
| 13 | Third-party code (Tesseract, pdf.js) is niet volledig nagelopen. | Open | [security-audit-2026-10-28.md](../security-audit-2026-10-28.md), "Limits" |
| 14 | Geen dynamische test op de live server of op echte pCloud-accounts. | Open | `docs/design/pcloud-credentials.md` §1 |

## 3. Grenzen van deze omvang

- Deze lijst is opgesteld op basis van de code en de interne reviews, niet door een onafhankelijke
  partij. Een auditor kan punten toevoegen of wegnemen.
- Er is geen dynamische test van de productie-omgeving opgenomen.
- Voor een echte audit moet de eigenaar een auditor kiezen en afspreken wat er getest mag worden.
  Pas als een audit is uitgevoerd en het rapport beschikbaar is, mag daarover iets gepubliceerd worden.
