package com.sera.tosleep

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 闹钟触发：拉起 MainActivity。
 * MainActivity 在 manifest 中配置了 showWhenLocked + turnScreenOn，
 * 熄屏状态下启动时会由系统自动点亮屏幕。
 */
class WakeAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    Log.i("WakeAlarm", "alarm fired, launching app")
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(launch)
  }
}
