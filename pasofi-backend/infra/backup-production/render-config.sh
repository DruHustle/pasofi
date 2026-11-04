#!/bin/sh
set -eu
# Generate a private config file, never emit credentials to stdout or argv.
target=${1:?Supply a private output path}
fail() { printf 'Invalid or missing independent backup configuration: %s\n' "$1" >&2; exit 1; }
read_secret() {
 [ -f "$1" ] || fail secret_file
 value=$(cat "$1")
 [ ${#value} -ge "$2" ] && [ ${#value} -le 512 ] || fail secret_length
 case "$value" in *[!a-zA-Z0-9_+/=-]*) fail secret_format;; esac
 printf '%s' "$value"
}
bucket=${B2_BUCKET:?B2_BUCKET is required}
region=${B2_REGION:?B2_REGION is required}
prefix=${BACKUP_REPOSITORY_PREFIX:?BACKUP_REPOSITORY_PREFIX is required}
case "$bucket" in ''|*[!a-z0-9.-]*) fail bucket;; esac
case "$region" in ''|*[!a-z0-9-]*) fail region;; esac
case "$prefix" in /*) ;; *) fail prefix;; esac
case "$prefix" in *[!a-zA-Z0-9_/-]*|*..*) fail prefix;; esac
key_id=$(read_secret "${B2_KEY_ID_FILE:?B2_KEY_ID_FILE is required}" 8)
application_key=$(read_secret "${B2_APPLICATION_KEY_FILE:?B2_APPLICATION_KEY_FILE is required}" 20)
cipher=$(read_secret "${BACKUP_CIPHER_FILE:?BACKUP_CIPHER_FILE is required}" 32)
umask 077
temporary=$(mktemp "${target}.XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
{
 printf '[global]\nrepo1-type=s3\nrepo1-s3-bucket=%s\nrepo1-s3-endpoint=s3.%s.backblazeb2.com\nrepo1-s3-region=%s\n' "$bucket" "$region" "$region"
 printf 'repo1-s3-uri-style=path\nrepo1-storage-verify-tls=y\nrepo1-path=%s\n' "$prefix"
 printf 'repo1-s3-key=%s\nrepo1-s3-key-secret=%s\nrepo1-cipher-type=aes-256-cbc\nrepo1-cipher-pass=%s\n' "$key_id" "$application_key" "$cipher"
 printf 'repo1-bundle=y\nrepo1-retention-full=4\nrepo1-retention-diff=14\narchive-check=y\narchive-copy=y\nstart-fast=y\nprocess-max=2\nlog-level-console=warn\nlog-level-file=off\n'
 printf '\n[pamofi]\npg1-path=/var/lib/postgresql/data/pgdata\npg1-socket-path=/var/run/postgresql\npg1-user=pamofi_bootstrap\n'
} > "$temporary"
chmod 600 "$temporary"
mv -f -- "$temporary" "$target"
trap - EXIT HUP INT TERM
