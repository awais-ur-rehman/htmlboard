import http from 'node:http';

// The htmlboard canvases running on this machine, found by asking ports for /api/health: for
// `htmlboard check`, and so that starting htmlboard again for a folder points at the running one.

/** Where htmlboard listens unless told otherwise: 3000, or the next free port */
export const PORTS = Array.from({ length: 21 }, (_, i) => 3000 + i);

/** GET a URL: its status and body */
export function get(url, { timeout = 0 } = {}) {
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

/**
 * The htmlboard servers listening on these ports: each its health (dir, root, version) with its
 * port and url.
 */
export async function findCanvases(ports = PORTS) {
  const found = await Promise.all([...new Set(ports)].map(async (port) => {
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
