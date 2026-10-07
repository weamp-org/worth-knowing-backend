/**
 * How fast one person may post public prose, per hour.
 *
 * The global limit in `app.module.ts` is 100 requests a *minute*, which is the right
 * shape for reads and far too generous for the writes on this site that produce public
 * free text. An hour of solid conversation is nowhere near this number, so it costs an
 * ordinary person nothing, and it means bulk posting needs more accounts than a bored
 * person has.
 *
 * Shared between comment creation and both kinds of report rather than restated per
 * route: reporting a thing is the same kind of act as writing one, and three copies of
 * this number would be free to drift.
 */
export const PUBLIC_WRITE_THROTTLE = {
  default: { limit: 10, ttl: 3_600_000 },
};
