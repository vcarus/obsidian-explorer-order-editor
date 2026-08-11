/**
 * The runtime home of the vault-level order index (`orderIndex.ts`): loads
 * the index note once at startup, keeps the parsed `OrderIndex` in memory as
 * the value every other module reads (`get`), and persists mutations
 * (`update`) back to the note on a short debounce, so a burst of calls — a
 * sync client landing a batch of renames, several rows dragged in one modal
 * session — becomes one write, not one per call.
 *
 * The in-memory index is the source of truth; the note is its persistence.
 * `get` never touches disk — it is a synchronous `Map` lookup, because it
 * sits on the file explorer's hot path (`explorerSort.ts` calls it from
 * inside a patched `getSortedFolderItems`, which cannot be async).
 *
 * Deliberately thin: every judgment that doesn't need the vault — parsing,
 * serializing, the pure mutations, the rebuild loop's per-attempt decision —
 * lives in `orderIndex.ts`/`rebuildStep.ts`, so what stays here is only
 * I/O, event wiring, and state the vault forces on us.
 *
 * Healing: detecting that the note is unreadable never, by itself,
 * changes anything on disk (see `applyParsed`/`markUnusable` — a hand edit
 * inside Obsidian necessarily passes through "not valid JSON yet" on every
 * autosave, and a store that healed at that moment would clobber the user
 * mid-keystroke). Healing only ever runs from `updateOrRepair`/`repair`, and
 * only in response to an explicit user action asking for an order to change
 * — a save, a move, a drag, a clear, or the settings tab's "Repair the order
 * note" row — never automatically. When it runs, it never chooses one source
 * of truth over another: it unions the unreadable note's own salvageable
 * lines, the in-memory index, the `data.json` backup, and the last text a
 * read found unreadable (`recoverIndex`, in `orderIndex.ts`), preserves the
 * unreadable text as a quarantine note beside the original first, and only
 * then rebuilds. `update()` itself is unchanged — still synchronous, still
 * just refuses while unusable — so
 * `orderSync.ts`'s background reactions to renames/deletes keep behaving
 * exactly as before; a rename elsewhere in the vault is not the user asking
 * this plugin to repair anything.
 */
import { App, Notice, normalizePath, Plugin, TAbstractFile, TFile, TFolder, type View } from 'obsidian';
import { explorerViews } from './fileExplorerLeaves';
import { fillGapsFrom, parseIndex, recoverIndex, serializeIndex, type OrderIndex, type ParseResult } from './orderIndex';
import { INITIAL_HEALTH, madeUnusable, madeUsable, type StoreHealth } from './storeHealth';
import { rebuildStepFor } from './rebuildStep';
import { findFreeQuarantinePath } from './quarantine';
import type { ExplorerOrderEditorSettings } from './settings';

/** The top-level key this plugin's `data.json` stores the index backup under, alongside settings — see `persistBackup`/`readBackup`. */
const INDEX_BACKUP_KEY = 'indexBackup';

/**
 * Recorded when a note that provably held a json block comes back without
 * one. Shared rather than written twice: `applyParsed` (the read side) and
 * `performWrite` (the write side) have to reach the same verdict about a
 * missing block, and two copies of the wording would let them drift apart
 * silently — the write side once checked only `invalid`, which is exactly
 * the drift this guards against recurring.
 */
const MISSING_BLOCK_REASON = 'Its json block is missing';

/**
 * Why a repair attempt ended where it did.
 *
 * Three-valued rather than a boolean because the settings tab acts on the
 * difference and a caller that cannot see it will say something false:
 * `'nothing-to-recover'` is the only outcome for which offering to start over
 * is honest, while `'failed'` means the attempt itself broke — the orders may
 * be perfectly recoverable, and a wipe offered on that footing would discard
 * them on a false premise.
 *
 * Anything reading this as a boolean gets the wrong answer silently, since
 * every member is a non-empty string and therefore truthy. Compare against
 * `'healed'` explicitly.
 */
export type RepairOutcome = 'healed' | 'nothing-to-recover' | 'failed';

/** See `quarantineThenRebuild`: how many read-plan-write rounds it will spend before deciding the note is being rewritten faster than it can be repaired. */
const MAX_REBUILD_ATTEMPTS = 3;

/** What `quarantineThenRebuild`'s caller wants written, and how much of the text it planned from could not be salvaged. */
interface RebuildPlan {
	readonly index: OrderIndex;
	readonly droppedLines: number;
}

/**
 * How a rebuild ended. Every member means something different to the caller,
 * which is why this is not a boolean: three of them leave the store usable and
 * two of them do not, and only `'rebuilt'` actually replaced the note.
 *
 * `copies` rides on every member rather than on `'rebuilt'` alone, and that
 * shape is the point. A quarantine copy is written *before* the write it
 * exists to justify, so an attempt that then loses the identity check leaves
 * one behind and ends somewhere else entirely — adopted, or given up. Naming
 * them used to be the privilege of the one branch that usually has none to
 * name, which is how a *successful* repair could put a note in the vault and
 * mention it nowhere. Carrying the list on the type means a new member cannot
 * be added without a decision about what to say about them.
 */
type RebuildOutcome = { readonly copies: readonly string[] } & (
	| { kind: 'rebuilt'; droppedLines: number }
	| { kind: 'adopted' }
	| { kind: 'already-usable' }
	| { kind: 'nothing-to-recover' }
	| { kind: 'gave-up' }
);

/** Milliseconds a burst of `update()` calls is given to settle before the debounced write actually runs. */
const WRITE_DEBOUNCE_MS = 200;
/** See `awaitIndexing`: ~5s of retries at `WRITE_DEBOUNCE_MS` apiece. */
const MAX_INDEXING_RETRIES = 25;
/** See `retryFailedWrite`: far fewer than the indexing retries, because an I/O error that repeats is not going to settle on its own. */
const MAX_WRITE_RETRIES = 3;

/**
 * Structural slice of `Plugin`, matching `ExplorerSortHost`/`OrderSyncHost`
 * elsewhere — avoids a circular import against `main.ts`.
 */
export interface IndexFileHost extends Plugin {
	settings: ExplorerOrderEditorSettings;
	/**
	 * A serialized read-modify-write of `data.json` (`main.ts`). Required
	 * rather than each writer doing its own `loadData`/`saveData` pair: this
	 * store's backup and the settings object share one file, and merging on
	 * write only prevents a *blind* overwrite — it does nothing about two
	 * cycles interleaving, which silently reverts whichever of the two read
	 * first. See `persistBackup`.
	 */
	updateData(mutate: (data: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
	/** Persists `settings` (`main.ts`), through `updateData`. Needed here so the store can follow a rename of the note it owns. */
	saveSettings(): Promise<void>;
}

/**
 * Where the order index note lives, normalized — the single owner of "which
 * file is the index note".
 *
 * It was computed at eight call sites and compared against at six, in three
 * different shapes (`instanceof TFile` first, `.path ===` alone, or through a
 * local named `indexNotePath`). None of them were wrong, which is exactly the
 * problem: the `normalizePath` is not decoration — a user who types
 * `/Order.md` or `notes//order.md` into settings gets a `settings.indexPath`
 * that matches no `TFile.path` anywhere, and a site that forgot the call
 * would fail only for those users, only on that one feature, and silently.
 * Same reasoning that gave the deferred-leaf walk (`fileExplorerLeaves.ts`)
 * and the rebuild decision (`rebuildStep.ts`) one home each.
 */
export function indexNotePath(settings: ExplorerOrderEditorSettings): string {
	return normalizePath(settings.indexPath);
}

/**
 * Whether `file` is the order index note: the one file this plugin owns, and
 * the one file it must never offer to reorder, drop beside, or list as a
 * sibling.
 *
 * Takes an abstract file and answers `false` for folders, so callers stop
 * pairing the comparison with their own `instanceof` — a folder can never
 * share the note's path anyway, and the two spellings differing between call
 * sites is what made this look like six unrelated checks.
 *
 * A type predicate, not a `boolean`, because the `instanceof` it absorbs was
 * load-bearing at two of those sites: the vault event handlers are handed a
 * `TAbstractFile`, and narrowing it is how they reach a `TFile`-typed
 * continuation. A plain `boolean` would have made each of them keep the
 * `instanceof` anyway, which is the duplication this exists to remove.
 */
export function isIndexNote(file: TAbstractFile, settings: ExplorerOrderEditorSettings): file is TFile {
	return file instanceof TFile && file.path === indexNotePath(settings);
}

/**
 * The key `folder`'s own order is (or would be) stored under in the index.
 * The vault root is keyed `'/'` explicitly, via `isRoot()`, so every caller
 * keys the index the same way without any of them having to know what
 * `TFolder.path` literally returns for the root — a value this codebase has
 * deliberately never depended on (see the same reasoning spelled out in
 * `orderSync.ts`'s rename handling, which compares two resolved folders'
 * `.path` values rather than asserting either).
 *
 * Only for a folder's *own* key. A folder being renamed or deleted can never
 * be the vault root (Obsidian doesn't fire those events for it), so
 * `renameFolderPath`/`removeOrder` call sites that key off the mutated
 * folder's own `TFolder.path` directly don't need this — only call sites
 * that key off a folder currently being *rendered*, *saved to*, or acting as
 * someone else's *parent* do.
 */
export function folderIndexKey(folder: TFolder): string {
	return folder.isRoot() ? '/' : folder.path;
}

interface FileExplorerViewLike {
	requestSort(): void;
}

function isFileExplorerViewLike(view: View): view is View & FileExplorerViewLike {
	const candidate = view as Partial<FileExplorerViewLike>;
	return typeof candidate.requestSort === 'function';
}

/**
 * Asks the file explorer to recompute and redraw, the same effect
 * `IndexFileStore`'s own external-change handling needs and every mutation
 * site (`main.ts`, `OrderModal.ts`, `orderSync.ts`) needs after a write:
 * `getSortedFolderItems` isn't re-invoked just because the in-memory index
 * changed underneath it.
 *
 * `requestSort` is not part of Obsidian's public typed API — it lives on the
 * file explorer's own internal view subclass. Declared as its own narrow,
 * independent interface rather than reusing `explorerSort.ts`'s
 * `FileExplorerView` (which declares the same member for its own reason) —
 * not because of a circular import any more. `fileExplorerLeaves.ts` now owns
 * the leaf-finding this function needs and depends on neither this module nor
 * `explorerSort.ts`, so that circularity is gone. What still keeps this
 * interface local and one field wide is the same discipline every other
 * internal-API touchpoint here follows: declare only the member actually read
 * at this call site, rather than pulling in a richer interface for the one
 * field of it this function uses (`explorerDrag.ts`'s own
 * `FileExplorerViewHandle` makes the identical choice for the identical
 * reason).
 *
 * Every `file-explorer` leaf is asked, not just the first: with two real
 * explorers open, both are showing the order that just changed.
 * `explorerViews` (`fileExplorerLeaves.ts`) is what finds all of them and
 * skips deferred leaves along the way — see that module for why a deferred
 * leaf's view has no `requestSort` to call in the first place.
 *
 * Returns `false` when no leaf's view exposes `requestSort` — never throws.
 */
export function requestFileExplorerResort(app: App): boolean {
	let asked = false;
	for (const view of explorerViews(app, isFileExplorerViewLike)) {
		view.requestSort();
		asked = true;
	}
	return asked;
}

export class IndexFileStore {
	private index: OrderIndex = new Map();
	/**
	 * The usable/unusable state machine, moved only through
	 * `markUsable`/`markUnusable` below — the arms, the evidence each is
	 * required to carry, and the transition semantics (sticky `sawBlock`, the
	 * unreadable text living exactly one unusable stretch, one Notice per
	 * stretch) are all `storeHealth.ts`'s and are tested there as a table.
	 *
	 * `sawBlock` deserves one store-side note the pure module cannot carry:
	 * together with `lastWrittenText` (non-null exactly when this store has
	 * written a note, and every note it writes has a block) it is what
	 * `performWrite` may treat as proof that a block-less note lost one. The
	 * in-memory index is emphatically *not* that proof on the write side,
	 * however well it serves on the read side: `applyParsed` runs after a
	 * read, where a non-empty index can only have come from the note;
	 * `performWrite` runs after the user's edit has already been applied, so
	 * there it is non-empty because somebody just ordered a folder. Reading it
	 * as evidence once refused the first write into an existing note that
	 * never had a block — silently, since nothing throws.
	 */
	private health: StoreHealth = INITIAL_HEALTH;
	/** The exact text this store itself last wrote, so the `modify` listener below can tell its own write apart from an external one. `null` until the first write. */
	private lastWrittenText: string | null = null;
	private writeTimerId: number | null = null;
	/** See `awaitIndexing`. Reset on every successful write. */
	private indexingRetries = 0;
	/** See `retryFailedWrite`. Separate from `indexingRetries` because the two wait for different things and give up at very different counts. */
	private writeRetries = 0;
	/** Serializes writes so two overlapping `Vault.process` calls on the index note can never interleave — same reason `orderSync.ts`'s coordinator chains its own ops. */
	private writeChain: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(private readonly host: IndexFileHost) {
		this.host.registerEvent(
			this.host.app.vault.on('modify', (file) => {
				if (!isIndexNote(file, this.host.settings)) return;
				void this.onExternalModify(file);
			}),
		);
		// The index note is the one file this plugin owns, and `modify` was the
		// only thing watching it. `orderSync.ts` maintains every *other* path
		// in the vault against these two events and deliberately leaves this
		// one out of its remit — so until these existed, nothing at all
		// observed the note being renamed or deleted out from under the store.
		this.host.registerEvent(
			this.host.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile) || oldPath !== this.notePath()) return;
				void this.onIndexNoteRenamed(file.path);
			}),
		);
		this.host.registerEvent(
			this.host.app.vault.on('delete', (file) => {
				if (!isIndexNote(file, this.host.settings)) return;
				this.onIndexNoteDeleted();
			}),
		);
		this.host.register(() => {
			this.disposed = true;
			// Commits the pending write rather than just cancelling it — this
			// callback runs *before* `main.ts`'s `onunload`, so cancelling here
			// leaves `flush()` nothing to find. See `commitPendingWrite`.
			this.commitPendingWrite();
		});
	}

	private notePath(): string {
		return indexNotePath(this.host.settings);
	}

	/**
	 * Follows the note to where the user put it, rather than carrying on
	 * writing to a path nothing lives at any more.
	 *
	 * Not following was worse than it looks. `indexPath` still named the old
	 * path, so the next write recreated a note there with every saved order,
	 * while the renamed copy — no longer matching `indexNotePath` — stopped
	 * being hidden by `explorerSort` and appeared in the tree as a second,
	 * stale index note beside the fresh one.
	 *
	 * A rename is an explicit user action on a file this plugin owns, and
	 * "the data file is wherever I moved it" is the only reading of it that
	 * does not produce a duplicate. Announced, because a setting changing on
	 * its own is exactly the kind of thing that must not happen quietly.
	 */
	private async onIndexNoteRenamed(newPath: string): Promise<void> {
		// Replaced, not mutated: the fields are `readonly`, and `settings.ts`
		// swaps the whole object on every change too.
		this.host.settings = { ...this.host.settings, indexPath: newPath };
		try {
			await this.host.saveSettings();
		} catch (err) {
			console.error('[explorer-order-editor] failed to save the renamed order note path', err);
		}
		new Notice(`Explorer order editor: the order note moved to ${newPath}, so the setting now points there.`);
	}

	/**
	 * Says what will happen, and changes nothing.
	 *
	 * Deleting this note has two honest readings and no way to tell them
	 * apart from a vault event: "start over" (which is how `load()` reads an
	 * absent note at startup) and "a sync client removed it". Acting on the
	 * first means dropping every saved order out of memory on a background
	 * event, with the `data.json` backup left holding a copy that nothing
	 * would go on to consult. Acting on the second means what already
	 * happened before this existed — the next write silently recreates the
	 * note with every order the user just deleted.
	 *
	 * So this does neither, and instead removes the silence: the orders are
	 * still loaded, the note comes back on the next change, and "Clear every
	 * saved order" in settings is the explicit action that actually clears
	 * them. That row already exists and already confirms, and it stays visible
	 * here because the orders are still loaded — its `visible` predicate is
	 * `keys().size > 0`, which a deleted note does not change.
	 *
	 * Naming that row exactly is not a detail: an earlier draft of this Notice
	 * pointed at "Start over", which is the confirm button inside the repair
	 * flow and not a settings row at all. A message that sends someone hunting
	 * for a control that does not exist is worse than one that says nothing.
	 */
	private onIndexNoteDeleted(): void {
		if (this.index.size === 0) return;
		new Notice(
			`Explorer order editor: ${this.notePath()} was deleted, but its saved orders are still loaded and it will be recreated on the next change. ` +
				'Use "Clear every saved order" in settings to clear them for good.',
		);
	}

	/**
	 * Reads and parses the index note. Must be awaited in `onload`, before
	 * `onLayoutReady`: `get` is synchronous because `getSortedFolderItems`
	 * is, so if the index isn't in memory by the time the file explorer
	 * first renders, folders paint in default order and then visibly snap
	 * once this resolves. One small file read on the load path is the price
	 * of never showing that.
	 *
	 * A note that is simply absent resolves to a usable, empty index: nobody
	 * has saved an order yet, or the user deleted the note to start over, and
	 * neither is a fault. `status: 'empty'` is subtler — see `applyParsed`.
	 */
	async load(): Promise<void> {
		const path = this.notePath();
		const text = await this.readNote(path);
		if (text === null) {
			// Genuinely absent, confirmed against the filesystem — not merely
			// missing from a `Vault` index that may not be built yet. See
			// `readNote`.
			this.index = new Map();
			// No note, so nothing has proved a block is at this path — and the
			// absence is not itself proof of the opposite either, which is why
			// this is `false` rather than a reset.
			this.markUsable(false);
			return;
		}
		const result = parseIndex(text);
		// The backup is only consulted for the one judgment `applyParsed`
		// cannot make on its own at startup, where nothing is loaded yet: is
		// "this note has no json block" a fresh note, or a note whose block was
		// destroyed? Read only when that question actually arises.
		const hadBlockBefore = result.status === 'empty' ? await this.backupSuggestsBlock() : false;
		this.applyParsed(result, text, hadBlockBefore);
	}

	/**
	 * The index note's text, or `null` only when the note genuinely is not
	 * there.
	 *
	 * `vault.getFileByPath` answers from the `Vault`'s in-memory file map, and
	 * **that map is not populated yet while `onload` runs during a cold app
	 * start**. `load()` used to treat its `null` as "no note has been written
	 * yet", which on every cold start produced an empty index that reported
	 * itself perfectly healthy: no orders rendered, no repair row, nothing in
	 * the console — and the next write would then have persisted that emptiness
	 * over a note that still held every order. Reported as issue #1, and
	 * invisible to every hand test this project ever ran, because reloading the
	 * plugin from the settings toggle or via hot-reload re-enters `onload` at a
	 * point where the map *is* built. Only quitting and reopening Obsidian
	 * reaches the broken path.
	 *
	 * So a `null` from the file map is not evidence of absence: it is checked
	 * against the vault adapter, which reads the filesystem directly and needs
	 * no index. `cachedRead` is still preferred when the map does have the
	 * file, since that is the warm path and shares Obsidian's own cache.
	 *
	 * `fresh` opts out of that cache, for the one caller whose read has to
	 * agree with a write: `Vault.process` re-reads the file itself, so a plan
	 * made from a cached copy can be compared against bytes it never saw. The
	 * cache is invalidated by Obsidian's own `modify` event, and the state
	 * `quarantineThenRebuild` exists for — a sync client having just replaced
	 * the note — is exactly the state where that event has not fired yet. Every
	 * attempt would then plan from text that is no longer there, find
	 * `data !== expected`, and quarantine a copy of it for its trouble; three
	 * rounds of that reports "the attempt itself failed" about a note that was
	 * never touched. The adapter branch below needs no equivalent: it already
	 * reads the filesystem.
	 */
	private async readNote(path: string, fresh = false): Promise<string | null> {
		const file = this.host.app.vault.getFileByPath(path);
		if (file !== null) return fresh ? this.host.app.vault.read(file) : this.host.app.vault.cachedRead(file);

		const { adapter } = this.host.app.vault;
		if (!(await adapter.exists(path))) return null;
		return adapter.read(path);
	}

	/**
	 * `status: 'empty'` — the note exists but holds no ```json block — is
	 * ambiguous, and the two readings need opposite handling.
	 *
	 * Read one, benign: nothing has ever been written here. Usable, empty.
	 *
	 * Read two, a corruption this plugin used to miss entirely: the block was
	 * there and something destroyed it — the fence line deleted by a bad hand
	 * edit, a sync client landing a truncated copy. Treating that as "no
	 * orders yet" is the worst outcome available: every saved order silently
	 * disappears, the store reports itself perfectly healthy, no repair is
	 * offered, and the next write appends a fresh empty block as if nothing
	 * had been there.
	 *
	 * The two are distinguishable, and not by heuristic: this plugin only ever
	 * writes a note *with* a block, so either a non-empty in-memory index or a
	 * non-empty backup is proof a block existed at this path. Either one turns
	 * `empty` into the same unusable state a parse failure produces, which is
	 * what routes it to `salvageIndex` and the repair path — and salvage reads
	 * whatever survived, fence or no fence.
	 *
	 * `hadBlockBefore` is required, not defaulted, for the reason `markUsable`'s
	 * argument is: both callers have just learned something about this path's
	 * history, and a default would let a third caller not answer.
	 */
	private applyParsed(result: ParseResult, text: string, hadBlockBefore: boolean): void {
		if (result.status === 'invalid') {
			// Proof, not optimism: `parseIndex` reaches `invalid` only once
			// `findJsonBlock` has located a fence — a note with no fence at all
			// comes back `empty`. So a block is at this path; it is the content
			// that cannot be read.
			this.markUnusable(result.reason, text, true);
			return;
		}
		if (result.status === 'empty' && (this.index.size > 0 || hadBlockBefore)) {
			// The condition on this branch *is* the proof: a non-empty in-memory
			// index or a witness from before means a block existed here, which
			// is the whole reason a missing one is damage rather than a blank
			// slate.
			this.markUnusable(MISSING_BLOCK_REASON, text, true);
			return;
		}
		// A good parse arriving while this store's own debounced write is still
		// armed. `this.index` holds a change the note does not yet, so adopting
		// the disk copy would discard the user's reorder from memory — and then
		// the armed timer would persist the replacement, taking it off disk as
		// well. Gone from screen, memory and note, with `isUsable()` still true
		// and nothing logged: the failure mode this whole file is organized
		// against.
		//
		// The same hazard `quarantineThenRebuild` already guards before its
		// fresh read, with the same answer — what is in memory is newer.
		// Nothing on the note is lost by keeping it: the armed write serializes
		// the entire block from `this.index` regardless, so whatever landed here
		// was going to be replaced the moment the debounce fired.
		//
		// `load()` reaches this too and is unaffected: no write can be armed
		// before the first `update()`.
		if (result.status === 'ok' && this.writeTimerId !== null) {
			this.markUsable(true);
			return;
		}
		// A read that parses is proof a block is really there, and it counts even
		// when the block parsed to an empty index: what matters later is that a
		// fence existed at this path, not what was inside it.
		this.index = result.status === 'ok' ? result.index : new Map();
		this.markUsable(result.status === 'ok');
	}

	/**
	 * Synchronous `Map` lookup — the file explorer's hot path. No I/O, no
	 * parsing. Returns whatever the in-memory index currently holds
	 * regardless of `isUsable()`: going unusable only means further writes
	 * are refused, not that the last successfully parsed order should stop
	 * being shown.
	 */
	get(folderPath: string): readonly string[] | undefined {
		return this.index.get(folderPath);
	}

	/**
	 * Every folder key the index currently holds an order for. Synchronous
	 * and cheap, like `get()` — used by the settings tab's "Remove orders for
	 * missing folders" row to find which keys have no corresponding folder in
	 * the vault any more (`pruneMissing`, `orderIndex.ts`); `get()`'s
	 * per-key lookup has no way to enumerate what's stored.
	 */
	keys(): ReadonlySet<string> {
		return new Set(this.index.keys());
	}

	isUsable(): boolean {
		return this.health.usable;
	}

	/**
	 * Applies `mutate` to the in-memory index and, if it actually changed —
	 * every `orderIndex.ts` mutation returns the *same* reference when it
	 * would be a no-op, which is the cheap signal used here — schedules a
	 * debounced write.
	 *
	 * Refuses outright when the store is unusable: writing over a note we
	 * could not parse would mean `serializeIndex` either throws (an
	 * unterminated block) or, worse, silently discards whatever the invalid
	 * content on disk was hiding. The user was already told *why* at the
	 * moment this became unusable (`markUnusable`); this only logs, so a
	 * burst of refused calls (e.g. `orderSync.ts` reacting to a batch of
	 * renames while the note is broken) doesn't also produce a burst of
	 * Notices repeating the same fact.
	 */
	update(mutate: (index: OrderIndex) => OrderIndex): boolean {
		if (!this.health.usable) {
			console.error(`[explorer-order-editor] refusing to update the order index: ${this.notePath()} could not be parsed and is unusable`);
			return false;
		}
		const next = mutate(this.index);
		if (next === this.index) return true;
		this.index = next;
		this.scheduleWrite();
		return true;
	}

	/**
	 * Same contract as `update()`, except that when the store is unusable it
	 * attempts to heal first (`healThenUpdate`) instead of refusing outright.
	 * `mutate` runs against the *recovered* index if healing happens, so the
	 * edit the caller was making lands in the same note write that repairs
	 * it — the action the user asked for actually happens, not just the
	 * repair.
	 *
	 * This is the entry point for every explicit user action it heals on —
	 * `OrderModal.save`, `applyMove`, both branches of `applyDrop`,
	 * `clearOrderFor`, and the settings tab's "Remove orders for missing
	 * folders" and "Clear every saved order" rows — plus, indirectly via
	 * `repair()`, that tab's "Repair the order note" row and the pre-flight
	 * heal the move actions run before they read an order to compute a write
	 * from (`moveItem.ts`'s `orderToWriteFrom`). `orderSync.ts`'s background
	 * rename/delete reactions deliberately keep calling plain `update()`
	 * instead — a rename elsewhere in the vault is not the user asking this
	 * plugin to repair anything, and healing must only ever happen in response
	 * to one that is.
	 *
	 * **`mutate` may run more than once.** When healing happens it runs once
	 * per rebuild attempt, and once more if the note turns out to have healed
	 * itself in the meantime. Only the last call corresponds to what was
	 * actually written, so it must be a function of the index it is handed:
	 * a caller measuring its own edit (`OrderModal.save`'s `changed`,
	 * `runPruneMissing`'s `removed`, `runClearAll`'s `cleared`) has to *assign*
	 * from the argument, never accumulate across calls, or it will report a
	 * number no single write ever produced.
	 */
	async updateOrRepair(mutate: (index: OrderIndex) => OrderIndex): Promise<boolean> {
		if (this.health.usable) return this.update(mutate);
		// Callers of this one only need to know whether their edit landed, so
		// the three-valued outcome collapses here rather than spreading into
		// every move, drop and clear. `repair()` keeps the distinction because
		// the settings tab is the one caller that must act on it.
		return (await this.healThenUpdate(mutate)) === 'healed';
	}

	/**
	 * Attempts to heal without any accompanying edit — the settings tab's
	 * "Repair the order note" row, for the cold-start case
	 * where a bad note left nothing in memory and there is no in-flight edit
	 * to complete alongside the repair, and `moveItem.ts`'s pre-flight heal,
	 * which needs the store readable *before* it reads an order rather than
	 * after. Identical machinery to what `updateOrRepair` runs automatically,
	 * via an identity `mutate` that changes nothing beyond the recovery itself.
	 *
	 * Answers `'healed'` — not `true` — when the store is already usable, and
	 * that is the whole reason the return type is `RepairOutcome` rather than a
	 * boolean: every member of it is a non-empty string, so `if (await
	 * store.repair())` is true for the failures too, silently and with nothing
	 * for tsc to catch. Compare against `'healed'`.
	 */
	async repair(): Promise<RepairOutcome> {
		if (this.health.usable) return 'healed';
		return this.healThenUpdate((index) => index);
	}

	/**
	 * The healing sequence itself, reachable only through
	 * `updateOrRepair`/`repair` and only while the store is unusable — never from
	 * detection (`applyParsed`/`markUnusable`), which must never by itself
	 * change anything on disk.
	 *
	 * 1. Builds the recovered index — a union of the unreadable note's own
	 *    salvageable lines, the in-memory index, the `data.json` backup, and
	 *    the last text a read found unreadable (`recoverIndex`). If that union
	 *    is empty, there is nothing to recover: stops here, touches nothing,
	 *    stays unusable. Destroying
	 *    the only copy of something in order to replace it with an empty one
	 *    is the one outcome that must never happen, so this is the one case
	 *    healing refuses even to try. `startOver` is the explicit, confirmed
	 *    way past that refusal, for the user who would rather have a working
	 *    plugin than a note nothing can read.
	 * 2. Applies `mutate` to the recovered index and hands the result to
	 *    `quarantineThenRebuild`, which preserves the unreadable text beside
	 *    the original before replacing it and makes the store usable again.
	 * 3. Reports success with a Notice naming the quarantine note, so the
	 *    preserved content is findable, and how many lines could not be
	 *    salvaged when that count is above zero.
	 *
	 * A failure at step 2 (quarantine or rebuild I/O) is logged and leaves the
	 * store unusable, and no order is half-written: `this.index` and
	 * the health state are only updated together, after both the quarantine and
	 * the rebuilt note have actually landed.
	 *
	 * What such a failure *can* leave behind is quarantine notes — one per
	 * attempt `quarantineThenRebuild` spent (see its own doc comment on the
	 * loop). That is not a leak to be tidied away silently: each copy holds a
	 * version of the note that really existed at the moment it was taken, which
	 * is strictly more preserved than before the attempt. The settings tab's
	 * "delete the kept copies" row is where they can be removed, and it stays
	 * reachable while the store is unusable precisely so this case has an exit.
	 *
	 * `mutate` may therefore be called more than once — once per attempt, plus
	 * once more on the adopt path below. See `updateOrRepair`'s contract note:
	 * it has to be a function of its argument, and any bookkeeping a caller
	 * does inside it has to be assignment, not accumulation.
	 */
	private async healThenUpdate(mutate: (index: OrderIndex) => OrderIndex): Promise<RepairOutcome> {
		// Unreadable and empty are the same to a recovery *source*; the
		// distinction `readBackup` draws is for `backupSuggestsBlock`.
		const backup = (await this.readBackup()) ?? new Map();
		// Read once, outside the loop, for the same reason `backup` is: neither
		// can change while this runs — nothing between here and the write
		// re-reads the backup, and `lastUnreadableText` only moves when the
		// store's usability does, which ends the loop either way.
		const lastUnreadable = this.health.usable ? '' : this.health.lastUnreadableText;

		try {
			// Recovery is re-derived per attempt, from whatever the note holds
			// at that moment, rather than once from the snapshot taken when it
			// went unusable. A differently-broken version that arrives in
			// between carries its own salvageable lines, and planning from the
			// older text would discard them while claiming to repair.
			const outcome = await this.quarantineThenRebuild(
				(text) => {
					const { index: recovered, droppedLines } = recoverIndex(text, this.index, backup, lastUnreadable);
					if (recovered.size === 0) return null;
					return { index: mutate(recovered), droppedLines };
				},
				// The adopt path's union. Deliberately not `planFor` above: that
				// one calls `mutate`, and `updateOrRepair`'s contract counts
				// those calls — the adopted index gets `mutate` applied once,
				// afterwards, by the `this.update(mutate)` in the `'adopted'`
				// case below.
				(adopted) => fillGapsFrom(adopted, this.index, backup, lastUnreadable),
			);

			const kept = this.keptClause(outcome.copies);

			switch (outcome.kind) {
				case 'nothing-to-recover':
					// Deliberately silent to the user: the settings tab is the
					// caller that acts on this one, and it answers with a dialog
					// offering to start over. A Notice raised underneath that
					// dialog would be talking over it. Copies still go to the
					// console, where the reason already goes.
					console.error(
						`[explorer-order-editor] cannot repair the order index (${this.notePath()}): nothing recoverable in the note, what is loaded, or the last backup` +
							(kept === null ? '' : ` — ${kept}`),
					);
					return 'nothing-to-recover';
				case 'gave-up':
					if (kept !== null) console.error(`[explorer-order-editor] the repair of ${this.notePath()} ended without rebuilding it. ${kept}`);
					return 'failed';
				// Both leave the store usable without this call having written
				// anything, so the edit the caller came for still has to land.
				//
				// Silent when nothing was kept — the note works again and the
				// user asked for an edit, not for a status report. Not silent
				// when something was: an earlier attempt in this same call can
				// have taken a copy before losing the identity check, and a note
				// appearing in somebody's vault with no explanation is the one
				// thing a repair must never do quietly.
				case 'already-usable':
				case 'adopted':
					if (kept !== null) {
						new Notice(`Explorer order editor: ${this.notePath()} became readable on its own, so it was not rebuilt. ${kept}`);
					}
					return this.update(mutate) ? 'healed' : 'failed';
				case 'rebuilt': {
					const lines = [`Explorer order editor: repaired ${this.notePath()}.`];
					if (kept !== null) lines.push(kept);
					if (outcome.droppedLines > 0) {
						lines.push(`${outcome.droppedLines} line${outcome.droppedLines === 1 ? '' : 's'} in it could not be salvaged.`);
					}
					new Notice(lines.join(' '));
					return 'healed';
				}
			}
		} catch (err) {
			console.error('[explorer-order-editor] failed to repair the order index', err);
			return 'failed';
		}
	}

	/**
	 * Replaces the unreadable note with one built from `next`, preserving what
	 * was there first. Shared by `healThenUpdate` and `startOver` so the order
	 * of these five steps is written down once: the quarantine copy lands
	 * *before* the original is touched, and `this.index`/`usable` only move
	 * after both that copy and the rebuilt note have actually been written.
	 *
	 * Plans and writes in a loop, because the note is not held still while any
	 * of this runs. Each attempt reads the note as it is *now*, plans from that
	 * text, quarantines that text, and then writes only if the note still holds
	 * it — `Vault.process`'s change function re-reads, which is the one place
	 * that comparison is atomic against the write it guards.
	 *
	 * Planning from a snapshot taken earlier is what made this necessary. A
	 * sync client can replace a broken note with a *differently* broken one
	 * whose lines are perfectly salvageable, and `usable` does not go true for
	 * it — `applyParsed` marks it unusable again — so no "has someone healed
	 * this?" check can see it. Writing the old plan over it destroyed those
	 * orders, and the quarantine copy held the *older* text, so they survived
	 * nowhere. Quarantining exactly the bytes about to be replaced is the
	 * invariant that fixes it; re-planning from them is what keeps the write
	 * meaningful rather than merely safe.
	 *
	 * `planFor` is therefore called once per attempt, and must be a function of
	 * the text it is handed rather than something that accumulates across
	 * calls — only the attempt that actually writes describes the note
	 * afterwards. It returns `null` for "nothing here is worth recovering",
	 * which only `healThenUpdate` ever says — `startOver` plans an empty index
	 * whatever it finds, since that is precisely what the user confirmed. Note
	 * that it plans from the *newest* text even so, and that text is preserved
	 * before it goes: starting over costs the orders and keeps the bytes.
	 *
	 * Bounded rather than `while (true)`. A note being rewritten faster than
	 * this can read-plan-write is a sync client mid-burst, and spinning on the
	 * vault for the duration would be worse than stopping and saying so. Each
	 * attempt that quarantined something kept a real version, so giving up
	 * leaves more preserved than it started with, never less.
	 *
	 * The cost of that is up to `MAX_REBUILD_ATTEMPTS` copies from one click,
	 * with the store still unusable afterwards. They are deliberately not
	 * cleaned up here — a copy this loop took is the only evidence of a version
	 * that existed, and deciding it is spent is exactly what nothing in this
	 * file may do on its own. It is the settings tab's "delete the kept copies"
	 * row that has to remain reachable in that state, which is why the row is
	 * offered (with different wording) while the store is unusable rather than
	 * only after a successful repair.
	 *
	 * Runs on `writeChain` (`runExclusive`), the same queue `performWrite`
	 * uses: a write that was already scheduled *before* the note went unusable
	 * (armed by an earlier, then-valid `update()`) could still be in flight
	 * when this starts, and without this its `Vault.process` call could
	 * interleave with the rebuild's own — exactly the overlap `writeChain`
	 * exists to prevent.
	 */
	private async quarantineThenRebuild(planFor: (text: string) => RebuildPlan | null, fillGaps: (adopted: OrderIndex) => OrderIndex): Promise<RebuildOutcome> {
		return this.runExclusive(async () => {
			const { app } = this.host;
			const path = this.notePath();
			// Accumulated across attempts and returned on every outcome, because
			// a copy is written before the write that would justify it: an
			// attempt that then loses the identity check ends somewhere other
			// than `'rebuilt'` and its copy is still in the vault. See
			// `RebuildOutcome`.
			const copies: string[] = [];

			for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt++) {
				// Re-checked after taking the chain, not just at entry: two
				// explicit actions can reach here before either has run — a
				// double-click on "Clear explorer order", a save landing while
				// a repair is queued. The first healed everything; the second
				// would otherwise quarantine the same content again and hand
				// the user two "preserved copy" notes for one broken file.
				//
				// Stays here, outside `rebuildStepFor`'s table, because it must
				// run *before* the fresh read below: a store that healed while
				// this was queued can hold in-memory changes a debounced write
				// has not flushed yet, and adopting the disk bytes would replace
				// that newer index with the older note.
				if (this.health.usable) return { kind: 'already-usable', copies };

				// Read past the cache (`fresh`), because this text is what
				// `rebuildNoteFrom` compares against what `Vault.process`
				// re-reads. Planning and writing have to be looking at the same
				// bytes for the identity check to mean anything — see
				// `readNote`. `null` is kept apart from `''` all the way down:
				// `readNote` answers `null` only after the *adapter* says the
				// note is not there, and that is what tells the rebuild whether
				// creating the note is right or catastrophic.
				const current = await this.readNote(path, true);
				const parsed = parseIndex(current ?? '');
				// Only when the parse did not succeed, so `mutate`'s per-attempt
				// call count stays what `updateOrRepair` documents — the adopt
				// path must not spend a call on a plan it will never use.
				const plan = parsed.status === 'ok' ? null : planFor(current ?? '');
				const file = current === null ? null : app.vault.getFileByPath(path);

				// The judgment itself is pure (`rebuildStep.ts`) and enumerated
				// as a table in rebuildStep.test.ts; each branch's reasoning
				// lives on the corresponding `RebuildStep` member.
				const step = rebuildStepFor(parsed, plan, current, file !== null);

				switch (step.kind) {
					// The note fixed itself while this was queued or while a
					// confirmation dialog was open — only what `onExternalModify`
					// was about to do anyway.
					//
					// Through `fillGaps`, not as a straight replacement: this is
					// a recovery path like the rebuild below, and the same union
					// rule applies. Replacing outright discarded memory, the
					// backup (which this then overwrote with the smaller
					// adopted index) and the kept unreadable text in one step,
					// with nothing quarantined — `copies` is empty here — and
					// the store reporting itself healthy afterwards.
					case 'adopt': {
						const adopted = fillGaps(step.index);
						this.index = adopted;
						this.markUsable(true);
						await this.persistBackup(adopted);
						return { kind: 'adopted', copies };
					}
					case 'nothing-to-recover':
						return { kind: 'nothing-to-recover', copies };
					// Reported as `'gave-up'` rather than as its own outcome: the
					// caller's answer is the same either way — the note is
					// unchanged, try again — and the console carries which it was.
					case 'gave-up-unindexed':
						console.error(
							`[explorer-order-editor] cannot repair ${path}: it exists on disk but the vault has not indexed it, ` +
								'so it cannot be replaced atomically. A cold start does this briefly; any path component ' +
								'beginning with a dot does it permanently, since the vault walk skips those subtrees. ' +
								'The note was not changed and no copy was made.',
						);
						return { kind: 'gave-up', copies };
					case 'rebuild': {
						if (step.quarantineFirst) copies.push(await this.quarantineUnreadableNote(current ?? ''));

						if (!(await this.rebuildNoteFrom(step.plan.index, current ?? '', file))) continue;

						this.index = step.plan.index;
						this.markUsable(true);
						await this.persistBackup(step.plan.index);
						return { kind: 'rebuilt', copies, droppedLines: step.plan.droppedLines };
					}
				}
			}

			console.error(
				`[explorer-order-editor] gave up rebuilding ${path}: it kept changing between reading it and writing it`,
			);
			return { kind: 'gave-up', copies };
		});
	}

	/**
	 * The deliberate way out of the one state `healThenUpdate` refuses to act
	 * on: the note is unreadable and the note, the loaded index and the backup
	 * between them hold nothing to recover. That refusal is right as an
	 * automatic policy — replacing the only copy of something with an empty
	 * one is the outcome that must never happen on its own — but it leaves the
	 * user with a plugin that cannot write and no action inside it that
	 * changes that. This is that action, and it is reachable only from an
	 * explicit confirmed click in the settings tab.
	 *
	 * What makes overriding the policy safe is that nothing is actually
	 * destroyed: `quarantineThenRebuild` writes the unreadable content to its
	 * own note before the original is touched, so "start over" costs the saved
	 * orders but keeps every byte that held them.
	 *
	 * Returns `true` when the store is usable afterwards — including the case
	 * where something else healed it first, which is not a failure and must
	 * not be followed by a wipe.
	 */
	async startOver(): Promise<boolean> {
		// Reported, not silently accepted, and this is the *likely* way to get
		// here rather than an edge: repair answers "nothing to recover", the
		// confirmation dialog stays open for as long as it takes to read it, a
		// readable copy lands in that window and `onExternalModify` adopts it.
		// The caller only asks the file explorer to re-sort, so without this the
		// user who just agreed to lose every saved order gets no answer at all —
		// the same silence the branch further down exists to prevent, reached by
		// the wider path.
		if (this.health.usable) {
			// Empty, and provably so: this returns before `quarantineThenRebuild`
			// is entered, so no copy of anything can have been taken yet.
			this.reportNothingCleared([]);
			return true;
		}

		try {
			// Plans an empty index whatever the note turns out to hold, which
			// is exactly what was confirmed — but the loop still re-reads, so
			// the text actually being replaced is the text that gets preserved.
			// A newer, differently-broken version arriving while the dialog was
			// open is kept as its own copy rather than being written over on
			// the strength of a snapshot from before it existed.
			const outcome = await this.quarantineThenRebuild(
				() => ({ index: new Map(), droppedLines: 0 }),
				// Identity, where `healThenUpdate` unions: this is the one
				// caller with nothing it wants back. The user confirmed
				// starting over, so resurrecting keys from memory or the backup
				// into a note that healed itself would be undoing the request.
				// Adopting is reported as "nothing was cleared" either way.
				(adopted) => adopted,
			);

			const kept = this.keptClause(outcome.copies);

			switch (outcome.kind) {
				case 'gave-up':
					if (kept !== null) console.error(`[explorer-order-editor] starting over on ${this.notePath()} ended without rebuilding it. ${kept}`);
					return false;
				// `planFor` above never returns `null`, so recovery can never
				// be the reason this stopped. Handled rather than assumed away:
				// the compiler asks for it, and an unhandled member later
				// would otherwise become a silent `true`.
				case 'nothing-to-recover':
					return false;
				// A confirmed destructive action that quietly did nothing is
				// its own kind of failure to report: the orders are back, and
				// somebody who just agreed to lose them needs telling that they
				// did not.
				case 'already-usable':
				case 'adopted':
					this.reportNothingCleared(outcome.copies);
					return true;
				case 'rebuilt': {
					const lines = [`Explorer order editor: ${this.notePath()} was rebuilt with no saved orders.`];
					if (kept !== null) lines.push(kept);
					new Notice(lines.join(' '));
					return true;
				}
			}
		} catch (err) {
			console.error('[explorer-order-editor] failed to start over with an empty order index', err);
			return false;
		}
	}

	/**
	 * The one sentence "start over" must never leave unsaid: it ended without
	 * clearing anything.
	 *
	 * Shared by the two places that can reach that ending — the guard at the
	 * top of `startOver` and the adopt/already-usable branch inside it — which
	 * is the whole reason it is a method. The wording lived only in the branch
	 * before, and the branch is the narrow window (between taking the write
	 * chain and reading the note); the guard is the wide one, and it returned
	 * `true` in silence.
	 *
	 * `copies` is required rather than defaulted, for the same reason
	 * `markUsable`'s argument is: the two callers know different things — the
	 * guard runs before anything could have been written, the branch runs after
	 * attempts that may have kept something — and a default would let the
	 * branch quietly inherit the guard's answer.
	 */
	private reportNothingCleared(copies: readonly string[]): void {
		const kept = this.keptClause(copies);
		new Notice(
			`Explorer order editor: ${this.notePath()} became readable again before starting over, so nothing was cleared.` +
				(kept === null ? '' : ` ${kept}`),
		);
	}

	/**
	 * Names every quarantine copy one repair produced, or `null` when it
	 * produced none — the sentence every reporting path appends, written once so
	 * the singular/plural and the quoting cannot drift between them.
	 *
	 * `null` rather than `''` so a caller building a list of sentences has to
	 * decide, rather than pushing an empty string and shipping a double space.
	 */
	private keptClause(copies: readonly string[]): string | null {
		if (copies.length === 0) return null;
		const named = copies.map((path) => `"${path}"`).join(', ');
		return copies.length === 1 ? `The unreadable copy was kept as ${named}.` : `The unreadable copies were kept as ${named}.`;
	}

	/**
	 * Runs `fn` as the next link on `writeChain`, after whatever is already
	 * queued (a pending debounced write, a previous call to this same
	 * method) finishes, and returns its result. Unlike `enqueueWrite`
	 * (fire-and-forget, errors swallowed into a log line because nothing is
	 * waiting on a specific write landing), this hands `fn`'s outcome back to
	 * its caller — `healThenUpdate` needs to know whether the quarantine and
	 * rebuild it just queued actually succeeded. The chain itself is still
	 * kept always-resolved afterwards (mirroring `orderSync.ts`'s own
	 * `enqueue`), so a failure here can never poison a write queued after it.
	 */
	private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.writeChain.then(fn);
		this.writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Copies `text` (the unreadable note's own content) to a sibling
	 * "quarantine" note before anything about the original is touched —
	 * `vault.create` never overwrites, and `findFreeQuarantinePath` (pure,
	 * `quarantine.ts`) keeps adjusting the name until one is free, so an
	 * existing quarantine note (a previous failed heal, another device) is
	 * never clobbered either. Returns the path used, for the Notice.
	 *
	 * `isTaken` asks the `Vault` file map, and that is a knowing exception to
	 * the rule the rest of this file follows (a `null` from the map is not
	 * evidence of absence — see `readNote`). It is safe *here* only because
	 * being wrong is not destructive: `create` checks the filesystem itself and
	 * throws rather than overwriting, the retry below re-asks, and a name that
	 * still collides gives up with the error rather than clobbering the file it
	 * collided with. Making the predicate async to reach the adapter would push
	 * `findFreeQuarantinePath` — pure, and tested as such — into promises for a
	 * case that cannot lose data.
	 */
	private async quarantineUnreadableNote(text: string): Promise<string> {
		const { app } = this.host;
		const isTaken = (path: string): boolean => app.vault.getAbstractFileByPath(path) !== null;

		let path = findFreeQuarantinePath(this.notePath(), new Date(), isTaken);
		// Bounded, not `for(;;)`. The timestamp is minute-granular, so a retry
		// inside the same minute lands on the same name and the `retry === path`
		// check below rethrows — but a `create` that keeps failing for a reason
		// that has nothing to do with the name (an unwritable parent, a full
		// disk) produces a *different* name every time the clock ticks over,
		// and an unbounded loop would then spin on vault I/O indefinitely. A
		// handful of attempts covers every real collision; past that, the
		// failure is not about the name.
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				await app.vault.create(path, text);
				return path;
			} catch (err) {
				// Something claimed `path` between the check and `create` (e.g.
				// two heals in quick succession). Ask again with a fresh
				// predicate; if that still lands on the same path, `create` is
				// failing for some other reason and retrying won't help.
				const retry = findFreeQuarantinePath(this.notePath(), new Date(), isTaken);
				if (retry === path) throw err;
				path = retry;
			}
		}
		throw new Error(`Could not create a quarantine note beside ${this.notePath()} after several attempts`);
	}

	/**
	 * Rebuilds the index note from `index`, replacing whatever unreadable
	 * content is currently on disk — safe to do unconditionally by this
	 * point, since `healThenUpdate` has already preserved that content in
	 * the quarantine note. Goes through `Vault.process` with a change
	 * function, same as `performWrite`, so this is a true read-modify-write
	 * rather than a blind overwrite of possibly-stale content.
	 *
	 * `serializeIndex` still throws for the one case it always refuses — an
	 * opened-but-never-closed json fence, whose extent can't be determined —
	 * so that's caught here and treated as "no existing block to preserve
	 * around," same as an empty note. Nothing is lost by falling back: the
	 * original text this is replacing is already safe in the quarantine
	 * note.
	 *
	 * `file` is passed in rather than looked up here, and that is what makes
	 * the `null` branch below safe. Its caller resolved it against a read that
	 * had already asked the *adapter* whether the note exists, so `null` here
	 * means "proven absent" and nothing else — where a lookup at this point
	 * would also return `null` for a note that is on disk but unindexed, and
	 * creating over that throws after a copy has been taken. See the caller.
	 */
	private async rebuildNoteFrom(index: OrderIndex, expected: string, file: TFile | null): Promise<boolean> {
		const { app } = this.host;

		if (file === null) {
			// The note vanished between going unusable and this heal (e.g.
			// deleted externally in the meantime). Same as any other first write.
			const text = serializeIndex('', index);
			this.lastWrittenText = text;
			await app.vault.create(this.notePath(), text);
			return true;
		}

		let wrote = false;
		await app.vault.process(file, (data) => {
			// One condition, and it is deliberately identity rather than
			// anything cleverer: write only if the note still holds the exact
			// text the caller planned from and has already preserved.
			//
			// `Vault.process` re-reads here, which makes this the only place
			// the comparison is atomic against the write it guards. Everything
			// else — `usable`, a parse of the note, the snapshot taken when it
			// was last found unreadable — can be stale by the time the write
			// lands.
			//
			// Judging the *content* instead was the earlier mistake. Refusing
			// only when the note had become readable let a differently-broken
			// version through, and its salvageable lines were replaced by a
			// plan derived from text that no longer existed, while the
			// quarantine copy preserved that older text rather than the one
			// being destroyed. Identity cannot make that distinction wrong,
			// because it does not make a distinction: anything but the bytes
			// that were preserved is somebody else's write, and the caller
			// re-reads and re-plans around it.
			if (data !== expected) return data; // unchanged

			let text: string;
			try {
				text = serializeIndex(data, index);
			} catch {
				text = serializeIndex('', index);
			}
			this.lastWrittenText = text;
			wrote = true;
			return text;
		});
		return wrote;
	}

	/**
	 * Persists a copy of `index` into this plugin's own `data.json`, alongside
	 * the settings, through `host.updateData` — which is the only reason this
	 * does not fight `main.ts`'s `saveSettings()` over the file.
	 *
	 * Both used to run their own `loadData` → `saveData` pair, each merging
	 * into what it had read. Merging prevents a *blind* overwrite and nothing
	 * else: with no shared lock, a settings toggle clicked while a backup
	 * write was in flight had both cycles holding the same snapshot, and
	 * whichever wrote second reverted the other. In one direction that costs
	 * a backup generation — the third source in `recoverIndex`, and the
	 * `hadBlockBefore` witness — which only ever surfaces later, as orders
	 * that "could not be recovered". In the other it costs the toggle, which
	 * looks correct in `this.plugin.settings` and in the settings tab until
	 * the next restart.
	 *
	 * Serialized with `orderIndex.ts`'s own `serializeIndex` against an empty
	 * starting note — there is no second encoding here, just the note-text
	 * format stored as a string instead of written to a file.
	 *
	 * Never a source of truth on its own (see `readBackup`) — best-effort:
	 * failures are logged, not surfaced, since losing a backup write changes
	 * nothing the user can see until a future heal needs it, and even then
	 * it is only ever the lowest-precedence source in `recoverIndex`.
	 */
	private async persistBackup(index: OrderIndex): Promise<void> {
		try {
			const text = serializeIndex('', index);
			await this.host.updateData((data) => ({ ...data, [INDEX_BACKUP_KEY]: text }));
		} catch (err) {
			console.error('[explorer-order-editor] failed to back up the order index to data.json', err);
		}
	}

	/**
	 * Reads the `data.json` backup as a *recovery source*: an empty index for
	 * anything short of a cleanly parsed backup (missing, wrong shape,
	 * corrupt), and `null` for the one case that is not an answer at all —
	 * `loadData()` itself threw, so nothing is known about what is stored.
	 *
	 * Never called from `load()` with the note absent. That asymmetry is
	 * deliberate: a missing index note means the user removed it to start over
	 * and must not have its content resurrected from a backup; only a note
	 * that *exists but does not parse* is eligible for recovery at all.
	 *
	 * The `null` exists because this answers two different questions.
	 * `recoverIndex` wants a source, and "unreadable" and "empty" are the same
	 * to it. `backupSuggestsBlock` below wants *evidence*, and there they are
	 * opposites: an empty result is positive evidence that no block was ever
	 * written at this path, and a caught exception is no evidence at all.
	 * Collapsing the two let a transient `loadData` failure be read as proof
	 * of a fresh start, which is the one verdict the write path must never
	 * reach by accident.
	 */
	private async readBackup(): Promise<OrderIndex | null> {
		try {
			const data = (await this.host.loadData()) as Record<string, unknown> | null;
			const text = data?.[INDEX_BACKUP_KEY];
			if (typeof text !== 'string') return new Map();
			const parsed = parseIndex(text);
			return parsed.status === 'ok' ? parsed.index : new Map();
		} catch (err) {
			console.error('[explorer-order-editor] failed to read the order index backup from data.json', err);
			return null;
		}
	}

	/**
	 * Whether the backup is evidence that a json block was once written at
	 * this path — with "could not be read" answering **yes**.
	 *
	 * The two mistakes here are not symmetric, which is the whole reason this
	 * is a named rule rather than `.size > 0` written out at each of its three
	 * call sites. A wrong `true` refuses a write and routes the user to the
	 * repair path, where the order is still on disk and still recoverable. A
	 * wrong `false` lets `performWrite` append a fresh block over a note that
	 * held every saved order in the vault, and `lastWrittenText` then makes
	 * the resulting `modify` look like our own write, so nothing detects it.
	 */
	private async backupSuggestsBlock(): Promise<boolean> {
		const backup = await this.readBackup();
		return backup === null || backup.size > 0;
	}

	/**
	 * Why the store is unusable, for a caller that needs to tell the user
	 * *now* rather than rely on the one Notice shown when it first happened.
	 * That Notice fires once per unusable stretch and never repeats
	 * (`madeUnusable`'s `firstNotice`), which is right
	 * for a background failure and wrong for the moment someone presses Save:
	 * the file may have broken long before, and silence at the point of action
	 * reads as "nothing happened" rather than "this was refused".
	 */
	unusableReason(): string | null {
		// No fallback wording: the unusable arm of `StoreHealth` carries its
		// reason structurally, so "unusable but nobody said why" cannot exist.
		return this.health.usable ? null : this.health.reason;
	}

	private scheduleWrite(): void {
		if (this.disposed) return;
		if (this.writeTimerId !== null) window.clearTimeout(this.writeTimerId);
		this.writeTimerId = window.setTimeout(() => {
			this.writeTimerId = null;
			this.enqueueWrite();
		}, WRITE_DEBOUNCE_MS);
	}

	private enqueueWrite(): void {
		this.writeChain = this.writeChain.then(() => this.performWrite());
	}

	/**
	 * Turns an armed debounce into a write on the chain; does nothing when
	 * none is armed.
	 *
	 * One owner, because the two callers run in a fixed order and it is the
	 * unhelpful one. `Component.unload` drains the callbacks handed to
	 * `register()` and only *then* calls `onunload` (verified against
	 * `obsidian.asar` — `obsidian-internals.md`), so the store's teardown
	 * always runs before `main.ts` reaches `flush()`. While the cancel lived
	 * in that teardown alone, `flush()` arrived to find `writeTimerId` already
	 * null, skipped straight to awaiting an unchanged chain, and a reorder
	 * made within the debounce window of quitting or disabling the plugin was
	 * lost from disk entirely — the exact case both `flush()` and
	 * `performWrite`'s `disposed` comment exist to cover.
	 */
	private commitPendingWrite(): void {
		if (this.writeTimerId === null) return;
		window.clearTimeout(this.writeTimerId);
		this.writeTimerId = null;
		this.enqueueWrite();
	}

	/**
	 * Performs any pending write now, and waits for one already in flight.
	 * Callers that need a write to have actually landed (rather than merely
	 * be reflected in memory, which `update()` already guarantees
	 * synchronously) await this.
	 */
	async flush(): Promise<void> {
		this.commitPendingWrite();
		await this.writeChain;
	}

	/**
	 * Re-arms the debounce so `performWrite` can try again once the vault has
	 * indexed a note it can already see on disk.
	 *
	 * Bounded, and not out of superstition: `indexPath` can name something
	 * Obsidian will never index, and then `getFileByPath` stays null while
	 * `adapter.exists` stays true, forever. The reachable case is a path with a
	 * dot-prefixed component — `.obsidian/order.md`, say. Obsidian's vault walk
	 * tests every component with a "starts with a dot" predicate and skips the
	 * whole subtree, while the adapter reads it perfectly well.
	 *
	 * Not the backslash filename this comment used to name: `normalizePath` is
	 * `path.replace(/([\\/])+/g, '/')` before anything else it does, so a
	 * backslash in `indexPath` becomes a directory separator and `notePath()`
	 * can never carry one. Such files do exist and Obsidian really does refuse
	 * to index them (`docs/dev/obsidian-internals.md`) — they simply cannot be
	 * *this* note.
	 *
	 * Unbounded retries would spin a timer for the life of the session. The
	 * counter resets on every successful write, so an ordinary startup gap (a
	 * few hundred milliseconds at most) never approaches the limit, and a
	 * permanent one says so once and stops.
	 */
	private awaitIndexing(): void {
		this.indexingRetries += 1;
		if (this.indexingRetries > MAX_INDEXING_RETRIES) {
			console.error(
				`[explorer-order-editor] ${this.notePath()} exists on disk but the vault never indexed it, so the order could not be written. ` +
					'A path component beginning with a dot does this permanently — the vault walk skips those subtrees.',
			);
			return;
		}
		this.scheduleWrite();
	}

	/**
	 * The actual `Vault.process`/`vault.create` write. Never throws: an
	 * unexpected I/O error is logged and handed to `retryFailedWrite`, which
	 * re-arms the debounce a bounded number of times and then tells the user
	 * the change is not on disk. `this.index` holds it in memory throughout,
	 * so nothing the caller already did is undone.
	 *
	 * Which is worth stating precisely, because this comment used to claim
	 * "only the persistence of it is delayed" while nothing existed to delay
	 * it to: the catch logged and stopped, and the order lived in memory
	 * alone until the next restart silently loaded a note without it.
	 */
	private async performWrite(): Promise<void> {
		// Deliberately NOT guarded on `disposed`. A change made moments before
		// the plugin is disabled or reloaded still has to land, and by the time
		// it does `disposed` is always already true: `Component.unload` drains
		// the `register()` callbacks before calling `onunload`, so the store's
		// teardown has run long before `main.ts` reaches `flush()`. That
		// teardown is itself what puts this write on the chain
		// (`commitPendingWrite`), so bailing on `disposed` here would drop the
		// write in exactly the case it exists for. Writing a change the user already
		// made, a moment later than expected, is harmless; losing it is not.
		// `disposed` still stops new debounce timers being armed
		// (`scheduleWrite`) and stops reacting to external edits
		// (`onExternalModify`), which is all it is for.
		if (!this.health.usable) return;
		const { app } = this.host;
		const path = this.notePath();

		try {
			const existing = app.vault.getFileByPath(path);
			if (existing === null) {
				// Same trap `readNote` documents, on the write side: a `null`
				// here can mean "not indexed yet" rather than "not there". The
				// consequence is milder — `Vault.create` checks the filesystem
				// itself and throws "File already exists." rather than
				// overwriting, so the note is never in danger — but the write
				// would be lost to a caught exception while the in-memory index
				// still shows the change, so the UI would look correct until the
				// next restart.
				//
				// Waiting is the right response, not writing through the
				// adapter: `Vault.process` is what makes this a real atomic
				// read-modify-write, and skipping it to dodge a transient
				// indexing gap would trade a delay for a class of lost
				// concurrent edit.
				if (await app.vault.adapter.exists(path)) {
					this.awaitIndexing();
					return;
				}
				const text = serializeIndex('', this.index);
				this.lastWrittenText = text;
				await app.vault.create(path, text);
				this.indexingRetries = 0;
				this.writeRetries = 0;
				await this.persistBackup(this.index);
				return;
			}

			// The `empty` half of the judgment below needs the same evidence
			// `applyParsed` uses, and `Vault.process`'s change function is
			// synchronous — so the one await it depends on happens here, before
			// the process call rather than inside it.
			//
			// The evidence is deliberately about the *note*, never about the
			// in-memory index — see `sawBlock`'s doc comment for the regression
			// that distinction cost. Both cheap terms are tried first, so the
			// ordinary write path (which is what runs after every reorder, and
			// has written this note at least once by definition) keeps costing
			// zero extra `data.json` reads.
			const blockWasStored = this.health.sawBlock || this.lastWrittenText !== null || (await this.backupSuggestsBlock());

			let becameUnusable: string | null = null;
			// The text the refusal below was decided against, kept for the same
			// reason `markUnusable`'s other callers pass theirs: it is the only
			// copy of a note that may be gone by the time anyone repairs.
			let refusedText = '';
			await app.vault.process(existing, (data) => {
				// The disk may have changed since `load()` (or since the last
				// write) — a sync client could have landed a corrupt or
				// half-written copy in between. Checking here, inside the
				// change function, against the text `Vault.process` just
				// re-read, is the entire reason `orderIndex.ts` distinguishes
				// `invalid` from `empty`: it lets this refuse to overwrite
				// content we can't prove is safe to replace, rather than
				// clobbering whatever the invalid state was hiding. This is
				// detection only (see the module doc comment) — it does not
				// heal on the spot, only records what was found so a later
				// explicit `updateOrRepair`/`repair` call can.
				const parsed = parseIndex(data);
				if (parsed.status === 'invalid') {
					becameUnusable = parsed.reason;
					refusedText = data;
					return data; // unchanged
				}
				// `empty` is the other half of that distinction, and it has to
				// be refused here for the same reason `applyParsed` refuses it:
				// the block vanishing from a note that provably held one is a
				// change to be quarantined and repaired, not a blank slate to
				// append to. Without this, `serializeIndex` takes the `none`
				// branch and re-appends a block built from the in-memory index —
				// silently reverting whatever removed it (a sync client landing
				// another device's "Clear every saved order", say) and, because
				// `lastWrittenText` is set below, making `onExternalModify`
				// dismiss the resulting event as our own write, so the repair
				// path is never entered at all.
				if (parsed.status === 'empty' && blockWasStored) {
					becameUnusable = MISSING_BLOCK_REASON;
					refusedText = data;
					return data; // unchanged
				}
				const next = serializeIndex(data, this.index);
				// Set inside the callback — synchronous, and guaranteed to run
				// before the write this callback's return value produces
				// actually lands — so the `modify` listener below can never
				// observe our own write before this is already in place.
				this.lastWrittenText = next;
				return next;
			});

			if (becameUnusable !== null) {
				// Only reachable via `blockWasStored`, which is the evidence.
				this.markUnusable(becameUnusable, refusedText, true);
			} else {
				this.indexingRetries = 0;
				this.writeRetries = 0;
				await this.persistBackup(this.index);
			}
		} catch (err) {
			console.error('[explorer-order-editor] failed to write the order index', err);
			this.retryFailedWrite();
		}
	}

	/**
	 * Re-arms the debounce after a write threw, and tells the user once the
	 * retries are spent.
	 *
	 * Without this the catch above was the end of the story: nothing re-armed
	 * `scheduleWrite` (only `update()` and `awaitIndexing` do), so the order
	 * lived on in `this.index` and nowhere else. `persistBackup` never runs on
	 * this path either, so not even the backup held it. Meanwhile the caller
	 * had already said "Explorer order saved." — `update()` returns `true`
	 * synchronously, which is the whole point of the debounce — and the next
	 * restart would `load()` an index that had quietly lost the change. That
	 * gap is what made the doc comment on `performWrite` false when it said
	 * only the *persistence* was delayed: nothing was delaying it.
	 *
	 * Bounded, and low. `awaitIndexing` retries 25 times because it is waiting
	 * for something that genuinely does resolve on its own (the vault
	 * finishing its walk). A `Vault.process` that throws is a deleted note, a
	 * lock, a full disk or a permission problem — none of which a fourth
	 * attempt 200ms later is likely to fix, and each attempt re-reads and
	 * re-writes the note.
	 *
	 * The Notice is the point of the whole function, and it is deliberately
	 * not silent-with-a-console-line like `persistBackup`'s failure: this one
	 * contradicts something the user was already told.
	 */
	private retryFailedWrite(): void {
		this.writeRetries += 1;
		if (this.writeRetries <= MAX_WRITE_RETRIES) {
			this.scheduleWrite();
			return;
		}
		this.writeRetries = 0;
		new Notice(
			`Explorer order editor: could not write ${this.notePath()}, so the last order change is not saved. ` +
				'It is still applied in this session — reorder something again once the problem is fixed, or check the console for the error.',
		);
	}

	/**
	 * Fires on every change to the index note, including our own writes —
	 * `lastWrittenText` is how those are told apart, compared against the
	 * exact text just read rather than re-derived, since a byte-identical
	 * external edit is harmless to treat as "ours" either way. A genuine
	 * external change (another device, a manual edit) is re-parsed and, if
	 * usable, replaces the in-memory index and asks the file explorer to
	 * redraw with it; an invalid one marks the store unusable, same as a
	 * failed load.
	 */
	private async onExternalModify(file: TFile): Promise<void> {
		if (this.disposed) return;
		const text = await this.host.app.vault.cachedRead(file);
		if (text === this.lastWrittenText) return;
		const result = parseIndex(text);
		// Same question `load()` asks, and for the same reason: "no json block"
		// is only benign if nothing was ever stored here. The in-memory index
		// answers that on its own most of the time, but not when it is
		// legitimately empty — a vault that has saved no order yet, or one just
		// after "Clear every saved order" — and that is exactly when a sync
		// client landing a block-less copy of a note that *did* hold orders
		// would otherwise be accepted as normal. The backup is the other half of
		// the proof, so this path consults it too.
		const hadBlockBefore = result.status === 'empty' ? await this.backupSuggestsBlock() : false;
		this.applyParsed(result, text, hadBlockBefore);
		requestFileExplorerResort(this.host.app);
	}

	/**
	 * Detection only — never writes, never heals (see the module doc
	 * comment).
	 *
	 * The kept text's role — last-resort recovery source, never a plan — and
	 * its one-stretch lifetime are `storeHealth.ts`'s contract; what this
	 * wrapper adds is the store's side effects. Every caller has the judged
	 * text in hand already, which is why it is a parameter rather than another
	 * read.
	 *
	 * Also cancels any debounced write still armed from before this ran: it
	 * would only find the store unusable and no-op when it fired anyway
	 * (`performWrite`'s own guard), but not scheduling it at all means one
	 * fewer thing that could still be pending if a heal starts before it
	 * would have fired.
	 */
	private markUnusable(reason: string, text: string, blockProven: boolean): void {
		const { health, firstNotice } = madeUnusable(this.health, reason, text, blockProven);
		this.health = health;
		if (this.writeTimerId !== null) {
			window.clearTimeout(this.writeTimerId);
			this.writeTimerId = null;
		}
		const path = this.notePath();
		console.error(`[explorer-order-editor] the order index (${path}) is unusable: ${reason}`);
		// One Notice per unusable stretch — `madeUnusable` decides, so a burst
		// of failed reads of the same broken note tells the user once.
		if (!firstNotice) return;
		new Notice(
			`Explorer order editor: ${path} could not be read (${reason}). Saved folder orders are unavailable until this is repaired — ` +
				'use "Repair the order note" in settings, or the next save/clear will attempt it automatically.',
		);
	}

	/**
	 * `blockProven` is required, and required for the reason `sawBlock` exists
	 * at all: every path that makes the store usable has just learned something
	 * about whether a json block is really at this path, and one of them used to
	 * arrive here and drop that knowledge on the floor. Reading a note that
	 * parses `ok`, adopting one that healed itself, and rebuilding one
	 * ourselves are all proof; finding no note at all is not. Stickiness and
	 * the structural dropping of the kept unreadable text are `madeUsable`'s
	 * contract (`storeHealth.ts`).
	 */
	private markUsable(blockProven: boolean): void {
		this.health = madeUsable(this.health, blockProven);
	}
}
