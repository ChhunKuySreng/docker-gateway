const http = require('http');
const net = require('net');

const HOST = '192.168.65.254';
const START_PORT = 3000;
const END_PORT = 3999;

let clients = [];
let lastActivePortsKey = '';
let cachedActiveProjects = [];

// Fast TCP connect test (< 2ms for closed ports on host bridge)
function checkPort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(250);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, HOST);
  });
}

// Dynamically fetch and parse HTML to extract live project name from the running dev server
function fetchLiveProjectName(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${port}/`, { timeout: 1200 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 32768) req.destroy();
      });
      res.on('end', () => {
        // 1. Prefer application-name meta tag if present
        const appMatch = data.match(/<meta[^>]*name=["']application-name["'][^>]*content=["']([^"']+)["']/i);
        if (appMatch && appMatch[1].trim()) {
          return resolve(appMatch[1].trim());
        }

        // 2. Next prefer HTML <title> tag
        const titleMatch = data.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch && titleMatch[1].trim()) {
          return resolve(titleMatch[1].trim());
        }

        // 3. Fallback to OpenGraph title
        const ogMatch = data.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
        if (ogMatch && ogMatch[1].trim()) {
          return resolve(ogMatch[1].trim());
        }

        resolve(`Project ${port}`);
      });
    });

    req.on('error', () => resolve(`Project ${port}`));
    req.on('timeout', () => { req.destroy(); resolve(`Project ${port}`); });
  });
}

function pickIcon(name = '') {
  const lower = name.toLowerCase();
  if (lower.includes('charger') || lower.includes('ev') || lower.includes('battery')) return '🔋';
  if (lower.includes('chat') || lower.includes('message')) return '💬';
  if (lower.includes('approval') || lower.includes('document')) return '📝';
  if (lower.includes('delivery') || lower.includes('ship')) return '🚚';
  if (lower.includes('angkor') || lower.includes('tour') || lower.includes('visit')) return '🏛️';
  if (lower.includes('udaya') || lower.includes('system') || lower.includes('erp')) return '⚡';
  if (lower.includes('api') || lower.includes('backend')) return '⚙️';
  if (lower.includes('power') || lower.includes('bank')) return '⚡';
  return '🚀';
}

// Scans 3000 to 3999 in chunks of 100
async function scanActivePorts() {
  const active = [];
  const chunkSize = 100;
  for (let p = START_PORT; p <= END_PORT; p += chunkSize) {
    const chunk = [];
    const limit = Math.min(p + chunkSize, END_PORT + 1);
    for (let port = p; port < limit; port++) {
      chunk.push(
        checkPort(port).then((isOpen) => {
          if (isOpen) active.push(port);
        })
      );
    }
    await Promise.all(chunk);
  }
  return active.sort((a, b) => a - b);
}

// Pure dynamic resolution: inspects whatever is actually running right now
async function refreshActiveProjects() {
  const activePorts = await scanActivePorts();

  const projectPromises = activePorts.map(async (port) => {
    const name = await fetchLiveProjectName(port);
    const icon = pickIcon(name);

    return {
      port,
      name,
      icon,
      url: `/${port}/`
    };
  });

  const activeProjects = await Promise.all(projectPromises);
  cachedActiveProjects = activeProjects;
  return activeProjects;
}

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (let i = clients.length - 1; i >= 0; i--) {
    try {
      clients[i].res.write(payload);
    } catch (e) {
      clients.splice(i, 1);
    }
  }
}

// Periodic scan loop every 1.5 seconds
async function pollLoop() {
  try {
    const activeProjects = await refreshActiveProjects();
    const portsKey = activeProjects.map((p) => `${p.port}:${p.name}`).join('|');

    if (portsKey !== lastActivePortsKey) {
      lastActivePortsKey = portsKey;
      broadcast({
        type: 'update',
        timestamp: Date.now(),
        count: activeProjects.length,
        projects: activeProjects
      });
    }
  } catch (err) {
    console.error('Scan error:', err);
  }
  setTimeout(pollLoop, 1500);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // 1. SSE Real-time push stream
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
    }, 15000);

    const clientObj = { id: Date.now(), res };
    clients.push(clientObj);

    res.write(`data: ${JSON.stringify({
      type: 'initial',
      timestamp: Date.now(),
      count: cachedActiveProjects.length,
      projects: cachedActiveProjects
    })}\n\n`);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients = clients.filter((c) => c.id !== clientObj.id);
    });
    return;
  }

  // 2. Active status API
  if (url.pathname === '/api/status') {
    const activeProjects = await refreshActiveProjects();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: activeProjects.length, projects: activeProjects }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const PORT = 4000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`⚡ Dev SSE Server with 100% Live Discovery listening on :${PORT}`);
  await refreshActiveProjects();
  pollLoop();
});
