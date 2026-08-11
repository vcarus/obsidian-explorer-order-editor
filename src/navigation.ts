/**
 * Pure judgments for the reorder modal: walking into a subfolder or back out
 * to any ancestor without closing the dialog, and the order a level's rows
 * open in (`openingRowOrder`). Kept free of `obsidian` — `OrderModal.ts`
 * imports it and so has no unit-test surface at all, the same reason
 * `rowMove.ts` exists as its own module rather than living inline there.
 */
import { mergeOrder } from './orderIndex';
import type { Entry } from './types';

/**
 * The order a level's rows open in: `explorerNames` (what the file explorer
 * is rendering right now, when it could be consulted) resolved against
 * `siblings`, the entries the dialog actually knows how to order. When the
 * explorer could not be consulted (`null`), the names come from
 * `mergeOrder(stored, …)` instead — the stored order reconciled against the
 * live siblings, the same approximation the render patch itself applies.
 *
 * Either way `mergeOrder` finishes the job, and its two rules are exactly the
 * ones this level needs:
 *
 * - A name with no matching sibling is dropped, not invented: the index note
 *   (excluded from `siblings` on purpose) and anything else the dialog
 *   doesn't recognize never becomes a row. Duplicate names keep their first
 *   occurrence only.
 * - Every sibling the names never mentioned is appended at the end, in the
 *   order `siblings` arrived — a stale row must still get a position rather
 *   than vanish from the dialog entirely.
 *
 * Those rules are `mergeOrder`'s contract verbatim, which is why this reaches
 * for it in both cases rather than restating them: the whole of the work here
 * is choosing *which* names to reconcile against the live siblings, and the
 * explorer's current rendering is as valid a starting list as the stored
 * order. Spelling the loops out again also meant running them a second time
 * over an already-merged list on the `null` path, which provably could not
 * change anything.
 *
 * Generic in the entry type for `fallbackEntryOrder`'s reason (`types.ts`):
 * this only ever permutes what it is handed, so the caller's richer
 * `SortableEntry` rides through without a cast.
 */
export function openingRowOrder<T extends Entry>(
	explorerNames: readonly string[] | null,
	stored: readonly string[] | undefined,
	siblings: readonly T[],
): T[] {
	const siblingByName = new Map(siblings.map((entry) => [entry.name, entry] as const));
	const ordered: T[] = [];
	for (const name of mergeOrder(explorerNames ?? stored, siblings.map((entry) => entry.name))) {
		const entry = siblingByName.get(name);
		if (entry !== undefined) ordered.push(entry);
	}
	return ordered;
}

/** True when both lists name the same entries, same `kind`, in the same order. */
export function isSameOrder(a: readonly Entry[], b: readonly Entry[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((entry, index) => {
		const other = b[index];
		return other !== undefined && entry.name === other.name && entry.kind === other.kind;
	});
}

/** The folder's own name rather than its path; root is the vault name (or 'Vault root' when that's empty). */
export function folderShortName(name: string, isRoot: boolean, vaultName: string): string {
	return isRoot ? vaultName || 'Vault root' : name;
}

/**
 * Accessible name / tooltip for a navigation control, stating up front whether
 * activating it will save first. Never silently discards or silently writes:
 * the control says which of the two it does.
 */
export function navigationLabel(dirty: boolean, targetLabel: string): string {
	return dirty ? `Save and open "${targetLabel}"` : `Open "${targetLabel}"`;
}

/**
 * One rendered position in the breadcrumb trail: either a folder from the
 * chain (by index) or the collapsed run standing in for the ones left out.
 */
export type BreadcrumbSegment =
	| { readonly kind: 'crumb'; readonly index: number }
	| { readonly kind: 'ellipsis'; readonly hiddenIndices: readonly number[] };

/**
 * Which of a `count`-deep folder chain (index 0 = vault root, last = the
 * folder being edited) to actually render, in display order.
 *
 * Truncation always keeps both ends rather than, say, the tail alone: index 0
 * is "back to the vault root" and the last-but-one is "up one level", the two
 * jumps people actually make. Only mid-chain ancestors ever disappear behind
 * the ellipsis, and they stay reachable by stepping through the ones that are
 * still shown.
 *
 * Worked example: `count = 6, maxVisible = 4` ->
 * `[crumb 0, ellipsis [1, 2, 3], crumb 4, crumb 5]` — 4 rendered positions,
 * matching `maxVisible`, with the ellipsis naming exactly the indices between
 * the two crumbs on either side of it.
 */
export function breadcrumbSegments(count: number, maxVisible: number): readonly BreadcrumbSegment[] {
	if (count <= 0) return [];

	// Below 3, "keep both ends" has nothing left to keep once the ellipsis
	// itself takes a slot. Clamping here means every caller downstream can
	// rely on a sane trail instead of special-casing a degenerate maxVisible.
	const visible = Math.max(maxVisible, 3);
	if (count <= visible) {
		return Array.from({ length: count }, (_, index) => ({ kind: 'crumb', index }));
	}

	const tailStart = count - (visible - 2);
	const hiddenIndices = Array.from({ length: tailStart - 1 }, (_, offset) => offset + 1);
	const segments: BreadcrumbSegment[] = [{ kind: 'crumb', index: 0 }, { kind: 'ellipsis', hiddenIndices }];
	for (let index = tailStart; index < count; index++) {
		segments.push({ kind: 'crumb', index });
	}
	return segments;
}
