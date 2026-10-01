import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AGENT_TEXT_MAX,
  RECIPES,
  SECRET_PLACEHOLDER,
  containsSecret,
  type AgentConversation,
  type AgentMessage,
  type ServerProposal,
} from "@homehost/shared";
import { isApiError } from "../lib/api";
import { createErrorCopy, recipeEula } from "../lib/request-input";
import { recipeLabel } from "../lib/concierge";
import { formatPlanSpecs } from "../lib/format";
import {
  queryKeys,
  useAgentConversation,
  useAgentConversations,
  useAgentTurn,
  useCreateRequest,
  useDashboard,
  usePlans,
  useSession,
} from "../lib/query";
import { EulaCheckbox } from "../components/SetupHelper";
import {
  isReady,
  isSettling,
  ReadyCard,
  ServerTimeline,
} from "../components/ServerProgress";
import { SignInGate } from "../components/SignInGate";
import { Spinner } from "../components/icons";
import {
  BUTTON_PRIMARY,
  BUTTON_OUTLINE_SM,
  CARD,
  EmptyState,
  ErrorState,
  FORM_ERROR,
  LINK_GHOST,
  PageLoading,
} from "../components/primitives";

const BUBBLE =
  "max-w-full rounded-control border border-line bg-ink-2 p-3.5 text-[14px] leading-[1.6] [overflow-wrap:anywhere]";
function ProposalCard({
  message,
  proposal,
}: {
  message: AgentMessage;
  proposal: ServerProposal;
}) {
  const plans = usePlans().data ?? [];
  const create = useCreateRequest();
  const [accepted, setAccepted] = useState(false);
  const eula = recipeEula(proposal.recipeId);
  const plan = plans.find((p) => p.id === proposal.planId);
  return (
    <section
      className={BUBBLE}
      aria-label={`Suggested server ${proposal.name}`}
    >
      <h3 className="m-0 text-[15px] font-semibold">{proposal.name}</h3>
      <p className="m-0 mt-1 text-text-2">
        {plan ? `${plan.name} · ${formatPlanSpecs(plan)}` : proposal.planId}
      </p>
      <p className="m-0 mt-1 text-text-2">
        Software: {recipeLabel(proposal.recipeId)}
      </p>
      {proposal.recipeId === "docker" ? (
        <p className="m-0 mt-1 text-[12.5px] text-text-3">
          Ready for your app or bot. I'll be able to set it up for you soon.
        </p>
      ) : null}
      {eula && !message.requestId ? (
        <EulaCheckbox
          id={`chat-eula-${message.id}`}
          eula={eula}
          checked={accepted}
          disabled={create.isPending}
          onChange={setAccepted}
        />
      ) : null}
      {!message.requestId ? (
        <button
          type="button"
          className={`${BUTTON_PRIMARY} mt-3 min-h-11`}
          disabled={create.isPending || (eula !== null && !accepted)}
          onClick={() =>
            create.mutate({
              ...proposal,
              agentProposalId: message.id,
              eulaAccepted: eula ? accepted : undefined,
            })
          }
        >
          {create.isPending ? <Spinner className="spinner-sm" /> : null}Create
          it
        </button>
      ) : (
        <p className="m-0 mt-2 text-text-3">
          Request sent. The progress is below.
        </p>
      )}
      {create.isError ? (
        <p className={FORM_ERROR} role="alert">
          {createErrorCopy(create.error)}
        </p>
      ) : null}
    </section>
  );
}

function ChatView({
  conversation,
  userId,
}: {
  conversation: AgentConversation;
  userId: string;
}) {
  const [text, setText] = useState("");
  const [sendingText, setSendingText] = useState<string | null>(null);
  const turn = useAgentTurn(userId, conversation.id);
  const started = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const requestIds = conversation.messages.flatMap((m) =>
    m.requestId ? [m.requestId] : [],
  );
  const dashboard = useDashboard(userId, (data) =>
    data?.requests.some(
      (r) => requestIds.includes(r.id) && isSettling(r, data.activity),
    )
      ? 2500
      : 10000,
  );
  const busy = turn.isPending || conversation.status === "running";
  useEffect(() => {
    if (conversation.status !== "pending" || started.current) return;
    started.current = true;
    turn.mutate(undefined);
  }, [conversation.status, turn.mutate]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [conversation.messages.length, sendingText]);
  useEffect(() => {
    if (isApiError(turn.error) && turn.error.status === 401)
      void client.invalidateQueries({ queryKey: queryKeys.session });
  }, [turn.error, client]);
  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    setSendingText(containsSecret(value) ? SECRET_PLACEHOLDER : value);
    setText("");
    turn.mutate(value, { onSettled: () => setSendingText(null) });
  };
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 pb-4">
      <div className="flex flex-col gap-2">
        <Link to="/agent" className={`${LINK_GHOST} -ml-3 w-fit px-3`}>
          ← Conversations
        </Link>
        <h1 className="m-0 text-[clamp(22px,3vw,28px)] font-bold">
          Your setup helper
        </h1>
        <p className="m-0 text-[13.5px] text-text-3">
          Describe what you'd like to run. You decide before anything is
          created.
        </p>
      </div>
      <div
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        className="flex min-w-0 flex-col gap-3"
      >
        {conversation.messages.map((message) => {
          const proposal = message.toolResult?.proposal;
          if (message.role === "tool" && !proposal)
            return message.content ? (
              <p key={message.id} className={`${BUBBLE} m-0 text-text-2`}>
                {message.content}
              </p>
            ) : null;
          if (proposal && message.toolResult?.ok) {
            const request = dashboard.data?.requests.find(
              (r) => r.id === message.requestId,
            );
            return (
              <div key={message.id} className="flex min-w-0 flex-col gap-3">
                <ProposalCard message={message} proposal={proposal} />
                {request ? (
                  <>
                    <ServerTimeline
                      request={request}
                      activity={dashboard.data?.activity ?? []}
                      compact
                    />
                    {isReady(request) ? <ReadyCard request={request} /> : null}
                  </>
                ) : message.requestId ? (
                  <p className={BUBBLE}>Checking your server…</p>
                ) : null}
              </div>
            );
          }
          return (
            <div
              key={message.id}
              className={`${BUBBLE} ${message.role === "user" ? "ml-auto w-fit bg-accent-dim" : message.role === "event" ? "border-dashed text-text-3" : "mr-auto"}`}
            >
              <p className="m-0 mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">
                {message.role === "user"
                  ? "You"
                  : message.role === "event"
                    ? "Server progress"
                    : "Homehost"}
              </p>
              <p className="m-0 whitespace-pre-wrap">{message.content}</p>
            </div>
          );
        })}
        {sendingText ? (
          <p className={`${BUBBLE} m-0 ml-auto bg-accent-dim`}>{sendingText}</p>
        ) : null}
        {busy ? (
          <p className="m-0 flex items-center gap-2 text-[13.5px] text-text-3">
            <Spinner className="spinner-sm" />
            Thinking about your setup…
          </p>
        ) : null}
        <div ref={end} />
      </div>
      {dashboard.isError && requestIds.length > 0 ? (
        <p className={FORM_ERROR} role="alert">
          We couldn't check your server's progress just now. This page keeps
          trying.
        </p>
      ) : null}
      {turn.isError ? (
        <div className="flex flex-col gap-2">
          <p className={FORM_ERROR} role="alert">
            {isApiError(turn.error)
              ? turn.error.message
              : "The reply didn't arrive. Please try again."}
          </p>
          {conversation.status === "pending" ? (
            <button
              className={`${BUTTON_OUTLINE_SM} w-fit`}
              type="button"
              disabled={busy}
              onClick={() => turn.mutate(undefined)}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      <form
        className="sticky bottom-0 flex flex-col gap-2 rounded-control border border-line-strong bg-ink-1 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        aria-label="Send a message"
      >
        <label htmlFor="chat-message" className="text-[13.5px] font-semibold">
          Message
        </label>
        <textarea
          id="chat-message"
          name="message"
          rows={2}
          maxLength={AGENT_TEXT_MAX}
          value={text}
          disabled={busy}
          className="min-h-11 w-full resize-y rounded-control border border-line bg-ink-2 p-3 text-[16px] text-text-1"
          placeholder="e.g. how do I log in?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="m-0 text-[12px] text-text-3">
            Please don't paste passwords or tokens.
          </p>
          <button
            type="submit"
            className={BUTTON_PRIMARY}
            disabled={busy || text.trim().length === 0}
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

export function AgentChatPage() {
  const session = useSession();
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  const userId = session.data?.user?.id;
  const conversation = useAgentConversation(userId, id);
  if (session.isPending) return <PageLoading label="Loading your session…" />;
  if (!userId)
    return (
      <SignInGate title="Sign in to chat">
        Sign in to set up your server.
      </SignInGate>
    );
  if (conversation.isPending)
    return <PageLoading label="Opening your conversation…" />;
  if (conversation.isError)
    return (
      <ErrorState
        error={conversation.error}
        title="We couldn't open that conversation"
        onRetry={() => void conversation.refetch()}
      />
    );
  return (
    <ChatView
      key={`${userId}:${id}`}
      conversation={conversation.data}
      userId={userId}
    />
  );
}
export function AgentConversationsPage() {
  const session = useSession();
  const userId = session.data?.user?.id;
  const conversations = useAgentConversations(userId);
  if (session.isPending) return <PageLoading label="Loading your session…" />;
  if (!userId)
    return (
      <SignInGate title="Sign in to chat">
        Sign in to see your conversations.
      </SignInGate>
    );
  if (conversations.isPending)
    return <PageLoading label="Loading conversations…" />;
  if (conversations.isError)
    return (
      <ErrorState
        error={conversations.error}
        onRetry={() => void conversations.refetch()}
      />
    );
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
      <h1 className="m-0 text-[26px] font-bold">Agent</h1>
      <Link to="/" className={`${LINK_GHOST} w-fit`}>
        Start a conversation
      </Link>
      {conversations.data.length === 0 ? (
        <EmptyState
          title="What would you like to run?"
          copy="Start from the dashboard and we'll help you set up a server."
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {conversations.data.map((c) => (
            <li key={c.id}>
              <Link
                to="/chat/$id"
                params={{ id: c.id }}
                className={`${CARD} flex min-h-11 items-center gap-3 no-underline`}
              >
                <span className="min-w-0 flex-1 truncate text-text-1">
                  {c.title}
                </span>
                {c.settingUp ? (
                  <span className="shrink-0 rounded-full bg-accent-dim px-2 py-1 text-[12px] text-accent">
                    Setting up
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
