package expo.modules.t3agentnotifications

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.content.ContextCompat

/**
 * Keeps the app process at foreground priority so its environment sockets survive the
 * background. It holds no wake lock and runs no JS task; the tick only lets JS recheck
 * connections, because JS timers do not fire while the screen is off.
 */
class AgentWatchService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val tick = object : Runnable {
    override fun run() {
      onTick?.invoke()
      handler.postDelayed(this, TICK_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = AgentNotifications.watchNotification(this)
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(
        AgentNotifications.WATCH_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      )
    } else {
      startForeground(AgentNotifications.WATCH_ID, notification)
    }
    handler.removeCallbacks(tick)
    handler.postDelayed(tick, TICK_MS)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    super.onDestroy()
  }

  companion object {
    private const val TICK_MS = 120_000L

    @Volatile var onTick: (() -> Unit)? = null

    /** Android refuses to start a foreground service from the background; the caller retries. */
    fun start(context: Context): Boolean = try {
      ContextCompat.startForegroundService(context, Intent(context, AgentWatchService::class.java))
      true
    } catch (_: IllegalStateException) {
      false
    } catch (_: SecurityException) {
      false
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, AgentWatchService::class.java))
    }
  }
}
