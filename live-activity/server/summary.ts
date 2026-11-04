// 纯函数：把各机器的会话汇总成实时活动的 content-state（规则与 App 端 LiveActivityController.snapshot 一致）。

/** 汇总只用到的会话字段（来自 AgentSnapshotPayload）。 */
export interface AgentLite {
  id: string;
  title: string | null;
  status: string;
  pendingPermissions: readonly PermissionLite[];
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  labels: Readonly<Record<string, string>>;
  archivedAt?: string | null;
  attentionReason?: string | null;
  /** daemon 的提醒信号：需要提醒时为 true，attentionTimestamp 是这次提醒的时间（ISO）。 */
  requiresAttention?: boolean;
  attentionTimestamp?: string | null;
  lastError?: string | null;
  updatedAt: string;
  workspaceId?: string | null;
  cwd?: string | null;
}

/** 权限请求只留通知要用的字段。 */
export interface PermissionLite { id?: string | null; title?: string | null; name?: string | null; kind?: string | null }

export interface HostRef { serverId: string; label: string }

export interface ActivityRow {
  serverId: string;
  agentId: string;
  host: string;
  title: string;
  /** 项目名（侧栏分组名）：工作区的 projectDisplayName，拿不到时用工作目录最后一段。 */
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

export const ERROR_MAX_CHARS = 200;

/** 按字符（码点）截短，不切坏 emoji / 生僻字。 */
export function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/** 只保留汇总要用的字段，避免长期持有整份快照。 */
export function toLite(agent: AgentLite): AgentLite {
  return {
    id: agent.id,
    title: agent.title ?? null,
    status: agent.status,
    pendingPermissions: (agent.pendingPermissions ?? []).map(p => ({
      id: typeof p?.id === "string" ? p.id : null,
      title: typeof p?.title === "string" ? p.title : null,
      name: typeof p?.name === "string" ? p.name : null,
      kind: typeof p?.kind === "string" ? p.kind : null,
    })),
    activeTurn: agent.activeTurn ?? null,
    labels: agent.labels ?? {},
    archivedAt: agent.archivedAt ?? null,
    attentionReason: agent.attentionReason ?? null,
    requiresAttention: agent.requiresAttention === true,
    attentionTimestamp: agent.attentionTimestamp ?? null,
    // 通知正文只用前 200 字，不长期持有整段错误。
    lastError: typeof agent.lastError === "string" ? clipChars(agent.lastError, ERROR_MAX_CHARS) : null,
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
  /** 工作区 ID → 项目名与工作区标题（同 App 侧栏的分组名与行名）。 */
  workspaces?: ReadonlyMap<string, WorkspaceInfo>;
}

export interface WorkspaceInfo { project: string; title: string | null }

/** 与 App 的 projectName 同一规则：工作区的项目显示名，否则工作目录最后一段。 */
export function projectName(agent: AgentLite, workspaces?: ReadonlyMap<string, WorkspaceInfo>): string | undefined {
  const name = agent.workspaceId ? workspaces?.get(agent.workspaceId)?.project : undefined;
  if (name?.trim()) return name;
  const last = agent.cwd?.replace(/\/+$/, "").split("/").pop();
  return last ? last : undefined;
}

/**
 * 汇总成一份状态，**按工作区合并**（同 App 侧栏：一个工作区一行，状态取其中最紧急的会话：
 * 等你处理 → 出错 → 运行中；同级取最近活动的，它也是点开的那个会话）。计数也按工作区。
 */
export function buildState(hosts: readonly HostData[], nowSec: number): ContentState {
  const groups = new Map<string, { row: ActivityRow; recent: number }>();
  const offline: string[] = [];
  for (const { host, agents, workspaces } of hosts) {
    if (!agents) { offline.push(host.label); continue; }
    for (const agent of agents.values()) {
      if (agent.archivedAt || isNested(agent, host.serverId, agents)) continue;
      const status = classify(agent);
      if (!status) continue;
      const workspace = agent.workspaceId ? workspaces?.get(agent.workspaceId) : undefined;
      // 行名同侧栏：工作区标题，没有就用会话标题。
      const title = workspace?.title?.trim() ? workspace.title : (agent.title?.trim() ? agent.title : "新会话");
      const row: ActivityRow = { serverId: host.serverId, agentId: agent.id, host: host.label, title, status };
      const project = projectName(agent, workspaces);
      if (project) row.project = project;
      const since = status === "running" ? seconds(agent.activeTurn?.startedAt) : null;
      if (since !== null) row.since = since;
      const recent = seconds(agent.updatedAt) ?? 0;
      const key = `${host.serverId}/${agent.workspaceId ?? `agent:${agent.id}`}`;
      const existing = groups.get(key);
      if (!existing) { groups.set(key, { row, recent }); continue; }
      // 运行时长取这个工作区里最早开始的回合。
      const longest = [existing.row.since, row.since].filter((v): v is number => v !== undefined);
      const more = RANK[row.status] < RANK[existing.row.status]
        || (RANK[row.status] === RANK[existing.row.status] && recent > existing.recent);
      const next = more ? row : existing.row;
      if (next.status === "running" && longest.length) next.since = Math.min(...longest);
      else delete next.since;
      groups.set(key, { row: next, recent: Math.max(recent, existing.recent) });
    }
  }
  const all = [...groups.values()];
  const count = (s: ActivityRow["status"]) => all.filter(g => g.row.status === s).length;
  const running = count("running"), waiting = count("waiting"), failed = count("failed");
  all.sort((a, b) => RANK[a.row.status] - RANK[b.row.status] || b.recent - a.recent);
  return {
    updatedAt: nowSec,
    running,
    waiting,
    failed,
    rows: running + waiting > 0 ? all.slice(0, MAX_ROWS).map(g => g.row) : [],
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
