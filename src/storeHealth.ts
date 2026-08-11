/**
 * Pure: the usable/unusable state of the order-note store, with the evidence
 * each state is required to carry. `IndexFileStore` holds one value of this
 * and moves it only through the two transitions below; the side effects of a
 * transition (console line, Notice, cancelling a pending write timer) stay in
 * the store, where the vault is.
 *
 * Extracted (2026-08-11) for the same reason as `rebuildStep.ts`: this state
 * used to be five free-standing mutable fields whose invariants lived in
 * prose, and the repair path's worst bugs were exactly those invariants being
 * missed one field at a time — E2 was a transition into usable that dropped
 * its evidence on the floor. As a discriminated union the invariants are
 * structural instead:
 *
 * - The unusable arm *requires* a reason and the text that was judged
 *   unreadable. There is no way to mark the store unusable while keeping the
 *   only copy of what it saw to yourself.
 * - The usable arm has no `lastUnreadableText` at all, so "a readable note is
 *   the newer truth and the kept text must not outlive the stretch" is not a
 *   cleanup step anyone can forget — the field does not exist to leak.
 * - `blockProven` is a required argument on the way in to usable, sticky once
 *   true: it answers "has a json block ever been seen at this path", and a
 *   later read that finds none is the very event the question is asked about.
 */

/** Evidence common to both arms: whether a json block has ever provably existed at this path. Sticky — see `madeUsable`. */
interface HealthBase {
	readonly sawBlock: boolean;
}

export interface UsableHealth extends HealthBase {
	readonly usable: true;
}

export interface UnusableHealth extends HealthBase {
	readonly usable: false;
	/** Why the note cannot be used, always present — `unusableReason()` never needs a fallback. */
	readonly reason: string;
	/**
	 * The text the store judged unreadable, kept as the lowest-precedence
	 * recovery source for exactly one unusable stretch (see `recoverIndex`'s
	 * fourth source). Not a plan and never becomes one.
	 */
	readonly lastUnreadableText: string;
}

export type StoreHealth = UsableHealth | UnusableHealth;

/** A fresh store: usable, nothing proven yet. */
export const INITIAL_HEALTH: UsableHealth = { usable: true, sawBlock: false };

/**
 * The transition into usable. `blockProven` is required — every caller has
 * just learned something about whether a block is really at this path, and a
 * default would let the next caller not answer (the E2 regression, as a
 * signature). Sticky: `false` never clears an earlier `true`.
 */
export function madeUsable(previous: StoreHealth, blockProven: boolean): UsableHealth {
	return { usable: true, sawBlock: previous.sawBlock || blockProven };
}

/**
 * The transition into unusable. `unreadableText` is required for the same
 * reason `blockProven` is above: the caller has the judged text in hand, and
 * it may be the only copy of a note that is gone by the time anyone repairs.
 *
 * `firstNotice` is true exactly when this stretch of unusability has not yet
 * told the user — a fresh break, or the first break after a recovery. That is
 * the same thing as "this transition crossed from usable", so it is read
 * straight off the discriminant rather than from a `noticeShown` flag the
 * state used to carry: this is the only constructor of `UnusableHealth`, so
 * such a flag could only ever hold one value, and a union advertising a state
 * the module cannot produce is a rule the next reader has to re-derive.
 * Re-marking an already-unusable store (another failed read of the same broken
 * note) therefore stays quiet, which is the whole contract.
 */
export function madeUnusable(
	previous: StoreHealth,
	reason: string,
	unreadableText: string,
): { readonly health: UnusableHealth; readonly firstNotice: boolean } {
	return {
		health: { usable: false, sawBlock: previous.sawBlock, reason, lastUnreadableText: unreadableText },
		firstNotice: previous.usable,
	};
}
