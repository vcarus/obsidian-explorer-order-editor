/**
 * Pure path arithmetic for the "quarantine" copy `IndexFileStore` creates
 * beside the order index note when it heals an unreadable one (M10e): the
 * unreadable text is preserved under a sibling name before the note is
 * rebuilt, so healing can never destroy the only copy of whatever the broken
 * note held.
 *
 * Zero imports, synchronous — same discipline as `orderIndex.ts` and
 * `frontmatter.ts`: this module never touches `obsidian`. The actual
 * `vault.create`/`vault.getAbstractFileByPath` calls this feeds live in
 * `indexFile.ts`.
 */

const MARKER = 'unreadable';

/** Formats `date` as `YYYY-MM-DD HHmm`, e.g. `2026-08-08 1403` — local time, minute precision. Two quarantines in the same minute are told apart by `findFreeQuarantinePath`'s suffix, not by adding seconds here. */
function formatTimestamp(date: Date): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	const year = date.getFullYear();
	const month = pad(date.getMonth() + 1);
	const day = pad(date.getDate());
	const hours = pad(date.getHours());
	const minutes = pad(date.getMinutes());
	return `${year}-${month}-${day} ${hours}${minutes}`;
}

interface SplitPath {
	/** Empty string for a root-level path (no trailing slash either way). */
	readonly folder: string;
	readonly base: string;
	/** Includes the leading dot, e.g. `.md`. Empty string if `fileName` has no extension. */
	readonly ext: string;
}

/**
 * Splits a vault path into folder/base/extension the way `TFile.parent` /
 * `TFile.basename` / `TFile.extension` would, without needing a `TFile` —
 * this module cannot import `obsidian` (see the module doc comment above).
 */
function splitPath(notePath: string): SplitPath {
	const slash = notePath.lastIndexOf('/');
	const folder = slash === -1 ? '' : notePath.slice(0, slash);
	const fileName = slash === -1 ? notePath : notePath.slice(slash + 1);

	const dot = fileName.lastIndexOf('.');
	// A leading dot (dotfile with no extension, e.g. ".gitignore") is not
	// treated as an extension separator — `dot <= 0` covers both "no dot"
	// and "dot is the first character".
	const base = dot <= 0 ? fileName : fileName.slice(0, dot);
	const ext = dot <= 0 ? '' : fileName.slice(dot);
	return { folder, base, ext };
}

/**
 * Builds the quarantine path for `notePath` at `timestamp`, e.g.
 * `explorer-order (unreadable 2026-08-08 1403).md` beside a root-level note,
 * or `Folder/explorer-order (unreadable 2026-08-08 1403).md` for one in a
 * subfolder — same folder, same extension, basename plus a marker and
 * timestamp so it sorts and reads sensibly beside the original.
 *
 * `suffix` disambiguates multiple quarantines created in the same minute
 * (see `findFreeQuarantinePath`): `0` adds nothing, `1` appends ` 2`, `2`
 * appends ` 3`, and so on — the displayed number is always `suffix + 1`, so
 * the first collision reads as "the 2nd one," not "attempt 1."
 */
export function quarantinePath(notePath: string, timestamp: Date, suffix = 0): string {
	const { folder, base, ext } = splitPath(notePath);
	const disambiguator = suffix === 0 ? '' : ` ${suffix + 1}`;
	const name = `${base} (${MARKER} ${formatTimestamp(timestamp)}${disambiguator})${ext}`;
	return folder === '' ? name : `${folder}/${name}`;
}

/**
 * Finds a quarantine path `isTaken` reports free, starting from
 * `quarantinePath(notePath, timestamp, 0)` and incrementing the suffix until
 * one is free. `isTaken` is injected so this stays synchronous and
 * vault-free — `indexFile.ts` supplies `path =>
 * app.vault.getAbstractFileByPath(path) !== null`. Never overwrites an
 * existing file: the caller's `vault.create` runs against whatever path this
 * returns, and this only ever returns a path `isTaken` said was free.
 */
export function findFreeQuarantinePath(notePath: string, timestamp: Date, isTaken: (path: string) => boolean): string {
	let suffix = 0;
	let candidate = quarantinePath(notePath, timestamp, suffix);
	while (isTaken(candidate)) {
		suffix++;
		candidate = quarantinePath(notePath, timestamp, suffix);
	}
	return candidate;
}

/**
 * The folder every quarantine copy of `notePath` lives in, or `null` when
 * that is the vault root — `quarantinePath` above only ever varies the
 * basename, so this is the same folder as the note's own, always.
 *
 * Exists so a caller can look in one folder instead of enumerating the whole
 * vault and filtering with `isQuarantinePath`, which would only ever discard
 * what it found: that predicate's first test is `note.folder !==
 * candidate.folder`. Kept here rather than at the call site for the reason
 * given below — where the copies go and where they are looked for are one
 * fact, and it is only true while it is written once.
 *
 * `null` rather than `''` for the root: a caller has to resolve this through
 * a different vault call either way (`getRoot()` vs `getFolderByPath()`), so
 * the type makes it say which, instead of passing an empty string to a lookup
 * that would answer `null` and be indistinguishable from a missing folder.
 */
export function quarantineFolderPath(notePath: string): string | null {
	const { folder } = splitPath(notePath);
	return folder === '' ? null : folder;
}

/**
 * Whether `candidatePath` is a quarantine copy this module would have made
 * for `notePath` — same folder, same basename, the marker in the same place,
 * same extension. Used to find copies to offer for deletion, so the pattern
 * that recognizes them and the pattern that creates them stay in one file
 * and cannot drift apart.
 *
 * Deliberately shape-based rather than exact: the timestamp and the
 * collision suffix vary, and this must match every copy ever written,
 * including ones from an older run. It does not attempt to validate the
 * timestamp — a note the user renamed into this shape by hand would match,
 * which is why deleting is always confirmed and never automatic.
 */
export function isQuarantinePath(notePath: string, candidatePath: string): boolean {
	const note = splitPath(notePath);
	const candidate = splitPath(candidatePath);
	if (note.folder !== candidate.folder) return false;
	if (note.ext !== candidate.ext) return false;
	return candidate.base.startsWith(`${note.base} (${MARKER} `) && candidate.base.endsWith(')');
}
