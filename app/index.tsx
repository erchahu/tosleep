/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import KioskManager from 'react-native-kiosk-manager';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, NativeModules, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// 原生闹钟 + 设置持久化模块（android/app/.../WakeAlarmModule.kt）
const WakeAlarm = NativeModules.WakeAlarm as
  | {
      scheduleWake: (triggerAtMs: number) => void;
      cancelWake: () => void;
      wakeUpScreen: () => void;
      getSettings: () => Promise<string | null>;
      setSettings: (json: string) => Promise<boolean>;
    }
  | undefined;

type Settings = {
  onHour: number; // 每日自动开启 - 时
  onMin: number; // 每日自动开启 - 分
  offHour: number; // 每日自动关闭 - 时
  offMin: number; // 每日自动关闭 - 分
};

// ==== 默认配置（可在设置模块中修改并持久化） ====
const DEFAULT_SETTINGS: Settings = { onHour: 22, onMin: 0, offHour: 22, offMin: 15 };
const SNOOZE_MINUTES = 5; // 每次延迟 5 分钟
const MAX_SNOOZES = 3; // 最多延迟 3 次

const pad = (n: number) => n.toString().padStart(2, '0');

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const [seconds, setSeconds] = useState<number>(0);
  const [running, setRunning] = useState<boolean>(false);
  const [confirmVisible, setConfirmVisible] = useState<boolean>(false);
  const [settingsVisible, setSettingsVisible] = useState<boolean>(false);
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [autoTriggered, setAutoTriggered] = useState<boolean>(false);
  const [snoozesLeft, setSnoozesLeft] = useState<number>(MAX_SNOOZES);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextTriggerRef = useRef<number>(0);
  const dayKeyRef = useRef('');
  const confirmVisibleRef = useRef(false);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 某天的开启触发时间戳
  const targetFor = useCallback((s: Settings) => {
    const d = new Date();
    d.setHours(s.onHour, s.onMin, 0, 0);
    return d.getTime();
  }, []);

  const onPressEnd = useCallback(() => {
    stopTimer();
    setRunning(false);
    setSeconds(0);
    KioskManager.stopKiosk();
    console.log('End-2');
  }, [stopTimer]);

  // 开始锁定：倒计时到设置的每日关闭时间（支持跨天），结束后自动退出 kiosk 模式
  const startSession = useCallback(() => {
    KioskManager.startKiosk();
    const now = new Date();
    const off = new Date();
    off.setHours(settingsRef.current.offHour, settingsRef.current.offMin, 0, 0);
    if (off.getTime() <= now.getTime()) {
      off.setDate(off.getDate() + 1); // 关闭时间已过，算明天（如 22:10 开、06:30 关）
    }
    const total = Math.max(1, Math.floor((off.getTime() - now.getTime()) / 1000));
    setRunning(true);
    setSeconds(total);
    stopTimer();
    timerRef.current = setInterval(() => {
      setSeconds(prev => {
        if (prev <= 1) {
          if (timerRef.current !== null) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          setRunning(false);
          KioskManager.stopKiosk();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [stopTimer]);

  // 组件卸载时清理定时器
  useEffect(() => stopTimer, [stopTimer]);

  // 明天的开启触发时间戳
  const nextDayTarget = useCallback((s: Settings) => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(s.onHour, s.onMin, 0, 0);
    return d.getTime();
  }, []);

  // 加载持久化设置，并按新的开启时间重排闹钟
  useEffect(() => {
    WakeAlarm?.getSettings()
      .then(json => {
        if (!json) return;
        const s = JSON.parse(json) as Settings;
        setSettings(s);
        settingsRef.current = s;
        const t = targetFor(s);
        nextTriggerRef.current = t;
        WakeAlarm?.scheduleWake(t);
      })
      .catch(() => {});
  }, [targetFor]);

  // 初始化当天的触发时间，并挂上原生闹钟（熄屏时 JS 定时器会暂停，需 AlarmManager 唤醒）
  useEffect(() => {
    dayKeyRef.current = new Date().toDateString();
    nextTriggerRef.current = targetFor(settingsRef.current);
    WakeAlarm?.scheduleWake(nextTriggerRef.current);
  }, [targetFor]);

  // 定时触发：先唤醒屏幕、把 app 拉回前台，再弹确认窗
  const triggerConfirm = useCallback(() => {
    console.log('[schedule] TRIGGERED, waking up and showing confirm modal');
    WakeAlarm?.wakeUpScreen(); // 熄屏时点亮屏幕（亮屏状态下是 no-op）
    KioskManager.launchApp('com.sera.tosleep'); // device owner，可从后台把 app 切回前台
    setAutoTriggered(true);
    setConfirmVisible(true);
  }, []);

  // 每 20 秒检查一次：到达触发时间（或延迟到期）时自动弹出确认窗
  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      const dayKey = now.toDateString();

      // 跨天：重置延迟次数和触发时间
      if (dayKeyRef.current !== dayKey) {
        dayKeyRef.current = dayKey;
        setSnoozesLeft(MAX_SNOOZES);
        nextTriggerRef.current = targetFor(settingsRef.current);
        WakeAlarm?.scheduleWake(nextTriggerRef.current);
      }

      console.log(`[schedule] checking, now = ${now.toLocaleString()}, snoozesLeft = ${snoozesLeft}`);
      if (Date.now() >= nextTriggerRef.current && !confirmVisibleRef.current) {
        triggerConfirm();
      }
    }, 20 * 1000);
    return () => clearInterval(id);
  }, [snoozesLeft, targetFor, triggerConfirm]);

  // Modal visible 的 ref 镜像，避免 interval 闭包拿到旧值
  useEffect(() => {
    confirmVisibleRef.current = confirmVisible;
  }, [confirmVisible]);

  // 延迟 5 分钟，最多 MAX_SNOOZES 次
  const onSnooze = useCallback(() => {
    setConfirmVisible(false);
    setAutoTriggered(false);
    setSnoozesLeft(n => n - 1);
    const nextAt = Date.now() + SNOOZE_MINUTES * 60 * 1000;
    nextTriggerRef.current = nextAt;
    WakeAlarm?.scheduleWake(nextAt);
    console.log(`[schedule] snoozed ${SNOOZE_MINUTES} minutes, alarm at ${new Date(nextAt).toLocaleTimeString()}`);
  }, []);

  // ---- 设置模块 ----
  const openSettings = useCallback(() => {
    setDraft(settingsRef.current);
    setSettingsVisible(true);
  }, []);

  const stepHour = (field: 'onHour' | 'offHour', delta: number) =>
    setDraft(v => ({ ...v, [field]: (v[field] + delta + 24) % 24 }));

  const stepMin = (field: 'onMin' | 'offMin', delta: number) =>
    setDraft(v => ({ ...v, [field]: (v[field] + delta * 5 + 60) % 60 }));

  const onSaveSettings = useCallback(() => {
    setSettings(draft);
    settingsRef.current = draft;
    setSettingsVisible(false);
    WakeAlarm?.setSettings(JSON.stringify(draft));
    const t = targetFor(draft);
    nextTriggerRef.current = t;
    WakeAlarm?.scheduleWake(t);
    console.log(`[settings] saved, next trigger at ${new Date(t).toLocaleString()}`);
  }, [draft, targetFor]);

  const mmss = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

  const canSnooze = autoTriggered && snoozesLeft > 0;
  const offLabel = `${pad(settings.offHour)}:${pad(settings.offMin)}`;
  const onLabel = `${pad(settings.onHour)}:${pad(settings.onMin)}`;

  return (
    <View style={styles.container}>
      {/* 设置入口 */}
      <Pressable style={styles.gearButton} onPress={openSettings}>
        <Text style={styles.gearIcon}>⚙️</Text>
      </Pressable>

      <Text style={styles.moon}>🌙</Text>
      <Text style={styles.title}>{running ? '专注模式进行中' : '该休息了'}</Text>
      <Text style={[styles.timer, running && styles.timerRunning]}>
        {running ? mmss : '––:––'}
      </Text>
      <Text style={styles.subtitle}>
        {running
          ? `至 ${offLabel} 自动解除锁定`
          : `每天 ${onLabel} 自动开启锁定`}
      </Text>

      <Pressable
        style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryPressed]}
        onPress={() => setConfirmVisible(true)}>
        <Text style={styles.primaryText}>立即开始专注</Text>
      </Pressable>

      {/* 当前设置的时间 */}
      <Pressable style={styles.scheduleInfo} onPress={openSettings}>
        <Text style={styles.scheduleItem}>⏰ 开启  {onLabel}</Text>
        <Text style={styles.scheduleDot}>·</Text>
        <Text style={styles.scheduleItem}>🌙 关闭  {offLabel}</Text>
      </Pressable>

      {/* 调试按钮 */}
      <View style={styles.debugRow}>
        <Pressable style={styles.debugButton} onPress={onPressEnd}>
          <Text style={styles.debugText}>End</Text>
        </Pressable>
      </View>

      {/* 自定义确认弹窗 */}
      <Modal
        visible={confirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          // 自动触发且已无可延迟次数时不允许关闭
          if (!autoTriggered || snoozesLeft > 0) {
            setConfirmVisible(false);
          }
        }}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>🌙 准备入睡</Text>
            <Text style={styles.cardBody}>
              锁定后设备将进入专注模式，至 {offLabel} 自动解除。
            </Text>

            {autoTriggered && snoozesLeft > 0 && (
              <Text style={styles.snoozeHint}>今晚还可延迟 {snoozesLeft} 次</Text>
            )}

            <Pressable
              style={({ pressed }) => [
                styles.confirmButton,
                pressed && styles.confirmButtonPressed,
              ]}
              onPress={() => {
                setConfirmVisible(false);
                setAutoTriggered(false);
                // 今日已锁定：下次自动触发推到明天，同一天不再弹窗
                const next = nextDayTarget(settingsRef.current);
                nextTriggerRef.current = next;
                WakeAlarm?.scheduleWake(next);
                startSession();
              }}>
              <Text style={styles.confirmText}>开始锁定</Text>
            </Pressable>

            {canSnooze && (
              <Pressable
                style={({ pressed }) => [styles.snoozeButton, pressed && { opacity: 0.6 }]}
                onPress={onSnooze}>
                <Text style={styles.snoozeText}>再睡 5 分钟（剩余 {snoozesLeft} 次）</Text>
              </Pressable>
            )}

            {(!autoTriggered || snoozesLeft > 0) && (
              <Pressable
                style={({ pressed }) => [styles.cancelButton, pressed && { opacity: 0.6 }]}
                onPress={() => {
                  setConfirmVisible(false);
                  if (autoTriggered && snoozesLeft > 0) {
                    // 自动触发时"暂不锁定"视作一次延迟，否则 20 秒后会立即重新弹出
                    onSnooze();
                  } else {
                    setAutoTriggered(false);
                  }
                }}>
                <Text style={styles.cancelText}>暂不锁定</Text>
              </Pressable>
            )}
          </View>
        </View>
      </Modal>

      {/* 设置弹窗 */}
      <Modal
        visible={settingsVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSettingsVisible(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>⚙️ 设置</Text>
            <Text style={styles.cardBody}>设置每日自动开启与关闭的时间</Text>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>每日开启</Text>
              <View style={styles.stepperGroup}>
                <Pressable style={styles.stepButton} onPress={() => stepHour('onHour', -1)}>
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text style={styles.timeValue}>{pad(draft.onHour)}</Text>
                <Pressable style={styles.stepButton} onPress={() => stepHour('onHour', 1)}>
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
                <Text style={styles.timeColon}>:</Text>
                <Pressable style={styles.stepButton} onPress={() => stepMin('onMin', -1)}>
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text style={styles.timeValue}>{pad(draft.onMin)}</Text>
                <Pressable style={styles.stepButton} onPress={() => stepMin('onMin', 1)}>
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>每日关闭</Text>
              <View style={styles.stepperGroup}>
                <Pressable style={styles.stepButton} onPress={() => stepHour('offHour', -1)}>
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text style={styles.timeValue}>{pad(draft.offHour)}</Text>
                <Pressable style={styles.stepButton} onPress={() => stepHour('offHour', 1)}>
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
                <Text style={styles.timeColon}>:</Text>
                <Pressable style={styles.stepButton} onPress={() => stepMin('offMin', -1)}>
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text style={styles.timeValue}>{pad(draft.offMin)}</Text>
                <Pressable style={styles.stepButton} onPress={() => stepMin('offMin', 1)}>
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
              </View>
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.confirmButton,
                pressed && styles.confirmButtonPressed,
              ]}
              onPress={onSaveSettings}>
              <Text style={styles.confirmText}>保存</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.cancelButton, pressed && { opacity: 0.6 }]}
              onPress={() => setSettingsVisible(false)}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0E0F26', // 夜空深蓝背景
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  gearButton: {
    position: 'absolute',
    top: 40,
    right: 24,
    padding: 10,
  },
  gearIcon: {
    fontSize: 26,
  },
  moon: {
    fontSize: 64,
    marginBottom: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#F5F0FF',
    marginBottom: 20,
  },
  timer: {
    fontSize: 72,
    fontWeight: '300',
    color: '#8A85B0', // 未开始时暗淡
    fontVariant: ['tabular-nums'],
    marginBottom: 12,
  },
  timerRunning: {
    color: '#B7AFFF', // 计时中亮起
  },
  subtitle: {
    fontSize: 14,
    color: '#5C5980',
    marginBottom: 48,
  },
  primaryButton: {
    backgroundColor: '#7C6FE0',
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 44,
    marginBottom: 24,
  },
  primaryPressed: {
    backgroundColor: '#655ABF',
    transform: [{ scale: 0.97 }],
  },
  primaryText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  scheduleInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1C1C3A',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  scheduleItem: {
    fontSize: 14,
    color: '#B8B3D9',
    fontVariant: ['tabular-nums'],
  },
  scheduleDot: {
    fontSize: 14,
    color: '#5C5980',
  },
  debugRow: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    flexDirection: 'row',
    gap: 12,
  },
  debugButton: {
    backgroundColor: '#1C1C3A',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 18,
  },
  debugText: {
    color: '#5C5980',
    fontSize: 13,
  },
  // ---- 弹窗样式 ----
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(8, 9, 25, 0.8)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '84%',
    maxWidth: 360,
    backgroundColor: '#1C1C3A',
    borderRadius: 24,
    padding: 28,
    alignItems: 'center',
  },
  cardTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#F5F0FF',
    marginBottom: 12,
  },
  cardBody: {
    fontSize: 15,
    lineHeight: 22,
    color: '#B8B3D9',
    textAlign: 'center',
    marginBottom: 20,
  },
  snoozeHint: {
    fontSize: 13,
    color: '#7C6FE0',
    marginBottom: 20,
  },
  confirmButton: {
    width: '100%',
    backgroundColor: '#7C6FE0',
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 14,
  },
  confirmButtonPressed: {
    backgroundColor: '#655ABF',
    transform: [{ scale: 0.98 }],
  },
  confirmText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  snoozeButton: {
    width: '100%',
    backgroundColor: '#2A2A4E',
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 14,
  },
  snoozeText: {
    fontSize: 15,
    color: '#B7AFFF',
  },
  cancelButton: {
    paddingVertical: 6,
  },
  cancelText: {
    fontSize: 15,
    color: '#8A85B0',
  },
  // ---- 设置弹窗样式 ----
  settingRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  settingLabel: {
    fontSize: 16,
    color: '#B8B3D9',
  },
  stepperGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#2A2A4E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: {
    fontSize: 20,
    color: '#B7AFFF',
    lineHeight: 24,
  },
  timeValue: {
    minWidth: 30,
    fontSize: 20,
    fontWeight: '600',
    color: '#F5F0FF',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  timeColon: {
    fontSize: 20,
    color: '#8A85B0',
  },
});

export default App;
