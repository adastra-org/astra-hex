// Publishes @adastra/hex if its current version is not on the public registry yet.
// CI (.github/workflows/publish.yml) uses npm Trusted Publishing (OIDC, no token). Bun packs the tarball and npm
// publishes it, because `bun publish` has no OIDC support.
// First release of a new package: Trusted Publishing needs the package to exist, so run `bun run release` once from a
// logged-in shell (`npm login`); npm asks for the 2FA code on the terminal.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const interactive = !process.env.CI

const run = async (cmd: string[], inherit = false) => {
  const p = Bun.spawn(cmd, {
    cwd: root,
    stdin: inherit ? 'inherit' : undefined,
    stdout: inherit ? 'inherit' : 'pipe',
    stderr: inherit ? 'inherit' : 'pipe',
    env: process.env,
  })
  if (inherit) return { code: await p.exited, text: '' }
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { code: await p.exited, text: (out + err).trim() }
}

const {
  name,
  version,
  private: isPrivate,
} = await Bun.file(join(root, 'package.json')).json()
if (isPrivate) {
  console.log(`skip ${name} (private)`)
  process.exit(0)
}
const spec = `${name}@${version}`
// `npm view` prints warnings on stderr: search the lines for the version, do not read the last one.
const info = await run(['npm', 'view', spec, 'version'])
if (
  info.code === 0 &&
  info.text
    .split('\n')
    .map((l) => l.trim())
    .includes(version)
) {
  console.log(`skip ${spec} (already published)`)
  process.exit(0)
}
// A package never published answers 404: that is the case this script exists for.
if (info.code !== 0 && !/E404|404 Not Found/i.test(info.text)) {
  console.error(`cannot check ${spec}: ${info.text}`)
  process.exit(1)
}
const out = mkdtempSync(join(tmpdir(), 'adastra-hex-pack-'))
try {
  const pack = await run(['bun', 'pm', 'pack', '--destination', out])
  const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'))
  if (pack.code !== 0 || !tarball) throw new Error(`pack failed\n${pack.text}`)
  const pub = await run(
    ['npm', 'publish', join(out, tarball), '--access', 'public'],
    interactive,
  )
  if (pub.code !== 0)
    throw new Error(pub.text || `npm publish exited ${pub.code}`)
  console.log(`published ${spec}`)
} catch (error) {
  console.error(
    `FAILED ${spec}\n${error instanceof Error ? error.message : error}`,
  )
  process.exitCode = 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
