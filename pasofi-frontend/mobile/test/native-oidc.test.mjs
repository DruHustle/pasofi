import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { callback, flowKey, finishNativeSignIn, isNativeCallback, startNativeSignIn } from '../src/native-oidc.ts';

for (const platform of ['ios', 'android'])
  test(platform + ' uses public-client S256, exact callback and its saved customer screen', async () => {
    const issuer = 'https://id.example.invalid/',
      registration = {
        issuer,
        audience: 'https://api.pasofi.example.invalid',
        ios: 'test_pasofi_ios_client',
        android: 'test_pasofi_android_client',
      };
    const db = new Map(),
      storage = {
        setItem: (k, v) => db.set(k, v),
        getItem: (k) => db.get(k) ?? null,
        removeItem: (k) => db.delete(k),
      };
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let auth,
      exchanges = 0;
    function jwt(body) {
      const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
      const input = encode({ alg: 'RS256', kid: 'primary' }) + '.' + encode(body);
      return input + '.' + sign('sha256', Buffer.from(input), keys.privateKey).toString('base64url');
    }
    const fetch = async (url, init) => {
      if (String(url) === issuer + '.well-known/openid-configuration')
        return Response.json({
          issuer,
          authorization_endpoint: issuer + 'authorize',
          token_endpoint: issuer + 'token',
          jwks_uri: issuer + 'keys',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        });
      if (String(url) === issuer + 'keys')
        return Response.json({
          keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'primary', use: 'sig', alg: 'RS256' }],
        });
      assert.equal(String(url), issuer + 'token');
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('redirect_uri'), callback);
      assert.equal(form.get('client_id'), registration[platform]);
      assert.ok(!form.has('client_secret'));
      assert.ok(!new Headers(init.headers).has('authorization'));
      assert.equal(
        createHash('sha256').update(form.get('code_verifier')).digest('base64url'),
        auth.get('code_challenge'),
      );
      const now = Math.floor(Date.now() / 1000);
      exchanges++;
      return Response.json({
        token_type: 'Bearer',
        access_token: 'product-resource-token',
        id_token: jwt({
          sub: 'approved-user',
          iss: issuer,
          aud: registration[platform],
          nonce: auth.get('nonce'),
          iat: now,
          exp: now + 180,
        }),
      });
    };
    const url = new URL(await startNativeSignIn(registration, platform, 'history', storage, fetch));
    auth = url.searchParams;
    assert.equal(url.origin + '/', issuer);
    assert.equal(auth.get('code_challenge_method'), 'S256');
    assert.equal(auth.get('audience'), registration.audience);
    assert.equal(auth.get('redirect_uri'), callback);
    assert.equal(auth.get('response_type'), 'code');
    const deep = callback + '?code=public-code&state=' + auth.get('state');
    for (const bad of [deep.replace('login', 'other'), deep.replace('callback', 'wrong'), deep + '#fragment'])
      assert.equal(isNativeCallback(bad), false);
    await assert.rejects(
      finishNativeSignIn(
        registration,
        platform,
        callback + '?code=x&state=other',
        storage,
        () => assert.fail(),
        fetch,
      ),
    );
    assert.equal(exchanges, 0);
    assert.ok(storage.getItem(flowKey));
    let received;
    assert.equal(
      await finishNativeSignIn(
        registration,
        platform,
        deep,
        storage,
        async (access, device) => {
          received = [access, device];
        },
        fetch,
      ),
      'history',
    );
    assert.deepEqual(received, ['product-resource-token', platform]);
    assert.equal(storage.getItem(flowKey), null);
    await assert.rejects(finishNativeSignIn(registration, platform, deep, storage, () => assert.fail(), fetch));
    assert.equal(exchanges, 1);
  });
