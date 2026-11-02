#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { installSkills, uninstallSkills } from '../src/skills.js';
import { planMigration, checkMigration, applyMigration } from '../src/migrate.js';
import { installComponents, COMPONENTS_FOLDER, COMPONENTS_SCRIPT } from '../src/components.js';
import { buildCatalog, formatCatalog } from '../src/catalog.js';
import { runCheck, formatReport, hasProblems, CheckError } from '../src/check.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_PATH = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

// Parse command line arguments
function parseArgs(args) {
  const options = {
    port: 3000,
    dir: process.cwd(),
    root: null,
    open: false,
    init: false,
    help: false,
    version: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--open' || arg === '-o') {
      options.open = true;
    } else if (arg === '--init') {
      options.init = true;
    } else if (arg === '--port' || arg === '-p') {
      const next = args[++i];
      if (next && !next.startsWith('-')) {
        options.port = parseInt(next, 10);
      }
    } else if (arg.startsWith('--port=')) {
      options.port = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--dir' || arg === '-d') {
      const next = args[++i];
      if (next && !next.startsWith('-')) {
        options.dir = next;
      }
    } else if (arg.startsWith('--dir=')) {
      options.dir = arg.split('=')[1];
    } else if (arg === '--root' || arg === '-r') {
      const next = args[++i];
      if (next && !next.startsWith('-')) {
        options.root = next;
      }
    } else if (arg.startsWith('--root=')) {
      options.root = arg.split('=')[1];
    } else if (!arg.startsWith('-')) {
      // Positional directory argument e.g. `htmlboard ./my-designs`
      options.dir = arg;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
htmlboard v${pkg.version}
Infinite canvas and design explorer for HTML artboards — designed for humans and LLMs

Usage:
  htmlboard [directory] [options]
  npx htmlboard [directory] [options]
  htmlboard skills <install|uninstall> [options]   Teach your AI agent to use HtmlBoard
  htmlboard migrate [directory] [--write]          Move designs.json's sizes, titles and variants into the files
  htmlboard components [directory] [--force]       Add components.js: files in components/ become custom elements
  htmlboard catalog [directory]                    What the designs share: stylesheets, scripts, components
  htmlboard check [directory or file] [-p <port>]  What went wrong in the designs, from the canvas open in a browser

Options:
  -p, --port <number>   Port to listen on (default: 3000)
  -d, --dir <path>      Directory to serve HTML artboards from (default: .)
  -r, --root <path>     Serve files from this parent folder, so artboards can link to
                        shared files outside the designs folder (default: the designs folder)
  -o, --open            Open the explorer automatically in your default browser
      --init            Add sample designs (two folders of artboards) to the directory
  -v, --version         Display the version
  -h, --help            Display this help message

Examples:
  htmlboard                     # Run in current directory on http://localhost:3000
  htmlboard --open              # Run and launch browser automatically
  htmlboard ./designs -p 8080   # Serve ./designs on port 8080
  htmlboard design --root .     # Artboards in ./design that link to ../css/…
  htmlboard --init              # Add sample designs to the current folder
  htmlboard skills install      # Add the HtmlBoard skill to this project's agents
  htmlboard components designs  # Let ./designs use components (components/tx-item.html is <tx-item>)
  htmlboard catalog designs     # What ./designs share, in a few lines (for your AI agent)
  htmlboard check designs       # Script errors, missing files, cut-off text in ./designs

On the canvas:
  Drag, scroll          Move around
  Ctrl/Cmd + scroll     Zoom (or pinch)
  Double-click          Fit a design (Shift + 1 fits everything)
  /                     Search
  1 – 4                 Show all, mobile, tablet, desktop
  ?                     All the shortcuts
`);
}

function openBrowser(url) {
  const startCmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
    ? 'start'
    : 'xdg-open';

  exec(`${startCmd} ${url}`, (err) => {
    if (err) {
      console.warn(`[htmlboard] Unable to auto-launch browser: ${err.message}`);
    }
  });
}

function scaffoldProject(targetDir) {
  const templatesDir = path.join(__dirname, '..', 'src', 'templates');
  console.log(`[htmlboard] Adding sample designs to ${targetDir}...`);
  // Folders are sections and number prefixes the order; each file says its own size
  const copy = (from, rel) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const relPath = path.join(rel, entry.name);
      const dest = path.join(targetDir, relPath);
      if (entry.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        copy(path.join(from, entry.name), relPath);
      } else if (fs.existsSync(dest)) {
        console.log(`  ℹ ${relPath} already exists (skipped)`);
      } else {
        fs.copyFileSync(path.join(from, entry.name), dest);
        console.log(`  ✓ Created ${relPath}`);
      }
    }
  };
  fs.mkdirSync(targetDir, { recursive: true });
  copy(templatesDir, '');
}

function showSkillsHelp() {
  console.log(`
Usage:
  htmlboard skills install [options]     Copy the HtmlBoard skill into your agents' skill folders
  htmlboard skills uninstall [options]   Remove it

Options:
  -g, --global          Install for your user (~/.claude/skills, ~/.agents/skills) instead of this project
  -a, --agent <name>    claude (.claude/skills), agents (.agents/skills: Codex and other agents), or all (default)
  -d, --dir <path>      Project root (default: current directory)
  -f, --force           Replace a skill that was changed locally
  -h, --help            Display this help message
`);
}

function runSkills(args) {
  const [action, ...rest] = args;
  const options = { agent: 'all', global: false, dir: process.cwd(), force: false };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--global' || arg === '-g') options.global = true;
    else if (arg === '--force' || arg === '-f') options.force = true;
    else if (arg === '--agent' || arg === '-a') options.agent = rest[++i];
    else if (arg.startsWith('--agent=')) options.agent = arg.split('=')[1];
    else if (arg === '--dir' || arg === '-d') options.dir = rest[++i];
    else if (arg.startsWith('--dir=')) options.dir = arg.split('=')[1];
    else if (arg === '--help' || arg === '-h') return showSkillsHelp();
    else {
      console.error(`[htmlboard] Unknown option: ${arg}`);
      showSkillsHelp();
      process.exit(1);
    }
  }

  if (action !== 'install' && action !== 'uninstall') {
    showSkillsHelp();
    process.exit(action && action !== '--help' && action !== '-h' ? 1 : 0);
  }

  let results;
  try {
    results = action === 'install' ? installSkills(options) : uninstallSkills(options);
  } catch (err) {
    console.error(`[htmlboard] ${err.message}`);
    process.exit(1);
  }

  const labels = {
    installed: '\x1b[32m✓ installed\x1b[0m',
    updated: '\x1b[32m✓ updated\x1b[0m',
    unchanged: '\x1b[90m= up to date\x1b[0m',
    skipped: '\x1b[33m! changed locally, kept (use --force to replace)\x1b[0m',
    removed: '\x1b[32m✓ removed\x1b[0m',
    absent: '\x1b[90m- not installed\x1b[0m'
  };
  for (const { path: dest, status } of results) {
    console.log(`  ${labels[status]}  ${path.relative(process.cwd(), dest) || dest}`);
  }
  if (action === 'install' && results.some((r) => r.status === 'installed' || r.status === 'updated')) {
    console.log(`\n  Restart your agent session to load the skill, then ask it for a design.`);
  }
}

function runComponents(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  htmlboard components [directory] [--force]

Adds ${COMPONENTS_SCRIPT} and a ${COMPONENTS_FOLDER}/ folder to the designs folder (default: the current one).
Each file in ${COMPONENTS_FOLDER}/ is then a custom element named after it (${COMPONENTS_FOLDER}/tx-item.html is
<tx-item>) in the designs that load ${COMPONENTS_SCRIPT}, once, beside their stylesheet:

  <script type="module" src="../${COMPONENTS_SCRIPT}"></script>

A ${COMPONENTS_SCRIPT} that differs from this version's (an older one, or one you edited) is kept;
--force replaces it.
`);
    return;
  }
  const unknown = args.find((arg) => arg.startsWith('-') && arg !== '--force' && arg !== '-f');
  if (unknown) {
    console.error(`[htmlboard] Unknown option: ${unknown} (see htmlboard components --help)`);
    process.exit(1);
  }
  const dirArg = args.find((arg) => !arg.startsWith('-'));
  const { path: dest, status } = installComponents({
    dir: dirArg || process.cwd(),
    force: args.includes('--force') || args.includes('-f')
  });
  const labels = {
    installed: '\x1b[32m✓ added\x1b[0m',
    updated: '\x1b[32m✓ updated\x1b[0m',
    unchanged: '\x1b[90m= up to date\x1b[0m',
    skipped: '\x1b[33m! differs from this version, kept (use --force to replace)\x1b[0m'
  };
  console.log(`  ${labels[status]}  ${path.relative(process.cwd(), dest) || dest}`);
  if (status === 'installed') {
    const folder = path.relative(process.cwd(), path.join(path.dirname(dest), COMPONENTS_FOLDER)) || COMPONENTS_FOLDER;
    console.log(`\n  Write components in ${folder}/ (tx-item.html is <tx-item>) and load ${COMPONENTS_SCRIPT} in the designs.`);
  }
}

// A folder as the user would type it: from the current folder, unless that means going up
function shownPath(dir) {
  const rel = path.relative(process.cwd(), dir);
  return !rel ? '.' : rel.startsWith('..') ? dir : rel;
}

function runCatalog(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  htmlboard catalog [directory] [--root <path>]

Prints what the designs in the folder (default: the current one) share, read from the files: the
stylesheets and scripts they load, each local stylesheet's variables, classes, @keyframes and
fonts, and the components in ${COMPONENTS_FOLDER}/ with their attributes, slots, example and where
they are used. A few lines instead of every file, for the AI agent that writes the designs.

Options:
  -r, --root <path>   The folder the canvas serves (htmlboard … --root), for links that start
                      with "/" (default: the designs folder)
`);
    return;
  }
  let root;
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root' || arg === '-r') root = args[++i];
    else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
    else if (arg.startsWith('-')) {
      console.error(`[htmlboard] Unknown option: ${arg} (see htmlboard catalog --help)`);
      process.exit(1);
    } else dirs.push(arg);
  }
  let catalog;
  try {
    catalog = buildCatalog(dirs[0] || process.cwd(), { root });
  } catch (err) {
    console.error(`[htmlboard] ${err.message}`);
    process.exit(1);
  }
  process.stdout.write(formatCatalog(catalog, { name: shownPath(catalog.dir) }));
}

async function runCheckCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  htmlboard check [directory or file] [-p <port>] [--json]

Has the canvas running for the designs (open in a browser: the check runs there) load each one
afresh and prints what went wrong, in a few lines of text: script errors and console.error, files
that aren't there, components that weren't built, fonts that didn't load, content cut at the
frame's edge, text cut off or spilling out of its box. A directory checks the designs in it, a
file just that design (default: the current directory).

Exits with 1 when it finds problems, 2 when it can't check (no canvas running, or none open).

Options:
  -p, --port <number>   The canvas's port (default: found on 3000 to 3020)
      --json            The report as JSON
`);
    return;
  }
  let port;
  let asJson = false;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') port = parseInt(args[++i], 10);
    else if (arg.startsWith('--port=')) port = parseInt(arg.slice('--port='.length), 10);
    else if (arg === '--json') asJson = true;
    else if (arg.startsWith('-')) {
      console.error(`[htmlboard] Unknown option: ${arg} (see htmlboard check --help)`);
      process.exit(2);
    } else targets.push(arg);
  }
  try {
    const { canvas, report } = await runCheck(targets[0], { port });
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else process.stdout.write(formatReport(report, { name: shownPath(report.dir), url: canvas.url }));
    process.exitCode = hasProblems(report) ? 1 : 0;
  } catch (err) {
    console.error(err instanceof CheckError ? err.message : `[htmlboard] ${err.message}`);
    process.exitCode = 2;
  }
}

function runMigrate(args) {
  const write = args.includes('--write');
  const dirArg = args.find((arg) => !arg.startsWith('-'));
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  htmlboard migrate [directory] [--write]

Moves what designs.json says about each design into the design's own file (its size, category,
label, variants and description, as <meta> tags after its <title>) and leaves designs.json with
the sections, their titles and order, and the values that differ from the files'.

Without --write it only shows what it would do, and checks that the canvas stays the same.
`);
    return;
  }
  const dir = path.resolve(dirArg || process.cwd());
  let plan;
  try {
    plan = planMigration(dir);
  } catch (err) {
    console.error(`[htmlboard] Can't read ${path.join(dir, 'designs.json')}: ${err.message}`);
    process.exit(1);
  }
  const differences = checkMigration(dir, plan);
  const [before, after] = plan.entries;

  console.log(`\n  \x1b[1m${path.relative(process.cwd(), dir) || '.'}\x1b[0m`);
  if (!plan.files.length) console.log('  \x1b[90mNo file to change.\x1b[0m');
  for (const { file, lines } of plan.files) {
    console.log(`\n  ${file}`);
    for (const line of lines) console.log(`    \x1b[32m+\x1b[0m ${line}`);
  }
  console.log(`\n  designs.json: ${before} entries → ${after}`);
  if (differences.length) {
    console.log(`\n  \x1b[33mThe canvas would change:\x1b[0m`);
    for (const { before: was, after: will } of differences.slice(0, 20)) {
      if (was) console.log(`    \x1b[31m-\x1b[0m ${was}`);
      if (will) console.log(`    \x1b[32m+\x1b[0m ${will}`);
    }
  } else {
    console.log(`  \x1b[32m✓\x1b[0m The canvas stays the same.`);
  }

  if (!write) {
    console.log(`\n  Nothing written. Run again with --write to apply.\n`);
    return;
  }
  applyMigration(dir, plan);
  console.log(`\n  \x1b[32m✓ Written:\x1b[0m ${plan.files.length} file${plan.files.length === 1 ? '' : 's'} and designs.json.\n`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === 'skills') {
    runSkills(args.slice(1));
    return;
  }

  if (args[0] === 'components') {
    runComponents(args.slice(1));
    return;
  }

  if (args[0] === 'migrate') {
    runMigrate(args.slice(1));
    return;
  }

  if (args[0] === 'catalog') {
    runCatalog(args.slice(1));
    return;
  }

  if (args[0] === 'check') {
    await runCheckCommand(args.slice(1));
    return;
  }

  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (options.version) {
    console.log(`htmlboard v${pkg.version}`);
    process.exit(0);
  }

  const targetDir = path.resolve(options.dir);

  if (options.init) {
    scaffoldProject(targetDir);
  }

  // An empty folder (or a new one) gets the sample designs
  let entries = [];
  try {
    entries = fs.readdirSync(targetDir);
  } catch (_) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  if (!options.init && !entries.some((e) => !e.startsWith('.'))) {
    console.log(`[htmlboard] Directory is empty. Adding sample designs...`);
    scaffoldProject(targetDir);
  }

  try {
    const { url, rootDir } = await startServer({
      dir: targetDir,
      root: options.root ? path.resolve(options.root) : undefined,
      port: options.port
    });

    console.log(`
  \x1b[90mhtml\x1b[0m\x1b[1mboard\x1b[0m \x1b[90mv${pkg.version}\x1b[0m
  \x1b[90mInfinite canvas for HTML designs\x1b[0m

  \x1b[32m➜\x1b[0m  \x1b[1mLocal:\x1b[0m   \x1b[36m${url}\x1b[0m
  \x1b[32m➜\x1b[0m  \x1b[1mTarget:\x1b[0m  \x1b[90m${targetDir}\x1b[0m${rootDir !== targetDir ? `\n  \x1b[32m➜\x1b[0m  \x1b[1mRoot:\x1b[0m    \x1b[90m${rootDir}\x1b[0m` : ''}
  \x1b[32m➜\x1b[0m  \x1b[1mLive:\x1b[0m    \x1b[32mWatching files for hot live reload\x1b[0m

  \x1b[90mPress \x1b[1mCtrl+C\x1b[0m\x1b[90m to stop.\x1b[0m
`);

    if (options.open) {
      openBrowser(url);
    }
  } catch (err) {
    console.error(`[htmlboard] Error starting server:`, err.message);
    process.exit(1);
  }
}

main();
