package com.coderred.redterm.androidpaste

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
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

class RedtermSessionForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        if (action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val sessionCount = intent?.getIntExtra(EXTRA_SESSION_COUNT, 1) ?: 1
        val title = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() }
            ?: "RedTerm - Connection active"
        val text = intent?.getStringExtra(EXTRA_TEXT)?.takeIf { it.isNotBlank() }
            ?: "SSH session is kept alive in the background"

        ensureChannel()
        val notification = buildNotification(sessionCount, title, text)
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                } else {
                    0
                }
            )
        } catch (e: Exception) {
            android.util.Log.e("RedtermFGService", "Failed to start foreground: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            "RedTerm Session",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps SSH connections alive in the background"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(sessionCount: Int, title: String, text: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(
                NotificationCompat.BigTextStyle().bigText(
                    if (sessionCount > 1) {
                        "$text\nActive sessions: $sessionCount"
                    } else {
                        text
                    }
                )
            )
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "redterm-session-foreground"
        private const val NOTIFICATION_ID = 1001
        private const val EXTRA_SESSION_COUNT = "session_count"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"

        const val ACTION_START = "com.coderred.redterm.androidpaste.action.START_FOREGROUND"
        const val ACTION_STOP = "com.coderred.redterm.androidpaste.action.STOP_FOREGROUND"

        fun startIntent(context: Context, sessionCount: Int, title: String, text: String): Intent =
            Intent(context, RedtermSessionForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_SESSION_COUNT, sessionCount)
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_TEXT, text)
            }

        fun stopIntent(context: Context): Intent =
            Intent(context, RedtermSessionForegroundService::class.java).apply {
                action = ACTION_STOP
            }
    }
}
