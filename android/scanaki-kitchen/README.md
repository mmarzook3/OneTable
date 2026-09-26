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
front/public/downloads/scanaki-0.5.0.apk
```

Back up the private signing directory securely. Every future APK using the package name
`uk.scanaki.kitchen` must use the same signing key so Android can install it as an update.

## Pilot evidence and remaining checks

### Permanent venue printing (0.5.0)

Open **Print > Printer setup / status**. An administrator creates a dedicated
agent in Scanaki Settings > Printing and securely enters its one-time token on
this tablet. Do not reuse another device's token. Enter the printer's private LAN
IPv4 address and TCP port (KP80B-USE pilot: `192.168.55.20:9100`). Stop the laptop
agent before enabling the tablet's agent; revoke the old registration after the
tablet handoff passes. Both receipt and kitchen roles use this single printer.

The token is encrypted with Android Keystore, never exposed to the WebView, and
excluded from Android backups. The app keeps only job IDs and send outcomes in
its durable recovery journal, not ticket/customer content. The foreground service
has a persistent status notification and continues without the Kitchen page open.
Enabled printing restarts after reboot and first unlock, or after an app update.
Android force-stop still requires reopening Scanaki. Grant notification permission
and allow unrestricted battery/background operation and OEM auto-launch. Keep the
tablet powered on the same LAN as the printer; cellular internet cannot replace
the printer's local Wi-Fi connection. No public printer port is required.

Creating/loading an order does not print: the existing first Start swipe creates
one queue job; order print icons create explicit copies. No printer bytes are
sent by setup/connectivity probes. The tablet probes the printer before claiming
new work, and acknowledges each ticket only after attempting its socket write.
Successful TCP writing is not physical-paper proof. Unknown/partial writes and
unrecorded claims after interruption are failed conservatively, not automatically
reprinted. Check the paper and use a manual reprint if needed. A lost completion
response is retried as an acknowledgement only. Pairing cannot be changed while
unresolved local recovery records remain; restore the old pairing's connection or
ask the operator to reconcile its queue before replacing credentials.

Before customer GO, test paper/cut, backgrounding, app/process restart, reboot and
unlock, printer/Wi-Fi interruption, and recovery without duplicate tickets.
Automated tests do not substitute for this physical acceptance.

Version 0.4.0 was installed on the NFC phone and non-NFC tablet. The tablet's unavailable
message and phone reader prompt were observed. The operator confirmed a physical phone
scan opened the correct table/menu. Android printer selection opened on the tablet.
Physical tag writing, paper output, and first-time camera approval still need end-to-end
verification. These observations do not close Phase 2 or certify every application flow.
