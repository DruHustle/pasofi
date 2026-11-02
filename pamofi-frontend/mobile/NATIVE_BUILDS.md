# PamoFi native build previews

The mobile source is `pamofi-frontend/mobile`. The checked-in native projects are `android` and `ios`; the Capacitor application ID is `com.onesa.pamofi`. There is no separate `pamofi-mobile` source folder.

The `Build PamoFi native previews` workflow compiles fresh web assets, runs the pinned Capacitor 8.6.0 synchronization, then independently builds Android and iOS. A successful job uploads its binary, exact source commit, toolchain version and SHA-256 checksum for 14 days. A workflow definition or successful web build alone does not mean a native binary has been built: inspect the native job result and its artifact.

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
