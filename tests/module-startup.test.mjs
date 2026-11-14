import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('every named app import exists in the actual module used by the browser', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  for (const [, bindings, specifier] of app.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
    const module = await import(new URL(`../${specifier}`, import.meta.url));
    for (const binding of bindings.split(',').map(value => value.trim())) {
      assert.ok(binding in module, `${specifier} must export ${binding} so the app can start`);
    }
  }
});
