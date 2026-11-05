# Mobile notifications

Get push alerts, Live Activities, and home-screen widgets on iOS and Android when agents finish, fail, or need your approval or input.

## Prerequisites

- Sign in to **T3 Connect** on both your phone and host machine (direct/Tailscale connections alone do not deliver background push notifications).
- Enable **Publish agent activity** in **Settings → Sharing & access** on the host.
- Enable **Device Notifications** in **Settings → Notifications** on mobile (Android requires Android 7.0+ and Google Play services).

## Live updates and widgets

- **Live progress**: Enable **Live Activity Updates** (iOS), **Agent Live Updates** (Android 16+, check **Live Update Settings** if missing), or **Ongoing Agent Activity** (older Android). Finished results stay visible for up to 15 minutes.
- **Silent live updates (Android 8+)**: Keep **Ongoing agent activity** on and disable **Agent alerts** in Android system notification settings.
- **iOS widget**: Add the **Agent Activity** widget to your Home Screen or Lock Screen (refreshes when you open T3; marks unfinished work stale after 10 minutes).

## Notes

- Ordinary alerts are muted while the mobile app is in the foreground, though viewing a thread on another device does not silence your phone.
- Force-stopping T3 Code in Android system Settings pauses push delivery until you reopen the app.

## Direct connections on Android

Environments you reach over Tailscale or your local network can't send push notifications. On Android, turn on **Background Updates** in **Settings → Notifications** to keep those connections open while the app is in the background. The agent card then works the same way, without T3 Connect. Turn on **Alerts** to also get notified when an agent finishes, fails, or needs you.

Background Updates shows a quiet persistent notification while it runs, and Android may pause the connection while the phone is idle. Set T3 Code's battery usage to **Unrestricted** when prompted to keep it reliable. Reopen the app after restarting your phone or force-stopping it. Environments that already publish through T3 Connect keep using push, so you won't get duplicate alerts. iOS doesn't support this mode, because Live Activities can only be updated by push.
