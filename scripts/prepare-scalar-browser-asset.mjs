import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const reactEntry = require.resolve('@scalar/api-reference-react')
const reactRoot = path.dirname(path.dirname(reactEntry))
const scalarEntry = createRequire(path.join(reactRoot, 'package.json')).resolve('@scalar/api-reference')
const scalarRoot = path.dirname(path.dirname(scalarEntry))
const source = path.join(scalarRoot, 'dist', 'browser', 'standalone.js')
const destination = path.resolve('public/vendor/scalar-api-reference.js')

await mkdir(path.dirname(destination), { recursive: true })
await copyFile(source, destination)
console.log('Prepared Scalar browser asset for the runtime docs boundary')
