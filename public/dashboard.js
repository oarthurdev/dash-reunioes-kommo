(() => {
  // Mantém ?account= (uso local sem subdomínio) em todas as chamadas.
  const params = new URLSearchParams(location.search);
  const accountQS = params.get('account') ? `?account=${encodeURIComponent(params.get('account'))}` : '';
  const api = (path) => `${path}${accountQS}`;

  const $ = (id) => document.getElementById(id);
  document.getElementById('logout-form').action = api('/logout');

  const events = [];
  const seen = new Set();
  let knownUsers = []; // corretores da conta (via API Kommo), para listar os zerados
  let period = localStorage.getItem('rankPeriod') || 'today';

  // ---------------------------------------------------------------------
  // Som de alerta (WebAudio — campainha) + locução
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

  // Campainha clássica "ding-dong" (E5 → C5).
  function playChime() {
    if (!soundOn) return;
    ensureAudio();
    const t = audioCtx.currentTime;
    bellNote(659.25, t, 1.1, 0.4);        // ding
    bellNote(523.25, t + 0.45, 1.5, 0.4); // dong
  }

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
  // Identidade visual dos corretores (cor estável por corretor, nunca por rank)
  // ---------------------------------------------------------------------
  const AVATAR_COLORS = ['#5eead4', '#93c5fd', '#f9a8d4', '#fcd34d', '#c4b5fd', '#86efac', '#fdba74', '#a5f3fc'];

  function avatarColor(key) {
    let h = 0;
    const s = String(key);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function initials(name) {
    const words = String(name || '?').trim().split(/\s+/);
    const a = words[0]?.[0] || '?';
    const b = words.length > 1 ? words[words.length - 1][0] : (words[0]?.[1] || '');
    return (a + b).toUpperCase();
  }

  function makeAvatar(key, name, className = 'avatar') {
    const el = document.createElement('div');
    el.className = className;
    el.style.background = avatarColor(key);
    el.textContent = initials(name);
    return el;
  }

  // ---------------------------------------------------------------------
  // Agregação do ranking
  // ---------------------------------------------------------------------
  function periodStart() {
    const now = new Date();
    if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (period === '7d') return Date.now() - 7 * 864e5;
    return Date.now() - 30 * 864e5;
  }

  function brokerKey(ev) {
    return ev.responsibleUserId != null ? String(ev.responsibleUserId) : 'none';
  }

  function brokerName(ev) {
    if (ev.responsibleUserName) return ev.responsibleUserName;
    const u = knownUsers.find((u) => String(u.id) === brokerKey(ev));
    return u?.name || (ev.responsibleUserId ? `Corretor #${ev.responsibleUserId}` : 'Sem corretor');
  }

  function aggregate() {
    const start = periodStart();
    const map = new Map(); // key -> {key, name, count, lastTs}
    for (const u of knownUsers) {
      map.set(String(u.id), { key: String(u.id), name: u.name, count: 0, lastTs: 0 });
    }
    let total = 0;
    let lastMeeting = null;
    for (const ev of events) {
      if (!ev.isMeeting || ev.ts < start) continue;
      const key = brokerKey(ev);
      if (!map.has(key)) map.set(key, { key, name: brokerName(ev), count: 0, lastTs: 0 });
      const b = map.get(key);
      b.count += 1;
      b.lastTs = Math.max(b.lastTs, ev.ts);
      total += 1;
      if (!lastMeeting || ev.ts > lastMeeting.ts) lastMeeting = ev;
    }
    const brokers = [...map.values()].sort(
      (a, b) => b.count - a.count || b.lastTs - a.lastTs || a.name.localeCompare(b.name, 'pt-BR')
    );
    return { brokers, total, lastMeeting };
  }

  function countFor(key, sinceTs) {
    let n = 0;
    for (const ev of events) {
      if (ev.isMeeting && ev.ts >= sinceTs && brokerKey(ev) === key) n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------
  // Render — pódio, ranking (com animação FLIP), estatísticas
  // ---------------------------------------------------------------------
  const fmtTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'agora';
    if (s < 3600) return `há ${Math.floor(s / 60)} min`;
    if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
    return `há ${Math.floor(s / 86400)} d`;
  }

  let lastBump = null; // corretor que pontuou por último (efeito visual)

  function renderBoard() {
    const { brokers, total, lastMeeting } = aggregate();

    // estatísticas
    $('stat-total').textContent = total;
    const leader = brokers.find((b) => b.count > 0);
    $('stat-leader').textContent = leader ? leader.name.split(/\s+/)[0] : '—';
    $('stat-leader-sub').textContent = leader ? `${leader.count} ${leader.count === 1 ? 'reunião' : 'reuniões'}` : 'sem reuniões no período';
    $('stat-last').textContent = lastMeeting ? timeAgo(lastMeeting.ts) : '—';
    $('stat-last-sub').textContent = lastMeeting
      ? `${lastMeeting.leadName || 'lead'} · ${fmtDay.format(new Date(lastMeeting.ts))} ${fmtTime.format(new Date(lastMeeting.ts))}`
      : '';

    // pódio (só quem pontuou)
    const podium = $('podium');
    podium.innerHTML = '';
    const top = brokers.filter((b) => b.count > 0).slice(0, 3);
    const slots = [
      { cls: 'second', crown: '', b: top[1] },
      { cls: 'first', crown: '👑', b: top[0] },
      { cls: 'third', crown: '', b: top[2] },
    ];
    for (const slot of slots) {
      const div = document.createElement('div');
      div.className = `step ${slot.cls}${slot.b ? '' : ' empty'}`;
      const crown = document.createElement('div');
      crown.className = 'crown';
      crown.textContent = slot.b ? slot.crown : '';
      div.append(crown);
      div.append(makeAvatar(slot.b?.key ?? slot.cls, slot.b?.name ?? '—'));
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = slot.b ? slot.b.name : '—';
      const score = document.createElement('div');
      score.className = 'score';
      const bnum = document.createElement('b');
      bnum.textContent = slot.b ? slot.b.count : '·';
      score.append(bnum, document.createTextNode(slot.b ? (slot.b.count === 1 ? 'reunião' : 'reuniões') : ''));
      const base = document.createElement('div');
      base.className = 'base';
      div.append(name, score, base);
      podium.append(div);
    }

    // ranking com animação FLIP (linhas deslizam para a nova posição)
    const list = $('rank-list');
    const oldPos = new Map();
    for (const row of list.children) {
      oldPos.set(row.dataset.key, row.getBoundingClientRect().top);
    }

    list.innerHTML = '';
    const max = Math.max(1, ...brokers.map((b) => b.count));
    const medals = ['gold', 'silver', 'bronze'];
    brokers.forEach((b, i) => {
      const li = document.createElement('li');
      li.className = 'rank-row' + (b.count === 0 ? ' zero' : '');
      li.dataset.key = b.key;

      const pos = document.createElement('span');
      pos.className = 'rank-pos' + (b.count > 0 && i < 3 ? ` ${medals[i]}` : '');
      pos.textContent = b.count > 0 ? `${i + 1}º` : '·';

      const main = document.createElement('div');
      main.className = 'rank-main';
      const name = document.createElement('div');
      name.className = 'rank-name';
      name.textContent = b.name;
      const bar = document.createElement('div');
      bar.className = 'rank-bar';
      const fill = document.createElement('i');
      fill.style.width = `${(b.count / max) * 100}%`;
      bar.append(fill);
      main.append(name, bar);

      const count = document.createElement('div');
      count.className = 'rank-count';
      count.textContent = b.count;
      const lbl = document.createElement('small');
      lbl.textContent = b.count === 1 ? 'reunião' : 'reuniões';
      count.append(lbl);

      li.append(pos, makeAvatar(b.key, b.name), main, count);
      if (b.key === lastBump) {
        li.classList.add('bump');
        li.addEventListener('animationend', () => li.classList.remove('bump'), { once: true });
      }
      list.append(li);
    });

    // FLIP: anima do deslocamento antigo para a posição nova
    for (const row of list.children) {
      const before = oldPos.get(row.dataset.key);
      if (before == null) continue;
      const delta = before - row.getBoundingClientRect().top;
      if (!delta) continue;
      row.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
        { duration: 500, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
    }

    $('rank-empty').hidden = brokers.length > 0;
  }

  // ---------------------------------------------------------------------
  // Feed lateral
  // ---------------------------------------------------------------------
  function renderFeed() {
    const feed = $('feed');
    feed.innerHTML = '';
    $('feed-empty').hidden = events.length > 0;
    for (const ev of events.slice(0, 40)) {
      const li = document.createElement('li');
      li.className = 'ev' + (ev.isMeeting ? ' meeting' : '');

      const l1 = document.createElement('div');
      l1.className = 'l1';
      const lead = document.createElement('span');
      lead.className = 'lead';
      lead.textContent = ev.leadName || `Lead #${ev.leadId}`;
      const when = document.createElement('span');
      when.className = 'when';
      const d = new Date(ev.ts);
      when.textContent = `${fmtDay.format(d)} ${fmtTime.format(d)}`;
      l1.append(lead, when);

      const l2 = document.createElement('div');
      l2.className = 'l2';
      const to = ev.statusName || (ev.statusId ? `status #${ev.statusId}` : '?');
      const broker = ev.responsibleUserName || '';
      const b = document.createElement('b');
      b.textContent = to;
      l2.append(ev.type === 'add' ? 'Novo lead em ' : '→ ', b);
      if (broker) l2.append(document.createTextNode(` · ${broker}`));

      li.append(l1, l2);
      if (ev.isMeeting) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'REUNIÃO';
        li.append(tag);
      }
      feed.append(li);
    }
  }

  // ---------------------------------------------------------------------
  // Alerta visual
  // ---------------------------------------------------------------------
  function showAlert(ev) {
    currentAlert = ev;
    const name = ev.leadName || `Lead #${ev.leadId}`;
    $('alert-lead').textContent = name;
    $('alert-broker').textContent = ev.responsibleUserName ? `Corretor: ${ev.responsibleUserName}` : '';

    const av = $('alert-avatar');
    av.style.background = avatarColor(brokerKey(ev));
    av.textContent = initials(ev.responsibleUserName || name);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const n = countFor(brokerKey(ev), startOfDay.getTime());
    $('alert-tally').textContent = ev.responsibleUserName
      ? `${n}ª reunião de ${ev.responsibleUserName.split(/\s+/)[0]} hoje 🔥`
      : '';

    $('alert-overlay').classList.add('show');
    startSiren();
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Reunião agendada! 🔔', { body: name });
    }
  }

  $('alert-dismiss').addEventListener('click', () => {
    $('alert-overlay').classList.remove('show');
    stopSiren();
  });

  // ---------------------------------------------------------------------
  // Estado + tempo real
  // ---------------------------------------------------------------------
  function addEvent(ev, { alert = false } = {}) {
    if (seen.has(ev.id)) return;
    seen.add(ev.id);
    events.unshift(ev);
    events.sort((a, b) => b.ts - a.ts);
    if (ev.isMeeting) lastBump = brokerKey(ev);
    renderBoard();
    renderFeed();
    if (alert && ev.isMeeting) showAlert(ev);
  }

  $('period-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-period]');
    if (!btn) return;
    period = btn.dataset.period;
    localStorage.setItem('rankPeriod', period);
    for (const b of $('period-seg').children) b.classList.toggle('on', b === btn);
    lastBump = null;
    renderBoard();
  });

  // aplica período salvo
  for (const b of $('period-seg').children) b.classList.toggle('on', b.dataset.period === period);

  async function loadInitial() {
    const [meta, data] = await Promise.all([
      fetch(api('/api/meta')).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch(api('/api/events')).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
    ]);
    $('account-label').textContent = meta.label;
    document.title = `${meta.label} — Placar de Reuniões`;
    $('enrich-note').textContent = meta.enriched
      ? ''
      : 'sem token Kommo no .env — exibindo IDs';
    knownUsers = meta.users || [];
    for (const ev of data.events) addEvent(ev);
    renderBoard();
    renderFeed();
  }

  function connectSSE() {
    const es = new EventSource(api('/events'));
    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false); // EventSource reconecta sozinho
    es.onmessage = (msg) => {
      try {
        addEvent(JSON.parse(msg.data), { alert: true });
      } catch (e) {
        console.error(e);
      }
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

  // atualiza "há X min" e a virada do dia sem precisar de evento novo
  setInterval(renderBoard, 60000);

  loadInitial()
    .then(connectSSE)
    .catch((status) => {
      if (status === 401) location.href = api('/login');
      else console.error('Falha ao carregar dados:', status);
    });
})();
