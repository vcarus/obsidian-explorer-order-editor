/**
 * Pure "sort by" logic for the reorder dialog: turning one of six discrete
 * choices (name/created/modified, each ascending or descending) into a
 * concrete ordering of a folder's entries. This is the dialog's *starting
 * point* when the user asks for one of these — distinct from
 * `fallbackEntryOrder` in `types.ts`, which is what the dialog falls back to
 * when it has no better source at all (see that function's doc comment).
 *
 * `compareNames` is imported from `types.ts` rather than duplicated: it is
 * the same name-comparison primitive `fallbackEntryOrder` uses, so
 * `sortEntries(entries, 'name', false)` and `fallbackEntryOrder(entries)`
 * agree by construction rather than by two implementations happening to
 * match today. That import is the one deliberate exception to this module
 * staying free of anything beyond `Entry`/`EntryKind`: `types.ts` itself has
 * zero imports, so pulling a function from it does not pull in `obsidian` or
 * any DOM/runtime dependency — this file stays exactly as unit-testable as
 * `rowMove.ts` or `dropZone.ts`.
 */
import { compareNames, type Entry, type EntryKind } from './types';

export type SortKey = 'name' | 'created' | 'modified';

/**
 * An `Entry` plus the two timestamps a sort might need. `ctime`/`mtime` are
 * `readonly number | null` rather than plain `number` because a folder has
 * no `stat` in Obsidian's data model at all (`TFolder` simply doesn't carry
 * one) — there is no sentinel number that means "no value" without also
 * being a real, sortable timestamp for some file created at that instant, so
 * `null` is the only honest representation. Files are expected to always
 * have both, but the type doesn't enforce that (nothing here can reach into
 * `TFile.stat` to prove it), so `sortEntries` treats a `null` on a file as a
 * real possibility rather than an impossible state — see rule 6 in this
 * module's `sortEntries` doc comment.
 */
export interface SortableEntry extends Entry {
	readonly ctime: number | null;
	readonly mtime: number | null;
}

/**
 * One row the reorder dialog's "sort by" control offers. `id` is stored
 * nowhere persistent today, but is stable and exported anyway so a future
 * caller (e.g. remembering the user's last choice) has something to key on
 * that survives label wording changes. `label` is sentence case per this
 * project's UI-text convention.
 *
 * Date choices list newest-first before oldest-first (the reverse of the
 * name choices, which list A-to-Z first) because "show me what changed
 * recently" is the overwhelmingly common reason to sort by a date at all;
 * oldest-first is the rarer ask.
 */
export interface SortChoice {
	readonly id: string;
	readonly label: string;
	readonly key: SortKey;
	readonly descending: boolean;
}

export const SORT_CHOICES: readonly SortChoice[] = [
	{ id: 'name-asc', label: 'Name (A to Z)', key: 'name', descending: false },
	{ id: 'name-desc', label: 'Name (Z to A)', key: 'name', descending: true },
	{ id: 'created-desc', label: 'Created (newest first)', key: 'created', descending: true },
	{ id: 'created-asc', label: 'Created (oldest first)', key: 'created', descending: false },
	{ id: 'modified-desc', label: 'Modified (newest first)', key: 'modified', descending: true },
	{ id: 'modified-asc', label: 'Modified (oldest first)', key: 'modified', descending: false },
];

/**
 * Sorts `entries` by `key`, honouring `descending`, and returns a new array
 * — `entries` itself is never mutated (same discipline as
 * `fallbackEntryOrder`: callers may be holding a live reference, e.g. into
 * `folder.children`-derived state).
 *
 * The rules, in priority order:
 *
 * 1. **Folders always sort before files, under all six choices.**
 *    `descending` never flips this grouping — only the ordering *within*
 *    each group. Reasons this is non-negotiable rather than a style choice:
 *    a folder has no `stat`, so it has no value at all for the date keys
 *    (see `SortableEntry`'s doc comment), and folders-before-files is what
 *    `fallbackEntryOrder` and Obsidian's own file explorer both already do —
 *    a folder appearing after a file because the user picked "newest first"
 *    would be a new, surprising rule this dialog invented on its own.
 *
 * 2. **Within the folder group:** under `key === 'name'`, folders sort by
 *    name honouring `descending`, same as the file explorer's own
 *    name-descending mode would order them. Under `key === 'created'` or
 *    `'modified'`, folders sort by name *ascending*, unconditionally —
 *    `descending` has nothing to flip, because folders have no value for
 *    either date key, so "descending by created date" is meaningless for
 *    them and falling back to a fixed, direction-independent order (rather
 *    than, say, reversing arbitrarily) is what keeps the folder block's
 *    order deterministic and stable when the user flips between the two
 *    directions of the same date key.
 *
 * 3. **Within the file group:** compare by the chosen key.
 *    `descending` reverses only this comparison — not the null-placement
 *    rule in point 6 below, and not the folder group's ordering (point 2).
 *
 * 4. **Tie-breaking, in this order:** chosen key -> name (always ascending,
 *    never reversed by `descending`) -> code-unit comparison. The name step
 *    is why two files with an identical `mtime` still land in a stable,
 *    deterministic order instead of whatever order they happened to arrive
 *    in. The code-unit step exists for a narrower and sharper reason — see
 *    "The NFC/NFD problem" below — and is folded into `compareNames` itself
 *    (imported from `types.ts`), so both the `key === 'name'` case and the
 *    date-key tie-break get it automatically.
 *
 * 5. Name comparisons go through `compareNames`, the same primitive
 *    `fallbackEntryOrder` uses (`localeCompare` with `numeric: true`, so
 *    runs of digits compare as numbers). That sharing is exactly what makes
 *    `sortEntries(entries, 'name', false)` produce the same result as
 *    `fallbackEntryOrder(entries)` on the same input — not merely similar
 *    results, the same result, because it is the same code running.
 *
 * 6. **A `null` `ctime`/`mtime` must not corrupt the sort or throw.** This
 *    should not occur in practice — every real `TFile` has a `stat` — but
 *    the type permits it (see `SortableEntry`'s doc comment), so this
 *    function treats it as a real input rather than an assumed-impossible
 *    one. A file with `null` for the chosen date key sorts after every file
 *    that has a value for that key, *regardless of `descending`*: point 3
 *    says `descending` reverses the comparison between two files that both
 *    have a value, but null-placement is a separate rule layered on top of
 *    that, not part of what gets reversed. Two files that are both `null`
 *    for the key (or, for non-`null` values, two that tie) fall through to
 *    the name/code-unit tiebreak from point 4. Without this carve-out,
 *    picking "newest first" on a folder with one dateless file would either
 *    throw (comparing `null` numerically) or — worse, silently — put that
 *    one file at the *top* under "newest first" and the *bottom* under
 *    "oldest first", which is backwards from what a user would expect a
 *    missing value to do under either direction.
 *
 * ### The NFC/NFD problem
 *
 * This is the reason `compareNames`'s code-unit fallback (point 4/5 above)
 * is mandatory, not defensive padding. `localeCompare` treats
 * canonically-equivalent strings as *equal*: measured on this machine,
 * `'café.md'.normalize('NFC').localeCompare('café.md'.normalize('NFD'),
 * undefined, {numeric: true})` is `0`, even though the two forms differ in
 * length (7 code units vs 8) and are not the same string. The filesystem
 * guarantees full names are unique *within a folder*, but says nothing about
 * which normalization form a given device wrote that name in, so name alone
 * is not a total order over `SortableEntry[]`. `Array.prototype.sort` is
 * stable, so a canonically-equivalent pair with no further tiebreak would
 * fall through to whatever order they arrived in — which traces back to
 * `folder.children`, i.e. the filesystem's own enumeration order, which is
 * not guaranteed consistent across devices or even across two scans on the
 * same device. Two machines holding "the same" vault could then serialize
 * two different index byte streams for the same folder, breaking this
 * plugin's idempotence invariant. Comparing code units directly always
 * breaks the tie, because two distinct normalization forms of the same
 * string always differ in code units.
 */
export function sortEntries(entries: readonly SortableEntry[], key: SortKey, descending: boolean): SortableEntry[] {
	return [...entries].sort((a, b) => compareEntries(a, b, key, descending));
}

function compareEntries(a: SortableEntry, b: SortableEntry, key: SortKey, descending: boolean): number {
	if (a.kind !== b.kind) return isFolder(a.kind) ? -1 : 1;

	if (isFolder(a.kind)) {
		// Folders have no date-key value at all, so only 'name' has a
		// direction to honour here — see point 2 in sortEntries's doc comment.
		const byName = compareNames(a.name, b.name);
		return key === 'name' && descending ? -byName : byName;
	}

	if (key === 'name') {
		const byName = compareNames(a.name, b.name);
		return descending ? -byName : byName;
	}

	const aValue = key === 'created' ? a.ctime : a.mtime;
	const bValue = key === 'created' ? b.ctime : b.mtime;
	const byValue = compareTimestamps(aValue, bValue, descending);
	if (byValue !== 0) return byValue;

	// Tie (including "both null"): fall through to name, always ascending
	// regardless of `descending` — point 4 in sortEntries's doc comment.
	return compareNames(a.name, b.name);
}

function isFolder(kind: EntryKind): boolean {
	return kind === 'folder';
}

/**
 * Compares two date-key values for files only (folders never reach this —
 * see `compareEntries`). `null` always sorts after any real value, in both
 * directions: `descending` flips the ordering between two real values, but
 * never promotes a missing value above a present one. See point 6 in
 * `sortEntries`'s doc comment for why direction-independence here is the
 * correct behaviour rather than an oversight.
 */
function compareTimestamps(a: number | null, b: number | null, descending: boolean): number {
	if (a === null && b === null) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return descending ? b - a : a - b;
}
