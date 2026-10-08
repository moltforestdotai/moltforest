import { table, type Db } from "../db.js";

export function createNewsletterRepository(db: Db, appSchema: string) {
  const subscribers = table(appSchema, "newsletter_subscriber");

  return {
    /**
     * Inserts a normalized email. Returns true when a new row was written,
     * false when the address was already subscribed (idempotent).
     */
    async subscribe(email: string, source: string): Promise<boolean> {
      const r = await db.query(
        `INSERT INTO ${subscribers} (email, source) VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING`,
        [email, source],
      );
      return (r.rowCount ?? 0) > 0;
    },
  };
}

export type NewsletterRepository = ReturnType<typeof createNewsletterRepository>;
