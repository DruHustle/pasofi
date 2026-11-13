# Distributing Pasofi on phones

## Android

Build from the release commit in this mobile directory with the supported Node and Java versions and the Android SDK. Confirm the native version code increases for an update. The Android manifest must identify `com.onesa.pasofi`.

```sh
npm ci
export VITE_PAMOFI_API_BASE_URL=https://pasofi.mobile.onesa.eu
npm run build
npx --no-install cap sync android
(cd android && bash gradlew :app:assembleRelease :app:bundleRelease)
```

Use the owner’s app-signing keystore for direct downloads. Updates to an existing installation require the same signing identity. A Play upload key is appropriate for a Play submission and may differ from the app-signing certificate on customers’ devices. If Google controls that app-signing key, use an APK signed by Google for compatible direct distribution. For a first release, create the key on an owner-controlled system, keep a protected backup and record the public SHA-256 certificate fingerprint separately.

In the signing shell, set `ANDROID_RELEASE_KEYSTORE` to the private keystore path, `ANDROID_RELEASE_ALIAS` to the key alias and `ANDROID_RELEASE_CERT_SHA256` to the independently recorded public fingerprint. Supply `ANDROID_RELEASE_STORE_PASSWORD` and `ANDROID_RELEASE_KEY_PASSWORD` through the owner’s secret manager. The credentials are needed for signing only. `ANDROID_HOME` locates Android Build Tools 36.0.0. `ANDROID_BUILD_TOOLS` can point directly to a compatible installation.

```sh
release_dir=android/app/build/outputs/apk/release
scripts/sign-release-apk.sh sign "$release_dir/app-release-unsigned.apk" "pasofi-1.0.0.apk"
scripts/sign-release-apk.sh verify "pasofi-1.0.0.apk"
```

Choose the filename for the actual version. The helper checks the package, launcher, release manifest, page alignment, APK signatures and owner certificate, then prints the file SHA-256. QA signing identities and debug builds must stay out of customer distribution. A smoke test on a supported Android phone can confirm installation and behavior on that device. Pasofi’s live customer sessions, payments, vouchers and hotspot connections each keep their existing service qualification and capability settings. An owner-signed preview can be published with those capabilities disabled. Use its public release notes to identify the offline or service-limited experience.

Upload the verified APK to `https://pasofi.mobile.onesa.eu/downloads/` or to a versioned GitHub Release asset in the product’s repository. Fetch it while signed out and compare the published bytes to the verified local file, then set the website’s `VITE_ANDROID_DOWNLOAD_URL` and `VITE_ANDROID_APK_SHA256` to the verified URL and digest. The direct button downloads the APK. Android handles the install confirmation and permission for this source.

```sh
curl --fail --location --proto '=https' --proto-redir '=https' "$PUBLIC_APK_URL" -o downloaded-release.apk
cmp "pasofi-1.0.0.apk" downloaded-release.apk
scripts/sign-release-apk.sh verify downloaded-release.apk
```

With Android SDK Platform 36 and Build Tools 36.0.0 installed, run `python3 scripts/test-release-apk.py` to exercise signing and rejection of tampered, debuggable and incorrectly signed samples. The test deletes its temporary files and disposable key.

### Google Play App Bundle

The **Android release packaging** workflow on main builds and validates the unsigned Play input with production web assets. Download the `pasofi-android-unsigned-play-input-<commit>` GitHub Actions artifact, check `SOURCE_COMMIT.txt` against the intended main revision, and run `sha256sum --check SHA256SUMS.txt` from the extracted directory. The included `PasoFi-unsigned.aab` is the owner-signing input. A local build produces the same input at `android/app/build/outputs/bundle/release/app-release.aab`. Use JDK 21, Python 3.11+, OpenSSL and the workflow’s checksum-pinned Google bundletool JAR. Set `BUNDLETOOL_JAR` to that verified JAR.

Use the **upload key certificate** SHA-256 fingerprint independently obtained from Play Console’s App integrity page for this app. Set `ANDROID_PLAY_UPLOAD_CERT_SHA256` to that fingerprint, `ANDROID_PLAY_UPLOAD_KEYSTORE` to the registered upload keystore path, and `ANDROID_PLAY_UPLOAD_ALIAS` to its alias. Supply `ANDROID_PLAY_UPLOAD_STORE_PASSWORD` and `ANDROID_PLAY_UPLOAD_KEY_PASSWORD` through the owner’s secret manager. From the mobile directory, run the following with the actual paths and version.

```sh
python3 scripts/release-bundle.py inspect-unsigned /path/to/PasoFi-unsigned.aab
python3 scripts/release-bundle.py sign /path/to/PasoFi-unsigned.aab /path/to/PasoFi-upload.aab
python3 scripts/release-bundle.py verify /path/to/PasoFi-upload.aab
```

Verification requires only the bundle, bundletool and the independently recorded public fingerprint. The helper checks Google’s bundle validation, the PasoFi package and launcher, target SDK, production customer origin, embedded web assets and the signature over the bundle contents. Upload the verified owner-signed AAB to the intended Play Console release track, check its version code against prior uploads, and complete review. A public store link requires a published listing.

## iOS

Register `com.onesa.pasofi` with the owner’s Apple Developer team and create the matching App Store Connect record. Select that team in Xcode and configure the app’s release signing and distribution profile. Apple Pay entitlements default to empty. The public gateway governs customer, checkout and hotspot capabilities independently of signing. CI simulator apps cannot be installed through TestFlight or the App Store.

On a Mac with the supported Xcode and a signed-in owner account, set `APPLE_TEAM_ID` to the team identifier. From this mobile directory create a Release archive for a physical iOS destination.

```sh
npm ci
export VITE_PAMOFI_API_BASE_URL=https://pasofi.mobile.onesa.eu
npm run build
npx --no-install cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$PWD/build/pasofi.xcarchive" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic archive
```

In Xcode Organizer, validate the archive and distribute to App Store Connect with the owner’s distribution signing. For public beta installs, complete external TestFlight review and enable a public invitation. For general availability, complete App Review and release the listing. Open the actual link from a signed-out iPhone and verify it identifies Pasofi before setting the website’s `VITE_IOS_DOWNLOAD_URL` to its public TestFlight or App Store URL. The current native projects use the same product identifier for preview and release.
