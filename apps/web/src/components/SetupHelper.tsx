import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  SUGGEST_TEXT_MAX,
  type OfferedUseCaseId,
  type Plan,
  type RecipeId,
  type SuggestBody,
  type SuggestPicks,
  type Suggestion,
  type SuggestionChoice,
} from "@homehost/shared";
import { isApiError } from "../lib/api";
import {
  notOfferedCopy,
  recipeLabel,
  REFUSED_COPY,
  suggestErrorCopy,
  useCaseLabel,
  warningCopy,
} from "../lib/concierge";
import { formatPlanSpecs } from "../lib/format";
import { usePlans, useSuggest } from "../lib/query";
import { InfoIcon, Spinner } from "./icons";
import {
  BUTTON_GHOST_SM,
  BUTTON_OUTLINE_SM,
  BUTTON_PRIMARY,
  FORM_ERROR,
} from "./primitives";

export interface SetupPick {
  planId: string;
  useCase: OfferedUseCaseId;
  recipeId: RecipeId;
}

// A 503 means the concierge is not configured: hide it until the next page
// load so the form looks exactly as it does without the feature.
let conciergeUnavailable = false;

const QUESTION: Record<SuggestionChoice["slot"], string> = {
  use_case: "What's it mainly for?",
  plan: "Which size fits best?",
  recipe: "What should it run?",
};

const INPUT_FIELD =
  "min-h-11 w-full rounded-control border border-line-strong bg-ink-2 px-3 py-2.5 text-[14.5px] text-text-1 transition-colors duration-(--duration-fast) ease-out-quint placeholder:text-text-3 focus:border-accent aria-invalid:border-bad disabled:opacity-60";
const FIELD_HINT = "m-0 max-w-[62ch] text-[12.5px] leading-[1.5] text-text-3";
const COUNTER_BASE = "m-0 whitespace-nowrap font-mono text-[12px]";
// Busy or empty controls stay focusable (aria-disabled, guarded in the
// handler) so keyboard focus is not dropped while a suggestion loads.
const BUSY = "aria-disabled:cursor-not-allowed aria-disabled:opacity-55";
const RESULT_CARD =
  "animate-fade-in flex flex-col gap-3 rounded-control border border-line-strong bg-ink-2 p-3.5";
const RESULT_TITLE = "text-[14.5px] font-[650]";
const RESULT_COPY = "m-0 text-[13.5px] leading-[1.55] text-text-2";
const NOTE =
  "m-0 flex items-start gap-2 text-[13px] leading-[1.55] text-text-2 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-3";
const ACTIONS = "flex flex-wrap gap-2.5";

interface ChoiceOption {
  id: string;
  label: string;
  detail: string | null;
  picks: SuggestPicks;
}

function choiceOptions(
  choice: SuggestionChoice,
  plans: readonly Plan[],
): ChoiceOption[] {
  switch (choice.slot) {
    case "use_case":
      return choice.options.map((o) => ({
        id: o.id,
        label: useCaseLabel(o.id),
        detail: null,
        picks: { useCase: o.id },
      }));
    case "plan":
      return choice.options.map((o) => {
        const plan = plans.find((p) => p.id === o.id);
        return {
          id: o.id,
          label: plan?.name ?? o.label,
          detail: plan ? formatPlanSpecs(plan) : null,
          picks: { planId: o.id },
        };
      });
    case "recipe":
      return choice.options.map((o) => ({
        id: o.id,
        label: recipeLabel(o.id),
        detail: null,
        picks: { recipeId: o.id },
      }));
    default:
      return [];
  }
}

function Notes({ items }: { items: string[] }) {
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

/**
 * "What's it for?" concierge: free text in, a suggested plan out. It never
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
  const plansQuery = usePlans();
  const suggest = useSuggest();
  const [hidden, setHidden] = useState(conciergeUnavailable);
  const [text, setText] = useState("");
  const [lastBody, setLastBody] = useState<SuggestBody | null>(null);
  const [result, setResult] = useState<Suggestion | null>(null);
  // Bumped on every settled call: re-keys the result so it fades in again.
  const [seq, setSeq] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resultFocus = useRef<HTMLElement | null>(null);
  const focusResult = useRef(false);

  // Answering a question or retrying replaces the control that had focus;
  // hand focus to the new result instead of dropping it on <body>.
  useEffect(() => {
    if (!focusResult.current) return;
    focusResult.current = false;
    resultFocus.current?.focus();
  }, [seq]);

  if (hidden) return null;

  const plans = plansQuery.data ?? [];
  const busy = suggest.isPending;
  const trimmed = text.trim();
  const setResultFocus = (node: HTMLElement | null) => {
    resultFocus.current = node;
  };

  const run = (body: SuggestBody, fromResult: boolean) => {
    if (busy || disabled) return;
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
          setHidden(true);
          return;
        }
        setSeq((n) => n + 1);
      },
    });
  };

  const submit = () => {
    if (trimmed.length === 0 || busy) return;
    setResult(null);
    run({ text: trimmed }, false);
  };

  const startOver = () => {
    suggest.reset();
    setResult(null);
    setLastBody(null);
    textareaRef.current?.focus();
  };

  const startOverButton = (
    <button type="button" className={BUTTON_GHOST_SM} onClick={startOver}>
      Start over
    </button>
  );

  let content: ReactNode = null;
  if (suggest.isError) {
    const { message, retry } = suggestErrorCopy(suggest.error);
    content = (
      <div key={seq} className="animate-fade-in flex flex-col gap-2.5">
        <p className={FORM_ERROR} tabIndex={-1} ref={setResultFocus}>
          {message}
        </p>
        {retry && lastBody ? (
          <div className={ACTIONS}>
            <button
              type="button"
              className={BUTTON_OUTLINE_SM}
              onClick={() => run(lastBody, true)}
              disabled={disabled}
            >
              Try again
            </button>
          </div>
        ) : null}
      </div>
    );
  } else if (result) {
    const warnings = warningCopy(result.warnings);
    switch (result.outcome) {
      case "suggested": {
        const { planId, useCase, recipeId } = result;
        const plan = plans.find((p) => p.id === planId);
        const notes =
          recipeId === "none"
            ? warnings
            : [
                `Automatic setup for ${recipeLabel(recipeId)} is coming soon. For now you'll get a clean Ubuntu server you can set it up on.`,
                ...warnings,
              ];
        content = (
          <div key={seq} className={RESULT_CARD}>
            <h3 className={RESULT_TITLE} tabIndex={-1} ref={setResultFocus}>
              Here's what we suggest
            </h3>
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13.5px] leading-[1.5]">
              <Spec term="For">{useCaseLabel(useCase)}</Spec>
              <Spec term="Size">
                {plan ? `${plan.name} · ${formatPlanSpecs(plan)}` : planId}
              </Spec>
              <Spec term="Software">{recipeLabel(recipeId)}</Spec>
            </dl>
            <Notes items={notes} />
            <div className={ACTIONS}>
              <button
                type="button"
                className={BUTTON_PRIMARY}
                disabled={disabled}
                onClick={() => onApply({ planId, useCase, recipeId })}
              >
                Use this
              </button>
              {startOverButton}
            </div>
          </div>
        );
        break;
      }
      case "choose": {
        const options = choiceOptions(result.choice, plans);
        if (options.length === 0) break;
        const questionId = `setup-question-${seq}`;
        content = (
          <div key={seq} className={RESULT_CARD}>
            <h3
              id={questionId}
              className={RESULT_TITLE}
              tabIndex={-1}
              ref={setResultFocus}
            >
              {QUESTION[result.choice.slot]}
            </h3>
            <div
              role="group"
              aria-labelledby={questionId}
              className="flex flex-wrap gap-2.5"
            >
              {options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${BUTTON_OUTLINE_SM} ${BUSY} max-w-full`}
                  disabled={disabled}
                  aria-disabled={busy || undefined}
                  onClick={() =>
                    lastBody &&
                    run(
                      {
                        text: lastBody.text,
                        picks: { ...lastBody.picks, ...option.picks },
                      },
                      true,
                    )
                  }
                >
                  <span className="flex min-w-0 flex-col items-start text-left">
                    <span>{option.label}</span>
                    {option.detail ? (
                      <span className="text-[12.5px] font-normal text-text-3">
                        {option.detail}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
            <Notes items={warnings} />
            <div className={ACTIONS}>{startOverButton}</div>
          </div>
        );
        break;
      }
      case "not_offered":
        content = (
          <div key={seq} className={RESULT_CARD}>
            <p className={RESULT_COPY} tabIndex={-1} ref={setResultFocus}>
              {notOfferedCopy(result.reason)}
            </p>
            <div className={ACTIONS}>
              <button
                type="button"
                className={BUTTON_OUTLINE_SM}
                onClick={onPickManually}
              >
                Pick a plan yourself
              </button>
              {startOverButton}
            </div>
          </div>
        );
        break;
      case "refused":
        content = (
          <div key={seq} className={RESULT_CARD}>
            <p className={RESULT_COPY} tabIndex={-1} ref={setResultFocus}>
              {REFUSED_COPY}
            </p>
            <div className={ACTIONS}>{startOverButton}</div>
          </div>
        );
        break;
    }
  }

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
          ref={textareaRef}
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
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <button
            type="button"
            className={`${BUTTON_PRIMARY} ${BUSY} w-full sm:w-auto`}
            disabled={disabled}
            aria-disabled={busy || trimmed.length === 0 || undefined}
            onClick={submit}
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
        {content}
      </div>

      <p className="m-0 flex items-center gap-3 text-[12.5px] text-text-3">
        <span className="h-px flex-1 bg-line" aria-hidden="true" />
        or pick a plan yourself
        <span className="h-px flex-1 bg-line" aria-hidden="true" />
      </p>
    </section>
  );
}
