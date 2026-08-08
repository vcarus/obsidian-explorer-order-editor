/**
 * Patches the file explorer to render the order this plugin stores, so
 * custom-sort becomes optional rather than required to actually see a saved
 * order. custom-sort still wins whenever it's installed and enabled — this
 * module never touches `getSortedFolderItems`'s result in that case (see
 * `isCustomSortAvailable`) — so there is exactly one thing deciding the file
 * explorer's order at any moment, never two disagreeing.
 *
 * The only new module that imports `obsidian`, and deliberately thin: every
 * judgment that doesn't need a live `TFolder`/`TAbstractFile` — reconciling
 * a stored order against live siblings, parsing the stored spec text — is
 * already pure (`sortspec.ts`) or lives in `sortspecFile.ts` (the data
 * layer's own, pre-existing single point of `obsidian` contact). This file's
 * own job is narrow: locate the file explorer view, patch its prototype,
 * read the already-parsed frontmatter synchronously, and map the resulting
 * order back onto the live item objects `getSortedFolderItems` already
 * produced.
 *
 * The `getSortedFolderItems` patch itself mirrors exactly how custom-sort
 * patches the same method (verified against its bundled `main.js`: it
 * monkey-patches `leaf.view.constructor.prototype.getSortedFolderItems` with
 * its own `around`-style helper — the same contract `patch.ts` reimplements)
 * — the one deliberate exception to this project's usual "no monkey-patching
 * the file tree" rule (see CLAUDE.md). Everything else in that rule still
 * stands: this never touches the DOM the file explorer builds, never calls a
 * private renderer, and always falls back to the explorer's own result on
 * any error.
 */
import { Plugin, TAbstractFile, TFile, TFolder, type View } from 'obsidian';
import { SORTING_SPEC_KEY } from './frontmatter';
import { aroundPrototypeMethod } from './patch';
import { entryKey, mergeStoredOrder, parseSortingSpec, readFolderOrder, type ParsedSpec } from './sortspec';
import { entryForChild, isCustomSortAvailable, SORTSPEC_FILENAME, sortspecPathFor, specFolderKeyFor, targetKeyFor } from './sortspecFile';
import type { ExplorerOrderEditorSettings } from './settings';
import type { Entry } from './types';

/**
 * `getSortedFolderItems` and `requestSort` are not part of Obsidian's public
 * typed API — they live on the file explorer's own internal view subclass,
 * not on the base `View` every leaf's `.view` is typed as (confirmed against
 * custom-sort's bundled source, which checks for both members by name before
 * trusting a leaf is really the file explorer — the same two this interface
 * declares). A local interface plus a runtime guard, rather than a `declare
 * module 'obsidian'` augmentation on `View` itself: augmenting `View` would
 * make every *other* view (markdown, graph, ...) wrongly appear to have
 * these two members too. This follows the same "declare only the slice you
 * use, right next to its use" precedent as the `App.commands` augmentation
 * at the top of sortspecFile.ts; `sortspecFile.ts` needs `requestSort` too,
 * for a different reason, and declares its own equally narrow, independent
 * copy rather than importing this one (see the comment there for why that
 * would be circular).
 */
interface FileExplorerView extends View {
	getSortedFolderItems(folder: TFolder): FileExplorerItem[];
	requestSort(): void;
}

/**
 * `getSortedFolderItems` returns the file explorer's own *row* objects, not
 * `TAbstractFile`s — each row wraps the file it renders. Verified in
 * custom-sort's bundled `main.js`, whose replacement for this same method
 * ends with `a.sort(s), a.map(m => o[m.path])` where `o = this.fileItems`:
 * it sorts `TAbstractFile`s and then maps each one back through the view's
 * `fileItems` index before returning. So the array in and the array out are
 * both rows, and `.file` is how you get from one to the other.
 *
 * Declaring only `.file` deliberately: it is all this module reads. Getting
 * this shape wrong is not a theoretical concern — an earlier draft of this
 * file typed the return as `TAbstractFile[]`, which type-checked (the
 * interface is our own assertion about an untyped internal, so nothing could
 * contradict it), made every `instanceof TFile` check silently false, and
 * would have rendered every ordered folder as empty. Hence the runtime shape
 * guard in the replacement below: a wrong assumption here has to fail into
 * the explorer's own ordering, not into an empty file tree.
 */
interface FileExplorerItem {
	readonly file: TAbstractFile;
}

function isFileExplorerView(view: View): view is FileExplorerView {
	const candidate = view as Partial<FileExplorerView>;
	return typeof candidate.getSortedFolderItems === 'function' && typeof candidate.requestSort === 'function';
}

type GetSortedFolderItemsFn = (this: FileExplorerView, folder: TFolder) => FileExplorerItem[];

/**
 * Structural slice of `Plugin`, matching `OrderSyncHost`/`SettingsHost`
 * elsewhere — avoids a circular import against `main.ts`.
 */
export interface ExplorerSortHost extends Plugin {
	settings: ExplorerOrderEditorSettings;
}

/** One parsed-spec cache entry per sortspec.md path, invalidated by content. */
interface CachedSpec {
	readonly raw: string;
	readonly spec: ParsedSpec;
}

/**
 * Builds the `getSortedFolderItems` replacement for one file explorer view.
 * `cache` is created once per install (shared across every folder the view
 * asks about, for the file explorer's whole lifetime) so a fresh parse only
 * happens when a given folder's `sorting-spec` text actually changed since
 * the last call — see `getParsedSpec`.
 */
function buildReplacement(host: ExplorerSortHost, cache: Map<string, CachedSpec>): (original: GetSortedFolderItemsFn) => GetSortedFolderItemsFn {
	const { app } = host;

	function getParsedSpec(path: string, raw: string, specFolderKey: string): ParsedSpec {
		const cached = cache.get(path);
		if (cached !== undefined && cached.raw === raw) return cached.spec;
		const spec = parseSortingSpec(raw, specFolderKey);
		cache.set(path, { raw, spec });
		return spec;
	}

	return (original) =>
		function replacement(this: FileExplorerView, folder: TFolder): FileExplorerItem[] {
			// Always computed first and kept as the fallback: the explorer's
			// own ordering under whatever sort setting the user has chosen,
			// and the raw material our own reorder works from. No I/O here,
			// so nothing before this line needs the try/catch below.
			const items = original.call(this, folder);

			try {
				// custom-sort, when present and enabled, is the one source of
				// truth for the rendered order; this patch stays out of its
				// way entirely rather than risk the two disagreeing. Checked
				// per call (cheap: a single `in` lookup) so toggling
				// custom-sort on/off at runtime is picked up immediately,
				// without needing to know about it.
				if (isCustomSortAvailable(app)) return items;

				const path = sortspecPathFor(folder);
				const sortspecFile = app.vault.getFileByPath(path);
				if (sortspecFile === null) return items; // no sortspec.md for this folder at all

				// Synchronous by design: `getSortedFolderItems` cannot await
				// anything. The already-parsed frontmatter in `metadataCache`
				// is exactly what `folderHasClearableOrder` reads the same
				// way, for the same reason.
				const rawValue: unknown = app.metadataCache.getFileCache(sortspecFile)?.frontmatter?.[SORTING_SPEC_KEY];
				if (typeof rawValue !== 'string') return items;

				// Entries derived in the *items' own* order — this is what
				// makes the result agree with the explorer's current sort
				// setting for anything the stored order doesn't mention,
				// instead of falling back to `entriesFor`'s alphabetic
				// guess. `sortspec.md` itself is tracked separately: it's
				// excluded from `siblings`/`itemByKey` by `entryForChild`
				// (same as `entriesFor`), so it never participates in
				// `readFolderOrder`/`mergeStoredOrder`, and is re-appended
				// or omitted below based on the "hide" setting alone.
				let sortspecItem: FileExplorerItem | null = null;
				const siblings: Entry[] = [];
				const itemByKey = new Map<string, FileExplorerItem>();
				for (const item of items) {
					const file: unknown = item?.file;
					// The shape guard `FileExplorerItem` documents. A row that
					// isn't wrapping a file or a folder means our assumption
					// about this internal no longer holds, and the only safe
					// answer is to render nothing of our own.
					if (!(file instanceof TFile) && !(file instanceof TFolder)) return items;

					if (file instanceof TFile && file.name === SORTSPEC_FILENAME) {
						sortspecItem = item;
						continue;
					}
					const entry = entryForChild(file);
					// Unreachable given the guard above — `entryForChild`'s only
					// other null case is sortspec.md, handled just above. Kept as
					// a fail-safe: a row we cannot key has to send us back to the
					// explorer's own order, never be dropped from the file tree.
					if (entry === null) return items;
					siblings.push(entry);
					itemByKey.set(entryKey(entry), item);
				}

				// No row could be keyed, yet the folder has rows. Nothing below
				// can emit a row that isn't in `itemByKey`, so this would
				// reconcile to an empty order and render the folder empty — the
				// exact shape of the bug the guard above prevents, caught a
				// second time on the way out.
				if (siblings.length === 0) return items;

				const spec = getParsedSpec(path, rawValue, specFolderKeyFor(folder));
				const stored = readFolderOrder(spec, targetKeyFor(folder), siblings);
				if (stored === null) return items; // no saved order for this folder — the common case, kept cheap

				const merged = mergeStoredOrder(stored, siblings);
				const result: FileExplorerItem[] = [];
				for (const entry of merged) {
					const item = itemByKey.get(entryKey(entry));
					// Always found: `merged` only ever contains entries that
					// came from `siblings`, and every `siblings` entry has a
					// corresponding `itemByKey` mapping by construction. The
					// guard exists so a future change to that invariant fails
					// safe (skips one item) instead of pushing `undefined`.
					if (item !== undefined) result.push(item);
				}

				// custom-sort's `/--hide:` directive achieves the same
				// omission for its own renderer; this is that same effect
				// for ours, driven by the same setting, so the two renderers
				// agree regardless of which one is currently active. We keep
				// writing `/--hide:` unchanged either way (see
				// `upsertFolderOrder`'s `hideNames` parameter) — this is
				// purely about what *this* renderer includes.
				if (sortspecItem !== null && !host.settings.hideSortspec) {
					result.push(sortspecItem);
				}

				return result;
			} catch (err) {
				// Obsidian's internals changed under us, or something above
				// misbehaved: degrade to the explorer's own ordering rather
				// than let the file explorer break. Logged once per call,
				// not deduplicated — same tradeoff `syncHideSetting` and
				// `orderSync.ts` already make elsewhere in this plugin.
				console.error('[explorer-order-editor] failed to render the saved explorer order, falling back to the default sort', err);
				return items;
			}
		};
}

/**
 * Installs the patch on `view`'s constructor prototype — once per file
 * explorer view class, not per instance, since Obsidian only ever
 * constructs one file explorer view class and every leaf of that type
 * shares its prototype. Registers the remover with `host.register` so
 * unloading the plugin restores `getSortedFolderItems` untouched, then
 * immediately asks the view to redraw so an already-open file explorer
 * reflects any order already saved, without waiting for an unrelated
 * refresh to trigger one.
 */
function installOnView(host: ExplorerSortHost, view: FileExplorerView): void {
	const cache = new Map<string, CachedSpec>();
	const remove = aroundPrototypeMethod<GetSortedFolderItemsFn>(
		view.constructor.prototype as Record<string, unknown>,
		'getSortedFolderItems',
		buildReplacement(host, cache),
	);
	host.register(remove);
	view.requestSort();
}

/**
 * Wires up the file explorer patch. Call once, from `onLayoutReady` — plugin
 * load order is not guaranteed any earlier (see the identical reasoning on
 * `isCustomSortAvailable` in sortspecFile.ts and on `registerOrderSync` in
 * orderSync.ts), and the file explorer leaf itself may not exist yet the
 * first time this runs. When it doesn't (or its view doesn't yet expose
 * `getSortedFolderItems`/`requestSort` — e.g. it's still a deferred, lazily
 * constructed leaf), this retries on every `layout-change` until it
 * succeeds once, then stops listening; it does not retry on any later
 * failure, since a leaf that has already produced a real file explorer view
 * is not expected to stop being one.
 */
export function installExplorerSort(host: ExplorerSortHost): void {
	const tryInstall = (): boolean => {
		const leaf = host.app.workspace.getLeavesOfType('file-explorer')[0];
		if (leaf === undefined) return false;
		if (!isFileExplorerView(leaf.view)) return false;
		installOnView(host, leaf.view);
		return true;
	};

	if (tryInstall()) return;

	const ref = host.app.workspace.on('layout-change', () => {
		if (tryInstall()) host.app.workspace.offref(ref);
	});
	host.registerEvent(ref);
}
