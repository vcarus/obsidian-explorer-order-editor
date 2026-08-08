/**
 * The only file in the data layer that imports `obsidian` (`explorerSort.ts`
 * also imports it, but sits alongside `orderSync.ts`/`OrderModal.ts`/
 * `settings.ts` as a downstream consumer of this layer, not part of it).
 * Everything here either derives `Entry[]` from a live `TFolder`, or
 * performs the atomic read-modify-write of a folder's sortspec.md and (once
 * written) pokes custom-sort — or, absent custom-sort, the file explorer
 * directly — into picking the change up.
 *
 * `App.commands` is not part of Obsidian's public typed API. The module
 * augmentation below declares only the slice we actually call — looking a
 * command up by id and executing it — right here, next to (and only next
 * to) the code that uses it, rather than casting to `any` at each call site.
 * The shape has been stable across the plugin API's history; every community
 * plugin that pokes commands programmatically relies on the same two
 * members.
 */
import { App, normalizePath, parseYaml, TAbstractFile, TFile, TFolder, type Command } from 'obsidian';
import { readSortingSpecValue, removeSortingSpecFromFile, replaceSortingSpecInFile, SORTING_SPEC_KEY, type FrontMatterDeps } from './frontmatter';
import {
	hasAuthoredSection,
	mergeStoredOrder,
	parseSortingSpec,
	readFolderOrder,
	removeFolderOrder,
	serializeSortingSpec,
	specTargets,
	upsertFolderOrder,
	type MutationResult,
	type ParsedSpec,
} from './sortspec';
import { fallbackEntryOrder, type Entry } from './types';

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
 * Derives a single child's `Entry`, or `null` for `sortspec.md` itself or for
 * a node that is neither a file nor a folder. `.md` files use their basename
 * (no extension); every other file uses its full name including the
 * extension; folders use the folder name — the exact strings custom-sort
 * matches against (see `types.ts`).
 *
 * Deliberately Obsidian's own `extension`/`basename` rather than
 * `entryNameForFileName`, even though the two agree on every name either of
 * us has been able to construct: custom-sort derives the names it matches
 * against from these same two `TFile` fields, so reading them is what makes
 * our output agree with it *by definition*, whatever Obsidian's exact rule
 * for `extension` turns out to be (the API docs don't say whether it is
 * lower-cased). `entryNameForFileName` exists for the one place that has no
 * `TFile` to ask — reconstructing the *former* name from a rename event's
 * `oldPath` — and says so.
 *
 * `sortspec.md` is never offered: it's the file this plugin manages, and
 * listing it invites ordering the thing that describes the order. Leaving it
 * unlisted is harmless — an unlisted entry sorts to the end, whether that's
 * custom-sort's default or `explorerSort.ts`'s own rendering of it (subject
 * to the "hide sortspec.md" setting there).
 *
 * Exported (not just used by `entriesFor` below) so `explorerSort.ts` can
 * derive entries from the file explorer's own live item list, in the
 * *items' own* order, without re-deriving this naming rule and without
 * going through `entriesFor`'s `fallbackEntryOrder` sort — the file
 * explorer's own current order is the value that replacement keys off, not
 * the alphabetic fallback.
 */
export function entryForChild(child: TAbstractFile): Entry | null {
	if (child instanceof TFolder) {
		return { name: child.name, kind: 'folder' };
	}
	if (child instanceof TFile) {
		if (child.name === SORTSPEC_FILENAME) return null;
		const name = child.extension === 'md' ? child.basename : child.name;
		return { name, kind: 'file' };
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
export function entriesFor(folder: TFolder): readonly Entry[] {
	const entries: Entry[] = [];
	for (const child of folder.children) {
		const entry = entryForChild(child);
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

/** The normalized vault path to `folder`'s sortspec.md, whether or not it exists yet. */
export function sortspecPathFor(folder: TFolder): string {
	const path = folder.isRoot() ? SORTSPEC_FILENAME : `${folder.path}/${SORTSPEC_FILENAME}`;
	return normalizePath(path);
}

/**
 * The canonical key `parseSortingSpec`/`normalizeTarget` use for `folder`
 * itself (`/` for the vault root). Exported so `explorerSort.ts` can parse a
 * folder's `sorting-spec` value with the same `specFolder` every other
 * reader (`readStoredOrder`, `folderHasClearableOrder`, ...) uses — a `.`
 * target only resolves correctly when it does.
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
 * Whether the custom-sort plugin is installed *and* enabled right now.
 *
 * Probed through the command registry rather than the plugin list: the
 * command is the thing we actually need, so its presence is exactly the
 * capability we care about, and unlike `app.plugins` it survives the plugin
 * being installed-but-disabled without a separate check.
 *
 * Not meaningful during our own `onload` — plugin load order is not
 * guaranteed, so custom-sort may not have registered its commands yet. Call
 * it from `onLayoutReady` or later, or it will report a false negative.
 */
export function isCustomSortAvailable(app: App): boolean {
	return CUSTOM_SORT_COMMAND_ID in app.commands.commands;
}

/**
 * Resolves once `metadataCache` has caught up with `file` (or the timeout
 * elapses, so a missed event can't hang the caller).
 *
 * Exported separately from the trigger below for callers that write now but
 * refresh later — the reorder dialog batches one refresh for a whole
 * session of saves. `waitForMetadataChange` registers its listener when it
 * is called, so starting the wait at *refresh* time would be too late: the
 * event fired back when the file was written, nothing would arrive, and the
 * full timeout would be burned every time. Started at write time it has
 * normally already resolved by the time anyone awaits it.
 */
export function awaitMetadataSettled(app: App, file: TFile): Promise<void> {
	return waitForMetadataChange(app, file, METADATA_WAIT_TIMEOUT_MS);
}

/**
 * `requestSort` (forces the file explorer to recompute and redraw a folder's
 * children) is not part of Obsidian's public typed API — it lives on the
 * file explorer's own internal view subclass, not on the base `View` every
 * leaf's `.view` is typed as. `explorerSort.ts` needs the same member for a
 * different reason (installing the patch) and declares its own local
 * interface for it, right next to its own use, the same way `App.commands`
 * is declared right next to its use just above. This is a second,
 * independently-scoped declaration rather than a shared one imported from
 * there: `explorerSort.ts` already imports from this file
 * (`isCustomSortAvailable`, `entryForChild`, `sortspecPathFor`,
 * `specFolderKeyFor`, `targetKeyFor`) to do its own job, so the reverse
 * import this file would need to reuse its interface would be circular.
 */
interface FileExplorerViewLike {
	requestSort(): void;
}

/**
 * Finds the file explorer leaf, if one exists, and asks its view to
 * recompute and redraw — the same effect custom-sort's refresh command has,
 * used here for the case custom-sort isn't the one rendering: once
 * `explorerSort.ts` has patched `getSortedFolderItems`, that patch already
 * computes the right order on every call, but Obsidian doesn't re-invoke it
 * just because we edited sortspec.md's frontmatter, so this is what actually
 * makes a write visible.
 *
 * Returns `false` when there is no file explorer leaf, or its view doesn't
 * (yet, or ever) expose `requestSort` — e.g. `explorerSort.ts` hasn't
 * finished installing. Never throws.
 */
function requestFileExplorerResort(app: App): boolean {
	const leaf = app.workspace.getLeavesOfType('file-explorer')[0];
	if (leaf === undefined) return false;
	const view = leaf.view as Partial<FileExplorerViewLike>;
	if (typeof view.requestSort !== 'function') return false;
	view.requestSort();
	return true;
}

/**
 * Runs custom-sort's refresh command when it's present. When it isn't, asks
 * the file explorer to redraw itself directly instead — `explorerSort.ts`'s
 * patched `getSortedFolderItems` renders our own order once that redraw
 * happens, so custom-sort is no longer required for a save to become
 * visible. `'missing'` now means neither mechanism is available (no
 * custom-sort *and* no file explorer leaf/patch to ask) — genuinely rare,
 * but still reported so a write that silently isn't visible anywhere isn't
 * mistaken for one that is.
 *
 * Assumes the metadata cache is already current — see `awaitMetadataSettled`.
 */
export function triggerCustomSortRefresh(app: App): 'triggered' | 'rendered' | 'missing' {
	if (isCustomSortAvailable(app)) {
		app.commands.executeCommandById(CUSTOM_SORT_COMMAND_ID);
		return 'triggered';
	}
	return requestFileExplorerResort(app) ? 'rendered' : 'missing';
}

/** Wait, then trigger — for callers that write and refresh in one go. */
export async function refreshCustomSort(app: App, file: TFile): Promise<'triggered' | 'rendered' | 'missing'> {
	await awaitMetadataSettled(app, file);
	return triggerCustomSortRefresh(app);
}

export interface HideSettingSyncResult {
	/** sortspec.md files examined. */
	readonly scanned: number;
	/** Files actually rewritten. */
	readonly changed: number;
	/** Files that threw and were left alone. */
	readonly failed: number;
	/**
	 * A metadata-cache wait armed at the moment of the last successful write,
	 * or `null` if nothing was written. The caller awaits this before asking
	 * custom-sort to re-read, so it reads a cache that has caught up.
	 *
	 * Armed in here rather than by the caller afterwards for the reason
	 * `awaitMetadataSettled` documents: the listener has to exist before the
	 * write it is waiting on. A caller that starts waiting once the pass is
	 * over is waiting for an event that already fired, and gets the full
	 * timeout instead.
	 */
	readonly settled: Promise<void> | null;
}

/**
 * Vault-wide pass that immediately syncs every folder's authored `/--hide:`
 * state with the "hide sortspec.md" setting, instead of waiting for the
 * setting's only other effect site — `OrderModal.save`, which only emits the
 * directive the next time that particular folder's order happens to be
 * saved. Without this, toggling the setting does nothing observable until
 * some unrelated future save — which, from the user's side, looks like the
 * setting doing nothing at all.
 *
 * Only rewrites sortspec.md files that already carry a section *authored by
 * us* for their own folder (`hasAuthoredSection`) — a folder with no
 * authored section is left completely alone, per the "never touch
 * hand-written config" rule; we must not upsert a brand-new section into
 * existence here. The order re-written is always
 * `mergeStoredOrder(<the folder's current stored order>, <its live
 * children>)` — whatever the user already arranged, reconciled against
 * what's actually there now — never a fresh alphabetical order, which would
 * silently destroy every saved order in the vault the first time this
 * setting is toggled. When the stored order can't be read back
 * unambiguously (`readFolderOrder` returns `null` — e.g. a duplicated,
 * hand-edited authored section), the folder is skipped for the same reason:
 * guessing at an order here is worse than doing nothing.
 *
 * As a side effect, rewriting an authored section also re-encodes it from
 * scratch, which drops any stale entry `entriesFor` no longer produces (for
 * example, sortspec.md's own former self-listing, from before `entriesFor`
 * started excluding it). This is a desirable migration, not a bug, but the
 * caller should mention it so a "hide" toggle doesn't appear to have also
 * changed unrelated list contents as a surprise.
 *
 * Goes through `updateFolderSpec`, the same atomic `Vault.process`
 * read-modify-write every other mutation in this plugin uses. A file that
 * throws while being processed (`FrontMatterError`, etc.) increments
 * `failed` and is left untouched; it does not abort the rest of the pass.
 * Does not trigger custom-sort's refresh — that stays the caller's
 * responsibility (as with every other mutation here), since only the caller
 * knows whether the "auto-refresh" setting is on. It does arm the wait that
 * refresh needs (`HideSettingSyncResult.settled`), because only this
 * function is present at the moment of the write.
 */
export async function syncHideSetting(app: App, hide: boolean): Promise<HideSettingSyncResult> {
	const files = app.vault.getAllLoadedFiles().filter((f): f is TFile => f instanceof TFile && f.name === SORTSPEC_FILENAME);
	const hideNames = hide ? [SORTSPEC_FILENAME] : [];

	let scanned = 0;
	let changed = 0;
	let failed = 0;
	let settled: Promise<void> | null = null;

	for (const file of files) {
		const folder = file.parent;
		if (folder === null) continue;
		scanned++;

		try {
			const targetRaw = targetKeyFor(folder);
			const siblings = entriesFor(folder);

			const result = await updateFolderSpec(app, folder, (spec) => {
				if (!hasAuthoredSection(spec, targetRaw)) {
					return { spec, status: 'unchanged', diagnostics: [] };
				}
				const stored = readFolderOrder(spec, targetRaw, siblings);
				if (stored === null) {
					// Ambiguous (e.g. a duplicated, hand-edited authored
					// section) — don't guess at an order, don't touch the file.
					return { spec, status: 'unchanged', diagnostics: [] };
				}
				const order = mergeStoredOrder(stored, siblings);
				return upsertFolderOrder(spec, targetRaw, order, hideNames);
			});

			if (result.status === 'replaced' || result.status === 'appended') {
				changed++;
				// `file` is the sortspec.md just rewritten, so this is a wait
				// that can actually be satisfied. Each write replaces the
				// previous promise; the superseded ones resolve on their own
				// and clean up their own listeners.
				settled = awaitMetadataSettled(app, file);
			}
		} catch (err) {
			failed++;
			console.error('[explorer-order-editor] failed to sync hide setting for', file.path, err);
		}
	}

	return { scanned, changed, failed, settled };
}
