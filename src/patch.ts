/**
 * A from-scratch, small reimplementation of monkey-around's patch/remove
 * contract (https://github.com/pjeby/monkey-around), scoped to a single
 * prototype method instead of monkey-around's multi-key `around()`. Verified
 * against monkey-around's own source, and against how custom-sort's own
 * bundled `main.js` uses it to patch the file explorer's
 * `getSortedFolderItems` — the exact same method `explorerSort.ts` patches —
 * rather than invented from scratch. `explorerSort.ts` needs the same
 * stacking-safety guarantee custom-sort relies on for its own patch, since
 * both plugins may be installed and enabled at once.
 *
 * Pure: no `obsidian` import, no I/O. Unit-tested in patch.test.ts.
 */

export function aroundPrototypeMethod<T extends (...args: never[]) => unknown>(
	proto: Record<string, unknown>,
	methodName: string,
	factory: (original: T) => T,
): () => void {
	const existing = proto[methodName];
	if (typeof existing !== 'function') {
		// Nothing to wrap. Installing nothing (rather than, say, wrapping a
		// function that throws) means a caller that always checks for the
		// method first and only calls this when it's present never actually
		// hits this branch; it exists as a defensive fallback, not a path
		// this plugin expects to exercise.
		return () => {
			// No-op: nothing was installed, so there is nothing to remove.
		};
	}
	const original = existing as T;

	// `current` is what the installed wrapper actually calls. It starts out
	// as the factory's function and is reassigned exactly once, by `remove`
	// below, back to `original`. That reassignment is what turns this layer
	// into a transparent pass-through instead of literally uninstalling it —
	// the behavior that keeps a *later* patch (whose own "original" is this
	// wrapper function object) working after this one is removed out from
	// under it.
	let current: T = factory(original);

	function wrapper(this: unknown, ...args: unknown[]): unknown {
		return (current as unknown as (...a: unknown[]) => unknown).apply(this, args);
	}

	proto[methodName] = wrapper;

	return function remove(): void {
		// Only clobber `proto[methodName]` if it is still literally our own
		// wrapper — i.e. nobody has patched on top of us since we installed.
		// If someone has, their patch's own "original" is this `wrapper`
		// function object; overwriting `proto[methodName]` here would
		// silently detach their patch from the prototype it believes it's
		// still attached to.
		if (proto[methodName] === wrapper) {
			proto[methodName] = original;
		}
		// Idempotent, and safe to call whether or not the branch above ran:
		// once `current` is already `original`, a second (or later) call has
		// nothing left to do.
		if (current === original) return;
		current = original;
	};
}
