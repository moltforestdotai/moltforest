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
  } else {
    req.log?.error({ err }, "unhandled error");
  }
  res.status(status).json(body);
};
