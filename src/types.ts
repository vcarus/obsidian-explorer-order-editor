/**
 * Shared vocabulary between the pure layers (`orderIndex.ts`, and — until
 * M10c removes them — `sortspec.ts`/`frontmatter.ts`) and the UI.
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
 * The order rows appear in when a folder has no saved order yet — folders
 * before files, each group by name. It also decides where entries the saved
 * order doesn't mention get appended (see `mergeOrder` in `orderIndex.ts`).
 *
 * `numeric: true` so runs of digits compare as numbers: without it `10`
 * sorts before `2`, which disagrees with the file explorer for any folder
 * using numbered names and makes the dialog's suggested order look wrong
 * before the user has touched anything.
 *
 * This can only ever approximate the explorer, and deliberately stops here:
 *
 * - There is no public API for the explorer's current visual order, and its
 *   sort setting (name A→Z / Z→A / by modified time) is not readable either,
 *   so a user who picked anything but A→Z sees a dialog that disagrees. The
 *   alternative — reaching into the file explorer view for its `sortOrder` —
 *   is the monkey-patching this plugin exists to avoid.
 * - No locale is passed, so the collation is the runtime's default. Two
 *   devices with different system locales can suggest different orders for
 *   the same CJK names. Pinning a locale would trade that for being wrong
 *   the same way everywhere, which is not obviously better; and it only
 *   affects the *suggestion*, since a saved order is explicit and renders
 *   identically everywhere it's read.
 *
 * Pure and dependency-free so it can be unit-tested: `entriesFor`, its only
 * caller, imports obsidian and cannot be.
 */
export function fallbackEntryOrder(entries: readonly Entry[]): Entry[] {
	return [...entries].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { numeric: true });
	});
}
