/**
 * Pure: the per-attempt decision inside `IndexFileStore`'s
 * `quarantineThenRebuild` loop — given what one fresh read of the note found,
 * what should this attempt do?
 *
 * Extracted (2026-08-11) because this branch point is where the repair path's
 * bugs actually lived: E1 (a note on disk but unindexed fell into a blind
 * `create`), E2/E3 (an outcome added without deciding what every *other*
 * outcome owes the caller) were all cases nobody could see because the
 * judgment sat six-deep in an `import obsidian` method no unit test reaches.
 * As a function of four plain values it is a table, and `rebuildStep.test.ts`
 * enumerates the table.
 *
 * Two things deliberately stay with the caller, and moving either here would
 * be wrong:
 *
 * - The `usable` early-exit. It has to run *before* the fresh read, not after:
 *   a store that healed while this attempt was queued may hold in-memory
 *   changes a debounced write hasn't flushed yet, and answering `'adopt'` from
 *   the disk bytes would replace that newer index with the older note. The
 *   read must not happen at all once `usable` is true.
 * - Laziness. `planFor` runs user-supplied `mutate` functions with a
 *   documented once-per-attempt call count, so the caller only invokes it when
 *   the parse did not succeed and passes `null` here otherwise — this function
 *   never causes a call, it only reads the results of ones the caller chose to
 *   make.
 */
import type { OrderIndex, ParseResult } from './orderIndex';

/**
 * What one rebuild attempt should do. Generic in the plan type so the caller's
 * own `RebuildPlan` rides through with full narrowing — `'rebuild'` hands back
 * the plan it was given, `'adopt'` hands back the parsed index, and neither
 * needs a re-check at the use site.
 */
export type RebuildStep<P> =
	/** The note parses cleanly now — take it as-is instead of writing a plan derived from a broken version over orders that are strictly newer. */
	| { readonly kind: 'adopt'; readonly index: OrderIndex }
	/** The planner found nothing worth recovering. Stop before anything is written; wiping is `startOver`'s explicitly confirmed job, never this loop's. */
	| { readonly kind: 'nothing-to-recover' }
	/**
	 * The note is on disk (the adapter-backed read returned text) but the vault
	 * has no handle for it, so it cannot be replaced atomically through
	 * `Vault.process`. Stop *before* quarantining: a blind `create` here throws
	 * "File already exists." after a copy has been taken — one stray copy and
	 * one spurious failure per click, for a note nothing ever touched (E1).
	 * Reachable briefly during a cold start and permanently for a path with a
	 * dot-prefixed component, which the vault walk skips.
	 */
	| { readonly kind: 'gave-up-unindexed' }
	/**
	 * Quarantine (when there are bytes to preserve) and rebuild. `quarantineFirst`
	 * is false exactly when there is nothing a copy would preserve — the note is
	 * absent or zero bytes — so no copy is made only to be offered for deletion.
	 */
	| { readonly kind: 'rebuild'; readonly plan: P; readonly quarantineFirst: boolean };

/**
 * `parsed` is the result of parsing `noteText ?? ''`; `plan` is the caller's
 * recovery plan, computed only when the parse did not succeed (`null` both for
 * "not computed" on the adopt path, where it is never read, and for "nothing
 * recoverable"); `noteText` is what the adapter-backed fresh read found
 * (`null` only when the adapter itself says the note is not there — the one
 * trustworthy answer to that question); `indexed` is whether the vault's file
 * map currently holds a handle for the path.
 */
export function rebuildStepFor<P>(parsed: ParseResult, plan: P | null, noteText: string | null, indexed: boolean): RebuildStep<P> {
	if (parsed.status === 'ok') return { kind: 'adopt', index: parsed.index };
	if (plan === null) return { kind: 'nothing-to-recover' };
	if (noteText !== null && !indexed) return { kind: 'gave-up-unindexed' };
	return { kind: 'rebuild', plan, quarantineFirst: noteText !== null && noteText !== '' };
}
