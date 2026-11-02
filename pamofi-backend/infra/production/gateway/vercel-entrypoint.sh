#!/bin/sh
set -eu
umask 077

fail() { echo 'Vercel gateway startup refused: inspect the qualified hostname, token file and TLS files privately.' >&2; exit 1; }
test -f /run/secrets/vercel_proxy_token || fail
test ! -L /run/secrets/vercel_proxy_token || fail
test -f /run/secrets/public_tls_cert || fail
test -f /run/secrets/public_tls_key || fail
test -n "${PAMOFI_PUBLIC_HOST:-}" || fail
private=/tmp/pamofi-gateway
test ! -e "$private" || fail
mkdir -m 700 "$private"
# Workers need private temporary storage but cannot traverse the root-owned
# configuration directory. Keep those paths separate from the secret config.
mkdir -m 700 /tmp/pamofi-nginx-body /tmp/pamofi-nginx-proxy
chown nginx:nginx /tmp/pamofi-nginx-body /tmp/pamofi-nginx-proxy

# Read the credential inside awk: never place it in an environment variable or
# process argument. Refuse additional lines, carriage returns and non-hex data.
awk '
BEGIN {
  host = ENVIRON["PAMOFI_PUBLIC_HOST"]
  if (length(host) + 8 > 253 || host !~ /^[a-z0-9.-]+$/ || host !~ /\./) exit 1
  n = split(host, labels, /\./)
  if (length(labels[n]) < 2 || labels[n] !~ /^[a-z]+$/ ||
      labels[n] == "local" || labels[n] == "localhost") exit 1
  for (i = 1; i <= n; i++) {
    if (length(labels[i]) < 1 || length(labels[i]) > 63 ||
        labels[i] !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) exit 1
  }
  file = "/run/secrets/vercel_proxy_token"
  if ((getline token < file) != 1 || length(token) != 64 ||
      token ~ /[^0-9a-f]/ || (getline extra < file) != 0) exit 1
  close(file)
}
{
  gsub(/__PAMOFI_PUBLIC_HOST__/, host)
  gsub(/__PAMOFI_PROXY_TOKEN__/, token)
  print
}
' /etc/nginx/templates/default.conf.template > "$private/public.conf" || fail

cat > "$private/nginx.conf" <<'NGINX'
user nginx;
worker_processes auto;
pid /tmp/pamofi-gateway/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  client_body_temp_path /tmp/pamofi-nginx-body;
  proxy_temp_path /tmp/pamofi-nginx-proxy;
  include /tmp/pamofi-gateway/public.conf;
}
NGINX
chmod 600 "$private/nginx.conf" "$private/public.conf"
# Nginx diagnostics can print configuration fragments; suppress them here.
nginx -t -q -c "$private/nginx.conf" >/dev/null 2>&1 || fail
exec nginx -c "$private/nginx.conf" -g 'daemon off;'
