#!/bin/bash
# Finder/Terminal entry point; compatible with the Bash 3.2 shipped by macOS.
set -euo pipefail

pasofi_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Explicit command-line arguments keep their exact values and working directory.
if [ "$#" -gt 0 ]; then
  exec /bin/bash "$pasofi_script_dir/release-deploy.sh" "$@"
fi

pasofi_finish() {
  local pasofi_finish_status=$?
  trap - EXIT
  if [ -t 0 ]; then
    printf '\nPress Return to finish. '
    IFS= read -r pasofi_finish_input || :
  fi
  exit "$pasofi_finish_status"
}
trap pasofi_finish EXIT

pasofi_stop() {
  printf 'STOPPED: %s\n' "$1" >&2
  exit 1
}

printf 'PasoFi Mac deployment\n\n'
printf 'Use the qualified, extracted release bundle and your existing SSH connection.\n'
printf 'Enter connection names and existing paths only, never passwords or private keys.\n\n'

for pasofi_required_file in release-deploy.sh release-deploy.py release.json source.tar.gz; do
  [ -f "$pasofi_script_dir/$pasofi_required_file" ] ||
    pasofi_stop "The release bundle is incomplete. Keep its launcher, manifest and source archive together."
done
for pasofi_tool in python3 ssh scp; do
  command -v "$pasofi_tool" >/dev/null 2>&1 ||
    pasofi_stop "$pasofi_tool is required. Follow MAC_DEPLOY.md, then run the launcher again."
done
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  pasofi_stop 'Python 3.9 or newer is required. The launcher does not install software.'
fi

printf 'Existing SSH alias: '
IFS= read -r pasofi_host || pasofi_stop 'No SSH alias was entered.'
case "$pasofi_host" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.@-]*)
    pasofi_stop 'Use an existing SSH alias; keep ports and identity files in your SSH configuration.' ;;
esac

pasofi_args=(--host "$pasofi_host"
  --manifest "$pasofi_script_dir/release.json"
  --archive "$pasofi_script_dir/source.tar.gz")
pasofi_env_count=0
printf '\nEnter existing absolute environment-file paths on the server, in their original order.\n'
printf 'Enter one path per line, without surrounding quotes; spaces are preserved.\n'
printf 'After the last path, press Return on an empty line.\n'
while :; do
  printf 'Server environment file %s: ' "$((pasofi_env_count + 1))"
  IFS= read -r pasofi_env_path || pasofi_stop 'Environment-file input ended before the list was completed.'
  if [ -z "$pasofi_env_path" ]; then
    [ "$pasofi_env_count" -gt 0 ] || pasofi_stop 'At least one existing server environment file is required.'
    break
  fi
  case "$pasofi_env_path" in
    /*) ;;
    *) pasofi_stop 'Use an existing absolute path on the server, starting with /.' ;;
  esac
  pasofi_args+=(--env-file "$pasofi_env_path")
  pasofi_env_count=$((pasofi_env_count + 1))
done

printf '\nPostgreSQL system identifier from the retained installation/backup record: '
IFS= read -r pasofi_database_id || pasofi_stop 'No retained database identifier was entered.'
case "$pasofi_database_id" in
  ''|*[!0-9]*) pasofi_stop 'The retained PostgreSQL system identifier must contain digits only.' ;;
esac
if [ "${#pasofi_database_id}" -lt 10 ] || [ "${#pasofi_database_id}" -gt 30 ]; then
  pasofi_stop 'Use the complete PostgreSQL system identifier from your retained record.'
fi
pasofi_args+=(--expected-database-id "$pasofi_database_id")

printf '\nExisting Compose project (optional; press Return to discover it): '
IFS= read -r pasofi_project || pasofi_stop 'Project selection was interrupted.'
if [ -n "$pasofi_project" ]; then
  case "$pasofi_project" in
    [!a-z0-9]*|*[!a-z0-9_-]*) pasofi_stop 'Use the existing lowercase Compose project name.' ;;
  esac
  pasofi_args+=(--project "$pasofi_project")
fi

printf '\nRunning preflight. Review the reported project, release and selected services.\n\n'
if /bin/bash "$pasofi_script_dir/release-deploy.sh" "${pasofi_args[@]}"; then
  :
else
  pasofi_preflight_status=$?
  printf '\nPreflight did not pass. Resolve the reported issue before trying again.\n' >&2
  exit "$pasofi_preflight_status"
fi

printf '\nPreflight passed. Apply will build images, run owned migrations and update selected services.\n'
printf 'Type APPLY exactly to continue, or press Return to finish after preflight: '
if ! IFS= read -r pasofi_confirmation; then
  printf '\nFinished after preflight; apply was not requested.\n'
  exit 0
fi
if [ "$pasofi_confirmation" != 'APPLY' ]; then
  printf '\nFinished after preflight; apply was not requested.\n'
  exit 0
fi

printf '\nRunning apply with the same inputs. The deployment engine repeats preflight.\n\n'
if /bin/bash "$pasofi_script_dir/release-deploy.sh" "${pasofi_args[@]}" --apply; then
  printf '\nDeployment command completed. Follow the acceptance steps in MAC_DEPLOY.md and ROUTER_FLEET.md.\n'
else
  pasofi_apply_status=$?
  printf '\nApply stopped. Some operations may have completed; review the private server record before retrying.\n' >&2
  exit "$pasofi_apply_status"
fi
