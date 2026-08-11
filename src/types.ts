/**
 * Shared vocabulary between the pure layers (`orderIndex.ts`) and the UI.
 *
 * `name` is the exact child name as it appears in the vault: full name,
 * extension included, for files and folders alike. That is what the index
 * (`orderIndex.ts`) stores, and it is what makes a `Notes` folder and a
 * `Notes.md` note distinguishable without a separate `kind` field on the
 * stored data itself — the filesystem already guarantees full names are
 * unique within a folder. `kind` still lives on `Entry`: the UI uses it for
 * icons and for grouping (folders before files) in `fallbackEntryOrder`.
 */
export type EntryKind = 'file' | 'folder';

export interface Entry {
	readonly name: string;
	readonly kind: EntryKind;
}

/**
 * What a row in the reorder dialog should *show* for `entry`, as opposed to
 * what gets stored: strips a trailing `.md` from a file's name, so a note
 * called "Design.md" reads as "Design" — matching how the rest of Obsidian's
 * UI (the file explorer, the quick switcher) displays note titles. Storage
 * (`Entry.name`, and every key/value the index holds) always keeps the full
 * name; only a rendered label goes through this.
 *
 * Folders are never touched — a folder named e.g. "Notes.old" keeps that
 * name verbatim, since a folder has no extension to strip in the first
 * place.
 */
export function displayLabel(entry: Entry): string {
	return entry.kind === 'file' && entry.name.endsWith('.md') ? entry.name.slice(0, -'.md'.length) : entry.name;
}

/**
 * The collator `compareNames` runs on, built once here rather than through
 * `a.localeCompare(b, undefined, { numeric: true })` at every comparison.
 * The two produce the same *comparison* — `localeCompare` with an options
 * object is defined as constructing a collator with them and calling
 * `compare` — but not at the same moment: this resolves the runtime's default
 * locale once at module load, where per-call construction would re-resolve it
 * every time. In practice that difference needs an app restart to observe (a
 * changed system locale reaches a running Obsidian no other way), which is why
 * hoisting is safe. That per-call construction is also exactly the cost being
 * avoided: inside a sort comparator it builds one collator per comparison.
 * Measured on this machine, sorting 150 names (the size
 * of `bigfolder` in the test vault) takes 8.65ms that way against 0.49ms
 * through a hoisted collator, and the ratio holds at ~16x through 5000 names.
 *
 * Equivalence was checked, not assumed: over an 81-pair cross product of
 * NFC/NFD spellings of one name, numeric runs, case variants, CJK and a
 * combining mark, the two forms disagreed on nothing. In particular
 * `localeCompare`'s "canonically equivalent strings are equal" behaviour is
 * preserved, which is what the code-unit tiebreak below exists to sit under.
 */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true });

/**
 * The name-comparison primitive behind `fallbackEntryOrder` below and, in
 * `entrySort.ts`, `sortEntries`: `NAME_COLLATOR` above — `localeCompare`'s
 * comparison with `numeric: true` (see `fallbackEntryOrder`'s doc comment for
 * why that option is there) — falling through to a plain code-unit comparison
 * when the collator calls two different names equal.
 *
 * That fallthrough is not defensive padding. `localeCompare` treats
 * canonically-equivalent strings as equal — measured on this machine,
 * `'café.md'.normalize('NFC').localeCompare('café.md'.normalize('NFD'),
 * undefined, {numeric: true})` is `0`, even though the two forms differ in
 * length (7 code units vs 8). The filesystem guarantees full names are
 * unique within a folder, but not that every device agrees on which
 * normalization form a given name is stored in, so name alone is not a
 * total order. Without a second, code-unit-level tiebreak, a
 * canonically-equivalent pair would fall through `Array.prototype.sort`'s
 * stability to whatever order they arrived in — which traces back to
 * `folder.children`, i.e. the filesystem's own enumeration, not guaranteed
 * consistent across devices — so two machines could serialize two different
 * index byte streams for what a user would call the same vault state.
 * Comparing code units directly always breaks the tie, because two distinct
 * normalization forms of the same string always differ in code units.
 */
export function compareNames(a: string, b: string): number {
	const collated = NAME_COLLATOR.compare(a, b);
	if (collated !== 0) return collated;
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order rows appear in when a folder has no saved order yet — folders
 * before files, each group by name. It also decides where entries the saved
 * order doesn't mention get appended (see `mergeOrder` in `orderIndex.ts`).
 *
 * `numeric: true` so runs of digits compare as numbers: without it `10`
 * sorts before `2`, which disagrees with the file explorer for any folder
 * using numbered names and makes the dialog's suggested order look wrong
 * before the user has touched anything. The name comparison itself, and the
 * code-unit tiebreak layered under it for names `localeCompare` treats as
 * equal (e.g. an NFC vs NFD spelling of the same name), lives in
 * `compareNames` above — see its doc comment for why that tiebreak is
 * required for deterministic output, not optional.
 *
 * This is not the dialog's usual starting order — it is the *fallback*
 * `OrderModal` uses when the file explorer itself can't be consulted (no
 * leaf open, or something unexpected about its internals). The usual path is
 * `explorerOrderNames` in `explorerSort.ts`, which reads the order straight
 * out of the file explorer's own `getSortedFolderItems` — through this
 * plugin's own patch of that method — so it agrees with whatever the tree is
 * actually showing, sort setting and all, rather than guessing. This
 * function still only ever approximates that:
 *
 * - No locale is passed, so the collation is the runtime's default. Two
 *   devices with different system locales can suggest different orders for
 *   the same CJK names. Pinning a locale would trade that for being wrong
 *   the same way everywhere, which is not obviously better; and it only
 *   affects the *suggestion*, since a saved order is explicit and renders
 *   identically everywhere it's read.
 *
 * Pure and dependency-free so it can be unit-tested: `entriesFor`, its only
 * caller, imports obsidian and cannot be.
 *
 * Generic in the entry type rather than typed against `Entry` flatly: this
 * only ever permutes what it is handed, never rebuilds an entry, so whatever
 * richer shape came in comes back out. `entriesFor` (`folderEntries.ts`)
 * passes `SortableEntry`, which carries the timestamps `entrySort.ts` needs,
 * and gets `SortableEntry[]` back — where a plain `Entry[]` return would have
 * forced a cast at that call site to recover a fact this signature can simply
 * state and the compiler can then check.
 */
export function fallbackEntryOrder<T extends Entry>(entries: readonly T[]): T[] {
	return [...entries].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		return compareNames(a.name, b.name);
	});
}
