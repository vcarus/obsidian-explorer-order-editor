/**
 * Pure data layer for the vault-level order index: a single JSON object,
 * mapping folder path -> the child names the user placed by hand in that
 * folder, embedded in a fenced ```json block inside one ordinary note (see
 * `parseIndex`/`serializeIndex`).
 *
 * Zero imports, synchronous, no I/O — this module never touches `obsidian`.
 * Everything here operates on the note's full text (the string a caller read
 * from/will write to the note file); locating and splicing the fenced block
 * within that text is this module's job, same as `frontmatter.ts` does for
 * sortspec.md's YAML key, but far simpler: there is exactly one block to
 * find, and its content is JSON we parse with `JSON.parse`, not a bespoke
 * grammar.
 *
 * Format contract (see the M10a brief): the block's JSON is one folder per
 * line, keys sorted, e.g.:
 *
 *   {
 *     "Projects/Alpha": ["Design.md", "Notes", "TODO.md"],
 *     "Projects/Beta": ["b.md", "a.md"]
 *   }
 *
 * One line per folder is deliberate — it is what makes a git three-way merge
 * resolve per folder instead of conflicting on the whole file. `JSON.stringify(obj,
 * null, 2)` does not produce this (it puts every array element on its own
 * line too), so `serializeIndex` builds the lines itself. An empty index
 * serializes as the single line `{}`.
 *
 * Values are child names exactly as they appear in the vault, full names
 * including extensions. Unlike the old sortspec.md format, there is no
 * `kind` field: the filesystem already guarantees full names (with
 * extension) are unique within a folder, which removes the
 * file-vs-folder-sharing-a-name ambiguity that format needed `kind` for.
 *
 * Keys are folder paths exactly as Obsidian reports them. This module treats
 * them as opaque strings and never parses or normalizes them beyond the `/`
 * separator logic `renameFolderPath` needs to distinguish a folder from a
 * same-named-with-suffix sibling (`Projects` vs `ProjectsOld`).
 */

/** Folder path -> the names, in order, the user placed by hand. */
export type OrderIndex = ReadonlyMap<string, readonly string[]>;

export type ParseResult =
	| { readonly status: 'ok'; readonly index: OrderIndex }
	| { readonly status: 'empty' } // note exists, no json block yet
	| { readonly status: 'invalid'; readonly reason: string }; // block present but unusable

// ---------------------------------------------------------------------------
// Fenced-block location
// ---------------------------------------------------------------------------

const FENCE_OPEN = '```json';
const FENCE_CLOSE = '```';

interface JsonBlockLocation {
	/** Index into the note's `\n`-split lines of the ` ```json ` fence line itself. */
	readonly openLine: number;
	/** Index of the closing ` ``` ` fence line itself. */
	readonly closeLine: number;
	/** The lines strictly between the two fences, joined back with `\n`. */
	readonly content: string;
}

type BlockSearch =
	| { readonly status: 'found'; readonly block: JsonBlockLocation }
	/** No ` ```json ` fence line anywhere — a brand new note, or one we've never written to. */
	| { readonly status: 'none' }
	/** A ` ```json ` fence opens and never closes, so the block has no determinable end. */
	| { readonly status: 'unterminated' };

/**
 * Finds the first ```json fenced block in `lines` (already split on `\n`).
 * Fence lines are matched by exact content once trailing whitespace/CR is
 * stripped — this module always writes exactly `` ```json `` / `` ``` `` with
 * nothing else on the line, so that is what it looks for; a fence line
 * carrying extra text (a different info string, more backticks, indentation
 * from a surrounding list) is deliberately not recognized rather than
 * guessed at.
 *
 * `unterminated` is reported separately from `none`, and both callers treat
 * it as unusable rather than as "no block here". Conflating the two is a data
 * loss: `serializeIndex` would append a *second* block after the dangling
 * fence, and the next read would then scan from that dangling fence to the
 * appended block's closing fence and try to parse the prose in between —
 * failing, permanently, with the just-written order unreadable. Refusing at
 * the first sign of a boundary we cannot determine is the same rule this
 * module applies to malformed JSON, for the same reason.
 */
function findJsonBlock(lines: readonly string[]): BlockSearch {
	let openLine = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.trimEnd() === FENCE_OPEN) {
			openLine = i;
			break;
		}
	}
	if (openLine === -1) return { status: 'none' };

	let closeLine = -1;
	for (let i = openLine + 1; i < lines.length; i++) {
		if (lines[i]?.trimEnd() === FENCE_CLOSE) {
			closeLine = i;
			break;
		}
	}
	if (closeLine === -1) return { status: 'unterminated' };

	return {
		status: 'found',
		block: { openLine, closeLine, content: lines.slice(openLine + 1, closeLine).join('\n') },
	};
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Locates the first ```json block in `noteText` and parses it. Never throws:
 * a parse failure, or JSON that parses but isn't an object of string arrays,
 * comes back as `{status: 'invalid', reason}` rather than propagating an
 * exception or silently degrading to an empty index. That distinction
 * matters to every caller — a corrupt or half-synced file misread as "no
 * orders" would let one bad write erase every hand-placed order in the
 * vault, so callers need to be able to see "unusable" and refuse to write.
 *
 * `{status: 'empty'}` means something different: no ```json block was found
 * at all (a brand new note, or one the user hasn't had the plugin write to
 * yet). An `ok` result can still carry a genuinely empty index (`{}` in the
 * block) — that is a valid, parsed, empty map, not this status.
 */
export function parseIndex(noteText: string): ParseResult {
	const search = findJsonBlock(noteText.split('\n'));
	if (search.status === 'none') return { status: 'empty' };
	if (search.status === 'unterminated') {
		return { status: 'invalid', reason: 'A json block opens but is never closed' };
	}
	const block = search.block;

	let parsed: unknown;
	try {
		parsed = JSON.parse(block.content);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { status: 'invalid', reason: `Malformed JSON: ${message}` };
	}

	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { status: 'invalid', reason: 'The json block must contain a JSON object' };
	}

	const obj = parsed as Record<string, unknown>;
	const index = new Map<string, readonly string[]>();
	for (const key of Object.keys(obj)) {
		const value = obj[key];
		if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) {
			return { status: 'invalid', reason: `Value for folder "${key}" must be an array of strings` };
		}
		index.set(key, value);
	}

	return { status: 'ok', index };
}

// ---------------------------------------------------------------------------
// Serializing
// ---------------------------------------------------------------------------

const PREAMBLE_LINE =
	'This note is maintained by the Explorer Order Editor plugin. It stores the manual sort order for folders in this vault; the block below is machine-generated.';

/** Builds just the block's interior, e.g. `{}` or `{\n  "A": ["x"]\n}`. Keys sorted, one per line. */
function buildBlockBody(index: OrderIndex): string {
	const keys = [...index.keys()].sort();
	if (keys.length === 0) return '{}';
	const lines = keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(index.get(key))}`);
	return `{\n${lines.join(',\n')}\n}`;
}

/** Builds the full fence, as an array of lines: `` ```json ``, the body's own lines, `` ``` ``. */
function buildBlockLines(index: OrderIndex): string[] {
	return [FENCE_OPEN, ...buildBlockBody(index).split('\n'), FENCE_CLOSE];
}

/** Appends a preamble + block after `noteText`, which is known to have no ```json block already. */
function appendBlock(noteText: string, index: OrderIndex): string {
	const block = buildBlockLines(index).join('\n');
	const separator = noteText.endsWith('\n\n') ? '' : noteText.endsWith('\n') ? '\n' : '\n\n';
	return `${noteText}${separator}${PREAMBLE_LINE}\n\n${block}\n`;
}

/**
 * Replaces the content of the first ```json block in `noteText` with the
 * serialization of `index`, leaving every byte outside that block — prose
 * before and after, other fenced blocks, front matter, trailing newline —
 * exactly as it was: only the lines strictly between the fence markers are
 * ever replaced, and the fence marker lines themselves are copied through
 * verbatim rather than rewritten.
 *
 * If `noteText` has no ```json block yet, one is appended after the existing
 * text, preceded by a short preamble line explaining what the file is. If
 * `noteText` is empty, the whole note is produced from that same template.
 *
 * Throws if a ```json fence opens and never closes — the one case where the
 * block's extent cannot be determined, so neither replacing nor appending is
 * safe (see `findJsonBlock`). Callers already have to handle `parseIndex`
 * reporting the same note `invalid`; this makes the write side refuse in
 * exactly the cases the read side does, rather than quietly producing a note
 * that can never be read back. Same shape as `frontmatter.ts` throwing rather
 * than rewriting a file whose front matter it cannot delimit.
 */
export function serializeIndex(noteText: string, index: OrderIndex): string {
	if (noteText === '') {
		const block = buildBlockLines(index).join('\n');
		return `${PREAMBLE_LINE}\n\n${block}\n`;
	}

	const lines = noteText.split('\n');
	const search = findJsonBlock(lines);
	if (search.status === 'unterminated') {
		throw new Error('Cannot write the order index: a json block opens but is never closed');
	}
	if (search.status === 'none') return appendBlock(noteText, index);

	const block = search.block;
	const newLines = [
		...lines.slice(0, block.openLine + 1),
		...buildBlockBody(index).split('\n'),
		...lines.slice(block.closeLine),
	];
	return newLines.join('\n');
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getOrder(index: OrderIndex, folderPath: string): readonly string[] | undefined {
	return index.get(folderPath);
}

// ---------------------------------------------------------------------------
// Mutations — all pure: each returns a new `OrderIndex`, never modifies its
// argument. Several return the same `index` reference when nothing would
// change, both as a cheap no-op signal for callers and to keep unrelated
// re-renders/writes from being triggered by a mutation that did nothing.
// ---------------------------------------------------------------------------

function dedupeKeepFirst(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

/**
 * Sets the stored order for `folderPath` to `names` (de-duplicated,
 * keeping each name's first occurrence). An empty `names` array removes the
 * key instead of storing `[]`: an empty order is the *absence* of an order,
 * not a distinct zero-length one — storing `[]` would make
 * `removeOrder(setOrder(i, p, []), p)` differ from `i`.
 */
export function setOrder(index: OrderIndex, folderPath: string, names: readonly string[]): OrderIndex {
	const deduped = dedupeKeepFirst(names);
	if (deduped.length === 0) return removeOrder(index, folderPath);
	const next = new Map(index);
	next.set(folderPath, deduped);
	return next;
}

export function removeOrder(index: OrderIndex, folderPath: string): OrderIndex {
	if (!index.has(folderPath)) return index;
	const next = new Map(index);
	next.delete(folderPath);
	return next;
}

/**
 * Remaps `oldPath` to `newPath`, for that key itself and every descendant
 * key. Descendant matching is on `oldPath + '/'` as a literal prefix — not
 * on `oldPath` alone — so renaming `Projects` remaps `Projects/Notes` but
 * leaves a sibling folder that merely starts with the same characters, like
 * `ProjectsOld/Notes`, untouched.
 */
export function renameFolderPath(index: OrderIndex, oldPath: string, newPath: string): OrderIndex {
	if (oldPath === newPath) return index;
	const prefix = `${oldPath}/`;
	let changed = false;
	const next = new Map<string, readonly string[]>();
	for (const [key, value] of index) {
		if (key === oldPath) {
			next.set(newPath, value);
			changed = true;
		} else if (key.startsWith(prefix)) {
			next.set(newPath + key.slice(oldPath.length), value);
			changed = true;
		} else {
			next.set(key, value);
		}
	}
	return changed ? next : index;
}

/**
 * Swaps `oldName` for `newName` at whatever position it occupies in
 * `folderPath`'s stored order, disturbing nothing else. If `folderPath` has
 * no stored order, or `oldName` isn't in it, returns `index` unchanged
 * (same reference).
 *
 * Any *other* occurrence of `newName` is dropped, keeping the renamed entry
 * at its own position. Stored orders are otherwise duplicate-free by
 * `setOrder`'s construction, and this is the one mutation that could
 * reintroduce a duplicate: delete `B.md`, then rename `A.md` to `B.md`, and
 * if the two events are applied in the other order the array briefly holds
 * `B` twice. `mergeOrder` would render that correctly anyway (it ignores
 * repeats), so this is about not letting a duplicate reach disk, where a
 * human reading the file would have to wonder which one wins.
 */
export function renameEntry(index: OrderIndex, folderPath: string, oldName: string, newName: string): OrderIndex {
	const order = index.get(folderPath);
	if (order === undefined) return index;
	const pos = order.indexOf(oldName);
	if (pos === -1) return index;
	const newOrder: string[] = [];
	for (const [i, name] of order.entries()) {
		if (i === pos) newOrder.push(newName);
		else if (name !== newName) newOrder.push(name);
	}
	const next = new Map(index);
	next.set(folderPath, newOrder);
	return next;
}

/** Drops `name` from `folderPath`'s stored order, if present. Removes the key entirely if that empties it (via `setOrder`'s invariant). */
export function removeEntry(index: OrderIndex, folderPath: string, name: string): OrderIndex {
	const order = index.get(folderPath);
	if (order === undefined) return index;
	if (!order.includes(name)) return index;
	return setOrder(index, folderPath, order.filter((n) => n !== name));
}

/** Drops every key not present in `existingFolderPaths`. */
export function pruneMissing(index: OrderIndex, existingFolderPaths: ReadonlySet<string>): OrderIndex {
	let changed = false;
	const next = new Map<string, readonly string[]>();
	for (const [key, value] of index) {
		if (existingFolderPaths.has(key)) {
			next.set(key, value);
		} else {
			changed = true;
		}
	}
	return changed ? next : index;
}

// ---------------------------------------------------------------------------
// Render-time reconcile
// ---------------------------------------------------------------------------

/**
 * Reconciles a folder's stored order against its actual current children:
 * stored names that still exist in `liveNames`, in stored order, followed by
 * every `liveNames` entry the stored order doesn't mention, in the order
 * they arrived in `liveNames`. That trailing order is load-bearing — it is
 * what makes the file explorer's own sort setting apply to anything the user
 * didn't place by hand, instead of some arbitrary fallback this module would
 * otherwise have to invent. Stored names no longer present in `liveNames`
 * are dropped; duplicates in `stored` are ignored after the first.
 */
export function mergeOrder(stored: readonly string[] | undefined, liveNames: readonly string[]): string[] {
	if (stored === undefined) return [...liveNames];

	const live = new Set(liveNames);
	const seen = new Set<string>();
	const merged: string[] = [];

	for (const name of stored) {
		if (seen.has(name)) continue;
		if (!live.has(name)) continue;
		seen.add(name);
		merged.push(name);
	}
	for (const name of liveNames) {
		if (seen.has(name)) continue;
		seen.add(name);
		merged.push(name);
	}
	return merged;
}
