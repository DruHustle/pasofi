#!/usr/bin/env python3
"""Create a password-protected PasoFi hotspot certificate for WinBox import.

Run interactively on the owner's Mac. The password is sent only over the
existing pinned SSH connection and is not written to disk or printed.
"""
from getpass import getpass
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

EXPECTED = '0B82C568EC209746A1BE140B9D84124AF8C46E1450257144230B68B62364E564'
HOST = 'hotspot.pasofi.onesa.eu'
CERT_DIR = '/home/ubuntu/pamofi/production/acme/config/live/pasofi-hotspot-transition'


def run(args, data, timeout=60):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True, timeout=timeout)


def make_bundle(password, expected=EXPECTED, parent='/private/tmp'):
    if len(password) < 20 or any(c in password for c in '\n\r\x00'):
        raise ValueError('Choose a password of at least 20 characters without line breaks.')
    password_bytes = password.encode('utf-8') + b'\n'
    directory = Path(tempfile.mkdtemp(prefix='pasofi-hotspot-', dir=parent))
    os.chmod(directory, 0o700)
    target = directory / 'pasofi-hotspot-transition.p12'
    try:
        command = ('sudo -n openssl pkcs12 -export '
                   f'-in {CERT_DIR}/cert.pem -inkey {CERT_DIR}/privkey.pem '
                   f'-certfile {CERT_DIR}/chain.pem -name pasofi-hotspot -passout stdin')
        result = run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12',
                      'onesa-portal-worker', command], password_bytes)
        if not result.stdout:
            raise ValueError('The certificate export was empty.')
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(result.stdout)
        chain = run(['openssl', 'pkcs12', '-in', str(target), '-nokeys',
                     '-passin', 'stdin'], password_bytes).stdout
        if chain.count(b'-----BEGIN CERTIFICATE-----') < 2:
            raise ValueError('The bundle does not contain the certificate chain.')
        leaf = run(['openssl', 'x509', '-noout', '-fingerprint', '-sha256'], chain).stdout
        fingerprint = leaf.decode('ascii').strip().split('=', 1)[-1].replace(':', '').upper()
        if fingerprint != expected:
            raise ValueError('The certificate fingerprint differs from the reviewed certificate.')
        checked = run(['openssl', 'x509', '-noout', '-checkhost', HOST], chain).stdout
        if b'does match certificate' not in checked:
            raise ValueError('The certificate does not cover the PasoFi hostname.')
        run(['openssl', 'x509', '-noout', '-checkend', '604800'], chain)
        info = run(['openssl', 'pkcs12', '-in', str(target), '-noout', '-info',
                    '-passin', 'stdin'], password_bytes)
        if b'Shrouded Keybag' not in info.stderr:
            raise ValueError('The encrypted private key is missing from the bundle.')
        return target
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise


def main():
    if not sys.stdin.isatty():
        raise SystemExit('Run this script directly in Terminal so the password stays hidden.')
    print('Choose and securely save a temporary export password of at least 20 characters.')
    first = getpass('Export password: ')
    second = getpass('Enter it again: ')
    if first != second:
        raise SystemExit('Passwords did not match; no bundle was created.')
    try:
        path = make_bundle(first)
    except (ValueError, subprocess.SubprocessError, OSError) as exc:
        raise SystemExit(f'Certificate preparation failed: {type(exc).__name__}. No bundle was saved.')
    print(f'Encrypted certificate bundle: {path}')
    print('Upload it privately to the router and use the same export password to import it.')
    print('Remove the temporary bundle from the Mac and router after the import is verified.')


if __name__ == '__main__':
    main()
