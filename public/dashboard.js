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

  // Nota de "sino" sintetizada: fundamental + harmônicos com decaimento natural.
  function bellNote(freq, when, dur, volume) {
    const partials = [
      { mult: 1, gain: 1 },
      { mult: 2, gain: 0.35 },
      { mult: 3, gain: 0.12 },
    ];
    for (const p of partials) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * p.mult;
      const peak = volume * p.gain;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(peak, when + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(when);
      osc.stop(when + dur + 0.1);
    }
  }

  // Campainha clássica "ding-dong" (E5 → C5), coerente com "chegou visita/reunião".
  function playChime() {
    if (!soundOn) return;
    ensureAudio();
    const t = audioCtx.currentTime;
    bellNote(659.25, t, 1.1, 0.4);        // ding
    bellNote(523.25, t + 0.45, 1.5, 0.4); // dong
  }

  // ---------------------------------------------------------------------
  // Anúncio falado (Web Speech API, voz pt-BR do próprio navegador):
  // o gestor ouve a campainha e em seguida "Reunião agendada, lead X, corretor Y".
  // ---------------------------------------------------------------------
  let currentAlert = null;
  let speakTimer = null;

  if ('speechSynthesis' in window) speechSynthesis.getVoices(); // aquece a lista de vozes

  function ptVoice() {
    return speechSynthesis
      .getVoices()
      .find((v) => v.lang && v.lang.toLowerCase().startsWith('pt'));
  }

  // Locução gravada em pt-BR ("Atenção! Reunião agendada!") — funciona em
  // qualquer máquina, mesmo sem voz pt-BR instalada no sistema.
  const alertVoice = new Audio('/alert-reuniao.wav');
  alertVoice.onended = () => {
    if (sirenTimer && ptVoice()) speakDetails(false);
  };

  function speakDetails(includeIntro) {
    if (!('speechSynthesis' in window) || !currentAlert) return;
    const ev = currentAlert;
    const parts = [];
    if (includeIntro) parts.push('Atenção! Reunião agendada.');
    if (ev.leadName) parts.push(`Lead: ${ev.leadName}.`);
    if (ev.responsibleUserName) parts.push(`Corretor: ${ev.responsibleUserName}.`);
    if (parts.length === 0) return;
    const u = new SpeechSynthesisUtterance(parts.join(' '));
    u.lang = 'pt-BR';
    u.rate = 1.02;
    u.volume = 1;
    const voice = ptVoice();
    if (voice) u.voice = voice;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function announce() {
    playChime();
    clearTimeout(speakTimer);
    speakTimer = setTimeout(() => {
      alertVoice.currentTime = 0;
      alertVoice
        .play()
        // se o áudio gravado falhar, cai para a voz do navegador com a frase completa
        .catch(() => speakDetails(true));
    }, 1100); // logo após o "ding-dong"
  }

  function startSiren() {
    if (!soundOn || sirenTimer) return;
    announce();
    sirenTimer = setInterval(announce, 12000);
  }

  function stopSiren() {
    clearInterval(sirenTimer);
    sirenTimer = null;
    clearTimeout(speakTimer);
    speakTimer = null;
    alertVoice.pause();
    alertVoice.currentTime = 0;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  $('sound-btn').addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem('soundOn', soundOn ? '1' : '0');
    if (soundOn) { ensureAudio(); playChime(); } else { stopSiren(); }
    updateSoundBtn();
  });
  updateSoundBtn();

  // Após recarregar a página o navegador trava áudio/voz até a 1ª interação;
  // qualquer clique na página destrava (a preferência de som já fica salva).
  if (soundOn) {
    document.body.addEventListener('click', () => ensureAudio(), { once: true });
  }

  // ---------------------------------------------------------------------
  // Alerta visual
  // ---------------------------------------------------------------------
  function showAlert(ev) {
    currentAlert = ev;
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
