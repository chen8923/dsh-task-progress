/**
 * Host-wiring tests: the route over a real HTTP server, the environment
 * contributor, and the entry point's own wiring — the three seams that a unit
 * test of the store alone would leave unproven.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_ROUTE, SETTINGS_NAMESPACE } from '../src/protocol.ts'
import { readConfig } from '../src/host/config.ts'
import { apply } from '../src/host/index.ts'
import { stateHandler, type ConnectionLike } from '../src/host/routes.ts'
import { PROGRESS_CLI_KEY, PROGRESS_DIR_KEY, registerProgressEnv, type ShellEnvLike } from '../src/host/shell-env.ts'
import { PROMPT_SECTION_NAME } from '../src/host/system-prompt.ts'
import { createTaskStore } from '../src/host/store.ts'

/** A store over a throwaway root with one session directory holding one task. */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dtp-host-'))
  const dir = join(root, '.dsh-progress', 'session-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'build.jsonl'), '{"task":"build","state":"running","pct":30,"msg":"linking"}\n', 'utf8')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Serve one handler on an ephemeral port and answer its base URL. */
async function serve(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no ephemeral port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

test('the state route serves the named session to a trusted caller', async () => {
  const f = fixtureRoot()
  const store = createTaskStore(readConfig({}))
  store.addRoot(f.root)
  store.scan()
  const trusted: ConnectionLike = { requestRejection: () => undefined }
  const http = await serve(stateHandler(trusted, store))
  try {
    const response = await fetch(`${http.url}?session=session-1`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json() as { v: number, pollMs: number, tasks: { task: string, pct: number, root?: unknown }[] }
    assert.equal(body.v, 1)
    assert.equal(body.pollMs, 2000)
    assert.deepEqual(body.tasks.map(task => [task.task, task.pct]), [['build', 30]])
    // The absolute workspace root is not on the wire at all: the panel never
    // needed it, and a filesystem path is not this endpoint's business.
    assert.equal('root' in (body.tasks[0] ?? {}), false)
  } finally {
    await http.close()
    f.cleanup()
  }
})

test('the state route answers for one session and never for everything', async () => {
  const f = fixtureRoot()
  // A second session's work exists in the same store, as it does in real use.
  const other = join(f.root, '.dsh-progress', 'session-2')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'secret-job.jsonl'), '{"task":"secret-job","pct":80}\n', 'utf8')
  const store = createTaskStore(readConfig({}))
  store.addRoot(f.root)
  store.scan()
  const trusted: ConnectionLike = { requestRejection: () => undefined }
  const http = await serve(stateHandler(trusted, store))
  try {
    const own = await (await fetch(`${http.url}?session=session-1`)).json() as { tasks: { task: string }[] }
    assert.deepEqual(own.tasks.map(task => task.task), ['build'])

    // A request that names no session gets an empty document, not the union of
    // every session this process knows about.
    const everything = await (await fetch(http.url)).json() as { tasks: unknown[] }
    assert.deepEqual(everything.tasks, [])
    const unknown = await (await fetch(`${http.url}?session=does-not-exist`)).json() as { tasks: unknown[] }
    assert.deepEqual(unknown.tasks, [])
  } finally {
    await http.close()
    f.cleanup()
  }
})

test('the state route refuses an untrusted caller before reading anything', async () => {
  const f = fixtureRoot()
  const store = createTaskStore(readConfig({}))
  store.addRoot(f.root)
  const fenced: ConnectionLike = { requestRejection: () => 403 }
  const http = await serve(stateHandler(fenced, store))
  try {
    const response = await fetch(`${http.url}?session=session-1`)
    assert.equal(response.status, 403)
    assert.equal(await response.text(), '')
  } finally {
    await http.close()
    f.cleanup()
  }
})

test('the state route answers only GET and HEAD', async () => {
  const f = fixtureRoot()
  const store = createTaskStore(readConfig({}))
  const trusted: ConnectionLike = { requestRejection: () => undefined }
  const http = await serve(stateHandler(trusted, store))
  try {
    const response = await fetch(`${http.url}?session=session-1`, { method: 'POST' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
    const head = await fetch(`${http.url}?session=session-1`, { method: 'HEAD' })
    assert.equal(head.status, 200)
  } finally {
    await http.close()
    f.cleanup()
  }
})

test('the environment contributor hands out a per-session directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dtp-env-'))
  const registered: { resolve: (execution: unknown) => Record<string, string>, variables: Record<string, unknown> }[] = []
  const shellEnv: ShellEnvLike = {
    register: (contributor) => {
      registered.push(contributor as never)
      return () => {}
    },
  }
  const store = createTaskStore(readConfig({}))
  const dispose = registerProgressEnv(shellEnv, store, 'C:/pkg/bin/dsh-progress.mjs')
  try {
    const contributor = registered[0]
    assert.ok(contributor)
    assert.deepEqual(Object.keys(contributor.variables).sort(), [PROGRESS_CLI_KEY, PROGRESS_DIR_KEY].sort())

    const values = contributor.resolve({ agent: { session: { header: { id: 'session-9', cwd: root } } } })
    assert.equal(values[PROGRESS_DIR_KEY], join(root, '.dsh-progress', 'session-9'))
    assert.equal(values[PROGRESS_CLI_KEY], 'C:/pkg/bin/dsh-progress.mjs')
    // Handing out the path is also what creates it, before the script starts.
    assert.equal(existsSync(values[PROGRESS_DIR_KEY] ?? ''), true)

    // A session without a workspace still gets a usable directory.
    const fallback = contributor.resolve({ agent: { session: { header: { id: 'session-10' } } } })
    assert.equal(fallback[PROGRESS_DIR_KEY], join(process.cwd(), '.dsh-progress', 'session-10'))
    rmSync(join(process.cwd(), '.dsh-progress', 'session-10'), { recursive: true, force: true })

    // No session, no variable: the registry injects only what it is returned.
    assert.deepEqual(contributor.resolve({}), {})
    assert.deepEqual(contributor.resolve(undefined), {})
  } finally {
    dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('apply() wires the route, the environment, the settings namespace, and the prompt section', () => {
  const routes: { kind: string, path: string }[] = []
  const disposers: (() => void)[] = []
  let contributors = 0
  const registered: string[] = []
  const sections: string[] = []
  let watched = 0
  const context = {
    effect: (callback: () => void | (() => void)) => {
      const dispose = callback()
      disposers.push(typeof dispose === 'function' ? dispose : () => {})
    },
    webServer: {
      register: (route: { kind: string, path: string }) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    connection: { requestRejection: () => undefined },
    shellEnv: {
      register: () => {
        contributors += 1
        return () => { contributors -= 1 }
      },
    },
    settings: {
      register: (ns: string, schema: { (value: unknown): unknown }) => {
        registered.push(ns)
        return {
          get: () => schema({}),
          watch: () => {
            watched += 1
            return () => { watched -= 1 }
          },
          update: async () => {},
          replace: async () => {},
        }
      },
    },
    systemPrompt: {
      section: (section: { name: string }) => {
        sections.push(section.name)
        return () => {
          const index = sections.indexOf(section.name)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      getSectionOrder: () => 1600,
    },
  }
  // The host half picks its optional services up through `ctx.inject`, so the
  // fake context runs that callback immediately for whichever dep was asked for.
  const withInject = context as typeof context & {
    inject: (deps: readonly string[], callback: (scope: typeof context) => void) => void
  }
  withInject.inject = (deps, callback) => { callback(context) }
  apply(withInject as never, { scanMs: 60_000 })
  assert.deepEqual(routes.map(route => ({ kind: route.kind, path: route.path })), [{ kind: 'exact', path: STATE_ROUTE }])
  assert.deepEqual(registered, [SETTINGS_NAMESPACE])
  assert.deepEqual(sections, [PROMPT_SECTION_NAME])
  assert.equal(watched, 1)
  assert.equal(contributors, 1)
  // Five effects: settings changes, environment, route, scan loop, prompt
  // section. Disposing them unregisters everything.
  for (const dispose of disposers) dispose()
  assert.deepEqual(routes, [])
  assert.deepEqual(sections, [])
  assert.equal(contributors, 0)
  assert.equal(watched, 0)
})
