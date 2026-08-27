# Scanaki Kitchen for Android

Minimal native Android shell for the Scanaki Kitchen Display System.

## MVP behaviour

- Opens `https://scanaki.uk/kitchen` in a restricted native WebView.
- Allows navigation only to HTTPS pages on `scanaki.uk`.
- Keeps the screen awake and uses immersive landscape mode.
- Preserves the secure Scanaki login session using WebView cookies.
- Enables JavaScript, DOM storage and automatic audio playback for KDS alerts.
- Rejects WebView permission requests and all clear-text network traffic.
- Shows a local recovery page and reloads automatically when connectivity returns.

## Build

From this directory:

```powershell
./gradlew.bat assembleDebug
```

The APK is generated at:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## Install on an authorised USB-debugging device

```powershell
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n uk.scanaki.kitchen.debug/uk.scanaki.kitchen.MainActivity
```

This first build is intended for controlled pilot distribution. Play Store signing, managed-device kiosk provisioning and automatic APK updates are separate release-hardening work.

## Signed pilot release

Release signing credentials stay in the ignored `signing/` directory and must never be committed.

Expected local files:

```text
signing/scanaki-kitchen-release.p12
signing/keystore.properties
```

Build the signed release:

```powershell
./gradlew.bat assembleRelease
```

The signed APK is generated at:

```text
app/build/outputs/apk/release/app-release.apk
```

The public pilot download copy is stored at:

```text
front/public/downloads/scanaki-kitchen-0.3.0.apk
```

Back up the private signing directory securely. Every future APK using the package name
`uk.scanaki.kitchen` must use the same signing key so Android can install it as an update.
