/**
 * Post-build assertion: the emitted bundle must contain every marker the
 * current source declares.
 *
 * Why this exists: `tsdown` bundles `lib/types/**` (the `tsc` output), not
 * `src/`. Running tsdown alone therefore re-emits the PREVIOUS build, and a
 * fix can ship, pass CI, and still not be in the artifact the host loads. That
 * happened for real: three fixes went out while every build silently produced
 * stale output, so "rebuilt and it changed nothing" looked like a code bug.
 *
 * Each marker below is a name or literal that only exists when the matching
 * source file made it into the bundle. Adding a fix that must be observable
 * from outside? Add its marker here.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'lib', 'index.js'), 'utf8')

/** @type {readonly { marker: string, why: string }[]} */
const REQUIRED = [
  { marker: 'cachedPredecessorTitle', why: 'L1 predecessor-title face (session discovery titles)' },
  { marker: 'shortId', why: 'non-prefixed short session id in tool output' },
  { marker: 'onPersistError', why: 'title-cache write failure reporting' },
  { marker: 'dsh-s2s', why: 'producer-owned message source kind' },
]

const missing = REQUIRED.filter(({ marker }) => !bundle.includes(marker))
if (missing.length > 0) {
  console.error('verify-bundle: lib/index.js is STALE — missing markers:')
  for (const { marker, why } of missing) console.error(`  - ${marker}  (${why})`)
  console.error('\nDid you run `tsdown` without `tsc`? The bundle reads lib/types/, which tsc produces.')
  console.error('Run the full build: npm run build')
  process.exit(1)
}
console.log(`verify-bundle: ok — ${REQUIRED.length} markers present in lib/index.js`)
