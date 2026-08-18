(() => {
  // Mantém ?account= (uso local sem subdomínio) em todas as chamadas.
  const params = new URLSearchParams(location.search);
  const accountQS = params.get('account') ? `?account=${encodeURIComponent(params.get('account'))}` : '';
  const api = (path) => `${path}${accountQS}`;

  const $ = (id) => document.getElementById(id);
  document.getElementById('logout-form').action = api('/logout');
  const feed = $('feed');
  const events = [];
  const seen = new Set();

  // ---------------------------------------------------------------------
  // Som de alerta (WebAudio — sem arquivos). Precisa de 1 clique do usuário
  // para desbloquear o áudio (política dos navegadores).
  // ---------------------------------------------------------------------
  let audioCtx = null;
  let soundOn = localStorage.getItem('soundOn') === '1';
  let sirenTimer = null;

  function updateSoundBtn() {
    $('sound-btn').textContent = soundOn ? '🔊 Som ativado' : '🔇 Ativar som';
  }

  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function beep(freq, when, dur) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.5, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  function playChime() {
    if (!soundOn) return;
    ensureAudio();
    const t = audioCtx.currentTime;
    beep(880, t, 0.25);
    beep(1174.66, t + 0.18, 0.25);
    beep(1567.98, t + 0.36, 0.45);
  }

  function startSiren() {
    if (!soundOn || sirenTimer) return;
    playChime();
    sirenTimer = setInterval(playChime, 2200);
  }

  function stopSiren() {
    clearInterval(sirenTimer);
    sirenTimer = null;
  }

  $('sound-btn').addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem('soundOn', soundOn ? '1' : '0');
    if (soundOn) { ensureAudio(); playChime(); } else { stopSiren(); }
    updateSoundBtn();
  });
  updateSoundBtn();

  // ---------------------------------------------------------------------
  // Alerta visual
  // ---------------------------------------------------------------------
  function showAlert(ev) {
    $('alert-lead').textContent = ev.leadName || `Lead #${ev.leadId}`;
    $('alert-broker').textContent = ev.responsibleUserName
      ? `Corretor: ${ev.responsibleUserName}`
      : (ev.statusName ? `Status: ${ev.statusName}` : '');
    $('alert-overlay').classList.add('show');
    startSiren();
    if (Notification && Notification.permission === 'granted') {
      new Notification('Lead movido para Reunião! 🔔', { body: ev.leadName || '' });
    }
  }

  $('alert-dismiss').addEventListener('click', () => {
    $('alert-overlay').classList.remove('show');
    stopSiren();
  });

  // ---------------------------------------------------------------------
  // Feed e estatísticas
  // ---------------------------------------------------------------------
  const fmtTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
  const fmtMoney = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

  function render() {
    feed.innerHTML = '';
    $('empty').hidden = events.length > 0;

    for (const ev of events.slice(0, 100)) {
      const li = document.createElement('li');
      li.className = 'event' + (ev.isMeeting ? ' meeting' : '');

      const info = document.createElement('div');
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = ev.leadName || `Lead #${ev.leadId}`;
      const line = document.createElement('div');
      line.className = 'status-line';
      const from = ev.oldStatusName || (ev.oldStatusId ? `#${ev.oldStatusId}` : null);
      const to = ev.statusName || (ev.statusId ? `#${ev.statusId}` : '?');
      line.innerHTML = (ev.type === 'add' ? 'Novo lead em ' : (from ? `${esc(from)} → ` : 'Movido para ')) + `<b>${esc(to)}</b>` +
        (ev.responsibleUserName ? ` · ${esc(ev.responsibleUserName)}` : '');
      info.append(who, line);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `${fmtTime.format(new Date(ev.ts))}` +
        (ev.price ? `<br>${fmtMoney.format(ev.price)}` : '');

      li.append(info);
      if (ev.isMeeting) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'REUNIÃO';
        li.append(badge);
      }
      li.append(meta);
      feed.append(li);
    }

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekAgo = Date.now() - 7 * 864e5;
    const meetings = events.filter((e) => e.isMeeting);
    $('stat-today').textContent = meetings.filter((e) => e.ts >= startOfDay).length;
    $('stat-week').textContent = meetings.filter((e) => e.ts >= weekAgo).length;
    $('stat-events').textContent = events.length;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function addEvent(ev, { alert = false } = {}) {
    if (seen.has(ev.id)) return;
    seen.add(ev.id);
    events.unshift(ev);
    events.sort((a, b) => b.ts - a.ts);
    render();
    if (alert && ev.isMeeting) showAlert(ev);
  }

  // ---------------------------------------------------------------------
  // Carga inicial + SSE
  // ---------------------------------------------------------------------
  async function loadInitial() {
    const [meta, data] = await Promise.all([
      fetch(api('/api/meta')).then((r) => r.ok ? r.json() : Promise.reject(r.status)),
      fetch(api('/api/events')).then((r) => r.ok ? r.json() : Promise.reject(r.status)),
    ]);
    $('account-label').textContent = `${meta.label} — Reuniões`;
    document.title = `${meta.label} — Dash Reunião`;
    $('enrich-note').textContent = meta.enriched
      ? ''
      : '(sem token Kommo no .env: exibindo IDs de status; configure para ver nomes)';
    for (const ev of data.events) addEvent(ev);
  }

  function connectSSE() {
    const es = new EventSource(api('/events'));
    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false); // EventSource reconecta sozinho
    es.onmessage = (msg) => {
      try {
        addEvent(JSON.parse(msg.data), { alert: true });
      } catch (e) { console.error(e); }
    };
  }

  function setConn(ok) {
    $('conn-dot').classList.toggle('on', ok);
    $('conn-text').textContent = ok ? 'ao vivo' : 'reconectando…';
  }

  $('test-btn').addEventListener('click', () => {
    fetch(api('/api/test-alert'), { method: 'POST' });
  });

  // Notificações do navegador (opcional, além do som)
  if ('Notification' in window && Notification.permission === 'default') {
    document.body.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }

  loadInitial()
    .then(connectSSE)
    .catch((status) => {
      if (status === 401) location.href = api('/login');
      else console.error('Falha ao carregar dados:', status);
    });
})();
