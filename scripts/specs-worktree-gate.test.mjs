import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const gate = fileURLToPath(new URL('./specs-worktree-gate.mjs', import.meta.url));
function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'specs-gate-')));
  const product = join(root, 'product');
  const shared = join(root, 'private');
  const isolated = join(root, 'private-feature');
  mkdirSync(product);
  mkdirSync(shared);
  git(product, 'init', '-q');
  git(shared, 'init', '-q');
  git(shared, 'config', 'user.name', 'Gate Test');
  git(shared, 'config', 'user.email', 'gate@example.invalid');
  mkdirSync(join(shared, 'product', '001-feature'), { recursive: true });
  writeFileSync(join(shared, 'product', '001-feature', 'spec.md'), 'fixture');
  git(shared, 'add', '.');
  git(shared, 'commit', '-qm', 'fixture');
  git(shared, 'worktree', 'add', '-qb', 'feature-specs', isolated);
  symlinkSync(join(shared, 'product'), join(product, 'specs'));
  return { product, shared, isolated };
}
function run(product, ...args) {
  return spawnSync(process.execPath, [gate, ...args], { cwd: product, encoding: 'utf8' });
}

test('unbound feature access fails closed', () => {
  const { product } = fixture();
  assert.equal(run(product, 'check').status, 2);
});

test('bind and check return the isolated feature path', () => {
  const { product, isolated } = fixture();
  const bind = run(product, 'bind', isolated, 'feature-specs', 'product/001-feature');
  assert.equal(bind.status, 0, bind.stderr);
  const checked = run(product, 'check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, new RegExp(`SPECS_DIR=${isolated}/product/001-feature`));
  const saved = JSON.parse(readFileSync(join(product, '.specify', 'specs-worktree-binding.json'), 'utf8'));
  assert.equal(saved.specsWorktree, isolated);
  assert.equal(run(product, 'bind', isolated, 'feature-specs', 'product/001-feature').status, 2);
  git(isolated, 'branch', '-m', 'renamed');
  assert.equal(run(product, 'check').status, 2);
});

test('project-level binding supports discovery before a feature directory exists', () => {
  const { product, isolated } = fixture();
  const bound = run(product, 'bind', isolated, 'feature-specs', 'product');
  assert.equal(bound.status, 0, bound.stderr);
  assert.match(run(product, 'check').stdout, new RegExp(`SPECS_DIR=${isolated}/product`));
});

test('reject shared checkout, traversal, wrong repository and symlink feature', () => {
  const { product, shared, isolated } = fixture();
  assert.equal(run(product, 'bind', shared, 'feature-specs', 'product/001-feature').status, 2);
  assert.equal(run(product, 'bind', isolated, 'feature-specs', '../private').status, 2);
  mkdirSync(join(isolated, 'other-project', '001-feature'), { recursive: true });
  assert.equal(run(product, 'bind', isolated, 'feature-specs', 'other-project/001-feature').status, 2);
  assert.equal(run(product, 'bind', product, 'feature-specs', 'product/001-feature').status, 2);
  symlinkSync(join(isolated, 'product', '001-feature'), join(isolated, 'linked-feature'));
  assert.equal(run(product, 'bind', isolated, 'feature-specs', 'linked-feature').status, 2);
});
