/**
 * As of M10b, superseded by `indexFile.ts`/`orderIndex.ts` as this plugin's
 * storage: nothing here is called from the running plugin's render/save/sync
 * paths except `entryForChild`/`entriesFor` (updated in place — see their
 * doc comments). Everything else operates on the old per-folder sortspec.md
 * format, and as of M10c exists only to serve the two one-time migration
 * commands in `sortspecMigration.ts` — importing whatever this plugin
 * previously wrote there into the order index, and cleaning up the files
 * afterward. The write side that used to live here (`upsertFolderOrder` and
 * friends) was deleted along with `sortspec.ts`'s own encoder; only the read
 * (`readFolderOrder`, via `sortspec.ts` directly) and removal
 * (`updateFolderSpec`, `clearFolderOrder`, both still here) paths remain.
 *
 * The custom-sort-refresh machinery (`awaitMetadataSettled`,
 * `triggerCustomSortRefresh`, `isCustomSortAvailable`, ...) was removed
 * outright rather than left dead, because it was the source of two released
 * bugs (0.4.1, 0.5.1) from getting its metadata-cache wait ordering wrong,
 * and M10b's new render path has nothing left to wait for — there is no
 * reason to keep a footgun on disk that nothing calls.
 */
import { App, normalizePath, parseYaml, TAbstractFile, TFile, TFolder } from 'obsidian';
import { readSortingSpecValue, removeSortingSpecFromFile, replaceSortingSpecInFile, type FrontMatterDeps } from './frontmatter';
import { parseSortingSpec, removeFolderOrder, serializeSortingSpec, type MutationResult, type ParsedSpec } from './sortspec';
import { fallbackEntryOrder, type Entry } from './types';

export const SORTSPEC_FILENAME = 'sortspec.md';

const yamlDeps: FrontMatterDeps = { parseYaml };

/**
 * Derives a single child's `Entry`, or `null` for the order index note
 * itself (identified by `indexNotePath`, the normalized vault path of
 * `settings.indexPath` — there is exactly one, vault-wide, unlike the old
 * one-sortspec.md-per-folder scheme) or for a node that is neither a file
 * nor a folder. Since M10b, both files and folders use their full name,
 * extension included — what the index (`orderIndex.ts`) stores, and what
 * `OrderModal.ts` needs so a row's *identity* matches what `store.update`
 * will write; `types.ts`'s `displayLabel` is what strips `.md` for display.
 *
 * The index note is never offered: it's the file this plugin manages, and
 * listing it invites ordering the thing that describes the order. Leaving it
 * unlisted is harmless — an unlisted entry sorts to the end.
 *
 * Not exported: `entriesFor` below is its only caller.
 */
function entryForChild(child: TAbstractFile, indexNotePath: string): Entry | null {
	if (child instanceof TFolder) {
		return { name: child.name, kind: 'folder' };
	}
	if (child instanceof TFile) {
		if (child.path === indexNotePath) return null;
		return { name: child.name, kind: 'file' };
	}
	return null;
}

/**
 * Derives this folder's rows, in `fallbackEntryOrder` — see it for what that
 * order is and where it knowingly diverges from the file explorer.
 *
 * Only the name derivation (`entryForChild`) lives in this file, because
 * only it needs a `TFile`/`TFolder`; the ordering itself is pure and
 * unit-tested in `types.ts` rather than trapped behind this function's
 * `obsidian` import.
 */
export function entriesFor(folder: TFolder, indexNotePath: string): readonly Entry[] {
	const entries: Entry[] = [];
	for (const child of folder.children) {
		const entry = entryForChild(child, indexNotePath);
		if (entry !== null) entries.push(entry);
	}
	return fallbackEntryOrder(entries);
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

/**
 * The normalized vault path to `folder`'s sortspec.md, whether or not it
 * exists yet. Not exported: `updateFolderSpec`/`clearFolderOrder` below are
 * its only callers.
 */
function sortspecPathFor(folder: TFolder): string {
	const path = folder.isRoot() ? SORTSPEC_FILENAME : `${folder.path}/${SORTSPEC_FILENAME}`;
	return normalizePath(path);
}

/**
 * The canonical key `parseSortingSpec`/`normalizeTarget` use for `folder`
 * itself (`/` for the vault root) — a `.` target only resolves correctly
 * when every reader of a given sortspec.md parses it with the same
 * `specFolder`.
 */
export function specFolderKeyFor(folder: TFolder): string {
	return folder.isRoot() ? '/' : folder.path;
}

/**
 * Applies `mutate` and turns the result into new file text. When the
 * mutated spec serializes to '' (nothing left to say — the case
 * `removeFolderOrder` produces once the last section for a folder is gone),
 * this goes through `removeSortingSpecFromFile` instead of
 * `replaceSortingSpecInFile`, so the `sorting-spec` key itself is dropped
 * (and the front matter block with it, if that empties too) rather than
 * left behind as an empty `sorting-spec: |` block.
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

