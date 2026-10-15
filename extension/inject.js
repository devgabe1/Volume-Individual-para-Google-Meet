// Meet Volume Individual
// Roda no "MAIN world" da página do Meet, antes dos scripts do próprio Meet.
//
// Como funciona:
// 1. Interceptamos o RTCPeerConnection para saber quais faixas de áudio são remotas
//    e qual RTCRtpReceiver as entrega.
// 2. Interceptamos o setter de `srcObject` dos elementos <audio>. Quando o Meet
//    tenta tocar um stream remoto, trocamos por: stream -> GainNode -> stream novo.
//    O Meet continua tocando no mesmo elemento (respeita o dispositivo de saída escolhido).
// 3. O Meet não usa um stream por pessoa: ele mistura em poucos canais e troca quem
//    está em cada canal conforme quem fala. A identidade de quem está falando vem nos
//    CSRCs do RTP (receiver.getContributingSources()). Consultamos isso a cada ~20ms
//    e ajustamos o ganho do canal para o volume da pessoa que está nele.
// 4. Para saber o nome de cada voz, cruzamos "voz ativa" com "quadro do participante
//    animando" (indicador de fala do Meet). Volumes ficam salvos por nome.
(() => {
  'use strict';
  if (window.__meetVolume) return;

  const LOG = '[MeetVolume]';
  const POLL_MS = 10;
  const HANDOFF_MS = 60;  // janela em que duas vozes no mesmo canal contam como "trocando"
  const ACTIVE_MS = 400;
  const LEARN_MS = 150;         // frequência da amostragem voz x quadro
  const LEARN_WINDOW_MS = 300;  // "ativo agora" = mudou nos últimos 300ms
  const MIN_SAMPLES = 12;       // amostras mínimas antes de dar nome a uma voz
  const RENAME_SAMPLES = 40;    // ...e antes de trocar o nome automático de uma voz
  const BRIDGE = 'meet-volume'; // marcador das mensagens trocadas com bridge.js
  const LEGACY_KEYS = { store: 'meetVolume:v1', ui: 'meetVolume:ui' };

  const receiversByTrack = new Map(); // track.id -> RTCRtpReceiver
  const peerConnections = new Set();  // usado só pelo diagnóstico
  const pipes = new Set();            // canais de áudio sendo processados
  const pending = new Set();          // elementos aguardando o AudioContext liberar
  const voices = new Map();           // voiceId -> { label, name, volume, muted, lastActive, level }
  let master = 1;
  let ctx = null;
  let voiceCounter = 0;

  // ---------------------------------------------------------------- RTCPeerConnection
  const OrigPC = window.RTCPeerConnection;
  if (OrigPC) {
    const PCProxy = new Proxy(OrigPC, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget);
        peerConnections.add(pc);
        pc.addEventListener('connectionstatechange', () => {
          if (pc.connectionState === 'closed') peerConnections.delete(pc);
        });
        pc.addEventListener('track', (e) => {
          if (e.track && e.track.kind === 'audio') {
            receiversByTrack.set(e.track.id, e.receiver);
            e.track.addEventListener('ended', () => receiversByTrack.delete(e.track.id));
          }
        });
        return pc;
      },
    });
    window.RTCPeerConnection = PCProxy;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PCProxy;
  }

  // ---------------------------------------------------------------- AudioContext
  function getCtx() {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'running') flushPending();
      });
      const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
      for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, true);
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }

  // ---------------------------------------------------------------- srcObject hook
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  const ORIG = Symbol('meetVolumeOrig');

  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get() {
      // O Meet continua enxergando o stream original que ele mesmo definiu.
      return ORIG in this ? this[ORIG] : srcDesc.get.call(this);
    },
    set(value) {
      this[ORIG] = value;
      pending.delete(this);
      let out = value;
      try {
        out = maybeProcess(this, value);
      } catch (err) {
        console.warn(LOG, 'falha ao processar áudio, usando original', err);
      }
      srcDesc.set.call(this, out);
    },
  });

  function findReceiver(stream) {
    if (!(stream instanceof MediaStream)) return null;
    if (stream.getVideoTracks().length) return null;
    const track = stream.getAudioTracks()[0];
    return track ? receiversByTrack.get(track.id) || null : null;
  }

  function maybeProcess(el, stream) {
    const receiver = findReceiver(stream);
    if (!receiver) return stream;
    const c = getCtx();
    if (c.state !== 'running') {
      // Sem gesto do usuário ainda: toca o original e troca assim que liberar.
      pending.add(el);
      return stream;
    }
    return createPipe(stream, receiver).output;
  }

  function flushPending() {
    for (const el of pending) {
      pending.delete(el);
      const stream = el[ORIG];
      const receiver = findReceiver(stream);
      if (receiver) srcDesc.set.call(el, createPipe(stream, receiver).output);
    }
  }

  function createPipe(stream, receiver) {
    const c = getCtx();

    // Bug conhecido do Chrome: stream WebRTC remoto só entrega áudio ao WebAudio
    // se também estiver ligado a um elemento de mídia. Elemento mudo resolve.
    const keepAlive = new Audio();
    keepAlive.muted = true;
    srcDesc.set.call(keepAlive, stream);
    keepAlive.play().catch(() => {});

    // source -> gain -> dry --------------------------> dest
    //                \-> compressor -> limiter -> wet -/
    // "Igualar volumes" (opcional) só troca dry/wet; o caminho comprimido existe sempre
    // para a troca ser instantânea e sem clique.
    const source = c.createMediaStreamSource(stream);
    const gain = c.createGain();
    const dest = c.createMediaStreamDestination();
    const dry = c.createGain();
    const wet = c.createGain();

    const comp = c.createDynamicsCompressor();
    // O compressor do Chrome já aplica ganho de compensação automático: quem fala
    // alto desce um pouco e quem fala baixo sobe bastante.
    comp.threshold.value = -28;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;
    const limiter = c.createDynamicsCompressor(); // teto contra estouro (volume > 100%)
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    source.connect(gain);
    gain.connect(dry).connect(dest);
    gain.connect(comp).connect(limiter).connect(wet).connect(dest);
    dry.gain.value = store.normalize ? 0 : 1;
    wet.gain.value = store.normalize ? 1 : 0;

    // Nível do som que chega no canal (antes do nosso volume), para o diagnóstico.
    const analyser = c.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const pipe = { receiver, gain, dry, wet, source, analyser, keepAlive, output: dest.stream, currentVoice: null };
    pipes.add(pipe);

    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      pipes.delete(pipe);
      try { source.disconnect(); gain.disconnect(); } catch {}
      srcDesc.set.call(keepAlive, null);
    });
    return pipe;
  }

  // ---------------------------------------------------------------- configurações
  // Ficam no chrome.storage.local (via bridge.js), compartilhadas com a página de
  // opções. Volumes são salvos por nome da pessoa (IDs de áudio mudam a cada
  // chamada; o nome não).
  const DEFAULTS = { master: 1, normalize: false, autoName: true, dock: true, ui: null, people: {} };
  const store = { ...DEFAULTS, people: {} };
  const storeListeners = new Set(); // a UI se inscreve para refletir mudanças vindas das opções
  const ownSaves = [];              // ecos dos nossos próprios saves, para ignorar
  let bridgeReady = false;
  let extensionVersion = null;      // informado pela ponte (manifest.json)

  function saveStore() {
    if (!bridgeReady) return; // antes de carregar, salvar apagaria o que está guardado
    const json = JSON.stringify(store);
    ownSaves.push(json);
    if (ownSaves.length > 30) ownSaves.shift();
    window.postMessage({ [BRIDGE]: 'toBridge', type: 'save', settings: JSON.parse(json) }, location.origin);
  }

  function applySettings(s) {
    const prevNormalize = store.normalize;
    Object.assign(store, DEFAULTS, s, { people: { ...(s.people || {}) } });
    master = store.master;
    for (const v of voices.values()) {
      const p = v.name.trim() && personOf(v.name);
      if (p) { v.volume = p.volume; v.muted = p.muted; v.dirty = true; }
    }
    if (store.normalize !== prevNormalize) applyNormalize();
    for (const fn of storeListeners) fn();
  }

  // Versões anteriores salvavam no localStorage do meet.google.com: migra uma vez.
  function migrateLegacy() {
    try {
      const old = JSON.parse(localStorage.getItem(LEGACY_KEYS.store));
      const ui = JSON.parse(localStorage.getItem(LEGACY_KEYS.ui));
      if (!old && !ui) return;
      applySettings({ ...old, ui: ui || null });
      saveStore();
      localStorage.removeItem(LEGACY_KEYS.store);
      localStorage.removeItem(LEGACY_KEYS.ui);
    } catch {}
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[BRIDGE] !== 'toPage') return;
    const { type, settings } = e.data;
    if (e.data.version) extensionVersion = e.data.version;
    if (type === 'init') {
      if (bridgeReady) return; // a ponte pode mandar "init" duas vezes
      bridgeReady = true;
      if (settings) applySettings(settings);
      else migrateLegacy();
    } else if (type === 'changed' && settings) {
      if (ownSaves.includes(JSON.stringify(settings))) return;
      applySettings(settings);
    }
  });
  window.postMessage({ [BRIDGE]: 'toBridge', type: 'ready' }, location.origin);

  function applyNormalize() {
    if (!ctx) return;
    const on = store.normalize;
    for (const p of pipes) {
      p.dry.gain.setTargetAtTime(on ? 0 : 1, ctx.currentTime, 0.03);
      p.wet.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.03);
    }
  }

  function setNormalize(on) {
    store.normalize = on;
    saveStore();
    applyNormalize();
  }

  const nameKey = (name) => name.trim().toLocaleLowerCase();

  const personOf = (name) => store.people[nameKey(name)] || null;

  // Salva o volume de uma pessoa e aplica em todas as vozes com esse nome.
  function setPerson(name, patch) {
    const key = nameKey(name);
    if (!key) return;
    const p = { name: name.trim(), volume: 1, muted: false, ...store.people[key], ...patch };
    store.people[key] = p;
    saveStore();
    for (const v of voices.values()) {
      if (v.name.trim() && nameKey(v.name) === key) {
        v.volume = p.volume;
        v.muted = p.muted;
        v.dirty = true;
      }
    }
  }

  // Ajuste feito pelo usuário numa voz (painel). Se ela tem nome, vale para a pessoa.
  function adjust(v, patch) {
    Object.assign(v, patch);
    v.touched = true;
    v.dirty = true;
    if (v.name.trim()) setPerson(v.name, { volume: v.volume, muted: v.muted });
  }

  function setName(v, name, source) {
    const renaming = v.name.trim() !== '';
    v.name = name;
    v.nameSource = name.trim() ? source : '';
    v.dirty = true;
    if (!name.trim()) return;
    const saved = store.people[nameKey(name)];
    // Renomeação automática = a voz tinha sido confundida com outra pessoa. O volume
    // atual era o dessa outra pessoa: não pode ser copiado para o novo nome.
    if (renaming && source === 'auto') {
      v.volume = saved ? saved.volume : 1;
      v.muted = saved ? saved.muted : false;
      v.touched = false;
      return;
    }
    // Se o usuário mexeu no volume de uma voz ainda sem nome, esse ajuste vale mais
    // que o salvo. Numa renomeação, o volume ajustado era da pessoa antiga.
    if (saved && !(v.touched && !renaming)) {
      v.volume = saved.volume;
      v.muted = saved.muted;
    } else if (v.touched) {
      setPerson(name, { volume: v.volume, muted: v.muted });
    }
  }

  // ---------------------------------------------------------------- quem está falando
  function getVoice(id) {
    let v = voices.get(id);
    if (!v) {
      v = {
        id, label: `Voz ${++voiceCounter}`, name: '', nameSource: '',
        volume: 1, muted: false, touched: false, lastActive: 0, level: 0, dirty: true,
      };
      voices.set(id, v);
    }
    return v;
  }

  // O Meet coloca nos pacotes com fala, junto do CSRC real da pessoa, um CSRC
  // marcador (visto: 42) com o mesmo nível e timestamp, em TODOS os canais. Ele não é
  // uma pessoa: se virasse uma "voz", o volume dela valeria para todo mundo.
  // Marcador = valor pequeno demais para um SSRC real (que é aleatório de 32 bits)
  // ou CSRC que aparece em mais de um canal ao mesmo tempo.
  const markerCsrcs = new Set();
  const overlapHits = new Map(); // csrc -> vezes em que tocou em 2+ canais no mesmo instante
  const MARKER_HITS = 3;
  const FRESH_MS = 200;

  // Recebe os CSRCs de todos os canais num mesmo instante. Timestamps do Chrome são
  // de relógio absoluto (timeOrigin + now), então dá para comparar entre canais.
  // Uma pessoa trocando de canal nunca está "fresca" em dois ao mesmo tempo.
  function detectMarkers(lists) {
    const nowTs = performance.timeOrigin + performance.now();
    const freshOn = new Map();
    for (const list of lists) {
      for (const s of list) {
        if (markerCsrcs.has(s.source)) continue;
        if (s.source < 65536) { markerCsrcs.add(s.source); continue; }
        if (nowTs - s.timestamp < FRESH_MS) freshOn.set(s.source, (freshOn.get(s.source) || 0) + 1);
      }
    }
    for (const [source, n] of freshOn) {
      if (n < 2) continue;
      const hits = (overlapHits.get(source) || 0) + 1;
      overlapHits.set(source, hits);
      if (hits >= MARKER_HITS) {
        markerCsrcs.add(source);
        console.info(LOG, `CSRC ${source} toca em vários canais ao mesmo tempo: ignorado (marcador do Meet)`);
      }
    }
  }

  function currentVoiceOf(pipe, all) {
    const receiver = pipe.receiver;
    // CSRC = participante original deste canal. Entre os que acabaram de tocar
    // (fora os marcadores), o de maior nível de áudio é quem está falando.
    let latest = -Infinity;
    for (const s of all) latest = Math.max(latest, s.timestamp);
    const csrcs = all.filter((s) => !markerCsrcs.has(s.source));
    let best = null;
    for (const s of csrcs) {
      if (latest - s.timestamp >= HANDOFF_MS) continue;
      if (!best || (s.audioLevel ?? 0) > (best.audioLevel ?? 0) ||
          ((s.audioLevel ?? 0) === (best.audioLevel ?? 0) && s.timestamp > best.timestamp)) best = s;
    }
    // Canal em silêncio: o CSRC real continua chegando (pacotes de silêncio), só
    // talvez sem timestamp recente. Fica com o mais recente que não é marcador.
    if (!best) for (const s of csrcs) if (!best || s.timestamp > best.timestamp) best = s;
    if (best) return { id: 'c' + best.source, level: best.audioLevel ?? 0, timestamp: best.timestamp };

    // Sem CSRC: o canal em si representa uma fonte (SSRC). Não vale para SSRCs
    // pequenos, que são canais virtuais (o Meet usa 6666, 6667...), não pessoas.
    const ssrcs = (receiver.getSynchronizationSources ? receiver.getSynchronizationSources() : [])
      .filter((s) => s.source >= 65536);
    if (ssrcs.length) return { id: 's' + ssrcs[0].source, level: ssrcs[0].audioLevel ?? 0, timestamp: ssrcs[0].timestamp };
    return null;
  }

  const targetOf = (v) => (v.muted ? 0 : v.volume * master);

  function tick() {
    const now = performance.now();
    const lists = new Map();
    for (const pipe of pipes) {
      lists.set(pipe, pipe.receiver.getContributingSources ? pipe.receiver.getContributingSources() : []);
    }
    detectMarkers(lists.values());
    for (const pipe of pipes) {
      const info = currentVoiceOf(pipe, lists.get(pipe));
      if (!info) continue;
      const v = getVoice(info.id);
      v.level = info.level;
      if (info.timestamp !== pipe.lastTimestamp && info.level > 0.01) v.lastActive = now;
      pipe.lastTimestamp = info.timestamp;

      const switched = pipe.currentVoice !== info.id;
      if (switched) {
        pipe.prevVoice = pipe.currentVoice;
        pipe.switchedAt = now;
        pipe.currentVoice = info.id;
      }

      // Na troca de pessoa no canal, o volume novo chega alguns ms atrasado. Para não
      // tocar o começo da fala de alguém com o volume alto de quem falava antes,
      // usamos o MENOR dos dois volumes, só durante HANDOFF_MS depois da troca.
      let target = targetOf(v);
      const prev = pipe.prevVoice && voices.get(pipe.prevVoice);
      if (prev && now - pipe.switchedAt < HANDOFF_MS) target = Math.min(target, targetOf(prev));

      if (switched || Math.abs(pipe.gain.gain.value - target) > 0.001) {
        // Rampa curta na troca (sem clique), mais suave em ajustes normais.
        if (switched) pipe.gain.gain.cancelScheduledValues(ctx.currentTime);
        pipe.gain.gain.setTargetAtTime(target, ctx.currentTime, switched ? 0.004 : 0.02);
      }
    }
  }
  setInterval(tick, POLL_MS);

  // ---------------------------------------------------------------- identificação automática
  // Os quadros dos participantes têm [data-participant-id]. Quando alguém fala, o Meet
  // anima o indicador de áudio do quadro dela (muda class/style). Não dependemos de
  // nenhuma classe específica: só observamos "o quadro X está mudando agora" e cruzamos
  // estatisticamente com "a voz Y está ativa agora".
  //
  // Para cada voz, medimos a taxa de vezes em que cada quadro estava animado enquanto
  // SÓ aquela voz falava, e subtraímos a taxa de base do quadro (quando nenhuma voz
  // remota fala). Isso elimina quadros que vivem mudando e o seu próprio quadro.
  const tileLastChange = new Map(); // participantId -> performance.now()
  const stats = new Map();          // voiceId -> { n, hits: Map<pid, count> }
  const baseline = { n: 0, hits: new Map() };

  function watchTiles() {
    new MutationObserver((mutations) => {
      const now = performance.now();
      for (const m of mutations) {
        const el = m.target;
        if (el.nodeName === 'VIDEO') continue;
        const tile = el.closest && el.closest('[data-participant-id]');
        if (tile) tileLastChange.set(tile.getAttribute('data-participant-id'), now);
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  const ICON_TEXT = /^[a-z0-9_]+$/; // ícones Material são texto tipo "mic_off"

  // Textos de botões, dicas e menus do quadro ("Fixar Fulano na tela", "Mais opções"...).
  const CONTROL_TEXT = 'button, [role="button"], [role="tooltip"], [role="menu"], [role="menuitem"], [aria-hidden="true"]';

  function tileName(pid) {
    const candidates = [], all = [];
    for (const tile of document.querySelectorAll(`[data-participant-id="${CSS.escape(pid)}"]`)) {
      const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.trim();
        if (!text || text.length > 60 || ICON_TEXT.test(text)) continue;
        const parent = node.parentElement;
        if (!parent) continue;
        const r = parent.getBoundingClientRect();
        all.push(text);
        if (r.width <= 1 || r.height <= 1) continue; // escondido ou só para leitor de tela
        if (parent.closest(CONTROL_TEXT)) continue;
        candidates.push(text);
      }
    }
    if (!candidates.length) return null;
    // Se um texto aparece dentro de outros ("Ana" em "Fixar Ana na tela"), é o nome.
    const score = (c) => all.filter((o) => o !== c && o.includes(c)).length;
    let best = candidates[0];
    for (const c of candidates) if (score(c) > score(best)) best = c;
    return best;
  }

  function bump(bucket, activeTiles) {
    bucket.n++;
    bucket.total = (bucket.total || 0) + 1; // sem decaimento, usado pelos avisos
    for (const pid of activeTiles) bucket.hits.set(pid, (bucket.hits.get(pid) || 0) + 1);
    // Decaimento: o modelo se adapta se a pessoa sair e outra entrar.
    if (bucket.n > (bucket === baseline ? 300 : 80)) {
      bucket.n /= 2;
      for (const [k, c] of bucket.hits) bucket.hits.set(k, c / 2);
    }
  }

  function learn() {
    const now = performance.now();
    const activeVoices = [];
    for (const v of voices.values()) if (now - v.lastActive < LEARN_WINDOW_MS) activeVoices.push(v);
    if (activeVoices.length > 1) return; // ambíguo, ignora

    const pids = new Set();
    for (const el of document.querySelectorAll('[data-participant-id]')) pids.add(el.getAttribute('data-participant-id'));
    const activeTiles = [...pids].filter((pid) => now - (tileLastChange.get(pid) || 0) < LEARN_WINDOW_MS);

    if (activeVoices.length === 0) {
      bump(baseline, activeTiles);
      return;
    }

    const v = activeVoices[0];
    let s = stats.get(v.id);
    if (!s) stats.set(v.id, (s = { n: 0, hits: new Map() }));
    bump(s, activeTiles);
    if (s.n < MIN_SAMPLES || v.nameSource === 'manual' || !store.autoName) return;

    // Só disputam quadros com nome legível: um quadro sem nome (ex.: o seu, ou um
    // vazio) nunca pode ser atribuído e só atrasaria a decisão.
    const names = new Map();
    for (const pid of pids) {
      const n = tileName(pid);
      if (n) names.set(pid, n);
    }
    let best = null, second = null;
    for (const pid of names.keys()) {
      const rate = (s.hits.get(pid) || 0) / s.n;
      const base = baseline.n ? (baseline.hits.get(pid) || 0) / baseline.n : 0;
      const cand = { pid, rate, lift: rate - base };
      if (!best || cand.lift > best.lift) { second = best; best = cand; }
      else if (!second || cand.lift > second.lift) second = cand;
    }
    if (!best || best.rate < 0.5 || best.lift < 0.3) return;
    if (second && best.lift - second.lift < 0.15) return;
    if (best.pid === v.pid) { v.autoLift = best.lift; return; }

    // Trocar o nome de uma voz já identificada exige mais evidência que nomear a primeira vez.
    if (v.nameSource === 'auto' && (s.n < RENAME_SAMPLES || best.lift < 0.5)) return;

    // Um quadro = uma voz. Se outra voz já tem este quadro, fica com quem tem mais evidência.
    for (const u of voices.values()) {
      if (u === v || u.pid !== best.pid || u.nameSource !== 'auto') continue;
      if ((u.autoLift || 0) >= best.lift) return;
      console.info(LOG, `${u.label} deixou de ser "${u.name}" (${v.label} combina melhor)`);
      u.pid = null;
      u.autoLift = 0;
      clearAutoName(u);
    }

    const name = names.get(best.pid);
    v.pid = best.pid;
    v.autoLift = best.lift;
    if (name !== v.name) {
      console.info(LOG, `${v.label} identificada como "${name}"`);
      setName(v, name, 'auto');
    }
  }

  // Desfaz um nome automático errado: a voz volta a ser "Voz N" com volume padrão
  // (o volume que ela tinha era o da pessoa com quem foi confundida).
  function clearAutoName(v) {
    v.name = '';
    v.nameSource = '';
    if (!v.touched) { v.volume = 1; v.muted = false; }
    v.dirty = true;
  }

  // ---------------------------------------------------------------- diagnóstico
  // Grava alguns segundos do que o Meet informa sobre cada canal de áudio, para
  // entender o comportamento real dele numa chamada. Nomes e quadros viram apelidos
  // (Pessoa1, Quadro1...) para o arquivo poder ser compartilhado.
  async function record(seconds = 15, onProgress) {
    const alias = (prefix) => {
      const map = new Map();
      return (key) => {
        if (key == null || key === '') return null;
        if (!map.has(key)) map.set(key, prefix + (map.size + 1));
        return map.get(key);
      };
    };
    const nameOf = alias('Pessoa');
    const tileOf = alias('Quadro');
    const channelOf = alias('Canal');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const round = (x, d = 3) => (x == null ? null : +x.toFixed(d));
    const buf = new Float32Array(512);
    const rms = (an) => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const x of buf) s += x * x;
      return round(Math.sqrt(s / buf.length), 4);
    };
    const tsBase = {}; // timestamps relativos ao primeiro visto, separados por tipo (CSRC/SSRC)
    const ts = (prefix, t) => { tsBase[prefix] ??= t; return Math.round(t - tsBase[prefix]); };
    const sources = (list, prefix) => list.map((s) => ({
      id: prefix + s.source, level: round(s.audioLevel), ts: ts(prefix, s.timestamp), rtp: s.rtpTimestamp ?? null,
    }));

    const meta = {
      extensionVersion,
      userAgent: navigator.userAgent,
      startedAt: new Date().toISOString(),
      peerConnections: peerConnections.size,
      audioReceivers: receiversByTrack.size,
      channels: pipes.size,
      audioElements: document.querySelectorAll('audio').length,
      audioContext: ctx ? ctx.state : null,
      markerCsrcs: [...markerCsrcs],
      settings: { master, normalize: store.normalize, autoName: store.autoName },
      headerExtensions: [...pipes].map((p) => {
        try { return { channel: channelOf(p), uris: p.receiver.getParameters().headerExtensions.map((e) => e.uri) }; }
        catch { return { channel: channelOf(p), uris: null }; }
      }),
    };

    const samples = [];
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
      const now = performance.now();
      const channels = [];
      for (const p of pipes) {
        let inbound = null;
        try {
          for (const r of (await p.receiver.getStats()).values()) {
            if (r.type === 'inbound-rtp') inbound = { ssrc: r.ssrc, level: round(r.audioLevel), packets: r.packetsReceived, energy: round(r.totalAudioEnergy, 5) };
          }
        } catch {}
        channels.push({
          ch: channelOf(p),
          chosen: p.currentVoice,
          gain: round(p.gain.gain.value),
          rms: rms(p.analyser),
          csrcs: sources(p.receiver.getContributingSources?.() || [], 'c'),
          ssrcs: sources(p.receiver.getSynchronizationSources?.() || [], 's'),
          inbound,
        });
      }
      const tiles = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('[data-participant-id]')) {
        const pid = el.getAttribute('data-participant-id');
        if (seen.has(pid)) continue;
        seen.add(pid);
        const changed = tileLastChange.get(pid);
        tiles.push({ tile: tileOf(pid), name: nameOf(tileName(pid)), changedMsAgo: changed ? Math.round(now - changed) : null });
      }
      const vs = [...voices.values()].map((v) => ({
        id: v.id, name: nameOf(v.name.trim()) || v.label, source: v.nameSource || null, tile: tileOf(v.pid),
        volume: v.volume, muted: v.muted, activeMsAgo: v.lastActive ? Math.round(now - v.lastActive) : null,
      }));
      // Barra de controles a cada ~0,5 s (para ver o que muda ao abrir os seletores).
      const bar = samples.length % 5 === 0 ? describeBar() : undefined;
      samples.push({ t: Math.round(now - t0), channels, tiles, voices: vs, bar });
      if (onProgress) onProgress(Math.ceil(seconds - (performance.now() - t0) / 1000));
      await wait(100);
    }

    const learning = [...stats].map(([id, s]) => ({
      voice: id, n: round(s.n, 1), total: s.total,
      hits: Object.fromEntries([...s.hits].map(([pid, c]) => [tileOf(pid), round(c / s.n)])),
    }));
    const base = { n: round(baseline.n, 1), hits: Object.fromEntries([...baseline.hits].map(([pid, c]) => [tileOf(pid), round(c / (baseline.n || 1))])) };
    return { meta, learning, baseline: base, samples };
  }

  async function downloadDiagnostic(onProgress) {
    const data = await record(15, onProgress);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `meet-volume-diagnostico-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.documentElement.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------------------------------------------------------------- avisos
  // Detecta quando o Meet mudou algo por dentro e a extensão deixou de funcionar.
  let remoteSince = 0;      // primeira vez que vimos áudio remoto (RTCPeerConnection)
  let unknownAudioSince = 0; // <audio> tocando stream que não passou pelo nosso hook
  let noTilesSince = 0;      // quadros [data-participant-id] ausentes desde

  function health() {
    const now = performance.now();
    const issues = []; // { level: 'error' | 'info', text }

    if (pending.size) {
      issues.push({ level: 'error', text: 'Clique em qualquer lugar da página para ativar o controle de volume.' });
    }

    if (receiversByTrack.size && !remoteSince) remoteSince = now;
    if (remoteSince && !pipes.size && !pending.size && now - remoteSince > 10000) {
      issues.push({ level: 'error', text: 'O áudio da chamada não está passando pela extensão. O Meet pode ter mudado; o volume individual não está funcionando.' });
    }

    let unknown = false;
    if (!receiversByTrack.size) {
      for (const el of document.querySelectorAll('audio')) {
        const s = srcDesc.get.call(el);
        if (s instanceof MediaStream && s.getAudioTracks().some((t) => t.readyState === 'live')) { unknown = true; break; }
      }
    }
    if (!unknown) unknownAudioSince = 0;
    else if (!unknownAudioSince) unknownAudioSince = now;
    if (unknownAudioSince && now - unknownAudioSince > 15000) {
      issues.push({ level: 'error', text: 'Não consegui interceptar a conexão de áudio do Meet. Recarregue a página; se continuar, o Meet mudou.' });
    }

    // Os quadros somem por instantes (troca de layout, apresentação, aba em segundo
    // plano): só avisa se ficarem ausentes por um tempo.
    if (document.querySelector('[data-participant-id]')) noTilesSince = 0;
    else if (!noTilesSince) noTilesSince = now;
    const hasTiles = !noTilesSince || now - noTilesSince < 15000;
    let learned = false, unnamed = false;
    for (const [id, s] of stats) {
      const v = voices.get(id);
      if (s.total >= 40) learned = true;
      if (s.total >= 60 && v && !v.nameSource) unnamed = true;
    }
    if (learned && !hasTiles) {
      issues.push({ level: 'error', text: 'Não encontrei os quadros dos participantes. Nomes automáticos indisponíveis: digite os nomes à mão.' });
    } else if (unnamed) {
      issues.push({ level: 'info', text: 'Algumas vozes não foram identificadas automaticamente. Digite o nome delas à mão.' });
    }
    return issues;
  }

  // ---------------------------------------------------------------- API para depuração
  window.__meetVolume = {
    voices,
    store,
    stats,
    baseline,
    health,
    tileName,
    record,
    // Estado de cada canal de áudio: quem a extensão acha que está nele e o que o Meet informa.
    channels: () => [...pipes].map((p) => ({
      voice: p.currentVoice,
      name: voices.get(p.currentVoice)?.name || voices.get(p.currentVoice)?.label,
      gain: +p.gain.gain.value.toFixed(3),
      csrcs: ((list) => {
        const latest = Math.max(...list.map((s) => s.timestamp));
        // behindMs: quanto este CSRC está atrás do mais recente do canal (0 = tocando agora)
        return list.map((s) => ({ id: 'c' + s.source, level: +(s.audioLevel ?? 0).toFixed(3), behindMs: Math.round(latest - s.timestamp) }));
      })(p.receiver.getContributingSources?.() || []),
    })),
    get master() { return master; },
    get active() { return pipes.size; },
  };

  // ---------------------------------------------------------------- UI
  // Meet usa Trusted Types: nada de innerHTML, só createElement/textContent.
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v; // input.list é só leitura
      else el.setAttribute(k, v);
    }
    for (const c of children) el.append(c);
    return el;
  }

  // Ícones Material (mesmo conjunto usado pelo Meet), viewBox 24x24.
  const ICONS = {
    volumeUp: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    volumeOff: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  };

  function icon(name, size = 20) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  // Botão de silenciar: alto-falante normal ou cortado (vermelho, como no Meet).
  function setMuteIcon(btn, muted) {
    btn.replaceChildren(icon(muted ? 'volumeOff' : 'volumeUp', 18));
    btn.classList.toggle('on', muted);
    btn.title = muted ? 'Ativar som' : 'Silenciar';
  }

  const FAB = 40;
  const PANEL_W = 320;
  const HIDE_SILENT_MS = 10 * 60e3; // some da lista quem não fala há 10 min
  const HIDE_GONE_MS = 2 * 60e3;    // ...ou há 2 min, se o quadro dela sumiu

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: 'Google Sans', Roboto, Arial, sans-serif; }
    [hidden] { display: none !important; }
    .fab {
      position: fixed; z-index: 2147483647; touch-action: none;
      width: ${FAB}px; height: ${FAB}px; border-radius: 50%; border: none; cursor: grab;
      background: #3c4043; color: #e8eaed; padding: 0; display: grid; place-items: center;
      box-shadow: 0 2px 8px rgba(0,0,0,.4);
    }
    .fab:hover { background: #5f6368; }
    .fab.dragging { cursor: grabbing; }
    .behind { visibility: hidden !important; }
    .fab.alert::after {
      content: ''; position: absolute; top: 2px; right: 2px; width: 10px; height: 10px;
      border-radius: 50%; background: #ea4335; border: 2px solid #3c4043;
    }
    .panel {
      position: fixed; z-index: 2147483647;
      width: ${PANEL_W}px; max-height: 60vh; overflow: auto; padding: 12px;
      background: #202124; color: #e8eaed; border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,.5); font-size: 13px;
    }
    h3 { margin: 0 0 4px; font-size: 15px; font-weight: 500; cursor: grab; user-select: none; touch-action: none; }
    .hint { color: #9aa0a6; font-size: 12px; margin: 0 0 10px; }
    .warn { margin: 0 0 8px; padding: 6px 8px; border-radius: 6px; font-size: 12px; line-height: 1.4; }
    .warn.error { background: #5c2b29; color: #f6aea9; }
    .warn.info { background: #2d3a4f; color: #aecbfa; }
    .row { padding: 8px 0; border-top: 1px solid #3c4043; }
    .top { display: flex; align-items: center; gap: 8px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #5f6368; flex: none; transition: background .1s; }
    .dot.on { background: #34a853; box-shadow: 0 0 6px #34a853; }
    input[type=text] {
      flex: 1; min-width: 0; background: #303134; color: #e8eaed;
      border: 1px solid #5f6368; border-radius: 6px; padding: 4px 6px; font-size: 13px;
    }
    .auto { font-size: 10px; color: #8ab4f8; border: 1px solid #8ab4f8; border-radius: 4px; padding: 0 4px; flex: none; }
    .mute {
      flex: none; width: 28px; height: 28px; padding: 0; border: none; border-radius: 50%;
      display: grid; place-items: center; cursor: pointer; background: none; color: #e8eaed;
    }
    .mute:hover { background: rgba(232,234,237,.12); }
    .mute.on { background: #ea4335; color: #fff; }
    .bottom { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    input[type=range] { flex: 1; min-width: 0; accent-color: #8ab4f8; }
    .pct { width: 42px; text-align: right; color: #9aa0a6; font-variant-numeric: tabular-nums; }
    .empty { color: #9aa0a6; padding: 8px 0; }
    .switch { display: flex; align-items: flex-start; gap: 10px; margin-top: 10px; cursor: pointer; }
    .switch input { position: absolute; opacity: 0; pointer-events: none; }
    .track {
      flex: none; position: relative; width: 32px; height: 18px; margin-top: 1px;
      border-radius: 9px; background: #5f6368; transition: background .15s;
    }
    .track::after {
      content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
      border-radius: 50%; background: #e8eaed; transition: transform .15s;
    }
    .switch input:checked + .track { background: #8ab4f8; }
    .switch input:checked + .track::after { transform: translateX(14px); background: #202124; }
    .switch input:focus-visible + .track { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    .switch .desc { color: #9aa0a6; font-size: 11px; margin-top: 2px; }
    .more { background: none; border: none; color: #8ab4f8; cursor: pointer; font-size: 12px; padding: 8px 0 0; }
    .diag { display: block; color: #9aa0a6; margin-top: 4px; }
    .diag:disabled { cursor: default; color: #fdd663; }
    .tile {
      position: fixed; z-index: 2147483647; width: 220px; padding: 8px 10px;
      background: rgba(32,33,36,.92); color: #e8eaed; border-radius: 10px;
      box-shadow: 0 2px 10px rgba(0,0,0,.5); font-size: 12px;
    }
    .tile .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
    .tile .sub { color: #9aa0a6; font-size: 11px; }
    .tile .bottom { margin-top: 4px; }
  `;

  function slider(value, onChange) {
    const pct = h('span', { className: 'pct' });
    const range = h('input', {
      type: 'range', min: '0', max: '200', step: '5',
      oninput: () => {
        pct.textContent = range.value + '%';
        onChange(Number(range.value) / 100);
      },
    });
    const set = (x) => {
      range.value = String(Math.round(x * 100));
      pct.textContent = range.value + '%';
    };
    set(value);
    return { el: h('div', { className: 'bottom' }, range, pct), range, set };
  }

  function toggle(label, desc, checked, onChange) {
    const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
    return h('label', { className: 'switch' },
      input,
      h('span', { className: 'track' }),
      h('span', {}, h('div', { textContent: label }), h('div', { className: 'desc', textContent: desc })),
    );
  }

  function buildRow(v, datalistId) {
    const dot = h('span', { className: 'dot' });
    const auto = h('span', { className: 'auto', textContent: 'auto', title: 'Nome detectado automaticamente' });
    const name = h('input', {
      type: 'text', placeholder: v.label, list: datalistId,
      // "change" = ao sair do campo / Enter: aí aplica o volume salvo daquele nome.
      onchange: () => setName(v, name.value, 'manual'),
    });
    const mute = h('button', {
      className: 'mute', title: 'Silenciar',
      onclick: () => { adjust(v, { muted: !v.muted }); refresh(); },
    });
    const vol = slider(v.volume, (x) => adjust(v, { volume: x }));
    const row = h('div', { className: 'row' }, h('div', { className: 'top' }, dot, name, auto, mute), vol.el);

    const refresh = () => {
      if (name.getRootNode().activeElement !== name) name.value = v.name;
      auto.hidden = v.nameSource !== 'auto';
      setMuteIcon(mute, v.muted);
      vol.set(v.volume);
    };
    return { row, dot, refresh };
  }

  function savedPos() {
    const s = store.ui;
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return { x: s.x, y: s.y };
    return { x: 16, y: window.innerHeight - 96 - FAB };
  }

  function mountUI() {
    const host = h('div', { id: 'meet-volume-root' });
    const root = host.attachShadow({ mode: 'open' });
    root.append(h('style', { textContent: STYLE }));

    // Sugestões de nome para digitar manualmente: nomes vistos nos quadros.
    const datalistId = 'meet-volume-names';
    const datalist = h('datalist', { id: datalistId });

    const header = h('h3', { textContent: 'Volume individual', title: 'Arraste para mover' });
    const warnings = h('div');
    const list = h('div');
    const empty = h('div', { className: 'empty', textContent: 'Nenhuma voz detectada ainda. Entre na chamada e espere alguém falar.' });
    const masterSlider = slider(master, (x) => { master = x; store.master = x; saveStore(); });
    const normalizeToggle = toggle('Igualar volumes',
      'Aproxima o volume de quem fala alto e de quem fala baixo, e evita som estourado acima de 100%.',
      !!store.normalize, setNormalize);
    let showAll = false;
    const more = h('button', { className: 'more', onclick: () => { showAll = !showAll; render(); } });
    const DIAG_LABEL = 'Gravar diagnóstico (15 s)';
    const diag = h('button', {
      className: 'more diag', textContent: DIAG_LABEL,
      title: 'Grava como o Meet está mandando o áudio e baixa um arquivo para enviar ao desenvolvedor. Os nomes são trocados por apelidos.',
      onclick: async () => {
        if (diag.disabled) return;
        diag.disabled = true;
        try {
          await downloadDiagnostic((s) => { diag.textContent = `Gravando… ${s} s (peça para cada pessoa falar)`; });
          diag.textContent = 'Arquivo baixado ✓';
        } catch (err) {
          console.warn(LOG, 'falha no diagnóstico', err);
          diag.textContent = 'Falhou — veja o console';
        }
        setTimeout(() => { diag.textContent = DIAG_LABEL; diag.disabled = false; }, 3000);
      },
    });
    const panel = h('div', { className: 'panel', hidden: true },
      header,
      h('p', { className: 'hint', textContent: 'Nomes são detectados sozinhos e os volumes ficam salvos por nome. Passe o mouse sobre o vídeo de alguém para ajustar direto.' }),
      warnings,
      h('div', { className: 'row' },
        h('div', { className: 'top' }, h('strong', { textContent: 'Geral' })),
        masterSlider.el,
        normalizeToggle,
      ),
      empty,
      list,
      more,
      diag,
      datalist,
    );
    const fab = h('button', { className: 'fab', title: 'Volume individual (arraste para mover)' }, icon('volumeUp', 22));
    const tile = buildTileControl();
    root.append(panel, fab, tile.el);
    document.documentElement.append(host);

    const togglePanel = () => {
      panel.hidden = !panel.hidden;
      dock.setActive(!panel.hidden);
      render();
      layout();
    };
    const dock = buildDock(togglePanel);

    // ---- posição do botão e do painel (arrastáveis, posição salva)
    let pos = savedPos();

    // Mudanças feitas na página de opções (ou a carga inicial das configurações).
    storeListeners.add(() => {
      masterSlider.set(master);
      normalizeToggle.querySelector('input').checked = !!store.normalize;
      pos = savedPos();
      dock.sync();
      layout();
    });

    function layout() {
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      fab.hidden = dock.docked;
      header.style.cursor = dock.docked ? 'default' : '';
      if (!dock.docked) {
        pos.x = Math.min(Math.max(pos.x, 4), vw - FAB - 4);
        pos.y = Math.min(Math.max(pos.y, 4), vh - FAB - 4);
        fab.style.left = pos.x + 'px';
        fab.style.top = pos.y + 'px';
      }
      if (panel.hidden) return;
      const ph = panel.offsetHeight;
      if (dock.docked) {
        // Na barra do Meet: abre acima do botão, centralizado nele, como os menus do Meet.
        const r = dock.rect();
        panel.style.top = Math.max(4, r.top - ph - 12) + 'px';
        panel.style.left = Math.min(Math.max(r.left + r.width / 2 - PANEL_W / 2, 4), vw - PANEL_W - 4) + 'px';
        return;
      }
      // Flutuante: abre acima do botão se couber; senão, abaixo. Alinhado pela esquerda.
      const above = pos.y - ph - 8;
      panel.style.top = (above >= 4 ? above : Math.min(pos.y + FAB + 8, vh - ph - 4)) + 'px';
      panel.style.left = Math.min(Math.max(pos.x, 4), vw - PANEL_W - 4) + 'px';
    }

    // Na barra do Meet o painel se comporta como os menus dele: fecha ao clicar fora.
    document.addEventListener('pointerdown', (e) => {
      if (!dock.docked || panel.hidden) return;
      const path = e.composedPath();
      if (path.includes(host) || path.includes(dock.host)) return;
      togglePanel();
    }, true);

    // Procura a barra periodicamente: ela só existe dentro da chamada e o Meet a recria.
    setInterval(() => { if (dock.sync()) layout(); }, 1000);
    dock.sync();

    function draggable(handle, onClick) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (dock.docked && handle === header) return; // na barra, o painel fica preso ao botão
        const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y;
        let moved = false;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          fab.classList.add('dragging');
          pos.x = ox + dx;
          pos.y = oy + dy;
          layout();
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          fab.classList.remove('dragging');
          if (moved) {
            store.ui = { x: Math.round(pos.x), y: Math.round(pos.y) };
            saveStore();
          } else if (onClick) {
            onClick();
          }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    }

    draggable(fab, togglePanel);
    draggable(header);
    window.addEventListener('resize', layout);
    layout();

    // ---- lista: quem falou por último no topo; esconde quem saiu
    const rows = new Map();
    let interacting = false; // não reordena enquanto o usuário mexe na lista
    list.addEventListener('pointerenter', () => { interacting = true; });
    list.addEventListener('pointerleave', () => { interacting = false; });
    list.addEventListener('focusin', () => { interacting = true; });
    list.addEventListener('focusout', () => { interacting = false; });
    let lastOrder = '';
    let lastReorder = 0;

    function visible(v, now, pids) {
      if (showAll) return true;
      if (!v.lastActive) return false; // nunca falou: canal vazio/ruído
      if (now - v.lastActive > HIDE_SILENT_MS) return false;
      if (v.pid && !pids.has(v.pid) && now - v.lastActive > HIDE_GONE_MS) return false;
      return true;
    }

    function render() {
      const now = performance.now();
      const pids = new Set();
      for (const el of document.querySelectorAll('[data-participant-id]')) pids.add(el.getAttribute('data-participant-id'));

      let shown = 0;
      for (const v of voices.values()) {
        let r = rows.get(v.id);
        if (!r) {
          r = buildRow(v, datalistId);
          rows.set(v.id, r);
          list.append(r.row);
        }
        if (v.dirty) { v.dirty = false; r.refresh(); }
        r.dot.classList.toggle('on', now - v.lastActive < ACTIVE_MS);
        r.row.hidden = !visible(v, now, pids);
        if (!r.row.hidden) shown++;
      }

      if (!interacting && now - lastReorder > 1000) {
        lastReorder = now;
        const sorted = [...voices.values()].sort((a, b) => b.lastActive - a.lastActive);
        const order = sorted.map((v) => v.id).join();
        if (order !== lastOrder) {
          lastOrder = order;
          list.replaceChildren(...sorted.map((v) => rows.get(v.id).row));
        }
      }

      const hiddenCount = voices.size - shown;
      empty.hidden = shown > 0;
      more.hidden = !showAll && hiddenCount === 0;
      more.textContent = showAll ? 'Esconder inativos' : `Mostrar todos (${hiddenCount} ocultos)`;

      const names = new Set();
      for (const pid of pids) {
        const n = tileName(pid);
        if (n) names.add(n);
      }
      for (const p of Object.values(store.people)) names.add(p.name);
      datalist.replaceChildren(...[...names].map((n) => h('option', { value: n })));
    }

    setInterval(() => { if (!panel.hidden) { render(); layout(); } }, 250);

    // ---- nunca cobrir menus e janelas do Meet
    // Nossa UI fica no z-index máximo para não sumir atrás dos vídeos. Quando o Meet
    // abre um menu/diálogo (identificado pelo papel de acessibilidade, que é estável)
    // e ele encosta em algo nosso, escondemos só o que está por cima até ele fechar.
    const MEET_POPUPS = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

    function yieldToMeetPopups() {
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      const popups = [];
      for (const el of document.querySelectorAll(MEET_POPUPS)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.width >= vw * 0.95 && r.height >= vh * 0.95) continue; // contêiner de página, não um menu
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
        popups.push(r);
      }
      for (const el of [fab, panel, tile.el]) {
        if (el.hidden) { el.classList.remove('behind'); continue; }
        const r = el.getBoundingClientRect();
        el.classList.toggle('behind', popups.some((p) => overlaps(r, p)));
      }
      // O painel e o botão também têm prioridade sobre o controle do quadro.
      if (!tile.el.hidden) {
        const r = tile.el.getBoundingClientRect();
        const mine = [fab, panel].filter((el) => !el.hidden).map((el) => el.getBoundingClientRect());
        if (mine.some((m) => overlaps(r, m))) tile.el.classList.add('behind');
      }
    }
    setInterval(yieldToMeetPopups, 150);

    // ---- avisos
    const warned = new Set();
    setInterval(() => {
      const issues = health();
      fab.classList.toggle('alert', issues.some((i) => i.level === 'error'));
      dock.setAlert(issues.some((i) => i.level === 'error'));
      warnings.replaceChildren(...issues.map((i) => h('div', { className: `warn ${i.level}`, textContent: i.text })));
      for (const i of issues) {
        // console.info (e não warn): avisos já aparecem no painel, e console.warn de
        // content script vira "erro" na página chrome://extensions.
        if (!warned.has(i.text)) { warned.add(i.text); console.info(LOG, i.text); }
      }
    }, 1000);

    // ---- controle ao passar o mouse sobre o quadro de alguém
    let frame = 0, lastEvent = null, lastPath = [], hideTimer = 0;
    document.addEventListener('pointermove', (e) => {
      lastEvent = e;
      lastPath = e.composedPath(); // só existe durante o evento; no rAF já vem vazio
      if (!frame) frame = requestAnimationFrame(onHover);
    }, { capture: true, passive: true });

    function onHover() {
      frame = 0;
      const e = lastEvent;
      const path = lastPath;
      if (path.includes(tile.el)) { clearTimeout(hideTimer); return; }
      // Sobre o painel ou o botão: o controle do quadro não pode ficar por cima deles.
      if (path.includes(host)) { clearTimeout(hideTimer); tile.hide(); return; }
      const t = findTile(e);
      const avoid = [fab, panel].filter((el) => !el.hidden).map((el) => el.getBoundingClientRect());
      if (t && tile.showFor(t, avoid)) clearTimeout(hideTimer);
      else { clearTimeout(hideTimer); hideTimer = setTimeout(tile.hide, 400); }
    }
  }

  // Quadro (o elemento mais externo com [data-participant-id]) sob o ponteiro.
  function findTile(e) {
    let t = e.target instanceof Element ? e.target.closest('[data-participant-id]') : null;
    if (!t) {
      // Camadas transparentes do Meet podem ficar por cima do vídeo.
      t = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.matches('[data-participant-id]')) || null;
    }
    if (!t) return null;
    const pid = t.getAttribute('data-participant-id');
    for (let p = t.parentElement?.closest('[data-participant-id]'); p && p.getAttribute('data-participant-id') === pid;
      p = p.parentElement?.closest('[data-participant-id]')) t = p;
    return t;
  }

  // ---------------------------------------------------------------- botão na barra do Meet
  // As classes do Meet são embaralhadas e mudam a cada versão, então a barra é
  // encontrada pela aparência: o botão de sair da chamada é o único botão largo e
  // vermelho no rodapé, e a barra é o menor ancestral dele com vários botões.
  //
  // NÃO inserimos nada dentro da barra: o Meet redesenha os filhos dela e um elemento
  // estranho ali fez o grupo do microfone sumir. Em vez disso, a barra ganha um recuo
  // à esquerda (regra CSS via atributo data-*, sem tocar nos filhos nem no style dela)
  // e o nosso botão fica por cima, em position: fixed, ocupando esse recuo.
  const isVisible = (r) => r.width > 0 && r.height > 0;
  const rgb = (c) => (c.match(/\d+(\.\d+)?/g) || []).map(Number);
  const BAR_ATTR = 'data-meet-volume-bar';

  function looksRed(el) {
    for (const e of [el, ...el.querySelectorAll('*')].slice(0, 6)) {
      const [r, g, b, a = 1] = rgb(getComputedStyle(e).backgroundColor);
      if (a > 0.5 && r > 180 && g < 100 && b < 100) return true;
    }
    return false;
  }

  function findMeetBar() {
    const vh = document.documentElement.clientHeight;
    let leave = null;
    for (const b of document.querySelectorAll('button')) {
      if (b.closest('#meet-volume-root, #meet-volume-dock')) continue;
      const r = b.getBoundingClientRect();
      if (!isVisible(r) || r.top < vh - 200 || r.height < 28 || r.width < r.height * 1.3) continue;
      if (looksRed(b)) { leave = b; break; }
    }
    if (!leave) return null;

    let bar = leave.parentElement;
    const countButtons = (el) => [...el.querySelectorAll('button')].filter((b) => isVisible(b.getBoundingClientRect())).length;
    while (bar && bar !== document.body && countButtons(bar) < 5) bar = bar.parentElement;
    if (!bar || bar === document.body || bar.getBoundingClientRect().height > 160) return null;

    // Visual de referência: tamanho e formato de um botão redondo da barra; cor só
    // se for escura e neutra (cinza). Botões em estado especial (microfone/câmera
    // desligados ficam rosa) nunca servem de cor. A cor pode estar num elemento
    // interno ou num ::before, não no <button>.
    const styles = new Map();
    let shape = null;
    for (const b of bar.querySelectorAll('button')) {
      const r = b.getBoundingClientRect();
      if (!isVisible(r) || Math.abs(r.width - r.height) > 2 || r.width < 32 || looksRed(b)) continue;
      const cs = getComputedStyle(b);
      shape ??= { w: r.width, h: r.height, radius: cs.borderRadius };
      const bg = neutralBackground(b);
      if (!bg) continue;
      const entry = styles.get(bg) || { n: 0, bg, fg: isNeutral(cs.color, 150) ? cs.color : NEUTRAL.fg };
      entry.n++;
      styles.set(bg, entry);
    }
    const color = [...styles.values()].sort((a, b) => b.n - a.n)[0] || NEUTRAL;
    const ref = shape ? { ...shape, bg: color.bg, fg: color.fg } : null;
    return { bar, ref };
  }

  // Cinza dos botões do Meet no tema escuro, usado quando não dá para ler da página.
  const NEUTRAL = { bg: 'rgb(51, 53, 55)', fg: 'rgb(227, 227, 227)' };

  // Cor sem saturação (cinza). minBright: exige claro (ícone); senão exige escuro (fundo).
  function isNeutral(color, minBright) {
    const [r, g, b, a = 1] = rgb(color);
    if (a < 0.3 || Math.max(r, g, b) - Math.min(r, g, b) > 24) return false;
    return minBright ? Math.min(r, g, b) >= minBright : Math.max(r, g, b) <= 120;
  }

  function neutralBackground(button) {
    const els = [button, ...button.querySelectorAll('*')].slice(0, 5);
    for (const el of els) {
      for (const pseudo of [null, '::before', '::after']) {
        const bg = getComputedStyle(el, pseudo).backgroundColor;
        const [, , , a = 1] = rgb(bg);
        if (a < 0.3) continue;
        return isNeutral(bg) ? bg : null; // primeira cor opaca decide (rosa → descarta)
      }
    }
    return null;
  }

  // Para o diagnóstico: a barra, seus ancestrais (onde costuma estar o fundo
  // arredondado) e seus filhos, com posição e estilos que afetam o layout.
  function describeBar() {
    const found = findMeetBar();
    if (!found) return null;
    const desc = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        rect: [r.left, r.top, r.width, r.height].map(Math.round),
        bg: cs.backgroundColor, radius: cs.borderRadius, display: cs.display, position: cs.position,
        padL: cs.paddingLeft, width: cs.width, inlineWidth: el.style.width || null, overflow: cs.overflow,
        justify: cs.justifyContent, kids: el.children.length, marked: el.hasAttribute(BAR_ATTR),
      };
    };
    const ancestors = [];
    for (let el = found.bar.parentElement, i = 0; el && el !== document.body && i < 6; el = el.parentElement, i++) ancestors.push(desc(el));
    const dockBtn = document.getElementById('meet-volume-dock')?.shadowRoot?.querySelector('button');
    const d = dockBtn?.getBoundingClientRect();
    return {
      bar: desc(found.bar),
      children: [...found.bar.children].map(desc),
      ancestors,
      dockButton: d ? [d.left, d.top, d.width, d.height].map(Math.round) : null,
    };
  }

  // Filho da barra mais à esquerda (o grupo do microfone) e o espaço entre os grupos.
  function barLayout(bar) {
    const kids = [...bar.children].map((c) => ({ c, r: c.getBoundingClientRect() }))
      .filter((k) => isVisible(k.r)).sort((a, b) => a.r.left - b.r.left);
    if (!kids.length) return null;
    const gap = kids.length > 1 ? kids[1].r.left - kids[0].r.right : 8;
    return { first: kids[0].r, gap: Math.min(Math.max(gap, 4), 24) };
  }

  function buildDock(onClick) {
    const host = document.createElement('div');
    host.id = 'meet-volume-dock';
    const root = host.attachShadow({ mode: 'open' });
    root.append(h('style', { textContent: `
      :host { position: fixed; z-index: 2147483646; display: none; }
      :host(.on) { display: block; }
      button {
        position: relative; display: grid; place-items: center; padding: 0; border: none; cursor: pointer;
        width: var(--w, 48px); height: var(--h, 48px); border-radius: var(--r, 50%);
        background: var(--bg, #3c4043); color: var(--fg, #e8eaed); transition: filter .15s, background .15s;
      }
      button:hover { filter: brightness(1.18); }
      button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
      button.active { background: #8ab4f8; color: #202124; }
      button.alert::after {
        content: ''; position: absolute; top: 4px; right: 4px; width: 9px; height: 9px;
        border-radius: 50%; background: #ea4335; border: 2px solid var(--bg, #3c4043);
      }
    ` }));
    const btn = h('button', { title: 'Volume individual', ariaLabel: 'Volume individual', onclick: onClick }, icon('volumeUp', 24));
    root.append(btn);
    document.documentElement.append(host);

    // Regra que abre o espaço na barra. Fica no <head> da página (fora do shadow DOM).
    const rule = document.createElement('style');
    rule.id = 'meet-volume-bar-style';

    let bar = null, w = 48, frame = 0;

    function release() {
      if (bar) bar.removeAttribute(BAR_ATTR);
      bar = null;
      rule.textContent = '';
      host.classList.remove('on');
    }

    // Reposiciona o botão sobre o recuo a cada quadro (a barra anima e muda de lugar).
    function place() {
      frame = 0;
      if (!dock.docked || !bar || !bar.isConnected) return;
      const lay = barLayout(bar);
      if (lay) {
        host.style.left = Math.round(lay.first.left - lay.gap - w) + 'px';
        host.style.top = Math.round(lay.first.top + lay.first.height / 2 - btn.offsetHeight / 2) + 'px';
      }
      frame = requestAnimationFrame(place);
    }

    const dock = {
      host,
      docked: false,
      rect: () => btn.getBoundingClientRect(),
      setActive: (on) => btn.classList.toggle('active', on),
      setAlert: (on) => btn.classList.toggle('alert', on),
      // Encaixa (ou mantém encaixado) na barra. Devolve true se o estado mudou.
      sync() {
        const was = dock.docked;
        const found = store.dock !== false ? findMeetBar() : null;
        if (!found) {
          release();
          dock.docked = false;
          return was !== dock.docked;
        }
        if (found.bar !== bar) { release(); bar = found.bar; }
        const { ref } = found;
        if (ref) {
          w = Math.round(ref.w);
          host.style.setProperty('--w', w + 'px');
          host.style.setProperty('--h', Math.round(ref.h) + 'px');
          host.style.setProperty('--r', ref.radius);
          host.style.setProperty('--bg', ref.bg);
          host.style.setProperty('--fg', ref.fg);
        }
        const lay = barLayout(bar);
        if (!bar.hasAttribute(BAR_ATTR)) {
          // Recuo = recuo original + nosso botão + o espaço entre grupos.
          const pad = parseFloat(getComputedStyle(bar).paddingLeft) || 0;
          bar.setAttribute(BAR_ATTR, '');
          rule.textContent = `[${BAR_ATTR}] { padding-left: ${Math.round(pad + w + (lay ? lay.gap : 8))}px !important; }`;
        }
        if (!rule.isConnected) (document.head || document.documentElement).append(rule);
        host.classList.add('on');
        dock.docked = true;
        if (!frame) frame = requestAnimationFrame(place);
        return was !== dock.docked;
      },
    };
    return dock;
  }

  function buildTileControl() {
    const name = h('div', { className: 'name' });
    const sub = h('div', { className: 'sub' });
    let current = null; // nome da pessoa no quadro
    const vol = slider(1, (x) => current && setPerson(current, { volume: x }));
    const mute = h('button', {
      className: 'mute', title: 'Silenciar',
      onclick: () => {
        if (!current) return;
        setPerson(current, { muted: !(personOf(current)?.muted) });
        refresh();
      },
    });
    vol.el.prepend(mute);
    const el = h('div', { className: 'tile', hidden: true }, name, sub, vol.el);

    // force: trocou de pessoa. O slider pode estar com foco desde o último ajuste
    // (de outra pessoa); sem forçar, ele continuaria mostrando aquele valor.
    function refresh(force = false) {
      const p = personOf(current) || { volume: 1, muted: false };
      if (force || el.getRootNode().activeElement !== vol.range) vol.set(p.volume);
      setMuteIcon(mute, p.muted);
      const key = nameKey(current);
      const heard = [...voices.values()].some((v) => v.name.trim() && nameKey(v.name) === key);
      sub.textContent = heard ? '' : 'Voz ainda não identificada — o volume vale quando for.';
      sub.hidden = heard;
    }

    // avoid: retângulos que o controle não pode cobrir (painel e botão da extensão).
    function showFor(tileEl, avoid = []) {
      const n = tileName(tileEl.getAttribute('data-participant-id'));
      if (!n) return false;
      const changed = n !== current || el.hidden;
      if (changed && el.getRootNode().activeElement === vol.range) vol.range.blur();
      current = n;
      name.textContent = n;
      refresh(changed);
      el.hidden = false;

      const r = tileEl.getBoundingClientRect();
      // Quadro grande (vídeo): o controle fica dentro dele, encolhendo se preciso.
      const inside = r.width >= 176 && r.height >= 96;
      el.style.width = (inside ? Math.min(220, r.width - 16) : 220) + 'px';
      const w = el.offsetWidth, hgt = el.offsetHeight;
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      const clamp = ([x, y]) => [Math.min(Math.max(x, 4), vw - w - 4), Math.min(Math.max(y, 4), vh - hgt - 4)];

      // Posições possíveis em ordem de preferência; fica na primeira livre.
      const spots = inside
        ? [[r.left + 8, r.top + 8], [r.right - w - 8, r.top + 8], [r.left + 8, r.bottom - hgt - 8], [r.right - w - 8, r.bottom - hgt - 8]]
        : [[r.left - w - 8, r.top + (r.height - hgt) / 2], [r.right + 8, r.top + (r.height - hgt) / 2]]; // item pequeno (lista de pessoas)
      const free = spots.map(clamp).find(([x, y]) =>
        !avoid.some((a) => x < a.right && a.left < x + w && y < a.bottom && a.top < y + hgt));
      if (!free) { el.hidden = true; return false; }

      el.style.left = free[0] + 'px';
      el.style.top = free[1] + 'px';
      return true;
    }

    return { el, showFor, hide: () => { el.hidden = true; } };
  }

  function start() {
    watchTiles();
    setInterval(learn, LEARN_MS);
    mountUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
