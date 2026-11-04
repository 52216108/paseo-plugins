// App（plugin.rpc.invoke）与插件之间的 RPC 契约。App 已上线，字段名与语义不得改动。
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 令牌：App 传小写 hex；这里兼容大写并统一转小写（令牌会拼进 APNs 请求路径，必须严格校验）。
const token = z.string().min(1).max(512).regex(/^[0-9a-fA-F]+$/, "令牌必须是 hex").transform(v => v.toLowerCase());

export const registerInput = z.object({
  deviceId: z.string().min(1).max(200),
  // bundleId 会拼进 apns-topic 请求头，只允许合法的 bundle 字符。
  bundleId: z.string().min(1).max(200).regex(/^[A-Za-z0-9.-]+$/, "bundleId 不合法"),
  environment: z.enum(["development", "production"]),
  // 省略 = 保持原值；null = 清除。
  pushToStartToken: token.nullable().optional(),
  activityToken: token.nullable().optional(),
  hosts: z.array(z.object({ serverId: z.string().min(1).max(200), label: z.string().max(200) })).max(50),
});
export type RegisterInput = z.output<typeof registerInput>;

export const activityRegister = defineRpc({
  name: "activity.register",
  input: registerInput,
  output: z.object({ configured: z.boolean(), serverId: z.string() }),
});

export const activityUnregister = defineRpc({
  name: "activity.unregister",
  input: z.object({ deviceId: z.string().min(1).max(200) }),
  output: z.object({ ok: z.boolean() }),
});

export const activityConfigure = defineRpc({
  name: "activity.configure",
  input: z.object({ teamId: z.string(), keyId: z.string(), p8: z.string() }),
  output: z.object({ configured: z.boolean() }),
});

export const lastPushSchema = z.object({
  at: z.number(), ok: z.boolean(), status: z.number().nullable(), reason: z.string().nullable(),
});
export type LastPush = z.output<typeof lastPushSchema>;

export const activityStatus = defineRpc({
  name: "activity.status",
  input: z.object({}),
  output: z.object({
    configured: z.boolean(),
    teamId: z.string().nullable(),
    keyId: z.string().nullable(),
    devices: z.number(),
    lastPush: lastPushSchema.nullable(),
  }),
});
