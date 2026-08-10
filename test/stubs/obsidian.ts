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
 */

/**
 * `IndexFileStore` schedules its debounced writes through `window.setTimeout`,
 * so without this the whole write path throws `ReferenceError` on the first
 * `update()` and no test can reach it. That gap is not hypothetical: it is why
 * a guard that refused every first write into a block-less note went in green.
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
	private handlers: ((file: TAbstractFile) => void)[] = [];

	adapter = {
		exists: async (path: string): Promise<boolean> => this.files.has(path),
		read: async (path: string): Promise<string> => this.files.get(path) ?? '',
	};

	getFileByPath(path: string): TFile | null {
		return this.files.has(path) ? new TFile(path, path.split('/').pop() ?? path) : null;
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.getFileByPath(path);
	}

	async cachedRead(file: TFile): Promise<string> {
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

	on(_event: string, handler: (file: TAbstractFile) => void): { handler: typeof handler } {
		this.handlers.push(handler);
		return { handler };
	}
}

export class Workspace {
	getLeavesOfType(_type: string): unknown[] {
		return [];
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

	async loadData(): Promise<Record<string, unknown> | null> {
		return this.data;
	}

	async saveData(data: Record<string, unknown>): Promise<void> {
		this.data = data;
	}

	registerEvent(_ref: unknown): void {}
	register(_cb: () => void): void {}
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
