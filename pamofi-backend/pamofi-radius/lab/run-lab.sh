#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
repo_root=$(cd ../.. && pwd)
lab_temp=$(mktemp -d "${TMPDIR:-/tmp}/pamofi-radius-lab.XXXXXXXX")
chmod 700 "$lab_temp"
lab_project="pamofi-radius-$(basename "$lab_temp" | tr '[:upper:].' '[:lower:]-')"
export LAB_CERT_DIR="$lab_temp"
# Choose a private /24 which does not overlap existing Docker networks.
lab_prefix=$(python3 - <<'PYNET'
import ipaddress,json,random,subprocess
ids=subprocess.check_output(['docker','network','ls','-q'],text=True).split()
networks=json.loads(subprocess.check_output(['docker','network','inspect',*ids],text=True)) if ids else []
used=[ipaddress.ip_network(config['Subnet'],strict=False) for net in networks for config in (net.get('IPAM',{}).get('Config') or []) if config.get('Subnet')]
candidates=[ipaddress.ip_network(f'10.{second}.{third}.0/24') for second in range(240,255) for third in range(256)]
random.SystemRandom().shuffle(candidates)
for candidate in candidates:
 if all(candidate.version!=other.version or not candidate.overlaps(other) for other in used):
  print(str(candidate.network_address).rsplit('.',1)[0]);break
else: raise SystemExit('No unused lab subnet found')
PYNET
)
export LAB_SUBNET="$lab_prefix.0/24" LAB_NAS_A_IP="$lab_prefix.10" LAB_NAS_B_IP="$lab_prefix.11"
sed -e "s/172.29.79.10/$LAB_NAS_A_IP/g" -e "s/172.29.79.11/$LAB_NAS_B_IP/g" clients.conf > "$lab_temp/clients.conf"
cleanup() {
  docker compose -p "$lab_project" down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
  rm -rf -- "$lab_temp"
}
diagnose() {
  printf 'RADIUS lab failed at line %s.\n' "$1" >&2
  if [ -f "$lab_temp/auth-a" ]; then
    grep -E 'Received (Access|Accounting)|Class =|Mikrotik-Total-Limit|Session-Timeout' "$lab_temp/auth-a" | head -20 >&2 || true
  fi
  docker compose -p "$lab_project" logs --tail=12 radius radius-api prepaid 2>/dev/null >&2 || true
}
trap 'diagnose "$LINENO"' ERR
trap cleanup EXIT

# One-use certificates for an isolated test network; never deploy these keys.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$lab_temp/ca.key" -out "$lab_temp/ca.crt" -days 1 -subj '/CN=PamoFi disposable lab CA' >/dev/null 2>&1
for name in server radius; do
  openssl req -newkey rsa:2048 -nodes -keyout "$lab_temp/$name.key" -out "$lab_temp/$name.csr" -subj "/CN=$name" >/dev/null 2>&1
  if [ "$name" = server ]; then
    printf 'subjectAltName=DNS:radius-api\nextendedKeyUsage=serverAuth\n' > "$lab_temp/$name.ext"
  else
    printf 'extendedKeyUsage=clientAuth\n' > "$lab_temp/$name.ext"
  fi
  openssl x509 -req -in "$lab_temp/$name.csr" -CA "$lab_temp/ca.crt" -CAkey "$lab_temp/ca.key" -CAcreateserial -out "$lab_temp/$name.crt" -days 1 -extfile "$lab_temp/$name.ext" >/dev/null 2>&1
done
chmod 644 "$lab_temp/server.key" "$lab_temp/radius.key"
export LAB_CLIENT_FINGERPRINT
LAB_CLIENT_FINGERPRINT=$(openssl x509 -in "$lab_temp/radius.crt" -noout -fingerprint -sha256 | cut -d= -f2)

for service in prepaid-access-service network-service; do
  (cd "$repo_root/services/$service" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
done
docker compose -p "$lab_project" up -d --build >"$lab_temp/start.log" 2>&1 || { tail -35 "$lab_temp/start.log"; exit 1; }
compose() { docker compose -p "$lab_project" "$@"; }
# Wait for the RADIUS process; startup logs contain no live credentials.
for attempt in $(seq 1 30); do
  if [ "$(compose ps --status running -q radius | wc -l | tr -d ' ')" = 1 ]; then break; fi
  if [ "$attempt" = 30 ]; then compose logs --tail=30 radius radius-api; exit 1; fi
  sleep 1
done

customer=$(uuidgen | tr '[:upper:]' '[:lower:]')
order=$(uuidgen | tr '[:upper:]' '[:lower:]')
entitlement=$(uuidgen | tr '[:upper:]' '[:lower:]')
site_a=$(uuidgen | tr '[:upper:]' '[:lower:]')
site_b=$(uuidgen | tr '[:upper:]' '[:lower:]')
nas_a=$(uuidgen | tr '[:upper:]' '[:lower:]')
nas_b=$(uuidgen | tr '[:upper:]' '[:lower:]')
credential_a=$(uuidgen | tr '[:upper:]' '[:lower:]')
credential_b=$(uuidgen | tr '[:upper:]' '[:lower:]')
request_key=$(uuidgen | tr '[:upper:]' '[:lower:]')
user_a=$(node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))")
user_b=$(node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))")
password_a=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
password_b=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
hash_a=$(printf '%s' "$password_a" | openssl dgst -sha256 | awk '{print $NF}')
hash_b=$(printf '%s' "$password_b" | openssl dgst -sha256 | awk '{print $NF}')
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U pamofi_prepaid_access -d pamofi_prepaid_access >/dev/null <<SQL
INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES('$order','$customer','$request_key','flex',100,'USD',5000000000,604800,'payment_confirmed',now()+interval '15 minutes');
INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by) VALUES('$entitlement','$order','$customer','flex',5000000000,604800,now()+interval '30 days');
SQL
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U pamofi_network -d pamofi_network >/dev/null <<SQL
INSERT INTO radius_nas(id,site_id,client_name,enabled) VALUES('$nas_a','$site_a','nas_a',true),('$nas_b','$site_b','nas_b',true);
INSERT INTO radius_credentials(id,username,secret_hash,customer_id,nas_id,expires_at) VALUES('$credential_a','$user_a',decode('$hash_a','hex'),'$customer','$nas_a',now()+interval '15 minutes'),('$credential_b','$user_b',decode('$hash_b','hex'),'$customer','$nas_b',now()+interval '15 minutes');
SQL
printf 'User-Name = "%s"\nUser-Password = "%s"\nAcct-Session-Id = "LAB-SESSION-A"\n' "$user_a" "$password_a" > "$lab_temp/access-a"
printf 'User-Name = "%s"\nUser-Password = "%s"\nAcct-Session-Id = "LAB-SESSION-B"\n' "$user_b" "$password_b" > "$lab_temp/access-b"
rad() { local nas="$1" kind="$2" secret="$3" input="$4" output="$5"; compose exec -T "$nas" /opt/bin/radclient -x -t 2 -r 2 "radius:1812" "$kind" "$secret" < "$input" > "$output" 2>&1; }
# Actual retry on initial startup can race the listener.
for attempt in $(seq 1 15); do
 if rad nas-a auth LAB_ONLY_nas_a_secret_26characters "$lab_temp/access-a" "$lab_temp/auth-a" && grep -q 'Received Access-Accept' "$lab_temp/auth-a"; then break; fi
 if [ "$attempt" = 15 ]; then compose logs --tail=30 radius radius-api prepaid; echo 'RADIUS authorization failed' >&2; exit 1; fi
 sleep 1
done
class=$(sed -n 's/^[[:space:]]*Class = \(0x[0-9a-fA-F]*\).*/\1/p' "$lab_temp/auth-a" | head -1)
test -n "$class"
grep -q 'Mikrotik-Total-Limit = 705032704' "$lab_temp/auth-a"
grep -q 'Mikrotik-Total-Limit-Gigawords = 1' "$lab_temp/auth-a"
rad nas-a auth LAB_ONLY_nas_a_secret_26characters "$lab_temp/access-a" "$lab_temp/auth-retry"
grep -q 'Received Access-Accept' "$lab_temp/auth-retry"
grep -q "$class" "$lab_temp/auth-retry"
rad nas-b auth LAB_ONLY_nas_b_secret_26characters "$lab_temp/access-b" "$lab_temp/auth-b" || true
grep -q 'Received Access-Reject' "$lab_temp/auth-b"
rad nas-b auth LAB_ONLY_nas_a_secret_26characters "$lab_temp/access-b" "$lab_temp/wrong-secret" || true
if grep -q 'Received Access-Accept' "$lab_temp/wrong-secret"; then echo 'Wrong NAS secret was accepted' >&2; exit 1; fi
printf 'Acct-Status-Type = Start\nAcct-Session-Id = "LAB-SESSION-A"\nClass = %s\n' "$class" > "$lab_temp/start"
compose exec -T nas-b /opt/bin/radclient -x -t 2 -r 1 radius:1813 acct LAB_ONLY_nas_b_secret_26characters < "$lab_temp/start" > "$lab_temp/wrong-nas-accounting" 2>&1 || true
if grep -q 'Received Accounting-Response' "$lab_temp/wrong-nas-accounting"; then echo 'Wrong NAS accounting was acknowledged' >&2; exit 1; fi
if ! compose exec -T nas-a /opt/bin/radclient -x -t 2 -r 2 radius:1813 acct LAB_ONLY_nas_a_secret_26characters < "$lab_temp/start" > "$lab_temp/start-result" 2>&1; then
  echo 'Accounting start failed' >&2
  grep -E 'Received|Error|No reply|No response' "$lab_temp/start-result" >&2 || true
  compose logs --tail=20 radius radius-api prepaid >&2
  exit 1
fi
grep -q 'Received Accounting-Response' "$lab_temp/start-result"
printf 'Acct-Status-Type = Interim-Update\nAcct-Session-Id = "LAB-SESSION-A"\nClass = %s\nAcct-Input-Octets = 10\nAcct-Input-Gigawords = 0\nAcct-Output-Octets = 0\nAcct-Output-Gigawords = 1\n' "$class" > "$lab_temp/interim"
for attempt in 1 2; do
 if ! compose exec -T nas-a /opt/bin/radclient -x -t 2 -r 2 radius:1813 acct LAB_ONLY_nas_a_secret_26characters < "$lab_temp/interim" > "$lab_temp/interim-result" 2>&1; then
  echo 'Accounting interim failed' >&2
  grep -E 'Received|Error|No reply|No response' "$lab_temp/interim-result" >&2 || true
  compose logs --tail=20 radius radius-api prepaid >&2
  exit 1
 fi
 grep -q 'Received Accounting-Response' "$lab_temp/interim-result"
done
consumed=$(compose exec -T postgres psql -At -U pamofi_prepaid_access -d pamofi_prepaid_access -c "SELECT consumed_bytes FROM purchase_entitlements WHERE id='$entitlement'")
test "$consumed" = 4294967306
sed 's/Interim-Update/Stop/' "$lab_temp/interim" > "$lab_temp/stop"
compose exec -T nas-a /opt/bin/radclient -x -t 2 -r 2 radius:1813 acct LAB_ONLY_nas_a_secret_26characters < "$lab_temp/stop" > "$lab_temp/stop-result" 2>&1
grep -q 'Received Accounting-Response' "$lab_temp/stop-result"
rad nas-b auth LAB_ONLY_nas_b_secret_26characters "$lab_temp/access-b" "$lab_temp/after-stop" || true
grep -q 'Received Access-Reject' "$lab_temp/after-stop"

# A positive 2^32-byte reservation has a zero low word and a nonzero high word.
customer_c=$(uuidgen | tr '[:upper:]' '[:lower:]')
order_c=$(uuidgen | tr '[:upper:]' '[:lower:]')
entitlement_c=$(uuidgen | tr '[:upper:]' '[:lower:]')
credential_c=$(uuidgen | tr '[:upper:]' '[:lower:]')
key_c=$(uuidgen | tr '[:upper:]' '[:lower:]')
user_c=$(node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))")
password_c=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
hash_c=$(printf '%s' "$password_c" | openssl dgst -sha256 | awk '{print $NF}')
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U pamofi_prepaid_access -d pamofi_prepaid_access >/dev/null <<SQL
INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES('$order_c','$customer_c','$key_c','flex',100,'USD',4294967296,604800,'payment_confirmed',now()+interval '15 minutes');
INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by) VALUES('$entitlement_c','$order_c','$customer_c','flex',4294967296,604800,now()+interval '30 days');
SQL
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U pamofi_network -d pamofi_network >/dev/null <<SQL
INSERT INTO radius_credentials(id,username,secret_hash,customer_id,nas_id,expires_at) VALUES('$credential_c','$user_c',decode('$hash_c','hex'),'$customer_c','$nas_a',now()+interval '15 minutes');
SQL
printf 'User-Name = "%s"\nUser-Password = "%s"\nAcct-Session-Id = "LAB-SESSION-C"\n' "$user_c" "$password_c" > "$lab_temp/access-c"
rad nas-a auth LAB_ONLY_nas_a_secret_26characters "$lab_temp/access-c" "$lab_temp/auth-c"
grep -q 'Received Access-Accept' "$lab_temp/auth-c"
grep -q 'Mikrotik-Total-Limit = 0' "$lab_temp/auth-c"
grep -q 'Mikrotik-Total-Limit-Gigawords = 1' "$lab_temp/auth-c"

# A new customer cannot receive an Access-Accept when the authority is down.
customer_d=$(uuidgen | tr '[:upper:]' '[:lower:]')
order_d=$(uuidgen | tr '[:upper:]' '[:lower:]')
entitlement_d=$(uuidgen | tr '[:upper:]' '[:lower:]')
credential_d=$(uuidgen | tr '[:upper:]' '[:lower:]')
key_d=$(uuidgen | tr '[:upper:]' '[:lower:]')
user_d=$(node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))")
password_d=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
hash_d=$(printf '%s' "$password_d" | openssl dgst -sha256 | awk '{print $NF}')
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U pamofi_prepaid_access -d pamofi_prepaid_access >/dev/null <<SQL
INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES('$order_d','$customer_d','$key_d','flex',100,'USD',5000000000,604800,'payment_confirmed',now()+interval '15 minutes');
INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by) VALUES('$entitlement_d','$order_d','$customer_d','flex',5000000000,604800,now()+interval '30 days');
SQL
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U pamofi_network -d pamofi_network >/dev/null <<SQL
INSERT INTO radius_credentials(id,username,secret_hash,customer_id,nas_id,expires_at) VALUES('$credential_d','$user_d',decode('$hash_d','hex'),'$customer_d','$nas_a',now()+interval '15 minutes');
SQL
compose stop prepaid >/dev/null
printf 'User-Name = "%s"\nUser-Password = "%s"\nAcct-Session-Id = "LAB-SESSION-D"\n' "$user_d" "$password_d" > "$lab_temp/access-d"
rad nas-a auth LAB_ONLY_nas_a_secret_26characters "$lab_temp/access-d" "$lab_temp/auth-d" || true
if grep -q 'Received Access-Accept' "$lab_temp/auth-d"; then echo 'Access was accepted without the authority' >&2; exit 1; fi
unreserved=$(compose exec -T postgres psql -At -U pamofi_prepaid_access -d pamofi_prepaid_access -c "SELECT count(*) FROM access_grants WHERE customer_id='$customer_d'")
test "$unreserved" = 0
printf 'Actual FreeRADIUS lab passed: mTLS, NAS identity, grant replay, site exclusion, 64-bit limits, duplicate accounting, uncertain stop and authority outage.\n'
