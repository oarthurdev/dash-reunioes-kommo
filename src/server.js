const path = require('path');
const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const { EventStore, MonthlyStats } = require('./store');
const { KommoClient } = require('./kommo');
const auth = require('./auth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Kommo envia webhooks como application/x-www-form-urlencoded com chaves
// aninhadas (leads[status][0][id]); extended:true monta o objeto aninhado.
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Estado por conta
// ---------------------------------------------------------------------------
const stores = new Map();
const statsStores = new Map();
const kommoClients = new Map();
const sseClients = new Map(); // accountKey -> Set<res>

for (const [key, account] of config.accounts) {
  const store = new EventStore(key, config.maxEventsPerAccount);
  const stats = new MonthlyStats(key);
  // primeira execução com histórico novo: reconstrói o resumo mensal a partir
  // dos eventos já gravados
  if (!stats.loaded) stats.rebuildFrom(store.events);
  stores.set(key, store);
  statsStores.set(key, stats);
  kommoClients.set(key, new KommoClient(account));
  sseClients.set(key, new Set());
}

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Resolução de conta por subdomínio (dicasa.x.com, mazi.x.com); fallback
// ?account= para desenvolvimento local.
// ---------------------------------------------------------------------------
function accountFromHost(req) {
  const host = String(req.headers.host || '').split(':')[0];
  const first = host.split('.')[0].toLowerCase();
  return config.accounts.has(first) ? first : null;
}

function resolveAccountKey(req) {
  const fromHost = accountFromHost(req);
  if (fromHost) return fromHost;
  const q = String(req.query.account || '').toLowerCase();
  return config.accounts.has(q) ? q : null;
}

// Mantém ?account= nos redirects quando a conta veio da query (uso local).
function accountSuffix(req, accountKey) {
  return accountFromHost(req) === accountKey ? '' : `?account=${accountKey}`;
}

function requireAuth(req, res, next) {
  const accountKey = resolveAccountKey(req);
  if (!accountKey) return res.status(404).send(accountPickerHtml());

  const session = auth.verifySessionCookie(auth.parseCookies(req)[auth.COOKIE_NAME]);
  if (!session || session.accountKey !== accountKey) {
    if (req.path.startsWith('/api/') || req.path === '/events') {
      return res.status(401).json({ error: 'não autenticado' });
    }
    return res.redirect(`/login${accountSuffix(req, accountKey)}`);
  }
  req.accountKey = accountKey;
  req.account = config.accounts.get(accountKey);
  next();
}

const FAVICON_TAGS = `<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/logo.png">`;

function accountPickerHtml() {
  const links = [...config.accounts.values()]
    .map(
      (a) => `<a class="acc-card" href="/?account=${a.key}">
        <span class="acc-avatar">${a.label.slice(0, 1).toUpperCase()}</span>
        <span class="acc-info"><b>${a.label}</b><small>${a.kommoSubdomain}.kommo.com</small></span>
        <span class="acc-go">→</span>
      </a>`
    )
    .join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Placar de Reuniões — Contas</title>${FAVICON_TAGS}
<link rel="stylesheet" href="/style.css"></head>
<body class="center-page"><div class="card login-card">
<img class="login-logo" src="/logo.png" alt="Placar de Reuniões">
<div class="login-brand">Placar de Reuniões</div>
<p class="muted center">Escolha a imobiliária para entrar — ou acesse direto pelo subdomínio (ex.: <code>dicasa.seudominio.com</code>).</p>
<div class="acc-list">${links}</div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function loginHtml(account, suffix, errorMsg) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrar — ${account.label} · Placar de Reuniões</title>${FAVICON_TAGS}
<link rel="stylesheet" href="/style.css"></head>
<body class="center-page"><div class="card login-card${errorMsg ? ' shake' : ''}">
<img class="login-logo" src="/logo.png" alt="Placar de Reuniões">
<div class="login-brand">Placar de Reuniões</div>
<span class="login-account">${account.label}</span>
<p class="muted center">Reuniões do time em tempo real — Kommo CRM</p>
${errorMsg ? `<p class="error"><span>⚠️</span> ${errorMsg}</p>` : ''}
<form method="post" action="/login${suffix}" id="login-form">
  <label>Usuário
    <span class="field">
      <span class="f-ico">👤</span>
      <input name="user" autocomplete="username" placeholder="seu usuário" required autofocus>
    </span>
  </label>
  <label>Senha
    <span class="field">
      <span class="f-ico">🔒</span>
      <input id="pass-input" name="pass" type="password" autocomplete="current-password" placeholder="••••••••" required>
      <button type="button" class="peek" id="peek" title="Mostrar senha" aria-label="Mostrar senha">👁</button>
    </span>
  </label>
  <button type="submit" class="btn" id="login-btn">Entrar no placar</button>
</form>
<div class="login-foot">🔔 alerta sonoro · 🏆 ranking mensal · ⚡ tempo real</div>
</div>
<script>
  const pass = document.getElementById('pass-input');
  document.getElementById('peek').addEventListener('click', function () {
    pass.type = pass.type === 'password' ? 'text' : 'password';
    this.textContent = pass.type === 'password' ? '👁' : '🙈';
  });
  document.getElementById('login-form').addEventListener('submit', function () {
    const b = document.getElementById('login-btn');
    b.disabled = true;
    b.textContent = 'Entrando…';
  });
</script>
</body></html>`;
}

app.get('/login', (req, res) => {
  const accountKey = resolveAccountKey(req);
  if (!accountKey) return res.status(404).send(accountPickerHtml());
  const account = config.accounts.get(accountKey);
  res.send(loginHtml(account, accountSuffix(req, accountKey)));
});

app.post('/login', (req, res) => {
  const accountKey = resolveAccountKey(req);
  if (!accountKey) return res.status(404).send(accountPickerHtml());
  const account = config.accounts.get(accountKey);
  const suffix = accountSuffix(req, accountKey);

  const { user, pass } = req.body || {};
  if (!auth.checkCredentials(account, user, pass)) {
    return res.status(401).send(loginHtml(account, suffix, 'Usuário ou senha inválidos.'));
  }

  const cookie = auth.createSessionCookie(accountKey);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${auth.COOKIE_NAME}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtlHours * 3600}${secure}`
  );
  res.redirect(`/${suffix}`);
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${auth.COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
  const accountKey = resolveAccountKey(req);
  res.redirect(`/login${accountKey ? accountSuffix(req, accountKey) : ''}`);
});

// ---------------------------------------------------------------------------
// Dashboard (HTML estático parametrizado via /api/meta)
// ---------------------------------------------------------------------------
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

app.get('/api/meta', requireAuth, async (req, res) => {
  const client = kommoClients.get(req.accountKey);
  await client.refreshIfStale();
  res.json({
    account: req.accountKey,
    label: req.account.label,
    enriched: client.enabled,
    meetingStatusIds: req.account.meetingStatusIds,
    metaCorretor: req.account.metaCorretor,
    metaTime: req.account.metaTime,
    // Corretores da conta (para o ranking listar também quem está zerado).
    users: client.cache.users ? [...client.cache.users].map(([id, name]) => ({ id, name })) : [],
  });
});

// Meses com dados no histórico (o atual sempre incluso), do mais novo ao mais antigo.
app.get('/api/months', requireAuth, (req, res) => {
  const set = new Set(statsStores.get(req.accountKey).months());
  set.add(currentYm());
  res.json({ months: [...set].sort().reverse(), current: currentYm() });
});

// Ranking consolidado de um mês (histórico persistente, sem eventos de teste).
app.get('/api/ranking', requireAuth, (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : currentYm();
  const month = statsStores.get(req.accountKey).month(ym);
  const client = kommoClients.get(req.accountKey);
  const brokers = [];
  if (month) {
    for (const [key, b] of Object.entries(month.brokers)) {
      brokers.push({
        key,
        name: b.name || client.userName(key) || (key === 'none' ? 'Sem corretor' : `Corretor #${key}`),
        agendadas: b.agendadas,
        realizadas: b.realizadas,
      });
    }
  }
  res.json({ month: ym, brokers });
});

app.get('/api/events', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, config.maxEventsPerAccount);
  res.json({ events: stores.get(req.accountKey).recent(limit) });
});

// Simula um evento de reunião (para testar som/alerta sem mexer na Kommo).
app.post('/api/test-alert', requireAuth, (req, res) => {
  const event = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    account: req.accountKey,
    type: 'status',
    leadId: 0,
    leadName: 'Lead de teste',
    price: 0,
    statusId: 0,
    statusName: 'Reunião (teste)',
    oldStatusId: null,
    oldStatusName: null,
    pipelineId: null,
    pipelineName: null,
    responsibleUserId: null,
    responsibleUserName: 'Corretor de teste',
    isMeeting: true,
    test: true,
  };
  stores.get(req.accountKey).add(event);
  broadcast(req.accountKey, event);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// SSE — tempo real
// ---------------------------------------------------------------------------
app.get('/events', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: conectado\n\n`);

  const clients = sseClients.get(req.accountKey);
  clients.add(res);

  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

function broadcast(accountKey, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients.get(accountKey)) {
    res.write(payload);
  }
}

// ---------------------------------------------------------------------------
// Webhook Kommo
// ---------------------------------------------------------------------------
function accountFromWebhook(req) {
  // 1) subdomínio informado no próprio payload da Kommo
  const bodySub = String(req.body?.account?.subdomain || '').toLowerCase();
  if (bodySub) {
    for (const [key, acc] of config.accounts) {
      if (acc.kommoSubdomain.toLowerCase() === bodySub || key === bodySub) return key;
    }
  }
  // 2) subdomínio do host do dashboard / 3) query ?account=
  return resolveAccountKey(req);
}

app.post('/webhook/kommo', (req, res) => {
  if (config.webhookSecret && req.query.secret !== config.webhookSecret) {
    return res.status(403).send('forbidden');
  }

  const accountKey = accountFromWebhook(req);
  // Responde 200 imediatamente — a Kommo desativa webhooks lentos/com erro.
  res.status(200).send('ok');

  if (!accountKey) {
    console.warn('[webhook] conta não identificada; payload ignorado:', JSON.stringify(req.body).slice(0, 500));
    return;
  }

  processWebhook(accountKey, req.body).catch((err) =>
    console.error(`[webhook:${accountKey}] erro ao processar:`, err)
  );
});

async function processWebhook(accountKey, body) {
  const leadsChanged = [
    ...(toArray(body?.leads?.status).map((l) => ({ lead: l, type: 'status' })) || []),
    ...(toArray(body?.leads?.add).map((l) => ({ lead: l, type: 'add' })) || []),
  ];
  if (leadsChanged.length === 0) return;

  const client = kommoClients.get(accountKey);
  await client.refreshIfStale();

  const store = stores.get(accountKey);
  for (const { lead, type } of leadsChanged) {
    const statusId = num(lead.status_id);
    const statusInfo = client.statusInfo(statusId);
    const oldStatusId = num(lead.old_status_id);
    const oldInfo = client.statusInfo(oldStatusId);

    const event = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      account: accountKey,
      type,
      leadId: num(lead.id),
      leadName: lead.name || `Lead #${lead.id}`,
      price: num(lead.price) || 0,
      statusId,
      statusName: statusInfo?.name || null,
      oldStatusId,
      oldStatusName: oldInfo?.name || null,
      pipelineId: num(lead.pipeline_id),
      pipelineName: statusInfo?.pipelineName || null,
      responsibleUserId: num(lead.responsible_user_id),
      responsibleUserName: client.userName(lead.responsible_user_id),
      isMeeting: client.isMeetingStatus(statusId),
      isMeetingDone: client.isDoneStatus(statusId),
    };

    store.add(event);
    statsStores.get(accountKey).record(event);
    broadcast(accountKey, event);
    console.log(
      `[webhook:${accountKey}] lead ${event.leadId} "${event.leadName}" → status ${event.statusName || event.statusId}${event.isMeeting ? ' 🔔 REUNIÃO' : ''}`
    );
  }
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  // urlencoded pode chegar como objeto {"0": {...}, "1": {...}}
  return Object.values(value);
}

function num(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(config.port, () => {
  console.log(`Dash Reunião Kommo rodando na porta ${config.port}`);
  console.log(`Contas: ${[...config.accounts.keys()].join(', ')}`);
  console.log(`Local: http://localhost:${config.port}/?account=dicasa`);
});
