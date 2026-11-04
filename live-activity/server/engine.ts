// 调度：汇总状态 → 去抖 → 按设备决定推送 → 调 APNs → 回写设备记录。
import type { LastPush, RegisterInput } from "../shared/contracts.ts";
import { ApnsClient, validateKey, type ApnsKey } from "./apns.ts";
import { applyResult, decide, settleIdle, type Device } from "./decide.ts";
import { Sources, type Api } from "./sources.ts";
import { Store } from "./store.ts";
import { buildState } from "./summary.ts";

const DEBOUNCE_MS = 1500;
const TICK_MS = 60_000;

const log = (line: string) => console.log(`live-activity: ${line}`);
const short = (token: string) => `${token.slice(0, 8)}…`;

export class LiveActivity {
  private devices = new Map<string, Device>();
  private key: ApnsKey | null = null;
  private apns = new ApnsClient();
  private sources: Sources | null = null;
  private started: Promise<void> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private warnedUnconfigured = false;
  private disposed = false;
  lastPush: LastPush | null = null;
  readonly ready: Promise<void>;

  constructor(private readonly store = new Store()) {
    this.ready = this.load();
  }

  private async load() {
    try {
      for (const device of await this.store.loadDevices()) this.devices.set(device.deviceId, device);
    } catch (error) { log(`读取设备记录失败：${(error as Error).message}`); }
    try {
      const key = await this.store.loadKey();
      if (key) { this.apns.setKey(key); this.key = key; }
    } catch { log("读取 APNs 密钥失败，按未配置处理"); }
  }

  get configured() { return this.apns.configured; }
  get deviceCount() { return this.devices.size; }
  get keyInfo() { return { teamId: this.key?.teamId ?? null, keyId: this.key?.keyId ?? null }; }

  /** 第一次拿到 paseo（hook / RPC 回调）时启动数据源订阅。 */
  ensureStarted(paseo: Api): Promise<void> {
    if (!this.started) {
      this.started = this.start(paseo).catch(error => {
        log(`启动失败：${(error as Error).message}`);
        this.started = null;
      });
    }
    return this.started;
  }

  private async start(paseo: Api) {
    await this.ready;
    const sources = new Sources(paseo, () => this.schedule(), log);
    this.sources = sources;
    await sources.init();
    await sources.sync(this.allHosts());
    if (this.disposed) { await sources.close(); return; }
    this.tick = setInterval(() => {
      void sources.healthCheck().catch(() => {}).then(() => this.evaluateAll());
    }, TICK_MS);
    log(`已启动，本机 serverId=${sources.selfId}，设备 ${this.devices.size} 台`);
    this.evaluateAll();
  }

  private allHosts() {
    return [...this.devices.values()].flatMap(d => d.hosts);
  }

  /** 状态可能变了：去抖 1.5 秒后重算。 */
  schedule() {
    if (this.disposed) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; this.evaluateAll(); }, DEBOUNCE_MS);
  }

  evaluateAll() {
    this.enqueue(async () => {
      for (const device of [...this.devices.values()]) await this.evaluate(device);
    });
  }

  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain.then(task).catch(error => log(`处理出错：${(error as Error).message}`));
  }

  private async evaluate(device: Device) {
    const sources = this.sources;
    if (!sources || this.disposed || this.devices.get(device.deviceId) !== device) return;
    const hosts = device.hosts.map(h => sources.hostData(h));
    // 一台机器的数据都还没拿到时不能据此结束活动。
    if (!hosts.some(h => h.agents)) return;
    const now = Date.now();
    const state = buildState(hosts, now / 1000);
    if (settleIdle(device, state, now)) await this.persist();
    const steps = decide(device, state, now);
    if (!steps.length) return;
    if (!this.apns.configured) {
      if (!this.warnedUnconfigured) log("未配置 APNs 密钥，不推送（App 设置里配置后生效）");
      this.warnedUnconfigured = true;
      return;
    }
    let dirty = false;
    for (const step of steps) {
      const result = await this.apns.send(device.environment, step.token, device.bundleId, step.priority, step.payload);
      const at = Date.now();
      this.lastPush = { at, ok: result.ok, status: result.status, reason: result.reason };
      log(`${step.kind} → ${step.tokenKind === "activity" ? "activity" : "push-to-start"} ${short(step.token)}（设备 ${device.deviceId.slice(0, 8)}，优先级 ${step.priority}）：`
        + (result.ok ? "成功" : `失败 ${result.status ?? "-"} ${result.reason ?? ""}`));
      dirty = applyResult(device, step, result, at) || dirty;
      if (!result.ok) break;
    }
    if (dirty) await this.persist();
  }

  private async persist() {
    try { await this.store.saveDevices([...this.devices.values()]); }
    catch (error) { log(`保存设备记录失败：${(error as Error).message}`); }
  }

  async register(input: RegisterInput): Promise<void> {
    await this.ready;
    const now = Date.now();
    const old = this.devices.get(input.deviceId);
    // 就地修改已有记录：正在进行的推送回写的是同一个对象。
    const device: Device = old ?? {
      deviceId: input.deviceId, bundleId: input.bundleId, environment: input.environment,
      pushToStartToken: null, activityToken: null, hosts: [],
      activityStartedAt: null, lastStartAt: null, lastSent: null, lastSentWaiting: 0,
    };
    device.bundleId = input.bundleId;
    device.environment = input.environment;
    device.hosts = input.hosts.map(h => ({ serverId: h.serverId, label: h.label }));
    // 字段省略 = 保持原值；null = 清除。
    if (input.pushToStartToken !== undefined) device.pushToStartToken = input.pushToStartToken;
    if (input.activityToken !== undefined) {
      if (input.activityToken === null) {
        // App 那边活动结束了（本地结束或被用户划掉）：下次有会话开始就能重新 start。
        device.activityStartedAt = null;
        if (device.activityToken) { device.lastSent = null; device.lastSentWaiting = 0; device.lastStartAt = null; }
      }
      else if (input.activityToken !== device.activityToken) device.activityStartedAt = now;
      device.activityToken = input.activityToken;
    }
    this.devices.set(device.deviceId, device);
    await this.persist();
    log(`设备 ${device.deviceId.slice(0, 8)} 已登记（${device.environment}，机器 ${device.hosts.length} 台，`
      + `activity ${device.activityToken ? short(device.activityToken) : "无"}，push-to-start ${device.pushToStartToken ? short(device.pushToStartToken) : "无"}）`);
    // 不等新机器连上再回复（连不上时要等几十秒，App 会当作超时）；数据到了订阅会触发重算。
    void this.sources?.sync(this.allHosts()).catch(error => log(`同步机器失败：${(error as Error).message}`));
    // 注册后立即按当前状态推一次（如需要）。
    this.enqueue(() => this.evaluate(device));
  }

  async unregister(deviceId: string): Promise<boolean> {
    await this.ready;
    const existed = this.devices.delete(deviceId);
    if (existed) {
      await this.persist();
      await this.sources?.sync(this.allHosts());
      log(`设备 ${deviceId.slice(0, 8)} 已移除`);
    }
    return existed;
  }

  async configure(input: ApnsKey): Promise<void> {
    await this.ready;
    const key = validateKey(input);
    await this.store.saveKey(key);
    this.apns.setKey(key);
    this.key = key;
    this.warnedUnconfigured = false;
    log(`APNs 密钥已配置（Key ID ${key.keyId}）`);
    this.evaluateAll();
  }

  async selfServerId(paseo: Api): Promise<string> {
    if (this.sources?.selfId) return this.sources.selfId;
    return (await paseo.hosts.list()).self.serverId;
  }

  dispose() {
    this.disposed = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.tick) clearInterval(this.tick);
    void this.sources?.close();
    this.apns.close();
  }
}
