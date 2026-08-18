const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Armazenamento simples em arquivo JSON por conta (volume de webhooks é baixo).
class EventStore {
  constructor(accountKey, maxEvents) {
    this.file = path.join(DATA_DIR, `events-${accountKey}.json`);
    this.maxEvents = maxEvents;
    this.events = [];
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw.replace(/^﻿/, '')); // tolera BOM
      if (Array.isArray(parsed)) this.events = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[store] Falha ao ler ${this.file}:`, err.message);
      }
    }
  }

  add(event) {
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      this.events.length = this.maxEvents;
    }
    this.scheduleSave();
    return event;
  }

  recent(limit = 100) {
    return this.events.slice(0, limit);
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 250);
  }

  save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.events, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[store] Falha ao salvar ${this.file}:`, err.message);
    }
  }
}

// Resumo mensal persistente por conta: { "2026-08": { brokers: { "<userId>":
// { name, agendadas, realizadas } } } }. Alimentado a cada webhook — o ranking
// do mês zera na virada, mas o histórico fica guardado aqui para consulta.
class MonthlyStats {
  constructor(accountKey) {
    this.file = path.join(DATA_DIR, `stats-${accountKey}.json`);
    this.data = {};
    this.loaded = false;
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw.replace(/^﻿/, '')); // tolera BOM
      if (parsed && typeof parsed === 'object') {
        this.data = parsed;
        this.loaded = true;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[stats] Falha ao ler ${this.file}:`, err.message);
      }
    }
  }

  record(event) {
    if (event.test) return; // alertas de teste não entram no histórico
    const agendada = Boolean(event.isMeeting) && !event.isMeetingDone;
    const realizada = Boolean(event.isMeetingDone);
    if (!agendada && !realizada) return;
    const d = new Date(event.ts);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!this.data[ym]) this.data[ym] = { brokers: {} };
    const key = event.responsibleUserId != null ? String(event.responsibleUserId) : 'none';
    const brokers = this.data[ym].brokers;
    if (!brokers[key]) brokers[key] = { name: '', agendadas: 0, realizadas: 0 };
    if (event.responsibleUserName) brokers[key].name = event.responsibleUserName;
    if (agendada) brokers[key].agendadas++;
    if (realizada) brokers[key].realizadas++;
    this.scheduleSave();
  }

  rebuildFrom(events) {
    this.data = {};
    for (const ev of [...events].reverse()) this.record(ev);
    this.save();
    this.loaded = true;
  }

  months() {
    return Object.keys(this.data).sort();
  }

  month(ym) {
    return this.data[ym] || null;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 250);
  }

  save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[stats] Falha ao salvar ${this.file}:`, err.message);
    }
  }
}

module.exports = { EventStore, MonthlyStats };
