// Validates the dashboard's CLIENT script as the browser will receive it.
// node --check on dashboard.js never parses the PAGE template's contents, and
// template-literal escapes (\n, \\) change between source and served bytes —
// a single lost backslash once shipped a client-side SyntaxError (0.9.7).
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../server/dashboard.js', import.meta.url), 'utf8')
const tpl = src.match(/const PAGE = \/\* html \*\/ `([\s\S]*?)`\n/)?.[1]
if (!tpl) { console.error('PAGE template not found'); process.exit(1) }

// Evaluate template-literal escapes the way JS does (no ${} interpolations used).
const page = tpl.replace(/\\`/g, '`').replace(/\\\\/g, '\x00').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\x00/g, '\\')
const js = page.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1]
if (!js) { console.error('client <script> not found'); process.exit(1) }

try {
  new vm.Script(js, { filename: 'dashboard-client.js' })
  console.log('client script parses as served:', js.length, 'bytes OK')
} catch (err) {
  console.error('SERVED CLIENT SYNTAX ERROR:', err.message)
  process.exit(1)
}
