import http from 'node:http';
import path from 'node:path';

// `htmlboard check`: the canvas running for a folder, open in a browser, loads its designs and says
// what went wrong in each (see client/check.js); this finds that canvas, asks it, and puts the
// answer in a few lines of text.

/** Where htmlboard listens unless told otherwise: 3000, or the next free port */
const PORTS = Array.from({ length: 21 }, (_, i) => 3000 + i);

/** A problem the check couldn't get past (no canvas running, none open in a browser): exit code 2 */
export class CheckError extends Error {}

function get(url, { timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
  });
}

const isInside = (base, target) => {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The htmlboard servers listening on these ports, each with its designs folder (dir) and root */
async function findCanvases(ports) {
  const found = await Promise.all(ports.map(async (port) => {
    try {
      const { status, body } = await get(`http://127.0.0.1:${port}/api/health`, { timeout: 1500 });
      const health = JSON.parse(body);
      return status === 200 && health.status === 'ok' && health.dir ? { ...health, port, url: `http://localhost:${port}` } : null;
    } catch {
      return null;
    }
  }));
  return found.filter(Boolean);
}

/**
 * Check designs with the canvas that shows them: a designs folder, a folder in it, or a design's
 * file (default: all the designs of the canvas found). The canvas must be open in a browser, where
 * the check runs.
 *
 * @param {string} [target] A path; without one, the canvas's whole folder (looked for from the current one)
 * @param {object} [options]
 * @param {number} [options.port] The canvas's port (default: looked for on 3000 to 3020)
 * @returns {Promise<{canvas: object, report: object}>} The canvas (its url, dir, root) and its report
 */
export async function runCheck(target, { port } = {}) {
  const full = path.resolve(target || process.cwd());
  const canvases = await findCanvases(port ? [Number(port)] : PORTS);
  // The canvas whose folder holds the target (the deepest one), else the only one inside it
  const holding = canvases.filter((canvas) => isInside(canvas.dir, full)).sort((a, b) => b.dir.length - a.dir.length);
  const within = canvases.filter((canvas) => isInside(full, canvas.dir));
  let canvas = holding[0] ?? (within.length === 1 ? within[0] : null);
  if (!canvas && port && !target && canvases.length) canvas = canvases[0];
  if (!canvas) {
    const shown = path.relative(process.cwd(), full) || '.';
    if (within.length > 1) {
      throw new CheckError(`Several canvases show folders in ${shown}: ${within.map((c) => `${path.relative(process.cwd(), c.dir)} (${c.url})`).join(', ')}. Say which one.`);
    }
    if (port) throw new CheckError(canvases.length ? `The canvas at ${canvases[0].url} shows ${canvases[0].dir}, not ${shown}.` : `No htmlboard is running at http://localhost:${port}.`);
    throw new CheckError(`No htmlboard canvas is running for ${shown}. Start it (npx htmlboard <designs folder>) and open it in a browser.`);
  }
  const only = holding[0] === canvas && full !== canvas.dir ? path.relative(canvas.dir, full).split(path.sep).join('/') : '';
  let answer;
  try {
    const { status, body } = await get(`http://127.0.0.1:${canvas.port}/api/check${only ? `?only=${encodeURIComponent(only)}` : ''}`);
    answer = { status, ...JSON.parse(body) };
  } catch (error) {
    throw new CheckError(`The canvas at ${canvas.url} didn't answer (${error.message}).`);
  }
  if (answer.status === 409) {
    throw new CheckError(`The canvas at ${canvas.url} isn't open in a browser, and the check runs there. Open it and try again.`);
  }
  if (answer.status !== 200) throw new CheckError(`${answer.error || `The canvas answered ${answer.status}`}.`);
  const { status, ...report } = answer;
  return { canvas, report };
}

const LEVELS = ['error', 'layout', 'note'];
// The page as a whole first, then its scripts, its components and its files
const KINDS = ['blank', 'timeout', 'check', 'script', 'console', 'component', 'missing', 'load', 'font', 'beyond', 'cut', 'spill', 'below'];

/** Whether the report has something to fix (notes aside) */
export const hasProblems = (report) => report.designs.some((design) => design.problems.some((problem) => problem.level !== 'note'));

/**
 * The report as text: the designs with problems, each followed by its problems (errors, then
 * layout, then notes), with paths from the designs folder.
 *
 * @param {object} report What runCheck returns as `report` (or GET /api/check answers)
 * @param {object} [options]
 * @param {string} [options.name] How to call the designs folder (default: its path)
 * @param {string} [options.url] The canvas's address, to say where the check ran
 */
export function formatReport(report, { name = report.dir, url } = {}) {
  const prefix = path.relative(report.root, report.dir).split(path.sep).join('/');
  // A path from the server's root ("/design/app.js"), from the designs folder instead ("app.js")
  const show = (file) => {
    const bare = String(file).replace(/^\/+/, '');
    return prefix ? path.posix.relative(prefix, bare) : bare;
  };
  const designs = report.designs;
  const failing = designs.filter((design) => design.problems.some((problem) => problem.level !== 'note')).length;
  const noted = designs.filter((design) => design.problems.length && design.problems.every((problem) => problem.level === 'note')).length;
  const lines = [`Checked ${count(designs.length, 'design')} in ${name}${url ? ` (the canvas at ${url})` : ''}: ${
    failing ? `${failing} with problems` : 'no problems found'}${noted ? `, ${noted} with notes` : ''}.`];
  const order = (problem) => LEVELS.indexOf(problem.level) * KINDS.length + KINDS.indexOf(problem.kind);
  for (const design of designs.filter((d) => d.problems.length)) {
    lines.push('', `${show(design.file)}${design.title ? ` · ${design.title}` : ''}`);
    for (const problem of [...design.problems].sort((a, b) => order(a) - order(b))) {
      lines.push(`  ${problem.level.padEnd(6)} ${describe(problem, show)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** A problem in words (see client/check.js for what each kind holds) */
function describe(problem, show) {
  const times = problem.count > 1 ? ` (${problem.count} times)` : '';
  const file = problem.path ? show(problem.path) : problem.url;
  switch (problem.kind) {
    case 'script': {
      const source = problem.source ? (problem.source.startsWith('/') ? show(problem.source) : problem.source) : '';
      return `${problem.message}${source ? ` (${source}${problem.line ? `:${problem.line}` : ''})` : ''}${times}`;
    }
    case 'console':
      return `console.error: ${problem.message}${times}`;
    case 'missing':
      return `missing file: ${file}${problem.tag ? ` (<${problem.tag}>)` : ''}${times}`;
    case 'load':
      return file ? `<${problem.tag}> couldn't load ${file}${times}` : `<${problem.tag}> has nothing to load${times}`;
    case 'font':
      return `font "${problem.family}" didn't load`;
    case 'component':
      if (problem.loader === false) return `<${problem.tag}> isn't built: the page doesn't load components.js`;
      if (problem.found === false) return `<${problem.tag}> isn't built: there is no ${file}`;
      return `<${problem.tag}> isn't built, though ${file || 'its file'} is there (see the errors)`;
    case 'blank':
      return 'the page shows nothing';
    case 'timeout':
      return `still loading after ${problem.seconds} s, checked as it was`;
    case 'beyond':
      return `cut at the right edge (the frame is ${problem.frame} px wide): ${problem.elements
        .map((element) => `${element.selector} reaches ${element.right}`).join(', ')}${problem.more ? `, and ${problem.more} more` : ''}`;
    case 'cut':
      if (problem.more) return `and ${moreBoxes(problem.more)} cut text off`;
      return `text cut off by ${problem.selector} (overflow: ${problem.overflow}): "${problem.text}"${problem.count > 1 ? ` and ${problem.count - 1} more` : ''}`;
    case 'spill':
      if (problem.more) return `and ${moreBoxes(problem.more)} with text spilling out`;
      return `text spills out of ${problem.selector}: "${problem.text}"${problem.count > 1 ? ` and ${problem.count - 1} more` : ''}`;
    case 'below':
      return `content goes on below the frame, down to ${problem.bottom} px (the frame is ${problem.frame} px tall)`;
    case 'check':
      return `couldn't check it: ${problem.message}`;
    default:
      return JSON.stringify(problem);
  }
}

function count(n, what) {
  return `${n} ${what}${n === 1 ? '' : 's'}`;
}

const moreBoxes = (n) => `${n} more ${n === 1 ? 'box' : 'boxes'}`;
