import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installSkills, uninstallSkills, SKILLS_DIR } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'htmlboard.js');
const SKILLS = ['htmlboard', 'htmlboard-components', 'htmlboard-designs-json'];

describe('Agent skills', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'htmlboard-skills-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('each bundled skill has a valid SKILL.md frontmatter, named after its folder', () => {
    const bundled = fs.readdirSync(SKILLS_DIR).filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'))).sort();
    assert.deepEqual(bundled, SKILLS);
    for (const name of SKILLS) {
      const skill = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
      const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(frontmatter, `${name}: SKILL.md starts with a frontmatter block`);
      assert.match(frontmatter[1], new RegExp(`^name: ${name}$`, 'm'));
      assert.match(frontmatter[1], /^description: .{20,1024}$/m);
    }
    // The main skill says when to use the others
    const main = fs.readFileSync(path.join(SKILLS_DIR, 'htmlboard', 'SKILL.md'), 'utf8');
    for (const name of SKILLS.slice(1)) assert.ok(main.includes(`**${name}**`), name);
  });

  test('installSkills copies the skills for every agent by default', () => {
    const results = installSkills({ dir: tmp });
    assert.deepEqual(results.map((r) => r.status), Array(SKILLS.length * 2).fill('installed'));
    for (const target of ['.claude/skills', '.agents/skills']) {
      for (const name of SKILLS) assert.ok(fs.existsSync(path.join(tmp, target, name, 'SKILL.md')), `${target}/${name}`);
    }
  });

  test('installSkills honours --agent', () => {
    installSkills({ dir: tmp, agent: 'claude' });
    assert.ok(fs.existsSync(path.join(tmp, '.claude/skills/htmlboard/SKILL.md')));
    assert.ok(!fs.existsSync(path.join(tmp, '.agents')));
    assert.throws(() => installSkills({ dir: tmp, agent: 'nope' }), /Unknown agent/);
  });

  test('reinstalling is a no-op, and local edits are kept unless forced', () => {
    installSkills({ dir: tmp, agent: 'claude' });
    assert.equal(installSkills({ dir: tmp, agent: 'claude' })[0].status, 'unchanged');

    const installed = path.join(tmp, '.claude/skills/htmlboard/SKILL.md');
    fs.appendFileSync(installed, '\nMy own notes.\n');
    assert.equal(installSkills({ dir: tmp, agent: 'claude' })[0].status, 'skipped');
    assert.match(fs.readFileSync(installed, 'utf8'), /My own notes/);

    assert.equal(installSkills({ dir: tmp, agent: 'claude', force: true })[0].status, 'updated');
    assert.doesNotMatch(fs.readFileSync(installed, 'utf8'), /My own notes/);
  });

  test('uninstallSkills removes only the htmlboard skills', () => {
    installSkills({ dir: tmp });
    fs.mkdirSync(path.join(tmp, '.claude/skills/other'), { recursive: true });

    const results = uninstallSkills({ dir: tmp });
    assert.deepEqual(results.map((r) => r.status), Array(SKILLS.length * 2).fill('removed'));
    for (const name of SKILLS) assert.ok(!fs.existsSync(path.join(tmp, '.claude/skills', name)));
    assert.ok(fs.existsSync(path.join(tmp, '.claude/skills/other')));
    assert.deepEqual(uninstallSkills({ dir: tmp }).map((r) => r.status), Array(SKILLS.length * 2).fill('absent'));
  });

  test('CLI: htmlboard skills install', () => {
    const out = execFileSync(process.execPath, [BIN, 'skills', 'install', '--agent', 'agents'], { cwd: tmp, encoding: 'utf8' });
    assert.match(out, /installed/);
    assert.ok(fs.existsSync(path.join(tmp, '.agents/skills/htmlboard/SKILL.md')));
  });
});
