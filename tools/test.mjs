/**
 * Test entry point: every suite, in one process.
 *
 * `node --test test/` is the canonical form and works anywhere the test runner
 * is allowed to spawn its per-file children. In a sandbox that forbids creating
 * the pipes those children need (Windows restricted-token sessions do), the
 * runner fails with `spawn EPERM` before a single assertion runs. Importing the
 * suites here executes exactly the same tests in the current process, which is
 * what `npm test` uses by default so the suite is runnable everywhere.
 */

import '../test/protocol.test.ts'
import '../test/jobs.test.ts'
import '../test/store.test.ts'
import '../test/format.test.ts'
import '../test/host.test.ts'
import '../test/settings.test.ts'
import '../test/settings-form.test.ts'
import '../test/system-prompt.test.ts'
import '../test/reminder.test.ts'
import '../test/session-hook.test.ts'
import '../test/client-store.test.ts'
import '../test/cli.test.ts'
import '../test/bundle.test.ts'
import '../test/release.test.ts'
