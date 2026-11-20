/* =========================================================
   COLLATZ CORAL — 콜라츠 수열 나무
   어떤 수 n 에서 시작해 짝수면 n/2, 홀수면 3n+1 을 반복하면 1 에 도착한다.
   그 길을 1 에서부터 거꾸로 걸으며, 짝수를 만나면 evenAng, 홀수를 만나면 oddAng 만큼 꺾어 그린다.
   같은 수를 지나는 길은 같은 줄기를 쓰므로, 각 수(마디)는 딱 한 번만 그린다.

   자라는 방식
   · 수마다 뻗기: 2, 3, 4… 를 차례로 추가하고, 새 가지는 이미 있는 줄기에서 끝까지 뻗어 나감
   · 뿌리부터 다 같이: 나무 전체를 먼저 계산해 두고, 1 에서 가까운 마디부터 모든 가지가 동시에 자람
   · 바로 생기기: 계산되는 즉시 나타남
   자라는 중인 가지 끝은 길이 0 에서 부드럽게 늘어난다.
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
  let growMode = ['tips', 'root', 'instant'].includes(params.get('grow')) ? params.get('grow') : 'tips';
  let evenAng = numParam('ea', 8), oddAng = numParam('oa', -16);
  let maxN = 10000;
  let nextStart = 1;                // 다음에 추가할 시작 수
  let playing = true, speedVal = 30, acc = 0, showPath = true;

  function numParam(k, d) { const v = parseFloat(params.get(k)); return Number.isFinite(v) ? Math.max(-30, Math.min(30, v)) : d; }

  // ---------------------------------------------------------
  // 나무 (마디 = 수 하나)
  // ---------------------------------------------------------
  let cap = 1 << 15;
  let nx, ny, nh, nd, npar, nval, nstart, nseg, vis;
  let count = 0;
  const index = new Map();          // 수 → 마디 번호
  function alloc() {
    nx = new Float64Array(cap); ny = new Float64Array(cap); nh = new Float64Array(cap);
    nd = new Int32Array(cap); npar = new Int32Array(cap); nval = new Float64Array(cap);
    nstart = new Int32Array(cap); nseg = new Int32Array(cap); vis = new Uint8Array(cap);
  }
  function grow() {
    const old = { nx, ny, nh, nd, npar, nval, nstart, nseg, vis };
    cap *= 2; alloc();
    nx.set(old.nx); ny.set(old.ny); nh.set(old.nh); nd.set(old.nd);
    npar.set(old.npar); nval.set(old.nval); nstart.set(old.nstart); nseg.set(old.nseg); vis.set(old.vis);
  }
  alloc();

  const rad = (deg) => deg * Math.PI / 180;

  function nodeColor(i) {
    if (colorMode === 'depth') return Math.floor(((nd[i] % DEPTH_CYCLE) / DEPTH_CYCLE) * K) % K;
    if (colorMode === 'start') return Math.floor(((Math.log2(nstart[i]) / 20) % 1) * K) % K;
    const p = npar[i];
    return color.zoneAt((nx[i] + nx[p]) / 2, (ny[i] + ny[p]) / 2);
  }

  // 마디 i 의 위치·방향을 부모로부터 계산 (그리지는 않음)
  function layoutNode(i) {
    const p = npar[i];
    const h = nh[p] + rad(nval[i] % 2 === 0 ? evenAng : oddAng);
    nh[i] = h;
    nx[i] = nx[p] + Math.sin(h) * STEP;
    ny[i] = ny[p] - Math.cos(h) * STEP;
    nd[i] = nd[p] + 1;
  }
  // 다 자란 마디를 그림에 넣음
  function showNode(i) {
    if (vis[i]) return;
    const p = npar[i];
    store.jumpTo(nx[p], ny[p]);
    store.push(nx[i], ny[i], nodeColor(i));
    nseg[i] = store.n - 1;
    vis[i] = 1;
    shownCount++;
  }
  let shownCount = 0;

  // 시작 수 n 하나 추가: 이미 있는 마디를 만날 때까지 따라간 뒤, 거꾸로 새 마디들을 붙임.
  // 새로 생긴 마디 번호들을 (줄기 쪽부터) 돌려줌
  const chain = [];
  function addNumber(n) {
    if (index.has(n)) return [];
    chain.length = 0;
    let v = n;
    while (!index.has(v)) { chain.push(v); v = v % 2 === 0 ? v / 2 : 3 * v + 1; }
    let parent = index.get(v);
    const made = [];
    for (let k = chain.length - 1; k >= 0; k--) {
      if (count >= cap) grow();
      const i = count++;
      nval[i] = chain[k]; npar[i] = parent; nstart[i] = n; nseg[i] = -1; vis[i] = 0;
      index.set(chain[k], i);
      layoutNode(i);
      made.push(i);
      parent = i;
    }
    return made;
  }

  // ---------------------------------------------------------
  // 자라기
  // ---------------------------------------------------------
  // (A) 수마다 뻗기: 가지 끝(tip) 하나 = 새 수 하나의 새 마디들. 앞쪽부터 차례로 자람
  let tips = [];
  let newestTip = null;
  // (B) 뿌리부터: 깊이별 묶음, 지금 자라는 깊이(front)
  let buckets = null, front = 0, maxDepth = 0, precomputing = false;
  // 지금 자라는 중인 선분 (끝이 짧게 늘어나는 중)
  let growSegs = new Float64Array(4096 * 4), growCols = new Uint8Array(4096), growN = 0;
  let lastShown = 0;                // 경로 빛내기 대상

  function pushGrow(i, f) {
    if (growN * 4 >= growSegs.length) {
      const a = new Float64Array(growSegs.length * 2); a.set(growSegs); growSegs = a;
      const c = new Uint8Array(growCols.length * 2); c.set(growCols); growCols = c;
    }
    const p = npar[i];
    const o = growN * 4;
    growSegs[o] = nx[p]; growSegs[o + 1] = ny[p];
    growSegs[o + 2] = nx[p] + (nx[i] - nx[p]) * f; growSegs[o + 3] = ny[p] + (ny[i] - ny[p]) * f;
    growCols[growN] = nodeColor(i);
    growN++;
  }

  // 속도 슬라이더 → 수/초 (A, 바로) 또는 단계/초 (B)
  const numbersPerSec = () => 0.5 * Math.pow(100000, speedVal / 100);
  const levelsPerSec = () => 0.6 * Math.pow(500, speedVal / 100);
  // 가지 끝이 자라는 속도 (마디/초): 수가 빨리 추가될수록 같이 빨라짐
  const tipSpeed = () => Math.min(4000, 18 + numbersPerSec() * 1.5);

  function stepTips(dt) {
    const sp = tipSpeed();
    const keep = [];
    for (const t of tips) {
      if (!t.started) {
        // 출발하는 줄기 마디가 아직 안 자랐으면 기다림 (허공에서 돋아나지 않게)
        const root = npar[t.nodes[0]];
        if (root > 0 && !vis[root]) { keep.push(t); continue; }
        t.started = true;
      }
      t.p += sp * dt;
      while (t.done < t.nodes.length && t.p >= t.done + 1) showNode(t.nodes[t.done++]);
      if (t.done < t.nodes.length) {
        pushGrow(t.nodes[t.done], NK.easeInOut(Math.min(1, t.p - t.done)));
        keep.push(t);
      }
      if (t === newestTip) lastShown = t.done > 0 ? t.nodes[t.done - 1] : npar[t.nodes[0]];
    }
    tips = keep;
  }

  function buildBuckets() {
    maxDepth = 0;
    for (let i = 1; i < count; i++) if (nd[i] > maxDepth) maxDepth = nd[i];
    const sizes = new Int32Array(maxDepth + 2);
    for (let i = 1; i < count; i++) sizes[nd[i]]++;
    buckets = [];
    for (let d = 0; d <= maxDepth; d++) buckets.push(new Int32Array(sizes[d]));
    const fill = new Int32Array(maxDepth + 2);
    for (let i = 1; i < count; i++) buckets[nd[i]][fill[nd[i]]++] = i;
  }

  function stepRoot(dt) {
    if (!buckets) return;
    const before = Math.floor(front);
    front = Math.min(maxDepth + 1, front + levelsPerSec() * dt);
    const full = Math.floor(front);
    for (let d = Math.max(1, before); d <= Math.min(full, maxDepth); d++) for (const i of buckets[d]) showNode(i);
    if (full + 1 <= maxDepth && full + 1 >= 1) {
      const f = NK.easeInOut(front - full);
      const b = buckets[full + 1];
      for (let k = 0; k < b.length; k++) pushGrow(b[k], f);
      if (b.length) lastShown = npar[b[b.length - 1]];
    }
  }

  // 뿌리부터 모드: 나무 전체를 몇 프레임에 나눠 미리 계산
  function precomputeStep() {
    const t0 = performance.now();
    while (nextStart <= maxN && performance.now() - t0 < 12) {
      for (let k = 0; k < 500 && nextStart <= maxN; k++) addNumber(nextStart++);
    }
    if (nextStart > maxN) { precomputing = false; buildBuckets(); front = 0; }
  }

  // ---------------------------------------------------------
  // 처음부터 / 다시 배치 / 다시 칠하기
  // ---------------------------------------------------------
  function resetTree() {
    index.clear();
    store.reset(0, 0);
    nx[0] = 0; ny[0] = 0; nh[0] = 0; nd[0] = 0; npar[0] = -1; nval[0] = 1; nstart[0] = 1; nseg[0] = -1; vis[0] = 1;
    index.set(1, 0);
    count = 1;
    shownCount = 0;
    nextStart = 2;
    tips = []; newestTip = null; buckets = null; front = 0; lastShown = 0;
    precomputing = growMode === 'root';
  }

  // 각도가 바뀜: 모든 마디 위치를 다시 계산하고, 이미 보이던 마디만 다시 그림
  function relayout() {
    for (let i = 1; i < count; i++) layoutNode(i);
    store.reset(0, 0);
    shownCount = 0;
    for (let i = 1; i < count; i++) if (vis[i]) { vis[i] = 0; showNode(i); }
    view.resetRenderer();
  }
  function recolor() {
    for (let i = 1; i < count; i++) if (vis[i]) store.cols[nseg[i]] = nodeColor(i);
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
    followPoint: () => [nx[lastShown], ny[lastShown]],
  });
  const oCtx = view.overlay.getContext('2d');
  const GPU = view.gpu;
  const growLayer = GPU ? view.glr.createSegLayer() : null;
  if (GPU) view.drawsFn = (L) => [{ layer: L }, { layer: growLayer }];

  // ---------------------------------------------------------
  // 오버레이: 자라는 가지 끝(캔버스 방식일 때), 지금 수가 1까지 가는 길
  // ---------------------------------------------------------
  function drawOverlay() {
    const W = view.W, H = view.H;
    oCtx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
    oCtx.clearRect(0, 0, W, H);
    oCtx.save();
    oCtx.lineCap = 'round'; oCtx.lineJoin = 'round';

    // GPU가 없으면 자라는 중인 선을 여기서 그림
    if (!GPU && growN) {
      oCtx.lineWidth = NK.lineStyle.core;
      for (let k = 0; k < growN; k++) {
        const [ax, ay] = view.worldToScreen(growSegs[k * 4], growSegs[k * 4 + 1]);
        const [bx, by] = view.worldToScreen(growSegs[k * 4 + 2], growSegs[k * 4 + 3]);
        oCtx.strokeStyle = color.colors[growCols[k]];
        oCtx.beginPath(); oCtx.moveTo(ax, ay); oCtx.lineTo(bx, by); oCtx.stroke();
      }
    }

    if (showPath && lastShown > 0 && growMode !== 'root') {
      const col = color.colors[nodeColor(lastShown)];
      oCtx.beginPath();
      let i = lastShown, k = 0;
      let [sx, sy] = view.worldToScreen(nx[i], ny[i]);
      // 지금 자라는 끝까지 이어서
      if (newestTip && newestTip.done < newestTip.nodes.length && growN) {
        const hd = newestTip.nodes[newestTip.done];
        const f = NK.easeInOut(Math.min(1, newestTip.p - newestTip.done));
        const [hx, hy] = view.worldToScreen(nx[npar[hd]] + (nx[hd] - nx[npar[hd]]) * f, ny[npar[hd]] + (ny[hd] - ny[npar[hd]]) * f);
        oCtx.moveTo(hx, hy); oCtx.lineTo(sx, sy);
        [sx, sy] = [hx, hy];
      } else oCtx.moveTo(sx, sy);
      while (i > 0 && k++ < 5000) {
        i = npar[i];
        const [px, py] = view.worldToScreen(nx[i], ny[i]);
        oCtx.lineTo(px, py);
      }
      oCtx.strokeStyle = col; oCtx.globalAlpha = 0.35; oCtx.lineWidth = 7; oCtx.stroke();
      oCtx.strokeStyle = '#fff'; oCtx.globalAlpha = 0.85; oCtx.lineWidth = 1.6; oCtx.stroke();
      oCtx.globalAlpha = 1;
      oCtx.shadowColor = col; oCtx.shadowBlur = 16;
      oCtx.fillStyle = '#fff';
      oCtx.beginPath(); oCtx.arc(sx, sy, 4.5, 0, Math.PI * 2); oCtx.fill();
      oCtx.shadowBlur = 0;
    }
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
    growN = 0;

    if (growMode === 'root') {
      if (precomputing) precomputeStep();
      else if (playing) stepRoot(dt);
      else if (buckets) stepRoot(0);
    } else {
      if (playing) {
        acc += numbersPerSec() * dt;
        let k = Math.min(Math.floor(acc), MAX_PER_FRAME);
        acc -= Math.floor(acc);
        // 너무 빠르면 자라는 애니메이션 없이 바로
        const instant = growMode === 'instant' || numbersPerSec() > 3000;
        while (k-- > 0 && nextStart <= maxN) {
          const n = nextStart++;
          const made = addNumber(n);
          if (!made.length) continue;
          if (instant) { for (const i of made) showNode(i); lastShown = made[made.length - 1]; newestTip = null; }
          else { const t = { nodes: made, p: 0, done: 0, started: false }; tips.push(t); newestTip = t; }
        }
        if (tips.length) stepTips(dt);
      } else if (tips.length) stepTips(0);
    }
    const finished = growMode === 'root' ? (!precomputing && front > maxDepth) : (nextStart > maxN && !tips.length);
    if (playing && finished) setPlaying(false, true);

    if (GPU) { growLayer.clear(); if (growN) growLayer.appendSegs(growSegs, growCols, growN); }
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
    const key = [lastShown, shownCount, Math.round(view.cam.s * 1000), playing, precomputing, Math.floor(front), color.paletteKey, color.seed, colorMode].join('|');
    if (key === hudKey) return;
    hudKey = key;
    if (growMode === 'root') {
      elPath.innerHTML = precomputing
        ? `나무 계산 중… ${Math.round((nextStart - 1) / maxN * 100)}%`
        : `<b style="color:${color.colors[Math.floor(((Math.min(front, maxDepth) % DEPTH_CYCLE) / DEPTH_CYCLE) * K) % K]}">${Math.min(Math.floor(front), maxDepth)}</b> / ${maxDepth}단계 <span class="steps">1에서부터 자라는 중</span>`;
    } else {
      const vals = [];
      let i = lastShown, peak = 0;
      while (i >= 0 && vals.length < 5000) { vals.push(nval[i]); peak = Math.max(peak, nval[i]); i = npar[i]; }
      const fmt = (v) => `<span class="${v % 2 === 0 ? 'even' : 'odd'}">${v.toLocaleString('ko-KR')}</span>`;
      const head = vals.slice(1, 10).map(fmt).join(' → ');
      const tail = vals.length > 13 ? ' → … → ' + vals.slice(-3).map(fmt).join(' → ') : vals.length > 10 ? ' → ' + vals.slice(10).map(fmt).join(' → ') : '';
      const n = nval[lastShown];
      elPath.innerHTML = lastShown > 0
        ? `<b style="color:${color.colors[nodeColor(lastShown)]}">${n.toLocaleString('ko-KR')}</b> : ${head}${tail}` +
          `<span class="steps">(${(vals.length - 1).toLocaleString('ko-KR')}단계, 최고 ${peak.toLocaleString('ko-KR')})</span>`
        : '';
    }
    elN.textContent = Math.max(1, Math.min(maxN, nextStart - 1)).toLocaleString('ko-KR');
    elNodes.textContent = shownCount.toLocaleString('ko-KR');
    elZoom.textContent = view.zoomLabel();
    elStatus.textContent = precomputing ? '계산 중' : (growMode === 'root' ? front > maxDepth : nextStart > maxN && !tips.length) ? '완성' : playing ? '자라는 중' : '일시정지';
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
    const finished = growMode === 'root' ? (!precomputing && front > maxDepth) : (nextStart > maxN && !tips.length);
    if (!playing && finished) { NK.toast('다 자랐어요. 시작 수 개수를 늘리거나 처음부터 해보세요'); return; }
    setPlaying(!playing);
  });
  function stepOnce() {
    setPlaying(false);
    if (growMode === 'root') {
      if (buckets && front <= maxDepth) { front = Math.floor(front) + 1; for (const i of buckets[Math.min(maxDepth, Math.floor(front))] || []) showNode(i); }
      return;
    }
    // 자라는 중인 가지는 다 자라게 하고 다음 수 하나를 바로 추가
    for (const t of tips) while (t.done < t.nodes.length) showNode(t.nodes[t.done++]);
    tips = [];
    if (nextStart <= maxN) {
      const made = addNumber(nextStart++);
      for (const i of made) showNode(i);
      if (made.length) lastShown = made[made.length - 1];
    }
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
  const speedHint = document.getElementById('speedHint');
  function updateSpeed() {
    speedVal = parseFloat(speedIn.value);
    if (growMode === 'root') {
      const v = levelsPerSec();
      speedLabel.textContent = `${v < 10 ? v.toFixed(1) : Math.round(v)} 단계/초`;
      speedHint.textContent = '1에서 한 단계씩 바깥으로, 모든 가지가 같이 자라요.';
    } else {
      const v = numbersPerSec();
      speedLabel.textContent = `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('ko-KR')} 개/초`;
      speedHint.textContent = growMode === 'tips'
        ? '수가 추가될 때마다 새 가지가 줄기에서 뻗어 나가요. 아주 빠르면(3,000개/초 이상) 바로 생겨요.'
        : '느리면 수 하나하나가 1까지 가는 길이 빛나는 게 보여요.';
    }
  }
  speedIn.addEventListener('input', updateSpeed);

  const growHint = document.getElementById('growHint');
  const GROW_HINT = {
    tips: '2, 3, 4… 순서로 수를 더하고, 새 가지가 줄기에서 끝까지 뻗어 나가요.',
    root: '나무 전체를 먼저 계산한 뒤, 1에서 가까운 곳부터 모든 가지가 동시에 자라요.',
    instant: '계산되는 즉시 가지가 나타나요.',
  };
  const setGrowSeg = NK.bindSeg(document.getElementById('growSeg'), 'grow', g => {
    if (g === growMode) return;
    growMode = g; setGrowSeg(g); growHint.textContent = GROW_HINT[g]; updateSpeed(); syncUrl(); restart();
  });

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
  let maxTimer = 0;
  maxIn.addEventListener('input', () => {
    updateMax();
    syncUrl();
    if (growMode === 'root') { clearTimeout(maxTimer); maxTimer = setTimeout(restart, 250); return; }
    if (nextStart <= maxN && !playing) setPlaying(true);
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
    NK.writeParams({ seed: color.seed, zone: color.zoneScale, pal: color.paletteKey, cm: colorMode, grow: growMode, ea: evenAng, oa: oddAng, max: maxN });
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
  setGrowSeg(growMode); growHint.textContent = GROW_HINT[growMode];
  updateMax();
  updateSpeed();
  updateCmUi();
  setCamSeg(view.camMode);
  resetTree();
  view.resetCamera(3);
  syncUrl();
  requestAnimationFrame(frame);
})();
