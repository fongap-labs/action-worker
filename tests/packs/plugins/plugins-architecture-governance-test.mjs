import { test, assert } from '../../kit/harness.mjs'
import { targetRoot as root } from '../../kit/target.mjs'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, relative, dirname, sep } from 'node:path'
const read = path => readFileSync(resolve(root, path), 'utf8')
const json = path => JSON.parse(read(path))
const contract = json('projects/architecture.json')
const migrationPresent = existsSync(resolve(root, 'packages/delta-ui/package.json'))

test('architecture contract rollout is complete when any new governance artifact exists', {
  skip: migrationPresent ? false : 'Delta UI product migration is not present in this target revision',
}, () => {
  assert.equal(contract.schema_version, 1)
  for (const path of [
    'docs/ARCHITECTURE_GOVERNANCE.md',
    'projects/delta-code/architecture-mece.json',
    'projects/delta-code/feature-readiness.json',
    'projects/delta-ui/architecture-mece.json',
    'projects/delta-ui/feature-readiness.json',
    'projects/delta-suite/architecture-mece.json',
    'projects/delta-suite/feature-readiness.json',
  ]) assert.ok(existsSync(resolve(root, path)), 'missing required architecture artifact: ' + path)
})
const packages = [...contract.products, ...contract.internal_packages]
const unique = values => assert.equal(new Set(values).size, values.length)

test('workspace package identity, product manifests and capability ownership agree', () => {
  assert.equal(contract.schema_version, 1)
  unique(packages.map(p => p.package))
  unique(packages.flatMap(p => p.capabilities))
  for (const product of contract.products) {
    assert.ok(product.architecture && product.readiness, 'missing product contract paths: ' + product.id)
  }
  const actual = readdirSync(resolve(root, 'packages'), { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(resolve(root, 'packages', e.name, 'package.json')))
    .map(e => 'packages/' + e.name).sort()
  assert.deepEqual(actual, packages.map(p => p.path).sort())
  const releaseProducts = readdirSync(resolve(root, 'projects'), { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(resolve(root, 'projects', e.name, 'release.manifest.json')))
    .map(e => e.name).sort()
  assert.deepEqual(releaseProducts, contract.products.map(p => p.id).sort())
  for (const p of packages) {
    const manifest = json(p.path + '/package.json')
    assert.equal(manifest.name, p.package)
    const dependencyNames = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies,
      ...manifest.peerDependencies, ...manifest.optionalDependencies })
    const internal = dependencyNames.filter(name => packages.some(other => other.package === name))
    assert.deepEqual(internal.sort(), [...p.allowed_workspace_dependencies].sort())
    if (p.architecture) {
      const architecture = json(p.architecture)
      unique(architecture.owners.map(owner => owner.id))
      unique(architecture.owners.flatMap(owner => owner.capabilities))
      assert.equal(json(p.readiness).schema_version, 1)
    }
  }
})

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) yield path
  }
}

test('literal source imports respect product boundaries', () => {
  for (const p of packages) {
    for (const path of sources(resolve(root, p.path, 'src'))) {
      const source = readFileSync(path, 'utf8')
      const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)
      for (const [, specifier] of imports) {
        const target = specifier.startsWith('.') ? resolve(dirname(path), specifier) : undefined
        for (const other of packages) {
          if (other === p) continue
          const prefix = resolve(root, other.path)
          if (specifier === other.package || specifier.startsWith(other.package + '/') ||
              target === prefix || target?.startsWith(prefix + sep)) {
            assert.ok(p.allowed_workspace_dependencies.includes(other.package),
              relative(root, path) + ' illegally imports ' + specifier)
          }
        }
      }
    }
  }
})

test('Code domain directories have exactly one declared owner', () => {
  const p = contract.products.find(p => p.id === 'delta-code')
  const architecture = json(p.architecture)
  const declared = architecture.owners.map(owner => owner.path).sort()
  unique(declared)
  const actual = readdirSync(resolve(root, p.path, 'src'), { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('delta-code-'))
    .map(e => p.path + '/src/' + e.name).sort()
  assert.deepEqual(actual, declared)
  for (const path of architecture.legacy_facades) assert.ok(existsSync(resolve(root, p.path, 'src', path)))
})

test('Delta UI mounted Host feature IDs agree with the MECE contract', {
  skip: migrationPresent ? false : 'Delta UI product migration is not present in this target revision',
}, () => {
  const architecture = json('projects/delta-ui/architecture-mece.json')
  const source = read('packages/delta-ui/src/delta-ui-composition.ts')
  const registered = Object.fromEntries([...source.matchAll(/registry\.register\(\{\s*id:\s*'([^']+)',\s*owner:\s*'([^']+)'/g)].map(([, id, owner]) => [id, owner]))
  assert.deepEqual(registered, architecture.host_feature_registration)
  for (const owner of Object.values(registered)) assert.ok(architecture.owners.some(o => o.id === owner))
})

test('governance document and machine-contract links are indexed', () => {
  const index = read('docs/README.md')
  for (const path of ['ARCHITECTURE.md', 'ARCHITECTURE_GOVERNANCE.md', 'DEVELOPMENT.md', 'OPERATIONS.md', 'SECURITY.md', 'COMPATIBILITY.md', '../projects/architecture.json']) {
    assert.ok(index.includes('](' + path + ')'), 'missing index link: ' + path)
    assert.ok(existsSync(resolve(root, 'docs', path)))
  }
})

function literalImports(source) {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)]
    .map(match => match[1])
}

test('plugin kernels have no external dependencies or internal module cycles', () => {
  for (const product of contract.products) {
    const kernel = resolve(root, product.path, 'src', product.id + '-kernel')
    if (product.id === 'delta-suite') {
      const core = resolve(root, product.path, 'src', 'core')
      const modularRoot = existsSync(core) ? core : kernel
      assert.ok(existsSync(modularRoot), 'missing Delta Suite modular core')
      assert.ok([...sources(modularRoot)].length > 0, 'empty Delta Suite modular core')
      continue
    }
    assert.ok(existsSync(kernel), 'missing product kernel: ' + product.id)
    const files = [...sources(kernel)]
    assert.ok(files.length > 0, 'empty product kernel: ' + product.id)
    const graph = new Map()
    for (const file of files) {
      const dependencies = literalImports(readFileSync(file, 'utf8')).map(specifier => {
        assert.ok(specifier.startsWith('.'), 'kernel imports external module: ' + relative(root, file) + ' -> ' + specifier)
        const resolved = resolve(dirname(file), specifier)
        assert.ok(resolved.startsWith(kernel + sep), 'kernel imports outside its boundary: ' + relative(root, file) + ' -> ' + specifier)
        const candidates = [resolved, resolved.replace(/\.js$/, '.ts'), resolved + '.ts', resolve(resolved, 'index.ts')]
        const target = candidates.find(candidate => files.includes(candidate))
        assert.ok(target, 'unresolved kernel dependency: ' + specifier)
        return target
      })
      graph.set(file, dependencies)
    }
    const visiting = new Set()
    const visited = new Set()
    function visit(file) {
      assert.ok(!visiting.has(file), 'cyclic kernel dependency: ' + relative(root, file))
      if (visited.has(file)) return
      visiting.add(file)
      for (const dependency of graph.get(file)) visit(dependency)
      visiting.delete(file)
      visited.add(file)
    }
    for (const file of files) visit(file)
  }
})

test('internal packages are not release products and runtime dependencies are bundled', () => {
  const internalNames = new Set(contract.internal_packages.map(p => p.package))
  for (const internal of contract.internal_packages) {
    const manifest = json(internal.path + '/package.json')
    assert.equal(internal.standalone_release, false)
    assert.ok(!manifest.dsh?.bundle?.patch, 'internal package declares a plugin release entry: ' + internal.package)
  }
  for (const product of contract.products) {
    const manifest = json(product.path + '/package.json')
    const bundled = manifest.bundleDependencies || manifest.bundledDependencies || []
    for (const [dependency, version] of Object.entries(manifest.dependencies || {})) {
      if (!internalNames.has(dependency)) continue
      assert.equal(version, 'workspace:*', 'internal runtime dependency must resolve from workspace: ' + dependency)
      assert.ok(bundled.includes(dependency), 'missing bundled runtime dependency: ' + dependency)
    }
    for (const dependency of bundled) {
      if (internalNames.has(dependency)) assert.ok(Object.hasOwn(manifest.dependencies || {}, dependency))
    }
  }
})


// Static source-boundary contract: type-only imports do not add runtime authority.
// This is intentionally a literal import check, not a complete TypeScript parser.
function boundaryRuntimeImports(source) {
  const withoutTypes = source.replace(
    /^[ \t]*import[ \t]+type\b[^;]*?\bfrom\s*['"][^'"\r\n]+['"][ \t]*;?/gm, '')
  return [...new Set(literalImports(withoutTypes))].sort()
}

test('declared Delta UI source boundaries have a single owner and bounded runtime dependencies', {
  skip: migrationPresent ? false : 'Delta UI product migration is not present in this target revision',
}, () => {
  const suite = contract.products.find(product => product.id === 'delta-ui')
  const architecture = json(suite.architecture)
  const boundaries = architecture.source_boundaries
  assert.ok(boundaries && boundaries.session_protection, 'missing established session protection boundary')
  const expected = [
    ['session_protection', 'security', 'delta-ui-security/session-protection.ts'],
    ['client_context_projection', 'context', 'client-context-projection.ts'],
    ['client_totp_qr', 'security', 'client-totp-qr.ts'],
  ]
  for (const [id, owner, relativePath] of expected) {
    const path = suite.path + '/src/' + relativePath
    assert.equal(boundaries[id]?.owner, owner, 'wrong source owner: ' + id)
    assert.equal(boundaries[id]?.path, path, 'wrong source path: ' + id)
    assert.ok(existsSync(resolve(root, path)), 'missing established source boundary: ' + id)
  }
  const declared = Object.values(boundaries)
  unique(declared.map(boundary => boundary.path))
  unique(declared.flatMap(boundary => boundary.public_functions))
  for (const boundary of declared) {
    assert.ok(architecture.owners.some(owner => owner.id === boundary.owner))
    const sourceRoot = resolve(root, suite.path, 'src')
    assert.ok(resolve(root, boundary.path).startsWith(sourceRoot + sep))
    const source = read(boundary.path)
    assert.deepEqual(boundaryRuntimeImports(source), [...boundary.allowed_runtime_imports].sort(),
      'runtime dependency drift: ' + boundary.path)
    for (const symbol of boundary.public_functions) {
      assert.match(symbol, /^[A-Za-z_$][A-Za-z0-9_$]*$/)
      assert.match(source, new RegExp('^(?:export\\s+)?(?:async\\s+)?(?:function|const|class)\\s+' + symbol.replace(/\$/g, '\\$') + '\\b', 'm'),
        'missing declared implementation: ' + symbol)
    }
    if (boundary.host_contract) {
      const hostContract = read(boundary.host_contract)
      assert.doesNotMatch(hostContract, /^\s*(?:export\s+)?(?:const|let|var|function|class|enum)\s/m,
        'workspace contract must remain types-only')
    }
    if (boundary.compatibility_entry) {
      const compatibility = read(boundary.compatibility_entry)
      for (const symbol of boundary.public_functions) {
        assert.match(compatibility, new RegExp('\\b' + symbol + '\\b'))
        assert.doesNotMatch(compatibility, new RegExp('^export\\s+(?:async\\s+)?(?:function|const|class)\\s+' + symbol + '\\b', 'm'),
          'compatibility entry must not duplicate the implementation: ' + symbol)
      }
    }
    if (boundary.runtime_entry) {
      assert.equal(boundary.runtime_entry, suite.path + '/lib/client.js')
      const relativeSource = boundary.path.slice(suite.path.length + 1)
      const clientConfig = json(suite.path + '/tsconfig.client.json')
      const hostConfig = json(suite.path + '/tsconfig.json')
      assert.ok(clientConfig.include.includes(relativeSource), 'missing browser helper input: ' + relativeSource)
      assert.ok(hostConfig.exclude.includes(relativeSource), 'browser helper leaks into Host build: ' + relativeSource)
      assert.doesNotMatch(source, /^\s*(?:import|export)\s/m,
        'single browser module helpers must remain self-contained scripts')
    }
  }
})


function assertProductRuntimeImportGraph(product, browserSources) {
  const sourceRoot = resolve(root, product.path, 'src')
  const files = [...sources(sourceRoot)].filter(file => !file.endsWith('.d.ts')).sort()
  assert.ok(files.length > 0, product.id + ' source graph must not be empty')
  const fileSet = new Set(files)
  const browser = new Set(browserSources.map(file => resolve(root, product.path, file)))
  for (const file of browser) assert.ok(fileSet.has(file), 'missing browser graph input: ' + relative(root, file))

  const graph = new Map()
  for (const file of files) {
    const targets = []
    for (const specifier of boundaryRuntimeImports(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      const candidate = resolve(dirname(file), specifier)
      assert.ok(candidate.startsWith(sourceRoot + sep),
        'relative dependency escapes ' + product.id + ' source: ' + relative(root, file) + ' -> ' + specifier)
      const target = [
        candidate, candidate.replace(/\.js$/, '.ts'), candidate.replace(/\.js$/, '.tsx'),
        candidate.replace(/\.mjs$/, '.mts'), candidate.replace(/\.cjs$/, '.cts'),
        candidate + '.ts', candidate + '.tsx', resolve(candidate, 'index.ts'),
      ].find(path => fileSet.has(path))
      assert.ok(target, 'unresolved relative dependency: ' + relative(root, file) + ' -> ' + specifier)
      assert.equal(browser.has(file), browser.has(target),
        'Host/browser import boundary crossed: ' + relative(root, file) + ' -> ' + relative(root, target))
      targets.push(target)
    }
    graph.set(file, targets)
  }

  const visiting = new Set()
  const visited = new Set()
  const stack = []
  function visit(file) {
    if (visiting.has(file)) {
      const cycle = [...stack.slice(stack.indexOf(file)), file].map(path => relative(root, path))
      assert.fail(product.id + ' internal runtime import cycle: ' + cycle.join(' -> '))
    }
    if (visited.has(file)) return
    visiting.add(file)
    stack.push(file)
    for (const dependency of graph.get(file)) visit(dependency)
    stack.pop()
    visiting.delete(file)
    visited.add(file)
  }
  for (const file of files) visit(file)
  assert.equal(visited.size, files.length)
}

test('Delta UI literal internal runtime import graph is resolvable, acyclic and Host/browser isolated', {
  skip: migrationPresent ? false : 'Delta UI product migration is not present in this target revision',
}, () => {
  const suite = contract.products.find(product => product.id === 'delta-ui')
  const config = json(suite.path + '/tsconfig.client.json')
  assertProductRuntimeImportGraph(suite, config.include.filter(file => !file.endsWith('.d.ts')))
})

test('Code literal internal runtime import graph is resolvable, acyclic and Host/browser isolated', () => {
  const code = contract.products.find(product => product.id === 'delta-code')
  const manifest = json(code.path + '/package.json')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  const client = read(code.path + '/src/client.ts')
  // The Host supplies React to the classic script through its loader factory;
  // it is not a package import. All other literal runtime dependencies remain forbidden.
  assert.doesNotMatch(client, /^\s*(?:import|export)\s/m,
    'Code classic browser script must not use static module syntax')
  assert.match(client, /function installClient\(require: \(id: string\) => unknown\)/)
  assert.match(client, /__ModuleLoader__\.load\(\{\s*id:\s*NAME,\s*factory:\s*installClient\s*\}\)/)
  assert.match(client, /\brequire\(['"]react['"]\)/)
  assert.deepEqual(boundaryRuntimeImports(client), ['react'],
    'Code classic browser script may use only the Host loader React dependency')
  assertProductRuntimeImportGraph(code, ['src/client.ts'])
})
