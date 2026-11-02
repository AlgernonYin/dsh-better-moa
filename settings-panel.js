/*
 * Node-only offline test adapter for the Better MoA browser panel.
 *
 * Harness ModuleLoader does not resolve relative require() specifiers, so the
 * production panel is self-contained in client.js. This helper evaluates that
 * exact file with a minimal ModuleLoader/React test double. It is intentionally
 * not imported by the browser and is not a duplicate panel implementation.
 */
import { readFile } from 'node:fs/promises'

/**
 * Evaluate the real client.js and return its captured module exports.
 * `clientPath` is an offline-test override only; the default is the shipped client.
 */
export async function loadMoaClientModule(react, { clientPath } = {}) {
  const source = await readFile(clientPath || new URL('./client.js', import.meta.url), 'utf8')
  let registration
  const window = {
    __ModuleLoader__: {
      load(entry) {
        if (registration) throw new Error('client.js registered more than one module')
        registration = entry
      },
    },
  }
  // client.js is a classic browser script, not an ESM module. Function keeps the
  // test objects in Node's realm so deep equality checks remain useful.
  new Function('window', `"use strict";\n${source}`)(window)
  if (!registration || typeof registration.factory !== 'function') {
    throw new Error('client.js did not call window.__ModuleLoader__.load()')
  }
  const required = []
  const require = (specifier) => {
    required.push(specifier)
    if (specifier === 'react') return react
    throw new Error(`Unexpected browser dependency: ${specifier}`)
  }
  require.async = async (specifier) => {
    if (specifier === './client.advice-renderer.js') return import('./advice-renderer.js')
    throw new Error(`Unexpected lazy browser dependency: ${specifier}`)
  }
  const exports = registration.factory(require)
  return { exports, registration, required, source, window }
}

/**
 * Tiny React hook/element double for offline structure tests. It does not claim
 * DOM, layout, accessibility-tree or visual verification.
 */
export function createReactStub() {
  let id = 0
  return {
    createElement(type, props, ...children) {
      return {
        type,
        props: {
          ...(props || {}),
          ...(children.length ? { children: children.flat(Infinity) } : {}),
        },
      }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useId() {
      id += 1
      return `test-${id}`
    },
  }
}
