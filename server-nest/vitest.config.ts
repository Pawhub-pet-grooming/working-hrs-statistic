import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  // Vite's default esbuild transform drops `emitDecoratorMetadata`, which Nest's DI
  // container reads to resolve constructor parameter types. swc.vite() restores it.
  plugins: [swc.vite()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
