import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

/**
 * Vitest reuses the app's Vite config (plugins, aliases, define) and adds one
 * thing: the Playwright specs under `e2e/` are not unit tests.
 *
 * They are named `*.spec.ts`, which Vitest collects by default — and a
 * Playwright `test()` called from Vitest fails with a confusing message about
 * two copies of @playwright/test. Excluding them here keeps `npm test` and
 * `npm run e2e` as two separate, honest commands.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // e2e/ are Playwright specs, not unit tests; the vendored
      // blueprint3d-modern core ships its own suite tuned to its repo.
      exclude: [...configDefaults.exclude, "e2e/**", "src/lib/modelstudio/vendor/**"],
    },
  }),
);
