/**
 * dsh-s2s types.
 *
 * Injected messages declare a producer-owned source kind
 * (`{ kind: 'dsh-s2s' }`), not the retired `plugin` wrapper. DSH session
 * format v4 refuses `{ kind: 'plugin', … }` at write admission
 * (`format v4 message requires a producer-owned source kind`), which aborts
 * the whole turn, so the wrapper must not be reintroduced.
 * @module dsh-s2s/types
 */
export {}
