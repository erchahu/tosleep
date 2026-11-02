# ToSleep — 技术文档与使用指南

一款 Android 睡眠/专注 kiosk 应用：到设定时间自动锁定设备（kiosk 模式），倒计时或到关闭时间后自动解锁。支持每日定时、确认弹窗、有限次数的延迟（贪睡）、熄屏唤醒、开机自启动和用户自定义设置。

- 包名：`com.tosleep`
- 技术栈：React Native 0.88（Fabric/新架构）+ Kotlin 原生模块 + `react-native-kiosk-manager`

---

## 一、核心技术点

### 1. Kiosk 锁定（device owner）

> 📖 单独的入门教程见 [docs/KIOSK_GUIDE.md](docs/KIOSK_GUIDE.md)（概念、device owner 配置、代码示例、排查表）。

- 锁定基于 Android Lock Task Mode（`Activity.startLockTask()`），由 `react-native-kiosk-manager` 封装。
- **必须将应用设为 device owner**，否则系统会弹"确认固定"对话框，且无法静默锁定：

  ```bash
  adb shell dpm set-device-owner 'com.tosleep/com.riuhou.kioskmanager.DeviceAdminReceiver'
  ```

  ⚠️ 注意组件类名是 `com.riuhou.kioskmanager.DeviceAdminReceiver`（库的真实命名空间），不是 `com.kioskmanager`。用错类名会出现 "already an admin / Not active admin" 的矛盾报错。
- device owner 状态下 `startKiosk()` 不弹任何系统确认框，直接进入锁定。
- 解除 device owner：`adb shell dpm remove-active-admin` 后 wipe data，或 `emulator -wipe-data`。device owner 无法被 `adb uninstall`。

### 2. 每日定时 + 确认弹窗 + 延迟（贪睡）

- 到达设定的每日开启时间后，App 自动点亮屏幕、回到前台并弹出确认窗。
- 确认窗提供 **"再睡 5 分钟"**（`SNOOZE_MINUTES`，最多 `MAX_SNOOZES = 3` 次）与 **"开始锁定"**。
- 延迟次数耗尽后进入强制模式：弹窗无法关闭、返回键失效，只能"开始锁定"。
- 自动触发时点"暂不锁定"视作消耗一次延迟（否则 20 秒后弹窗会立即重现）。
- **防重复弹窗**：用户确认锁定后，下次自动触发时间推到第二天（`nextDayTarget`），同一天不会再弹。
- JS 层每 20 秒轮询系统时间作为前台兜底；跨天自动重置延迟次数。

### 3. 熄屏唤醒（本项目最关键的原生方案）

**问题**：熄屏后 Android 会暂停 RN 的 JS 定时器（activity 进入 onPause 生命周期），纯 JS 无法在熄屏时触发任何逻辑。另外老式唤醒锁（`SCREEN_BRIGHT_WAKE_LOCK` + `ACQUIRE_CAUSES_WAKEUP`）在 Android 14+ 已失效。

**方案**（自研原生模块，位于 `android/app/src/main/java/com/tosleep/`）：

| 文件 | 职责 |
|---|---|
| `WakeAlarmModule.kt` | JS 可调用：`scheduleWake(timestamp)` / `cancelWake()` / `getSettings()` / `setSettings(json)`。用 `AlarmManager.setExactAndAllowWhileIdle` 挂精确闹钟 |
| `WakeAlarmReceiver.kt` | 闹钟触发时通过 `getLaunchIntentForPackage` 拉起 MainActivity |
| `WakeAlarmPackage.kt` | RN 包注册（已在 `MainApplication.kt` 注册） |

- `MainActivity` 在 manifest 中配置了 `showWhenLocked="true"` + `turnScreenOn="true"`：熄屏状态下启动 Activity 时由**系统自动点亮屏幕**并越过锁屏。
- 每次设置延迟、每日触发时间变化时，JS 都会同步重排原生闹钟。
- 精确闹钟权限（Android 14+ 需要授权，否则自动降级为非精确闹钟，Doze 下可能延迟数分钟）：

  ```bash
  adb shell appops set com.tosleep SCHEDULE_EXACT_ALARM allow
  ```

- ⚠️ `PendingIntent` 必须显式指定 receiver 类（`Intent(context, WakeAlarmReceiver::class.java)`）。若用隐式 action 而 receiver 又没配 intent-filter，闹钟触发后无人接收。

### 4. 设置持久化

- 设置（每日开启/关闭时间）以 JSON 存在原生 SharedPreferences（`tosleep_settings`），通过 `WakeAlarm.getSettings/setSettings` 读写，不依赖第三方存储库。
- 默认值：开启 `22:00`，关闭 `22:15`（用户保存过设置后以用户值为准）。
- 关闭时间支持跨天（如 22:10 开、06:30 关，锁定时长自动算到第二天）。

### 5. 开机自启动

- 库自带 `BootReceiver`（`com.riuhou.kioskmanager.BootReceiver`）监听 `BOOT_COMPLETED`，读取 `kiosk_prefs` 的 `boot_auto_start`（默认 true）后拉起 App。
- device owner 豁免 Android 10+ 的"后台启动 Activity"限制。
- 注意：`BOOT_COMPLETED` 对第三方应用是**分批延迟投递**的，开机后约 2-3 分钟 App 才会被拉起，属正常现象。想更快可把 App 设为 Home 应用。

### 6. 已知坑（重要）

| 坑 | 说明 |
|---|---|
| `react-native-kiosk-manager` 需本地补丁 | RN 0.88 的 `Promise` 接口是 Kotlin 且参数可空（`code: String?`），库里的 override 是非空 `String`，不改无法编译；另外本项目在库的原生侧加了 `wakeUpScreen()`。**补丁在 node_modules 内，`yarn install` 会丢失**（建议尽快用 patch-package 固化） |
| 库的 JS 入口是编译产物 | `react-native-kiosk-manager` 的运行入口是 `lib/module/`（编译产物），改 `src/` 不生效；原生 Kotlin 改 `android/src/` 直接生效 |
| Metro 断连时 console.log 不进 logcat | JS 日志"消失"≠代码没跑；原生 `Log.i` 始终可见，排查优先看原生日志 |
| force-stop 对 device owner 不可靠 | 杀进程重载 JS 用 `gradlew installDebug` 最可靠 |
| Metro 间歇掉线 | 模拟器内通过 `10.0.2.2:8088` 访问宿主 Metro，掉线时 app 表现为"没反应"，先确认 Metro 存活 |

---

## 二、环境与运行

### 环境要求

- Node >= 22.11、JDK 17+、Android SDK（compileSdk 37）、Android 模拟器或真机
- 首次安装依赖：`yarn install`（装完后必须重新应用 node_modules 补丁，见上表）

### 开发运行

```bash
yarn android --port 8088   # 构建安装并启动 Metro
```

### 模拟器完整初始化（新环境必做）

```bash
# 1. 设为 device owner（安装后、首次启动前执行）
adb shell dpm set-device-owner 'com.tosleep/com.riuhou.kioskmanager.DeviceAdminReceiver'

# 2. 授予精确闹钟权限
adb shell appops set com.tosleep SCHEDULE_EXACT_ALARM allow
```

### Release 构建

```bash
cd android && ./gradlew assembleRelease
# 产物: android/app/build/outputs/apk/release/app-release.apk
```

> release 需要签名配置；测试阶段可临时让 release 使用 debug 签名。

---

## 三、使用流程

1. **设置**：首页右上角 ⚙️（或点击首页时间胶囊）→ 调整"每日开启"/"每日关闭"时间（± 步进，分钟步进 5）→ 保存。设置持久化，重启 App/设备后保留。
2. **每日自动触发**：到达开启时间，App 自动点亮屏幕、回前台并弹确认窗。
3. **确认窗操作**：
   - **开始锁定**：进入 kiosk + 倒计时到关闭时间，结束后自动解锁；当天不再弹窗
   - **再睡 5 分钟**：延迟触发（最多 3 次）
   - **暂不锁定**：手动触发时直接关闭；自动触发时等价于消耗一次延迟
4. **手动锁定**：首页"立即开始专注"→ 确认后立即进入锁定。
5. **调试退出**：右下角 End 按钮立即解锁并清零倒计时。

---

## 四、关键文件索引

| 文件 | 说明 |
|---|---|
| `App.tsx` | 全部 UI 与调度逻辑（定时轮询、弹窗、延迟、设置、倒计时） |
| `android/app/src/main/java/com/tosleep/WakeAlarmModule.kt` | 原生闹钟 + 设置持久化 |
| `android/app/src/main/java/com/tosleep/WakeAlarmReceiver.kt` | 闹钟触发拉起 App |
| `android/app/src/main/java/com/tosleep/WakeAlarmPackage.kt` | 原生包注册 |
| `android/app/src/main/AndroidManifest.xml` | WAKE_LOCK 权限、turnScreenOn/showWhenLocked、receiver |
| `node_modules/react-native-kiosk-manager/` | kiosk 能力库（含本地补丁，见"已知坑"） |
