import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  applySourceUpdate,
  checkSourceUpdate,
  classifyChangedFiles,
  compactRuntimeUpdateNotice,
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  ERROR_RETRY_BACKOFF_MS,
  maybeAutoUpdateBeforeCreation,
  parseDirtyWorktreeFiles,
  readUpdateState,
  shouldAutoUpdateForToolCall,
  syncInstalledHostSkills,
  type ExecRunner,
} from '../shared/source-update.ts';
import { rpc } from '../mcp.ts';
import { handler } from '../server.ts';
import { WorkspaceStore } from '../workspace.ts';

const execFileAsync = promisify(execFile);
const repoSourceRoot = fileURLToPath(new URL('../', import.meta.url));
const buildStateScript = path.join(repoSourceRoot, 'scripts/source-build-state.mjs');

async function runGit(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Bot',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Bot',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return stdout.trim();
}

async function createGitFixtures(t: any) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'om-source-update-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  const remoteBare = path.join(root, 'remote.git');
  const upstreamWork = path.join(root, 'upstream');
  const checkout = path.join(root, 'checkout');
  const dataDir = path.join(root, 'data');
  const fakeHome = path.join(root, 'home');
  await mkdir(remoteBare, { recursive: true });
  await mkdir(upstreamWork, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(fakeHome, { recursive: true });

  await runGit(remoteBare, ['init', '--bare', '--initial-branch=main']);
  await runGit(upstreamWork, ['init', '--initial-branch=main']);
  await runGit(upstreamWork, ['remote', 'add', 'origin', remoteBare]);

  // Seed a minimal checkout that mirrors OpenGame's source-build-state layout.
  await mkdir(path.join(upstreamWork, 'scripts'), { recursive: true });
  await mkdir(path.join(upstreamWork, 'studio/src'), { recursive: true });
  await mkdir(path.join(upstreamWork, 'skills/openmotion-game'), { recursive: true });
  await mkdir(path.join(upstreamWork, 'shared'), { recursive: true });
  await copyFile(buildStateScript, path.join(upstreamWork, 'scripts/source-build-state.mjs'));
  await writeFile(path.join(upstreamWork, 'package.json'), JSON.stringify({ name: 'openmotion', version: '0.0.1' }, null, 2));
  const initialLock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/demo': { version: '1.0.0', integrity: 'sha512-v1' },
    },
  });
  await writeFile(path.join(upstreamWork, 'package-lock.json'), initialLock);
  await writeFile(path.join(upstreamWork, 'studio/src/app.ts'), 'export const v = 1;\n');
  await writeFile(path.join(upstreamWork, 'game-projects.ts'), 'export const gameVersion = 1;\n');
  await writeFile(path.join(upstreamWork, 'skills/openmotion-game/SKILL.md'), '---\nname: openmotion-game\ndescription: v1\n---\n# v1\n');
  await writeFile(path.join(upstreamWork, 'shared/game-tools.ts'), 'export const tools = 1;\n');
  await writeFile(path.join(upstreamWork, '.gitignore'), 'node_modules/\n.artifacts/\nstudio/build/\n');

  await runGit(upstreamWork, ['add', '.']);
  await runGit(upstreamWork, ['commit', '-m', 'Initial main commit']);
  await runGit(upstreamWork, ['push', '-u', 'origin', 'main']);

  // Clone exactly as docs/opengame-setup.md instructs: shallow single-branch main.
  await runGit(root, [
    '-c', 'filter.lfs.process=',
    '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.required=false',
    'clone', '--depth', '1', '--single-branch', '--branch', 'main',
    remoteBare, checkout,
  ]);

  // Simulate an already-installed source checkout (node_modules + studio/build).
  await mkdir(path.join(checkout, 'node_modules/demo'), { recursive: true });
  await writeFile(path.join(checkout, 'node_modules/.package-lock.json'), initialLock);
  await mkdir(path.join(checkout, 'studio/build'), { recursive: true });
  await writeFile(path.join(checkout, 'studio/build/index.html'), '<html>v1</html>');

  const commitUpstream = async (changes: Record<string, string>, message: string) => {
    for (const [rel, content] of Object.entries(changes)) {
      const target = path.join(upstreamWork, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await runGit(upstreamWork, ['add', '.']);
    await runGit(upstreamWork, ['commit', '-m', message]);
    await runGit(upstreamWork, ['push', 'origin', 'main']);
    return runGit(upstreamWork, ['rev-parse', 'HEAD']);
  };

  return { root, remoteBare, upstreamWork, checkout, dataDir, fakeHome, commitUpstream };
}

function createTrackingExec(options: { failOnNpmRun?: boolean; failOnLsRemote?: boolean } = {}) {
  const npmCalls: string[][] = [];
  const gitCalls: string[][] = [];
  const exec: ExecRunner = async (file, args, opts) => {
    const isGit = file === 'git';
    const isNpm = !isGit;
    if (isGit) {
      gitCalls.push([...args]);
      if (options.failOnLsRemote && args.includes('ls-remote')) {
        throw new Error('fatal: unable to access remote: network unreachable');
      }
      const res = await execFileAsync(file, [...args], { cwd: opts?.cwd, env: opts?.env, timeout: opts?.timeout });
      return { stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
    }
    if (isNpm) {
      const normalized = args[0]?.endsWith('.js') ? args.slice(1) : [...args];
      npmCalls.push(normalized);
      if (normalized[0] === 'ci') {
        await mkdir(path.join(opts!.cwd!, 'node_modules'), { recursive: true });
        const lock = await readFile(path.join(opts!.cwd!, 'package-lock.json'), 'utf8');
        await writeFile(path.join(opts!.cwd!, 'node_modules/.package-lock.json'), lock);
        return { stdout: 'npm ci ok', stderr: '' };
      }
      if (normalized[0] === 'run' && normalized[1] === 'build:studio') {
        if (options.failOnNpmRun) throw new Error('Vite build exploded');
        await mkdir(path.join(opts!.cwd!, 'studio/build'), { recursive: true });
        await writeFile(path.join(opts!.cwd!, 'studio/build/index.html'), '<html>rebuilt</html>');
        return { stdout: 'build ok', stderr: '' };
      }
    }
    throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
  };
  return { exec, npmCalls, gitCalls };
}

test('classifyChangedFiles accurately flags skill, MCP schema, Studio build, and lockfile changes', () => {
  assert.deepEqual(classifyChangedFiles(['game-projects.ts', 'templates/games/new/index.html']), {
    skillChanged: false,
    gameSkillChanged: false,
    changedSkills: [],
    mcpSchemaChanged: false,
    studioInputChanged: false,
    lockfileChanged: false,
  });
  assert.deepEqual(classifyChangedFiles(['skills/openmotion-game/SKILL.md', 'skills/openmotion-media/references/setup.md']), {
    skillChanged: true,
    gameSkillChanged: true,
    changedSkills: ['openmotion-game', 'openmotion-media'],
    mcpSchemaChanged: false,
    studioInputChanged: false,
    lockfileChanged: false,
  });
  assert.deepEqual(classifyChangedFiles(['shared/game-tools.ts', 'package-lock.json']), {
    skillChanged: false,
    gameSkillChanged: false,
    changedSkills: [],
    mcpSchemaChanged: true,
    studioInputChanged: true,
    lockfileChanged: true,
  });
});

test('shouldAutoUpdateForToolCall matches all creation/generation entries across Game, Motion, Design, and Media while skipping reads and dryRun', () => {
  // Creation and generation entries -> true
  assert.equal(shouldAutoUpdateForToolCall('openmotion_game_create', { prompt: 'runner' }), true);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_create_project', { requestId: 'r1', projectType: 'natural_language', title: 'Intro', requirements: 'make video' }), true);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_design_project', { action: 'create', scenario: 'deck' }), true);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_capability_run', { capabilityId: 'music', prompt: 'lofi loop' }), true);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_assets_use', { action: 'generate', modality: 'image' }), true);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_assets', { action: 'generate', modality: 'audio' }), true);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_media_use', { action: 'generate', modality: 'video' }), true);

  // Non-creation actions, reads, polling, edits, and dryRun -> false
  assert.equal(shouldAutoUpdateForToolCall('openmotion_capability_run', { capabilityId: 'music', dryRun: true }), false);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_design_project', { action: 'get', projectId: '0'.repeat(8) }), false);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_design_project', { action: 'open', projectId: '0'.repeat(8) }), false);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_assets_use', { action: 'list' }), false);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_assets_use', { action: 'status' }), false);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_media_use', { action: 'inspect' }), false);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_media_use', { action: 'models' }), false);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_game_get', { id: 'g1' }), false);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_get_project', {}), false);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_edit_project', {}), false);
  assert.equal(shouldAutoUpdateForToolCall('openmotion_capability_discover', { action: 'list' }), false);
});

test('parseDirtyWorktreeFiles ignores Codex installer marketplace.json but catches real dirty files', () => {
  const onlyMarketplace = '?? .agents/plugins/marketplace.json\0';
  assert.deepEqual(parseDirtyWorktreeFiles(onlyMarketplace), []);

  const withRealEdits = '?? .agents/plugins/marketplace.json\0 M game-projects.ts\0?? scratch.txt\0';
  assert.deepEqual(parseDirtyWorktreeFiles(withRealEdits), ['game-projects.ts', 'scratch.txt']);
});

test('24-hour TTL skips repeated checks with zero git remote probes until interval expires', async t => {
  const { checkout, dataDir } = await createGitFixtures(t);
  const tracker = createTrackingExec();
  let clock = 1_764_000_000_000;
  const env = { ...process.env, OPENMOTION_AUTO_UPDATE: '1' };

  const first = await checkSourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    automatic: true,
    now: () => clock,
    env,
    exec: tracker.exec,
  });
  assert.equal(first.status, 'up_to_date');
  assert.equal(first.checked, true);
  assert.equal(tracker.gitCalls.filter(args => args.includes('ls-remote')).length, 1);

  // Within 24h: zero ls-remote calls.
  clock += DEFAULT_UPDATE_CHECK_INTERVAL_MS - 1_000;
  const second = await checkSourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    automatic: true,
    now: () => clock,
    env,
    exec: tracker.exec,
  });
  assert.equal(second.status, 'skipped_ttl');
  assert.equal(second.checked, false);
  assert.equal(tracker.gitCalls.filter(args => args.includes('ls-remote')).length, 1);

  // After 24h: probes origin/main again.
  clock += 2_000;
  const third = await checkSourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    automatic: true,
    now: () => clock,
    env,
    exec: tracker.exec,
  });
  assert.equal(third.status, 'up_to_date');
  assert.equal(third.checked, true);
  assert.equal(tracker.gitCalls.filter(args => args.includes('ls-remote')).length, 2);
});

test('automatic update respects opt-out env, non-git installs, npm installs, and feature branches', async t => {
  const { root, checkout, dataDir } = await createGitFixtures(t);
  const tracker = createTrackingExec();

  // Disabled via env
  const disabled = await checkSourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    automatic: true,
    env: { ...process.env, OPENMOTION_AUTO_UPDATE: '0' },
    exec: tracker.exec,
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(tracker.gitCalls.length, 0);

  // Non-git directory
  const nonGit = path.join(root, 'plain');
  await mkdir(nonGit, { recursive: true });
  const unsupported = await checkSourceUpdate({
    repoRoot: nonGit,
    dataDirectory: dataDir,
    automatic: true,
    env: { ...process.env, OPENMOTION_AUTO_UPDATE: '1' },
    exec: tracker.exec,
  });
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.reason, 'not_git_checkout');

  // npm-managed installation
  await writeFile(path.join(nonGit, '.npm-install.json'), '{}');
  const npmInst = await checkSourceUpdate({
    repoRoot: nonGit,
    dataDirectory: dataDir,
    automatic: true,
    env: { ...process.env, OPENMOTION_AUTO_UPDATE: '1' },
    exec: tracker.exec,
  });
  assert.equal(npmInst.status, 'unsupported');
  assert.equal(npmInst.reason, 'npm_managed_installation');

  // Feature branch protection
  await runGit(checkout, ['checkout', '-b', 'feat/custom-work']);
  const featureBranch = await checkSourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    automatic: true,
    env: { ...process.env, OPENMOTION_AUTO_UPDATE: '1' },
    exec: tracker.exec,
  });
  assert.equal(featureBranch.status, 'non_target_branch');
  assert.equal(featureBranch.branch, 'feat/custom-work');
});

test('silent auto-update fast-forwards backend+skill updates without running npm ci or build:studio and syncs host Skills safely', async t => {
  const { checkout, dataDir, fakeHome, commitUpstream } = await createGitFixtures(t);
  const tracker = createTrackingExec();
  const env = { ...process.env, OPENMOTION_AUTO_UPDATE: '1' };

  // Installer-created marketplace.json must NOT block updates.
  await mkdir(path.join(checkout, '.agents/plugins'), { recursive: true });
  await writeFile(path.join(checkout, '.agents/plugins/marketplace.json'), '{"name":"openmotion-local"}');

  // Pre-install host copies: one valid copy, one foreign skill, one npm-managed bundle, one symlink.
  const claudeGameSkill = path.join(fakeHome, '.claude/skills/openmotion-game');
  await mkdir(claudeGameSkill, { recursive: true });
  await writeFile(path.join(claudeGameSkill, 'SKILL.md'), '---\nname: openmotion-game\ndescription: v1\n---\n# v1\n');

  const foreignSkill = path.join(fakeHome, '.agents/skills/openmotion-game');
  await mkdir(foreignSkill, { recursive: true });
  await writeFile(path.join(foreignSkill, 'SKILL.md'), '---\nname: unrelated-custom\n---\nkeep me\n');

  const npmManagedSkill = path.join(fakeHome, '.workbuddy/skills/openmotion-game');
  await mkdir(npmManagedSkill, { recursive: true });
  await writeFile(path.join(npmManagedSkill, 'SKILL.md'), '---\nname: openmotion-game\n---\n# npm\n');
  await writeFile(path.join(npmManagedSkill, 'scope.json'), JSON.stringify({ managedBy: '@openmotion/installer' }));

  const symlinkRoot = path.join(fakeHome, '.cursor/skills');
  await mkdir(symlinkRoot, { recursive: true });
  await symlink(path.join(checkout, 'skills/openmotion-game'), path.join(symlinkRoot, 'openmotion-game'));

  const newCommit = await commitUpstream({
    'game-projects.ts': 'export const gameVersion = 2;\n',
    'skills/openmotion-game/SKILL.md': '---\nname: openmotion-game\ndescription: v2\n---\n# v2\n',
  }, 'Improve game rules and skill');

  let shutdownCalled = 0;
  const result = await maybeAutoUpdateBeforeCreation({
    repoRoot: checkout,
    dataDirectory: dataDir,
    homeDirectory: fakeHome,
    env,
    exec: tracker.exec,
    shutdownBackend: async () => {
      shutdownCalled++;
      return { restarted: true, deferred: false };
    },
  });

  assert.equal(result.status, 'updated');
  if (result.status !== 'updated') throw new Error('expected updated');
  assert.equal(result.currentCommit, newCommit);
  assert.equal(result.skillChanged, true);
  assert.equal(result.gameSkillChanged, true);
  assert.deepEqual(result.changedSkills, ['openmotion-game']);
  assert.equal(result.mcpSchemaChanged, false);
  assert.equal(result.depsInstalled, false);
  assert.equal(result.studioRebuilt, false);
  assert.equal(result.restarted, true);
  assert.equal(shutdownCalled, 1);
  // Zero npm invocations because lockfile and Studio inputs were untouched!
  assert.equal(tracker.npmCalls.length, 0);

  // Verify repo updated, marketplace.json preserved, host skills synced safely.
  assert.match(await readFile(path.join(checkout, 'game-projects.ts'), 'utf8'), /gameVersion = 2/);
  assert.match(await readFile(path.join(checkout, '.agents/plugins/marketplace.json'), 'utf8'), /openmotion-local/);
  assert.match(await readFile(path.join(claudeGameSkill, 'SKILL.md'), 'utf8'), /# v2/);
  assert.match(await readFile(path.join(foreignSkill, 'SKILL.md'), 'utf8'), /keep me/);
  assert.match(await readFile(path.join(npmManagedSkill, 'SKILL.md'), 'utf8'), /# npm/);
  assert.deepEqual(result.syncedSkills, [claudeGameSkill]);

  // Verify subsequent automatic check within 24h skips immediately.
  const second = await maybeAutoUpdateBeforeCreation({
    repoRoot: checkout,
    dataDirectory: dataDir,
    homeDirectory: fakeHome,
    env,
    exec: tracker.exec,
  });
  assert.equal(second.status, 'skipped_ttl');
});

test('dirty working tree blocks update without overwriting local edits', async t => {
  const { checkout, dataDir, commitUpstream } = await createGitFixtures(t);
  const tracker = createTrackingExec();
  const env = { ...process.env, OPENMOTION_AUTO_UPDATE: '1' };

  await commitUpstream({ 'game-projects.ts': 'export const gameVersion = 99;\n' }, 'Upstream update');
  await writeFile(path.join(checkout, 'game-projects.ts'), 'export const gameVersion = 42; // local edit\n');

  const result = await applySourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    env,
    exec: tracker.exec,
    restartBackend: false,
  });

  assert.equal(result.status, 'dirty_worktree');
  assert.equal(result.updated, false);
  assert.deepEqual(result.dirtyFiles, ['game-projects.ts']);
  assert.match(await readFile(path.join(checkout, 'game-projects.ts'), 'utf8'), /local edit/);
});

test('incremental rebuild runs build:studio on Studio changes and npm ci + build:studio on lockfile changes', async t => {
  const { checkout, dataDir, commitUpstream } = await createGitFixtures(t);
  const tracker = createTrackingExec();
  const env = { ...process.env, OPENMOTION_AUTO_UPDATE: '1' };

  // 1) Frontend change -> build:studio only (no npm ci)
  await commitUpstream({ 'studio/src/app.ts': 'export const v = 2;\n' }, 'Update Studio UI');
  const first = await applySourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    env,
    exec: tracker.exec,
    restartBackend: false,
  });
  assert.equal(first.status, 'updated');
  assert.equal(first.depsInstalled, false);
  assert.equal(first.studioRebuilt, true);
  assert.deepEqual(tracker.npmCalls, [['run', 'build:studio']]);

  // 2) Lockfile + schema change -> npm ci + build:studio + mcpSchemaChanged
  await commitUpstream({
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/demo': { version: '2.0.0', integrity: 'sha512-v2' } } }),
    'shared/game-tools.ts': 'export const tools = 2;\n',
  }, 'Update deps and game tool schema');
  const second = await applySourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    env,
    exec: tracker.exec,
    restartBackend: false,
  });
  assert.equal(second.status, 'updated');
  assert.equal(second.depsInstalled, true);
  assert.equal(second.studioRebuilt, true);
  assert.equal(second.mcpSchemaChanged, true);
  assert.equal(tracker.npmCalls[1][0], 'ci');
  assert.deepEqual(tracker.npmCalls[2], ['run', 'build:studio']);
});

test('build failure rolls back checkout automatically to previousCommit', async t => {
  const { checkout, dataDir, commitUpstream } = await createGitFixtures(t);
  const beforeCommit = await runGit(checkout, ['rev-parse', 'HEAD']);
  await commitUpstream({ 'studio/src/app.ts': 'export const v = 999; // broken build\n' }, 'Broken Studio update');

  const tracker = createTrackingExec({ failOnNpmRun: true });
  const result = await applySourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    env: { ...process.env, OPENMOTION_AUTO_UPDATE: '1' },
    exec: tracker.exec,
    restartBackend: false,
  });

  assert.equal(result.status, 'failed_rolled_back');
  assert.equal(result.updated, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.currentCommit, beforeCommit);
  assert.equal(await runGit(checkout, ['rev-parse', 'HEAD']), beforeCommit);
  assert.match(await readFile(path.join(checkout, 'studio/src/app.ts'), 'utf8'), /export const v = 1;/);
});

test('transient network error during check backs off for 1 hour instead of stalling every call', async t => {
  const { checkout, dataDir } = await createGitFixtures(t);
  const tracker = createTrackingExec({ failOnLsRemote: true });
  let clock = 1_764_000_000_000;
  const env = { ...process.env, OPENMOTION_AUTO_UPDATE: '1' };

  const first = await checkSourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    automatic: true,
    now: () => clock,
    env,
    exec: tracker.exec,
  });
  assert.equal(first.status, 'check_failed');
  assert.equal(tracker.gitCalls.filter(args => args.includes('ls-remote')).length, 1);

  clock += ERROR_RETRY_BACKOFF_MS - 1_000;
  const second = await checkSourceUpdate({
    repoRoot: checkout,
    dataDirectory: dataDir,
    automatic: true,
    now: () => clock,
    env,
    exec: tracker.exec,
  });
  assert.equal(second.status, 'skipped_ttl');
  assert.equal(tracker.gitCalls.filter(args => args.includes('ls-remote')).length, 1);

  const persisted = await readUpdateState(dataDir);
  assert.equal(persisted?.lastStatus, 'check_failed');
});

test('MCP rpc triggers autoUpdate across all creation/generation tools, skips reads and dryRun, and never blocks creation on error', async t => {
  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'om-mcp-update-')));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new WorkspaceStore(dataDir);

  const updateCalls: Array<{ repoRoot: string; dataDirectory: string; restartBackend: boolean }> = [];
  const callPhase1 = async (payload: any) => ({ id: 'item-123', title: payload.arguments?.prompt || payload.arguments?.title || 'Item', status: 'draft' });

  // 1) Read-only / dryRun calls must NEVER trigger autoUpdate
  for (const params of [
    { name: 'openmotion_game_get', arguments: { id: 'game-123' } },
    { name: 'openmotion_capability_run', arguments: { capabilityId: 'music', prompt: 'test', dryRun: true } },
    { name: 'openmotion_design_project', arguments: { action: 'list' } },
    { name: 'openmotion_assets_use', arguments: { action: 'list' } },
    { name: 'openmotion_media_use', arguments: { action: 'inspect' } },
  ]) {
    await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params },
      store,
      undefined,
      undefined,
      undefined,
      {
        callPhase1,
        autoUpdate: async ctx => {
          updateCalls.push(ctx);
          return { status: 'skipped_ttl', checked: false, updateAvailable: false };
        },
      },
    );
  }
  assert.equal(updateCalls.length, 0);

  // 2) openmotion_game_create with actual update -> attaches compact runtimeUpdate
  const updatedOutcome = {
    status: 'updated' as const,
    updated: true,
    previousCommit: '1'.repeat(40),
    currentCommit: '2'.repeat(40),
    skillChanged: true,
    gameSkillChanged: true,
    changedSkills: ['openmotion-game'],
    mcpSchemaChanged: false,
    depsInstalled: false,
    studioRebuilt: false,
    restarted: true,
    restartDeferred: false,
  };
  const updatedResp: any = await rpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'openmotion_game_create', arguments: { prompt: 'A minimal runner' } } },
    store,
    undefined,
    undefined,
    undefined,
    {
      callPhase1,
      autoUpdate: async ctx => {
        updateCalls.push(ctx);
        return updatedOutcome;
      },
    },
  );
  assert.equal(updateCalls.length, 1);
  assert.equal(updatedResp.result.structuredContent.id, 'item-123');
  assert.deepEqual(updatedResp.result.structuredContent.runtimeUpdate, compactRuntimeUpdateNotice(updatedOutcome));

  // 3) Motion video, Design create, and Multimodal image/audio/video generation all invoke autoUpdate hook
  for (const params of [
    { name: 'openmotion_create_project', arguments: { requestId: 'req-video', projectType: 'natural_language', title: 'Promo', requirements: '10s promo' } },
    { name: 'openmotion_design_project', arguments: { action: 'create', requestId: 'req-design', scenario: 'deck', title: 'Pitch Deck' } },
    { name: 'openmotion_capability_run', arguments: { requestId: 'req-audio', capabilityId: 'music', prompt: 'upbeat synth loop' } },
    { name: 'openmotion_assets_use', arguments: { action: 'generate', requestId: 'req-image', model: 'seedream', modality: 'image', prompt: 'hero key art' } },
  ]) {
    const resp: any = await rpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params },
      store,
      undefined,
      undefined,
      undefined,
      {
        callPhase1,
        autoUpdate: async ctx => {
          updateCalls.push(ctx);
          return { status: 'skipped_ttl', checked: false, updateAvailable: false };
        },
      },
    );
    assert.equal(resp.result.isError, undefined, JSON.stringify(resp));
    assert.equal('runtimeUpdate' in resp.result.structuredContent, false);
  }
  assert.equal(updateCalls.length, 5);

  // 4) autoUpdate throwing unexpectedly must NEVER block creation
  const resilientResp: any = await rpc(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'openmotion_game_create', arguments: { prompt: 'Resilient game' } } },
    store,
    undefined,
    undefined,
    undefined,
    {
      callPhase1,
      autoUpdate: async () => { throw new Error('unexpected updater crash'); },
    },
  );
  assert.equal(resilientResp.result.isError, undefined);
  assert.equal(resilientResp.result.structuredContent.id, 'item-123');
});

test('HTTP /motion-api/update/status and /motion-api/update/apply reject cross-site requests and report non-git checkout cleanly', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'om-http-update-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const fakeAppRoot = path.join(root, 'app');
  await mkdir(dataDir, { recursive: true });
  await mkdir(fakeAppRoot, { recursive: true });
  const store = new WorkspaceStore(dataDir);

  const server = createServer((req, res) => {
    void handler(req, res, store, { nativeRoot: fakeAppRoot });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  // Cross-site GET rejected
  const crossGet = await fetch(`${origin}/motion-api/update/status`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossGet.status, 403);

  // Local GET reports unsupported on non-git app root
  const okGet = await fetch(`${origin}/motion-api/update/status`);
  assert.equal(okGet.status, 200);
  const statusJson = await okGet.json();
  assert.equal(statusJson.status, 'unsupported');
  assert.equal(statusJson.reason, 'not_git_checkout');

  // Cross-site POST rejected
  const crossPost = await fetch(`${origin}/motion-api/update/apply`, {
    method: 'POST',
    headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossPost.status, 403);

  // Same-origin POST returns unsupported cleanly without error
  const okPost = await fetch(`${origin}/motion-api/update/apply`, {
    method: 'POST',
    headers: { Origin: origin },
  });
  assert.equal(okPost.status, 200);
  const applyJson = await okPost.json();
  assert.equal(applyJson.status, 'unsupported');
  assert.equal(applyJson.restartRequired, false);
});

test('syncInstalledHostSkills does not create missing host directories', async t => {
  const { checkout, fakeHome } = await createGitFixtures(t);
  const synced = await syncInstalledHostSkills(checkout, { homeDirectory: fakeHome, env: {} });
  assert.deepEqual(synced, []);
});
