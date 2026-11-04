// 持久化：<PASEO_HOME 或 ~/.paseo>/live-activity/ 下的 devices.json 与 apns-key.json（均 0600）。
// 不放进插件 settings：settings 会被客户端读到。
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApnsKey } from "./apns.ts";
import type { Device } from "./decide.ts";

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PASEO_HOME || join(homedir(), ".paseo"), "live-activity");
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 先写临时文件（0600）再改名，避免写一半被读到。 */
async function writeSecret(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export class Store {
  constructor(readonly dir: string = dataDir()) {}

  private async ensureDir() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async loadDevices(): Promise<Device[]> {
    const raw = await readJson(join(this.dir, "devices.json"));
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { devices?: unknown }).devices)) return [];
    return ((raw as { devices: Partial<Device>[] }).devices).filter(d => d && typeof d.deviceId === "string").map(d => ({
      deviceId: d.deviceId!,
      bundleId: d.bundleId ?? "",
      environment: d.environment === "development" ? "development" : "production",
      pushToStartToken: d.pushToStartToken ?? null,
      activityToken: d.activityToken ?? null,
      hosts: Array.isArray(d.hosts) ? d.hosts : [],
      activityStartedAt: d.activityStartedAt ?? null,
      lastStartAt: d.lastStartAt ?? null,
      lastSent: d.lastSent ?? null,
      lastSentWaiting: d.lastSentWaiting ?? 0,
    }));
  }

  async saveDevices(devices: readonly Device[]) {
    await this.ensureDir();
    await writeSecret(join(this.dir, "devices.json"), { version: 1, devices });
  }

  async loadKey(): Promise<ApnsKey | null> {
    const raw = await readJson(join(this.dir, "apns-key.json")) as Partial<ApnsKey> | null;
    if (!raw || typeof raw.teamId !== "string" || typeof raw.keyId !== "string" || typeof raw.p8 !== "string") return null;
    return { teamId: raw.teamId, keyId: raw.keyId, p8: raw.p8 };
  }

  async saveKey(key: ApnsKey) {
    await this.ensureDir();
    await writeSecret(join(this.dir, "apns-key.json"), key);
  }
}
