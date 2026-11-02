# PamoFi native build previews

The mobile source is `pamofi-frontend/mobile`. The checked-in native projects are `android` and `ios`; the Capacitor application ID is `com.onesa.pamofi`. There is no separate `pamofi-mobile` source folder.

The `Build PamoFi native previews` workflow compiles fresh web assets, runs the pinned Capacitor 8.6.0 synchronization, then independently builds Android and iOS. A successful job uploads its binary, exact source commit, toolchain version and SHA-256 checksum for 14 days. A workflow definition or successful web build alone does not mean a native binary has been built: inspect the native job result and its artifact.

## Recorded native checkpoints

Both jobs succeeded in [workflow run 41378312413](https://github.com/DruHustle/pamofi/actions/runs/41378312413) for published head `64277e5e6d5442d3d4e335259a8da816f3ce621f`. GitHub compiled merge source `84a44994c025e625aa3c7ba5b40f8ddfa6a54225`, which is recorded with the artifacts. This checkpoint includes the cash-first customer flow and live usage display.

| Output | Artifact | Uploaded archive size | Uploaded archive SHA-256 |
| --- | --- | --- | --- |
| API-unconfigured Android debug APK | [13112510744](https://github.com/DruHustle/pamofi/actions/runs/41378312413/artifacts/13112510744) | 3,958,288 bytes | `2cfd6587d12d2397396b266b861194ad1cee99fcf9e2eb024b3c320601af58e2` |
| Unsigned iOS simulator app | [13112361645](https://github.com/DruHustle/pamofi/actions/runs/41378312413/artifacts/13112361645) | 1,507,604 bytes | `9e2c7a70a001874efd1a678bbe100a61f73ffcfab9ddff6367f7003fe8ef4be0` |

These artifacts expire on **16 November 2026**. Xcode 26.6 built the iOS preview for arm64 and x86_64 simulator. The earlier [run 41375913293](https://github.com/DruHustle/pamofi/actions/runs/41375913293), for source checkpoint `cd7399af`, also passed both jobs. Consult the pull request and Actions for subsequent exact-source results; artifact names and bundled source metadata identify each actual compiled revision. Native builds remain separate from cookie/device qualification and production signing.

### Earlier verified artifact record

Both native compilation jobs succeeded on **2026-11-02** in [workflow run 41373579356](https://github.com/DruHustle/pamofi/actions/runs/41373579356). The branch head was `649a5625dec4ec69715aa0225ae4a022ad407ddd`; the pull-request workflow compiled GitHub's merge commit `443cab073457bfdf238788daf08e38202c6af279`, which appears in the artifact names and source metadata.

| Output | Artifact | Uploaded archive size | Evidence |
| --- | --- | --- | --- |
| Android debug APK | [13110367862](https://github.com/DruHustle/pamofi/actions/runs/41373579356/artifacts/13110367862) | 3,949,802 bytes | Gradle 8.14.3 reported BUILD SUCCESSFUL; artifact upload completed. |
| Unsigned iOS simulator app | [13110560776](https://github.com/DruHustle/pamofi/actions/runs/41373579356/artifacts/13110560776) | 1,501,207 bytes | Xcode 26.6 reported BUILD SUCCEEDED for arm64 and x86_64 simulator; artifact upload completed. |

These GitHub artifacts expire on **2026-11-16**. The uploaded archive SHA-256 digests are `ada54f0961f0aa292fc2715bf21a1452da6eb7d06992e75052cc2b60bbc62f13` (Android) and `826e780d46dff3a61825ab95570b4ec453e1d16dcbfb8d89c79c0452b2c8e332` (iOS). Each archive also contains a checksum for its enclosed native binary/archive. The limitations below still apply: this run proves native compilation and packaging, not device behavior or connected production service acceptance.

## What the artifacts are

- Android: a debug APK signed with the disposable Android debug key. It is not a release-signed APK/AAB or a Google Play submission.
- iOS: an unsigned simulator `App.app` inside a tar archive, preserving executable permissions. It is not a device-installable IPA, TestFlight build or App Store submission. Use an iOS simulator compatible with the artifact's architecture and SDK.
- Both are **API-unconfigured previews**. The workflow explicitly leaves `VITE_PAMOFI_API_BASE_URL` empty, so the app cannot submit credentials, perform purchases, send SMS or connect through a backend. No provider or signing secrets are used.

The customer interface supports an explicitly configured HTTPS gateway, but that configuration alone does not qualify secure cross-origin cookies on real iOS/Android WebViews. Backend CORS/session configuration, real-device cookie behavior, recovery, network transitions and accessibility require separate acceptance before building a connected release. The current service capability keeps `mobileCookies` false until that work is qualified.

## Toolchains and local commands

Capacitor 8 requires Node 22 or later, Xcode 26 or later and an iOS 15 minimum deployment target. The Android project uses Java 21, SDK 36 (minimum device API 24), AGP 8.13.0 and the checked-in Gradle 8.14.3 wrapper. The workflow uses Node 24.22.1, Java 21 and a macOS 26 runner whose Xcode version is checked at runtime.

From this directory, build Android after installing Java 21 and the Android 36 SDK:

```sh
npm ci
npm run build
npx --no-install cap sync android
cd android
bash ./gradlew --no-daemon :app:assembleDebug
```

For the unsigned iOS simulator build on a Mac with Xcode 26 or later:

```sh
npm ci
npm run build
npx --no-install cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath native-build/ios \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM= ONLY_ACTIVE_ARCH=NO build
```

Official requirements: [Capacitor 8 migration guide](https://capacitorjs.com/docs/updating/8-0) and [environment setup](https://capacitorjs.com/docs/getting-started/environment-setup). The official GitHub [macOS 26 runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md) documents installed Xcode versions. Workflow actions are pinned to verified commits in the official `actions` repositories.
