// 纯函数：把各机器的会话汇总成实时活动的 content-state（规则与 App 端 LiveActivityController.snapshot 一致）。

/** 汇总只用到的会话字段（来自 AgentSnapshotPayload）。 */
export interface AgentLite {
  id: string;
  title: string | null;
  status: string;
  pendingPermissions: readonly unknown[];
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  labels: Readonly<Record<string, string>>;
  archivedAt?: string | null;
  attentionReason?: string | null;
  updatedAt: string;
  workspaceId?: string | null;
  cwd?: string | null;
}

export interface HostRef { serverId: string; label: string }

export interface ActivityRow {
  serverId: string;
  agentId: string;
  host: string;
  title: string;
  /** 工作区（项目）名：工作区的 projectDisplayName，拿不到时用工作目录最后一段。 */
  project?: string;
  status: "waiting" | "failed" | "running";
  since?: number;
}

export interface ContentState {
  updatedAt: number;
  running: number;
  waiting: number;
  failed: number;
  rows: ActivityRow[];
  offline: string[];
}

export const MAX_ROWS = 4;
export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
export const PARENT_SERVER_LABEL = "paseo.parent-server-id";

/** 只保留汇总要用的字段，避免长期持有整份快照。 */
export function toLite(agent: AgentLite): AgentLite {
  return {
    id: agent.id,
    title: agent.title ?? null,
    status: agent.status,
    pendingPermissions: agent.pendingPermissions ?? [],
    activeTurn: agent.activeTurn ?? null,
    labels: agent.labels ?? {},
    archivedAt: agent.archivedAt ?? null,
    attentionReason: agent.attentionReason ?? null,
    updatedAt: agent.updatedAt,
    workspaceId: agent.workspaceId ?? null,
    cwd: agent.cwd ?? null,
  };
}

/** 嵌套子会话：有父会话标签、父会话在同一台机器上、且父会话确实在这台机器的列表里。 */
export function isNested(agent: AgentLite, serverId: string, agents: ReadonlyMap<string, AgentLite>): boolean {
  const parentId = agent.labels[PARENT_AGENT_LABEL];
  if (!parentId) return false;
  const parentServer = agent.labels[PARENT_SERVER_LABEL];
  if (parentServer && parentServer !== serverId) return false;
  return agents.has(parentId);
}

export function classify(agent: AgentLite): ActivityRow["status"] | null {
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") return "waiting";
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.status === "running") return "running";
  return null;
}

const RANK: Record<ActivityRow["status"], number> = { waiting: 0, failed: 1, running: 2 };

function seconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** 一台机器的数据：agents 为 null 表示拿不到（离线）。 */
export interface HostData {
  host: HostRef;
  agents: ReadonlyMap<string, AgentLite> | null;
  /** 工作区 ID → 显示名（同 App 侧栏的项目名）。 */
  workspaces?: ReadonlyMap<string, string>;
}

/** 与 App 的 projectName 同一规则：工作区显示名，否则工作目录最后一段。 */
export function projectName(agent: AgentLite, workspaces?: ReadonlyMap<string, string>): string | undefined {
  const name = agent.workspaceId ? workspaces?.get(agent.workspaceId) : undefined;
  if (name?.trim()) return name;
  const last = agent.cwd?.replace(/\/+$/, "").split("/").pop();
  return last ? last : undefined;
}

export function buildState(hosts: readonly HostData[], nowSec: number): ContentState {
  const rows: { row: ActivityRow; recent: number }[] = [];
  let running = 0, waiting = 0, failed = 0;
  const offline: string[] = [];
  for (const { host, agents, workspaces } of hosts) {
    if (!agents) { offline.push(host.label); continue; }
    for (const agent of agents.values()) {
      if (agent.archivedAt || isNested(agent, host.serverId, agents)) continue;
      const status = classify(agent);
      if (!status) continue;
      if (status === "waiting") waiting++;
      else if (status === "failed") failed++;
      else running++;
      const row: ActivityRow = {
        serverId: host.serverId,
        agentId: agent.id,
        host: host.label,
        title: agent.title?.trim() ? agent.title : "新会话",
        status,
      };
      const project = projectName(agent, workspaces);
      if (project) row.project = project;
      if (status === "running") {
        const since = seconds(agent.activeTurn?.startedAt);
        if (since !== null) row.since = since;
      }
      rows.push({ row, recent: seconds(agent.updatedAt) ?? 0 });
    }
  }
  rows.sort((a, b) => RANK[a.row.status] - RANK[b.row.status] || b.recent - a.recent);
  return {
    updatedAt: nowSec,
    running,
    waiting,
    failed,
    rows: running + waiting > 0 ? rows.slice(0, MAX_ROWS).map(r => r.row) : [],
    offline,
  };
}

export function isActive(state: ContentState): boolean {
  return state.running + state.waiting > 0;
}

/** 比较内容时忽略 updatedAt。 */
export function sameContent(a: ContentState, b: ContentState): boolean {
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}
