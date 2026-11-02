package com.sera.tosleep

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.app.PendingIntent
import android.os.PowerManager
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * 原生闹钟模块：熄屏时 JS 定时器会被暂停，
 * 延迟到期需要靠 AlarmManager 唤醒进程并拉起 app。
 */
class WakeAlarmModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "WakeAlarm"

  private fun pendingIntent(context: Context): PendingIntent {
    val intent = Intent(context, WakeAlarmReceiver::class.java)
    return PendingIntent.getBroadcast(
      context,
      1001,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  @ReactMethod
  fun scheduleWake(triggerAtMs: Double) {
    val context = reactApplicationContext
    val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val pending = pendingIntent(context)
    am.cancel(pending)
    val triggerAt = triggerAtMs.toLong()
    try {
      am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
      Log.i("WakeAlarm", "exact alarm scheduled at $triggerAt")
    } catch (e: SecurityException) {
      // 无精确闹钟权限时退化为非精确闹钟（Doze 下可能有几分钟误差）
      am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
      Log.i("WakeAlarm", "inexact alarm scheduled at $triggerAt")
    }
  }

  @ReactMethod
  fun cancelWake() {
    val context = reactApplicationContext
    val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    am.cancel(pendingIntent(context))
    Log.i("WakeAlarm", "alarm cancelled")
  }

  /** 点亮屏幕（熄屏时的闹钟触发路径使用；亮屏状态下为 no-op） */
  @ReactMethod
  fun wakeUpScreen() {
    val pm = reactApplicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (pm.isInteractive) return
    @Suppress("DEPRECATION")
    val wakeLock = pm.newWakeLock(
      PowerManager.SCREEN_BRIGHT_WAKE_LOCK
        or PowerManager.ACQUIRE_CAUSES_WAKEUP
        or PowerManager.ON_AFTER_RELEASE,
      "tosleep:WakeUpScreen",
    )
    // 10 秒后自动释放，只负责点亮，不保持常亮
    wakeLock.acquire(10_000L)
    Log.i("WakeAlarm", "screen woken up")
  }

  /** 读取持久化的设置 JSON（每日开启/关闭时间等） */
  @ReactMethod
  fun getSettings(promise: Promise) {
    val prefs = reactApplicationContext.getSharedPreferences("tosleep_settings", Context.MODE_PRIVATE)
    promise.resolve(prefs.getString("json", null))
  }

  /** 持久化设置 JSON */
  @ReactMethod
  fun setSettings(json: String, promise: Promise) {
    val prefs = reactApplicationContext.getSharedPreferences("tosleep_settings", Context.MODE_PRIVATE)
    prefs.edit().putString("json", json).apply()
    Log.i("WakeAlarm", "settings saved: $json")
    promise.resolve(true)
  }
}
