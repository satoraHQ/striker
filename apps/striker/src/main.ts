// Striker HTTP server: node:http, JSON, SSE for the book.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from './config.js';
import { HttpError, Striker } from './striker.js';

const config = loadConfig();
const striker = await Striker.create(config);

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 64_000) throw new HttpError(413, 'body too large'); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T; } catch { throw new HttpError(400, 'invalid JSON'); }
}
const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

function streamBook(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let timer: NodeJS.Timeout | undefined;
  const send = () => { res.write(`event: book\ndata: ${JSON.stringify(striker.book())}\n\n`); };
  // Coalesce bursts (a maker requoting both sides, a fill) into one event per 200 ms.
  const onBook = () => { timer ??= setTimeout(() => { timer = undefined; send(); }, 200); };
  // Expiring quotes leave the book without an event; resend periodically.
  const keepalive = setInterval(send, 5_000);
  send();
  striker.on('book', onBook);
  res.on('close', () => { striker.off('book', onBook); clearInterval(keepalive); clearTimeout(timer); });
}

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /v1/info') return json(res, 200, striker.info());
    if (route === 'GET /v1/book') return json(res, 200, striker.book());
    if (route === 'GET /v1/book/stream') return streamBook(res);
    if (route === 'POST /v1/quotes') return json(res, 200, await striker.publishQuotes(await body(req)));
    if (route === 'POST /v1/swaps/preview') return json(res, 200, striker.preview(await body(req)));
    if (route === 'POST /v1/swaps') return json(res, 201, striker.createSwap(await body(req)));
    const swap = /^\/v1\/swaps\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && swap) return json(res, 200, striker.getSwap(swap[1]!));
    json(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    json(res, status, { error: (e as Error).message });
  }
});

server.listen(config.port, () => {
  const info = striker.info();
  console.log(`striker on :${config.port} (${info.network}), asset ${info.asset.id}, fee ${info.feeBps} bps, fee address ${info.feeAddress}`);
  console.log(`renew delegate ${info.renew.delegateKey}, window ${info.renew.window} s`);
  striker.start();
});
const shutdown = () => { striker.stop(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
