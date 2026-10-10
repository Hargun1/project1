#!/bin/sh
# Runs before Nginx starts (the official image executes /docker-entrypoint.d/*).
#
# 1. Certificate. If TLS_CERT_DIR holds fullchain.pem + privkey.pem (Let's
#    Encrypt in production, mkcert or similar locally), use them. Otherwise make
#    a self-signed certificate for localhost, so the stack works out of the box
#    and in CI; browsers will warn about it.
# 2. Redirect. Write the HTTP→HTTPS redirect with the *public* HTTPS port
#    (PUBLIC_HTTPS_PORT, e.g. 8443 locally; empty for the standard 443).
set -eu

CERT_DIR="${TLS_CERT_DIR:-/etc/nginx/certs}"
TLS_DIR=/etc/nginx/tls
mkdir -p "$TLS_DIR"

if [ -s "$CERT_DIR/fullchain.pem" ] && [ -s "$CERT_DIR/privkey.pem" ]; then
  # Copied (dereferencing Let's Encrypt's symlinks); Nginx reads them at start.
  cp -L "$CERT_DIR/fullchain.pem" "$TLS_DIR/fullchain.pem"
  cp -L "$CERT_DIR/privkey.pem" "$TLS_DIR/privkey.pem"
  echo "40-tls: using the certificate from $CERT_DIR"
else
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$TLS_DIR/privkey.pem" -out "$TLS_DIR/fullchain.pem" 2>/dev/null
  echo "40-tls: no certificate in $CERT_DIR; generated a self-signed one for localhost"
fi
chmod 600 "$TLS_DIR/privkey.pem"

PORT_SUFFIX=""
if [ -n "${PUBLIC_HTTPS_PORT:-}" ] && [ "${PUBLIC_HTTPS_PORT}" != "443" ]; then
  PORT_SUFFIX=":${PUBLIC_HTTPS_PORT}"
fi
# $host and $request_uri are Nginx variables, written literally.
printf 'return 301 https://$host%s$request_uri;\n' "$PORT_SUFFIX" \
  > /etc/nginx/snippets/https-redirect.conf
echo "40-tls: HTTP redirects to https://<host>${PORT_SUFFIX}"
