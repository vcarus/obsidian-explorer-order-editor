/**
 * The one seam between the stub and the real store types, shared by every
 * test file that builds a live `IndexFileStore` (`indexFileRepair`,
 * `indexFileWrite`, `notices`) — it existed as three identical copies until
 * 2026-08-11, each carrying its own copy of the cast the comment below
 * justifies.
 *
 * The stub is imported by path, never by mapping `obsidian` to it in
 * `test/tsconfig.json`. A mapping would apply to `src/**` as well — this
 * project compiles those too — and every module here would then be checked
 * against the stub's tiny surface instead of the real API, which is the one
 * check that actually protects the plugin. Types come from the real package
 * everywhere; only the runtime module is substituted, by the alias in
 * `vitest.config.ts`.
 *
 * The cast is where those two facts meet, and it is the only place they do.
 * It is honest at run time precisely because of that alias.
 *
 * Settings are spread from `DEFAULT_SETTINGS` rather than naming the one
 * field the store reads, so a key added later cannot leave this compiling
 * against a shape the plugin no longer has.
 */
import type { IndexFileHost } from '../src/indexFile';
import { DEFAULT_SETTINGS } from '../src/settings';
import { StubPlugin } from './stubs/obsidian';

/** The index note path every store-backed test uses. */
export const NOTE = 'explorer-order.md';

export function makeHost(): { host: IndexFileHost; stub: StubPlugin } {
	const stub = new StubPlugin();
	const host = stub as unknown as IndexFileHost;
	host.settings = { ...DEFAULT_SETTINGS, indexPath: NOTE };
	return { host, stub };
}
