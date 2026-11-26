// T-173 — flat-config typescript-eslint, type-aware, wired into the quality gate.
//
// Scope is deliberately narrow: the repo's manual hygiene is already good (fire-and-forget
// promises consistently `void`-marked), so this config targets the specific silent-bug classes
// named in the ticket rather than adopting a preset wholesale —
// `typescript-eslint/recommended-type-checked`'s no-unsafe-* family and
// `eslint-plugin-react-hooks`'s newer React-Compiler rules (static-components, purity,
// immutability, set-state-in-render, gating, …) would each open a large, unrelated triage
// surface this ticket isn't asking for. Prettier is deliberately skipped — style is already
// consistent.
//
// Five non-overlapping file globs map onto the repo's five tsconfigs (each project's
// `include` may overlap on paper — src/shared/** is included by most — but the globs
// below never do, so every file is type-checked against exactly one program).
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import playwright from 'eslint-plugin-playwright'

const tsconfigRootDir = import.meta.dirname

// Shared, non-type-aware hygiene: applied everywhere via tseslint.configs.base +
// the small `eslint-recommended` set (no-var/prefer-const/prefer-rest-params/prefer-spread;
// everything TypeScript itself already checks is left off). `no-duplicate-imports` is a
// core ESLint rule (no plugin needed) — the "import hygiene" target from the ticket.
// `allowSeparateTypeImports` — a value import and a same-module `import type` are a
// deliberate, common pattern here (isolatedModules-friendly), not a duplication bug.
const baseHygieneRules = {
  'no-var': 'error',
  'prefer-const': 'error',
  'prefer-rest-params': 'error',
  'prefer-spread': 'error',
  'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }]
}

// Type-aware rules, hand-picked to the ticket's named bug classes:
//  - no-floating-promises / no-misused-promises: the fire-and-forget class (also what makes
//    eslint-plugin-playwright's missing-playwright-await meaningful — a floating promise
//    inside a spec is the same bug as a missing `await expect(...)`).
//  - no-unused-vars: broader than tsconfig's noUnusedLocals/noUnusedParameters (rest-sibling
//    destructuring, catch-clause bindings); `_`-prefixed names are the escape hatch.
//  - no-explicit-any: `warn`. `npm run lint` runs with `--max-warnings 0`, so a warning fails the
//    gate exactly like an error: the severity only labels the rule (it matters for `eslint --quiet`).
//    The `any`s that remain are each suppressed on their line with the reason.
const typeAwareRules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true
    }
  ],
  '@typescript-eslint/no-explicit-any': 'warn'
}

function typeAwareProject(project) {
  return {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project, tsconfigRootDir }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { ...baseHygieneRules, ...typeAwareRules }
  }
}

export default tseslint.config(
  {
    ignores: [
      'private/**',
      'out/**',
      'dist/**',
      'dist-electron/**',
      'release/**',
      'build/**',
      // the family apps' built bundles a release copies in (gitignored, not our source)
      'bundled/**',
      'test-results/**',
      'playwright-report/**',
      '**/*.d.ts',
      // vitest.config.ts is a standalone root config file not covered by any of the five
      // tsconfig projects (node/web/e2e/scripts/cli) this config type-checks against.
      'vitest.config.ts'
    ]
  },
  tseslint.configs.base,
  {
    name: 'pomade/main-preload',
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'electron.vite.config.ts',
      'electron.vite.dev-react.config.ts'
    ],
    ...typeAwareProject(['tsconfig.node.json'])
  },
  {
    name: 'pomade/shared',
    files: ['src/shared/**/*.ts'],
    ...typeAwareProject(['tsconfig.node.json'])
  },
  {
    // E-042 — git-core: the git logic the main process and the `pomade-git` command share (D4).
    // It never imports Electron or the main process, so the command runs with Pomade closed.
    name: 'pomade/git-core',
    files: ['src/git-core/**/*.ts'],
    ...typeAwareProject(['tsconfig.node.json'])
  },
  {
    name: 'pomade/git-core-imports',
    files: ['src/git-core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'git-core runs in the pomade-git command too: no Electron.' }],
          patterns: [{ group: ['**/main/*', '@renderer/*'], message: 'git-core never imports the main process or the renderer.' }]
        }
      ]
    }
  },
  {
    name: 'pomade/renderer',
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...typeAwareProject(['tsconfig.web.json']),
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks
    },
    rules: {
      ...baseHygieneRules,
      ...typeAwareRules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error'
    }
  },
  {
    // E-027 — the `pomade` command (bin/pomade runs it under Node type stripping).
    name: 'pomade/cli',
    files: ['src/cli/**/*.ts'],
    ...typeAwareProject(['tsconfig.cli.json'])
  },
  {
    name: 'pomade/scripts',
    files: ['scripts/**/*.mjs'],
    ...typeAwareProject(['tsconfig.scripts.json'])
  },
  {
    name: 'pomade/e2e',
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    ...typeAwareProject(['tsconfig.e2e.json']),
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      playwright
    },
    rules: {
      ...baseHygieneRules,
      ...typeAwareRules,
      ...playwright.configs['flat/recommended'].rules,
      // Spec helpers whose whole job is an assertion: a test that only calls them asserts.
      'playwright/expect-expect': [
        'warn',
        { assertFunctionNames: ['expectHitTarget', 'expectTooltip', 'savedIs', 'savedContains'] }
      ]
    }
  }
)
