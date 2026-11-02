# Kiosk 模式使用教程

本文档教你从零理解并使用 Android Kiosk（锁定任务）模式，以及在本项目（ToSleep）中如何正确启用它。

---

## 1. 什么是 Kiosk 模式

Kiosk 模式（官方称 **Lock Task Mode**，锁定任务模式）让一台 Android 设备只运行你的应用，用户无法：

- 按 Home 键返回桌面
- 打开其他应用、通知栏
- 退出当前应用（除非你的代码调用解锁，或系统策略允许）

典型场景：专用设备（POS 机、电子价签、酒店床头屏）、家长管控、"睡眠锁定"（本项目）。

Android 提供的底层 API 是 `Activity.startLockTask()`，本项目通过 `react-native-kiosk-manager` 库调用它。

---

## 2. 前置条件：device owner（必须）

`startLockTask()` 的行为取决于应用的权限等级：

| 应用权限 | 调用 startLockTask() 的效果 |
|---|---|
| 普通应用 | 弹出系统"屏幕固定"确认框，**用户手动确认后**才锁定；文字、样式不可自定义 |
| **Device Owner（设备所有者）** | **直接锁定，不弹任何框** ✅ 本项目采用 |

### 2.1 设置 device owner

通过 adb 将应用设为设备所有者（模拟器或测试机均可）：

```bash
# 1. 先安装 app（确保已安装且未启动过其他账号环境）
adb install app-debug.apk

# 2. 设置 device owner（在首次启动 app 之前执行）
adb shell dpm set-device-owner 'com.sera.tosleep/com.riuhou.kioskmanager.DeviceAdminReceiver'
```

成功会输出：

```
Success: Device owner set to package com.sera.tosleep/com.riuhou.kioskmanager.DeviceAdminReceiver
```

### 2.2 常见报错与解决

| 报错 | 原因 | 解决 |
|---|---|---|
| `Not active admin` 且提示 `was already an admin` | 组件类名写错，或 admin 状态残留 | **确认类名是 `com.riuhou.kioskmanager.DeviceAdminReceiver`**（不是 `com.kioskmanager`）；若类名正确仍报错，卸载重装 app 后立刻执行 |
| `Not allowed to set the device owner because there are already some accounts on the device` | 设备上存在账号 | 设置 → 账号 全部移除，或模拟器 wipe data |
| `remove-active-admin` 报 SecurityException | 非测试型 admin 无法用 shell 移除 | 卸载 app 即可连带清除 admin 状态 |

### 2.3 验证

```bash
adb shell dumpsys device_policy | grep "Device Owner Type"
# Device Owner Type: 0   → 已是 device owner ✅（-1 表示不是）

adb shell dumpsys activity | grep mLockTaskModeState
# mLockTaskModeState=NONE     → 未锁定
# mLockTaskModeState=LOCKED   → 正在锁定 ✅
```

---

## 3. 在代码中使用

### 3.1 锁定与解锁

`react-native-kiosk-manager` 暴露两个核心方法：

```tsx
import KioskManager from 'react-native-kiosk-manager';

// 进入 kiosk（device owner 下直接锁定，无弹窗）
KioskManager.startKiosk();

// 退出 kiosk
KioskManager.stopKiosk();
```

原生实现（库内 `KioskManagerModule.kt`）等价于：

```kotlin
val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
if (am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
    activity.startLockTask()
}
```

### 3.2 本项目的封装（App.tsx）

本项目不直接裸调这两个方法，而是走带完整生命周期的 `startSession`：

```tsx
const startSession = useCallback(() => {
  KioskManager.startKiosk();              // 1. 进入锁定
  // 2. 计算到每日关闭时间的倒计时秒数（支持跨天，如 22:10 开、06:30 关）
  const total = Math.max(1, Math.floor((off.getTime() - now.getTime()) / 1000));
  setRunning(true);
  setSeconds(total);
  timerRef.current = setInterval(() => {  // 3. 每秒递减
    setSeconds(prev => {
      if (prev <= 1) {
        KioskManager.stopKiosk();          // 4. 归零自动解锁
        return 0;
      }
      return prev - 1;
    });
  }, 1000);
}, []);
```

调用入口有两处：

| 入口 | 触发条件 | 弹确认窗？ |
|---|---|---|
| 定时自动触发 | 每日开启时间到（或延迟到期），原生闹钟唤醒 App | 是（用户点"开始锁定"才真正锁定） |
| 手动"立即开始专注" | 用户点首页按钮 | 是 |

### 3.3 完整用户流程

```
到达开启时间
   ↓ 原生闹钟唤醒（熄屏时）→ 点亮屏幕 → App 回前台
确认弹窗「🌙 准备入睡」
   ├─ 开始锁定 ──→ kiosk 锁定 + 倒计时 ──→ 归零自动解锁（当天不再弹窗）
   ├─ 再睡 5 分钟 ──→ 推迟触发（最多 3 次，用尽后只能锁定）
   └─ 暂不锁定 ──→ 手动触发=直接关闭；自动触发=消耗一次延迟
```

---

## 4. 锁定状态下的注意事项

- **锁定期间 App 必须保持可用**：如果 App 崩溃或被杀，普通应用用户会卡在最后的画面（按 Home 无效）。debug 时可用 `adb shell input keyevent KEYCODE_HOME` 验证是否真的锁住。
- **解锁兜底**：真机上如果被锁死，可用 adb 强制停止 kiosk：`adb shell am force-stop com.sera.tosleep`（device owner 时不一定生效，此时重启设备或 `dpm remove-active-admin`）。
- **屏幕常亮**：kiosk 场景建议锁定期间保持屏幕常亮（可用 `setTurnScreenOn` / wake lock，或让用户插电）。
- **device owner 在重装后依然保留**：`adb install -r` 更新不需要重新执行 set-device-owner；只有卸载重装才需要。

---

## 5. 常见问题排查

| 现象 | 排查步骤 |
|---|---|
| 点了开始锁定没反应 | ① 是否 device owner（见 2.3）② Metro 是否连接（断连时 JS 正常跑但日志消失）③ `adb shell dumpsys activity \| grep mLockTaskModeState` 看状态 |
| 弹出系统"屏幕固定"确认框 | App 不是 device owner，重新执行 2.1 |
| `startLockTask` 抛 IllegalStateException | App 不在 lock task 白名单或权限不足，检查 device owner 状态 |
| 锁定后无法退出 | 正常行为；用 End 按钮（`stopKiosk`）或 adb 强停 |
| 模拟器重启后 device owner 丢失 | 正常会保留；若丢失，用 `emulator -wipe-data` 后重新配置 |

---

## 6. 相关文件

| 文件 | 作用 |
|---|---|
| `App.tsx` | `startSession` / `onPressEnd` / 确认弹窗逻辑 |
| `node_modules/react-native-kiosk-manager/android/.../KioskManagerModule.kt` | `startKiosk`/`stopKiosk` 原生实现（含本地补丁，勿随意 `yarn install`） |
| `DOCS.md` | 项目整体技术文档（熄屏唤醒、定时调度等） |
