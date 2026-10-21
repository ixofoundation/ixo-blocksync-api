// Records a compact summary of the GraphQL errors in each execution result on
// the Express response (res.locals.gqlErrors), so the per-request log line in
// request-log.ts can report them.
//
// Why not inspect the response body? grafast builds the result as
// { data, errors } - data FIRST (grafast/dist/prepare.js) - so a partial
// failure (rows of data, then a statement-timeout error) only mentions
// "errors" after the data, possibly tens of KB in. Re-buffering and parsing
// every response just for the log line is not worth it; the execution result
// is already an object here.
//
// grafserv's express v4 adaptor passes { node: { req, res }, expressv4: { req,
// res } } as the request context, which grafast exposes on the execute
// event's args.requestContext.

import type { GraphQLError } from "graphql";
import type { Response } from "express";

export interface GqlErrorSummary {
  count: number;
  /** Distinct error codes (pg SQLSTATE where available), at most 5. */
  codes: string[];
  /** First error's path joined with ".", or null if it has none. */
  path: string | null;
  /** First error's message, truncated. */
  message: string;
}

const MAX_CODES = 5;
const MAX_MESSAGE = 160;

const codeOf = (value: unknown): string | null => {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : null;
};

const errorCode = (err: GraphQLError): string => {
  // pg errors carry the SQLSTATE as .code (e.g. 57014, 26000, 25P02); grafast
  // may wrap the original error once more, so look one level deeper too.
  const original = err.originalError as (Error & { originalError?: unknown }) | undefined;
  const fromOriginal = codeOf(original) ?? codeOf(original?.originalError);
  if (fromOriginal) return fromOriginal;
  const ext = err.extensions as
    | { exception?: { errcode?: unknown }; code?: unknown }
    | undefined;
  const errcode = ext?.exception?.errcode;
  if (typeof errcode === "string" && errcode) return errcode;
  if (typeof ext?.code === "string" && ext.code) return ext.code;
  return "unknown";
};

export const summarizeErrors = (
  errors: readonly GraphQLError[]
): GqlErrorSummary => {
  const codes: string[] = [];
  for (const err of errors) {
    const code = errorCode(err);
    if (!codes.includes(code)) codes.push(code);
    if (codes.length >= MAX_CODES) break;
  }
  const first = errors[0];
  const message = String(first?.message ?? "");
  return {
    count: errors.length,
    codes,
    path: first?.path?.length ? first.path.join(".") : null,
    message:
      message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message,
  };
};

const record = (result: unknown, res: Response | undefined): void => {
  if (!res || result == null || typeof result !== "object") return;
  // Incremental delivery (@stream/@defer) yields an AsyncGenerator - not
  // inspected (our clients don't use it); only a plain ExecutionResult is.
  if (Symbol.asyncIterator in result) return;
  const errors = (result as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return;
  res.locals.gqlErrors = summarizeErrors(errors as GraphQLError[]);
};

export const RequestErrorsPlugin: GraphileConfig.Plugin = {
  name: "RequestErrorsPlugin",
  version: "1.0.0",
  grafast: {
    middleware: {
      execute(next, event) {
        // next.callback keeps a synchronous result synchronous and hands back
        // exactly the value (or rethrows exactly the error) next() produced.
        return next.callback((error, result) => {
          if (error) throw error;
          try {
            const ctx = event.args.requestContext;
            record(result, ctx?.expressv4?.res ?? (ctx?.node?.res as Response | undefined));
          } catch {
            // Logging must never break a request.
          }
          return result;
        });
      },
    },
  },
};
