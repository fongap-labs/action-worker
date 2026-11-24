import { test, assert } from '../../kit/harness.mjs'
import { targetRoot as root } from '../../kit/target.mjs'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, relative, dirname, sep } from 'node:path'
const read = path => readFileSync(resolve(root, path), 'utf8')
const json = path => JSON.parse(read(path))
const contract = json('projects/architecture.json')

test('architecture contract rollout is complete when any new governance artifact exists', () => {
  assert.equal(contract.schema_version, 1)
  for (const path of [
    'docs/ARCHITECTURE_GOVERNANCE.md',
    'projects/delta-code/architecture-mece.json',
    'projects/delta-code/feature-readiness.json',
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

test('Suite mounted Host feature IDs agree with the MECE contract', () => {
  const architecture = json('projects/delta-suite/architecture-mece.json')
  const source = read('packages/delta-suite/src/delta-suite-composition.ts')
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
