/** Shared informational disclaimer for discovery + paid intelligence responses. */
export const INTEL_DISCLAIMER =
  "Informational only; not investment advice. Past performance is not indicative of future results.";

export function withDisclaimer<T extends Record<string, unknown>>(body: T): T & { disclaimer: string } {
  return { ...body, disclaimer: INTEL_DISCLAIMER };
}
