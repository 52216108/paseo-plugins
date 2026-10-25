import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "preferences", scope: "host", version: 1,
  schema: z.object({ enabled: z.boolean().default(true) }),
});

export const suggestionSchema = z.object({
  agentId: z.string(), workspaceId: z.string(), token: z.string(),
  status: z.enum(["loading", "ready", "error"]),
  text: z.string(),
});
export type Suggestion = z.output<typeof suggestionSchema>;
export const ROW_KIND = "next-input";

export const listSuggestions = defineRpc({
  name: "suggestions.list", input: z.object({}),
  output: z.object({ items: z.array(suggestionSchema) }),
});
export const sendSuggestion = defineRpc({
  name: "suggestions.send",
  input: z.object({ agentId: z.string(), token: z.string(), text: z.string().trim().min(1).max(2000) }),
  output: z.object({}),
});
