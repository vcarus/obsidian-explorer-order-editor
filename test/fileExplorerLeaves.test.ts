/**
 * These read almost nothing off `App`: `app.workspace.getLeavesOfType(type)`,
 * then each leaf's `.view`, plus — for the two focus-aware finders — that
 * view's `containerEl` and the `activeElement` of the document owning it. That is
 * far narrower than the full stub's `Vault`/`fileManager` surface, so this
 * file builds its own minimal fake rather than reaching for `StubPlugin` —
 * one object literal, one cast, at the single seam `fakeApp` below owns, the
 * same convention `test/helpers.ts`'s `makeHost` uses for the same reason:
 * real types checked everywhere, substituted only at the one line honest
 * about doing it.
 *
 * `isReal` here is a hand-rolled stand-in for the five call sites' own
 * predicates (`isFileExplorerView`, `isFileExplorerViewLike`,
 * `isFileExplorerFocusView`, `isFileExplorerViewHandle`) — it exists only to
 * drive the four finders through their one shared branch: "does this leaf's
 * view pass the caller's own realness check." What each production predicate
 * actually probes for is exercised by its own call site's behaviour, not
 * here.
 */
import type { App, View } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { actingExplorerView, explorerViews, firstExplorerView, focusedExplorerView } from '../src/fileExplorerLeaves';

interface RealView extends View {
	readonly real: true;
	readonly name: string;
}

function isReal(view: View): view is RealView {
	return (view as Partial<RealView>).real === true;
}

/** A view that would pass `isReal` — stands in for a fully-constructed file explorer view. */
function real(name: string): RealView {
	return { real: true, name } as unknown as RealView;
}

/** A view that would fail `isReal` — stands in for a still-deferred leaf's placeholder view. */
function deferred(): View {
	return {} as unknown as View;
}

/**
 * A real view whose `containerEl` answers `contains(activeElement)` with
 * `focused`. Each view gets its own `ownerDocument` object, which is the
 * arrangement `focusedExplorerView` reads deliberately — a popped-out explorer
 * lives in a different document with its own `activeElement`.
 */
function realWithFocus(name: string, focused: boolean): RealView {
	const activeElement = { el: name };
	return {
		real: true,
		name,
		containerEl: {
			ownerDocument: { activeElement },
			contains: (node: unknown) => focused && node === activeElement,
		},
	} as unknown as RealView;
}

/**
 * The one seam between the fake and the real `App` type: a `workspace` whose
 * `getLeavesOfType` answers with exactly the leaves the test hands in,
 * regardless of the `type` argument — `fileExplorerLeaves.ts` only ever asks
 * for one type, so there is nothing to filter here.
 */
function fakeApp(leaves: readonly { view: unknown }[]): App {
	return {
		workspace: {
			getLeavesOfType: () => leaves,
		},
	} as unknown as App;
}

describe('firstExplorerView', () => {
	it('a deferred leaf ahead of a real one: returns the real view, not undefined and not the deferred one', () => {
		const realView = real('explorer');
		const app = fakeApp([{ view: deferred() }, { view: realView }]);

		expect(firstExplorerView(app, isReal)).toBe(realView);
	});

	it('no leaves at all: undefined', () => {
		const app = fakeApp([]);

		expect(firstExplorerView(app, isReal)).toBeUndefined();
	});

	it('every leaf deferred: undefined', () => {
		const app = fakeApp([{ view: deferred() }, { view: deferred() }]);

		expect(firstExplorerView(app, isReal)).toBeUndefined();
	});

	it('two real views open: returns the first one', () => {
		const first = real('a');
		const second = real('b');
		const app = fakeApp([{ view: first }, { view: second }]);

		expect(firstExplorerView(app, isReal)).toBe(first);
	});
});

describe('explorerViews', () => {
	it('returns every real view and skips deferred ones, order preserved', () => {
		const first = real('a');
		const second = real('b');
		const app = fakeApp([{ view: deferred() }, { view: first }, { view: deferred() }, { view: second }]);

		expect(explorerViews(app, isReal)).toEqual([first, second]);
	});

	it('no leaves at all: []', () => {
		const app = fakeApp([]);

		expect(explorerViews(app, isReal)).toEqual([]);
	});

	it('every leaf deferred: []', () => {
		const app = fakeApp([{ view: deferred() }, { view: deferred() }]);

		expect(explorerViews(app, isReal)).toEqual([]);
	});

	it('two explorers open: returns both, the case a resort must reach every one for', () => {
		const first = real('a');
		const second = real('b');
		const app = fakeApp([{ view: first }, { view: second }]);

		expect(explorerViews(app, isReal)).toEqual([first, second]);
	});
});

describe('focusedExplorerView', () => {
	it('two explorers open, the second focused: returns the second, not the first', () => {
		// H5: reading `[0]` here meant a drag in the second explorer computed
		// its order from the first one's sort setting and wrote that.
		const first = realWithFocus('a', false);
		const second = realWithFocus('b', true);
		const app = fakeApp([{ view: first }, { view: second }]);

		expect(focusedExplorerView(app, isReal)).toBe(second);
	});

	it('no view focused: undefined, so callers fall back to the first', () => {
		const app = fakeApp([{ view: realWithFocus('a', false) }, { view: realWithFocus('b', false) }]);

		expect(focusedExplorerView(app, isReal)).toBeUndefined();
	});

	it('a deferred leaf ahead of the focused one: still finds it', () => {
		// The realness probe has to run before `containerEl` is touched at all
		// — a deferred leaf's placeholder view has no such element.
		const focused = realWithFocus('a', true);
		const app = fakeApp([{ view: deferred() }, { view: focused }]);

		expect(focusedExplorerView(app, isReal)).toBe(focused);
	});

	it('no leaves at all: undefined', () => {
		expect(focusedExplorerView(fakeApp([]), isReal)).toBeUndefined();
	});
});

describe('actingExplorerView', () => {
	it('prefers the focused explorer', () => {
		const first = realWithFocus('a', false);
		const second = realWithFocus('b', true);
		const app = fakeApp([{ view: first }, { view: second }]);

		expect(actingExplorerView(app, isReal)).toBe(second);
	});

	it('falls back to the first real one when none has focus', () => {
		// The state every command-palette evaluation is in — the palette input
		// holds the focus, so no explorer does.
		const first = realWithFocus('a', false);
		const second = realWithFocus('b', false);
		const app = fakeApp([{ view: first }, { view: second }]);

		expect(actingExplorerView(app, isReal)).toBe(first);
	});

	it('skips deferred leaves on both paths', () => {
		const focused = realWithFocus('b', true);
		expect(actingExplorerView(fakeApp([{ view: deferred() }, { view: focused }]), isReal)).toBe(focused);

		const unfocused = realWithFocus('b', false);
		expect(actingExplorerView(fakeApp([{ view: deferred() }, { view: unfocused }]), isReal)).toBe(unfocused);
	});

	it('no leaves at all: undefined', () => {
		expect(actingExplorerView(fakeApp([]), isReal)).toBeUndefined();
	});
});
