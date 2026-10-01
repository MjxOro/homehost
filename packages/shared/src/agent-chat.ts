import type { RecipeId } from "./concierge-catalog.js";

export const AGENT_TEXT_MAX = 2000;
export const SECRET_GUARD_COPY =
  "That looks like a password or token. Please don't paste it here. When your service needs it, I'll ask for it in a secure field.";
export const SECRET_PLACEHOLDER =
  "[Message blocked: possible password or token]";

export interface ServerProposal {
  name: string;
  planId: string;
  recipeId: RecipeId;
}
export interface AgentToolResult {
  ok: boolean;
  message?: string;
  proposal?: ServerProposal;
  [key: string]: unknown;
}
export interface AgentMessage {
  id: string;
  seq: number;
  role: "user" | "assistant" | "tool" | "event";
  content: string;
  toolName: string | null;
  toolResult: AgentToolResult | null;
  requestId: string | null;
  createdAt: string;
}
export interface AgentConversationSummary {
  id: string;
  title: string;
  status: "pending" | "running" | "idle";
  settingUp: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AgentConversation extends AgentConversationSummary {
  messages: AgentMessage[];
}
