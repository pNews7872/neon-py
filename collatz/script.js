/* =========================================================
   COLLATZ CORAL — 콜라츠 수열 나무
   어떤 수 n 에서 시작해 짝수면 n/2, 홀수면 3n+1 을 반복하면 1 에 도착한다.
   그 길을 1 에서부터 거꾸로 걸으며, 짝수를 만나면 evenAng, 홀수를 만나면 oddAng 만큼 꺾어 그린다.
   같은 수를 지나는 길은 같은 줄기를 쓰므로, 각 수(마디)는 딱 한 번만 그린다.
   ========================================================= */
(() => {
  'use strict';
  const NK = window.NeonKit;
  const K = NK.K;

  const STEP = 10;                  // 마디 하나 길이 (월드 단위)
  const DEPTH_CYCLE = 240;          // '1에서 거리' 색칠: 이만큼 멀어지면 그라데이션 한 바퀴
  const MAX_PER_FRAME = 20000;
  const IS_MOBILE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  // ---------------------------------------------------------
  // 상태
  // ---------------------------------------------------------
  const params = NK.readParams();
  const color = new NK.ColorState(NK.colorFromParams(params));
  const store = new NK.SegStore();
  let colorMode = ['depth', 'start', 'zone'].includes(params.get('cm')) ? params.get('cm') : 'depth';
  let evenAng = numParam('ea', 8), oddAng = numParam('oa', -16);
  let maxN = 10000;
  let nextStart = 1;                // 다음에 추가할 시작 수
  let playing = true, speed = 5, acc = 0, showPath = true;

  function numParam(k, d) { const v = parseFloat(params.get(k)); return Number.isFinite(v) ? Math.max(-30, Math.min(30, v)) : d; }

  // ---------------------------------------------------------
  // 나무 (마디 = 수 하나)
  // ---------------------------------------------------------
  let cap = 1 << 15;
  let nx, ny, nh, nd, npar, nval, nstart, nseg;
  let count = 0;
  const index = new Map();          // 수 → 마디 번호
  function alloc() {
    nx = new Float64Array(cap); ny = new Float64Array(cap); nh = new Float64Array(cap);
    nd = new Int32Array(cap); npar = new Int32Array(cap); nval = new Float64Array(cap);
    nstart = new Int32Array(cap); nseg = new Int32Array(cap);
  }
  function grow() {
    const old = { nx, ny, nh, nd, npar, nval, nstart, nseg };
    cap *= 2; alloc();
    nx.set(old.nx); ny.set(old.ny); nh.set(old.nh); nd.set(old.nd);
    npar.set(old.npar); nval.set(old.nval); nstart.set(old.nstart); nseg.set(old.nseg);
  }
  alloc();

  const rad = (deg) => deg * Math.PI / 180;

  function resetTree() {
    index.clear();
    count = 0;
    store.reset(0, 0);
    // 뿌리: 1
    nx[0] = 0; ny[0] = 0; nh[0] = 0; nd[0] = 0; npar[0] = -1; nval[0] = 1; nstart[0] = 1; nseg[0] = -1;
    index.set(1, 0);
    count = 1;
    nextStart = 2;
    lastAdded = 0;
  }

  function nodeColor(i) {
    if (colorMode === 'depth') return Math.floor(((nd[i] % DEPTH_CYCLE) / DEPTH_CYCLE) * K) % K;
    if (colorMode === 'start') return Math.floor(((Math.log2(nstart[i]) / 20) % 1) * K) % K;
    const p = npar[i];
    return color.zoneAt((nx[i] + nx[p]) / 2, (ny[i] + ny[p]) / 2);
  }

  // 마디 i 의 위치·방향을 부모로부터 계산하고 선 저장
  function placeNode(i) {
    const p = npar[i];
    const h = nh[p] + rad(nval[i] % 2 === 0 ? evenAng : oddAng);
    nh[i] = h;
    nx[i] = nx[p] + Math.sin(h) * STEP;
    ny[i] = ny[p] - Math.cos(h) * STEP;
    nd[i] = nd[p] + 1;
    store.jumpTo(nx[p], ny[p]);
    store.push(nx[i], ny[i], nodeColor(i));
    nseg[i] = store.n - 1;
  }

  let lastAdded = 0;
  const chain = [];
  // 시작 수 n 하나 추가: 이미 있는 마디를 만날 때까지 따라간 뒤, 거꾸로 새 마디들을 붙임
  function addNumber(n) {
    if (index.has(n)) { lastAdded = index.get(n); return; }
    chain.length = 0;
    let v = n;
    while (!index.has(v)) { chain.push(v); v = v % 2 === 0 ? v / 2 : 3 * v + 1; }
    let parent = index.get(v);
    for (let k = chain.length - 1; k >= 0; k--) {
      if (count >= cap) grow();
      const i = count++;
      nval[i] = chain[k]; npar[i] = parent; nstart[i] = n;
      index.set(chain[k], i);
      placeNode(i);
      parent = i;
    }
    lastAdded = parent;
  }

  // 각도가 바뀜: 모든 마디 위치를 처음부터 다시 (마디가 만들어진 순서 = 부모가 먼저)
  function relayout() {
    store.reset(0, 0);
    for (let i = 1; i < count; i++) placeNode(i);
    view.resetRenderer();
  }
  function recolor() {
    for (let i = 1; i < count; i++) store.cols[nseg[i]] = nodeColor(i);
    view.sendConfig();
    view.resetRenderer();
  }

  // ---------------------------------------------------------
  // 뷰
  // ---------------------------------------------------------
  const view = new NK.NeonView({
    trail: document.getElementById('trail'),
    overlay: document.getElementById('overlay'),
    store, color,
    camMode: 'fit',
    maxFitScale: 4,
    onCamMode: m => setCamSeg(m),
    followPoint: () => [nx[lastAdded], ny[lastAdded]],
  });
  const oCtx = view.overlay.getContext('2d');
  const GPU = view.gpu;

  // ---------------------------------------------------------
  // 오버레이: 지금 수가 1까지 가는 길을 빛냄
  // ---------------------------------------------------------
  function drawOverlay() {
    const W = view.W, H = view.H;
    oCtx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
    oCtx.clearRect(0, 0, W, H);
    if (!showPath || lastAdded <= 0) return;
    const col = color.colors[nodeColor(lastAdded)];
    oCtx.save();
    oCtx.lineCap = 'round'; oCtx.lineJoin = 'round';
    oCtx.beginPath();
    let i = lastAdded, k = 0;
    let [sx, sy] = view.worldToScreen(nx[i], ny[i]);
    oCtx.moveTo(sx, sy);
    while (i > 0 && k++ < 5000) {
      i = npar[i];
      [sx, sy] = view.worldToScreen(nx[i], ny[i]);
      oCtx.lineTo(sx, sy);
    }
    oCtx.strokeStyle = col; oCtx.globalAlpha = 0.35; oCtx.lineWidth = 7; oCtx.stroke();
    oCtx.strokeStyle = '#fff'; oCtx.globalAlpha = 0.85; oCtx.lineWidth = 1.6; oCtx.stroke();
    oCtx.globalAlpha = 1;
    const [ex, ey] = view.worldToScreen(nx[lastAdded], ny[lastAdded]);
    oCtx.shadowColor = col; oCtx.shadowBlur = 16;
    oCtx.fillStyle = '#fff';
    oCtx.beginPath(); oCtx.arc(ex, ey, 4.5, 0, Math.PI * 2); oCtx.fill();
    oCtx.shadowBlur = 0;
    const [rx, ry] = view.worldToScreen(0, 0);
    oCtx.fillStyle = 'rgba(255,255,255,0.8)';
    oCtx.font = '600 12px Consolas, monospace';
    oCtx.textAlign = 'center';
    oCtx.fillText('1', rx, ry + 18);
    oCtx.restore();
  }

  // ---------------------------------------------------------
  // 메인 루프
  // ---------------------------------------------------------
  let lastT = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    if (playing) {
      acc += speed * dt;
      let k = Math.min(Math.floor(acc), MAX_PER_FRAME);
      acc -= Math.floor(acc);
      while (k-- > 0 && nextStart <= maxN) addNumber(nextStart++);
      if (nextStart > maxN) setPlaying(false, true);
    }
    view.tick(dt, now);
    drawOverlay();
    updateHud();
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------
  // HUD
  // ---------------------------------------------------------
  const elPath = document.getElementById('path');
  const elN = document.getElementById('statN');
  const elNodes = document.getElementById('statNodes');
  const elZoom = document.getElementById('statZoom');
  const elStatus = document.getElementById('statStatus');
  let hudKey = '';
  function updateHud() {
    const key = [lastAdded, count, Math.round(view.cam.s * 1000), playing, color.paletteKey, color.seed, colorMode].join('|');
    if (key === hudKey) return;
    hudKey = key;
    // 지금 수 → … → 1
    const vals = [];
    let i = lastAdded, peak = 0;
    while (i >= 0 && vals.length < 5000) { vals.push(nval[i]); peak = Math.max(peak, nval[i]); i = npar[i]; }
    const fmt = (v) => `<span class="${v % 2 === 0 ? 'even' : 'odd'}">${v.toLocaleString('ko-KR')}</span>`;
    const head = vals.slice(0, 10).map(fmt).join(' → ');
    const tail = vals.length > 13 ? ' → … → ' + vals.slice(-3).map(fmt).join(' → ') : vals.length > 10 ? ' → ' + vals.slice(10).map(fmt).join(' → ') : '';
    const n = nval[lastAdded];
    elPath.innerHTML = lastAdded > 0
      ? `<b style="color:${color.colors[nodeColor(lastAdded)]}">${n.toLocaleString('ko-KR')}</b> : ${head.replace(/^<span[^>]*>[^<]*<\/span>( → )?/, '')}${tail}` +
        `<span class="steps">(${(vals.length - 1).toLocaleString('ko-KR')}단계, 최고 ${peak.toLocaleString('ko-KR')})</span>`
      : '';
    elN.textContent = Math.max(1, nextStart - 1).toLocaleString('ko-KR');
    elNodes.textContent = (count - 1).toLocaleString('ko-KR');
    elZoom.textContent = view.zoomLabel();
    elStatus.textContent = nextStart > maxN ? '완성' : playing ? '자라는 중' : '일시정지';
  }

  // ---------------------------------------------------------
  // 컨트롤
  // ---------------------------------------------------------
  const btnPlay = document.getElementById('btnPlay');
  function setPlaying(p, done) {
    playing = p;
    btnPlay.textContent = p ? '⏸ 일시정지' : '▶ 재생';
    if (done) NK.toast(`1부터 ${maxN.toLocaleString('ko-KR')}까지 완성! 가지 ${(count - 1).toLocaleString('ko-KR')}개`);
  }
  btnPlay.addEventListener('click', () => {
    if (!playing && nextStart > maxN) { NK.toast('다 자랐어요. 시작 수 개수를 늘리거나 처음부터 해보세요'); return; }
    setPlaying(!playing);
  });
  function stepOnce() {
    setPlaying(false);
    if (nextStart <= maxN) addNumber(nextStart++);
  }
  document.getElementById('btnStep').addEventListener('click', stepOnce);

  function restart() {
    resetTree();
    acc = 0;
    view.resetCamera(3);
    if (view.camMode === 'free') view.setCamMode('fit');
    view.resetRenderer(true);
    setPlaying(true);
  }
  document.getElementById('btnReset').addEventListener('click', restart);

  const speedIn = document.getElementById('speed');
  const speedLabel = document.getElementById('speedLabel');
  function updateSpeed() {
    speed = 0.5 * Math.pow(100000, parseFloat(speedIn.value) / 100);    // 0.5 ~ 50,000 개/초
    speedLabel.textContent = `${speed < 10 ? speed.toFixed(1) : Math.round(speed).toLocaleString('ko-KR')} 개/초`;
  }
  speedIn.addEventListener('input', updateSpeed);

  // 시작 수 개수: GPU 100 ~ 1,000,000 (모바일 200,000) / 캔버스 100 ~ 50,000
  const MAX_TOP = GPU ? (IS_MOBILE ? 200000 : 1000000) : 50000;
  const maxIn = document.getElementById('maxN');
  const maxLabel = document.getElementById('maxLabel');
  function updateMax() {
    const raw = 100 * Math.pow(MAX_TOP / 100, parseFloat(maxIn.value) / 100);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
    maxN = Math.round(raw / mag) * mag;
    maxLabel.textContent = maxN.toLocaleString('ko-KR');
  }
  maxIn.addEventListener('input', () => {
    updateMax();
    if (nextStart <= maxN && !playing) setPlaying(true);
    syncUrl();
  });

  const evenIn = document.getElementById('evenAng'), oddIn = document.getElementById('oddAng');
  const evenLabel = document.getElementById('evenLabel'), oddLabel = document.getElementById('oddLabel');
  const fmtDeg = (v) => (v < 0 ? '−' + Math.abs(v) : v) + '°';
  let angTimer = 0;
  function onAngle() {
    evenLabel.textContent = fmtDeg(parseFloat(evenIn.value));
    oddLabel.textContent = fmtDeg(parseFloat(oddIn.value));
    clearTimeout(angTimer);
    angTimer = setTimeout(() => {
      evenAng = parseFloat(evenIn.value); oddAng = parseFloat(oddIn.value);
      relayout();
      if (view.camMode === 'fit') view.fitTarget(true);
      syncUrl();
    }, 60);
  }
  evenIn.addEventListener('input', onAngle);
  oddIn.addEventListener('input', onAngle);

  const cmHint = document.getElementById('colorModeHint');
  const zoneBlock = document.getElementById('zoneBlock');
  const CM_HINT = {
    depth: '1에서 몇 단계 떨어진 마디인지에 따라 색이 흘러가요.',
    start: '그 가지를 처음 만든 시작 수의 크기에 따라 색이 바뀌어요.',
    zone: '가지가 지나가는 위치의 색 구역 색으로 칠해요.',
  };
  const setCmSeg = NK.bindSeg(document.getElementById('colorModeSeg'), 'cm', cm => {
    if (cm === colorMode) return;
    colorMode = cm; updateCmUi(); recolor(); syncUrl();
  });
  function updateCmUi() {
    setCmSeg(colorMode);
    cmHint.textContent = CM_HINT[colorMode];
    zoneBlock.classList.toggle('disabled', colorMode !== 'zone');
  }

  const setCamSeg = NK.bindSeg(document.getElementById('camSeg'), 'cam', m => view.setCamMode(m));

  const colorUi = NK.bindColorControls(color, {
    palette: 'paletteSel', gradBar: 'gradBar', zone: 'zoneSize', zoneLabel: 'zoneLabel',
    seed: 'seedInput', reseed: 'btnReseed',
  }, () => { recolor(); syncUrl(); });

  document.getElementById('chkPath').addEventListener('change', e => { showPath = e.target.checked; });
  NK.bindPanelToggle();

  function syncUrl() {
    NK.writeParams({ seed: color.seed, zone: color.zoneScale, pal: color.paletteKey, cm: colorMode, ea: evenAng, oa: oddAng, max: maxN });
  }

  window.addEventListener('keydown', e => {
    if (NK.isTyping(e)) return;
    switch (e.key) {
      case ' ': e.preventDefault(); btnPlay.click(); break;
      case 'ArrowRight': e.preventDefault(); stepOnce(); break;
      case 'r': case 'R': restart(); break;
      case 'f': case 'F': view.setCamMode('follow'); break;
      case 'a': case 'A': view.setCamMode('fit'); break;
      case 's': case 'S': colorUi.reseed(); break;
      case '+': case '=': view.zoomAt(view.W / 2, view.H / 2, 1.25); break;
      case '-': case '_': view.zoomAt(view.W / 2, view.H / 2, 0.8); break;
    }
  });

  // ---------------------------------------------------------
  // 시작
  // ---------------------------------------------------------
  const pMax = parseInt(params.get('max'), 10);
  const startMax = Number.isFinite(pMax) ? Math.max(100, Math.min(MAX_TOP, pMax)) : 10000;
  maxIn.value = Math.log(startMax / 100) / Math.log(MAX_TOP / 100) * 100;
  evenIn.value = evenAng; oddIn.value = oddAng;
  evenLabel.textContent = fmtDeg(evenAng); oddLabel.textContent = fmtDeg(oddAng);
  updateMax();
  updateSpeed();
  updateCmUi();
  setCamSeg(view.camMode);
  resetTree();
  view.resetCamera(3);
  syncUrl();
  requestAnimationFrame(frame);
})();
