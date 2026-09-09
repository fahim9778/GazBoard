package com.gazboard.app

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class SharingService : Service() {
  private var multicast: WifiManager.MulticastLock? = null
  override fun onCreate() {
    super.onCreate()
    channel(this)
    val stop = PendingIntent.getService(this, 2, Intent(this, SharingService::class.java).setAction("stop"),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_notification).setContentTitle("GazBoard sharing is on")
      .setContentText("Ready to exchange boards on this network")
      .setContentIntent(open(this)).setOngoing(true).setSilent(true)
      .addAction(0, "Stop sharing", stop).build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(7, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    else startForeground(7, notification)
    multicast = (applicationContext.getSystemService(WIFI_SERVICE) as WifiManager).createMulticastLock("GazBoard discovery").apply {
      setReferenceCounted(false)
      acquire()
    }
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "stop") (application as GazBoardApplication).io.execute { (application as GazBoardApplication).stopSharing() }
    // Sharing starts only from the visible app. No boot receiver or sticky
    // restart can quietly bring a classroom session back after it was closed.
    return START_NOT_STICKY
  }
  override fun onDestroy() {
    multicast?.let { if (it.isHeld) it.release() }; multicast = null
    val app = application as GazBoardApplication
    app.io.execute { if (app.node.running) app.stopSharing() }
    super.onDestroy()
  }
  override fun onTaskRemoved(rootIntent: Intent?) { (application as GazBoardApplication).io.execute { (application as GazBoardApplication).stopSharing() }; stopSelf() }
  override fun onBind(intent: Intent?): IBinder? = null
  companion object {
    private const val CHANNEL = "sharing"
    private fun channel(context: Context) {
      context.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "Local network sharing", NotificationManager.IMPORTANCE_LOW))
    }
    private fun open(context: Context): PendingIntent = PendingIntent.getActivity(context, 1,
      Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    fun showIncoming(context: Context, name: String) {
      channel(context)
      try {
        context.getSystemService(NotificationManager::class.java).notify(8, NotificationCompat.Builder(context, CHANNEL)
          .setSmallIcon(R.drawable.ic_notification).setContentTitle("$name sent a board")
          .setContentText("Open GazBoard to accept or decline it").setContentIntent(open(context)).setAutoCancel(true).build())
      } catch (_: SecurityException) { /* Notifications may be declined; the in-app question still works. */ }
    }
    fun clearIncoming(context: Context) { context.getSystemService(NotificationManager::class.java).cancel(8) }
  }
}
