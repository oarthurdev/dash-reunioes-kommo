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
      const parsed = JSON.parse(raw);
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

module.exports = { EventStore };
