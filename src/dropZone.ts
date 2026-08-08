/**
 * Pure geometry for reading a file-explorer row during a self-rendered drag:
 * which band of the row the pointer is over decides whether a drop reorders
 * "before" the row, "after" it, or should fall through to Obsidian's own
 * drop handling. For a folder row, the native behavior a fall-through drop
 * gets is "move the dragged item into this folder" — so the middle of a
 * folder row is deliberately left unclaimed here.
 *
 * Zero imports — including `./types` — so this stays as directly
 * unit-testable as `rowMove.ts`. The (not yet written) drag handler owns
 * turning live DOM measurements into the plain numbers this takes.
 */

export type DropSide = 'before' | 'after';

/**
 * `file` rows have no native drop target to protect — Obsidian has nothing
 * to do with a note dropped "into" it — so a file row splits into exactly
 * two halves. Folder rows do have a native target (drop into the folder),
 * and how much of the row that target claims differs between a collapsed
 * folder (no children visible to drop "before" instead) and an expanded one
 * (see `dropSideFor`'s doc comment for why expanded folders also lose the
 * `after` zone entirely).
 */
export type RowKind = 'file' | 'collapsed-folder' | 'expanded-folder';

// Fraction of a folder row's height claimed by the "before"/"after" bands
// before the rest falls through to Obsidian's native drop-into-folder
// handling.
const EDGE_BAND = 0.25;

/**
 * Reads which hot zone `pointerY` falls into within the row spanning
 * `[rowTop, rowTop + rowHeight)`, given the row's `kind`. Returns `null`
 * when the pointer is over the band that should fall through to Obsidian's
 * native drop handling rather than being intercepted by this plugin.
 *
 * `rowHeight <= 0` returns `null` as a division-by-zero guard (and, for a
 * negative height, a guard against a fraction whose sign would invert every
 * comparison below) — a row with no measured height can't sensibly host a
 * drop zone at all.
 *
 * `fraction` is clamped to `[0, 1]` rather than the function returning
 * `null` for an out-of-range value. The caller only ever asks this about the
 * row directly under the pointer, so a fraction outside `[0, 1]` can only be
 * sub-pixel rounding right at that row's own edge, never the pointer
 * actually being over some other row. Returning `null` there instead of
 * clamping would carve out a dead band on the row's boundary that responds
 * to nothing.
 *
 * Every band is a half-open interval so each fraction in `[0, 1]` lands in
 * exactly one of them — no overlap, no gap:
 * - `file`: `[0, 0.5)` before, `[0.5, 1]` after. No native target to protect,
 *   so the whole row splits in two.
 * - `collapsed-folder`: `[0, 0.25)` before, `[0.25, 0.75)` native (`null`),
 *   `[0.75, 1]` after.
 * - `expanded-folder`: `[0, 0.25)` before, `[0.25, 1]` native (`null`).
 *   There is no `after` band here, on purpose: an expanded folder's bottom
 *   edge is, visually, the exact same line as its first child's top edge (or
 *   just the folder's own bottom edge, if it happens to be empty or fully
 *   collapsed-away inside). "After this expanded folder" and "before its
 *   first child" would be the same pixels meaning two different parent
 *   folders, and there is no reliable way to tell which one the pointer
 *   meant. Rather than guess, that whole band is left native (drop into the
 *   folder); a drop actually meant to land right after an expanded folder
 *   can still be made by dropping before its first child instead.
 */
export function dropSideFor(pointerY: number, rowTop: number, rowHeight: number, kind: RowKind): DropSide | null {
	if (rowHeight <= 0) return null;

	const raw = (pointerY - rowTop) / rowHeight;
	const fraction = Math.min(1, Math.max(0, raw));

	switch (kind) {
		case 'file':
			return fraction < 0.5 ? 'before' : 'after';
		case 'collapsed-folder':
			if (fraction < EDGE_BAND) return 'before';
			if (fraction >= 1 - EDGE_BAND) return 'after';
			return null;
		case 'expanded-folder':
			return fraction < EDGE_BAND ? 'before' : null;
	}
}
