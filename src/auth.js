const crypto = require('crypto');
const config = require('./config');

const COOKIE_NAME = 'dash_session';

function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

function createSessionCookie(accountKey) {
  const exp = Date.now() + config.sessionTtlHours * 3600 * 1000;
  const payload = `${accountKey}.${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function verifySessionCookie(value) {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const sep = payload.lastIndexOf('.');
  if (sep < 0) return null;
  const accountKey = payload.slice(0, sep);
  const exp = parseInt(payload.slice(sep + 1), 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  if (!config.accounts.has(accountKey)) return null;
  return { accountKey };
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function checkCredentials(account, user, pass) {
  let ok = false;
  for (const cred of account.logins) {
    // compara todos os pares (sem retorno antecipado) para tempo constante
    if (safeEqual(user, cred.user) && safeEqual(pass, cred.pass)) ok = true;
  }
  return ok;
}

module.exports = {
  COOKIE_NAME,
  createSessionCookie,
  verifySessionCookie,
  parseCookies,
  checkCredentials,
};
