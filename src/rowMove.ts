/**
 * Index arithmetic for the reorder modal's "move to top/bottom" buttons and
 * keyboard shortcuts. Pulled out of `OrderModal.ts` and kept free of any
 * import (including `./types`) so it can be unit-tested directly — this is
 * exactly the kind of off-by-one-prone arithmetic `orderSync.ts`'s doc
 * comment warns sinks to the pure layer, and `OrderModal.ts` has no unit-test
 * surface at all (it imports obsidian).
 */
export type RowMove = 'up' | 'down' | 'top' | 'bottom';

/**
 * `index` is a row's current position among `count` rows. Returns the
 * position it should end up at, or `null` if `move` would not change
 * anything (already at the relevant edge, fewer than two rows to reorder, or
 * `index` itself is out of range).
 *
 * Returning `null` rather than throwing on an out-of-range `index` matters
 * because the caller derives `index` by scanning live DOM children — a
 * result of `-1` (element not found) or a stale index raced against a
 * concurrent mutation should read as "nothing to do", not crash the modal.
 */
export function targetIndexFor(move: RowMove, index: number, count: number): number | null {
	if (count <= 1 || index < 0 || index >= count) return null;

	switch (move) {
		case 'up':
			return index === 0 ? null : index - 1;
		case 'down':
			return index === count - 1 ? null : index + 1;
		case 'top':
			return index === 0 ? null : 0;
		case 'bottom':
			return index === count - 1 ? null : count - 1;
	}
}
