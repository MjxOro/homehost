import { Data } from "effect";

export class DbFailure extends Data.TaggedError("DbFailure")<{
  readonly cause: unknown;
}> {}

export class QuotaExceeded extends Data.TaggedError("QuotaExceeded")<{}> {}

export class SubdomainTaken extends Data.TaggedError("SubdomainTaken")<{}> {}

export class RequestNotFound extends Data.TaggedError("RequestNotFound")<{}> {}

export class TransitionConflict extends Data.TaggedError(
  "TransitionConflict",
)<{}> {}

export type DomainError =
  | DbFailure
  | QuotaExceeded
  | SubdomainTaken
  | RequestNotFound
  | TransitionConflict;
