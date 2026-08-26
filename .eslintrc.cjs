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
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
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