import { and, eq, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "../db/client.js";
import * as schema from "../db/schema.js";

export type StoredMessage = typeof schema.agentMessages.$inferSelect;
export type NewMessage = Omit<
  typeof schema.agentMessages.$inferInsert,
  "seq" | "conversationId"
>;

/** Serialize every writer, including server linking and readiness notices. */
export async function appendMessagesInTx(
  tx: DbTransaction,
  conversationId: string,
  messages: NewMessage[],
) {
  await tx.execute(
    sql`SELECT 1 FROM agent_conversations WHERE id = ${conversationId} FOR UPDATE`,
  );
  const rows = await tx
    .select({ seq: sql<number>`coalesce(max(seq), 0)::int` })
    .from(schema.agentMessages)
    .where(eq(schema.agentMessages.conversationId, conversationId));
  let seq = rows[0]?.seq ?? 0;
  const inserted: StoredMessage[] = [];
  for (const message of messages) {
    const row = await tx
      .insert(schema.agentMessages)
      .values({ ...message, conversationId, seq: ++seq })
      .onConflictDoNothing()
      .returning();
    if (row[0]) inserted.push(row[0]);
  }
  if (inserted.length > 0)
    await tx
      .update(schema.agentConversations)
      .set({ updatedAt: new Date() })
      .where(eq(schema.agentConversations.id, conversationId));
  return inserted;
}
export function appendMessages(
  db: Database,
  conversationId: string,
  messages: NewMessage[],
) {
  return db.transaction((tx) =>
    appendMessagesInTx(tx, conversationId, messages),
  );
}
export async function ownedConversation(
  db: Database,
  id: string,
  userId: string,
) {
  const rows = await db
    .select()
    .from(schema.agentConversations)
    .where(
      and(
        eq(schema.agentConversations.id, id),
        eq(schema.agentConversations.userId, userId),
      ),
    )
    .limit(1);
  return rows[0];
}
