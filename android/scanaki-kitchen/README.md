# Scanaki for Android

One native Android shell for Scanaki on phones and tablets, including the Kitchen Display System.

## MVP behaviour

- Opens `https://scanaki.uk/` with Home, Kitchen, Scan Tag and Print controls. Existing role permissions still apply.
- Allows navigation only to HTTPS pages on `scanaki.uk`.
- Keeps the screen awake and supports device orientation.
- Preserves the secure Scanaki login session using WebView cookies.
- Enables JavaScript, DOM storage and automatic audio playback for KDS alerts.
- Supports trusted-origin camera permission and system file selection; rejects unrelated permissions and clear-text network traffic.
- NFC is optional: devices without a reader show an unavailable message, without blocking other features.
- Reads Scanaki HTTPS NDEF tags and supports explicitly confirmed writes to writable NDEF-formatted tags. Navigation and backgrounding cancel pending operations.
- Camera permission results are completed only after resume and a fresh origin/permission check.
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
front/public/downloads/scanaki-0.4.0.apk
```

Back up the private signing directory securely. Every future APK using the package name
`uk.scanaki.kitchen` must use the same signing key so Android can install it as an update.

## Pilot evidence and remaining checks

Version 0.4.0 was installed on the NFC phone and non-NFC tablet. The tablet's unavailable
message and phone reader prompt were observed. The operator confirmed a physical phone
scan opened the correct table/menu. Android printer selection opened on the tablet.
Physical tag writing, paper output, and first-time camera approval still need end-to-end
verification. These observations do not close Phase 2 or certify every application flow.
