// 各机器会话数据源：本机与已关联机器（connected hosts）都先尝试订阅，订阅失败或中断就降级为每 30 秒轮询。
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { toLite, type AgentLite, type HostData, type HostRef } from "./summary.ts";

export type Api = PluginHandlerContext["paseo"];
type ListResult = Awaited<ReturnType<Api["agents"]["list"]>>;
type UpdateMessage = { type: string; payload?: unknown };

const LIST_OPTIONS = { filter: { includeArchived: false }, page: { limit: 200 } } as const;
const POLL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_PAGES = 10;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}超时`)), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

interface SourceOptions {
  serverId: string;
  name: string;
  open(): Promise<Api>;
  release(api: Api): Promise<void>;
  onChange(): void;
  log(line: string): void;
}

/** 一台机器的会话列表。agents 为 null 表示当前拿不到数据（离线）。 */
export class AgentSource {
  agents: Map<string, AgentLite> | null = null;
  private api: Api | null = null;
  private subscription: { release(): Promise<void> } | null = null;
  private unsubscribe: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  private closed = false;

  constructor(private readonly opts: SourceOptions) {}

  get serverId() { return this.opts.serverId; }

  async start() {
    try {
      const api = await this.ensureApi();
      const result = await withTimeout(api.agents.list({ ...LIST_OPTIONS, subscribe: {} }), CONNECT_TIMEOUT_MS, "订阅会话列表");
      if (this.closed) { await result.subscription.release().catch(() => {}); return; }
      this.subscription = result.subscription;
      await this.replace(api, result);
      this.unsubscribe = result.subscription.subscribe({
        snapshot: snapshot => { void this.replace(api, snapshot as ListResult).catch(() => {}); },
        update: msg => this.apply(msg as UpdateMessage),
        error: error => { void this.downgrade(`订阅中断：${message(error)}`); },
      });
      this.opts.log(`${this.opts.name}：已订阅会话列表（${this.agents?.size ?? 0} 个未归档会话）`);
    } catch (error) {
      await this.downgrade(`订阅失败：${message(error)}`);
    }
  }

  /** 外部判断这台机器离线（hosts.list 状态不是 online）。 */
  markOffline() {
    if (this.agents) { this.agents = null; this.opts.onChange(); }
  }

  /** 机器恢复在线但还没数据时，主动拉一次。 */
  async refresh() {
    await this.pollOnce();
  }

  async close() {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.teardown();
  }

  private async ensureApi(): Promise<Api> {
    if (!this.api) this.api = await withTimeout(this.opts.open(), CONNECT_TIMEOUT_MS, "连接机器");
    return this.api;
  }

  private async teardown() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const subscription = this.subscription;
    this.subscription = null;
    await subscription?.release().catch(() => {});
    const api = this.api;
    this.api = null;
    if (api) await this.opts.release(api).catch(() => {});
  }

  private async downgrade(reason: string) {
    if (this.pollTimer || this.closed) return;
    this.opts.log(`${this.opts.name}：${reason}，改为每 30 秒轮询`);
    await this.teardown();
    this.pollTimer = setInterval(() => { void this.pollOnce(); }, POLL_MS);
    await this.pollOnce();
  }

  private async pollOnce() {
    if (this.closed) return;
    try {
      const api = await this.ensureApi();
      const result = await withTimeout(api.agents.list(LIST_OPTIONS), CONNECT_TIMEOUT_MS, "拉取会话列表");
      await this.replace(api, result);
      this.lastError = null;
    } catch (error) {
      const text = message(error);
      if (text !== this.lastError) this.opts.log(`${this.opts.name}：拉取会话失败：${text}`);
      this.lastError = text;
      // 只在轮询模式下丢掉连接，下次重连；订阅模式的连接由客户端自己恢复。
      if (this.pollTimer) {
        const api = this.api;
        this.api = null;
        if (api) await this.opts.release(api).catch(() => {});
      }
      this.markOffline();
    }
  }

  /** 用一份完整列表替换（超过一页时继续翻页）。 */
  private async replace(api: Api, first: ListResult) {
    const entries = [...first.entries];
    let page = first;
    for (let i = 1; i < MAX_PAGES && page.pageInfo?.hasMore && page.pageInfo.nextCursor; i++) {
      page = await api.agents.list({ ...LIST_OPTIONS, page: { limit: 200, cursor: page.pageInfo.nextCursor } });
      entries.push(...page.entries);
    }
    const next = new Map<string, AgentLite>();
    for (const entry of entries) {
      const agent = (entry as { agent?: AgentLite }).agent;
      if (agent && !agent.archivedAt) next.set(agent.id, toLite(agent));
    }
    if (this.closed) return;
    this.agents = next;
    this.opts.onChange();
  }

  private apply(msg: UpdateMessage) {
    if (msg.type !== "agent_update" || !this.agents) return;
    const payload = msg.payload as { kind: "upsert"; agent: AgentLite } | { kind: "remove"; agentId: string } | undefined;
    if (!payload) return;
    if (payload.kind === "upsert") {
      if (payload.agent.archivedAt) this.agents.delete(payload.agent.id);
      else this.agents.set(payload.agent.id, toLite(payload.agent));
    } else if (payload.kind === "remove") {
      this.agents.delete(payload.agentId);
    } else {
      return;
    }
    this.opts.onChange();
  }
}

/** 管理本机 + 各设备登记的已关联机器的数据源。 */
export class Sources {
  selfId: string | null = null;
  private sources = new Map<string, AgentSource>();

  constructor(private readonly paseo: Api, private readonly onChange: () => void, private readonly log: (line: string) => void) {}

  async init() {
    const directory = await this.paseo.hosts.list();
    this.selfId = directory.self.serverId;
    const local = new AgentSource({
      serverId: this.selfId, name: "本机",
      open: async () => this.paseo, release: async () => {},
      onChange: this.onChange, log: this.log,
    });
    this.sources.set(this.selfId, local);
    await local.start();
  }

  /** 让远程数据源与设备登记的机器一致（多的关掉，缺的连上）。 */
  async sync(hosts: readonly HostRef[]) {
    const wanted = new Map(hosts.filter(h => h.serverId !== this.selfId).map(h => [h.serverId, h.label] as const));
    for (const [id, source] of this.sources) {
      if (id !== this.selfId && !wanted.has(id)) { this.sources.delete(id); await source.close(); }
    }
    const started: Promise<void>[] = [];
    for (const [serverId, label] of wanted) {
      if (this.sources.has(serverId)) continue;
      const source = new AgentSource({
        serverId, name: label || serverId,
        open: () => this.paseo.hosts.client(serverId),
        release: api => api.dispose(),
        onChange: this.onChange, log: this.log,
      });
      this.sources.set(serverId, source);
      started.push(source.start());
    }
    await Promise.all(started);
  }

  hostData(host: HostRef): HostData {
    return { host, agents: this.sources.get(host.serverId)?.agents ?? null };
  }

  /** 按 hosts.list 的在线状态标记离线 / 恢复。 */
  async healthCheck() {
    const remotes = [...this.sources.values()].filter(s => s.serverId !== this.selfId);
    if (!remotes.length) return;
    let directory: Awaited<ReturnType<Api["hosts"]["list"]>>;
    try { directory = await this.paseo.hosts.list(); } catch { return; }
    for (const source of remotes) {
      const host = directory.hosts.find(h => h.serverId === source.serverId);
      if (!host || host.status !== "online") source.markOffline();
      else if (!source.agents) await source.refresh();
    }
  }

  async close() {
    const all = [...this.sources.values()];
    this.sources.clear();
    await Promise.all(all.map(s => s.close()));
  }
}
