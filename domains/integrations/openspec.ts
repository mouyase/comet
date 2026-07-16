import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PLATFORMS, getPlatformSkillsDir } from '../../platform/install/platforms.js';
import { printCommandErrorDetails } from '../../platform/process/command-error.js';
import { quoteArgsForShell } from '../../platform/process/shell-quote.js';

import type { InstallScope } from '../../platform/install/types.js';

const VALID_TOOL_IDS = new Set(PLATFORMS.map((p) => p.openspecToolId));
const MINIMUM_OPENSPEC_VERSION = '1.5.0';
const ALL_OPENSPEC_WORKFLOWS = [
  'propose',
  'explore',
  'new',
  'continue',
  'apply',
  'ff',
  'sync',
  'archive',
  'bulk-archive',
  'verify',
  'onboard',
] as const;

function getNpmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function buildOpenSpecInitInvocation(
  projectPath: string,
  toolIds: string[],
  scope: InstallScope,
  homeDir = os.homedir(),
  includeProfileFlag = true,
): { command: string; args: string[] } {
  const targetPath = scope === 'global' ? homeDir : projectPath;
  const args = ['init', targetPath, '--tools', toolIds.join(',')];
  if (includeProfileFlag) {
    args.push('--profile', 'custom');
  }
  return { command: 'openspec', args };
}

function buildOpenSpecStoreRegisterInvocation(
  projectPath: string,
  storeId: string,
): { command: string; args: string[] } {
  return {
    command: 'openspec',
    args: ['store', 'register', path.join(projectPath, 'docs'), '--id', storeId, '--yes'],
  };
}

function runOpenSpecInvocation(
  invocation: { command: string; args: string[] },
  cwd: string,
  options: { json?: boolean } = {},
): void {
  const useShell = process.platform === 'win32';
  const args = options.json ? [...invocation.args, '--json'] : invocation.args;
  execFileSync(invocation.command, useShell ? quoteArgsForShell(args) : args, {
    cwd,
    stdio: options.json ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'inherit', 'pipe'],
    timeout: 120_000,
    shell: useShell,
  });
}

function configureOpenSpecStore(
  projectPath: string,
  storeId: string,
  options: { json?: boolean; command?: string } = {},
): 'installed' | 'failed' {
  try {
    const invocation = buildOpenSpecStoreRegisterInvocation(projectPath, storeId);
    invocation.command = options.command ?? process.env.COMET_OPENSPEC ?? invocation.command;
    runOpenSpecInvocation(invocation, projectPath, options);
    return 'installed';
  } catch (error) {
    console.error(`    OpenSpec store configuration failed: ${(error as Error).message}`);
    printCommandErrorDetails(error);
    return 'failed';
  }
}

function relocateGeneratedOpenSpecRoot(projectPath: string): void {
  const legacyRoot = path.join(projectPath, 'openspec');
  if (!fs.existsSync(legacyRoot)) return;

  const docsRoot = path.join(projectPath, 'docs', 'openspec');
  if (fs.existsSync(docsRoot)) {
    fs.rmSync(legacyRoot, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(path.dirname(docsRoot), { recursive: true });
  fs.renameSync(legacyRoot, docsRoot);
}

interface OpenSpecStoreListOutput {
  stores?: Array<{
    id?: unknown;
    root?: unknown;
  }>;
}

function normalizeStorePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isOpenSpecStoreRoot(projectPath: string, registeredRoot: string): boolean {
  const expectedRoot = normalizeStorePath(path.join(projectPath, 'docs'));
  const actualRoot = normalizeStorePath(registeredRoot);
  return process.platform === 'win32'
    ? actualRoot.toLowerCase() === expectedRoot.toLowerCase()
    : actualRoot === expectedRoot;
}

function createOpenSpecStoreId(projectPath: string): string {
  const canonicalProjectPath = normalizeStorePath(projectPath);
  const projectSlug = path
    .basename(canonicalProjectPath)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const shortHash = createHash('sha256').update(canonicalProjectPath).digest('hex').slice(0, 8);
  return `comet-${projectSlug || 'project'}-${shortHash}`;
}

function readOpenSpecStoreList(projectPath: string, command: string): OpenSpecStoreListOutput {
  const invocation = { command, args: ['store', 'list', '--json'] };
  const useShell = process.platform === 'win32';
  const output = execFileSync(
    invocation.command,
    useShell ? quoteArgsForShell(invocation.args) : invocation.args,
    {
      cwd: projectPath,
      env: { ...process.env, OPENSPEC_TELEMETRY: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      shell: useShell,
    },
  );

  try {
    const parsed = JSON.parse(String(output)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as OpenSpecStoreListOutput;
  } catch (error) {
    throw new Error(
      `Unable to verify the configured OpenSpec store: openspec store list --json returned invalid JSON (${(error as Error).message}).`,
      { cause: error },
    );
  }
}

function assertOpenSpecStoreRegistration(
  projectPath: string,
  storeId: string,
  command = process.env.COMET_OPENSPEC || 'openspec',
): void {
  const store = readOpenSpecStoreList(projectPath, command).stores?.find(
    (entry) => entry.id === storeId,
  );
  if (typeof store?.root !== 'string' || store.root.trim().length === 0) {
    throw new Error(
      `Configured OpenSpec store '${storeId}' is not registered. Run comet init --artifact-layout docs --openspec-store ${storeId} to register this project.`,
    );
  }

  const expectedRoot = normalizeStorePath(path.join(projectPath, 'docs'));
  const registeredRoot = normalizeStorePath(store.root);
  if (!isOpenSpecStoreRoot(projectPath, store.root)) {
    throw new Error(
      `Configured OpenSpec store '${storeId}' registry path does not match this project's docs directory: expected ${expectedRoot}, got ${registeredRoot}.`,
    );
  }
}

interface OpenSpecDoctorOutput {
  root?: { path?: unknown; healthy?: unknown };
  store?: { id?: unknown; metadata?: { present?: unknown; valid?: unknown } };
  status?: Array<{ severity?: unknown; message?: unknown }>;
}

function assertOpenSpecStoreHealth(
  projectPath: string,
  storeId: string,
  command = process.env.COMET_OPENSPEC || 'openspec',
): void {
  assertOpenSpecStoreRegistration(projectPath, storeId, command);
  const useShell = process.platform === 'win32';
  let parsed: OpenSpecDoctorOutput;
  try {
    const args = ['doctor', '--store', storeId, '--json'];
    const output = execFileSync(command, useShell ? quoteArgsForShell(args) : args, {
      cwd: projectPath,
      env: { ...process.env, OPENSPEC_TELEMETRY: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      shell: useShell,
    });
    parsed = JSON.parse(String(output)) as OpenSpecDoctorOutput;
  } catch (error) {
    throw new Error(
      `Configured OpenSpec store '${storeId}' failed OpenSpec health validation: ${(error as Error).message}`,
      { cause: error },
    );
  }
  const errors = (parsed.status ?? []).filter((entry) => entry.severity === 'error');
  if (
    parsed.root?.healthy !== true ||
    typeof parsed.root.path !== 'string' ||
    !isOpenSpecStoreRoot(projectPath, parsed.root.path) ||
    parsed.store?.id !== storeId ||
    parsed.store.metadata?.present !== true ||
    parsed.store.metadata.valid !== true ||
    errors.length > 0
  ) {
    const details = errors
      .map((entry) => (typeof entry.message === 'string' ? entry.message : 'unknown error'))
      .join('; ');
    throw new Error(
      `Configured OpenSpec store '${storeId}' is unhealthy${details ? `: ${details}` : '.'}`,
    );
  }
}

function getOpenSpecStoreRoot(
  projectPath: string,
  storeId: string,
  command = process.env.COMET_OPENSPEC || 'openspec',
): string | undefined {
  const store = readOpenSpecStoreList(projectPath, command).stores?.find(
    (entry) => entry.id === storeId,
  );
  return typeof store?.root === 'string' && store.root.trim() ? store.root : undefined;
}

function unregisterOpenSpecStore(
  projectPath: string,
  storeId: string,
): 'unregistered' | 'skipped' | 'failed' {
  try {
    const command = process.env.COMET_OPENSPEC || 'openspec';
    const registeredRoot = getOpenSpecStoreRoot(projectPath, storeId, command);
    const expectedRoot = normalizeStorePath(path.join(projectPath, 'docs'));
    if (!registeredRoot || normalizeStorePath(registeredRoot) !== expectedRoot) {
      return 'skipped';
    }
    runOpenSpecInvocation({ command, args: ['store', 'unregister', storeId] }, projectPath);
    return 'unregistered';
  } catch (error) {
    console.error(`    OpenSpec store rollback failed: ${(error as Error).message}`);
    printCommandErrorDetails(error);
    return 'failed';
  }
}

const ALL_WORKFLOWS_CONFIG =
  JSON.stringify(
    {
      featureFlags: {},
      profile: 'custom',
      delivery: 'both',
      workflows: [...ALL_OPENSPEC_WORKFLOWS],
    },
    null,
    2,
  ) + '\n';

function getOpenSpecDefaultConfigDir(): string {
  const platform = os.platform();
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      return path.join(appData, 'openspec');
    }
    return path.join(os.homedir(), 'AppData', 'Roaming', 'openspec');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    return path.join(xdgConfig, 'openspec');
  }
  return path.join(os.homedir(), '.config', 'openspec');
}

function getOpenSpecDefaultConfigPath(): string {
  return path.join(getOpenSpecDefaultConfigDir(), 'config.json');
}

function createOpenSpecAllWorkflowsEnv(): { env: NodeJS.ProcessEnv; configHome: string } {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'comet-openspec-profile-'));
  try {
    const openspecConfigDir = path.join(configHome, 'openspec');
    fs.mkdirSync(openspecConfigDir, { recursive: true });
    fs.writeFileSync(path.join(openspecConfigDir, 'config.json'), ALL_WORKFLOWS_CONFIG, 'utf-8');

    return {
      configHome,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
      },
    };
  } catch (error) {
    fs.rmSync(configHome, { recursive: true, force: true });
    throw error;
  }
}

interface ConfigBackup {
  configPath: string;
  backupPath: string;
  hadExisting: boolean;
}

function writeAllWorkflowsToDefaultConfig(): ConfigBackup | null {
  const configPath = getOpenSpecDefaultConfigPath();
  const backupPath = configPath + '.comet-backup';
  let hadExisting = false;

  try {
    hadExisting = fs.existsSync(configPath);
    if (hadExisting) {
      fs.copyFileSync(configPath, backupPath);
    }

    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(configPath, ALL_WORKFLOWS_CONFIG, 'utf-8');

    return { configPath, backupPath, hadExisting };
  } catch {
    if (hadExisting) {
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // Best-effort cleanup
      }
    }
    return null;
  }
}

function restoreDefaultConfig(backup: ConfigBackup | null): void {
  if (!backup) return;
  try {
    if (backup.hadExisting) {
      fs.copyFileSync(backup.backupPath, backup.configPath);
      fs.unlinkSync(backup.backupPath);
    } else {
      if (fs.existsSync(backup.configPath)) {
        fs.unlinkSync(backup.configPath);
      }
    }
  } catch {
    // Best-effort restore
  }
}

function isCommandAvailable(command: string): boolean {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(checker, [command], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = value.match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function isOpenSpecVersionCompatible(versionOutput: string): boolean {
  const actual = parseSemanticVersion(versionOutput);
  const minimum = parseSemanticVersion(MINIMUM_OPENSPEC_VERSION);
  if (!actual || !minimum) return false;
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (actual[field] > minimum[field]) return true;
    if (actual[field] < minimum[field]) return false;
  }
  return actual.prerelease === null;
}

function getOpenSpecVersion(): string | null {
  try {
    return execFileSync('openspec', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      shell: process.platform === 'win32',
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

async function ensureOpenSpecCli(
  _scope: InstallScope,
  projectPath: string,
  shouldInstall = true,
  requireStoreSupport = false,
  quiet = false,
): Promise<'ready' | 'missing' | 'failed'> {
  const alreadyInstalled = isCommandAvailable('openspec');
  const supportsStores = !requireStoreSupport || (alreadyInstalled && openSpecStoreCliSupported());
  const mustInstall = shouldInstall || (requireStoreSupport && !supportsStores);
  if (!mustInstall) {
    if (!alreadyInstalled) return 'missing';
    const version = getOpenSpecVersion();
    if (version && isOpenSpecVersionCompatible(version)) return 'ready';
    console.error(
      `    OpenSpec ${version || 'version unknown'} is incompatible; Comet requires >= ${MINIMUM_OPENSPEC_VERSION}.`,
    );
    return 'failed';
  }
  const label = alreadyInstalled ? 'Upgrading' : 'Installing';
  console.warn(`    ${label} OpenSpec CLI...`);
  try {
    const npmArgs = ['install', '-g', '@fission-ai/openspec@latest'];
    execFileSync(getNpmExecutable(), npmArgs, {
      cwd: os.homedir() || projectPath,
      stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
      timeout: 120_000,
      shell: process.platform === 'win32',
    });
    if (!isCommandAvailable('openspec')) return 'failed';
    return !requireStoreSupport || openSpecStoreCliSupported() ? 'ready' : 'failed';
  } catch (error) {
    if (alreadyInstalled) {
      const version = getOpenSpecVersion();
      if (
        version &&
        isOpenSpecVersionCompatible(version) &&
        (!requireStoreSupport || supportsStores)
      ) {
        console.warn(
          `    OpenSpec upgrade failed, using compatible existing version ${version}: ${(error as Error).message}`,
        );
        return 'ready';
      }
      console.error(
        `    OpenSpec upgrade failed and existing ${version || 'version could not be read'} is incompatible; Comet requires >= ${MINIMUM_OPENSPEC_VERSION}.`,
      );
      printCommandErrorDetails(error);
      return 'failed';
    }
    console.error(`    Failed to install OpenSpec CLI: ${(error as Error).message}`);
    printCommandErrorDetails(error);
    return 'failed';
  }
}

function openSpecStoreCliSupported(command = process.env.COMET_OPENSPEC || 'openspec'): boolean {
  try {
    const useShell = process.platform === 'win32';
    const args = ['store', '--help'];
    execFileSync(command, useShell ? quoteArgsForShell(args) : args, {
      stdio: 'ignore',
      timeout: 10_000,
      shell: useShell,
    });
    return true;
  } catch {
    return false;
  }
}

function assertOpenSpecStoreCliSupport(command = process.env.COMET_OPENSPEC || 'openspec'): void {
  if (!openSpecStoreCliSupported(command)) {
    throw new Error(
      'Docs artifact layout requires OpenSpec 1.5 or newer with store support. Upgrade with: npm install -g @fission-ai/openspec@latest',
    );
  }
}

function migrateOpenCodeOpenSpecPaths(homeDir: string): void {
  const opencodePlatform = PLATFORMS.find((p) => p.id === 'opencode');
  if (!opencodePlatform?.globalSkillsDir) return;

  // OpenSpec hardcodes skillsDir as '.opencode' in its AI_TOOLS, so it writes
  // to ~/.opencode/ even for global installs. OpenCode actually reads from
  // ~/.config/opencode/ (Comet's globalSkillsDir). Move the files over.
  migrateOpenSpecPaths(
    path.join(homeDir, opencodePlatform.skillsDir),
    path.join(homeDir, opencodePlatform.globalSkillsDir),
  );
}

/**
 * OpenCode-compatible platforms can reuse openspec's opencode tool id. The
 * openspec CLI writes into the opencode directory, so mirror those skills and
 * commands into each platform-specific config directory.
 */
function mirrorOpenCodeCompatibleOpenSpecPaths(
  baseDir: string,
  scope: InstallScope,
  platformIds: string[],
): void {
  const opencodePlatform = PLATFORMS.find((p) => p.id === 'opencode');
  if (!opencodePlatform) return;

  const srcDir = path.join(baseDir, opencodePlatform.skillsDir);
  for (const platformId of [...new Set(platformIds)]) {
    const platform = PLATFORMS.find((p) => p.id === platformId);
    if (!platform || platform.id === 'opencode') continue;
    const destDir = path.join(baseDir, getPlatformSkillsDir(platform, scope));
    copyOpenSpecPaths(srcDir, destDir);
  }
}

function migrateZCodeOpenSpecPaths(baseDir: string, scope: InstallScope): void {
  mirrorOpenCodeCompatibleOpenSpecPaths(baseDir, scope, ['zcode']);
}

/**
 * Move openspec skills/commands from srcDir to destDir (used by opencode whose
 * global dir differs from where openspec writes).
 */
function migrateOpenSpecPaths(srcDir: string, destDir: string): void {
  if (srcDir === destDir) return;
  const migrations: Array<[string, string, string]> = [
    [path.join(srcDir, 'skills'), path.join(destDir, 'skills'), 'skills'],
    [path.join(srcDir, 'commands'), path.join(destDir, 'commands'), 'commands'],
  ];

  for (const [from, to, label] of migrations) {
    if (from === to) continue;
    if (!fs.existsSync(from)) continue;
    try {
      const entries = fs.readdirSync(from);
      if (entries.length === 0) continue;

      fs.mkdirSync(to, { recursive: true });
      for (const entry of entries) {
        const srcPath = path.join(from, entry);
        const destPath = path.join(to, entry);
        fs.cpSync(srcPath, destPath, { recursive: true, force: true });
      }
      fs.rmSync(from, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `    Warning: failed to migrate OpenSpec ${label} from ${from} to ${to}: ${(error as Error).message}`,
      );
    }
  }

  // Remove wrong parent directory if both skills and commands have been migrated
  if (fs.existsSync(srcDir)) {
    try {
      const remaining = fs.readdirSync(srcDir);
      if (remaining.length === 0) {
        fs.rmdirSync(srcDir);
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Copy openspec skills/commands from srcDir to destDir (used by zcode which
 * mirrors the opencode output without removing the source).
 */
function copyOpenSpecPaths(srcDir: string, destDir: string): void {
  if (srcDir === destDir) return;
  const copies: Array<[string, string, string]> = [
    [path.join(srcDir, 'skills'), path.join(destDir, 'skills'), 'skills'],
    [path.join(srcDir, 'commands'), path.join(destDir, 'commands'), 'commands'],
  ];

  for (const [from, to, label] of copies) {
    if (from === to) continue;
    if (!fs.existsSync(from)) continue;
    try {
      const entries = fs.readdirSync(from);
      if (entries.length === 0) continue;

      fs.mkdirSync(to, { recursive: true });
      for (const entry of entries) {
        const srcPath = path.join(from, entry);
        const destPath = path.join(to, entry);
        fs.cpSync(srcPath, destPath, { recursive: true, force: true });
      }
    } catch (error) {
      console.error(
        `    Warning: failed to copy OpenSpec ${label} from ${from} to ${to}: ${(error as Error).message}`,
      );
    }
  }
}

async function installOpenSpec(
  projectPath: string,
  toolIds: string[],
  scope: InstallScope,
  shouldInstallCli = true,
  mirrorOpenCodePlatformIds: string[] = [],
  relocateProjectRootToDocs = false,
  quiet = false,
): Promise<'installed' | 'failed' | 'skipped'> {
  const cliStatus = await ensureOpenSpecCli(
    scope,
    projectPath,
    shouldInstallCli,
    relocateProjectRootToDocs,
    quiet,
  );
  if (cliStatus === 'failed') {
    console.error(
      `    OpenSpec CLI not available. Install manually: npm install -g @fission-ai/openspec@latest`,
    );
    return 'failed';
  }
  if (cliStatus === 'missing') {
    return 'skipped';
  }

  const unknownIds = toolIds.filter((id) => !VALID_TOOL_IDS.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown tool IDs: ${unknownIds.join(', ')}`);
  }

  let configHome: string | undefined;
  let configBackup: ConfigBackup | null = null;
  const generatedLegacyRoot = path.join(projectPath, 'openspec');
  const shouldRelocateGeneratedRoot =
    relocateProjectRootToDocs && !fs.existsSync(generatedLegacyRoot);
  try {
    const openspecEnv = createOpenSpecAllWorkflowsEnv();
    configHome = openspecEnv.configHome;

    configBackup = writeAllWorkflowsToDefaultConfig();

    // Windows 上 openspec 是 .cmd shim，必须经 shell 解析才能执行。
    // shell:true 时 Node.js 不对含空格的参数加引号，会导致形如
    // "C:\Users\Test User\project" 的路径被拆成多个参数（issue #123），
    // 因此在启用 shell 时对参数逐个引用。
    const useShell = process.platform === 'win32';

    const invocation = buildOpenSpecInitInvocation(projectPath, toolIds, scope);
    try {
      const initArgs = useShell ? quoteArgsForShell(invocation.args) : invocation.args;
      execFileSync(invocation.command, initArgs, {
        cwd: projectPath,
        env: openspecEnv.env,
        stdio: quiet ? ['ignore', 'ignore', 'pipe'] : ['inherit', 'inherit', 'pipe'],
        timeout: 120_000,
        shell: useShell,
      });
    } catch (firstError) {
      const stderrText = (firstError as { stderr?: Buffer }).stderr?.toString() ?? '';
      if (stderrText.includes('unknown option') && stderrText.includes('--profile')) {
        console.warn('    OpenSpec does not support --profile flag, retrying without it...');
        const fallbackInvocation = buildOpenSpecInitInvocation(
          projectPath,
          toolIds,
          scope,
          os.homedir(),
          false,
        );
        const fallbackArgs = useShell
          ? quoteArgsForShell(fallbackInvocation.args)
          : fallbackInvocation.args;
        execFileSync(fallbackInvocation.command, fallbackArgs, {
          cwd: projectPath,
          env: openspecEnv.env,
          stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
          timeout: 120_000,
          shell: useShell,
        });
      } else {
        throw firstError;
      }
    }

    if (shouldRelocateGeneratedRoot) {
      relocateGeneratedOpenSpecRoot(projectPath);
    }

    const openspecWritesGlobal = scope === 'global';
    const openspecTargetBase = openspecWritesGlobal ? os.homedir() : projectPath;

    // Mirror OpenCode-compatible platforms first, before the opencode global
    // migration potentially moves the source away.
    if (mirrorOpenCodePlatformIds.length > 0 && toolIds.includes('opencode')) {
      mirrorOpenCodeCompatibleOpenSpecPaths(openspecTargetBase, scope, mirrorOpenCodePlatformIds);
    }

    if (openspecWritesGlobal && toolIds.includes('opencode')) {
      migrateOpenCodeOpenSpecPaths(os.homedir());
    }

    return 'installed';
  } catch (error) {
    console.error(`    OpenSpec init failed: ${(error as Error).message}`);
    printCommandErrorDetails(error);
    return 'failed';
  } finally {
    restoreDefaultConfig(configBackup);
    if (configHome) {
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  }
}

export {
  MINIMUM_OPENSPEC_VERSION,
  installOpenSpec,
  isCommandAvailable,
  isOpenSpecVersionCompatible,
  getOpenSpecVersion,
  configureOpenSpecStore,
  assertOpenSpecStoreRegistration,
  assertOpenSpecStoreHealth,
  assertOpenSpecStoreCliSupport,
  openSpecStoreCliSupported,
  getOpenSpecStoreRoot,
  isOpenSpecStoreRoot,
  createOpenSpecStoreId,
  unregisterOpenSpecStore,
  buildOpenSpecInitInvocation,
  buildOpenSpecStoreRegisterInvocation,
  getNpmExecutable,
  migrateOpenCodeOpenSpecPaths,
  migrateZCodeOpenSpecPaths,
  mirrorOpenCodeCompatibleOpenSpecPaths,
};
