import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AGENT_TEXT_MAX,
  SECRET_PLACEHOLDER,
  containsSecret,
  type AgentConversation,
  type AgentMessage,
  type ServerProposal,
} from "@homehost/shared";
import { isApiError } from "../lib/api";
import { createErrorCopy, recipeEula } from "../lib/request-input";
import { recipeLabel } from "../lib/concierge";
import { formatDateTime, formatPlanSpecs, formatRelative } from "../lib/format";
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
import {
  ArrowRightIcon,
  ServerIcon,
  SparklesIcon,
  Spinner,
} from "../components/icons";
import {
  BUTTON_PRIMARY,
  BUTTON_OUTLINE_SM,
  CARD,
  EmptyState,
  ErrorState,
  FORM_ERROR,
  LINK_GHOST,
  LINK_PRIMARY,
  PageLoading,
} from "../components/primitives";

const TEXT =
  "m-0 whitespace-pre-wrap text-[14.5px] leading-[1.6] [overflow-wrap:anywhere]";
const AGENT_BUBBLE = `${TEXT} w-fit max-w-full rounded-card rounded-tl-sm border border-line bg-ink-1 px-3.5 py-2.5 text-text-1`;
const USER_BUBBLE = `${TEXT} ml-auto w-fit max-w-[85%] rounded-card rounded-br-sm border border-accent-line bg-accent-dim px-3.5 py-2.5 text-text-1 sm:max-w-[75%]`;
const NOTE =
  "m-0 flex items-start gap-2 text-[13px] leading-[1.55] text-text-3 [overflow-wrap:anywhere]";
/** Distance from the page bottom that still counts as following the chat. */
const PIN_SLACK_PX = 96;

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
      className={`${CARD} flex flex-col gap-1 text-[14px] leading-[1.55]`}
      aria-label={`Suggested server ${proposal.name}`}
    >
      <h3 className="m-0 text-[15px] font-semibold">{proposal.name}</h3>
      <p className="m-0 text-text-2">
        {plan ? `${plan.name} · ${formatPlanSpecs(plan)}` : proposal.planId}
      </p>
      <p className="m-0 text-text-2">
        Software: {recipeLabel(proposal.recipeId)}
      </p>
      {proposal.recipeId === "docker" ? (
        <p className="m-0 text-[12.5px] text-text-3">
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
          className={`${BUTTON_PRIMARY} mt-3 w-full sm:w-fit`}
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
        <p className="m-0 mt-2 text-[13px] text-text-3">
          Request sent. The progress is below.
        </p>
      )}
      {create.isError ? (
        <p className={`${FORM_ERROR} mt-2`} role="alert">
          {createErrorCopy(create.error)}
        </p>
      ) : null}
    </section>
  );
}

/** Homehost's side of the conversation: avatar on the first item of a run. */
function AgentTurn({
  avatar,
  children,
}: {
  avatar: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      {avatar ? (
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-accent-line bg-accent-dim text-accent [&_svg]:size-4"
        >
          <SparklesIcon />
        </span>
      ) : (
        <span aria-hidden="true" className="w-8 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">{children}</div>
    </div>
  );
}

type Row = { key: string; side: "user" | "agent"; node: ReactNode };

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
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);
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
  // Follow the newest message while the reader is at the bottom: replies,
  // the typing row and late-loading progress cards all grow the log. Only
  // user input may unpin; the router's own scroll reset on navigation and
  // our programmatic scrolls must not.
  useEffect(() => {
    const root = document.documentElement;
    const toBottom = () => window.scrollTo({ top: root.scrollHeight });
    let userScrolling = false;
    const onIntent = () => {
      userScrolling = true;
    };
    const onScroll = () => {
      if (!userScrolling) return;
      pinned.current =
        root.scrollHeight - (window.scrollY + window.innerHeight) <=
        PIN_SLACK_PX;
    };
    const observer = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    if (log.current) observer.observe(log.current);
    const intents = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const name of intents)
      window.addEventListener(name, onIntent, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    const frame = requestAnimationFrame(toBottom);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const name of intents) window.removeEventListener(name, onIntent);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  useEffect(() => {
    if (isApiError(turn.error) && turn.error.status === 401)
      void client.invalidateQueries({ queryKey: queryKeys.session });
  }, [turn.error, client]);
  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    pinned.current = true;
    setSendingText(containsSecret(value) ? SECRET_PLACEHOLDER : value);
    setText("");
    turn.mutate(value, { onSettled: () => setSendingText(null) });
  };

  const rows: Row[] = [];
  for (const message of conversation.messages) {
    if (message.role === "user") {
      rows.push({
        key: message.id,
        side: "user",
        node: (
          <p className={USER_BUBBLE}>
            <span className="sr-only">You: </span>
            {message.content}
          </p>
        ),
      });
      continue;
    }
    const proposal = message.toolResult?.proposal;
    if (proposal && message.toolResult?.ok) {
      const request = dashboard.data?.requests.find(
        (r) => r.id === message.requestId,
      );
      rows.push({
        key: message.id,
        side: "agent",
        node: (
          <>
            <ProposalCard message={message} proposal={proposal} />
            {request ? (
              <>
                <ServerTimeline
                  request={request}
                  activity={dashboard.data?.activity ?? []}
                  compact
                />
                {isReady(request) ? (
                  <ReadyCard request={request} focusOnMount={false} />
                ) : null}
              </>
            ) : message.requestId ? (
              <p className={`${NOTE} items-center`}>
                <Spinner className="spinner-sm" />
                Checking your server…
              </p>
            ) : null}
          </>
        ),
      });
      continue;
    }
    if (message.role === "tool" || message.role === "event") {
      if (!message.content) continue;
      rows.push({
        key: message.id,
        side: "agent",
        node: (
          <p className={NOTE}>
            <ServerIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {message.role === "event" ? (
                <span className="sr-only">Server progress: </span>
              ) : null}
              {message.content}
            </span>
          </p>
        ),
      });
      continue;
    }
    rows.push({
      key: message.id,
      side: "agent",
      node: (
        <p className={AGENT_BUBBLE}>
          <span className="sr-only">Homehost: </span>
          {message.content}
        </p>
      ),
    });
  }
  if (sendingText)
    rows.push({
      key: "sending",
      side: "user",
      node: <p className={USER_BUBBLE}>{sendingText}</p>,
    });
  if (busy)
    rows.push({
      key: "busy",
      side: "agent",
      node: (
        <p className={`${NOTE} min-h-8 items-center`}>
          <Spinner className="spinner-sm" />
          Thinking about your setup…
        </p>
      ),
    });

  return (
    // -mb cancels AppLayout main's pb-[88px] so the composer rests on the
    // viewport edge; the composer's own padding provides the gap instead.
    <div className="mx-auto -mb-[88px] flex w-full max-w-[760px] flex-col">
      <header className="flex flex-col gap-1 pb-6">
        <Link to="/agent" className={`${LINK_GHOST} -ml-3 w-fit px-3`}>
          ← Conversations
        </Link>
        <h1 className="m-0 text-[clamp(22px,3vw,28px)] font-bold tracking-[-0.01em]">
          Your setup helper
        </h1>
        <p className="m-0 text-[13.5px] text-text-3">
          Describe what you'd like to run. You decide before anything is
          created.
        </p>
      </header>
      <div
        ref={log}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        className="flex min-w-0 flex-col gap-4"
      >
        {rows.map((row, index) =>
          row.side === "user" ? (
            <div key={row.key} className="flex min-w-0 flex-col">
              {row.node}
            </div>
          ) : (
            <AgentTurn key={row.key} avatar={rows[index - 1]?.side !== "agent"}>
              {row.node}
            </AgentTurn>
          ),
        )}
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
      </div>
      <div className="sticky bottom-0 z-10 -mx-2 bg-linear-to-t from-ink-0 from-75% to-transparent px-2 pb-[max(12px,env(safe-area-inset-bottom))] pt-6">
        <form
          className="flex items-end gap-2 rounded-[22px] border border-line-strong bg-ink-1 py-1.5 pl-4 pr-1.5 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.5)] transition-colors duration-(--duration-fast) ease-out-quint focus-within:border-accent"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          aria-label="Send a message"
        >
          <label htmlFor="chat-message" className="sr-only">
            Message
          </label>
          <textarea
            ref={input}
            id="chat-message"
            name="message"
            rows={1}
            maxLength={AGENT_TEXT_MAX}
            value={text}
            aria-describedby="chat-hint"
            className="max-h-40 min-h-11 flex-1 resize-none overflow-y-auto border-0 bg-transparent py-2.5 text-[16px] leading-[1.5] text-text-1 placeholder:text-text-3 focus:outline-none"
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
          <button
            type="submit"
            aria-label="Send"
            className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-accent text-on-accent transition-colors duration-(--duration-fast) ease-out-quint enabled:hover:bg-accent-strong enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:enabled:active:scale-100 [&>svg]:size-5"
            disabled={busy || text.trim().length === 0}
          >
            <ArrowRightIcon />
          </button>
        </form>
        <p id="chat-hint" className="m-0 mt-2 px-4 text-[12px] text-text-3">
          Please don't paste passwords or tokens.
          <span className="hidden sm:inline">
            {" "}
            Shift+Enter adds a new line.
          </span>
        </p>
      </div>
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
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-[clamp(22px,3vw,28px)] font-bold tracking-[-0.01em]">
            Agent
          </h1>
          <p className="m-0 mt-1.5 text-[14px] text-text-2">
            Your setup conversations, newest first.
          </p>
        </div>
        <Link to="/" className={`${LINK_PRIMARY} w-full sm:w-auto`}>
          Start a conversation
        </Link>
      </div>
      {conversations.data.length === 0 ? (
        <EmptyState
          title="What would you like to run?"
          copy="Start from the dashboard and we'll help you set up a server."
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {conversations.data.map((c) => (
            <li key={c.id}>
              <Link
                to="/chat/$id"
                params={{ id: c.id }}
                className={`${CARD} group flex min-h-11 items-center gap-3 no-underline transition-colors duration-(--duration-fast) ease-out-quint hover:border-line-strong hover:bg-ink-2`}
              >
                <SparklesIcon
                  className="size-[18px] shrink-0 text-accent"
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14.5px] font-medium text-text-1">
                    {c.title}
                  </span>
                  <time
                    dateTime={c.updatedAt}
                    title={formatDateTime(c.updatedAt)}
                    className="text-[12.5px] text-text-3"
                  >
                    {formatRelative(c.updatedAt)}
                  </time>
                </span>
                {c.settingUp ? (
                  <span className="shrink-0 rounded-full bg-accent-dim px-2.5 py-1 text-[12px] font-semibold text-accent">
                    Setting up
                  </span>
                ) : null}
                <span
                  aria-hidden="true"
                  className="shrink-0 text-[18px] text-text-3 transition-transform duration-(--duration-fast) group-hover:translate-x-0.5 group-hover:text-text-1 motion-reduce:transition-none"
                >
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
