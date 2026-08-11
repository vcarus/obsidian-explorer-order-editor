/**
 * Index arithmetic for the reorder modal's "move to top/bottom" buttons and
 * keyboard shortcuts. Pulled out of `OrderModal.ts` and kept free of any
 * import (including `./types`) so it can be unit-tested directly —
 * off-by-one-prone arithmetic is exactly what this project sinks to the pure
 * layer, and `OrderModal.ts` has no unit-test surface at all (it imports
 * obsidian).
 */
import type { DropSide } from './dropZone';

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

/**
 * Places `moved` immediately before or after `anchor` in `names`, for the
 * self-rendered drag-and-drop the dialog-free `dropZone.ts` geometry feeds
 * into. Unlike `moveNameInOrder`, `moved` is not required to already be in
 * `names`: dropping an item into a folder it doesn't currently belong to is
 * exactly the cross-folder-move case this exists for, and that folder's
 * order has never heard of `moved` before this call.
 *
 * Algorithm: strip every occurrence of `moved` out of `names` first, then
 * find `anchor`'s index in what's left and splice `moved` back in at that
 * index (`'before'`) or one past it (`'after'`). Stripping before searching
 * is what keeps this off-by-one-safe for the same-folder case — searching
 * `names` for `anchor` before removing `moved` would find the wrong index
 * whenever `moved` sits earlier in the array than `anchor` does, the exact
 * bug `moveNameInOrder` avoids by splicing out before splicing in.
 *
 * Returns `null`, never `names` unchanged, whenever there is nothing to do:
 * `moved === anchor` (a row cannot be dropped beside itself), `anchor` is
 * not in `names` (nothing to anchor the drop to), or the computed result is
 * identical to `names` (the drop would land `moved` right back where it
 * already was). Same null-means-no-change contract as `moveNameInOrder`.
 *
 * Never mutates `names` — always builds and returns a new array.
 */
export function insertNameBeside(names: readonly string[], moved: string, anchor: string, side: DropSide): string[] | null {
	if (moved === anchor) return null;

	const withoutMoved = names.filter((existing) => existing !== moved);
	const anchorIndex = withoutMoved.indexOf(anchor);
	if (anchorIndex === -1) return null;

	const insertAt = side === 'before' ? anchorIndex : anchorIndex + 1;
	const next = [...withoutMoved];
	next.splice(insertAt, 0, moved);

	const unchanged = next.length === names.length && next.every((existing, i) => existing === names[i]);
	return unchanged ? null : next;
}
