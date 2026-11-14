# Ontwerp: client-side versleutelde back-up naar WebDAV / Nextcloud

Status: **ontwerp, nog niet gebouwd**. Dit document wijzigt geen app-code. Datum van het onderzoek: 2026-11-14 (HEAD `7b13bd0`).
Aanleiding: idee #69, gebruikers willen back-ups op een eigen server of Nextcloud in plaats van alleen Google, Dropbox of iCloud.

Uitgangspunt: de server van Deeperguard ziet nooit inhoud, nooit WebDAV-inloggegevens en niet welke WebDAV-server de gebruiker kiest. De browser praat zelf met de WebDAV-server.

## 0. Wat bestaat er al? (gecontroleerd vóór het ontwerp)

Een WebDAV-bestemming bestaat nog niet. `grep -ri webdav app/` vindt alleen de pCloud-code (rclone, serverkant, zie §6). De bouwstenen voor browser-naar-cloud-back-ups bestaan wel, en dit ontwerp hergebruikt ze.

## 1. Vastgestelde feiten

### (a) CSP van de hoofdpagina

- De CSP wordt per verzoek opgebouwd in `content_security_policy()`, `app/auth.py:1060`.
- Regel `app/auth.py:1122`:
  `connect-src 'self'{github_connect}{google_connect}{dropbox_connect}{turnstile}{stripe_connect}`
- Effectief op de app-shell (`/app`, `app/auth.py:1017-1032`) is `connect-src` dus `'self'`, plus alleen als de operator ze heeft ingeschakeld:
  - Google (alleen met `GOOGLE_OAUTH_CLIENT_ID`): `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com` (`app/auth.py:1080-1083`);
  - Dropbox (alleen met `DROPBOX_APP_KEY`): `api.dropboxapi.com`, `content.dropboxapi.com`, `www.dropbox.com` (`app/auth.py:1084-1087`);
  - Stripe `api.stripe.com` bij ingeschakelde betalingen (`app/auth.py:1104-1112`).
  GitHub en Turnstile staan niet in de app-shell (`app/auth.py:1053`, `1048`; `tests/test_per_route_csp.py:58-64`).
- Overige directieven: `default-src 'self'`, `script-src 'self' 'nonce-…' 'wasm-unsafe-eval'` (`app/auth.py:1116`), `frame-src 'self'…` (`app/auth.py:1127`), `frame-ancestors 'none'` (`app/auth.py:1126`), `worker-src 'self' blob:` (`app/auth.py:1128`).
- `X-Frame-Options: DENY` staat op `app/auth.py:1138`.
- Er is precedent voor een eigen, smallere CSP per pad: `app/app.py:573` (`ICS_FETCH_WORKER_CSP = "default-src 'none'; connect-src https:"`), `app/app.py:575` (`KDF_WORKER_CSP`), en de override in `_headers()` op `app/app.py:586-593`. Getest in `tests/test_ics_relay.py:480-491`.
- Let op: `_csp_on_app_shell()` geeft de hoofd-CSP aan álle paden onder `/app/…` (`app/auth.py:1017-1032`). De bridge-pagina (§3) mag dus **niet** onder `/app/` staan.

Een gebruiker kan een willekeurige WebDAV-URL invullen. Die kan niet vooraf in `connect-src` staan. Daarom is isolatie nodig (§3).

### (b) Dropbox- en Drive-tokens en de back-upblob (`app/static/js/cloud-backup.js`)

- Kop van het bestand: "Tokens stay in the browser — never sent to our server" (`cloud-backup.js:4`).
- **Dropbox:** access- en refresh-token staan in de versleutelde kluisinstellingen (`cloud-backup.js:46`, commentaar "M5 / prior L8"). `rememberDropboxTokens()` (`cloud-backup.js:558-581`) schrijft ze via `vaultTokenBridge.save()` (`cloud-backup.js:572-574`). `localStorage` krijgt alleen metadata en lege tokenvelden (`cloud-backup.js:575-580`). Plaintext-tokens uit oudere versies worden verplaatst door `migratePlaintextDropboxTokens()` (`cloud-backup.js:528-556`) en gewist door `clearPlaintextDropboxTokensFromLocal()` (`cloud-backup.js:519-526`).
- De bridge wordt in `app/static/js/app.js:23664-23690` gekoppeld aan `prefs`; die gaan via `pushGlobalPrefs()` (`app.js:288`) en `NotesStore.saveGlobalSettings()` (`app/static/js/store.js:5789`) als versleuteld kluisrecord naar de server.
- **Google Drive:** het access-token blijft alleen in geheugen (`let accessToken`, `cloud-backup.js:37`) en wordt bij verlopen opnieuw opgehaald via de Google-tokenclient (`cloud-backup.js:292-324`). Er is geen refresh-token en niets wordt opgeslagen.
- `sessionStorage` wordt alleen gebruikt voor tijdelijke OAuth-status (`cloud-backup.js:137-151`).
- **Versleuteling van de blob:** `cloud-backup.js` versleutelt zelf niets. `backupBlobFromObject()` serialiseert alleen JSON (`cloud-backup.js:199-202`). Het object komt uit `buildLocalBackup()` (`app.js:24503-24546`): per item een `ciphertext` dat al met de kluissleutel is versleuteld (`NotesCrypto.encryptObject`, `app.js:24524`, `app/static/js/crypto.js:114`; AES-GCM-envelope `v, iv, data`, zie `app.js:20970`).
- **Kanttekening die dit ontwerp oplost:** de buitenste envelop is **niet** versleuteld en niet geauthenticeerd: `format`, `user_email`, `kdf_salt`, `exported_at`, en per item `item_uuid`, `content_hash`, `updated_at` staan leesbaar (`app.js:24538-24544`). Er is geen versie/volgnummer en geen MAC over het geheel. Items kunnen dus individueel worden vervangen of weggelaten zonder dat het bestand als geheel ongeldig wordt. Zie §7 (rollback) en bouwtaak B2.
- Upload naar Dropbox: `uploadDropboxBackupBlob()` (`cloud-backup.js:853-885`), `Authorization: Bearer`, modus `overwrite`, bestandsnaam `deeperguard-backup-YYYY-MM-DD.dgbackup` (`cloud-backup.js:196`).

### (c) Status pCloud-migratie (`docs/PCLOUD_CREDENTIALS_MIGRATION.md`)

**Code: afgerond. Uitrol: niet uit de repo te verifiëren.**

- Wachtwoordopslag is uitgeschakeld: `pcloud_password_set()` geeft altijd `False` (`app/config.py:418-420`).
- Tokens worden AES-GCM-versleuteld weggeschreven (`app/config.py:387-400`, `app/pcloud_credentials.py:55`, envelop `dg-pcloud-v1:` op regel 17).
- Bij het opstarten worden oude wachtwoordbestanden verwijderd en plaintext-tokenbestanden her-versleuteld: `app/app.py:4171-4175` roept `migrate_all_pcloud_secrets()` aan (`app/pcloud_credentials.py:137-154`).
- **Open / niet bewezen:** (1) `migrate_all_pcloud_secrets()` doet niets zolang `NOTES_PCLOUD_CREDENTIALS_KEY` niet is gezet (`pcloud_credentials.py:140`); of dat op de productieserver is gebeurd staat niet in de repo. (2) De operatorstappen (sleutel genereren, gebruikers vragen hun pCloud-wachtwoord te wijzigen) zijn handwerk. (3) De sleutel staat op dezelfde host als de versleutelde tokens, dus dit is bescherming tegen bestandslekken, niet tegen een gecompromitteerde server. Het auditpunt H-PCLOUD (`docs/security-audit-2026-10-28.md:24`) is dus mitigerend aangepakt, niet principieel opgelost. Dat laatste kan alleen door de inloggegevens nooit naar de server te sturen, wat dit ontwerp voor WebDAV wel doet.

## 2. Doelen en niet-doelen

Doelen: handmatige versleutelde back-up (en terugzetten) naar een door de gebruiker gekozen WebDAV-server of Nextcloud; inloggegevens alleen in het versleutelde kluisrecord; hoofd-CSP ongewijzigd.

Buiten scope:
- **Server-side WebDAV** (de server van Deeperguard die zelf uploadt, zoals pCloud via rclone). Zie H-PCLOUD, `docs/security-audit-2026-10-28.md:24`. Dit ontwerp voegt dat niet toe en wil het juist vermijden.
- **Sync via WebDAV** (doorlopend synchroniseren van items). Kan later als apart ontwerp; het vraagt conflictafhandeling, locking en een ander dreigingsmodel.
- Automatische/geplande back-ups (zie §3, restrisico). Eerste versie is handmatig.

## 3. Isolatie

### Probleem

De gebruiker voert een willekeurige origin in. De hoofd-CSP (`connect-src 'self' …`, `app/auth.py:1122`) staat geen verbinding ermee toe. Ruimer maken (`connect-src https:`) zou elke XSS een exfiltratiekanaal voor de ontsleutelde kluis geven, en dat is precies wat de CSP nu voorkomt.

### Optie A: aparte, ge-sandboxte bridge-pagina in een iframe, eigen CSP

Pad `/webdav-bridge` (buiten `/app/`), geladen in `<iframe sandbox="allow-scripts">` (dus **zonder** `allow-same-origin`: opaque origin, geen toegang tot `window.parent`, cookies, IndexedDB of `localStorage`). Eigen CSP via dezelfde per-pad-override als `app/app.py:586-593`. Twee manieren om `connect-src` te beperken tot de bevestigde origin:

- **A1, dynamische header:** de server zet `connect-src <origin>` uit een queryparameter. Nadeel: de server leert de hostnaam van de WebDAV-server van de gebruiker, in logs en aan de header.
- **A2, vaste pagina met meta-CSP:** de header is statisch (`connect-src https:`). Het bridge-script voegt vóór de eerste `fetch` een `<meta http-equiv="Content-Security-Policy" content="connect-src https://nextcloud.example.org">` toe. Meerdere CSP's werken als doorsnede, dus daarna geldt alleen die ene origin. De server ziet de hostnaam nooit.

Back-upblob en inloggegevens gaan van de hoofdpagina naar de bridge via `postMessage` op een `MessageChannel` (zie hieronder).

### Optie B: dedicated worker of service worker

Een worker met een eigen CSP-header op het scriptpad, zoals de bestaande `ics-fetch-worker.js` (`app/app.py:573`, `589`). Voordelen: bewezen patroon in deze codebase, geen iframe, same-origin dus `Origin: https://<app>` en een nette CORS-allowlist.
Nadelen:
- Een worker kan zijn CSP niet zelf aanscherpen met een meta-tag. De origin moet dus in de header (zoals A1, met het hostnaam-lek) of de header wordt `connect-src https:` en blijft breed.
- Same-origin: XSS in de hoofdpagina kan zelf een `new Worker(…)` starten en elke URL opgeven, zonder dat de gebruiker iets ziet. De worker beperkt de schade niet.
- Een service worker intercepteert bovendien alle fetches van de app en heeft al de rol van shell-cache; daar nog uploadlogica bij is een verkeerde koppeling met een bredere aanvalsopervlakte.

### Keuze: **A2** (ge-sandboxte bridge-pagina, vaste header, meta-CSP-aanscherping)

Motivering:
1. De server leert niets over de gekozen WebDAV-server (A1 en B lekken de hostnaam of blijven breed).
2. Opaque origin: XSS in de hoofdpagina kan niet in de frame kijken of scripten, en de bridge heeft geen kluissleutel, geen sessie en geen opslag. Het enige geheim in de bridge is het ene app-wachtwoord voor de duur van één actie.
3. De bevestiging van de doel-origin (en de knop "Verstuur naar https://host") staat **in** de bridge-frame, niet in de hoofdpagina. Een XSS in de hoofdpagina kan daar niet op klikken en de weergegeven host niet vervalsen. Zo wordt de bridge geen open exfiltratieroute voor XSS: elke upload naar een nieuwe origin vraagt een zichtbare handeling van de gebruiker. (Restrisico, zie §7: social engineering van die dialoog.)
4. Kleine, auditbare pagina: één script, geen inline code.

**Nadeel dat bij A2 hoort:** een opaque origin stuurt `Origin: null`. Een CORS-allowlist op de app-origin werkt dus niet. Zie §6: gebruik `Access-Control-Allow-Origin: *` (veilig omdat de bridge `credentials: 'omit'` gebruikt en alleen met een `Authorization`-header authenticeert, niet met cookies), of expliciet `null`.

### De hoofd-CSP blijft ongewijzigd

- `content_security_policy()` (`app/auth.py:1060-1134`) krijgt **geen** nieuwe host en geen nieuwe parameter. `connect-src` op de app-shell blijft `'self'` + de bestaande optionele Google/Dropbox/Stripe-hosts.
- `frame-src 'self'` (`app/auth.py:1127`) staat het laden van `/webdav-bridge` al toe. Dat is de enige reden dat de hoofdpagina niets nodig heeft.
- Alleen het pad `/webdav-bridge` krijgt een eigen header-set (de bestaande override-techniek, `app/app.py:586-593`), met o.a. `frame-ancestors 'self'` en `X-Frame-Options: SAMEORIGIN` in plaats van `DENY`/`'none'` (`app/auth.py:1126`, `1138`):

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  connect-src https:; base-uri 'none'; form-action 'none';
  frame-ancestors 'self'; sandbox allow-scripts
X-Frame-Options: SAMEORIGIN
Referrer-Policy: no-referrer
Cache-Control: no-store
```

- Voor testservers op localhost (Playwright) staat `http://localhost:*` alleen aan achter een testvlag, niet in productie.
- Een unit-test borgt dit: de CSP van `/app` bevat géén extra origin en geen `https:` in `connect-src`; `/webdav-bridge` heeft de bovenstaande header; `/app/…` blijft de hoofd-CSP krijgen.

### Doorgave van de versleutelde blob

1. Hoofdpagina maakt de blob zoals nu (`prepareEncryptedBackupBlob`, `app.js:23581-23590`) plus de nieuwe geauthenticeerde envelop (§7).
2. Hoofdpagina maakt de iframe en wacht op `load`. Omdat de frame een opaque origin heeft, is `event.origin === "null"` en dus geen bruikbare identiteit. Controles daarom:
   - hoofdpagina verstuurt **eenmalig** `iframe.contentWindow.postMessage({type:'init'}, '*', [port2])` (targetOrigin `'*'` is hier onvermijdelijk bij een opaque origin; er gaat geen geheim mee behalve de poort);
   - de bridge accepteert alleen berichten waarvan `event.source === window.parent`, en slechts één `init` met precies één `MessagePort`;
   - de hoofdpagina verwerkt antwoorden alleen via `port1` en controleert dat `event.source` van het init-antwoord `iframe.contentWindow` is;
   - alle verdere data (blob als `ArrayBuffer`, URL, gebruikersnaam, app-wachtwoord) gaat uitsluitend via de `MessageChannel`-poort, niet via `window.postMessage`. Zo kan geen andere frame of tab meeluisteren.
3. De bridge toont de doelhost, vraagt bevestiging, doet de PUT/GET en stuurt een resultaat terug (`{ok, status, kind}`), nooit de inloggegevens.
4. De frame wordt na afloop verwijderd; de opaque origin heeft geen persistente staat.

## 4. Opslag van gegevens

- WebDAV-URL, gebruikersnaam en **Nextcloud app-wachtwoord** komen in het versleutelde kluisrecord, op dezelfde plaats als de Dropbox-tokens (`prefs` → `pushGlobalPrefs()` → `saveGlobalSettings()`, `app.js:288`, `store.js:5789`; patroon `cloud-backup.js:46`, `558-581`). Ze gaan dus nooit onversleuteld naar de server en niet naar `localStorage`.
- `localStorage` krijgt hooguit niet-geheime metadata: `webdavConnected`, `lastWebdavBackupAt` en de weergavehost (zoals `dropboxAccountLabel`, `cloud-backup.js:596`).
- Nieuwe `prefs`-velden moeten in `pickGlobalPrefs` en in de bestaande wis-/uitlogpaden worden meegenomen (bouwtaak B1).
- De setup-pagina adviseert expliciet een **app-wachtwoord**: Nextcloud → Instellingen → Beveiliging → "Nieuwe app-wachtwoord maken". Voordelen: apart in te trekken, geen 2FA-conflict, beperkt tot WebDAV-gebruik, en het accountwachtwoord komt nooit in Deeperguard. Een app-wachtwoord is technisch niet te onderscheiden van een accountwachtwoord; de formuliertekst moet dit advies daarom duidelijk geven.
- Aanbevolen: een eigen map (bijv. `Deeperguard/`) en een gebruiker/app-wachtwoord dat alleen daar toegang toe heeft.
- Wordt de kluis vergrendeld of de gebruiker uitgelogd, dan zijn de gegevens weg uit het geheugen, net als de Dropbox-tokens.

## 5. Setup-flow

1. **Invoer:** server-URL (`https://…`, normaal gesproken eindigend op `/remote.php/dav/files/<gebruiker>/` voor Nextcloud), gebruikersnaam, app-wachtwoord, mapnaam. Plain `http://` wordt geweigerd behalve `localhost` achter de testvlag.
2. **Bevestiging in de bridge-frame:** "Deeperguard gaat verbinden met `https://nextcloud.example.org`." De gebruiker bevestigt (zie §3, punt 3).
3. **Verbinding testen** (in de bridge):
   1. `OPTIONS <url>`: moet slagen en `DAV:` in de `Allow`/`DAV`-header tonen. Dit is ook de CORS-preflight-test.
   2. `PROPFIND <map>` met `Depth: 0`: controleert inloggegevens en dat de map bestaat (anders `MKCOL`).
   3. Kleine testupload: `PUT <map>/.deeperguard-test-<willekeurig>` met 16 willekeurige bytes, dan `GET` (vergelijk), dan `DELETE`. Mislukt `DELETE`, dan meldt de test dat met naam van het bestand.
   4. Pas bij succes wordt het record opgeslagen.
4. **Foutmeldingen**, onderscheiden via het gedrag van `fetch` (een CORS-fout is voor JavaScript een `TypeError` zonder status, hetzelfde als een netwerkfout; daarom een tweede, vergelijkende stap):

| Situatie | Detectie | Melding (kern) |
|---|---|---|
| CORS niet ingesteld | `fetch` gooit `TypeError`; een `no-cors`-`HEAD` naar dezelfde URL slaagt wél (opaque respons) | "De server is bereikbaar, maar staat verbindingen vanuit de browser niet toe (CORS). Zie de handleiding hieronder." Met link naar §6. |
| Server onbereikbaar / DNS / TLS | `TypeError` én ook de `no-cors`-probe faalt | "Kan de server niet bereiken. Controleer de URL, je internetverbinding en het certificaat." |
| Verkeerde inloggegevens | HTTP 401 | "Gebruikersnaam of app-wachtwoord is onjuist. Maak in Nextcloud een nieuw app-wachtwoord." |
| Geen rechten | HTTP 403 | "Dit account mag niet schrijven in deze map." |
| Map/URL bestaat niet | HTTP 404 (en `MKCOL` mislukt) | "De map is niet gevonden. Controleer het pad." |
| Preflight geweigerd | `OPTIONS` geeft 4xx/5xx of mist `Authorization` in `Access-Control-Allow-Headers` | "De server weigert de preflight; `Authorization` en `PROPFIND`/`PUT`/`DELETE` moeten zijn toegestaan." |
| Quota vol | HTTP 507 | "Geen ruimte op de server." |
| Te groot | HTTP 413 | "De server accepteert dit bestand niet (limiet). Zie `client_max_body_size`/`LimitRequestBody`." |
| Onverwacht | overige statuscodes | "De server antwoordde met <status>." Zonder responsetekst, die kan inhoud bevatten. |

   Bekende beperking: de browser geeft bij CORS-fouten geen detail vrij. Het onderscheid CORS-versus-netwerk is dus een heuristiek (de `no-cors`-probe), geen zekerheid, en de tekst zegt dat ook.

5. **Back-up maken / terugzetten:** `PUT` naar `<map>/deeperguard-backup-YYYY-MM-DD.dgbackup` (naamconventie `cloud-backup.js:196`), lijst via `PROPFIND Depth: 1`, herstel via `GET`. Herstel valideert eerst de envelop (§7) en gebruikt daarna de bestaande herstelcode.

## 6. CORS-handleiding

De bridge draait in een sandbox, dus de browser stuurt `Origin: null` (§3). De bridge gebruikt `credentials: 'omit'` en authenticeert alleen met `Authorization: Basic …`. Daarom is `Access-Control-Allow-Origin: *` veilig: er zijn geen cookies die een andere site kan misbruiken. Wie strikter wil, mag `Access-Control-Allow-Origin: null` terugsturen (alleen deze sandboxed frames), maar niet dynamisch elke `Origin` reflecteren.

Minimaal nodig:
- Methoden: `OPTIONS, PROPFIND, MKCOL, PUT, GET, DELETE` (en `HEAD`).
- Request headers: `Authorization, Content-Type, Depth, Overwrite, Destination` (de laatste twee alleen als `MOVE` later nodig blijkt).
- Response `Access-Control-Allow-Headers` moet `Authorization` **expliciet** noemen; `*` dekt `Authorization` niet.
- Preflight (`OPTIONS`) moet zónder authenticatie met `204` antwoorden, anders faalt de preflight op een 401.
- Optioneel `Access-Control-Max-Age: 86400`.
- `Access-Control-Expose-Headers: DAV, Content-Length, ETag, Last-Modified` zodat de test de DAV-header kan lezen.

### Nextcloud (Apache, bijvoorbeeld in `.htaccess` of de vhost)

Nextcloud heeft geen CORS-instelling voor WebDAV; stel het in op de webserver. Vereist `mod_headers`.

```apache
<IfModule mod_headers.c>
  <LocationMatch "^/(remote\.php/(dav|webdav)|public\.php/webdav)">
    Header always set Access-Control-Allow-Origin "*"
    Header always set Access-Control-Allow-Methods "OPTIONS, PROPFIND, MKCOL, PUT, GET, HEAD, DELETE"
    Header always set Access-Control-Allow-Headers "Authorization, Content-Type, Depth, Overwrite, Destination"
    Header always set Access-Control-Expose-Headers "DAV, Content-Length, ETag, Last-Modified"
    Header always set Access-Control-Max-Age "86400"
  </LocationMatch>

  # Preflight zonder authenticatie beantwoorden
  RewriteEngine On
  RewriteCond %{REQUEST_METHOD} OPTIONS
  RewriteRule ^remote\.php/(dav|webdav) - [R=204,L]
</IfModule>
```

### Nextcloud (nginx)

```nginx
location ^~ /remote.php/ {
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "OPTIONS, PROPFIND, MKCOL, PUT, GET, HEAD, DELETE" always;
        add_header Access-Control-Allow-Headers "Authorization, Content-Type, Depth, Overwrite, Destination" always;
        add_header Access-Control-Max-Age 86400 always;
        add_header Content-Length 0;
        return 204;
    }
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Expose-Headers "DAV, Content-Length, ETag, Last-Modified" always;

    # ... bestaande fastcgi/php-configuratie van Nextcloud hier
}
```

`add_header` in een `location` vervangt `add_header`-regels van het omliggende blok; zet bestaande beveiligingsheaders (HSTS, enz.) dan ook in dit blok. Nextcloud AIO / Docker: zet de regels in de proxy ervoor, niet in de container.

### Generieke WebDAV-server

Apache `mod_dav` (`Dav On`), in de `<Directory>` of `<Location>` van de DAV-map:

```apache
<Location "/dav/">
  Dav On
  AuthType Basic
  AuthName "WebDAV"
  AuthUserFile /etc/apache2/dav.htpasswd
  <RequireAll>
    Require valid-user
  </RequireAll>

  Header always set Access-Control-Allow-Origin "*"
  Header always set Access-Control-Allow-Methods "OPTIONS, PROPFIND, MKCOL, PUT, GET, HEAD, DELETE"
  Header always set Access-Control-Allow-Headers "Authorization, Content-Type, Depth, Overwrite, Destination"
  Header always set Access-Control-Expose-Headers "DAV, Content-Length, ETag, Last-Modified"

  # Preflight mag zonder inlog
  <Limit OPTIONS>
    Require all granted
  </Limit>
</Location>
```

nginx (`ngx_http_dav_module`, plus `nginx-dav-ext-module` voor `PROPFIND`/`OPTIONS`):

```nginx
location /dav/ {
    dav_methods PUT DELETE MKCOL;
    dav_ext_methods PROPFIND OPTIONS;
    create_full_put_path on;
    client_max_body_size 200m;
    auth_basic "WebDAV";
    auth_basic_user_file /etc/nginx/dav.htpasswd;

    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "OPTIONS, PROPFIND, MKCOL, PUT, GET, HEAD, DELETE" always;
        add_header Access-Control-Allow-Headers "Authorization, Content-Type, Depth, Overwrite, Destination" always;
        add_header Access-Control-Max-Age 86400 always;
        return 204;   # let op: loopt vóór auth_basic via return
    }
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Expose-Headers "DAV, Content-Length, ETag, Last-Modified" always;
}
```

Controleer met `curl -i -X OPTIONS -H 'Origin: null' -H 'Access-Control-Request-Method: PUT' -H 'Access-Control-Request-Headers: authorization' https://server/dav/`: verwacht `204` en de drie `Access-Control-Allow-*`-headers.

## 7. Dreigingsmodel

| Dreiging | Effect / aanname | Maatregel |
|---|---|---|
| **XSS in de hoofdpagina** | Aanvaller met script in de unlocked app kan al kluisinhoud lezen; het enige wat de CSP nu voorkomt is exfiltratie (`connect-src`, `app/auth.py:1122`). | Hoofd-CSP blijft smal. De bridge heeft opaque origin en een eigen bevestigingsdialoog (§3). Restrisico: XSS kan de bridge-frame laden en de gebruiker proberen te overhalen naar een kwaadaardige host te bevestigen. De dialoog toont de volledige host en vereist een klik; pinnen van de bevestigde origin in het kluisrecord en een extra waarschuwing bij wijziging verkleint dit. Automatische back-ups zijn daarom buiten scope voor v1. |
| **XSS in de bridge zelf** | Zou het app-wachtwoord en de blob kunnen lekken. | Alleen `script-src 'self'`, geen inline code, geen `eval`, `default-src 'none'`, `sandbox`. De bridge krijgt geen kluissleutel; de blob is al versleuteld. Bij lekken: app-wachtwoord intrekken. |
| **Kwaadaardige of gecompromitteerde WebDAV-server** | Ziet alleen versleutelde blobs, tijdstip, grootte en IP. Kan weigeren, verwijderen, oude versie teruggeven of bestanden vervangen. Ziet het app-wachtwoord (Basic auth) bij elke aanvraag. | Inhoud blijft versleuteld met de kluissleutel (zie `buildLocalBackup`, `app.js:24524`). Aanbeveling: dedicated app-wachtwoord met toegang tot één map; HTTPS verplicht. Server kan wel back-ups wissen, dus zie ook "meerdere bestemmingen" en de lokale download. |
| **Rollback / vervanging van back-ups** | Nu is de buitenste envelop niet geauthenticeerd (§1b): oude of samengestelde bestanden zijn niet te onderscheiden. | Nieuw formaat `deeperguard-backup-v2`: de hele envelop wordt in één AES-GCM-blok versleuteld met een van de kluissleutel afgeleide sleutel (HKDF, apart label). De **header** (`format`, `version`, `backup_seq`, `exported_at`, `item_count`, `user_id_hash`) is als AAD aan de tag gebonden, dus onveranderbaar. `backup_seq` is een monotoon teller in het kluisrecord; herstel waarschuwt als `backup_seq` lager is dan de laatst geziene of als `exported_at` ouder is dan de laatst bekende back-up. GCM voorkomt wijzigen; de teller maakt rollback zichtbaar. Volledig voorkomen kan niet tegen een server die alles kent wat hij ooit had; dat staat zo in de documentatie. v1-bestanden blijven herstelbaar, met een waarschuwing "niet geauthenticeerd". |
| **Metadatalekken via bestandsnamen** | `deeperguard-backup-YYYY-MM-DD.dgbackup` (`cloud-backup.js:196`) verraadt product en back-upmomenten; `user_email` en `item_uuid` staan nu leesbaar in de blob (`app.js:24538`). | In v2 zit alles binnen het versleutelde blok. Bestandsnaam wordt neutraal en zonder e-mail (`backup-<8 hex>.bin`), de datum staat alleen in de versleutelde header. Dat het om Deeperguard gaat is op de server desondanks af te leiden uit grootte en gedrag; dat is acceptabel en wordt vermeld. Grootte, aantal bestanden en tijdstippen blijven zichtbaar. |
| **Credentials in de kluis** | Wie de kluis ontsleutelt, heeft ook het app-wachtwoord. | Zelfde bescherming als de Dropbox-tokens (§4). Server ziet alleen het versleutelde record. |
| **Mixed content / MITM** | `http://` zou het wachtwoord en de blob blootleggen. | Alleen `https://`; localhost-uitzondering alleen in testbuilds. |
| **Quota-misbruik / grote uploads** | Een te grote blob blokkeert de bridge. | Limieten en voortgang in de bridge; foutmelding 413/507 (§5). |
| **Eigen server, dus eigen risico** | Een misconfiguratie (`*` zonder `Authorization`-eis) kan elders een CORS-probleem geven. | Handleiding §6 beperkt `*` tot de DAV-paden en verlangt Basic auth zonder cookies. |

## 8. Opsplitsing in latere bouwtaken

Elke taak is zelfstandig te leveren en te testen.

**B1. Bridge-pagina en per-pad CSP (alleen server)**
- Nieuwe route `/webdav-bridge` buiten `/app/`, statische pagina + script; per-pad header-override in `_headers()` (`app/app.py:586-593`-patroon), met `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`.
- Acceptatie: `/webdav-bridge` geeft exact de header uit §3; `/app` en `/app/x` geven ongewijzigd de hoofd-CSP.
- Tests (unit, `tests/test_per_route_csp.py`-stijl): (1) bridge-CSP gelijk aan constante, `connect-src https:`, geen `unsafe-inline`; (2) `connect-src` van `/app` is `'self'` plus alleen Google/Dropbox/Stripe-hosts en bevat nooit `https:` of een `*`; (3) `/app/webdav-bridge` (verkeerd pad) krijgt de hoofd-CSP en niet de bridge-CSP; (4) `frame-src 'self'` op `/app` blijft aanwezig; (5) bestaande tests `test_ics_relay.py:480-491` blijven groen.

**B2. Back-upformaat v2 (geauthenticeerde envelop)**
- Nieuwe `buildEncryptedBackupV2` / `openBackupV2` in een eigen module, AES-GCM met AAD, `backup_seq`, neutrale bestandsnaam. v1 blijft leesbaar.
- Acceptatie: een gewijzigde header-byte, een verwisselde item-ciphertext of een afgebroken bestand wordt geweigerd; een lagere `backup_seq` geeft een waarschuwing; v1 herstelt nog steeds.
- Tests (JS unit, zoals `tests/test_*.js`): round-trip, tamper per veld, rollback-waarschuwing, v1-compatibiliteit.

**B3. Bridge-protocol (MessageChannel) en WebDAV-client**
- Alleen de bridge-kant: `init`-handshake, `event.source`-controle, één poort, acties `test`, `put`, `get`, `list`, `delete`, meta-CSP-aanscherping vóór de eerste fetch.
- Acceptatie: berichten van een andere bron worden genegeerd; na aanscherping weigert de browser een `fetch` naar een andere origin; geen inloggegevens in antwoorden.
- Tests: JS unit met gemockte `fetch` en poort; Playwright (B6) voor de echte CSP-afdwinging.

**B4. Kluisrecord en instellingen-UI**
- Nieuwe `prefs`-velden (URL, gebruiker, app-wachtwoord) in `pickGlobalPrefs`; wissen bij vergrendelen/uitloggen; UI met app-wachtwoord-advies en CORS-link.
- Acceptatie: na opslaan staat het wachtwoord niet in `localStorage`/`sessionStorage` en niet in een netwerkverzoek naar de eigen server (alleen in het versleutelde kluisrecord); na vergrendelen is het uit het geheugen.
- Tests: JS unit voor `pickGlobalPrefs`; Playwright controleert `localStorage` en onderschepte verzoeken naar de eigen server (geen plaintext).

**B5. Setup-flow, verbindingstest en foutmeldingen**
- OPTIONS → PROPFIND → testupload (PUT, GET, DELETE) en de foutentabel van §5, in het Nederlands en Engels.
- Acceptatie: elke rij van de foutentabel heeft een eigen, aangetoonde melding; de testbestand wordt altijd verwijderd of expliciet gemeld.
- Tests: Playwright tegen de testserver uit B6, met varianten: goed, 401, 403, 404, ontbrekende CORS, onbereikbare poort, 507.

**B6. Playwright-testserver en end-to-end**
- Kleine lokale WebDAV-testserver (Python `wsgidav`, of een minimale eigen handler) met schakelaars voor CORS aan/uit, auth, statuscodes.
- Acceptatie: e2e back-up maken → bestand staat versleuteld op de testserver (geen plaintext-notities, geen e-mail) → herstellen in een schone kluis; tweede back-up verhoogt `backup_seq`; teruggezette oude kopie geeft de rollback-waarschuwing; bevestigingsdialoog toont de juiste host.
- Tests: Playwright. Extra: controle dat de server van Deeperguard tijdens de hele flow geen verzoek ontvangt met de WebDAV-URL of het app-wachtwoord (verzoeklog).

**B7. Documentatie en uitrol**
- `docs/SELF_HOST.md` en gebruikershulp: status van "gepland" naar "beschikbaar", CORS-handleiding uit §6 verhuizen naar de helpdocumentatie.
- Acceptatie: links werken, voorbeeldconfig is gekopieerd uit dit document en getest tegen de Playwright-server.

Volgorde: B1, B2 en B3 parallel; daarna B4, B5; B6 start met B3 en groeit mee; B7 laatst.

## 9. Open vragen

- Geplande/automatische back-ups: de bevestigingsklik in de bridge staat daarmee op gespannen voet. Apart ontwerp als dit nodig is.
- Meerdere bestemmingen tegelijk (lokaal + WebDAV) als verdediging tegen een server die back-ups wist.
- Of `Origin: null` bij alle doelgroep-servers (Nextcloud hosters) werkt; de handleiding dekt de vaakst gebruikte gevallen.
