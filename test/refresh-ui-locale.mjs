// Diagnostic snapshot of the shipped client LOCALES table, not a second runtime dictionary.
// Regenerate after intentional UI wording changes with the matching client module.
// Run: node moa-selftest/refresh-ui-locale.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMoaClientModule } from '../settings-panel.js'

const here = dirname(fileURLToPath(import.meta.url))
// Defaults describe the shipped client and snapshot. The offline test overrides
// both so it can prove the script reproduces the committed bytes and detects a
// drifted client without touching the repository files.
const clientPath = process.env.MOA_CLIENT_PATH
  || resolve(here, '../client.js')
const path = process.env.MOA_LOCALE_SNAPSHOT
  || resolve(here, 'ui-locale.json')

// loadMoaClientModule is async (it reads client.js). The previous version used
// its Promise directly, so NS/LOCALES were undefined, JSON.stringify dropped
// both keys and the file was written as "{}".
const { exports: client } = await loadMoaClientModule({
  createElement() { return {} },
  useState() { return [undefined, () => {}] },
  useEffect() {},
  useId() { return 'refresh' },
}, { clientPath })
if (typeof client.NS !== 'string' || !client.NS) throw new Error('client.js exported no settings namespace')
if (!client.LOCALES || typeof client.LOCALES !== 'object') throw new Error('client.js exported no LOCALES table')
for (const code of ['zh', 'en']) {
  if (!client.LOCALES[code] || typeof client.LOCALES[code] !== 'object') throw new Error(`LOCALES.${code} is missing`)
  if (!Object.keys(client.LOCALES[code]).length) throw new Error(`LOCALES.${code} is empty`)
}

// Compare the exact bytes that would be written, not a re-parsed object, so key
// order and formatting drift also count as a difference.
const output = `${JSON.stringify({ namespace: client.NS, locales: client.LOCALES }, null, 2)}\n`
const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
if (before === output) {
  console.log(`Diagnostic locale snapshot already matches the client (${path})`)
} else {
  writeFileSync(path, output, 'utf8')
  console.log(`Updated the diagnostic locale snapshot from dsh-better-moa/client.js (${path})`)
}