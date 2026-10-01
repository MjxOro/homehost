import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  SUGGEST_TEXT_MAX,
  SECRET_GUARD_COPY,
  containsSecret,
  type OfferedUseCaseId,
  type Plan,
  type RecipeId,
  type SuggestBody,
  type Suggestion,
} from "@homehost/shared";
import { isApiError } from "../lib/api";
import {
  DOCKER_SETUP_COPY,
  notOfferedCopy,
  recipeLabel,
  REFUSED_COPY,
  suggestErrorCopy,
  useCaseLabel,
  warningCopy,
} from "../lib/concierge";
import { formatPlanSpecs } from "../lib/format";
import { recipeComingSoon } from "../lib/request-input";
import { usePlans, useSuggest } from "../lib/query";
import { InfoIcon, Spinner } from "./icons";
import {
  BUTTON_GHOST_SM,
  BUTTON_OUTLINE_SM,
  BUTTON_PRIMARY,
  FORM_ERROR,
} from "./primitives";

/**
 * The "what's it for?" concierge, shared by the dashboard search box and the
 * New request page: `useConcierge` owns the conversation, `ConciergeResult`
 * renders its answer, and each page supplies its own input and its own action
 * for a finished suggestion.
 */

export interface SetupPick {
  planId: string;
  useCase: OfferedUseCaseId;
  recipeId: RecipeId;
}

export type SuggestedResult = Extract<Suggestion, { outcome: "suggested" }>;

// A 503 means the concierge is not configured: remember it until the next page
// load so every concierge surface falls back without asking again.
let conciergeUnavailable = false;

const INPUT_FIELD =
  "min-h-11 w-full rounded-control border border-line-strong bg-ink-2 px-3 py-2.5 text-[14.5px] text-text-1 transition-colors duration-(--duration-fast) ease-out-quint placeholder:text-text-3 focus:border-accent aria-invalid:border-bad disabled:opacity-60";
const FIELD_HINT = "m-0 max-w-[62ch] text-[12.5px] leading-[1.5] text-text-3";
const COUNTER_BASE = "m-0 whitespace-nowrap font-mono text-[12px]";
// Busy or empty controls stay focusable (aria-disabled, guarded in the
// handler) so keyboard focus is not dropped while a suggestion loads.
export const BUSY = "aria-disabled:cursor-not-allowed aria-disabled:opacity-55";
export const RESULT_CARD =
  "animate-fade-in flex flex-col gap-3 rounded-control border border-line-strong bg-ink-2 p-3.5";
export const RESULT_TITLE = "text-[14.5px] font-[650]";
const RESULT_COPY = "m-0 text-[13.5px] leading-[1.55] text-text-2";
const NOTE =
  "m-0 flex items-start gap-2 text-[13px] leading-[1.55] text-text-2 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-3";
export const ACTIONS = "flex flex-wrap gap-2.5";

export function Notes({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {items.map((item) => (
        <li key={item} className={NOTE}>
          <InfoIcon aria-hidden="true" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Spec({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-3">{term}</dt>
      <dd className="m-0 min-w-0 text-text-1 [overflow-wrap:anywhere]">
        {children}
      </dd>
    </>
  );
}

/** What a suggestion would create: use case, size and software. */
export function SuggestionSpecs({
  result,
  plans,
}: {
  result: SuggestedResult;
  plans: readonly Plan[];
}) {
  const plan = plans.find((p) => p.id === result.planId);
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13.5px] leading-[1.5]">
      <Spec term="For">{useCaseLabel(result.useCase)}</Spec>
      <Spec term="Size">
        {plan ? `${plan.name} · ${formatPlanSpecs(plan)}` : result.planId}
      </Spec>
      <Spec term="Software">
        {recipeComingSoon(result.recipeId)
          ? `Plain Ubuntu (${recipeLabel(result.recipeId)} coming soon)`
          : recipeLabel(result.recipeId)}
        {result.recipeId === "docker" ? (
          <p className="m-0 mt-1 text-[12.5px] leading-[1.5] text-text-3">
            {DOCKER_SETUP_COPY}
          </p>
        ) : null}
      </Spec>
    </dl>
  );
}

/** Notes under a suggestion: "coming soon" setups first, then API warnings. */
export function suggestionNotes(result: SuggestedResult): string[] {
  const warnings = warningCopy(result.warnings);
  return recipeComingSoon(result.recipeId)
    ? [
        `Automatic setup for ${recipeLabel(result.recipeId)} is coming soon. For now you'll get a clean Ubuntu server you can set it up on yourself.`,
        ...warnings,
      ]
    : warnings;
}

/** Required license checkbox; the link opens the license in a new tab. */
export function EulaCheckbox({
  id,
  eula,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  eula: { label: string; url: string };
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        className="mt-[13px] size-[18px] shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
        checked={checked}
        disabled={disabled}
        required
        aria-required="true"
        onChange={(event) => onChange(event.target.checked)}
      />
      <label
        htmlFor={id}
        className="flex min-h-11 cursor-pointer items-center text-[13.5px] leading-[1.5] text-text-1"
      >
        <span>
          I accept the{" "}
          <a
            href={eula.url}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-accent underline underline-offset-2 hover:text-accent-strong"
          >
            {eula.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          .
        </span>
      </label>
    </div>
  );
}

/** Concierge conversation state; `T` is the free-text control the page renders. */
export interface Concierge<T extends HTMLElement = HTMLElement> {
  text: string;
  setText: (text: string) => void;
  busy: boolean;
  /** The server has no concierge (503); pages fall back to picking a plan. */
  unavailable: boolean;
  result: Suggestion | null;
  error: Error | null;
  lastBody: SuggestBody | null;
  /** Bumped on every settled call: re-keys the result so it fades in again. */
  seq: number;
  /** "Start over" returns focus here. */
  inputRef: RefObject<T>;
  /** Ref for the element that takes focus when a result replaces a control. */
  resultRef: FocusRef;
  /** Ask about `value` (defaults to the typed text). */
  submit: (value?: string) => void;
  retry: () => void;
  startOver: () => void;
}

export function useConcierge<T extends HTMLElement>(
  disabled: boolean,
): Concierge<T> {
  const suggest = useSuggest();
  const [unavailable, setUnavailable] = useState(conciergeUnavailable);
  const [text, setText] = useState("");
  const [lastBody, setLastBody] = useState<SuggestBody | null>(null);
  const [result, setResult] = useState<Suggestion | null>(null);
  // Bumped on every settled call: re-keys the result so it fades in again.
  const [seq, setSeq] = useState(0);
  const [secretError, setSecretError] = useState<Error | null>(null);
  const inputRef = useRef<T>(null);
  const resultFocus = useRef<HTMLElement | null>(null);
  const focusResult = useRef(false);

  // Retrying replaces the control that had focus;
  // hand focus to the new result instead of dropping it on <body>.
  useEffect(() => {
    if (!focusResult.current) return;
    focusResult.current = false;
    resultFocus.current?.focus();
  }, [seq]);

  const busy = suggest.isPending;

  const run = (body: SuggestBody, fromResult: boolean) => {
    if (busy || disabled || unavailable) return;
    if (containsSecret(body.text)) {
      setSecretError(new Error(SECRET_GUARD_COPY));
      return;
    }
    setSecretError(null);
    focusResult.current = fromResult;
    setLastBody(body);
    suggest.mutate(body, {
      onSuccess: (suggestion) => {
        setResult(suggestion);
        setSeq((n) => n + 1);
      },
      onError: (error) => {
        if (isApiError(error) && error.status === 503) {
          conciergeUnavailable = true;
          setUnavailable(true);
          return;
        }
        setSeq((n) => n + 1);
      },
    });
  };

  return {
    text,
    setText,
    busy,
    unavailable,
    result,
    error: secretError ?? (suggest.isError ? suggest.error : null),
    lastBody,
    seq,
    inputRef,
    resultRef: (node) => {
      resultFocus.current = node;
    },
    submit: (value = text) => {
      const trimmed = value.trim();
      if (trimmed.length === 0 || busy) return;
      setResult(null);
      run({ text: trimmed }, false);
    },
    retry: () => {
      if (lastBody) run(lastBody, true);
    },
    startOver: () => {
      setSecretError(null);
      suggest.reset();
      setResult(null);
      setLastBody(null);
      inputRef.current?.focus();
    },
  };
}

/** Callback ref accepted by any element (headings, paragraphs, forms). */
export type FocusRef = (node: HTMLElement | null) => void;

/**
 * The concierge's answer: a refusal, an error, or (through
 * `suggested`) the page's own card for a finished suggestion. Renders nothing
 * before the first request.
 */
export function ConciergeResult({
  concierge,
  disabled,
  manualAction,
  suggested,
}: {
  concierge: Concierge;
  disabled: boolean;
  /** "Pick a plan yourself" control, shown wherever the helper can't help. */
  manualAction: ReactNode;
  suggested: (result: SuggestedResult, headingRef: FocusRef) => ReactNode;
}) {
  const { busy, error, result, seq, lastBody, resultRef } = concierge;

  const startOverButton = (
    <button
      type="button"
      className={BUTTON_GHOST_SM}
      onClick={concierge.startOver}
    >
      Start over
    </button>
  );

  if (concierge.unavailable) {
    return (
      <div className="animate-fade-in flex flex-col gap-2.5">
        <p className={RESULT_COPY}>Suggestions aren't available right now.</p>
        <div className={ACTIONS}>{manualAction}</div>
      </div>
    );
  }

  if (error) {
    const { message, retry } = suggestErrorCopy(error);
    return (
      <div key={seq} className="animate-fade-in flex flex-col gap-2.5">
        <p className={FORM_ERROR} tabIndex={-1} ref={resultRef}>
          {message}
        </p>
        <div className={ACTIONS}>
          {retry && lastBody ? (
            <button
              type="button"
              className={BUTTON_OUTLINE_SM}
              onClick={concierge.retry}
              disabled={disabled}
            >
              Try again
            </button>
          ) : (
            manualAction
          )}
        </div>
      </div>
    );
  }

  if (!result) {
    return busy ? (
      <p className="animate-fade-in m-0 flex items-center gap-2.5 text-[13.5px] text-text-2">
        <Spinner className="spinner-sm" />
        Finding a setup that fits…
      </p>
    ) : null;
  }

  switch (result.outcome) {
    case "suggested":
      return <div key={seq}>{suggested(result, resultRef)}</div>;
    case "not_offered":
      return (
        <div key={seq} className={RESULT_CARD}>
          <p className={RESULT_COPY} tabIndex={-1} ref={resultRef}>
            {notOfferedCopy(result.reason)}
          </p>
          <div className={ACTIONS}>
            {manualAction}
            {startOverButton}
          </div>
        </div>
      );
    case "refused":
      return (
        <div key={seq} className={RESULT_CARD}>
          <p className={RESULT_COPY} tabIndex={-1} ref={resultRef}>
            {REFUSED_COPY}
          </p>
          <div className={ACTIONS}>{startOverButton}</div>
        </div>
      );
  }
}

/**
 * New request page helper: free text in, a suggested plan out. It never
 * creates anything; "Use this" hands the pick to the form below.
 */
export function SetupHelper({
  disabled,
  onApply,
  onPickManually,
}: {
  disabled: boolean;
  onApply: (pick: SetupPick) => void;
  onPickManually: () => void;
}) {
  const concierge = useConcierge<HTMLTextAreaElement>(disabled);
  const plans = usePlans().data ?? [];

  if (concierge.unavailable) return null;

  const { text, busy } = concierge;
  const trimmed = text.trim();

  return (
    <section
      aria-labelledby="setup-helper-heading"
      className="flex flex-col gap-[18px]"
    >
      <div className="flex flex-col gap-2">
        <h2
          id="setup-helper-heading"
          className="text-[16px] font-[650] tracking-[-0.005em]"
        >
          What's it for?
        </h2>
        <p id="setup-helper-hint" className={FIELD_HINT}>
          Describe it in your own words, in any language.
        </p>
        <textarea
          ref={concierge.inputRef}
          id="setup-helper-text"
          name="setup-helper-text"
          rows={3}
          className={INPUT_FIELD}
          value={text}
          maxLength={SUGGEST_TEXT_MAX}
          disabled={disabled}
          aria-labelledby="setup-helper-heading"
          aria-describedby="setup-helper-hint setup-helper-counter"
          placeholder="e.g. a Minecraft server for me and four friends"
          onChange={(event) => concierge.setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              concierge.submit();
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <button
            type="button"
            className={`${BUTTON_PRIMARY} ${BUSY} w-full sm:w-auto`}
            disabled={disabled}
            aria-disabled={busy || trimmed.length === 0 || undefined}
            onClick={() => concierge.submit()}
          >
            {busy ? <Spinner className="spinner-sm" /> : null}
            Suggest a setup
          </button>
          <p
            id="setup-helper-counter"
            className={`${COUNTER_BASE} text-text-3`}
          >
            {text.length}/{SUGGEST_TEXT_MAX}
          </p>
        </div>
      </div>

      <div aria-live="polite" aria-busy={busy} className="empty:hidden">
        <ConciergeResult
          concierge={concierge}
          disabled={disabled}
          manualAction={
            <button
              type="button"
              className={BUTTON_OUTLINE_SM}
              onClick={onPickManually}
            >
              Pick a plan yourself
            </button>
          }
          suggested={(result, headingRef) => (
            <div className={RESULT_CARD}>
              <h3 className={RESULT_TITLE} tabIndex={-1} ref={headingRef}>
                Here's what we suggest
              </h3>
              <SuggestionSpecs result={result} plans={plans} />
              <Notes items={suggestionNotes(result)} />
              <div className={ACTIONS}>
                <button
                  type="button"
                  className={BUTTON_PRIMARY}
                  disabled={disabled}
                  onClick={() =>
                    onApply({
                      planId: result.planId,
                      useCase: result.useCase,
                      recipeId: result.recipeId,
                    })
                  }
                >
                  Use this
                </button>
                <button
                  type="button"
                  className={BUTTON_GHOST_SM}
                  onClick={concierge.startOver}
                >
                  Start over
                </button>
              </div>
            </div>
          )}
        />
      </div>

      <p className="m-0 flex items-center gap-3 text-[12.5px] text-text-3">
        <span className="h-px flex-1 bg-line" aria-hidden="true" />
        or pick a plan yourself
        <span className="h-px flex-1 bg-line" aria-hidden="true" />
      </p>
    </section>
  );
}
