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
 * M10e — healing: detecting that the note is unreadable never, by itself,
 * changes anything on disk (see `applyParsed`/`markUnusable` — a hand edit
 * inside Obsidian necessarily passes through "not valid JSON yet" on every
 * autosave, and a store that healed at that moment would clobber the user
 * mid-keystroke). Healing only ever runs from `updateOrRepair`/`repair`, in
 * response to one of three explicit user actions — the order modal's save,
 * "Clear explorer order", or the settings tab's "Repair the order note" row
 * — never automatically. When it runs, it never chooses one source of truth
 * over another: it unions the unreadable note's own salvageable lines, the
 * in-memory index, and the `data.json` backup (`recoverIndex`, in
 * `orderIndex.ts`), preserves the unreadable text as a quarantine note
 * beside the original first, and only then rebuilds. `update()` itself is
 * unchanged — still synchronous, still just refuses while unusable — so
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

/** Milliseconds a burst of `update()` calls is given to settle before the debounced write actually runs. */
const WRITE_DEBOUNCE_MS = 200;

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
	 * The note's own text at the moment it was last found unreadable — kept
	 * up to date on every re-detection (a further external edit while
	 * already unusable re-parses and updates this too), so healing always
	 * salvages from the newest known state, not a stale snapshot from the
	 * first time this went unusable. `null` while usable.
	 */
	private unreadableText: string | null = null;
	/** The exact text this store itself last wrote, so the `modify` listener below can tell its own write apart from an external one. `null` until the first write. */
	private lastWrittenText: string | null = null;
	private writeTimerId: number | null = null;
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
		const file = this.host.app.vault.getFileByPath(this.notePath());
		if (file === null) {
			this.index = new Map();
			this.markUsable();
			return;
		}
		const text = await this.host.app.vault.cachedRead(file);
		const result = parseIndex(text);
		// The backup is only consulted for the one judgment `applyParsed`
		// cannot make on its own at startup, where nothing is loaded yet: is
		// "this note has no json block" a fresh note, or a note whose block was
		// destroyed? Read only when that question actually arises.
		const hadBlockBefore = result.status === 'empty' ? (await this.readBackup()).size > 0 : false;
		this.applyParsed(result, text, hadBlockBefore);
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
	private applyParsed(result: ParseResult, rawText: string, hadBlockBefore = false): void {
		if (result.status === 'invalid') {
			this.markUnusable(result.reason, rawText);
			return;
		}
		if (result.status === 'empty' && (this.index.size > 0 || hadBlockBefore)) {
			this.markUnusable('Its json block is missing', rawText);
			return;
		}
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
	 * This is the entry point for the three explicit user actions M10e heals
	 * on: the order modal's save, "Clear explorer order", and (indirectly,
	 * via `repair()`) the settings tab's migration rows and its own "Repair
	 * the order note" row. `orderSync.ts`'s background rename/delete
	 * reactions deliberately keep calling plain `update()` instead — a
	 * rename elsewhere in the vault is not the user asking this plugin to
	 * repair anything, and healing must only ever happen in response to one
	 * that is.
	 */
	async updateOrRepair(mutate: (index: OrderIndex) => OrderIndex): Promise<boolean> {
		if (this.usable) return this.update(mutate);
		return this.healThenUpdate(mutate);
	}

	/**
	 * Attempts to heal without any accompanying edit — the settings tab's
	 * "Repair the order note" row (M10e part 5), for the cold-start case
	 * where a bad note left nothing in memory and there is no in-flight edit
	 * to complete alongside the repair. A no-op returning `true` when the
	 * store is already usable. Identical machinery to what `updateOrRepair`
	 * runs automatically, via an identity `mutate` that changes nothing
	 * beyond the recovery itself.
	 */
	async repair(): Promise<boolean> {
		if (this.usable) return true;
		return this.healThenUpdate((index) => index);
	}

	/**
	 * The healing sequence itself (M10e parts 3–4), reachable only through
	 * `updateOrRepair`/`repair` and only while `!this.usable` — never from
	 * detection (`applyParsed`/`markUnusable`), which must never by itself
	 * change anything on disk.
	 *
	 * 1. Builds the recovered index — a union of the unreadable note's own
	 *    salvageable lines, the in-memory index, and the `data.json` backup
	 *    (`recoverIndex`). If that union is empty, there is nothing to
	 *    recover: stops here, touches nothing, stays unusable. Destroying
	 *    the only copy of something in order to replace it with an empty one
	 *    is the one outcome that must never happen, so this is the one case
	 *    healing refuses even to try.
	 * 2. Preserves the unreadable text as a quarantine note beside the
	 *    original *before* touching the original at all.
	 * 3. Applies `mutate` to the recovered index, rebuilds the note from the
	 *    result, and becomes usable again.
	 * 4. Reports success with a Notice naming the quarantine note, so the
	 *    preserved content is findable, and how many lines could not be
	 *    salvaged when that count is above zero.
	 *
	 * A failure at step 2 or 3 (quarantine or rebuild I/O) is logged and
	 * leaves the store unusable — it does not partially apply: `this.index`
	 * and `this.usable` are only updated together, after both the quarantine
	 * and the rebuilt note have actually landed.
	 *
	 * The quarantine + rebuild pair runs on `writeChain` (`runExclusive`),
	 * the same queue `performWrite` uses: a write that was already scheduled
	 * *before* the note went unusable (armed by an earlier, then-valid
	 * `update()`) could still be in flight when a heal starts, and without
	 * this its `Vault.process` call could interleave with the heal's own —
	 * exactly the overlap `writeChain` exists to prevent. Chaining onto it
	 * makes the heal wait for that write to finish first, and makes any
	 * later write (or a second, concurrent heal attempt) wait for the heal
	 * in turn.
	 */
	private async healThenUpdate(mutate: (index: OrderIndex) => OrderIndex): Promise<boolean> {
		const unreadableText = this.unreadableText ?? '';
		const backup = await this.readBackup();
		const { index: recovered, droppedLines } = recoverIndex(unreadableText, this.index, backup);

		if (recovered.size === 0) {
			console.error(
				`[explorer-order-editor] cannot repair the order index (${this.notePath()}): nothing recoverable in the note, what is loaded, or the last backup`,
			);
			return false;
		}

		const next = mutate(recovered);

		try {
			const quarantinePath = await this.runExclusive(async () => {
				// Re-checked after taking the chain, not just at entry: two
				// explicit actions can reach here before either has run — a
				// double-click on "Clear explorer order", a save landing while a
				// repair is queued. Each captured its own copy of
				// `unreadableText` while the store was still unusable, so
				// without this the second would quarantine the same content a
				// second time and hand the user two "preserved copy" notes for
				// one broken file. The first heal already recovered everything;
				// the second only has to apply its own mutation.
				if (this.usable) return null;
				const path = await this.quarantineUnreadableNote(unreadableText);
				await this.rebuildNoteFrom(next);
				this.index = next;
				this.markUsable();
				await this.persistBackup(next);
				return path;
			});

			if (quarantinePath === null) return this.update(mutate);

			const lines = [`Explorer order editor: repaired ${this.notePath()}. The unreadable copy was kept as "${quarantinePath}".`];
			if (droppedLines > 0) {
				lines.push(`${droppedLines} line${droppedLines === 1 ? '' : 's'} in it could not be salvaged.`);
			}
			new Notice(lines.join(' '));

			return true;
		} catch (err) {
			console.error('[explorer-order-editor] failed to repair the order index', err);
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
	private async rebuildNoteFrom(index: OrderIndex): Promise<void> {
		const { app } = this.host;
		const path = this.notePath();
		const file = app.vault.getFileByPath(path);

		if (file === null) {
			// The note vanished between going unusable and this heal (e.g.
			// deleted externally in the meantime). Same as any other first write.
			const text = serializeIndex('', index);
			this.lastWrittenText = text;
			await app.vault.create(path, text);
			return;
		}

		await app.vault.process(file, (data) => {
			let text: string;
			try {
				text = serializeIndex(data, index);
			} catch {
				text = serializeIndex('', index);
			}
			this.lastWrittenText = text;
			return text;
		});
	}

	/**
	 * Persists a copy of `index` into this plugin's own `data.json`, merged
	 * into the same stored object as the settings (M10e part 2) — read
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
				const text = serializeIndex('', this.index);
				this.lastWrittenText = text;
				await app.vault.create(path, text);
				await this.persistBackup(this.index);
				return;
			}

			let becameUnusable: string | null = null;
			let becameUnusableText = '';
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
					becameUnusableText = data;
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
				this.markUnusable(becameUnusable, becameUnusableText);
			} else {
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
		this.applyParsed(parseIndex(text), text);
		requestFileExplorerResort(this.host.app);
	}

	/**
	 * Detection only — never writes, never heals (see the module doc
	 * comment). `rawText` is kept as `unreadableText` so a later explicit
	 * heal (`healThenUpdate`) salvages from exactly what was found here,
	 * without having to re-read the file itself.
	 *
	 * Also cancels any debounced write still armed from before this ran: it
	 * would only find `!this.usable` and no-op when it fired anyway
	 * (`performWrite`'s own guard), but not scheduling it at all means one
	 * fewer thing that could still be pending if a heal starts before it
	 * would have fired.
	 */
	private markUnusable(reason: string, rawText: string): void {
		this.usable = false;
		this.reason = reason;
		this.unreadableText = rawText;
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
		this.unreadableText = null;
		this.noticeShown = false;
	}
}
