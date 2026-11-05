package expo.modules.t3agentnotifications

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3AgentNotifications")

    Events("onWatchTick")

    OnCreate { AgentWatchService.onTick = { sendEvent("onWatchTick") } }

    OnDestroy { AgentWatchService.onTick = null }

    Function("configure") {
        deviceId: String,
        userId: String,
        scheme: String,
        ongoingEnabled: Boolean
      ->
      appContext.reactContext?.let {
        AgentNotifications.configure(it, deviceId, userId, scheme, ongoingEnabled)
      }
    }

    Function("clear") {
      appContext.reactContext?.let { AgentNotifications.clear(it) }
    }

    Function("showShowcaseActivity") { scheme: String, data: Map<String, String> ->
      appContext.reactContext?.let { AgentNotifications.showcase(it, scheme, data) }
    }

    Function("setThreadOnScreen") { path: String? ->
      AgentNotifications.setThreadOnScreen(path)
    }

    Function("setLocalUpdatesEnabled") { enabled: Boolean, scheme: String ->
      appContext.reactContext?.let { AgentNotifications.setLocalEnabled(it, enabled, scheme) }
    }

    Function("showLocalActivity") { scheme: String, data: Map<String, String> ->
      appContext.reactContext?.let { AgentNotifications.receiveLocal(it, scheme, data) }
    }

    Function("startBackgroundWatch") {
      appContext.reactContext?.let { AgentWatchService.start(it) } ?: false
    }

    Function("stopBackgroundWatch") {
      appContext.reactContext?.let { AgentWatchService.stop(it) }
    }

    Function("isIgnoringBatteryOptimizations") {
      appContext.reactContext?.let {
        it.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(it.packageName)
      } ?: false
    }

    Function("requestIgnoreBatteryOptimizations") {
      val context = appContext.reactContext
      if (context == null) {
        false
      } else {
        try {
          context.startActivity(
            Intent(
              Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
              Uri.parse("package:${context.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      }
    }

    Function("openLiveUpdateSettings") {
      val context = appContext.reactContext
      if (context == null || Build.VERSION.SDK_INT < 36) {
        false
      } else {
        try {
          context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
              .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      }
    }
  }
}
