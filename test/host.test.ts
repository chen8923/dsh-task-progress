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

test('apply() settles a killed writer over the route it serves', async () => {
  // The whole point of the seam: the fake context below is a composition with a
  // job registry, and the job that wrote `build` was killed. The file still says
  // `running` — that is the failure this covers — so the row must come back
  // ended, with the reason attached, *without* the file changing.
  const f = fixtureRoot()
  const registered: { handler: (req: never, res: never) => void }[] = []
  const context = {
    effect: (callback: () => void | (() => void)) => { callback() },
    webServer: {
      register: (route: { handler: (req: never, res: never) => void }) => {
        registered.push(route)
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
    shellEnv: { register: () => () => {} },
    // The settings scope is how the extra root reaches the store; the fake
    // answers with one that points at this test's workspace.
    settings: {
      register: (_ns: string, schema: (value: unknown) => unknown) => ({
        get: () => schema({ roots: [f.root] }),
        watch: () => () => {},
        update: async () => {},
        replace: async () => {},
      }),
    },
    // Keyed by the session the progress directory is named after — and the
    // caller is that session **id**, which is what the registry's own filter
    // (`job.owner.id === caller`) compares. No `agents` fake: the registry takes
    // the session directly now, so the plugin no longer has to resolve one to
    // the other.
    jobs: {
      list: (caller?: string) => caller === 'session-1'
        ? [{
            id: 'pwsh-7',
            kind: 'pwsh',
            label: 'pwsh -File build.ps1 --task build',
            status: 'killed',
            startedAt: Date.now() - 60_000,
            finishedAt: Date.now(),
            detail: 'signal: SIGTERM',
          }]
        : [],
    },
    on: () => () => {},
  }
  // The host half picks its optional services up through `ctx.inject`, so the
  // fake context runs that callback the way cordis does: only once every named
  // service exists. A composition that is missing one wires less, not differently.
  const withInject = context as typeof context & {
    inject: (deps: readonly string[], callback: (scope: typeof context) => void) => void
  }
  withInject.inject = (deps, callback) => {
    if (deps.every(dep => (context as Record<string, unknown>)[dep] !== undefined)) callback(context)
  }
  apply(withInject as never, { scanMs: 60_000, roots: [f.root] })
  const handler = registered[0]?.handler
  assert.ok(handler, 'apply() registered no route')
  const http = await serve(handler as never)
  try {
    const body = await (await fetch(`${http.url}?session=session-1`)).json() as {
      tasks: { task: string, state: string, pct: number, ended?: { job: string, status: string, detail?: string } }[]
    }
    assert.equal(body.tasks[0]?.task, 'build')
    assert.equal(body.tasks[0]?.state, 'cancelled')
    assert.equal(body.tasks[0]?.pct, 30, 'the percentage the producer last reported is untouched')
    assert.deepEqual(body.tasks[0]?.ended, { job: 'pwsh-7', status: 'killed', detail: 'signal: SIGTERM' })
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
  const dispose = registerProgressEnv(shellEnv, store, '/pkg/bin/dsh-progress.mjs')
  try {
    const contributor = registered[0]
    assert.ok(contributor)
    assert.deepEqual(Object.keys(contributor.variables).sort(), [PROGRESS_CLI_KEY, PROGRESS_DIR_KEY].sort())

    const values = contributor.resolve({ agent: { session: { header: { id: 'session-9', cwd: root } } } })
    assert.equal(values[PROGRESS_DIR_KEY], join(root, '.dsh-progress', 'session-9'))
    assert.equal(values[PROGRESS_CLI_KEY], '/pkg/bin/dsh-progress.mjs')
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

test('apply() wires the route, the environment, and the prompt section with no settings service', () => {
  const routes: { kind: string, path: string }[] = []
  const disposers: (() => void)[] = []
  let contributors = 0
  const sections: string[] = []
  const listeners: string[] = []
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
    // Deliberately no `settings` service. DSH 0.1.7 replaced it with a
    // schema-derived form service that has no `register` at all, so the old
    // `inject(['settings'])` never fires — which is how both the settings card
    // and the `roots` override went missing while `apply` looked fine. The
    // configuration now arrives as the plugin row's own `config` argument.
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
    // The job registry is read as snapshots only; `read` deliberately is not
    // part of the fake, because the plugin is not allowed to call it.
    jobs: {
      list: () => [],
    },
    on: (event: string) => {
      listeners.push(event)
      return () => {
        const index = listeners.indexOf(event)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }
  // The host half picks its optional services up through `ctx.inject`, so the
  // fake context runs that callback immediately for whichever dep was asked for.
  const withInject = context as typeof context & {
    inject: (deps: readonly string[], callback: (scope: typeof context) => void) => void
  }
  withInject.inject = (deps, callback) => {
    if (deps.every(dep => (context as Record<string, unknown>)[dep] !== undefined)) callback(context)
  }
  apply(withInject as never, { scanMs: 60_000 })
  assert.deepEqual(routes.map(route => ({ kind: route.kind, path: route.path })), [{ kind: 'exact', path: STATE_ROUTE }])
  assert.deepEqual(sections, [PROMPT_SECTION_NAME])
  assert.equal(contributors, 1)
  assert.deepEqual(listeners, ['agent/pre-step'], 'the reminder listens to the step it can still influence')
  // Six effects: environment, route, scan loop, prompt section, the reminder, and
  // the settle source. Disposing them unregisters everything. The settle source is
  // wired from `jobs` alone: this fake has no `agents`, which is exactly the
  // composition the new registry makes possible.
  for (const dispose of disposers) dispose()
  assert.deepEqual(routes, [])
  assert.deepEqual(sections, [])
  assert.equal(contributors, 0)
  assert.deepEqual(listeners, [])
})
