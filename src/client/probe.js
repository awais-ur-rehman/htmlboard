// probe.js: notes what goes wrong while a design's page builds (script errors, console.error, files
// that don't load), for `htmlboard check`. The server puts it first in the <head> of the pages shown
// in frames, so it hears everything from the start. It only listens in the frames the check loads
// (named htmlboard-check): the canvas's own frames, and a page opened on its own, are left as they are.
(() => {
  if (window.name !== 'htmlboard-check') return;
  const MOST = 100;
  const problems = [];
  const note = (problem) => {
    if (problems.length < MOST) problems.push(problem);
  };
  const describe = (value) => {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  // Capturing: an element's failed load (an <img>, a <script>, a <link>) doesn't bubble
  addEventListener('error', (event) => {
    const { target } = event;
    if (target instanceof Element) {
      const url = [target.currentSrc, target.src, target.href, target.href?.baseVal].find((value) => typeof value === 'string');
      note({ kind: 'load', tag: target.localName, url: url || '' });
    } else {
      const message = event.message || describe(event.error);
      note({ kind: 'script', message: message.replace(/^Uncaught /, ''), source: event.filename || '', line: event.lineno || 0 });
    }
  }, true);
  addEventListener('unhandledrejection', (event) => {
    note({ kind: 'script', message: `(in a promise) ${describe(event.reason)}`, source: '', line: 0 });
  });
  const error = console.error;
  console.error = function (...args) {
    note({ kind: 'console', message: args.map(describe).join(' ') });
    return error.apply(this, args);
  };
  Object.defineProperty(window, '__htmlboard', { value: Object.freeze({ problems }) });
})();
