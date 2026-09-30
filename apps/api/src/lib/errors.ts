import type { ErrorRequestHandler, RequestHandler } from "express";
import type { ApiErrorBody } from "@moltforest/types";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, "not_found", `No route for ${req.method} ${req.path}`));
};

/** Client errors raised by express.json() (malformed JSON, oversized or unsupported body). */
function isBodyParserError(err: unknown): err is { status: number; type: string } {
  const e = err as { status?: unknown; type?: unknown } | null;
  return typeof e?.type === "string" && typeof e.status === "number" && e.status >= 400 && e.status < 500;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let body: ApiErrorBody = { error: { code: "internal_error", message: "Internal server error" } };

  if (err instanceof HttpError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message } };
  } else if (err instanceof ZodError) {
    status = 400;
    const message = err.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ");
    body = { error: { code: "invalid_request", message } };
  } else if (isBodyParserError(err)) {
    status = err.status;
    body =
      err.type === "entity.too.large"
        ? { error: { code: "body_too_large", message: "Request body is too large." } }
        : { error: { code: "invalid_body", message: "Request body must be valid JSON." } };
  } else {
    req.log?.error({ err }, "unhandled error");
  }
  res.status(status).json(body);
};
