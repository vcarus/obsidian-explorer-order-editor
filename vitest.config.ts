import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
	},
	resolve: {
		// Test-only, and it stays that way by construction: the production
		// build lists `obsidian` as external (`esbuild.config.mjs`) and never
		// resolves the import at all, and `tsconfig.json` compiles `src/`
		// alone. Nothing in this file is read by either. See the stub's own
		// header for the much more important limit — what it may be used to
		// assert, and what it must never be trusted for.
		//
		// `import.meta.dirname` rather than `node:url`: importing a Node
		// builtin here trips `obsidianmd/no-nodejs-modules`, which is right
		// about plugin code and has no way to know this file is never shipped.
		// `eslint.config.mts` already resolves its own root the same way.
		alias: {
			obsidian: `${import.meta.dirname}/test/stubs/obsidian.ts`,
		},
	},
});
