// Consistency check for lib/client.js: every field the card reads or edits through the
// form model must be declared in the model's specs. A mismatch only throws at runtime.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const src = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

// Fields declared as form specs.
const specs = [...src.matchAll(/settings(?:Text|Number)Field\("([A-Za-z0-9_]+)"\)/g)].map(m => m[1])
// Fields read through this.form.field("...") in the projection.
const reads = [...src.matchAll(/this\.form\.field\("([A-Za-z0-9_]+)"\)/g)].map(m => m[1])
// Fields written through props.edit("...") in the card.
const edits = [...src.matchAll(/props\.edit\("([A-Za-z0-9_]+)"/g)].map(m => m[1])
// Secret specs (write-only controls).
const secretSpecs = [...src.matchAll(/\{\s*field:\s*"([A-Za-z0-9_]+)",\s*write:/g)].map(m => m[1])

console.log('specs       :', specs.join(', '))
console.log('secretSpecs :', secretSpecs.join(', '))
console.log('reads       :', [...new Set(reads)].join(', '))
console.log('edits       :', [...new Set(edits)].join(', '))

const declared = new Set([...specs, ...secretSpecs])
const problems = []
for (const f of new Set([...reads, ...edits])) {
  if (!declared.has(f)) problems.push(`field "${f}" is read/edited but not declared in the form model`)
}
// A declared field nobody edits is dead weight, not an error — report it separately.
const edited = new Set(edits)
for (const f of declared) {
  if (!edited.has(f)) console.log(`note: "${f}" is declared but never edited by the card`)
}

// The secret is declared as a write-only spec (third argument to SettingsFormModel).
// Reading it through form.field() is correct and expected: for a secret spec that method
// returns ONLY the staged draft text ({ text, overridden: false, invalid: false }), never
// the stored value. What must never happen is reading the secret out of the section value.
if (secretSpecs.length !== 1) problems.push(`expected exactly one write-only spec, found ${secretSpecs.length}`)
for (const s of secretSpecs) {
  if (specs.includes(s)) problems.push(`"${s}" is declared both as a value field and as a write-only secret`)
}
if (/value\.appSecret|snapshot\(\)\?\.value\?\.appSecret/.test(src)) {
  problems.push('the projection reads appSecret out of the section value; a secret must stay write-only')
}

if (problems.length > 0) {
  console.log('\nFAIL')
  problems.forEach(p => console.log('  - ' + p))
  process.exit(1)
}
console.log('\nPASS: every read/edited field is declared, and the secret stays write-only')
