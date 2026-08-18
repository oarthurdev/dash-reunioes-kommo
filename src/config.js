require('dotenv').config();

const crypto = require('crypto');

function parseIdList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

// Contas suportadas. Cada subdomínio do dashboard (dicasa.x.com, mazi.x.com)
// corresponde a uma conta Kommo.
const ACCOUNT_KEYS = ['dicasa', 'mazi'];

// Até 3 usuários de login por conta: <CONTA>_DASH_USER1/_PASS1 .. _USER3/_PASS3.
// O par sem sufixo (<CONTA>_DASH_USER/_PASS) segue aceito por compatibilidade e
// conta dentro do limite. Sem nenhum usuário na conta, valem DASH_USER/DASH_PASS.
function buildLogins(upper) {
  const logins = [];
  for (const suffix of ['', '1', '2', '3']) {
    const user = process.env[`${upper}_DASH_USER${suffix}`];
    const pass = process.env[`${upper}_DASH_PASS${suffix}`];
    if (user && pass) logins.push({ user, pass });
  }
  if (logins.length === 0 && process.env.DASH_USER && process.env.DASH_PASS) {
    logins.push({ user: process.env.DASH_USER, pass: process.env.DASH_PASS });
  }
  return logins.slice(0, 3);
}

function buildAccount(key) {
  const upper = key.toUpperCase();
  return {
    key,
    label: process.env[`${upper}_LABEL`] || key.charAt(0).toUpperCase() + key.slice(1),
    // Subdomínio da conta na Kommo (ex.: "dicasa" em dicasa.kommo.com).
    // Usado para casar o account[subdomain] do webhook e para chamadas de API.
    kommoSubdomain: process.env[`${upper}_KOMMO_SUBDOMAIN`] || key,
    // Token de longa duração da Kommo (opcional — habilita nomes de status/corretor
    // e detecção automática do status "Reunião").
    kommoToken: process.env[`${upper}_KOMMO_TOKEN`] || '',
    // IDs de status que disparam o alerta de reunião. Se vazio e houver token,
    // o servidor detecta automaticamente os status cujo nome contém "reuni".
    meetingStatusIds: parseIdList(process.env[`${upper}_MEETING_STATUS_IDS`]),
    // Credenciais de login da conta (até 3 usuários).
    logins: buildLogins(upper),
  };
}

const accounts = new Map(ACCOUNT_KEYS.map((k) => [k, buildAccount(k)]));

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS, 10) || 12,
  // Segredo opcional exigido no webhook: /webhook/kommo?secret=...
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  maxEventsPerAccount: parseInt(process.env.MAX_EVENTS, 10) || 500,
  accounts,
};

if (!process.env.SESSION_SECRET) {
  console.warn(
    '[config] SESSION_SECRET não definido no .env — usando valor aleatório (sessões caem a cada restart).'
  );
}

for (const acc of accounts.values()) {
  if (acc.logins.length === 0) {
    console.warn(
      `[config] Conta "${acc.key}" sem credenciais de login (defina DASH_USER/DASH_PASS ou ${acc.key.toUpperCase()}_DASH_USER1/_DASH_PASS1 no .env).`
    );
  }
}

module.exports = config;
