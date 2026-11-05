# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Live Activity Updates** on iOS, **Agent Live Updates** on Android 16 and newer, or **Ongoing Agent Activity** on older Android versions to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off the same switch to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. If Live Updates don't appear on Android 16 or newer, check **Live Update Settings** in T3 Code's **Settings → Notifications**. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Push delivery requires T3 Connect, and the mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Direct connections on Android

Environments you reach over Tailscale or your local network can't send push notifications. On Android, turn on **Background Updates** in **Settings → Notifications** to keep those connections open while the app is in the background. The agent card then works the same way, without T3 Connect. Turn on **Alerts** to also get notified when an agent finishes, fails, or needs you.

Background Updates shows a quiet persistent notification while it runs, and Android may pause the connection while the phone is idle. Set T3 Code's battery usage to **Unrestricted** when prompted to keep it reliable. Reopen the app after restarting your phone or force-stopping it. Environments that already publish through T3 Connect keep using push, so you won't get duplicate alerts. iOS doesn't support this mode, because Live Activities can only be updated by push.
