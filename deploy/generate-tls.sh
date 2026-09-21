#!/usr/bin/env bash
# Deeperguard CA + server cert so iOS can treat the app as a secure context.
set -euo pipefail
KEYS="${NOTES_KEYS:-/opt/deeperguard/keys}"
HOST="${NOTES_HOST:-www.deeperguard.com}"
TLS="${KEYS}/tls"
install -d -m 700 "$TLS"

if [[ -s "$TLS/ca.crt" && -s "$TLS/server.crt" && -s "$TLS/server.key" ]]; then
  echo "TLS already present in $TLS"
  exit 0
fi

umask 077
openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
  -keyout "$TLS/ca.key" \
  -out "$TLS/ca.crt" \
  -subj "/CN=Deeperguard CA"

SAN="DNS:www.deeperguard.com,DNS:deeperguard.com"
if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SAN="${SAN},IP:${HOST}"
elif [[ "$HOST" != "www.deeperguard.com" && "$HOST" != "deeperguard.com" ]]; then
  SAN="${SAN},DNS:${HOST}"
fi
cat >"$TLS/server.ext" <<EXT
subjectAltName=${SAN}
extendedKeyUsage=serverAuth
EXT

openssl req -newkey rsa:2048 -nodes \
  -keyout "$TLS/server.key" \
  -out "$TLS/server.csr" \
  -subj "/CN=${HOST}"

openssl x509 -req -in "$TLS/server.csr" \
  -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" -CAcreateserial \
  -out "$TLS/server.crt" -days 825 -extfile "$TLS/server.ext"

chmod 600 "$TLS/ca.key" "$TLS/server.key"
chmod 644 "$TLS/ca.crt" "$TLS/server.crt"
rm -f "$TLS/server.csr"
echo "Wrote LAN CA and server certificate for ${HOST}"
