import { describe, expect, it } from 'vitest';
import { aroundPrototypeMethod } from '../src/patch';

describe('aroundPrototypeMethod', () => {
	it('installs a wrapper that delegates to the factory-produced function', () => {
		const proto: Record<string, unknown> = {
			greet: (name: string) => `hello ${name}`,
		};
		const calls: string[] = [];

		aroundPrototypeMethod(proto, 'greet', (original: (name: string) => string) => {
			return (name: string) => {
				calls.push(name);
				return `${original(name)}!`;
			};
		});

		const fn = proto.greet as (name: string) => string;
		expect(fn('world')).toBe('hello world!');
		expect(calls).toEqual(['world']);
	});

	it('preserves the call-time `this` binding through the wrapper', () => {
		const proto: Record<string, unknown> = {
			label(this: { name: string }): string {
				return `label:${this.name}`;
			},
		};
		aroundPrototypeMethod(proto, 'label', (original: (this: { name: string }) => string) => {
			return function (this: { name: string }): string {
				return `wrapped(${original.call(this)})`;
			};
		});

		const instance = { name: 'alice', label: proto.label as (this: { name: string }) => string };
		expect(instance.label()).toBe('wrapped(label:alice)');
	});

	it('remove restores the original function reference', () => {
		const original = (n: number) => n + 1;
		const proto: Record<string, unknown> = { inc: original };

		const remove = aroundPrototypeMethod(proto, 'inc', (orig: (n: number) => number) => (n: number) => orig(n) * 10);

		expect(proto.inc).not.toBe(original);
		expect((proto.inc as (n: number) => number)(4)).toBe(50);

		remove();
		expect(proto.inc).toBe(original);
	});

	it('installs nothing when the member is not a function', () => {
		const proto: Record<string, unknown> = { value: 42 };

		const remove = aroundPrototypeMethod(proto, 'value', ((orig: unknown) => orig) as never);

		expect(proto.value).toBe(42);
		expect(() => remove()).not.toThrow();
		expect(proto.value).toBe(42);
	});

	it('double-remove is a no-op the second time', () => {
		const original = () => 'orig';
		const proto: Record<string, unknown> = { m: original };

		const remove = aroundPrototypeMethod(proto, 'm', (orig: () => string) => () => `${orig()}+patched`);

		remove();
		expect(proto.m).toBe(original);

		expect(() => remove()).not.toThrow();
		expect(proto.m).toBe(original);
	});

	it('stacked patches: removing the inner one first leaves the outer installed and calling through, without clobbering it; removing the outer one afterward fully restores the original', () => {
		const calls: string[] = [];
		const original = (x: number): number => {
			calls.push(`original(${x})`);
			return x;
		};
		const proto: Record<string, unknown> = { run: original };

		const removeInner = aroundPrototypeMethod(proto, 'run', (orig: (x: number) => number) => (x: number) => {
			calls.push('inner-before');
			const result = orig(x) + 1;
			calls.push('inner-after');
			return result;
		});
		const wrapperAfterInnerInstall = proto.run;

		const removeOuter = aroundPrototypeMethod(proto, 'run', (orig: (x: number) => number) => (x: number) => {
			calls.push('outer-before');
			const result = orig(x) * 2;
			calls.push('outer-after');
			return result;
		});
		const wrapperAfterOuterInstall = proto.run;

		// Sanity: both layers run, inner closest to the original.
		calls.length = 0;
		expect((proto.run as (x: number) => number)(5)).toBe(12); // (5 + 1) * 2
		expect(calls).toEqual(['outer-before', 'inner-before', 'original(5)', 'inner-after', 'outer-after']);

		// Remove the inner patch while the outer one is still installed.
		removeInner();

		// The outer wrapper must still be the installed function, untouched —
		// removing the inner patch must not restore `original` over it.
		expect(proto.run).toBe(wrapperAfterOuterInstall);
		expect(proto.run).not.toBe(wrapperAfterInnerInstall);

		// Calling now: outer wrapper -> its "original" (the inner wrapper
		// object, now degraded to a pass-through) -> the real original. The
		// inner patch's own logic (the +1, and its before/after calls) must
		// no longer run.
		calls.length = 0;
		expect((proto.run as (x: number) => number)(5)).toBe(10); // 5 * 2, no +1
		expect(calls).toEqual(['outer-before', 'original(5)', 'outer-after']);

		// Now remove the outer patch too: it is still literally installed, so
		// this restores outer's own captured "original" — which is the inner
		// wrapper's function object (captured back when the outer patch was
		// installed, before the inner one was removed), not the true root
		// original. Each remover only ever knows about the one layer directly
		// below it; that inner wrapper is by now a pass-through, so the net
		// effect still behaves exactly like the real original.
		removeOuter();
		expect(proto.run).toBe(wrapperAfterInnerInstall);
		expect(proto.run).not.toBe(original);

		calls.length = 0;
		expect((proto.run as (x: number) => number)(5)).toBe(5);
		expect(calls).toEqual(['original(5)']);

		// Both removers stay safe to call again. Calling removeInner() a
		// second time is not a true no-op here, because the state it sees has
		// changed since its first call: with the outer patch now gone,
		// `proto.run` is once again literally inner's own wrapper (restored
		// there by removeOuter() above), so this second call finally clears
		// it back to the true original — the deferred cleanup inner's first
		// call (correctly) skipped while the outer patch was still on top.
		expect(() => {
			removeInner();
			removeOuter();
		}).not.toThrow();
		expect(proto.run).toBe(original);
	});
});
