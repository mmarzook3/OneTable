# Scanaki Kitchen Android MVP

## Outcome

Scanaki Kitchen `0.3.0-debug` is a native Android application shell for the existing Scanaki Kitchen Display System. It is not a PWA and does not duplicate order-processing logic. The application loads the production KDS from `https://scanaki.uk/kitchen` inside a restricted Android WebView.

## Native behaviour

1. Forces landscape orientation and immersive full-screen mode.
2. Keeps the screen awake while the application is foregrounded.
3. Preserves the secure Scanaki session in Android WebView cookies.
4. Shows a dedicated Kitchen login containing only email, password and Sign In.
5. Hides account creation, recovery, provider, courier, customer and legal links inside the native app only.
6. Redirects successful staff login and other staff routes back to `/kitchen`.
7. Allows HTTPS navigation only on `scanaki.uk` and blocks external WebView navigation.
8. Disables file/content access, third-party cookies, mixed content and WebView permission requests.
9. Allows KDS notification audio without requiring an extra tap.
10. Shows a native offline screen when internet access is lost.
11. Automatically reloads the authenticated KDS when connectivity returns.
12. Sends a native authenticated heartbeat to Scanaki every 10 seconds while the app is foregrounded.
13. Shares the same stable device identity as the browser KDS heartbeat to avoid duplicate device records.
14. Shows an immediate native warning banner when the VPS heartbeat fails.
15. Stops heartbeating when the app leaves the foreground, allowing Scanaki to flag the tablet offline.
16. Exposes Kitchen online/offline, online device count, last heartbeat and timeout in the platform tenant screen.
17. Flushes remembered-session cookies after full page loads, single-page route changes and successful native heartbeats so abrupt app termination does not lose the session.
18. Allows Kitchen feedback vibration for new orders and successful status changes.
19. Requires an animated press-and-hold before advancing a ticket; the tenant default is one second and is configurable in Display settings.
20. Locks the next ticket transition after a successful change; the tenant default is two seconds and is configurable in Display settings.

## HONOR acceptance test

Tested on 27 August 2026 using:

- Manufacturer: HONOR
- Model: HONOR Pad X8b (`NDL2-L09`)
- Android: 16 / API 36
- Display: 1200 × 1920 physical pixels, tested in forced landscape
- ADB serial: `ALDMJV6429H00568`

Passed checks:

- APK installation and cold launch
- Android 16 window/immersive-mode compatibility
- HTTPS Scanaki login and authenticated session
- Automatic redirect from the staff dashboard to Kitchen display
- Session persistence after force-stop and cold restart
- Screen `KEEP_SCREEN_ON` flag
- Live KDS clock and Active/Pending/Preparing/Ready counters
- Kitchen ticket rendering at the tablet resolution
- Touch workflow: Start → Ready → Complete
- Wi-Fi disabled: native connection-lost screen displayed
- Wi-Fi restored: authenticated KDS recovered automatically
- Android lint and debug build
- Native heartbeat build and authenticated endpoint response
- Platform Kitchen health flag updates after the 30-second stale threshold
- Production payment reconciliation after removing temporary test tickets

The temporary Kitchen password and test orders were removed after acceptance. The original password hash was restored and temporary tokens were revoked.

## Evidence

- [HONOR Kitchen display](evidence/2026-08-27-android-kitchen/honor-kds.png)
- [HONOR Kitchen-only login](evidence/2026-08-27-android-kitchen/honor-kitchen-login.png)
- [HONOR offline screen](evidence/2026-08-27-android-kitchen/honor-offline.png)
- [HONOR automatic recovery](evidence/2026-08-27-android-kitchen/honor-recovered.png)

## Build and install

Project location:

```text
android/scanaki-kitchen
```

Build:

```powershell
cd android/scanaki-kitchen
./gradlew.bat assembleDebug
```

Install to the tested HONOR tablet:

```powershell
adb -s ALDMJV6429H00568 install -r -t app/build/outputs/apk/debug/app-debug.apk
```

Prepared APK:

```text
output/scanaki-kitchen-0.3.0-debug.apk
```

## Before wider distribution

The current APK is debug-signed and intended only for the controlled pilot tablet. A wider release still requires a protected Scanaki release-signing key, release APK/AAB build, upgrade policy, managed-device/kiosk provisioning and final regression on the production tablet configuration.
