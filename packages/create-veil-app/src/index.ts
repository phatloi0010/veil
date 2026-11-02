#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import degit from 'degit';
import prompts from 'prompts';

export const DEFAULT_TEMPLATE_REPO = 'Miracle656/veil';

const MOVING_TARGET_REFS = new Set(['latest', 'stable', 'main', 'master', 'head', 'next', 'dev', 'trunk']);

export const TEMPLATES = {
  next: { label: 'Next.js', dir: 'examples/nextjs' },
  vite: { label: 'Vite + React', dir: 'examples/vite-react' },
  vanilla: { label: 'Vanilla JS', dir: 'examples/vanilla' },
} as const;

export type TemplateKey = keyof typeof TEMPLATES;

export interface TemplateSource {
  repo: string;
  ref: string;
  pinnedTag: string;
  isOverride: boolean;
}

export interface ScaffoldDependencies {
  degitFactory?: typeof degit;
  runCmd?: (cmd: string, args: string[], cwd: string) => Promise<void>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export function isTemplateKey(value: string): value is TemplateKey {
  return value in TEMPLATES;
}

export function getPackageVersion(
  pkgJsonPath: string = fileURLToPath(new URL('../package.json', import.meta.url)),
): string {
  const raw = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version?: unknown };
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!version) {
    throw new Error(`Could not determine package version from ${pkgJsonPath}`);
  }
  return version;
}

export function getPinnedTemplateTag(version: string = getPackageVersion()): string {
  const cleaned = version.trim().replace(/^v/, '');
  if (!cleaned || MOVING_TARGET_REFS.has(cleaned.toLowerCase()) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cleaned)) {
    throw new Error(
      `Invalid pinned template version "${version}". Default template pin must resolve to an immutable semver release tag.`,
    );
  }
  return `v${cleaned}`;
}

export function resolveTemplateSource(
  env: NodeJS.ProcessEnv = process.env,
  cliRef?: string,
  version?: string,
): TemplateSource {
  const pinnedTag = getPinnedTemplateTag(version);
  const rawRepoEnv = env.VEIL_TEMPLATE_REPO?.trim();

  let repo = DEFAULT_TEMPLATE_REPO;
  let inlineRef: string | undefined;

  if (rawRepoEnv) {
    const hashIndex = rawRepoEnv.indexOf('#');
    if (hashIndex !== -1) {
      repo = rawRepoEnv.slice(0, hashIndex).trim() || DEFAULT_TEMPLATE_REPO;
      inlineRef = rawRepoEnv.slice(hashIndex + 1).trim() || undefined;
    } else {
      repo = rawRepoEnv;
    }
  }

  const envRef = env.VEIL_TEMPLATE_REF?.trim() || undefined;
  const explicitRef = cliRef?.trim() || envRef || inlineRef;
  const ref = explicitRef || pinnedTag;
  const isOverride = Boolean(explicitRef && explicitRef !== pinnedTag) || repo !== DEFAULT_TEMPLATE_REPO;

  return {
    repo,
    ref,
    pinnedTag,
    isOverride,
  };
}

export function formatDegitSpec(source: Pick<TemplateSource, 'repo' | 'ref'>, subdir: string): string {
  const cleanSubdir = subdir.replace(/^\/+|\/+$/g, '');
  return `${source.repo}/${cleanSubdir}#${source.ref}`;
}

export function announceTemplateSource(
  source: TemplateSource,
  warn: (msg: string) => void = console.warn,
): void {
  if (!source.isOverride) return;
  warn(
    `Using overridden template ref "${source.ref}" from ${source.repo} (${source.repo}#${source.ref}; default pinned tag is ${DEFAULT_TEMPLATE_REPO}#${source.pinnedTag}).`,
  );
}

export function formatCloneError(err: unknown, source: Pick<TemplateSource, 'repo' | 'ref'>): Error {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);

  if (
    code === 'MISSING_REF' ||
    code === 'BAD_REF' ||
    /could not find commit hash for/i.test(message) ||
    /Unable to Read Remote Reference/i.test(message)
  ) {
    return new Error(
      `Template tag or ref "${source.ref}" was not found in ${source.repo}. ` +
        `Verify that the release tag "${source.ref}" exists on GitHub, or set VEIL_TEMPLATE_REF=<branch-or-tag> to use a different ref during development.`,
    );
  }

  return new Error(`Failed to fetch Veil template from ${source.repo}#${source.ref}: ${message}`);
}

export async function cloneSubdir(
  source: Pick<TemplateSource, 'repo' | 'ref'>,
  subdir: string,
  destDir: string,
  degitFactory: typeof degit = degit,
): Promise<void> {
  const spec = formatDegitSpec(source, subdir);
  try {
    await degitFactory(spec, { force: true }).clone(destDir);
  } catch (err) {
    throw formatCloneError(err, source);
  }
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`"${cmd} ${args.join(' ')}" exited with code ${code}`));
    });
  });
}

function replaceInFile(filePath: string, search: string, replace: string) {
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, 'utf8');
  fs.writeFileSync(filePath, contents.split(search).join(replace));
}

// The vendored sdk/ is consumed as a built dependency, not project source.
// Without this, a template's own tsconfig.json (e.g. Next.js's "**/*.ts"
// include) sweeps up the SDK's raw TypeScript and type-checks it against
// the app's compiler target, which can fail (e.g. ES2017 vs. the SDK's
// ES2020 BigInt literals).
function excludeSdkFromTsconfig(targetDir: string) {
  const tsconfigPath = path.join(targetDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return;
  try {
    const config = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
    const exclude: string[] = Array.isArray(config.exclude) ? config.exclude : [];
    if (!exclude.includes('sdk')) exclude.push('sdk');
    config.exclude = exclude;
    fs.writeFileSync(tsconfigPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    console.warn('Could not update tsconfig.json to exclude sdk/ — you may need to add it manually.');
  }
}

export function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  let template: string | undefined;
  let ref: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith('--template=')) template = arg.slice('--template='.length);
    else if (arg.startsWith('--ref=')) ref = arg.slice('--ref='.length);
    else if (!arg.startsWith('-')) positionals.push(arg);
  }

  return { name: positionals[0], template, ref };
}

export async function scaffoldProject(
  options: {
    name: string;
    template: TemplateKey;
    targetDir: string;
    env?: NodeJS.ProcessEnv;
    cliRef?: string;
    version?: string;
    skipInstall?: boolean;
  },
  deps: ScaffoldDependencies = {},
): Promise<TemplateSource> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const degitFactory = deps.degitFactory ?? degit;
  const runCmd = deps.runCmd ?? run;

  const source = resolveTemplateSource(options.env, options.cliRef, options.version);
  const { dir, label } = TEMPLATES[options.template];

  log(`\nScaffolding ${label} app in ./${options.name}...\n`);
  announceTemplateSource(source, warn);

  await cloneSubdir(source, dir, options.targetDir, degitFactory);

  log('Fetching the Veil SDK...');
  await cloneSubdir(source, 'sdk', path.join(options.targetDir, 'sdk'), degitFactory);

  // Templates reference the SDK from the monorepo (file:../../sdk); once
  // scaffolded standalone the SDK lives at ./sdk instead.
  replaceInFile(path.join(options.targetDir, 'package.json'), 'file:../../sdk', 'file:./sdk');
  replaceInFile(path.join(options.targetDir, 'index.html'), '../../sdk/dist/vanilla.js', './sdk/dist/vanilla.js');
  excludeSdkFromTsconfig(options.targetDir);

  if (!options.skipInstall) {
    log('Installing SDK dependencies and building...');
    await runCmd('npm', ['install'], path.join(options.targetDir, 'sdk'));
    await runCmd('npm', ['run', 'build'], path.join(options.targetDir, 'sdk'));

    if (fs.existsSync(path.join(options.targetDir, 'package.json'))) {
      log('Installing app dependencies...');
      await runCmd('npm', ['install'], options.targetDir);
    }
  }

  log(`\nDone! Next steps:\n`);
  log(`  cd ${options.name}`);
  log(options.template === 'vanilla' ? '  npx http-server .   # or any static file server' : '  npm run dev');
  log(`\nSee ${options.name}/README.md for environment variables (factory address, RPC URL, etc.).\n`);

  return source;
}

async function main() {
  const { name: nameArg, template: templateArg, ref: refArg } = parseArgs(process.argv.slice(2));

  let name = nameArg;
  if (!name) {
    const response = await prompts(
      { type: 'text', name: 'name', message: 'Project name', initial: 'my-veil-app' },
      { onCancel: () => process.exit(1) },
    );
    name = response.name;
  }
  if (!name) {
    console.error('A project name is required.');
    process.exit(1);
  }

  const targetDir = path.resolve(process.cwd(), name);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    console.error(`Directory "${name}" already exists and is not empty.`);
    process.exit(1);
  }

  let template = templateArg;
  if (!template || !isTemplateKey(template)) {
    const response = await prompts(
      {
        type: 'select',
        name: 'template',
        message: 'Choose a template',
        choices: Object.entries(TEMPLATES).map(([value, { label }]) => ({ title: label, value })),
      },
      { onCancel: () => process.exit(1) },
    );
    template = response.template;
  }
  if (!template || !isTemplateKey(template)) {
    console.error(`A template choice is required. Available: ${Object.keys(TEMPLATES).join(', ')}`);
    process.exit(1);
  }

  await scaffoldProject({
    name,
    template,
    targetDir,
    cliRef: refArg,
  });
}

function isCliEntrypoint(argv1: string | undefined, metaUrl: string): boolean {
  if (!argv1) return false;
  const selfPath = fileURLToPath(metaUrl);
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(selfPath);
  } catch {
    return path.resolve(argv1) === path.resolve(selfPath);
  }
}

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
