import { z } from "zod";

export const SITE_RE = /^(US|UK|FR|DE)$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DWS_REQUIRED_SECRETS = ["host", "user", "password", "database"];

export function siteToAccount(site: string): string {
  if (!SITE_RE.test(site)) {
    throw new Error(`site must be one of US/UK/FR/DE (独立站; no AU), got ${site}`);
  }
  return `EPSITE${site}`;
}

export const cohortMetadataSchema = z.object({
  asOfDate: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  coveredThrough: z.string(),
  maturityDays: z.number(),
  windowIncludesImmature: z.boolean(),
});

export const siteCohortBaseInputSchema = {
  site: z.string().regex(SITE_RE, "site must be one of US/UK/FR/DE (独立站; no AU)"),
  since: z.string().regex(DATE_RE, "since must be YYYY-MM-DD"),
  until: z
    .string()
    .regex(DATE_RE, "until must be YYYY-MM-DD")
    .describe(
      "Exclusive upper bound date (YYYY-MM-DD): matches pay_time >= since AND pay_time < until. " +
        "For a full calendar month use the first of the NEXT month, e.g. all of April 2026 = until 2026-05-01. " +
        "Output coveredThrough echoes the inclusive last day (2026-04-30).",
    )
    .optional(),
  maturityDays: z.coerce.number().int().min(0).max(180).optional(),
};

export const siteReturnDescriptionSuffix =
  " Source: DWS table dm_od_shopify_resreturn_d, the Shopify order-line full sales+returns table. " +
  "Account is EPSITE{site}; supported sites are US/UK/FR/DE only, no AU. " +
  "Return-rate denominator is SUM(quantity) over all cohort rows; numerator is " +
  "SUM(COALESCE(return_quantity,0)). Do not filter to returned rows for return-rate calculations. " +
  "The cohort is pay_time with a maturity window; when until is omitted, windowEnd defaults to " +
  "CURDATE() - maturityDays (default 45) because recent cohorts are right-censored and can understate " +
  "returns. DE has only a few hundred rows in this source, so read salesQty/returnQty before trusting " +
  "small-sample rates. These tools report current observed return rates and distributions only; they do not " +
  "join styleType and do not forecast.";
