package net.keremaltaylar.fieldscape

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * 5.8: keeps the walk going with the screen locked. Android stops a backgrounded app's location
 * updates (and may stop the process) unless a foreground service with a visible notification is
 * running; this one holds location + media playback while the walk is on. The engine and the GPS
 * listener themselves stay where they are (Core, Walk) - the service only keeps the process awake.
 */
class WalkService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Walk", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while Fieldscape plays your walk"
        })
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, CHANNEL)
            .setContentTitle("Fieldscape")
            .setContentText("Playing your walk")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29)
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(1, n)
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL = "walk"
        /** Call once location is granted, from the foreground (Android refuses a location service otherwise). */
        fun start(c: Context) { runCatching { c.startForegroundService(Intent(c, WalkService::class.java)) } }
        fun stop(c: Context) { c.stopService(Intent(c, WalkService::class.java)) }
    }
}
