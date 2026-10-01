import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { FocusRef } from "./SetupHelper";
import { SUGGEST_TEXT_MAX, type Plan } from "@homehost/shared";
import { setupSlug } from "../lib/concierge";
import { useCreateRequest, usePlans } from "../lib/query";
import {
  createErrorCopy,
  NAME_MAX,
  nameError,
  recipeEula,
  requestableRecipe,
  sshKeyError,
} from "../lib/request-input";
import { ArrowRightIcon, SparklesIcon, Spinner } from "./icons";
import {
  BUTTON_GHOST_SM,
  BUTTON_PRIMARY,
  FORM_ERROR,
  LINK_GHOST,
} from "./primitives";
import {
  ACTIONS,
  BUSY,
  ConciergeResult,
  EulaCheckbox,
  Notes,
  RESULT_CARD,
  RESULT_TITLE,
  suggestionNotes,
  SuggestionSpecs,
  useConcierge,
  type SuggestedResult,
} from "./SetupHelper";

const EXAMPLES = [
  "Minecraft server for friends",
  "Discord bot running 24/7",
  "A place to try coding",
  "A website for my project",
];

const FIELD_LABEL = "text-[13.5px] font-semibold text-text-1";
const INPUT_FIELD =
  "min-h-11 w-full rounded-control border border-line-strong bg-ink-1 px-3 py-2.5 text-[14.5px] text-text-1 transition-colors duration-(--duration-fast) ease-out-quint placeholder:text-text-3 focus:border-accent aria-invalid:border-bad disabled:opacity-60";
const FIELD_HINT = "m-0 max-w-[62ch] text-[12.5px] leading-[1.5] text-text-3";

/**
 * Last step of the search box: what will be created, with the name, license
 * and optional SSH key, and the one button that creates it.
 */
function ConfirmCard({
  result,
  plans,
  headingRef,
  onStartOver,
}: {
  result: SuggestedResult;
  plans: readonly Plan[];
  headingRef: FocusRef;
  onStartOver: () => void;
}) {
  const createRequest = useCreateRequest();
  const navigate = useNavigate();
  const [name, setName] = useState(() =>
    setupSlug(result.useCase, result.recipeId),
  );
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [sshKey, setSshKey] = useState("");
  const [attempted, setAttempted] = useState(false);

  const recipeId = requestableRecipe(result.recipeId);
  const eula = recipeEula(recipeId);
  const trimmedKey = sshKey.trim();
  const nameProblem = nameError(name);
  const keyProblem = sshKeyError(trimmedKey);
  const pending = createRequest.isPending;

  return (
    <form
      className={RESULT_CARD}
      noValidate
      aria-labelledby="confirm-heading"
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (nameProblem || keyProblem || (eula && !eulaAccepted) || pending)
          return;
        createRequest.mutate(
          {
            name: name.trim(),
            planId: result.planId,
            recipeId,
            eulaAccepted: eula ? true : undefined,
            sshPubkey: trimmedKey || undefined,
          },
          {
            onSuccess: (request) =>
              void navigate({
                to: "/servers/$id",
                params: { id: request.id },
              }),
          },
        );
      }}
    >
      <h3
        id="confirm-heading"
        className={RESULT_TITLE}
        tabIndex={-1}
        ref={headingRef}
      >
        Here's what we'll create
      </h3>
      <SuggestionSpecs result={result} plans={plans} />
      <Notes items={suggestionNotes(result)} />

      <div className="flex flex-col gap-2">
        <label htmlFor="confirm-name" className={FIELD_LABEL}>
          Server name
        </label>
        <input
          id="confirm-name"
          name="server-name"
          type="text"
          className={INPUT_FIELD}
          value={name}
          maxLength={NAME_MAX + 16}
          disabled={pending}
          aria-invalid={attempted && nameProblem ? true : undefined}
          aria-describedby="confirm-name-hint"
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
        <p id="confirm-name-hint" className={FIELD_HINT}>
          Also the start of its web address. You can change it.
        </p>
        {attempted && nameProblem ? (
          <p className={FORM_ERROR} role="alert">
            {nameProblem}
          </p>
        ) : null}
      </div>

      {eula ? (
        <EulaCheckbox
          id="confirm-eula"
          eula={eula}
          checked={eulaAccepted}
          disabled={pending}
          onChange={setEulaAccepted}
        />
      ) : null}

      <details className="group rounded-control border border-line bg-ink-1 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-[13.5px] font-semibold text-text-2 hover:text-text-1">
          Advanced
          <span
            className="text-text-3 transition-transform duration-(--duration-fast) group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden="true"
          >
            ›
          </span>
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <label htmlFor="confirm-ssh-key" className={FIELD_LABEL}>
            SSH public key <span className={FIELD_HINT}>(optional)</span>
          </label>
          <textarea
            id="confirm-ssh-key"
            name="ssh-key"
            rows={3}
            className={`${INPUT_FIELD} font-mono`}
            value={sshKey}
            disabled={pending}
            aria-invalid={attempted && keyProblem ? true : undefined}
            aria-describedby="confirm-ssh-key-hint"
            placeholder="ssh-ed25519 AAAA… you@machine"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setSshKey(event.target.value)}
          />
          <p id="confirm-ssh-key-hint" className={FIELD_HINT}>
            Key-only root login when set. Empty means a generated password,
            shown once on your servers list.
          </p>
        </div>
      </details>
      {/* Outside <details> so a bad key is visible even when it is closed. */}
      {attempted && keyProblem ? (
        <p className={FORM_ERROR} role="alert">
          SSH key (Advanced): {keyProblem}
        </p>
      ) : null}

      {createRequest.isError ? (
        <p className={FORM_ERROR} role="alert">
          {createErrorCopy(createRequest.error)}
        </p>
      ) : null}

      <div className={ACTIONS}>
        <button
          type="submit"
          className={`${BUTTON_PRIMARY} w-full sm:w-auto`}
          disabled={pending || (eula !== null && !eulaAccepted)}
        >
          {pending ? <Spinner className="spinner-sm" /> : null}
          Create it
        </button>
        <button
          type="button"
          className={BUTTON_GHOST_SM}
          disabled={pending}
          onClick={onStartOver}
        >
          Start over
        </button>
      </div>
    </form>
  );
}

/**
 * Google-like box at the top of the signed-in dashboard: describe what you
 * want, confirm the suggested setup, and land on the progress
 * page. Results expand in place under the box.
 */
export function ConciergeSearch() {
  const concierge = useConcierge<HTMLInputElement>(false);
  const plans = usePlans().data ?? [];
  const { text, busy } = concierge;
  const open =
    concierge.unavailable ||
    busy ||
    concierge.error !== null ||
    concierge.result !== null;

  return (
    <section aria-labelledby="ask-heading" className="flex flex-col gap-3">
      <h2
        id="ask-heading"
        className="text-[clamp(20px,2.6vw,26px)] font-[700] tracking-[-0.015em]"
      >
        What do you want to run?
      </h2>
      <form
        role="search"
        aria-labelledby="ask-heading"
        onSubmit={(event) => {
          event.preventDefault();
          concierge.submit();
        }}
      >
        <div className="relative">
          <SparklesIcon className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-accent" />
          <input
            ref={concierge.inputRef}
            id="ask-text"
            name="ask-text"
            type="text"
            enterKeyHint="go"
            autoComplete="off"
            className="h-14 w-full rounded-full border border-line-strong bg-ink-1 pl-12 pr-16 text-[16px] text-text-1 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.5)] transition-colors duration-(--duration-fast) ease-out-quint placeholder:text-text-3 hover:border-text-3 focus:border-accent"
            value={text}
            maxLength={SUGGEST_TEXT_MAX}
            aria-labelledby="ask-heading"
            aria-describedby="ask-hint"
            placeholder="e.g. a Minecraft server for 5 friends"
            onChange={(event) => concierge.setText(event.target.value)}
          />
          <button
            type="submit"
            aria-label="Find a setup"
            className={`absolute right-1.5 top-1/2 inline-flex size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-accent text-on-accent transition-colors duration-(--duration-fast) ease-out-quint hover:bg-accent-strong ${BUSY} [&>svg]:size-5 [&_.spinner]:text-on-accent`}
            aria-disabled={busy || text.trim().length === 0 || undefined}
          >
            {busy ? <Spinner className="spinner-sm" /> : <ArrowRightIcon />}
          </button>
        </div>
      </form>
      <p id="ask-hint" className="sr-only">
        Describe it in your own words, in any language. We suggest a server size
        and software, and you confirm before anything is created.
      </p>
      <ul
        className="m-0 flex list-none flex-wrap gap-2 p-0"
        aria-label="Examples"
      >
        {EXAMPLES.map((example) => (
          <li key={example}>
            <button
              type="button"
              className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border border-line-strong bg-ink-1 px-3.5 text-[13.5px] text-text-2 transition-colors duration-(--duration-fast) ease-out-quint hover:border-accent-line hover:text-accent ${BUSY}`}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                concierge.setText(example);
                concierge.submit(example);
              }}
            >
              {example}
            </button>
          </li>
        ))}
      </ul>
      {/* Expands from zero height when the first answer arrives. */}
      <div
        className={`grid transition-[grid-template-rows] duration-(--duration-slow) ease-out-quint motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        {/* -mx-1/px-1 keep focus rings clear of the clipping edge. */}
        <div className="-mx-1 min-h-0 overflow-hidden px-1">
          <div
            aria-live="polite"
            aria-busy={busy}
            className="pb-1 pt-2 empty:hidden"
          >
            <ConciergeResult
              concierge={concierge}
              disabled={false}
              manualAction={
                <Link to="/new" className={LINK_GHOST}>
                  Pick a plan yourself
                </Link>
              }
              suggested={(result, headingRef) => (
                <ConfirmCard
                  result={result}
                  plans={plans}
                  headingRef={headingRef}
                  onStartOver={concierge.startOver}
                />
              )}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
