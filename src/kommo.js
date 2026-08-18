// Enriquecimento opcional via API v4 da Kommo.
// Com um token de longa duração por conta, buscamos nomes de status/pipeline
// e nomes de usuários (corretores), com cache em memória.

const CACHE_TTL_MS = 10 * 60 * 1000;

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

class KommoClient {
  constructor(account) {
    this.account = account;
    this.cache = { statuses: null, users: null, fetchedAt: 0, pending: null };
  }

  get enabled() {
    return Boolean(this.account.kommoToken);
  }

  async api(pathname) {
    const url = `https://${this.account.kommoSubdomain}.kommo.com${pathname}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.account.kommoToken}` },
    });
    if (!res.ok) {
      throw new Error(`Kommo API ${res.status} em ${pathname}`);
    }
    return res.json();
  }

  async refreshIfStale() {
    if (!this.enabled) return;
    const fresh = Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
    if (fresh && this.cache.statuses) return;
    if (this.cache.pending) return this.cache.pending;

    this.cache.pending = (async () => {
      try {
        const [pipelines, users] = await Promise.all([
          this.api('/api/v4/leads/pipelines'),
          this.api('/api/v4/users?limit=250'),
        ]);

        const statuses = new Map();
        for (const p of pipelines?._embedded?.pipelines || []) {
          for (const s of p?._embedded?.statuses || []) {
            statuses.set(s.id, {
              id: s.id,
              name: s.name,
              color: s.color,
              pipelineId: p.id,
              pipelineName: p.name,
            });
          }
        }

        const userMap = new Map();
        for (const u of users?._embedded?.users || []) {
          userMap.set(u.id, u.name);
        }

        this.cache.statuses = statuses;
        this.cache.users = userMap;
        this.cache.fetchedAt = Date.now();
        console.log(
          `[kommo:${this.account.key}] cache atualizado: ${statuses.size} status, ${userMap.size} usuários`
        );
      } catch (err) {
        console.error(`[kommo:${this.account.key}] falha ao atualizar cache:`, err.message);
      } finally {
        this.cache.pending = null;
      }
    })();

    return this.cache.pending;
  }

  statusInfo(statusId) {
    return this.cache.statuses?.get(Number(statusId)) || null;
  }

  userName(userId) {
    return this.cache.users?.get(Number(userId)) || null;
  }

  // IDs de status considerados "reunião": os configurados no .env têm prioridade;
  // sem configuração, detecta pelo nome (contém "reuni", ex.: "Reunião agendada").
  isMeetingStatus(statusId) {
    const id = Number(statusId);
    if (this.account.meetingStatusIds.length > 0) {
      return this.account.meetingStatusIds.includes(id);
    }
    const info = this.statusInfo(id);
    if (info) return normalize(info.name).includes('reuni');
    return false;
  }

  // Reunião REALIZADA: IDs do .env têm prioridade; sem configuração, detecta
  // pelo nome (contém "reuni" e "realizad", ex.: "Reunião realizada").
  isDoneStatus(statusId) {
    const id = Number(statusId);
    if (this.account.doneStatusIds.length > 0) {
      return this.account.doneStatusIds.includes(id);
    }
    const info = this.statusInfo(id);
    if (info) {
      const n = normalize(info.name);
      return n.includes('reuni') && n.includes('realizad');
    }
    return false;
  }
}

module.exports = { KommoClient };
