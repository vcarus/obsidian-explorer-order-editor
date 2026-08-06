/**
 * The only file in the data layer that imports `obsidian`. Everything here
 * either derives `Entry[]` from a live `TFolder`, or performs the atomic
 * read-modify-write of a folder's sortspec.md and (once written) pokes
 * custom-sort into picking the change up.
 *
 * `App.commands` is not part of Obsidian's public typed API (see CLAUDE.md's
 * "custom-sort 契约" section). The module augmentation below declares only
 * the slice we actually call — looking a command up by id and executing it
 * — right here, next to (and only next to) the code that uses it. The shape
 * has been stable across the plugin API's history; every community plugin
 * that pokes commands programmatically relies on the same two members.
 */
import { App, normalizePath, parseYaml, TFile, TFolder, type Command } from 'obsidian';
import { readSortingSpecValue, removeSortingSpecFromFile, replaceSortingSpecInFile, SORTING_SPEC_KEY, type FrontMatterDeps } from './frontmatter';
import {
	parseSortingSpec,
	readFolderOrder,
	removeFolderOrder,
	serializeSortingSpec,
	specTargets,
	type MutationResult,
	type ParsedSpec,
} from './sortspec';
import type { Entry } from './types';

declare module 'obsidian' {
	interface App {
		commands: {
			commands: Record<string, Command>;
			executeCommandById(id: string): boolean;
		};
	}
}

export const SORTSPEC_FILENAME = 'sortspec.md';

const CUSTOM_SORT_COMMAND_ID = 'custom-sort:enable-custom-sorting';
const METADATA_WAIT_TIMEOUT_MS = 1000;

const yamlDeps: FrontMatterDeps = { parseYaml };

/**
 * Derives this folder's rows in the fallback order: folders before files,
 * each group alphabetical by display name (there's no public API for "the
 * file explorer's current visual order", so this approximates it). `.md`
 * files use their basename (no extension); every other file uses its full
 * name including the extension; folders use the folder name — the exact
 * strings custom-sort matches against (see `types.ts`).
 *
 * `sortspec.md` itself is never offered: it's the file this plugin manages,
 * and listing it invites ordering the thing that describes the order.
 * Leaving it unlisted is harmless — custom-sort sorts unlisted entries to
 * the end by default.
 */
export function entriesFor(folder: TFolder): readonly Entry[] {
	const folderEntries: Entry[] = [];
	const fileEntries: Entry[] = [];

	for (const child of folder.children) {
		if (child instanceof TFolder) {
			folderEntries.push({ name: child.name, kind: 'folder' });
		} else if (child instanceof TFile) {
			if (child.name === SORTSPEC_FILENAME) continue;
			const name = child.extension === 'md' ? child.basename : child.name;
			fileEntries.push({ name, kind: 'file' });
		}
	}

	folderEntries.sort((a, b) => a.name.localeCompare(b.name));
	fileEntries.sort((a, b) => a.name.localeCompare(b.name));

	return [...folderEntries, ...fileEntries];
}

/**
 * The `target-folder:` value we write for `folder`. Always `.` — every
 * folder's order lives in its own sortspec.md, so the target is always "the
 * folder this file lives in". Kept as a function anyway: it is the single
 * place this decision lives.
 */
export function targetKeyFor(folder: TFolder): string {
	return '.';
}

/** The normalized vault path to `folder`'s sortspec.md, whether or not it exists yet. */
export function sortspecPathFor(folder: TFolder): string {
	const path = folder.isRoot() ? SORTSPEC_FILENAME : `${folder.path}/${SORTSPEC_FILENAME}`;
	return normalizePath(path);
}

/** The canonical key `parseSortingSpec`/`normalizeTarget` use for `folder` itself (`/` for the vault root). */
function specFolderKeyFor(folder: TFolder): string {
	return folder.isRoot() ? '/' : folder.path;
}

/**
 * Applies `mutate` and turns the result into new file text. When the
 * mutated spec serializes to '' (nothing left to say — the case
 * `removeFolderOrder` produces once the last section for a folder is gone),
 * this goes through `removeSortingSpecFromFile` instead of
 * `replaceSortingSpecInFile`, so the `sorting-spec` key itself is dropped
 * (and the front matter block with it, if that empties too) rather than
 * left behind as an empty `sorting-spec: |` block. `upsertFolderOrder`
 * never produces an empty value (an authored section always carries at
 * least its `target-folder:` line and marker), so this only ever engages
 * for removal.
 */
function applyMutation(
	data: string,
	specFolderKey: string,
	mutate: (spec: ParsedSpec) => MutationResult,
): { readonly output: string; readonly result: MutationResult } {
	const read = readSortingSpecValue(data, yamlDeps);
	const spec = parseSortingSpec(read.status === 'ok' ? read.value : '', specFolderKey);
	const result = mutate(spec);
	if (result.status === 'blocked' || result.status === 'unchanged') {
		return { output: data, result };
	}
	const newValue = serializeSortingSpec(result.spec);
	const output = newValue === '' ? removeSortingSpecFromFile(data, yamlDeps) : replaceSortingSpecInFile(data, newValue, yamlDeps);
	return { output, result };
}

/**
 * Reads back the order currently stored for `folder`. `null` when there's no
 * sortspec.md yet, its `sorting-spec` doesn't parse as a plain string, or
 * (per `readFolderOrder`) this folder isn't covered by exactly one section
 * dedicated to it alone. Callers combine this with `mergeStoredOrder` and
 * the live sibling list to reconcile the two.
 */
export async function readStoredOrder(
	app: App,
	folder: TFolder,
	siblings: readonly Entry[],
): Promise<readonly Entry[] | null> {
	const file = app.vault.getFileByPath(sortspecPathFor(folder));
	if (file === null) return null;
	const data = await app.vault.cachedRead(file);
	const read = readSortingSpecValue(data, yamlDeps);
	if (read.status !== 'ok') return null;
	const spec = parseSortingSpec(read.value, specFolderKeyFor(folder));
	return readFolderOrder(spec, targetKeyFor(folder), siblings);
}

/**
 * Atomically reads, mutates, and (unless the mutation was a no-op) writes
 * `folder`'s sortspec.md. `mutate` is a function, not a precomputed string,
 * because `Vault.process` re-reads the file at call time — that is what
 * makes this a genuine read-modify-write; a string computed when the modal
 * opened could clobber a concurrent external edit.
 *
 * `blocked`/`unchanged` mutation results are returned as-is without writing
 * (no pointless write, no mtime churn). If the file doesn't exist yet it is
 * created. If `replaceSortingSpecInFile` throws (`FrontMatterError`),
 * nothing is written and the error propagates to the caller.
 */
export async function updateFolderSpec(
	app: App,
	folder: TFolder,
	mutate: (spec: ParsedSpec) => MutationResult,
): Promise<MutationResult> {
	const specFolderKey = specFolderKeyFor(folder);
	const path = sortspecPathFor(folder);

	const existing = app.vault.getFileByPath(path);
	if (existing === null) {
		const { output, result } = applyMutation('', specFolderKey, mutate);
		if (result.status === 'blocked' || result.status === 'unchanged') return result;
		await app.vault.create(path, output);
		return result;
	}

	let capturedResult: MutationResult | undefined;
	await app.vault.process(existing, (data) => {
		const { output, result } = applyMutation(data, specFolderKey, mutate);
		capturedResult = result;
		return output;
	});
	if (capturedResult === undefined) {
		// Vault.process always invokes fn synchronously before resolving; this
		// only guards against that contract changing out from under us.
		throw new Error('Vault.process did not invoke its callback');
	}
	return capturedResult;
}

/**
 * Sync check for whether `folder` has an authored order that "Clear explorer
 * order" would actually remove. Command `checkCallback`s must be
 * synchronous, so this reads the already-parsed frontmatter straight out of
 * `metadataCache` (the same source custom-sort itself reads) instead of
 * `vault.read`/`cachedRead`, both of which are async.
 *
 * Delegates the actual "would this remove something" judgment to
 * `removeFolderOrder` itself rather than re-deriving it, so this can never
 * drift out of sync with what `clearFolderOrder` below actually does.
 */
export function folderHasClearableOrder(app: App, folder: TFolder): boolean {
	const file = app.vault.getFileByPath(sortspecPathFor(folder));
	if (file === null) return false;
	const value: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[SORTING_SPEC_KEY];
	if (typeof value !== 'string') return false;
	const spec = parseSortingSpec(value, specFolderKeyFor(folder));
	return removeFolderOrder(spec, targetKeyFor(folder)).status === 'removed';
}

/**
 * Clears whatever this plugin authored for `folder`, via the same
 * read-modify-write path as `updateFolderSpec` (a mutate function passed
 * into `Vault.process`, not a precomputed string — same freshness guarantee).
 *
 * `removeFolderOrder` only ever deletes sections carrying our
 * `// explorer-order-editor` marker (see its tests: "a foreign matching
 * section is left untouched"), so this can't take hand-written config with
 * it. Cascading cleanup — empty `sorting-spec` drops the key, an empty front
 * matter block is removed, a file left with nothing at all — is
 * `applyMutation`'s/`removeSortingSpecFromFile`'s job; this function's own
 * added responsibility is the last step of that cascade: when the file is
 * left with truly nothing (not even a body), it's trashed via
 * `fileManager.trashFile` rather than kept around as a zero-byte file.
 */
export async function clearFolderOrder(app: App, folder: TFolder): Promise<MutationResult> {
	const specFolderKey = specFolderKeyFor(folder);
	const targetRaw = targetKeyFor(folder);
	const path = sortspecPathFor(folder);

	const existing = app.vault.getFileByPath(path);
	if (existing === null) {
		return removeFolderOrder(parseSortingSpec('', specFolderKey), targetRaw);
	}

	let capturedResult: MutationResult | undefined;
	let capturedOutput: string | undefined;
	await app.vault.process(existing, (data) => {
		const { output, result } = applyMutation(data, specFolderKey, (spec) => removeFolderOrder(spec, targetRaw));
		capturedResult = result;
		capturedOutput = output;
		return output;
	});
	if (capturedResult === undefined || capturedOutput === undefined) {
		// Vault.process always invokes fn synchronously before resolving; this
		// only guards against that contract changing out from under us.
		throw new Error('Vault.process did not invoke its callback');
	}
	if (capturedResult.status === 'removed' && capturedOutput === '') {
		await app.fileManager.trashFile(existing);
	}
	return capturedResult;
}

/**
 * custom-sort also reads a folder note (`Folder/Folder.md`, if one exists)
 * as a sorting spec for `Folder` itself. If that note's own `sorting-spec`
 * has a section targeting this same folder, it's a second, independent
 * source of truth for the same file explorer view — custom-sort documents
 * no precedence rule for two files each claiming the same `target-folder:`.
 * This only detects that and lets the caller warn; it never reads the
 * note's content into the modal or edits a file this plugin doesn't own.
 */
export async function folderNoteConflict(app: App, folder: TFolder): Promise<boolean> {
	if (folder.isRoot()) return false; // no folder note for the vault root
	const path = normalizePath(`${folder.path}/${folder.name}.md`);
	const file = app.vault.getFileByPath(path);
	if (file === null) return false;
	const data = await app.vault.cachedRead(file);
	const read = readSortingSpecValue(data, yamlDeps);
	if (read.status !== 'ok') return false;
	const specFolderKey = specFolderKeyFor(folder);
	const spec = parseSortingSpec(read.value, specFolderKey);
	return specTargets(spec, specFolderKey);
}

function waitForMetadataChange(app: App, file: TFile, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			app.metadataCache.offref(ref);
			window.clearTimeout(timeoutId);
			resolve();
		};
		const ref = app.metadataCache.on('changed', (changedFile) => {
			if (changedFile.path === file.path) finish();
		});
		const timeoutId = window.setTimeout(finish, timeoutMs);
	});
}

/**
 * custom-sort never re-reads sortspec.md on its own, and it reads the
 * *parsed* frontmatter via `metadataCache`, not the raw file we just wrote —
 * so this waits for the cache to catch up (with a timeout fallback in case
 * the event never fires, so a missed event can't hang the flow) and then
 * runs its refresh command.
 *
 * Returns `'missing'` without throwing when the command isn't registered
 * (custom-sort not installed or disabled) — the caller's write already
 * succeeded and should still be treated as a success; this only affects
 * whether the file explorer visibly reflects it.
 */
export async function refreshCustomSort(app: App, file: TFile): Promise<'triggered' | 'missing'> {
	await waitForMetadataChange(app, file, METADATA_WAIT_TIMEOUT_MS);
	if (!(CUSTOM_SORT_COMMAND_ID in app.commands.commands)) {
		return 'missing';
	}
	app.commands.executeCommandById(CUSTOM_SORT_COMMAND_ID);
	return 'triggered';
}
