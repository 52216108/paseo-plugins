// 纯函数：普通通知（APNs push-type alert）——何时发（沿用 daemon 的提醒信号）与载荷构造。
import type { Environment } from "./decide.ts";
import { clipChars, ERROR_MAX_CHARS, isNested, projectName, type AgentLite, type WorkspaceInfo } from "./summary.ts";

export type AlertReason = "finished" | "error" | "permission";
const REASONS = new Set<string>(["finished", "error", "permission"]);

/** 提醒时间戳离现在超过这么久就不发（重放 / 迟到的事件没有意义）。 */
export const ALERT_MAX_AGE_MS = 120_000;

export interface AlertEvent { agent: AgentLite; reason: AlertReason; timestamp: string }

/** 数据源按 agentId 记「已通知过（或已作为基线见过）的 attentionTimestamp」。 */
export type NotifiedMap = Map<string, string | null>;

/**
 * 判定一次增量变化要不要发通知，并记下这次见到的时间戳（同一时间戳只发一次）。
 * agents 是这台机器当前的会话表（用于判断嵌套子会话）。
 */
export function checkAlert(
  agent: AgentLite, serverId: string, agents: ReadonlyMap<string, AgentLite>, notified: NotifiedMap, nowMs: number,
): AlertEvent | null {
  const ts = agent.attentionTimestamp ?? null;
  const seen = notified.has(agent.id) ? notified.get(agent.id) : undefined;
  notified.set(agent.id, ts);
  if (!agent.requiresAttention || !ts || ts === seen) return null;
  const reason = agent.attentionReason;
  if (!reason || !REASONS.has(reason)) return null;
  if (agent.archivedAt || isNested(agent, serverId, agents)) return null;
  const at = Date.parse(ts);
  if (!Number.isFinite(at) || nowMs - at >= ALERT_MAX_AGE_MS) return null;
  return { agent, reason: reason as AlertReason, timestamp: ts };
}

/**
 * 一份完整列表：baseline=true（首次加载 / 订阅快照 / 重连）只记基线不发；
 * baseline=false（轮询模式下与上一份列表对比）按增量规则判定。不在列表里的会话从记录里去掉。
 */
export function scanAlerts(
  agents: ReadonlyMap<string, AgentLite>, serverId: string, notified: NotifiedMap, nowMs: number, baseline: boolean,
): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const id of [...notified.keys()]) if (!agents.has(id)) notified.delete(id);
  for (const agent of agents.values()) {
    if (baseline) { notified.set(agent.id, agent.attentionTimestamp ?? null); continue; }
    const event = checkAlert(agent, serverId, agents, notified, nowMs);
    if (event) events.push(event);
  }
  return events;
}

export interface AlertPayload {
  aps: {
    alert: { title: string; subtitle: string; body: string };
    sound: "default";
    category: "paseo.permission" | "paseo.finished";
    "thread-id": string;
  };
  serverId: string;
  agentId: string;
  reason: AlertReason;
}

const nonEmpty = (v: string | null | undefined): string | null => (v && v.trim() ? v : null);

/** 构造通知载荷（App 的点击 / 按钮处理读顶层 serverId、agentId）。hostLabel 是该设备登记时给这台机器起的名字。 */
export function buildAlertPayload(input: {
  serverId: string; hostLabel: string; agent: AgentLite; reason: AlertReason;
  workspaces?: ReadonlyMap<string, WorkspaceInfo>;
}): AlertPayload {
  const { serverId, agent, reason } = input;
  const name = nonEmpty(agent.title) ?? "会话";
  let title: string, body: string;
  if (reason === "permission") {
    title = `需要你批准 · ${name}`;
    const first = agent.pendingPermissions[0];
    body = nonEmpty(first?.title) ?? nonEmpty(first?.name) ?? "有一个权限请求等你处理";
  } else if (reason === "error") {
    title = `出错了 · ${name}`;
    const error = nonEmpty(agent.lastError);
    body = error ? clipChars(error, ERROR_MAX_CHARS) : "会话出错";
  } else {
    title = `完成 · ${name}`;
    const project = projectName(agent, input.workspaces);
    const workspaceTitle = agent.workspaceId ? nonEmpty(input.workspaces?.get(agent.workspaceId)?.title) : null;
    body = [project, workspaceTitle].filter(Boolean).join(" · ") || "回合已结束";
  }
  return {
    aps: {
      alert: { title, subtitle: input.hostLabel, body },
      sound: "default",
      category: reason === "permission" ? "paseo.permission" : "paseo.finished",
      "thread-id": `${serverId}:${agent.id}`,
    },
    serverId,
    agentId: agent.id,
    reason,
  };
}

/** 该发给哪些设备：alertToken 非空、且登记的机器里有这台。 */
export function alertTargets<D extends { alertToken: string | null; hosts: readonly { serverId: string; label: string }[] }>(
  devices: Iterable<D>, serverId: string,
): { device: D; hostLabel: string }[] {
  const targets: { device: D; hostLabel: string }[] = [];
  for (const device of devices) {
    if (!device.alertToken) continue;
    const host = device.hosts.find(h => h.serverId === serverId);
    if (host) targets.push({ device, hostLabel: host.label });
  }
  return targets;
}

/** register 输出的 alerts：插件会不会给这台设备发普通通知（有 alertToken 且该环境配了密钥）。 */
export function alertsEnabled(
  device: { alertToken: string | null; environment: Environment }, configuredFor: (env: Environment) => boolean,
): boolean {
  return !!device.alertToken && configuredFor(device.environment);
}
