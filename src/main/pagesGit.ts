/**
 * Puts a built site on a branch of a remote repository as a single commit of its own (an orphan
 * branch, force-pushed: the branch never keeps old versions of the plan, and the project's history is
 * not touched). The repository is a fresh one inside the site folder, created for each push. No
 * Electron imports: the git executable and folders come in as arguments (tests push to a local bare
 * repository). Deleting the branch again is git.gitPushRef with the head checked to be doplan's.
 */
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface GitRunner {
  /** absolute path of the git executable */
  git: string
  /** an always-empty folder: hooks never run */
  hooksDir: string
  /** extra `-c` flags (credentials for github.com; tests allow the file protocol) */
  config?: string[]
  timeoutMs?: number
}

export class PagesGitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message)
  }
}

function env(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) out[k] = v
  return {
    ...out,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C',
    GIT_NO_LAZY_FETCH: '1',
    // a neutral author: the published commit carries no personal name or address
    GIT_AUTHOR_NAME: 'doplan',
    GIT_AUTHOR_EMAIL: 'doplan@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'doplan',
    GIT_COMMITTER_EMAIL: 'doplan@users.noreply.github.com',
  }
}

function hardening(r: GitRunner): string[] {
  return [
    '-c', `core.hooksPath=${r.hooksDir}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.sshCommand=',
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false',
    '-c', 'core.quotepath=off',
    '-c', 'commit.gpgSign=false',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    // a large site goes up in one request
    '-c', 'http.postBuffer=524288000',
    ...(r.config ?? []),
  ]
}

function run(r: GitRunner, cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(
      r.git,
      [...hardening(r), ...args],
      { cwd, windowsHide: true, timeout: r.timeoutMs ?? 15 * 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...env(), ...extraEnv } },
      (err, stdout, stderr) => {
        const errText = String(stderr ?? '').trim()
        if (err) {
          const first = errText.split('\n').find((l) => /^(fatal|error|remote):/.test(l)) ?? errText.split('\n')[0] ?? err.message
          fail(new PagesGitError(`git ${args.find((a) => !a.startsWith('-')) ?? ''}: ${first || err.message}`, errText))
          return
        }
        ok(String(stdout ?? ''))
      },
    )
  })
}

/** git sees only this repository: no looking above the folder for another one */
function repoArgs(dir: string): { args: string[]; env: Record<string, string> } {
  const abs = resolve(dir)
  return { args: [`--git-dir=${join(abs, '.git')}`, `--work-tree=${abs}`], env: { GIT_CEILING_DIRECTORIES: dirname(abs) } }
}

/** the remote URL as git gets it: credentials never come inside it */
function checkRemote(remote: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(remote) || remote.startsWith('-')) throw new Error('remote URL must not carry credentials')
}

/**
 * Commits everything in `siteDir` as the only commit of `branch` and force-pushes it to `remote`.
 * `expected` is what the branch must be on the remote for the push to replace it: the head seen when
 * it was checked to be doplan's (null: the branch must not exist). Someone else's branch that
 * appeared or changed meanwhile is never overwritten. Resolves with the commit sha.
 */
export async function pushSite(r: GitRunner, siteDir: string, remote: string, branch: string, message: string, expected: string | null): Promise<string> {
  checkRemote(remote)
  const expect = lease(expected)
  const { args, env: e } = repoArgs(siteDir)
  await fsp.rm(join(siteDir, '.git'), { recursive: true, force: true })
  // no template: nothing from the user's init.templateDir (hooks) lands in the repository
  await run(r, siteDir, ['init', '-q', '--template=', `--initial-branch=${branch}`, resolve(siteDir)], e)
  try {
    await run(r, siteDir, [...args, 'add', '-A', '--', '.'], e)
    await run(r, siteDir, [...args, 'commit', '-q', '--no-verify', '-m', message], e)
    const sha = (await run(r, siteDir, [...args, 'rev-parse', 'HEAD'], e)).trim()
    await run(r, siteDir, [...args, 'push', `--force-with-lease=refs/heads/${branch}:${expect}`, '--quiet', '--no-verify', remote, `HEAD:refs/heads/${branch}`], e)
    return sha
  } finally {
    await fsp.rm(join(siteDir, '.git'), { recursive: true, force: true })
  }
}

const lease = (sha: string | null): string => {
  if (sha !== null && !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(sha)) throw new Error('bad commit id')
  return sha ?? ''
}

