import { useCallback, useRef, useState, type FormEvent } from "react";
import type { AccessScope, AccessToken } from "@homehost/shared";
import { ACCESS_SCOPES, ACCESS_TOKEN_MAX_ACTIVE } from "@homehost/shared";
import { isApiError } from "../lib/api";
import { prefersReducedMotion } from "../lib/motion";
import {
  useAccessTokens,
  useCreateAccessToken,
  useDashboard,
  useSession,
} from "../lib/query";
import { RevokeTokenDialog } from "../components/RevokeTokenDialog";
import { CopyIcon, LockIcon, Spinner } from "../components/icons";
import {
  BUTTON_OUTLINE,
  BUTTON_PRIMARY,
  BUTTON_DANGER,
  BUTTON_GHOST_SM,
  CARD,
  CARD_HEAD,
  CARD_SUB,
  CARD_TITLE,
  Chip,
  ErrorState,
  FORM_ERROR,
  PageLoading,
} from "../components/primitives";

const SCOPE_COPY: Record<AccessScope, { label: string; hint: string }> = {
  "machines:read": {
    label: "Read machines",
    hint: "List machines and see their status.",
  },
  "machines:exec": {
    label: "Run commands",
    hint: "Run shell commands and read or write files on your machines.",
  },
  "machines:power": {
    label: "Start and stop",
    hint: "Start and stop your machines.",
  },
};

const DEFAULT_SCOPES: AccessScope[] = ["machines:read", "machines:exec"];
const EXPIRY_OPTIONS = [7, 30, 90] as const;
const DEFAULT_EXPIRY = 30;
const NAME_MAX = 60;

const INPUT =
  "min-h-11 w-full rounded-control border border-line-strong bg-ink-2 px-3 py-2 text-[14px] text-text-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const LABEL = "text-[13.5px] font-[650] text-text-1";
const CHECK_ROW =
  "flex min-h-11 cursor-pointer items-start gap-3 rounded-control border border-line px-3 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent";

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function tokenStatus(
  token: AccessToken,
  now: number,
): "active" | "expired" | "revoked" | "unknown" {
  if (token.revokedAt) return "revoked";
  const expires = Date.parse(token.expiresAt);
  if (Number.isNaN(expires)) return "unknown";
  return expires <= now ? "expired" : "active";
}

const STATUS_CLASS: Record<ReturnType<typeof tokenStatus>, string> = {
  active: "border-[rgba(94,201,143,0.4)] bg-ok-dim text-ok",
  expired: "border-line-strong text-text-2",
  revoked: "border-[rgba(224,108,108,0.4)] bg-bad-dim text-bad",
  unknown: "border-line-strong text-text-2",
};

const STATUS_LABEL: Record<ReturnType<typeof tokenStatus>, string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
  unknown: "Unknown",
};

export function TokensPage() {
  const session = useSession();
  const user = session.data?.user ?? null;
  const tokens = useAccessTokens(user?.id);
  const dashboard = useDashboard(user?.id);
  const create = useCreateAccessToken();

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<AccessScope[]>(DEFAULT_SCOPES);
  const [allMachines, setAllMachines] = useState(true);
  const [machineIds, setMachineIds] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState<number>(DEFAULT_EXPIRY);
  const [formError, setFormError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  const revokeTrigger = useRef<HTMLElement | null>(null);
  const revealRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    node.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    });
    node.focus({ preventScroll: true });
  }, []);

  if (session.isPending) return <PageLoading />;
  if (session.isError)
    return (
      <ErrorState
        error={session.error}
        onRetry={() => void session.refetch()}
      />
    );
  if (!user) return null;

  const machines = (dashboard.data?.requests ?? []).filter(
    (row) => row.status !== "deleted",
  );
  const machineName = new Map(machines.map((row) => [row.id, row.name]));
  const pendingAccount = [create.error, tokens.error].some(
    (error) => isApiError(error) && error.code === "AccountPending",
  );

  const toggleScope = (scope: AccessScope) =>
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((s) => s !== scope)
        : [...current, scope],
    );

  const toggleMachine = (id: string) =>
    setMachineIds((current) =>
      current.includes(id) ? current.filter((m) => m !== id) : [...current, id],
    );

  const dismissReveal = () => {
    setRevealed(null);
    setCopied(false);
    create.reset();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const trimmed = name.trim();
    if (trimmed.length === 0) return setFormError("Give the token a name.");
    if (scopes.length === 0)
      return setFormError("Pick at least one permission.");
    if (!allMachines && machineIds.length === 0)
      return setFormError(
        "Pick at least one machine, or choose All my machines.",
      );
    create.mutate(
      {
        name: trimmed,
        scopes,
        machineIds: allMachines ? null : machineIds,
        expiresInDays,
      },
      {
        onSuccess: (result) => {
          setRevealed(result.secret);
          setCopied(false);
          setName("");
        },
      },
    );
  };

  const copySecret = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
    } catch {
      setFormError("Copy failed. Select the secret and copy it by hand.");
    }
  };

  const origin = window.location.origin;
  const list = tokens.data?.tokens ?? [];
  const now = Date.now();
  const activeCount = list.filter(
    (t) => tokenStatus(t, now) === "active",
  ).length;
  const atLimit = activeCount >= ACCESS_TOKEN_MAX_ACTIVE;

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8">
      <header>
        <h1 className="text-[24px] font-[700] tracking-[-0.015em]">
          Agent access
        </h1>
        <p className="m-0 mt-1.5 max-w-[66ch] text-[14px] leading-[1.6] text-text-3">
          Give an AI agent a token to work with your machines. Tokens only reach
          the machines you pick, with only the permissions you tick, and stop
          working when they expire or you revoke them.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
        <section className={CARD} aria-labelledby="create-heading">
          <div className={CARD_HEAD}>
            <div>
              <h2 id="create-heading" className={CARD_TITLE}>
                Create a token
              </h2>
              <p className={CARD_SUB}>Shown once after you create it.</p>
            </div>
          </div>

          {pendingAccount ? (
            <div
              className={`${FORM_ERROR} flex items-start gap-2.5`}
              role="status"
            >
              <LockIcon className="mt-0.5 size-[18px] shrink-0" />
              <p className="m-0">
                Your account is still waiting for approval. You can create
                access tokens once an operator approves it.
              </p>
            </div>
          ) : (
            <form
              className="flex flex-col gap-5"
              onSubmit={onSubmit}
              noValidate
            >
              <div className="flex flex-col gap-2">
                <label htmlFor="token-name" className={LABEL}>
                  Name
                </label>
                <input
                  id="token-name"
                  className={INPUT}
                  value={name}
                  maxLength={NAME_MAX}
                  placeholder="e.g. Claude on my laptop"
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                />
              </div>

              <fieldset className="flex flex-col gap-2 border-0 p-0">
                <legend className={`${LABEL} mb-2`}>Permissions</legend>
                {ACCESS_SCOPES.map((scope) => (
                  <label key={scope} className={CHECK_ROW}>
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
                      checked={scopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[14px] font-[650]">
                        {SCOPE_COPY[scope].label}
                      </span>
                      <span className="text-[13px] leading-[1.5] text-text-3">
                        {SCOPE_COPY[scope].hint}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <fieldset className="flex flex-col gap-2 border-0 p-0">
                <legend className={`${LABEL} mb-2`}>Machines</legend>
                <label className={CHECK_ROW}>
                  <input
                    type="radio"
                    name="machine-scope"
                    className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
                    checked={allMachines}
                    onChange={() => setAllMachines(true)}
                  />
                  <span className="text-[14px] font-[650]">
                    All my machines
                  </span>
                </label>
                <label className={CHECK_ROW}>
                  <input
                    type="radio"
                    name="machine-scope"
                    className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
                    checked={!allMachines}
                    onChange={() => setAllMachines(false)}
                  />
                  <span className="text-[14px] font-[650]">
                    Only specific machines
                  </span>
                </label>
                {!allMachines ? (
                  machines.length === 0 ? (
                    <p className="m-0 text-[13px] text-text-3">
                      You have no machines yet.
                    </p>
                  ) : (
                    <div className="ml-1 flex flex-col gap-2 pl-4">
                      {machines.map((row) => (
                        <label key={row.id} className={CHECK_ROW}>
                          <input
                            type="checkbox"
                            className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
                            checked={machineIds.includes(row.id)}
                            onChange={() => toggleMachine(row.id)}
                          />
                          <span className="text-[14px]">{row.name}</span>
                        </label>
                      ))}
                    </div>
                  )
                ) : null}
              </fieldset>

              <div className="flex flex-col gap-2">
                <label htmlFor="token-expiry" className={LABEL}>
                  Expires after
                </label>
                <select
                  id="token-expiry"
                  className={INPUT}
                  value={expiresInDays}
                  onChange={(event) =>
                    setExpiresInDays(Number(event.target.value))
                  }
                >
                  {EXPIRY_OPTIONS.map((days) => (
                    <option key={days} value={days}>
                      {days} days
                    </option>
                  ))}
                </select>
              </div>

              {atLimit ? (
                <p className="m-0 text-[13px] text-text-3">
                  You have {ACCESS_TOKEN_MAX_ACTIVE} active tokens, the most
                  allowed. Revoke one before creating another.
                </p>
              ) : null}

              {formError ? (
                <p className={FORM_ERROR} role="alert">
                  {formError}
                </p>
              ) : null}
              {create.isError && !pendingAccount ? (
                <p className={FORM_ERROR} role="alert">
                  {isApiError(create.error)
                    ? create.error.message
                    : "Could not create the token. Try again."}
                </p>
              ) : null}

              <div>
                <button
                  type="submit"
                  className={BUTTON_PRIMARY}
                  disabled={create.isPending || atLimit}
                >
                  {create.isPending ? <Spinner className="spinner-sm" /> : null}
                  Create token
                </button>
              </div>
            </form>
          )}

          {revealed ? (
            <div
              ref={revealRef}
              tabIndex={-1}
              className="animate-fade-in mt-5 flex flex-col gap-3 rounded-control border border-accent-line bg-accent-dim p-4"
              role="region"
              aria-label="New token"
            >
              <p className="m-0 text-[14px] font-[650]">
                Copy your token now. It is shown once.
              </p>
              <code className="block break-all rounded-control bg-ink-1 px-3 py-2 font-mono text-[13px] text-text-1">
                {revealed}
              </code>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={BUTTON_OUTLINE}
                  onClick={copySecret}
                >
                  <CopyIcon />
                  {copied ? "Copied" : "Copy token"}
                </button>
                <button
                  type="button"
                  className={BUTTON_GHOST_SM}
                  onClick={dismissReveal}
                >
                  Done, I've saved it
                </button>
              </div>
              <div className="flex flex-col gap-2 text-[13px] text-text-2">
                <p className="m-0">Add it to Claude Code:</p>
                <code className="block break-all rounded-control bg-ink-1 px-3 py-2 font-mono text-[12.5px]">
                  {`claude mcp add --transport http homehost ${origin}/api/mcp --header "Authorization: Bearer ${revealed}"`}
                </code>
                <p className="m-0">
                  Or use the CLI. Install it once;{" "}
                  <code className="font-mono">homehost update</code> keeps it
                  current:
                </p>
                <code className="block break-all rounded-control bg-ink-1 px-3 py-2 font-mono text-[12.5px]">
                  {`curl -fsSL ${origin}/install.sh | sh`}
                </code>
                <code className="block break-all rounded-control bg-ink-1 px-3 py-2 font-mono text-[12.5px]">
                  {`echo ${revealed} | homehost login --url ${origin}`}
                </code>
              </div>
            </div>
          ) : null}
        </section>

        <section className={CARD} aria-labelledby="tokens-heading">
          <div className={CARD_HEAD}>
            <div>
              <h2 id="tokens-heading" className={CARD_TITLE}>
                Your tokens
              </h2>
              <p className={CARD_SUB}>
                {activeCount} of {ACCESS_TOKEN_MAX_ACTIVE} active.
              </p>
            </div>
          </div>

          {tokens.isPending ? (
            <PageLoading label="Loading tokens…" />
          ) : tokens.isError ? (
            <ErrorState
              error={tokens.error}
              onRetry={() => void tokens.refetch()}
            />
          ) : list.length === 0 ? (
            <p className="m-0 text-[14px] text-text-3">No tokens yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {list.map((token) => {
                const status = tokenStatus(token, now);
                const machineText =
                  token.machineIds === null
                    ? "All machines"
                    : token.machineIds
                        .map((id) => machineName.get(id) ?? "removed machine")
                        .join(", ");
                return (
                  <li
                    key={token.id}
                    className="flex flex-col gap-2 rounded-control border border-line p-3.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 break-words text-[15px] font-[650]">
                        {token.name}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[12.5px] font-semibold ${STATUS_CLASS[status]}`}
                      >
                        {STATUS_LABEL[status]}
                      </span>
                    </div>
                    <p className="m-0 font-mono text-[12.5px] text-text-3">
                      ••••{token.hint}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {token.scopes.map((scope) => (
                        <Chip key={scope}>{SCOPE_COPY[scope].label}</Chip>
                      ))}
                    </div>
                    <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
                      <dt className="text-text-3">Machines</dt>
                      <dd className="m-0 min-w-0 break-words">{machineText}</dd>
                      <dt className="text-text-3">Created</dt>
                      <dd className="m-0">{formatDate(token.createdAt)}</dd>
                      <dt className="text-text-3">Expires</dt>
                      <dd className="m-0">{formatDate(token.expiresAt)}</dd>
                      <dt className="text-text-3">Last used</dt>
                      <dd className="m-0">{formatDate(token.lastUsedAt)}</dd>
                    </dl>
                    {status === "active" ? (
                      <div>
                        <button
                          type="button"
                          className={BUTTON_DANGER}
                          onClick={(event) => {
                            revokeTrigger.current = event.currentTarget;
                            setRevoking(token);
                          }}
                        >
                          Revoke
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {revoking ? (
        <RevokeTokenDialog
          token={revoking}
          onClose={() => {
            setRevoking(null);
            revokeTrigger.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
