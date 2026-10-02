import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { getFacilitatorResponseError } from "@x402/core/server";

/** Same error shape as the MoltForest API: `{ error: { code, message } }`. */
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

function isBodyParserError(err: unknown): err is { status: number; type: string } {
  const e = err as { status?: unknown; type?: unknown } | null;
  return typeof e?.type === "string" && typeof e.status === "number" && e.status >= 400 && e.status < 500;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let error = { code: "internal_error", message: "Internal server error" };

  if (err instanceof HttpError) {
    status = err.status;
    error = { code: err.code, message: err.message };
  } else if (err instanceof ZodError) {
    status = 400;
    error = { code: "invalid_request", message: err.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ") };
  } else if (isBodyParserError(err)) {
    status = err.status;
    error =
      err.type === "entity.too.large"
        ? { code: "body_too_large", message: "Request body is too large." }
        : { code: "invalid_body", message: "Request body must be valid JSON." };
  } else if (getFacilitatorResponseError(err)) {
    status = 502;
    error = { code: "facilitator_error", message: "The x402 facilitator gave an invalid answer. Retry later." };
    req.log?.warn({ err }, "facilitator error");
  } else {
    req.log?.error({ err }, "unhandled error");
  }
  res.status(status).json({ error });
};
