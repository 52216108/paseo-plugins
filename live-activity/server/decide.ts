// 纯函数：根据设备记录与当前汇总状态，决定这次要推哪些 APNs 消息，以及推送结果如何回写设备记录。
import { isActive, sameContent, type ContentState, type HostRef } from "./summary.ts";

export type Environment = "development" | "production";

/** 一台 iOS 设备的登记信息与推送记账（整体持久化到 devices.json）。时间均为毫秒。 */
export interface Device {
  deviceId: string;
  bundleId: string;
  environment: Environment;
  pushToStartToken: string | null;
  activityToken: string | null;
  hosts: HostRef[];
  /** 当前活动的开始时间（start 推送或收到新的 activityToken 时记录），用于 8 小时上限前轮换。 */
  activityStartedAt: number | null;
  /** 上次推 start 的时间，2 分钟内不重复 start。 */
  lastStartAt: number | null;
  /** 上次成功推送的内容与时间，用于判断内容变化与 10 分钟保活。 */
  lastSent: { state: ContentState; at: number } | null;
  /** 上次成功推送时的 waiting 数，waiting 变多时这次要提醒。 */
  lastSentWaiting: number;
}

export type PushKind = "start" | "update" | "end";

export interface PushStep {
  kind: PushKind;
  /** 推到哪个令牌。 */
  tokenKind: "activity" | "pushToStart";
  token: string;
  priority: 10 | 5;
  payload: { aps: Record<string, unknown> };
  state: ContentState;
}

export const START_COOLDOWN_MS = 2 * 60 * 1000;
export const REFRESH_MS = 10 * 60 * 1000;
export const ROTATE_AFTER_MS = (7 * 60 + 45) * 60 * 1000;
export const STALE_AFTER_SEC = 900;
export const DISMISS_AFTER_SEC = 300;
export const ATTRIBUTES_TYPE = "PaseoActivityAttributes";

/** 让 APNs 判定为令牌失效、需要清除的 400 原因。 */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "ExpiredToken"]);
export function isDeadToken(status: number | null, reason: string | null): boolean {
  return status === 410 || (status === 400 && reason !== null && DEAD_TOKEN_REASONS.has(reason));
}

function waitingAlert(state: ContentState) {
  const first = state.rows.find(r => r.status === "waiting");
  return { title: "需要你处理", body: first?.title ?? `${state.waiting} 个会话等你处理`, sound: "default" };
}

export function buildPayload(
  kind: PushKind, state: ContentState, nowMs: number,
  opts: { alert?: Record<string, unknown>; dismissAt?: number } = {},
): { aps: Record<string, unknown> } {
  const now = Math.floor(nowMs / 1000);
  const aps: Record<string, unknown> = {
    timestamp: now,
    event: kind,
    "content-state": state,
    "stale-date": now + STALE_AFTER_SEC,
  };
  if (kind === "start") {
    aps["attributes-type"] = ATTRIBUTES_TYPE;
    aps.attributes = {};
  }
  if (kind === "end") aps["dismissal-date"] = opts.dismissAt ?? now + DISMISS_AFTER_SEC;
  if (opts.alert) aps.alert = opts.alert;
  return { aps };
}

/**
 * 决定这次要推的消息（按顺序执行；轮换时为 end + start 两步）。
 * 不活跃 = running + waiting == 0。
 */
export function decide(device: Device, state: ContentState, nowMs: number): PushStep[] {
  const active = isActive(state);
  const waitingUp = state.waiting > device.lastSentWaiting;
  const steps: PushStep[] = [];

  const startStep = (): PushStep | null => {
    if (!device.pushToStartToken) return null;
    if (device.lastStartAt !== null && nowMs - device.lastStartAt < START_COOLDOWN_MS) return null;
    // start 必须带 alert；waiting 变多时用「需要你处理」提醒代替。
    const alert = waitingUp ? waitingAlert(state) : { title: "Paseo", body: `${state.running + state.waiting} 个会话运行中` };
    return {
      kind: "start", tokenKind: "pushToStart", token: device.pushToStartToken, priority: 10, state,
      payload: buildPayload("start", state, nowMs, { alert }),
    };
  };

  if (!active) {
    if (device.activityToken) {
      steps.push({
        kind: "end", tokenKind: "activity", token: device.activityToken, priority: 10, state,
        payload: buildPayload("end", state, nowMs),
      });
    }
    return steps;
  }

  if (device.activityToken) {
    const startedAt = device.activityStartedAt;
    if (startedAt !== null && nowMs - startedAt >= ROTATE_AFTER_MS) {
      // 接近 8 小时上限：先立即结束旧活动，再 start 新的。
      steps.push({
        kind: "end", tokenKind: "activity", token: device.activityToken, priority: 10, state,
        payload: buildPayload("end", state, nowMs, { dismissAt: Math.floor(nowMs / 1000) }),
      });
      const start = startStep();
      if (start) steps.push(start);
      return steps;
    }
    const last = device.lastSent;
    const changed = !last || !sameContent(last.state, state);
    if (changed || nowMs - last.at >= REFRESH_MS) {
      steps.push({
        kind: "update", tokenKind: "activity", token: device.activityToken, priority: waitingUp ? 10 : 5, state,
        payload: buildPayload("update", state, nowMs, waitingUp ? { alert: waitingAlert(state) } : {}),
      });
    }
    return steps;
  }

  const start = startStep();
  if (start) steps.push(start);
  return steps;
}

export interface PushResult { ok: boolean; status: number | null; reason: string | null }

/** 推送结果回写设备记录（就地修改）。返回 true 表示记录有变化需要持久化。 */
export function applyResult(device: Device, step: PushStep, result: PushResult, nowMs: number): boolean {
  let changed = false;
  if (step.kind === "start") { device.lastStartAt = nowMs; changed = true; }
  if (result.ok) {
    device.lastSent = { state: step.state, at: nowMs };
    device.lastSentWaiting = step.state.waiting;
    if (step.kind === "start") device.activityStartedAt = nowMs;
    // 推送期间 App 可能已登记了新令牌，只清掉刚结束的那个。
    if (step.kind === "end" && device.activityToken === step.token) { device.activityToken = null; device.activityStartedAt = null; }
    return true;
  }
  if (isDeadToken(result.status, result.reason)) {
    if (step.tokenKind === "activity" && device.activityToken === step.token) {
      device.activityToken = null; device.activityStartedAt = null;
    }
    if (step.tokenKind === "pushToStart" && device.pushToStartToken === step.token) device.pushToStartToken = null;
    return true;
  }
  return changed;
}
