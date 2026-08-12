/**
 * A hand-written stand-in for the `obsidian` module, aliased in for tests
 * only (`vitest.config.ts`). It is never bundled: `esbuild.config.mjs` lists
 * `obsidian` as external, the production `tsconfig.json` compiles `src/`
 * alone, and the release attaches `main.js`/`manifest.json`/`styles.css` —
 * nothing here can reach a user.
 *
 * WHAT THIS MAY BE USED TO ASSERT, AND WHAT IT MUST NOT
 *
 * This file encodes *our assumptions* about Obsidian, not Obsidian. A test
 * against it proves that our own code took the branch we meant it to take.
 * It proves nothing whatever about what the real application does, and a
 * green run here is not evidence that a change works — hand testing in
 * `testvault/` remains the only thing that decides that.
 *
 * So: assert control flow that is ours. Did `startOver` skip the copy when
 * there was nothing to preserve? Did a failed rebuild report rather than
 * stay silent? Those are our branches, and the stub is a faithful witness to
 * them.
 *
 * Never assert timing, lifecycle or view behaviour through this. Every
 * expensive bug this project has had was Obsidian doing something other than
 * assumed — `onload` versus `onLayoutReady`, a leaf rebuilt underneath a
 * listener, an icon id silently not rendering — and in each case a stub
 * written from the same wrong assumption would have agreed with the code and
 * gone green. See `docs/dev/obsidian-internals.md` before trusting any
 * intuition about the real thing.
 *
 * The one import below is the exception that proves the rule: `pluginData.ts`
 * is a pure leaf of *ours*, and calling it is how the double is kept from
 * owning a second copy of a decision `src/` already makes.
 */
import { classifyData, mergedData, type DataRead } from '../../src/pluginData';

/**
 * `IndexFileStore` schedules its debounced writes through `window.setTimeout`,
 * so without this the whole write path throws `ReferenceError` on the first
 * `update()` and no test can reach it. That gap is not hypothetical: it is why
 * a guard that refused every first write into a block-less note went in green.
 *
 * Installed once for every test file by `test/setup.ts` (`setupFiles` in
 * `vitest.config.ts`) — no file has to remember to call it, which is how the
 * gap above stayed open. Idempotent (`??=`), so calling it again is harmless.
 *
 * Node's own timers, only reachable under the name the plugin uses.
 */
export function installTimers(): void {
	(globalThis as { window?: unknown }).window ??= {
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		clearTimeout: (id: number) => {
			clearTimeout(id);
		},
	};
}

/** Captures every `Notice` raised during a test, so a silent path is distinguishable from a reporting one. */
export const notices: string[] = [];

export class Notice {
	constructor(message: string) {
		notices.push(message);
	}
}

export function resetNotices(): void {
	notices.length = 0;
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

export class TAbstractFile {
	constructor(
		public path: string,
		public name: string,
	) {}
}

export class TFile extends TAbstractFile {}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === '/';
	}
}

/**
 * An in-memory vault. `process` re-reads before applying its change
 * function, which is the one behaviour the code under test genuinely depends
 * on — everything else here is a convenience for building fixtures.
 *
 * `failCreate`/`failProcess` exist because the failure branches are the point:
 * a quarantine copy that cannot be written, and a rebuild that throws, are
 * the two I/O faults the store has to report rather than swallow.
 */
export class Vault {
	files = new Map<string, string>();
	failCreate: string | null = null;
	failProcess: string | null = null;
	/**
	 * What `cachedRead` answers with instead of `files`, for the one thing a
	 * test cannot otherwise express: the two reads disagreeing. Obsidian's read
	 * cache is only invalidated by a `modify` event, and this stub never fires
	 * one (see `on` below), so a note replaced underneath the app is exactly
	 * this — stale in the cache, current on disk.
	 *
	 * Set only by a test asserting *which of the two reads* a path of ours
	 * takes. Empty otherwise, and then `cachedRead` and `read` agree, which is
	 * what every other test wants.
	 */
	staleCache = new Map<string, string>();

	/**
	 * Paths the file map pretends not to know while `files` and `adapter` still
	 * hold them — "on disk, but the vault has not indexed it".
	 *
	 * `indexFile.ts` guards against that state in three separate places and
	 * documents it in two more, so our branches for it need some way to be
	 * reached. What this reproduces is only the *shape* of the state, never when
	 * the real app enters it — a cold-start window, or an index path inside a
	 * dot-folder — and neither is something a stub may claim to model (see the
	 * header).
	 */
	unindexed = new Set<string>();

	adapter = {
		exists: async (path: string): Promise<boolean> => this.files.has(path),
		read: async (path: string): Promise<string> => this.files.get(path) ?? '',
	};

	getFileByPath(path: string): TFile | null {
		return this.files.has(path) && !this.unindexed.has(path) ? new TFile(path, path.split('/').pop() ?? path) : null;
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.getFileByPath(path);
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.staleCache.get(file.path) ?? this.files.get(file.path) ?? '';
	}

	/** Straight from `files`, never from `staleCache` — the real `Vault.read` reads the file itself rather than the cache. */
	async read(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? '';
	}

	async create(path: string, text: string): Promise<TFile> {
		if (this.failCreate !== null) throw new Error(this.failCreate);
		if (this.files.has(path)) throw new Error('File already exists.');
		this.files.set(path, text);
		return new TFile(path, path.split('/').pop() ?? path);
	}

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		if (this.failProcess !== null) throw new Error(this.failProcess);
		const next = fn(this.files.get(file.path) ?? '');
		this.files.set(file.path, next);
		return next;
	}

	/**
	 * Accepts a listener and **never dispatches to it on its own**. "The disk
	 * changed and nothing has told the store" is the state several tests here
	 * need, and writing to `files` must keep leaving them in it — so no path
	 * through this class calls a handler.
	 *
	 * The handlers are kept, though, so a test that wants the *other* state can
	 * ask for it in as many words with `fire` below. They were originally
	 * discarded, on the reasoning that a list nothing reads would imply an
	 * `emit` that did not exist; the answer to that turned out to be an `emit`
	 * that does exist and is never implicit, rather than no way to reach
	 * `onExternalModify` from a test at all.
	 */
	private handlers = new Map<string, ((file: TAbstractFile, oldPath?: string) => void)[]>();

	on(event: string, handler: (file: TAbstractFile, oldPath?: string) => void): { handler: typeof handler } {
		const forEvent = this.handlers.get(event) ?? [];
		forEvent.push(handler);
		this.handlers.set(event, forEvent);
		return { handler };
	}

	/**
	 * Runs the listeners for `event` against `path`, the way Obsidian would
	 * after something else on the machine touched the note. `oldPath` is what a
	 * `rename` carries. Explicit on purpose: the write into `files` that
	 * precedes it is still silent, which is what every other test in this repo
	 * depends on.
	 *
	 * Returns nothing. `onExternalModify` is fired and not awaited by the store
	 * either (`void this.onExternalModify(file)`), so a caller that needs it
	 * settled awaits something the store exposes — `flush()` — rather than this.
	 */
	fire(event: string, path: string, oldPath?: string): void {
		const file = new TFile(path, path.slice(path.lastIndexOf('/') + 1));
		for (const handler of this.handlers.get(event) ?? []) handler(file, oldPath);
	}
}

export class Workspace {
	/**
	 * What `getLeavesOfType` answers with, for every type — this stub does not
	 * model per-type filtering, only "does a test care about leaves at all".
	 * Defaults to `[]` so every test that never touches this keeps behaving
	 * exactly as before: `fileExplorerLeaves.ts` and its four callers see no
	 * leaves and fall back the same way they always have.
	 *
	 * Settable, not fixed, because the whole point of the module this exists
	 * for is choosing *among* leaves — a deferred one ahead of a real one, two
	 * real ones open at once — and a stub that can only ever return `[]` can't
	 * put a test in front of that choice at all.
	 */
	leaves: unknown[] = [];

	getLeavesOfType(_type: string): unknown[] {
		return this.leaves;
	}
}

export class App {
	vault = new Vault();
	workspace = new Workspace();
	fileManager = {
		renameFile: async (): Promise<void> => undefined,
		trashFile: async (): Promise<void> => undefined,
	};
}

export class Plugin {
	app = new App();
	private data: Record<string, unknown> | null = null;

	/**
	 * The real shape of an unreadable `data.json`, and the one to reach for.
	 *
	 * Obsidian's `Plugin.loadData()` **does not throw** when the file cannot be
	 * read or does not parse: `Vault.readJson` logs it and returns `undefined`
	 * (and `null`, separately, when the file is genuinely absent). Verified
	 * against `obsidian.asar`; the greps are in
	 * `docs/dev/obsidian-internals.md`.
	 *
	 * This flag existed only as `failLoadData` below until 2026-08-12, which
	 * modelled a failure Obsidian never produces — so the code under test was
	 * green against a `catch` that could not run in the real app, while the
	 * value it was there to prevent (`undefined` reading as "no backup was
	 * ever written") flowed straight through. The header's warning about stubs
	 * that agree with the wrong assumption, in one variable.
	 */
	unreadableData = false;

	/**
	 * Makes `readData` itself throw — a host that breaks the no-throw contract
	 * `IndexFileHost` states, which is the only thing `readBackup`'s own
	 * `try`/`catch` can still be reached by.
	 *
	 * It replaced a `failLoadData` that made `loadData` throw. That one modelled
	 * a failure Obsidian cannot produce *and* let the double reject where the
	 * real `readData` returns `'unreadable'` — so the test written against it
	 * was exercising a path the app has no door to.
	 */
	failReadData: string | null = null;

	async loadData(): Promise<Record<string, unknown> | null | undefined> {
		if (this.unreadableData) return undefined;
		return this.data;
	}

	/**
	 * The real classifier, called — not a copy of it.
	 *
	 * It lived here as its own mapping for about an hour, and in that hour the
	 * copy already lost the non-object arm: `[1,2]` in `data.json` classified
	 * as `'ok'` under test and `'unreadable'` in the app. Same lesson as
	 * `unreadableData` above, one field over. `classifyData` imports nothing,
	 * so pulling it in creates no cycle with the `obsidian` alias.
	 */
	async readData(): Promise<DataRead> {
		if (this.failReadData !== null) throw new Error(this.failReadData);
		return classifyData(await this.loadData());
	}

	async saveData(data: Record<string, unknown>): Promise<void> {
		this.data = data;
	}

	/**
	 * Deliberately *not* a copy of `main.ts`'s serialized version. The real one
	 * chains these so the settings and the index backup cannot interleave on
	 * `data.json`; reproducing that chain here would only prove the stub
	 * serializes, since in a test the stub *is* the implementation — the same
	 * trap the header warns about. Nothing here starts two overlapping calls,
	 * so the plain read-modify-write is what the tests actually need, and a
	 * future test that does interleave will fail loudly against this rather
	 * than pass against a second implementation of the fix.
	 *
	 * The *policy* is a different matter and is shared: `mergedData` decides
	 * whether this may write at all. A double that wrote where the real one
	 * refuses would quietly cover the case the refusal exists for.
	 */
	async updateData(mutate: (data: Record<string, unknown>) => Record<string, unknown>): Promise<'written' | 'refused'> {
		const next = mergedData(await this.readData(), mutate);
		if (next === null) return 'refused';
		await this.saveData(next);
		return 'written';
	}

	/** `main.ts` writes the whole settings object; the tests that reach this only care that it round-trips through `updateData`. */
	settings: Record<string, unknown> = {};

	/**
	 * Swallows, because the real one does and `indexFile.ts` now depends on it:
	 * `onIndexNoteRenamed` dropped its own `try`/`catch` on the strength of the
	 * "does not reject" contract, so a double that rejected would let that
	 * deletion look safe here while the app got an unhandled rejection.
	 */
	async saveSettings(): Promise<void> {
		try {
			await this.updateData((data) => ({ ...data, ...this.settings }));
		} catch {
			// The real one reports; nothing here needs to.
		}
	}

	registerEvent(_ref: unknown): void {}

	/**
	 * Retained, not discarded, so a test can run a component's teardown the
	 * way `Component.unload` does. This models nothing about *when* Obsidian
	 * drains these — that fact is established in `obsidian-internals.md` from
	 * `obsidian.asar`, and a stub asserting it would only prove the stub. It
	 * exists so a test can ask what *our* teardown does when it runs.
	 */
	registered: (() => void)[] = [];
	register(cb: () => void): void {
		this.registered.push(cb);
	}

	/** Runs the registered teardowns, newest first, as `Component.unload` does. */
	runTeardowns(): void {
		while (this.registered.length > 0) this.registered.pop()?.();
	}
}

export class Modal {}
export class PluginSettingTab {}

/**
 * The same class under a second name, for tests that import this file
 * directly. They need the real `Plugin` type too — that is what the module
 * under test expects — and one file cannot bind that identifier twice. `src`
 * keeps seeing plain `Plugin`, through the alias.
 */
export { Plugin as StubPlugin };
