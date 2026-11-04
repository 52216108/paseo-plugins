// APNs 客户端：ES256 JWT（缓存 50 分钟）+ 每个环境一条复用的 HTTP/2 连接。
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import http2 from "node:http2";
import type { Environment, PushResult } from "./decide.ts";

export interface ApnsKey { teamId: string; keyId: string; p8: string }

const HOSTS: Record<Environment, string> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};
const JWT_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** 解析 .p8 私钥；不是 P-256 EC 私钥时抛中文错误（不回显密钥内容）。 */
export function loadPrivateKey(p8: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: p8.trim(), format: "pem" });
  } catch {
    throw new Error("无法解析 .p8 私钥，请粘贴完整的 PEM 内容（含 BEGIN/END PRIVATE KEY 行）");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("密钥类型不对：APNs 需要 P-256 椭圆曲线私钥（.p8）");
  }
  return key;
}

export function signJwt(key: KeyObject, teamId: string, keyId: string, nowMs: number): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) }));
  const input = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(signature)}`;
}

/** 校验 teamId / keyId 格式并试签一次，失败抛中文错误。 */
export function validateKey(input: ApnsKey): ApnsKey {
  const teamId = input.teamId.trim();
  const keyId = input.keyId.trim();
  if (!/^[A-Z0-9]{10}$/i.test(teamId)) throw new Error("Team ID 格式不对，应为 10 位字母数字");
  if (!/^[A-Z0-9]{10}$/i.test(keyId)) throw new Error("Key ID 格式不对，应为 10 位字母数字");
  const key = loadPrivateKey(input.p8);
  try {
    signJwt(key, teamId, keyId, Date.now());
  } catch {
    throw new Error("用该私钥签名 JWT 失败，请确认是从 Apple 开发者后台下载的 APNs .p8 密钥");
  }
  return { teamId, keyId, p8: input.p8.trim() + "\n" };
}

/** 每个环境一把密钥（Apple 后台按 Sandbox / Production 分开建的密钥各管各的）。 */
export type ApnsKeys = Partial<Record<Environment, ApnsKey>>;

export class ApnsClient {
  private keys = new Map<Environment, { config: ApnsKey; object: KeyObject }>();
  private jwts = new Map<Environment, { value: string; at: number }>();
  private sessions = new Map<Environment, http2.ClientHttp2Session>();

  setKeys(keys: ApnsKeys) {
    this.keys.clear();
    this.jwts.clear();
    for (const env of ["development", "production"] as const) {
      const config = keys[env];
      if (config) this.keys.set(env, { config, object: loadPrivateKey(config.p8) });
    }
  }

  get configured(): boolean { return this.keys.size > 0; }
  configuredFor(env: Environment): boolean { return this.keys.has(env); }

  private token(env: Environment, nowMs: number): string {
    const key = this.keys.get(env);
    if (!key) throw new Error(`未配置 ${env} 环境的 APNs 密钥`);
    const cached = this.jwts.get(env);
    if (cached && nowMs - cached.at < JWT_TTL_MS) return cached.value;
    const value = signJwt(key.object, key.config.teamId, key.config.keyId, nowMs);
    this.jwts.set(env, { value, at: nowMs });
    return value;
  }

  private session(env: Environment): http2.ClientHttp2Session {
    const existing = this.sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(HOSTS[env]);
    const drop = () => { if (this.sessions.get(env) === session) this.sessions.delete(env); };
    session.on("error", drop);
    session.on("close", drop);
    session.on("goaway", () => { drop(); session.close(); });
    // 空闲连接不阻止进程退出。
    session.unref();
    this.sessions.set(env, session);
    return session;
  }

  private dropSession(env: Environment) {
    const session = this.sessions.get(env);
    this.sessions.delete(env);
    session?.destroy();
  }

  async send(env: Environment, deviceToken: string, topic: string, priority: number, payload: unknown): Promise<PushResult> {
    let auth: string;
    try { auth = this.token(env, Date.now()); } catch (error) {
      return { ok: false, status: null, reason: error instanceof Error ? error.message : String(error) };
    }
    const body = Buffer.from(JSON.stringify(payload));
    return new Promise<PushResult>(resolve => {
      let settled = false;
      const done = (result: PushResult) => { if (!settled) { settled = true; resolve(result); } };
      let session: http2.ClientHttp2Session;
      try { session = this.session(env); } catch (error) {
        done({ ok: false, status: null, reason: error instanceof Error ? error.message : String(error) });
        return;
      }
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        "authorization": `bearer ${auth}`,
        "apns-push-type": "liveactivity",
        "apns-topic": `${topic}.push-type.liveactivity`,
        "apns-priority": String(priority),
        "content-type": "application/json",
        "content-length": body.length,
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        this.dropSession(env);
        done({ ok: false, status: null, reason: "请求超时" });
      });
      let status: number | null = null;
      const chunks: Buffer[] = [];
      req.on("response", headers => { status = Number(headers[":status"]) || null; });
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        let reason: string | null = null;
        if (chunks.length) {
          try { reason = JSON.parse(Buffer.concat(chunks).toString("utf8")).reason ?? null; } catch { reason = null; }
        }
        done({ ok: status === 200, status, reason });
      });
      req.on("error", error => {
        this.dropSession(env);
        done({ ok: false, status, reason: error.message });
      });
      req.end(body);
    });
  }

  close() {
    for (const env of [...this.sessions.keys()]) this.dropSession(env);
  }
}
