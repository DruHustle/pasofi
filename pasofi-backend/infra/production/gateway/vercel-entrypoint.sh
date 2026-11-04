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
for kind in body proxy fastcgi uwsgi scgi; do
  mkdir -m 700 "/tmp/pamofi-nginx-$kind"
  chown nginx:nginx "/tmp/pamofi-nginx-$kind"
done

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
  fastcgi_temp_path /tmp/pamofi-nginx-fastcgi;
  uwsgi_temp_path /tmp/pamofi-nginx-uwsgi;
  scgi_temp_path /tmp/pamofi-nginx-scgi;
  server {
    listen 127.0.0.1:8080;
    server_name localhost;
    access_log off;
    default_type application/json;
    location = /health/live { return 200 '{"status":"ok","service":"gateway"}'; }
    location / { return 404; }
  }
  include /tmp/pamofi-gateway/public.conf;
}
NGINX
chmod 600 "$private/nginx.conf" "$private/public.conf"
# Keep raw diagnostics private. Redact the validated token before printing any
# bounded excerpt, without putting the credential in arguments or environment.
if ! nginx -t -q -c "$private/nginx.conf" >"$private/validation.err" 2>&1; then
  awk '
    BEGIN {
      if ((getline token < "/run/secrets/vercel_proxy_token") != 1 || length(token) != 64 || token ~ /[^0-9a-f]/) exit 1
      close("/run/secrets/vercel_proxy_token")
    }
    NR <= 8 { gsub(token, "[redacted]"); print substr($0, 1, 512) }
  ' "$private/validation.err" >&2
  fail
fi
rm "$private/validation.err"
exec nginx -c "$private/nginx.conf" -g 'daemon off;'
