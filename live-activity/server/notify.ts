// 纯函数：普通通知（APNs push-type alert）——何时发（沿用 daemon 的提醒信号）与载荷构造。
import type { Environment } from "./decide.ts";
import { clipChars, ERROR_MAX_CHARS, isNested, projectName, type AgentLite, type WorkspaceInfo } from "./summary.ts";

export type AlertReason = "finished" | "error" | "permission";
const REASONS = new Set<string>(["finished", "error", "permission"]);

/** 提醒时间戳离现在超过这么久就不发（重放 / 迟到的事件没有意义）。 */
export const ALERT_MAX_AGE_MS = 120_000;

/** requestId：permission 时是这次新出现的待批准请求 id（App 只批准这一个，防止批到用户没看到的请求）。 */
export interface AlertEvent { agent: AgentLite; reason: AlertReason; timestamp: string; requestId?: string }

/** 数据源按 agentId 记已通知过（或已作为基线见过）的 attentionTimestamp 与待批准请求 id。 */
export interface Seen { ts: string | null; perms: string[] }
export type NotifiedMap = Map<string, Seen>;

const permIds = (agent: AgentLite) => agent.pendingPermissions.map((p, i) => p.id ?? `#${i}`);
const seenOf = (agent: AgentLite): Seen => ({ ts: agent.attentionTimestamp ?? null, perms: permIds(agent) });

/**
 * 判定一次增量变化要不要发通知，并记下这次见到的状态（同一时间戳 / 同一权限请求只发一次）。
 * - 需要批准：daemon 不会为权限请求设置 attention（只广播事件），所以按「出现了新的待批准请求 id」判定，
 *   和 daemon 自己判断「刚有权限请求」的方式一致。
 * - 完成 / 出错：按 requiresAttention + attentionReason + attentionTimestamp 变化判定。
 * agents 是这台机器当前的会话表（用于判断嵌套子会话）。
 */
export function checkAlert(
  agent: AgentLite, serverId: string, agents: ReadonlyMap<string, AgentLite>, notified: NotifiedMap, nowMs: number,
): AlertEvent | null {
  const prev = notified.get(agent.id);
  const now = seenOf(agent);
  notified.set(agent.id, now);
  if (agent.archivedAt || isNested(agent, serverId, agents)) return null;
  // 第一次见到这个会话（例如新建后立刻就要批准）：之前没有请求，按空集合比较。
  const newPerm = now.perms.find(id => !(prev?.perms ?? []).includes(id));
  if (newPerm !== undefined) return { agent, reason: "permission", timestamp: `perm:${newPerm}`, requestId: newPerm };
  const ts = now.ts;
  if (!agent.requiresAttention || !ts || ts === (prev?.ts ?? undefined)) return null;
  const reason = agent.attentionReason;
  // permission 已按待批准请求处理，这里不再重复。
  if (!reason || !REASONS.has(reason) || reason === "permission") return null;
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
    if (baseline) { notified.set(agent.id, seenOf(agent)); continue; }
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
  /** 仅 permission：通知对应的待批准请求 id。 */
  requestId?: string;
}

const nonEmpty = (v: string | null | undefined): string | null => (v && v.trim() ? v : null);

/** 构造通知载荷（App 的点击 / 按钮处理读顶层 serverId、agentId）。hostLabel 是该设备登记时给这台机器起的名字。 */
export function buildAlertPayload(input: {
  serverId: string; hostLabel: string; agent: AgentLite; reason: AlertReason;
  workspaces?: ReadonlyMap<string, WorkspaceInfo>;
  requestId?: string;
}): AlertPayload {
  const { serverId, agent, reason } = input;
  // 主标题用侧栏的行名（工作区标题，没有才用会话标题）；副标题是会话标题，和主标题一样时改写机器名。
  const workspaceTitle = agent.workspaceId ? nonEmpty(input.workspaces?.get(agent.workspaceId)?.title) : null;
  const agentTitle = nonEmpty(agent.title);
  const name = workspaceTitle ?? agentTitle ?? "会话";
  const subtitle = agentTitle && agentTitle !== name ? agentTitle : input.hostLabel;
  let title: string, body: string;
  if (reason === "permission") {
    title = `需要你批准 · ${name}`;
    const first = agent.pendingPermissions.find(p => input.requestId !== undefined && p.id === input.requestId) ?? agent.pendingPermissions[0];
    body = nonEmpty(first?.title) ?? nonEmpty(first?.name) ?? "有一个权限请求等你处理";
  } else if (reason === "error") {
    title = `出错了 · ${name}`;
    const error = nonEmpty(agent.lastError);
    body = error ? clipChars(error, ERROR_MAX_CHARS) : "会话出错";
  } else {
    title = `完成 · ${name}`;
    const project = projectName(agent, input.workspaces);
    body = [project, input.hostLabel].filter(Boolean).join(" · ") || "回合已结束";
  }
  return {
    aps: {
      alert: { title, subtitle, body },
      sound: "default",
      category: reason === "permission" ? "paseo.permission" : "paseo.finished",
      "thread-id": `${serverId}:${agent.id}`,
    },
    serverId,
    agentId: agent.id,
    reason,
    ...(reason === "permission" && input.requestId && !input.requestId.startsWith("#") ? { requestId: input.requestId } : {}),
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
