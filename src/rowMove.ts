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

/**
 * Moves `name` within `names` per `move`, reusing `targetIndexFor` for the
 * arithmetic rather than re-deriving it — this is the same computation
 * `OrderModal.ts`'s `moveRow` does against live DOM rows, applied here to a
 * plain array so the direct move commands/menu items (`moveItem.ts`) can
 * reorder a folder's stored order without a modal open at all.
 *
 * Returns `null`, never `names` unchanged, whenever there is nothing to do:
 * `name` isn't in `names`, `names` has fewer than two entries, or `name` is
 * already at the edge `move` would send it to. Callers use the `null`/array
 * split as their own "did anything change" signal, the same way every
 * `orderIndex.ts` mutation uses same-reference-back for that.
 *
 * Never mutates `names` — always builds and returns a new array.
 */
export function moveNameInOrder(names: readonly string[], name: string, move: RowMove): string[] | null {
	const index = names.indexOf(name);
	if (index === -1) return null;

	const target = targetIndexFor(move, index, names.length);
	if (target === null) return null;

	const next = [...names];
	next.splice(index, 1);
	next.splice(target, 0, name);
	return next;
}
