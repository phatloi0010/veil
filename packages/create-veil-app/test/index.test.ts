import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_TEMPLATE_REPO,
  formatCloneError,
  formatDegitSpec,
  getPackageVersion,
  getPinnedTemplateTag,
  parseArgs,
  resolveTemplateSource,
  scaffoldProject,
} from '../src/index.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'create-veil-app-test-'));
}

describe('create-veil-wallet template pinning (#1310)', () => {
  it('derives the default pinned tag from package.json version as an immutable v<semver> tag', () => {
    const version = getPackageVersion();
    const pinnedTag = getPinnedTemplateTag();

    assert.equal(pinnedTag, `v${version}`);
    assert.match(pinnedTag, /^v\d+\.\d+\.\d+/);

    const source = resolveTemplateSource({});
    assert.equal(source.repo, DEFAULT_TEMPLATE_REPO);
    assert.equal(source.ref, pinnedTag);
    assert.equal(source.pinnedTag, pinnedTag);
    assert.equal(source.isOverride, false);
  });

  it('rejects moving-target branch names as the default pin', () => {
    for (const movingRef of ['latest', 'stable', 'main', 'master', 'next']) {
      assert.throws(
        () => getPinnedTemplateTag(movingRef),
        /immutable semver release tag/i,
      );
    }
  });

  it('fetches both the template and sdk using the same pinned tag by default without printing an override notice', async () => {
    const targetDir = createTempDir();
    const clonedSpecs: Array<{ spec: string; dest: string }> = [];
    const warnings: string[] = [];
    const logs: string[] = [];

    try {
      const mockDegit = ((spec: string) => ({
        clone: async (dest: string) => {
          clonedSpecs.push({ spec, dest });
          fs.mkdirSync(dest, { recursive: true });
        },
      })) as unknown as typeof import('degit').default;

      const source = await scaffoldProject(
        {
          name: 'demo-app',
          template: 'vite',
          targetDir,
          env: {},
          skipInstall: true,
        },
        {
          degitFactory: mockDegit,
          warn: msg => warnings.push(msg),
          log: msg => logs.push(msg),
        },
      );

      const expectedTag = `v${getPackageVersion()}`;
      assert.equal(source.ref, expectedTag);
      assert.equal(source.isOverride, false);
      assert.equal(warnings.length, 0);
      assert.deepEqual(
        clonedSpecs.map(c => c.spec),
        [
          `${DEFAULT_TEMPLATE_REPO}/examples/vite-react#${expectedTag}`,
          `${DEFAULT_TEMPLATE_REPO}/sdk#${expectedTag}`,
        ],
      );
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('supports opt-in ref overrides via VEIL_TEMPLATE_REF, inline #ref, or --ref and prints the ref before cloning', async () => {
    const targetDir = createTempDir();
    const events: string[] = [];

    try {
      const mockDegit = ((spec: string) => ({
        clone: async (dest: string) => {
          events.push(`clone:${spec}`);
          fs.mkdirSync(dest, { recursive: true });
        },
      })) as unknown as typeof import('degit').default;

      const source = await scaffoldProject(
        {
          name: 'override-app',
          template: 'next',
          targetDir,
          env: {
            VEIL_TEMPLATE_REPO: 'custom-org/veil',
            VEIL_TEMPLATE_REF: 'feat/custom-template',
          },
          skipInstall: true,
        },
        {
          degitFactory: mockDegit,
          warn: msg => events.push(`warn:${msg}`),
          log: () => {},
        },
      );

      assert.equal(source.repo, 'custom-org/veil');
      assert.equal(source.ref, 'feat/custom-template');
      assert.equal(source.isOverride, true);

      // Verify the override warning was printed BEFORE the first clone call
      assert.equal(events.length, 3);
      assert.match(events[0], /^warn:.*feat\/custom-template/);
      assert.match(events[0], /custom-org\/veil#feat\/custom-template/);
      assert.equal(events[1], 'clone:custom-org/veil/examples/nextjs#feat/custom-template');
      assert.equal(events[2], 'clone:custom-org/veil/sdk#feat/custom-template');

      // Verify inline #ref in VEIL_TEMPLATE_REPO and --ref flag parsing
      const inlineSource = resolveTemplateSource({ VEIL_TEMPLATE_REPO: 'fork/veil#dev-branch' });
      assert.equal(inlineSource.repo, 'fork/veil');
      assert.equal(inlineSource.ref, 'dev-branch');
      assert.equal(inlineSource.isOverride, true);

      const parsed = parseArgs(['my-app', '--template=vanilla', '--ref=v0.2.0-rc.1']);
      assert.equal(parsed.name, 'my-app');
      assert.equal(parsed.template, 'vanilla');
      assert.equal(parsed.ref, 'v0.2.0-rc.1');
      assert.equal(formatDegitSpec(inlineSource, 'sdk'), 'fork/veil/sdk#dev-branch');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('fails with a readable message when a tag does not exist instead of leaking a degit error', async () => {
    const targetDir = createTempDir();

    try {
      const missingRefDegit = ((spec: string) => ({
        clone: async () => {
          const ref = spec.split('#')[1] ?? 'HEAD';
          const err = new Error(`could not find commit hash for ${ref}`) as Error & { code?: string };
          err.code = 'MISSING_REF';
          throw err;
        },
      })) as unknown as typeof import('degit').default;

      await assert.rejects(
        () =>
          scaffoldProject(
            {
              name: 'missing-tag-app',
              template: 'vanilla',
              targetDir,
              env: { VEIL_TEMPLATE_REF: 'v99.99.99-nonexistent' },
              skipInstall: true,
            },
            {
              degitFactory: missingRefDegit,
              warn: () => {},
              log: () => {},
            },
          ),
        (err: unknown) => {
          assert(err instanceof Error);
          assert.match(err.message, /Template tag or ref "v99\.99\.99-nonexistent" was not found in Miracle656\/veil/);
          assert.match(err.message, /VEIL_TEMPLATE_REF/);
          assert.doesNotMatch(err.message, /could not find commit hash for/);
          return true;
        },
      );

      const formatted = formatCloneError(
        Object.assign(new Error('could not find commit hash for v0.1.0'), { code: 'MISSING_REF' }),
        { repo: 'Miracle656/veil', ref: 'v0.1.0' },
      );
      assert.match(formatted.message, /Template tag or ref "v0\.1\.0" was not found in Miracle656\/veil/);
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
