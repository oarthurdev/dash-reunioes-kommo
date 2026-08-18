(() => {
  // Mantém ?account= (uso local sem subdomínio) em todas as chamadas.
  const params = new URLSearchParams(location.search);
  const accountQS = params.get('account') ? `?account=${encodeURIComponent(params.get('account'))}` : '';
  const api = (path) => `${path}${accountQS}`;

  const $ = (id) => document.getElementById(id);
  document.getElementById('logout-form').action = api('/logout');

  const events = [];
  const seen = new Set();
  let knownUsers = [];
  let metaCorretor = 25;
  let metaTime = 20;

  // ---------------------------------------------------------------------
  // Som de alerta (campainha WebAudio + locução gravada + voz do navegador)
  // ---------------------------------------------------------------------
  let audioCtx = null;
  let soundOn = localStorage.getItem('soundOn') === '1';
  let sirenTimer = null;

  function updateSoundBtn() {
    $('sound-btn').textContent = soundOn ? '🔊' : '🔇';
    $('sound-btn').title = soundOn ? 'Som ativado' : 'Ativar som';
  }

  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

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

  function playChime() {
    if (!soundOn) return;
    ensureAudio();
    const t = audioCtx.currentTime;
    bellNote(659.25, t, 1.1, 0.4);
    bellNote(523.25, t + 0.45, 1.5, 0.4);
  }

  let currentAlert = null;
  let speakTimer = null;

  if ('speechSynthesis' in window) speechSynthesis.getVoices();

  function ptVoice() {
    return speechSynthesis
      .getVoices()
      .find((v) => v.lang && v.lang.toLowerCase().startsWith('pt'));
  }

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
      alertVoice.play().catch(() => speakDetails(true));
    }, 1100);
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

  if (soundOn) {
    document.body.addEventListener('click', () => ensureAudio(), { once: true });
  }

  // ---------------------------------------------------------------------
  // Identidade visual dos corretores (cor estável por corretor)
  // ---------------------------------------------------------------------
  const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#ef4444', '#f97316', '#eab308', '#06b6d4', '#ec4899', '#22c55e'];

  function avatarColor(key) {
    let h = 0;
    const s = String(key);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function initials(name) {
    const words = String(name || '?').trim().split(/\s+/);
    const a = words[0]?.[0] || '?';
    const b = words.length > 1 ? words[words.length - 1][0] : '';
    return (a + b).toUpperCase();
  }

  function makeAvatar(key, name, className = 'avatar') {
    const el = document.createElement('div');
    el.className = className;
    el.style.background = `radial-gradient(circle at 35% 30%, ${avatarColor(key)}, #0a1128 160%)`;
    el.style.backgroundColor = avatarColor(key);
    el.textContent = initials(name);
    return el;
  }

  // ---------------------------------------------------------------------
  // Classificação e agregação (mês atual)
  // ---------------------------------------------------------------------
  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function isRealizada(ev) {
    if (ev.isMeetingDone) return true;
    const n = norm(ev.statusName);
    return n.includes('reuni') && n.includes('realizad');
  }

  function isAgendada(ev) {
    return Boolean(ev.isMeeting) && !isRealizada(ev);
  }

  function monthStart() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }

  function brokerKey(ev) {
    return ev.responsibleUserId != null ? String(ev.responsibleUserId) : 'none';
  }

  function brokerName(ev) {
    if (ev.responsibleUserName) return ev.responsibleUserName;
    const u = knownUsers.find((u) => String(u.id) === brokerKey(ev));
    return u?.name || (ev.responsibleUserId ? `Corretor #${ev.responsibleUserId}` : 'Sem corretor');
  }

  function dayStr(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function streakDays(key) {
    const days = new Set();
    for (const ev of events) {
      if ((isAgendada(ev) || isRealizada(ev)) && brokerKey(ev) === key) days.add(dayStr(ev.ts));
    }
    let streak = 0;
    const d = new Date();
    // hoje ainda sem reunião não quebra a sequência
    if (!days.has(dayStr(d.getTime()))) d.setDate(d.getDate() - 1);
    while (days.has(dayStr(d.getTime()))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  function aggregate() {
    const start = monthStart();
    const map = new Map();
    for (const u of knownUsers) {
      map.set(String(u.id), { key: String(u.id), name: u.name, agendadas: 0, realizadas: 0, lastTs: 0 });
    }
    let totAgendadas = 0;
    let totRealizadas = 0;
    for (const ev of events) {
      if (ev.ts < start) continue;
      const ag = isAgendada(ev);
      const re = isRealizada(ev);
      if (!ag && !re) continue;
      const key = brokerKey(ev);
      if (!map.has(key)) map.set(key, { key, name: brokerName(ev), agendadas: 0, realizadas: 0, lastTs: 0 });
      const b = map.get(key);
      if (ag) { b.agendadas++; totAgendadas++; }
      if (re) { b.realizadas++; totRealizadas++; }
      b.lastTs = Math.max(b.lastTs, ev.ts);
    }
    const brokers = [...map.values()].sort(
      (a, b) =>
        b.agendadas - a.agendadas ||
        b.realizadas - a.realizadas ||
        b.lastTs - a.lastTs ||
        a.name.localeCompare(b.name, 'pt-BR')
    );
    return { brokers, totAgendadas, totRealizadas };
  }

  function countAgendadasHoje(key) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    let n = 0;
    for (const ev of events) {
      if (isAgendada(ev) && ev.ts >= start.getTime() && brokerKey(ev) === key) n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  let lastBump = null;

  function renderAxis() {
    const axis = $('axis');
    axis.innerHTML = '';
    const stepCount = 5;
    const step = Math.max(1, Math.round(metaCorretor / stepCount));
    for (let v = 0; v < metaCorretor; v += step) {
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.style.left = `${(v / metaCorretor) * 100}%`;
      tick.textContent = v;
      axis.append(tick);
    }
  }

  function renderBoard() {
    const { brokers, totAgendadas, totRealizadas } = aggregate();

    // KPIs do topo
    $('meta-time').textContent = metaTime;
    const pct = Math.min(100, Math.round((totAgendadas / Math.max(1, metaTime)) * 100));
    $('ring-label').textContent = `${pct}%`;
    $('ring-fg').style.strokeDashoffset = String(150.8 * (1 - pct / 100));
    $('kpi-total').textContent = totAgendadas + totRealizadas;

    // Resumo do time
    $('sum-agendadas').textContent = totAgendadas;
    $('sum-realizadas').textContent = totRealizadas;
    $('sum-conv').textContent = totAgendadas > 0 ? `${Math.round((totRealizadas / totAgendadas) * 100)}%` : '0%';

    // Card "Bora!"
    const hit = totAgendadas >= metaTime;
    $('bora-sub').textContent = hit ? 'O time está batendo metas!' : 'Rumo à meta do time!';

    // Ranking
    const list = $('rank-list');
    const oldPos = new Map();
    for (const row of list.children) oldPos.set(row.dataset.key, row.getBoundingClientRect().top);

    list.innerHTML = '';
    brokers.forEach((b, i) => {
      const li = document.createElement('li');
      const active = b.agendadas > 0 || b.realizadas > 0;
      li.className = 'row' + (active && i < 3 ? ` r${i + 1}` : '') + (active ? '' : ' zero');
      li.dataset.key = b.key;

      // posição
      const pos = document.createElement('span');
      pos.className = 'pos';
      if (active && i < 3) {
        const crown = document.createElement('span');
        crown.className = 'crown';
        crown.textContent = '👑';
        pos.append(crown);
      }
      pos.append(document.createTextNode(active ? `${i + 1}º` : '·'));

      // corretor
      const who = document.createElement('div');
      who.className = 'who';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = b.name;
      who.append(makeAvatar(b.key, b.name), name);

      // barras
      const bars = document.createElement('div');
      bars.className = 'bars';
      const stepPx = Math.max(1, Math.round(metaCorretor / 5));
      for (let v = stepPx; v < metaCorretor; v += stepPx) {
        const gl = document.createElement('span');
        gl.className = 'grid-line';
        gl.style.left = `${(v / metaCorretor) * 100}%`;
        bars.append(gl);
      }
      const mk = (cls, value, leader) => {
        const bar = document.createElement('div');
        bar.className = `bar ${cls}`;
        const fill = document.createElement('i');
        const w = Math.min(100, (value / metaCorretor) * 100);
        fill.style.width = `${w}%`;
        bar.append(fill);
        const val = document.createElement('span');
        val.className = 'val';
        val.style.left = `${w}%`;
        val.textContent = value;
        bar.append(val);
        if (leader && value > 0) {
          const rk = document.createElement('span');
          rk.className = 'rocket';
          rk.style.left = `${w}%`;
          rk.textContent = '🚀';
          bar.append(rk);
        }
        return bar;
      };
      bars.append(mk('agendadas', b.agendadas, i === 0 && active), mk('realizadas', b.realizadas, false));

      // números "x / meta"
      const nums = document.createElement('div');
      nums.className = 'nums';
      nums.innerHTML =
        `<div class="a">${b.agendadas} <small>/ ${metaCorretor}</small></div>` +
        `<div class="r">${b.realizadas} <small>/ ${metaCorretor}</small></div>`;

      // sequência de dias
      const st = streakDays(b.key);
      const streak = document.createElement('div');
      streak.className = 'streak' + (st > 0 ? '' : ' off');
      streak.innerHTML =
        `<span class="fire">🔥</span><span><b>${st > 0 ? st : '—'} ${st === 1 ? 'dia' : 'dias'}</b><small>${st === 1 ? 'seguido' : 'seguidos'}</small></span>`;

      li.append(pos, who, bars, nums, streak);
      if (b.key === lastBump) {
        li.classList.add('bump');
        li.addEventListener('animationend', () => li.classList.remove('bump'), { once: true });
      }
      list.append(li);
    });

    // FLIP: anima as linhas até a nova posição
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
  // Relógio do cabeçalho
  // ---------------------------------------------------------------------
  const fmtDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtClock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

  function tickClock() {
    const now = new Date();
    $('date-chip').textContent = fmtDate.format(now);
    $('time-chip').textContent = fmtClock.format(now);
  }
  tickClock();
  setInterval(tickClock, 15000);

  // ---------------------------------------------------------------------
  // Alerta visual
  // ---------------------------------------------------------------------
  function showAlert(ev) {
    currentAlert = ev;
    const name = ev.leadName || `Lead #${ev.leadId}`;
    $('alert-lead').textContent = name;
    $('alert-broker').textContent = ev.responsibleUserName ? `Corretor: ${ev.responsibleUserName}` : '';

    const av = $('alert-avatar');
    av.style.background = `radial-gradient(circle at 35% 30%, ${avatarColor(brokerKey(ev))}, #0a1128 160%)`;
    av.textContent = initials(ev.responsibleUserName || name);

    const n = countAgendadasHoje(brokerKey(ev));
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
    if (ev.isMeeting || isRealizada(ev)) lastBump = brokerKey(ev);
    renderBoard();
    if (alert && isAgendada(ev)) showAlert(ev);
  }

  async function loadInitial() {
    const [meta, data] = await Promise.all([
      fetch(api('/api/meta')).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch(api('/api/events')).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
    ]);
    $('account-label').textContent = meta.label;
    document.title = `${meta.label} — Dashboard de Reuniões`;
    knownUsers = meta.users || [];
    metaCorretor = meta.metaCorretor || 25;
    metaTime = meta.metaTime || 20;
    $('meta-corretor').textContent = metaCorretor;
    renderAxis();
    for (const ev of data.events) addEvent(ev);
    renderBoard();
  }

  function connectSSE() {
    const es = new EventSource(api('/events'));
    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false);
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

  if ('Notification' in window && Notification.permission === 'default') {
    document.body.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }

  // atualiza streaks/virada de dia sem depender de evento novo
  setInterval(renderBoard, 60000);

  loadInitial()
    .then(connectSSE)
    .catch((status) => {
      if (status === 401) location.href = api('/login');
      else console.error('Falha ao carregar dados:', status);
    });
})();
