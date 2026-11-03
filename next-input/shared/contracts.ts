import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { validModelId } from "./model";

export const preferences = defineSettings({
  id: "preferences", scope: "host", version: 1,
  schema: z.object({ enabled: z.boolean().default(true),
    model: z.enum(["haiku", "sonnet", "opus", "custom"]).default("haiku"),
    customModel: z.string().default(""),
  }).refine(value => (value.customModel === "" && value.model !== "custom") || validModelId(value.customModel),
    { message: "Invalid model ID", path: ["customModel"] }),
});

export const suggestionSchema = z.object({
  agentId: z.string(), workspaceId: z.string(), token: z.string(),
  status: z.enum(["idle", "loading", "ready", "error"]),
  text: z.string(),
});
export type Suggestion = z.output<typeof suggestionSchema>;
export const ROW_KIND = "next-input";

export const predictionResult = z.object({
  status: z.enum(["ready", "empty", "expired", "unavailable", "error"]), text: z.string(),
});
export type PredictionResult = z.output<typeof predictionResult>;
export const predictSuggestion = defineRpc({
  name: "suggestions.predict", input: z.object({ agentId: z.string(), token: z.string() }),
  output: predictionResult,
});
export const claudeStatus = defineRpc({
  name: "claude.status", input: z.object({}),
  output: z.object({ path: z.string().nullable(), searched: z.array(z.string()) }),
});
export const sendSuggestion = defineRpc({
  name: "suggestions.send",
  input: z.object({ agentId: z.string(), token: z.string(), text: z.string().trim().min(1).max(2000) }),
  output: z.object({}),
});
