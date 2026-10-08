import express, { type RequestHandler, Router } from "express";
import { z } from "zod";
import type { NewsletterRepository } from "../repositories/newsletter.js";

const SOURCES = ["footer"] as const;

/** Loose but practical email shape; stored lowercased and trimmed. */
const Email = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email()
  .transform((s) => s.toLowerCase());

/**
 * Public signup body. `website` is a honeypot: real browsers leave it empty;
 * bots that fill every field get a fake success and nothing is stored.
 */
export const NewsletterBody = z
  .object({
    email: Email,
    source: z.enum(SOURCES).default("footer"),
    website: z.string().max(200).optional(),
  })
  .strict();

export function newsletterRouter(repo: NewsletterRepository, submitLimiter: RequestHandler): Router {
  const router = Router();

  router.post("/newsletter", submitLimiter, express.json({ limit: "1kb" }), async (req, res) => {
    const body = NewsletterBody.parse(req.body);

    // Honeypot tripped — pretend a fresh signup so scrapers learn nothing useful.
    if (body.website && body.website.trim() !== "") {
      res.json({ ok: true as const, alreadySubscribed: false as const });
      return;
    }

    const created = await repo.subscribe(body.email, body.source);
    res.json({ ok: true as const, alreadySubscribed: !created });
  });

  return router;
}
