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
 */
import { App, Notice, normalizePath, Plugin, TFile, TFolder } from 'obsidian';
import { parseIndex, serializeIndex, type OrderIndex, type ParseResult } from './orderIndex';
import type { ExplorerOrderEditorSettings } from './settings';

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
	 * A missing note (never written to yet) and a note with no json block
	 * yet (`status: 'empty'`) both resolve to a usable, empty index —
	 * indistinguishable from each other and from "usable, and genuinely
	 * empty" (`{}` in the block), which is the correct behavior in all three
	 * cases: no folder has a saved order.
	 */
	async load(): Promise<void> {
		const file = this.host.app.vault.getFileByPath(this.notePath());
		if (file === null) {
			this.index = new Map();
			this.markUsable();
			return;
		}
		const text = await this.host.app.vault.cachedRead(file);
		this.applyParsed(parseIndex(text));
	}

	private applyParsed(result: ParseResult): void {
		if (result.status === 'invalid') {
			this.markUnusable(result.reason);
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
				return;
			}

			let becameUnusable: string | null = null;
			await app.vault.process(existing, (data) => {
				// The disk may have changed since `load()` (or since the last
				// write) — a sync client could have landed a corrupt or
				// half-written copy in between. Checking here, inside the
				// change function, against the text `Vault.process` just
				// re-read, is the entire reason `orderIndex.ts` distinguishes
				// `invalid` from `empty`: it lets this refuse to overwrite
				// content we can't prove is safe to replace, rather than
				// clobbering whatever the invalid state was hiding.
				const parsed = parseIndex(data);
				if (parsed.status === 'invalid') {
					becameUnusable = parsed.reason;
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
				this.markUnusable(becameUnusable);
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
		this.applyParsed(parseIndex(text));
		requestFileExplorerResort(this.host.app);
	}

	private markUnusable(reason: string): void {
		this.usable = false;
		this.reason = reason;
		const path = this.notePath();
		console.error(`[explorer-order-editor] the order index (${path}) is unusable: ${reason}`);
		if (this.noticeShown) return;
		this.noticeShown = true;
		new Notice(`Explorer order editor: ${path} could not be read (${reason}). Saved folder orders are unavailable until this is fixed.`);
	}

	private markUsable(): void {
		this.usable = true;
		this.reason = null;
		this.noticeShown = false;
	}
}
