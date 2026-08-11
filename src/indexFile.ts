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
 * One of two files that import `obsidian` (`explorerSort.ts` is the other),
 * and deliberately thin for the same reason `sortspecFile.ts` used to be:
 * every judgment that doesn't need the vault — parsing, serializing, the
 * pure mutations themselves — already lives in `orderIndex.ts`.
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
import { App, Notice, normalizePath, Plugin, TFile, TFolder } from 'obsidian';
import { parseIndex, recoverIndex, serializeIndex, type OrderIndex, type ParseResult } from './orderIndex';
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
 */
type RebuildOutcome =
	| { kind: 'rebuilt'; quarantinePath: string | null; droppedLines: number }
	| { kind: 'adopted' }
	| { kind: 'already-usable' }
	| { kind: 'nothing-to-recover' }
	| { kind: 'gave-up' };

/** Milliseconds a burst of `update()` calls is given to settle before the debounced write actually runs. */
const WRITE_DEBOUNCE_MS = 200;
/** See `awaitIndexing`: ~5s of retries at `WRITE_DEBOUNCE_MS` apiece. */
const MAX_INDEXING_RETRIES = 25;

/**
 * Structural slice of `Plugin`, matching `ExplorerSortHost`/`OrderSyncHost`
 * elsewhere — avoids a circular import against `main.ts`.
 */
export interface IndexFileHost extends Plugin {
	settings: ExplorerOrderEditorSettings;
}

/**
 * The key `folder`'s own order is (or would be) stored under in the index.
 * The vault root is keyed `'/'` explicitly, via `isRoot()`, so every caller
 * keys the index the same way without any of them having to know what
 * `TFolder.path` literally returns for the root — a value this codebase has
 * deliberately never depended on (see the same reasoning spelled out in
 * `orderSync.ts`'s rename handling, which compares two resolved folders'
 * `.path` values rather than asserting either). Byte-identical to the old
 * `specFolderKeyFor` in the sortspec.md layer this replaces, so keys carry
 * over unchanged.
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

/**
 * Asks the file explorer to recompute and redraw, the same effect
 * `IndexFileStore`'s own external-change handling needs and every mutation
 * site (`main.ts`, `OrderModal.ts`, `orderSync.ts`) needs after a write:
 * `getSortedFolderItems` isn't re-invoked just because the in-memory index
 * changed underneath it.
 *
 * `requestSort` is not part of Obsidian's public typed API — it lives on the
 * file explorer's own internal view subclass. Declared as its own narrow,
 * independent interface rather than imported from `explorerSort.ts` (which
 * declares the same member for its own reason): `explorerSort.ts` needs the
 * `IndexFileStore` type from this file, so the reverse import this file
 * would need to reuse its interface would be circular. Same precedent
 * `sortspecFile.ts` used to follow for the same member.
 *
 * Returns `false` when there is no file explorer leaf, or its view doesn't
 * expose `requestSort` — never throws.
 */
export function requestFileExplorerResort(app: App): boolean {
	const leaf = app.workspace.getLeavesOfType('file-explorer')[0];
	if (leaf === undefined) return false;
	const view = leaf.view as Partial<FileExplorerViewLike>;
	if (typeof view.requestSort !== 'function') return false;
	view.requestSort();
	return true;
}

export class IndexFileStore {
	private index: OrderIndex = new Map();
	private usable = true;
	/** Guards against a Notice per refused `update()` call while unusable — the user was already told once, at the moment this became true. */
	private noticeShown = false;
	/** Why the store went unusable, kept so `unusableReason` can name it at the moment of a refused action. */
	private reason: string | null = null;
	/**
	 * Whether a json block has ever actually been seen at this path — set when
	 * a read parses as `ok`, which is the only positive evidence a read can
	 * give. Together with `lastWrittenText` (non-null exactly when this store
	 * has written a note, and every note it writes has a block) it is what
	 * `performWrite` may treat as proof that a block-less note lost one.
	 *
	 * The in-memory index is emphatically *not* that proof on the write side,
	 * however well it serves as proof on the read side. `applyParsed` runs
	 * after a read, where a non-empty index can only have come from the note;
	 * `performWrite` runs after the user's edit has already been applied to
	 * that index, so it is non-empty because somebody just ordered a folder.
	 * Reading it as evidence there refused the first write into an existing
	 * note that never had a block, left the order unwritten and marked the
	 * store unusable — silently, since nothing throws and the note looks
	 * untouched.
	 */
	private sawBlock = false;
	/** The exact text this store itself last wrote, so the `modify` listener below can tell its own write apart from an external one. `null` until the first write. */
	private lastWrittenText: string | null = null;
	/**
	 * The text of the last read that came back unreadable, kept only for as
	 * long as the store stays unusable (`markUsable` drops it) and used only as
	 * the lowest-precedence recovery source in `healThenUpdate`.
	 *
	 * It is not a plan and must never become one — planning from a snapshot is
	 * exactly what `quarantineThenRebuild` re-reads to avoid, and this is
	 * beaten by every source that could be fresher, including the note as it
	 * reads at the moment of the repair. What it covers is the case where that
	 * note has since stopped existing: found unreadable, then deleted by a sync
	 * conflict resolution or by hand before the user got to the repair row. The
	 * note-side salvage then has nothing to work on, and on a cold start
	 * neither the in-memory index nor the backup holds anything either, so
	 * without this the repair reports "nothing to recover" while the orders
	 * were sitting in text this store had already read.
	 *
	 * Its lifetime is exactly one unusable stretch. Every path into that state
	 * replaces it (`markUnusable` takes the text it judged), and `markUsable`
	 * clears it, so it can never speak for a note two repairs ago — a text kept
	 * past the moment the store reads cleanly again could only ever resurrect
	 * orders something has since legitimately replaced.
	 */
	private lastUnreadableText: string | null = null;
	private writeTimerId: number | null = null;
	/** See `awaitIndexing`. Reset on every successful write. */
	private indexingRetries = 0;
	/** Serializes writes so two overlapping `Vault.process` calls on the index note can never interleave — same reason `orderSync.ts`'s coordinator chains its own ops. */
	private writeChain: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(private readonly host: IndexFileHost) {
		this.host.registerEvent(
			this.host.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile) || file.path !== this.notePath()) return;
				void this.onExternalModify(file);
			}),
		);
		this.host.register(() => {
			this.disposed = true;
			if (this.writeTimerId !== null) {
				window.clearTimeout(this.writeTimerId);
				this.writeTimerId = null;
			}
		});
	}

	private notePath(): string {
		return normalizePath(this.host.settings.indexPath);
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
			this.markUsable();
			return;
		}
		const result = parseIndex(text);
		// The backup is only consulted for the one judgment `applyParsed`
		// cannot make on its own at startup, where nothing is loaded yet: is
		// "this note has no json block" a fresh note, or a note whose block was
		// destroyed? Read only when that question actually arises.
		const hadBlockBefore = result.status === 'empty' ? (await this.readBackup()).size > 0 : false;
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
	 */
	private applyParsed(result: ParseResult, text: string, hadBlockBefore = false): void {
		if (result.status === 'invalid') {
			this.markUnusable(result.reason, text);
			return;
		}
		if (result.status === 'empty' && (this.index.size > 0 || hadBlockBefore)) {
			this.markUnusable(MISSING_BLOCK_REASON, text);
			return;
		}
		// The one place a read can prove a block is really there. Recorded even
		// when the block parsed to an empty index: what matters later is that a
		// fence existed at this path, not what was inside it.
		if (result.status === 'ok') this.sawBlock = true;
		this.index = result.status === 'ok' ? result.index : new Map();
		this.markUsable();
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
		return this.usable;
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
		if (!this.usable) {
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
	 * This is the entry point for the three explicit user actions it heals
	 * on: the order modal's save, "Clear explorer order", and (indirectly,
	 * via `repair()`) the settings tab's own "Repair the order note" row. `orderSync.ts`'s background rename/delete
	 * reactions deliberately keep calling plain `update()` instead — a
	 * rename elsewhere in the vault is not the user asking this plugin to
	 * repair anything, and healing must only ever happen in response to one
	 * that is.
	 */
	async updateOrRepair(mutate: (index: OrderIndex) => OrderIndex): Promise<boolean> {
		if (this.usable) return this.update(mutate);
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
	 * to complete alongside the repair. A no-op returning `true` when the
	 * store is already usable. Identical machinery to what `updateOrRepair`
	 * runs automatically, via an identity `mutate` that changes nothing
	 * beyond the recovery itself.
	 */
	async repair(): Promise<RepairOutcome> {
		if (this.usable) return 'healed';
		return this.healThenUpdate((index) => index);
	}

	/**
	 * The healing sequence itself, reachable only through
	 * `updateOrRepair`/`repair` and only while `!this.usable` — never from
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
	 * store unusable — it does not partially apply: `this.index` and
	 * `this.usable` are only updated together, after both the quarantine and
	 * the rebuilt note have actually landed.
	 */
	private async healThenUpdate(mutate: (index: OrderIndex) => OrderIndex): Promise<RepairOutcome> {
		const backup = await this.readBackup();
		// Read once, outside the loop, for the same reason `backup` is: neither
		// can change while this runs — nothing between here and the write
		// re-reads the backup, and `lastUnreadableText` only moves when the
		// store's usability does, which ends the loop either way.
		const lastUnreadable = this.lastUnreadableText ?? '';

		try {
			// Recovery is re-derived per attempt, from whatever the note holds
			// at that moment, rather than once from the snapshot taken when it
			// went unusable. A differently-broken version that arrives in
			// between carries its own salvageable lines, and planning from the
			// older text would discard them while claiming to repair.
			const outcome = await this.quarantineThenRebuild((text) => {
				const { index: recovered, droppedLines } = recoverIndex(text, this.index, backup, lastUnreadable);
				if (recovered.size === 0) return null;
				return { index: mutate(recovered), droppedLines };
			});

			switch (outcome.kind) {
				case 'nothing-to-recover':
					console.error(
						`[explorer-order-editor] cannot repair the order index (${this.notePath()}): nothing recoverable in the note, what is loaded, or the last backup`,
					);
					return 'nothing-to-recover';
				case 'gave-up':
					return 'failed';
				// Both leave the store usable without this call having written
				// anything, so the edit the caller came for still has to land.
				case 'already-usable':
				case 'adopted':
					return this.update(mutate) ? 'healed' : 'failed';
				case 'rebuilt': {
					const lines = [`Explorer order editor: repaired ${this.notePath()}.`];
					if (outcome.quarantinePath !== null) lines.push(`The unreadable copy was kept as "${outcome.quarantinePath}".`);
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
	 * `planFor` returns `null` for "nothing here is worth recovering", which
	 * only `healThenUpdate` ever says — `startOver` plans an empty index
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
	 * Runs on `writeChain` (`runExclusive`), the same queue `performWrite`
	 * uses: a write that was already scheduled *before* the note went unusable
	 * (armed by an earlier, then-valid `update()`) could still be in flight
	 * when this starts, and without this its `Vault.process` call could
	 * interleave with the rebuild's own — exactly the overlap `writeChain`
	 * exists to prevent.
	 */
	private async quarantineThenRebuild(planFor: (text: string) => RebuildPlan | null): Promise<RebuildOutcome> {
		return this.runExclusive(async () => {
			for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt++) {
				// Re-checked after taking the chain, not just at entry: two
				// explicit actions can reach here before either has run — a
				// double-click on "Clear explorer order", a save landing while
				// a repair is queued. The first healed everything; the second
				// would otherwise quarantine the same content again and hand
				// the user two "preserved copy" notes for one broken file.
				if (this.usable) return { kind: 'already-usable' };

				// Read past the cache (`fresh`), because this text is what
				// `rebuildNoteFrom` compares against what `Vault.process`
				// re-reads. Planning and writing have to be looking at the same
				// bytes for the identity check to mean anything — see
				// `readNote`.
				const current = (await this.readNote(this.notePath(), true)) ?? '';

				// The note fixed itself while this was queued or while a
				// confirmation dialog was open. Adopt it — that is only what
				// `onExternalModify` was about to do — rather than write a plan
				// derived from the broken version over orders that are strictly
				// newer.
				const parsed = parseIndex(current);
				if (parsed.status === 'ok') {
					this.index = parsed.index;
					this.markUsable();
					await this.persistBackup(parsed.index);
					return { kind: 'adopted' };
				}

				const plan = planFor(current);
				if (plan === null) return { kind: 'nothing-to-recover' };

				// Zero bytes preserve nothing, and the copy would only leave a
				// note the "delete the kept copies" row then offers to tidy
				// away — "preserve before replacing" is satisfied vacuously
				// when there is nothing to preserve.
				const quarantinePath = current === '' ? null : await this.quarantineUnreadableNote(current);

				if (!(await this.rebuildNoteFrom(plan.index, current))) continue;

				this.index = plan.index;
				this.markUsable();
				await this.persistBackup(plan.index);
				return { kind: 'rebuilt', quarantinePath, droppedLines: plan.droppedLines };
			}

			console.error(
				`[explorer-order-editor] gave up rebuilding ${this.notePath()}: it kept changing between reading it and writing it`,
			);
			return { kind: 'gave-up' };
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
		if (this.usable) return true;

		try {
			// Plans an empty index whatever the note turns out to hold, which
			// is exactly what was confirmed — but the loop still re-reads, so
			// the text actually being replaced is the text that gets preserved.
			// A newer, differently-broken version arriving while the dialog was
			// open is kept as its own copy rather than being written over on
			// the strength of a snapshot from before it existed.
			const outcome = await this.quarantineThenRebuild(() => ({ index: new Map(), droppedLines: 0 }));

			switch (outcome.kind) {
				case 'gave-up':
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
					new Notice(
						`Explorer order editor: ${this.notePath()} became readable again before starting over, so nothing was cleared.`,
					);
					return true;
				case 'rebuilt': {
					const lines = [`Explorer order editor: ${this.notePath()} was rebuilt with no saved orders.`];
					if (outcome.quarantinePath !== null) lines.push(`The unreadable copy was kept as "${outcome.quarantinePath}".`);
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
	 */
	private async rebuildNoteFrom(index: OrderIndex, expected: string): Promise<boolean> {
		const { app } = this.host;
		const path = this.notePath();
		const file = app.vault.getFileByPath(path);

		if (file === null) {
			// The note vanished between going unusable and this heal (e.g.
			// deleted externally in the meantime). Same as any other first write.
			const text = serializeIndex('', index);
			this.lastWrittenText = text;
			await app.vault.create(path, text);
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
	 * Persists a copy of `index` into this plugin's own `data.json`, merged
	 * into the same stored object as the settings — read
	 * fresh and written back with only `INDEX_BACKUP_KEY` changed, rather
	 * than overwriting the whole object from a stale in-memory copy, so this
	 * never fights `main.ts`'s `saveSettings()` (which merges the same way)
	 * over the file. Serialized with `orderIndex.ts`'s own `serializeIndex`
	 * against an empty starting note — there is no second encoding here, just
	 * the note-text format stored as a string instead of written to a file.
	 *
	 * Never a source of truth on its own (see `readBackup`) — best-effort:
	 * failures are logged, not surfaced, since losing a backup write changes
	 * nothing the user can see until a future heal needs it, and even then
	 * it is only ever the lowest-precedence source in `recoverIndex`.
	 */
	private async persistBackup(index: OrderIndex): Promise<void> {
		try {
			const text = serializeIndex('', index);
			const data = (await this.host.loadData()) as Record<string, unknown> | null;
			await this.host.saveData({ ...data, [INDEX_BACKUP_KEY]: text });
		} catch (err) {
			console.error('[explorer-order-editor] failed to back up the order index to data.json', err);
		}
	}

	/**
	 * Reads the `data.json` backup, for `healThenUpdate` only — never called
	 * from `load()`. That asymmetry is deliberate: a missing index note
	 * (file === null in `load()`) means the user removed it to start over,
	 * and must not have its content resurrected from a backup; only a note
	 * that *exists but does not parse* — the only path that can ever mark
	 * this store unusable — is eligible for recovery at all. Returns an
	 * empty index for anything short of a cleanly parsed backup (missing,
	 * wrong shape, corrupt) — `recoverIndex` treats a missing source the
	 * same as an empty one, so this never needs to distinguish "no backup
	 * yet" from "backup unreadable."
	 */
	private async readBackup(): Promise<OrderIndex> {
		try {
			const data = (await this.host.loadData()) as Record<string, unknown> | null;
			const text = data?.[INDEX_BACKUP_KEY];
			if (typeof text !== 'string') return new Map();
			const parsed = parseIndex(text);
			return parsed.status === 'ok' ? parsed.index : new Map();
		} catch (err) {
			console.error('[explorer-order-editor] failed to read the order index backup from data.json', err);
			return new Map();
		}
	}

	/**
	 * Why the store is unusable, for a caller that needs to tell the user
	 * *now* rather than rely on the one Notice shown when it first happened.
	 * That Notice fires once and never repeats (`noticeShown`), which is right
	 * for a background failure and wrong for the moment someone presses Save:
	 * the file may have broken long before, and silence at the point of action
	 * reads as "nothing happened" rather than "this was refused".
	 */
	unusableReason(): string | null {
		return this.usable ? null : (this.reason ?? 'it could not be parsed');
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
	 * Performs any pending write now, and waits for one already in flight.
	 * Callers that need a write to have actually landed (rather than merely
	 * be reflected in memory, which `update()` already guarantees
	 * synchronously) await this.
	 */
	async flush(): Promise<void> {
		if (this.writeTimerId !== null) {
			window.clearTimeout(this.writeTimerId);
			this.writeTimerId = null;
			this.enqueueWrite();
		}
		await this.writeChain;
	}

	/**
	 * The actual `Vault.process`/`vault.create` write. Never throws: an
	 * unexpected I/O error is logged and the write is simply lost until the
	 * next `update()` schedules another attempt — `this.index` still holds
	 * the change in memory regardless, so nothing the caller already did is
	 * undone, only the persistence of it is delayed.
	 */
	/**
	 * Re-arms the debounce so `performWrite` can try again once the vault has
	 * indexed a note it can already see on disk.
	 *
	 * Bounded, and not out of superstition: `indexPath` could name something
	 * Obsidian will never index — a backslash in the filename is the known case
	 * — and then `getFileByPath` stays null while `adapter.exists` stays true,
	 * forever. Unbounded retries would spin a timer for the life of the
	 * session. The counter resets on every successful write, so an ordinary
	 * startup gap (a few hundred milliseconds at most) never approaches the
	 * limit, and a permanent one says so once and stops.
	 */
	private awaitIndexing(): void {
		this.indexingRetries += 1;
		if (this.indexingRetries > MAX_INDEXING_RETRIES) {
			console.error(
				`[explorer-order-editor] ${this.notePath()} exists on disk but the vault never indexed it, so the order could not be written. ` +
					'A filename Obsidian refuses to index (a backslash, for instance) would do this.',
			);
			return;
		}
		this.scheduleWrite();
	}

	private async performWrite(): Promise<void> {
		// Deliberately NOT guarded on `disposed`. `main.ts`'s `onunload` calls
		// `flush()` precisely so a change made moments before the plugin is
		// disabled or reloaded still lands, and Obsidian gives no guarantee
		// that `onunload` runs before the callbacks handed to `register()` —
		// so if this bailed on `disposed`, that final write would be dropped
		// exactly in the case it exists for. Writing a change the user already
		// made, a moment later than expected, is harmless; losing it is not.
		// `disposed` still stops new debounce timers being armed
		// (`scheduleWrite`) and stops reacting to external edits
		// (`onExternalModify`), which is all it is for.
		if (!this.usable) return;
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
			const blockWasStored = this.sawBlock || this.lastWrittenText !== null || (await this.readBackup()).size > 0;

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
				this.markUnusable(becameUnusable, refusedText);
			} else {
				this.indexingRetries = 0;
				await this.persistBackup(this.index);
			}
		} catch (err) {
			console.error('[explorer-order-editor] failed to write the order index', err);
		}
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
		const hadBlockBefore = result.status === 'empty' ? (await this.readBackup()).size > 0 : false;
		this.applyParsed(result, text, hadBlockBefore);
		requestFileExplorerResort(this.host.app);
	}

	/**
	 * Detection only — never writes, never heals (see the module doc
	 * comment).
	 *
	 * The text it found unreadable is kept (`lastUnreadableText`), and the
	 * distinction that makes that safe is worth stating exactly, because the
	 * opposite of it is a bug this file has already had: healing re-reads the
	 * note itself, inside the write that replaces it, since any copy taken here
	 * can be superseded before that write lands — and *planning* from a
	 * superseded copy is what destroyed salvageable orders before
	 * `quarantineThenRebuild` was made to re-plan. What is kept here is not a
	 * plan and never becomes one: it is the last-resort recovery source, below
	 * every source that could be fresher, and it exists for the case where the
	 * note being re-read has ceased to exist entirely.
	 *
	 * Also cancels any debounced write still armed from before this ran: it
	 * would only find `!this.usable` and no-op when it fired anyway
	 * (`performWrite`'s own guard), but not scheduling it at all means one
	 * fewer thing that could still be pending if a heal starts before it
	 * would have fired.
	 */
	private markUnusable(reason: string, text: string): void {
		this.usable = false;
		this.reason = reason;
		// Not a plan, and not consulted while anything fresher exists — see the
		// field's own doc comment. Every caller has the text in hand already,
		// which is why it is a parameter rather than another read.
		this.lastUnreadableText = text;
		if (this.writeTimerId !== null) {
			window.clearTimeout(this.writeTimerId);
			this.writeTimerId = null;
		}
		const path = this.notePath();
		console.error(`[explorer-order-editor] the order index (${path}) is unusable: ${reason}`);
		if (this.noticeShown) return;
		this.noticeShown = true;
		new Notice(
			`Explorer order editor: ${path} could not be read (${reason}). Saved folder orders are unavailable until this is repaired — ` +
				'use "Repair the order note" in settings, or the next save/clear will attempt it automatically.',
		);
	}

	private markUsable(): void {
		this.usable = true;
		this.reason = null;
		this.noticeShown = false;
		// Deliberately dropped here rather than left to age: a readable note is
		// the newer truth, and a text kept past this point could only ever
		// resurrect orders that something has since legitimately replaced.
		this.lastUnreadableText = null;
	}
}
