#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  echo "Usage: $0 sign UNSIGNED_RELEASE.apk OUTPUT.apk | verify SIGNED.apk" >&2
  exit 2
}
fail() { echo "$*" >&2; exit 1; }
[[ $# -ge 2 ]] || usage
mode=$1
input=$2
[[ -f "$input" ]] || fail "APK file is missing"
: "${ANDROID_RELEASE_CERT_SHA256:?Set the public SHA-256 fingerprint of the owner app-signing certificate}"
expected=$(printf '%s' "$ANDROID_RELEASE_CERT_SHA256" | tr -d ':' | tr '[:upper:]' '[:lower:]')
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "Expected certificate fingerprint must contain 64 hexadecimal digits"
tools=${ANDROID_BUILD_TOOLS:-"${ANDROID_HOME:?Set ANDROID_HOME or ANDROID_BUILD_TOOLS}/build-tools/36.0.0"}
for bin in aapt apksigner zipalign; do
  [[ -x "$tools/$bin" ]] || fail "Missing Android Build Tools executable: $bin"
done
badging=$("$tools/aapt" dump badging "$input")
package=$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<< "$badging")
[[ "$package" == 'com.onesa.pasofi' ]] || fail "APK package does not match com.onesa.pasofi"
if grep -q '^application-debuggable' <<< "$badging"; then fail "Refusing a debuggable APK"; fi
grep -q '^launchable-activity:' <<< "$badging" || fail "APK has no launcher activity"

verify() {
  "$tools/zipalign" -c -P 16 4 "$1" >/dev/null
  local receipt signer
  receipt=$("$tools/apksigner" verify --verbose --print-certs "$1")
  if grep -Eiq '^Signer #[0-9]+ certificate DN:.*CN=Android Debug([, ]|$)' <<< "$receipt"; then
    fail "Refusing an Android debug certificate"
  fi
  signer=$(sed -n 's/^Signer #[0-9][0-9]* certificate SHA-256 digest: //p' <<< "$receipt")
  [[ "$signer" == "$expected" ]] || fail "APK signer does not match the pinned owner certificate"
}

case "$mode" in
  verify)
    [[ $# == 2 ]] || usage
    verify "$input"
    shasum -a 256 "$input"
    ;;
  sign)
    [[ $# == 3 ]] || usage
    output=$3
    [[ ! -e "$output" ]] || fail "Output already exists"
    : "${ANDROID_RELEASE_KEYSTORE:?Set the owner keystore path}" "${ANDROID_RELEASE_ALIAS:?Set the signing alias}"
    : "${ANDROID_RELEASE_STORE_PASSWORD:?Set the keystore password}" "${ANDROID_RELEASE_KEY_PASSWORD:?Set the key password}"
    if "$tools/apksigner" verify "$input" >/dev/null 2>&1; then fail "Input already has a valid signature"; fi
    tmp=$(mktemp -d "$(dirname "$output")/.sign-apk.XXXXXX")
    trap 'rm -rf -- "$tmp"' EXIT
    "$tools/zipalign" -P 16 4 "$input" "$tmp/aligned.apk"
    "$tools/apksigner" sign --ks "$ANDROID_RELEASE_KEYSTORE" --ks-key-alias "$ANDROID_RELEASE_ALIAS" \
      --ks-pass env:ANDROID_RELEASE_STORE_PASSWORD --key-pass env:ANDROID_RELEASE_KEY_PASSWORD \
      --v4-signing-enabled false --out "$tmp/signed.apk" "$tmp/aligned.apk"
    verify "$tmp/signed.apk"
    # Publish the checked bytes without overwriting an existing version.
    ln "$tmp/signed.apk" "$output"
    shasum -a 256 "$output"
    ;;
  *) usage ;;
esac
