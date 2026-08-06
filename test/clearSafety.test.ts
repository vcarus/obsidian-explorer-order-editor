import { describe, expect, it } from 'vitest';
import { parseSortingSpec, removeFolderOrder, serializeSortingSpec } from '../src/sortspec';

describe('clear order: never deletes hand-written config', () => {
	it('leaves a foreign single-target section alone', () => {
		const hand = ['target-folder: .', '// my own notes', 'Zed', '  > a-z'].join('\n');
		const spec = parseSortingSpec(hand, 'Notes');
		const r = removeFolderOrder(spec, '.');
		expect(r.status).not.toBe('removed');
		expect(serializeSortingSpec(r.spec)).toBe(hand);
	});

	it('removes only our section, leaving a neighbouring foreign one intact', () => {
		const mixed = [
			'target-folder: Archive',
			'// hand written',
			'Zed',
			'target-folder: .',
			'// explorer-order-editor',
			'a',
			'b',
		].join('\n');
		const r = removeFolderOrder(parseSortingSpec(mixed, 'Notes'), '.');
		expect(r.status).toBe('removed');
		const out = serializeSortingSpec(r.spec);
		expect(out).toBe(['target-folder: Archive', '// hand written', 'Zed'].join('\n'));
	});
});
