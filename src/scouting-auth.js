// Steam OAuth flow for desktop app.
//
// Standard OAuth-for-desktop pattern:
//   1. Spawn an ephemeral HTTP server on localhost:<random-port>
//   2. Open the user's default browser to /scouting-auth-web/start
//      with return_to pointing at our local server.
//   3. User does Steam OpenID in browser, gets redirected back to our
//      localhost callback with ?session=<scout_token>.
//   4. Local server captures the token, returns a "you can close this
//      tab" page, shuts down, returns the token to the caller.
//
// Note: scouting-auth-web's RETURN_TO_ALLOWLIST currently allows
// http://localhost:5173 and http://localhost:3000. We try those ports
// first, fall back to whatever is open if both are busy and add the
// dynamic port to the allowlist server-side later. For now, we just
// pick from the allowlist.

const http = require('node:http');
const { shell } = require('electron');

const SUPABASE_URL = 'https://evnavwovdrwsootzljib.supabase.co';
const PREFERRED_PORTS = [5173, 3000]; // must be in scouting-auth-web allowlist
const TIMEOUT_MS = 5 * 60 * 1000; // 5 min for user to finish OAuth

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(null);
      else reject(err);
    });
    server.once('listening', () => {
      resolve(server);
    });
    server.listen(port, '127.0.0.1');
  });
}

async function pickServer() {
  for (const port of PREFERRED_PORTS) {
    const s = await tryListen(port);
    if (s) return { server: s, port };
  }
  throw new Error(
    `Both ports ${PREFERRED_PORTS.join(', ')} are busy on localhost. Close any apps using them and retry.`,
  );
}

/**
 * Run the desktop Steam OAuth flow. Resolves with { sessionToken, steamId }
 * on success, rejects on user cancel / timeout / network error.
 */
async function authenticateViaSteam({ log = () => {} } = {}) {
  const { server, port } = await pickServer();
  const returnTo = `http://localhost:${port}/scouting-auth-callback`;

  const tokenPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { server.close(); } catch { /* ignore */ }
      reject(new Error('Steam OAuth timed out (5 min). Try again.'));
    }, TIMEOUT_MS);

    server.on('request', (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== '/scouting-auth-callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      const session = url.searchParams.get('session');
      const steamId = url.searchParams.get('steam_id');
      const errorParam = url.searchParams.get('error');

      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Resolution Scouting</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#f5f5f5;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}
h1{font-size:32px;margin:0 0 12px}
p{color:#aaa;max-width:400px;text-align:center;line-height:1.6}
.ok{color:#22c55e}.err{color:#ef4444}</style></head>
<body>
${session
  ? `<h1>Steam <span class="ok">подключён ✓</span></h1><p>Можешь закрыть эту вкладку и вернуться в Resolution Scouting.</p>`
  : `<h1 class="err">Ошибка</h1><p>${errorParam || 'Не получили session token. Попробуй ещё раз.'}</p>`}
</body></html>`;
      res.writeHead(session ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);

      clearTimeout(timer);
      // Defer close so the response fully flushes.
      setTimeout(() => { try { server.close(); } catch { /* ignore */ } }, 100);

      if (session) resolve({ sessionToken: session, steamId });
      else reject(new Error(errorParam || 'No session token in callback'));
    });
  });

  const startUrl = `${SUPABASE_URL}/functions/v1/scouting-auth-web/start?return_to=${encodeURIComponent(returnTo)}`;
  log(`Opening browser → ${startUrl}`);
  await shell.openExternal(startUrl);
  return await tokenPromise;
}

module.exports = { authenticateViaSteam, SUPABASE_URL };
