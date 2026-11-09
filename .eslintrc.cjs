module.exports = {
  root: true,
  env: {
    browser: true,
    es2020: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'prettier',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: './tsconfig.eslint.json',
  },
  plugins: ['@typescript-eslint', 'prettier'],
  rules: {
    // Prettier integration
    'prettier/prettier': 'error',

    // TypeScript specific rules
    // caughtErrors: 'none' restores the v6 default — v8 changed the default to
    // 'all' and flagged 27 unused catch params (`catch (error) { /* ignore */ }`)
    // in one sweep. Deliberate: silent catch-and-ignore stays legal.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', caughtErrors: 'none' },
    ],
    // OFF (2026-08-22, user decision): 695 warnings of pure style; retrofitting
    // return types across the codebase has no safety value. Re-enable only if
    // the codebase is typed strictly enough that violations are rare.
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-inferrable-types': 'off',
    // MISFIRING under @typescript-eslint v6 + TS 5.x type info: removes legit
    // downcast assertions (Element → HTMLInputElement) as "unnecessary" —
    // broke the build 178× on 2026-08-22. Assertions here are intentional.
    '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    // checksVoidReturn OFF (2026-08-24): async callbacks passed to void-returning
    // APIs (addEventListener, EventBus.on, option objects like Switch.onChange,
    // InfiniteScroll) discard the promise BY DESIGN — 233 such sites, all
    // intentional fire-and-forget. IIFE-wrapping them is churn without runtime
    // benefit. The rule's other checks (await-thenable, promise-in-condition)
    // stay active. Real bugs of this class (async promise executors) were fixed
    // in AuthService/ZapService instead of suppressed.
    '@typescript-eslint/no-misused-promises': [
      'error',
      { checksVoidReturn: false },
    ],

    // Performance and best practices
    // console.debug is the sanctioned DevTools-only channel (log-review skill);
    // console.warn/error are allowed escape hatches. log/info are violations.
    'no-console': ['warn', { allow: ['warn', 'error', 'debug'] }],
    'no-debugger': 'error',
    'prefer-const': 'error',
    'no-var': 'error',

    // Code style
    'camelcase': ['error', { properties: 'never' }],
    'prefer-template': 'error',
    'object-shorthand': 'error',
    'prefer-arrow-callback': 'error',

    // Error prevention
    'no-duplicate-imports': 'error',
    'no-unreachable': 'error',
    'no-unused-expressions': 'error',
    'eqeqeq': ['error', 'always'],

    // Async/await best practices
    // Core require-await OFF — duplicates @typescript-eslint/require-await
    // (every site was double-counted). The TS variant's real bug value
    // (missing internal awaits) is covered by @typescript-eslint/await-thenable.
    // 'require-await': removed 2026-08-24
    '@typescript-eslint/require-await': 'off', // 2026-08-24: remaining ~70 sites are
    // intentional contract-async (manager wrappers, lifecycle symmetry) — same
    // rationale as explicit-function-return-type. runtime.ts override kept for
    // documentation purposes.
    'no-return-await': 'error',

    // v1/v2 boundary (2026-11-09): the v2 Focus Shell is a self-contained
    // mount layer (src/shell/**). Classic code must NEVER build v2 behavior
    // or import shell building blocks — the ONLY sanctioned seam outside the
    // shell is src/helpers/focusUiSetting.ts (mount/unmount switch, see the
    // overrides below). Reading the FLAG itself (isFocusUiEnabled) in
    // LayoutService/UISettingsSection is fine: those are the sanctioned
    // decision points, they don't import shell code.
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/shell/**', '**/shell'],
            message:
              'v1/v2 boundary: src/shell/** is the v2 Focus Shell layer. Import it only from src/helpers/focusUiSetting.ts (mount seam) or within src/shell itself. Classic components must not reach into v2.',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // Module/addon runtime entry points implement the AddonRuntime /
      // module lifecycle contract (async init/destroy) — often with no
      // internal await on purpose (no-op runtimes). require-await must not
      // flag interface compliance.
      files: ['**/runtime.ts'],
      rules: {
        '@typescript-eslint/require-await': 'off',
      },
    },
    {
      // Test files
      files: ['**/*.test.ts', '**/*.spec.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        'no-console': 'off',
      },
    },
    {
      // v1/v2 boundary sanctioned seams (see no-restricted-imports above):
      // - src/shell/** is the v2 layer itself — internal imports are the rule.
      // - src/helpers/focusUiSetting.ts is the ONLY v1-side module allowed to
      //   import the shell (mount/unmount switch).
      files: ['src/shell/**', 'src/helpers/focusUiSetting.ts'],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
    {
      // Configuration files
      files: ['*.config.js', '*.config.ts', '.eslintrc.cjs', 'vitest.config.ts'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        'no-console': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '*.d.ts'],
};