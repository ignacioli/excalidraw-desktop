#!/usr/bin/env node
// Resolve feature specs through an explicit, worktree-local binding, never the shared symlink.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function fail(message) {
  console.error(`SPEC_GATE: BLOCKED ${message}`);
  process.exit(2);
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!['bind', 'check'].includes(command)) fail('usage: specs-worktree-gate.mjs bind <absolute-specs-worktree> <branch> <relative-specs-dir> | check');
  const product = realpathSync(process.cwd());
  if (realpathSync(git(product, 'rev-parse', '--show-toplevel')) !== product) fail('run from the product worktree root');
  const primary = realpathSync(git(product, 'worktree', 'list', '--porcelain').split('\n')[0].slice('worktree '.length));
  const sharedLink = join(primary, 'specs');
  if (!existsSync(sharedLink)) fail('primary checkout has no specs symlink');
  const sharedRoot = realpathSync(sharedLink);
  const sharedRepo = realpathSync(git(sharedRoot, 'rev-parse', '--show-toplevel'));
  const projectSubpath = relative(sharedRepo, sharedRoot);
  if (!within(sharedRepo, sharedRoot)) fail('shared specs link must identify a project directory inside the private repository');
  const sharedCommon = realpathSync(resolve(sharedRepo, git(sharedRepo, 'rev-parse', '--git-common-dir')));
  const bindingPath = join(product, '.specify', 'specs-worktree-binding.json');
  let binding;
  if (command === 'bind') {
    if (args.length !== 3) fail('bind requires absolute specs worktree, branch, and relative specs directory');
    if (!isAbsolute(args[0]) || realpathSync(args[0]) !== args[0] || lstatSync(args[0]).isSymbolicLink()) fail('specs worktree must be a canonical absolute directory, not a symlink');
    binding = { specsWorktree: args[0], branch: args[1], specsDirectory: args[2] };
    if (existsSync(bindingPath)) fail('binding exists; review and remove it explicitly before rebinding');
  } else {
    if (args.length) fail('check takes no arguments');
    if (!existsSync(bindingPath)) fail(`no binding at ${bindingPath}; explicitly bind a private specs worktree`);
    binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
  }
  if (typeof binding.specsWorktree !== 'string' || !isAbsolute(binding.specsWorktree) ||
      typeof binding.branch !== 'string' || !binding.branch ||
      typeof binding.specsDirectory !== 'string' || !binding.specsDirectory || isAbsolute(binding.specsDirectory)) fail('invalid binding fields');
  const specsRoot = realpathSync(binding.specsWorktree);
  if (specsRoot !== binding.specsWorktree || specsRoot === sharedRepo || specsRoot === sharedRoot) fail('target is a symlink or the shared specs checkout');
  if (realpathSync(git(specsRoot, 'rev-parse', '--show-toplevel')) !== specsRoot) fail('target is not a specs worktree root');
  const common = realpathSync(resolve(specsRoot, git(specsRoot, 'rev-parse', '--git-common-dir')));
  if (common !== sharedCommon) fail('target is not a worktree of the expected private specs repository');
  if (git(specsRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD') !== binding.branch || ['main', 'master'].includes(binding.branch)) fail('target branch differs or is protected');
  const specsDir = resolve(specsRoot, binding.specsDirectory);
  const projectRoot = resolve(specsRoot, projectSubpath);
  if (!within(specsRoot, projectRoot) || (specsDir !== projectRoot && !within(projectRoot, specsDir)) ||
      !existsSync(specsDir) || realpathSync(specsDir) !== specsDir || !lstatSync(specsDir).isDirectory()) fail('specs directory is missing, outside the expected project, or symlinked');
  if (command === 'bind') {
    mkdirSync(dirname(bindingPath), { recursive: true });
    writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  console.log(`SPEC_GATE: PASS\nSPECS_WORKTREE=${specsRoot}\nSPECS_DIR=${specsDir}\nSPECS_BRANCH=${binding.branch}`);
} catch (error) {
  fail(error.message);
}
