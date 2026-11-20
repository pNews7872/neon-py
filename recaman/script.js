/* =========================================================
   RECAMÁN — 레카만 수열을 반원으로 이어 그리는 네온 드로잉
   a(0) = 0
   a(n) = a(n−1) − n   (0보다 크고 아직 안 나온 숫자면)
        = a(n−1) + n   (그 밖의 경우)
   a(n−1) 에서 a(n) 까지 반원을 위·아래 번갈아 그린다.
   ========================================================= */
(() => {
  'use strict';
  const NK = window.NeonKit;
  const K = NK.K;

  const UNIT = 10;                  // 숫자 1칸 = 월드 10
  const ANIM_MAX_SPEED = 12;        // 이 속도(개/초) 이하에서는 펜이 반원을 그리는 모습을 보여줌
  const MAX_PER_FRAME = 4000;
  const ORDER_CYCLE = 420;          // '순서' 색칠: 이만큼 지나면 그라데이션 한 바퀴

  // ---------------------------------------------------------
  // 상태
  // ---------------------------------------------------------
  const params = NK.readParams();
  const color = new NK.ColorState(NK.colorFromParams(params));
  const store = new NK.SegStore();
  let colorMode = ['order', 'dir', 'zone'].includes(params.get('cm')) ? params.get('cm') : 'order';
  let maxN = 3000;
  let playing = true;
  let speed = 2;
  let acc = 0;
  let showAxis = true, showPen = true;

  // 수열
  let seq = [0];                     // a(0..n)
  let seen = new Uint8Array(1024);   // 나온 숫자 표시
  seen[0] = 1;
  let dirs = [0];                    // 각 n의 방향 (−1 뒤로, +1 앞으로)
  let maxVal = 0;

  function markSeen(v) {
    if (v >= seen.length) {
      let n = seen.length; while (n <= v) n *= 2;
      const s2 = new Uint8Array(n); s2.set(seen); seen = s2;
    }
    seen[v] = 1;
  }
  const isSeen = v => v < seen.length && seen[v] === 1;

  // 다음 항 계산 (기록은 하지 않음)
  function nextTerm() {
    const n = seq.length;
    const p = seq[n - 1];
    const back = p - n;
    if (back > 0 && !isSeen(back)) return { n, p, v: back, dir: -1, reason: 'ok' };
    return { n, p, v: p + n, dir: +1, reason: back <= 0 ? 'neg' : 'seen', back };
  }

  // ---------------------------------------------------------
  // 반원 모양
  // ---------------------------------------------------------
  // 홀수 번째는 위, 짝수 번째는 아래 (화면 위쪽 = y 음수)
  const sideOf = n => (n % 2 === 1 ? -1 : 1);
  function arcPoint(p, v, n, t) {
    const x0 = p * UNIT, x1 = v * UNIT;
    const cx = (x0 + x1) / 2, r = Math.abs(x1 - x0) / 2, d = Math.sign(x1 - x0);
    const a = Math.PI * t;
    return [cx - d * r * Math.cos(a), sideOf(n) * r * Math.sin(a)];
  }
  // 반원을 몇 조각으로 나눌지 (크면 더 잘게)
  const arcSegments = (p, v) => Math.max(10, Math.min(160, Math.ceil(Math.sqrt(Math.abs(v - p) * UNIT) * 3)));

  function arcColor(n, dir, x0, y0, x1, y1) {
    if (colorMode === 'order') return Math.floor(((n % ORDER_CYCLE) / ORDER_CYCLE) * K) % K;
    if (colorMode === 'dir') {
      // 뒤로 = 팔레트 앞쪽, 앞으로 = 팔레트 반대쪽 (둘 다 순서에 따라 살짝 흐름)
      const base = dir < 0 ? 0.12 : 0.62;
      return Math.floor(((base + (n % 600) / 600 * 0.18) % 1) * K) % K;
    }
    return color.zoneAt((x0 + x1) / 2, (y0 + y1) / 2);
  }

  // 반원의 [t0, t1] 구간을 선으로 저장
  function pushArc(p, v, n, dir, t0, t1) {
    const segs = arcSegments(p, v);
    const i0 = Math.round(t0 * segs), i1 = Math.round(t1 * segs);
    for (let i = i0 + 1; i <= i1; i++) {
      const [x, y] = arcPoint(p, v, n, i / segs);
      const x0 = store.lastX, y0 = store.lastY;
      store.push(x, y, arcColor(n, dir, x0, y0, x, y));
    }
  }

  // GPU: 반원 하나를 레이어에 추가
  function gpuArc(t, tEnd) {
    const [ax, ay] = apex(t.p, t.v, t.n);
    const c = arcColor(t.n, t.dir, ax, ay, ax, ay);
    arcLayer.push(t.p * UNIT, t.v * UNIT, sideOf(t.n), tEnd, c);
    growBounds(t.p, t.v);
    lastCol = c;
  }

  // 한 항 통째로 그리기
  function commitTerm() {
    if (seq.length > maxN) return false;
    const t = nextTerm();
    if (GPU) gpuArc(t, 1); else pushArc(t.p, t.v, t.n, t.dir, 0, 1);
    seq.push(t.v); dirs.push(t.dir); markSeen(t.v);
    if (t.v > maxVal) maxVal = t.v;
    return true;
  }

  function resetSeq() {
    seq = [0]; dirs = [0]; seen = new Uint8Array(1024); seen[0] = 1; maxVal = 0;
    store.reset(0, 0);
    anim.active = false;
    if (GPU) { arcLayer.reset(); Object.assign(arcBounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 }); }
  }

  function recolor() {
    if (GPU) {
      for (let n = 1; n < seq.length + (anim.active ? 1 : 0); n++) {
        const p = seq[n - 1], v = n < seq.length ? seq[n] : anim.v, d = n < seq.length ? dirs[n] : anim.dir;
        const [ax, ay] = apex(p, v, n);
        const c = arcColor(n, d, ax, ay, ax, ay);
        arcLayer.setColor(n - 1, c);
        lastCol = c;
      }
      view.sendConfig();
      return;
    }
    // 선 순서대로 각 선이 몇 번째 항에 속하는지 다시 계산
    let i = 0;
    const p = store.pts;
    for (let n = 1; n < seq.length && i < store.n; n++) {
      const segs = arcSegments(seq[n - 1], seq[n]);
      for (let k = 0; k < segs && i < store.n; k++, i++) {
        store.cols[i] = arcColor(n, dirs[n], p[i * 2], p[i * 2 + 1], p[i * 2 + 2], p[i * 2 + 3]);
      }
    }
    // 그리는 중인 반원 조각
    if (anim.active) {
      for (; i < store.n; i++) store.cols[i] = arcColor(anim.n, anim.dir, p[i * 2], p[i * 2 + 1], p[i * 2 + 2], p[i * 2 + 3]);
    }
    view.sendConfig();
    view.resetRenderer();
  }

  // ---------------------------------------------------------
  // 펜 애니메이션 (느린 속도일 때)
  // ---------------------------------------------------------
  const anim = { active: false, t: 0, drawnT: 0, n: 0, p: 0, v: 0, dir: 0, info: null };

  function startAnim() {
    if (seq.length > maxN) return false;
    const info = nextTerm();
    Object.assign(anim, { active: true, t: 0, drawnT: 0, n: info.n, p: info.p, v: info.v, dir: info.dir, info });
    if (GPU) gpuArc(info, 0);
    return true;
  }
  function advanceAnim(dt) {
    anim.t = Math.min(1, anim.t + dt * speed);
    const e = NK.easeInOut(anim.t);
    if (GPU) { arcLayer.setLastT(e); if (anim.t >= 1) finishAnim(); return; }
    if (e > anim.drawnT) {
      pushArc(anim.p, anim.v, anim.n, anim.dir, anim.drawnT, e);
      anim.drawnT = Math.round(e * arcSegments(anim.p, anim.v)) / arcSegments(anim.p, anim.v);
    }
    if (anim.t >= 1) finishAnim();
  }
  function finishAnim() {
    if (GPU) arcLayer.setLastT(1);
    else if (anim.drawnT < 1) pushArc(anim.p, anim.v, anim.n, anim.dir, anim.drawnT, 1);
    seq.push(anim.v); dirs.push(anim.dir); markSeen(anim.v);
    if (anim.v > maxVal) maxVal = anim.v;
    anim.active = false;
  }

  // ---------------------------------------------------------
  // 뷰
  // GPU가 되면 반원을 셰이더가 직접 그림(조각내지 않음, 아무리 확대해도 매끈).
  // 안 되면 반원을 짧은 선으로 나눠 캔버스로 그림.
  // ---------------------------------------------------------
  const arcBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const view = new NK.NeonView({
    trail: document.getElementById('trail'),
    overlay: document.getElementById('overlay'),
    store, color,
    camMode: 'fit',
    maxFitScale: 6,
    onCamMode: m => setCamSeg(m),
    followPoint: () => penPos(),
    fitBounds: () => (GPU ? arcBounds : store.bounds),
  });
  const oCtx = view.overlay.getContext('2d');
  const GPU = view.gpu;
  const arcLayer = GPU ? view.glr.createArcLayer() : null;
  if (GPU) view.drawsFn = () => [{ layer: arcLayer }];
  let lastCol = 0;

  // 펜(지금 그리고 있는 끝) 위치
  function penPos() {
    if (anim.active) return arcPoint(anim.p, anim.v, anim.n, NK.easeInOut(anim.t));
    return [seq[seq.length - 1] * UNIT, 0];
  }
  function growBounds(p, v) {
    const r = Math.abs(v - p) * UNIT / 2;
    arcBounds.maxX = Math.max(arcBounds.maxX, Math.max(p, v) * UNIT);
    arcBounds.minY = Math.min(arcBounds.minY, -r);
    arcBounds.maxY = Math.max(arcBounds.maxY, r);
  }
  // 색 구역용: 반원 꼭대기 위치
  const apex = (p, v, n) => arcPoint(p, v, n, 0.5);

  // ---------------------------------------------------------
  // 오버레이: 수직선 + 펜
  // ---------------------------------------------------------
  function drawOverlay() {
    const W = view.W, H = view.H;
    oCtx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
    oCtx.clearRect(0, 0, W, H);

    if (showAxis) {
      const [, y] = view.worldToScreen(0, 0);
      if (y > -2 && y < H + 2) {
        const [x0] = view.worldToScreen(0, 0);
        oCtx.strokeStyle = 'rgba(255,255,255,0.18)';
        oCtx.lineWidth = 1;
        oCtx.beginPath(); oCtx.moveTo(Math.max(0, x0), y); oCtx.lineTo(W, y); oCtx.stroke();
        // 눈금: 화면에서 간격이 적당한 단위로
        const pxPer = view.cam.s * UNIT;
        const step = niceStep(40 / pxPer);
        const [lw] = view.screenToWorld(0, 0), [rw] = view.screenToWorld(W, 0);
        const from = Math.max(0, Math.ceil(lw / UNIT / step) * step), to = rw / UNIT;
        oCtx.fillStyle = 'rgba(255,255,255,0.4)';
        oCtx.font = '11px Consolas, monospace';
        oCtx.textAlign = 'center';
        for (let v = from, c = 0; v <= to && c < 200; v += step, c++) {
          const [sx] = view.worldToScreen(v * UNIT, 0);
          oCtx.fillRect(sx - 0.5, y - 4, 1, 8);
          if (step * pxPer >= 36) oCtx.fillText(formatNum(v), sx, y + 18);
        }
      }
    }

    if (!showPen) return;
    const pp = GPU ? penPos() : [store.lastX, store.lastY];
    const [px, py] = view.worldToScreen(pp[0], pp[1]);
    const col = color.colors[GPU ? lastCol : store.n > 0 ? store.cols[store.n - 1] : 0];
    oCtx.save();
    oCtx.shadowColor = col; oCtx.shadowBlur = 18;
    oCtx.fillStyle = '#fff';
    oCtx.beginPath(); oCtx.arc(px, py, 5, 0, Math.PI * 2); oCtx.fill();
    oCtx.shadowBlur = 0;
    oCtx.strokeStyle = col; oCtx.lineWidth = 1.5;
    oCtx.beginPath(); oCtx.arc(px, py, 11, 0, Math.PI * 2); oCtx.stroke();
    // 느린 속도: 도착할 곳 표시
    if (anim.active) {
      const [tx, ty] = view.worldToScreen(anim.v * UNIT, 0);
      oCtx.setLineDash([3, 5]);
      oCtx.strokeStyle = 'rgba(255,255,255,0.45)';
      oCtx.beginPath(); oCtx.arc(tx, ty, 8, 0, Math.PI * 2); oCtx.stroke();
      oCtx.setLineDash([]);
      oCtx.fillStyle = 'rgba(255,255,255,0.85)';
      oCtx.font = '600 12px Consolas, monospace';
      oCtx.textAlign = 'center';
      oCtx.fillText(String(anim.v), tx, ty + (sideOf(anim.n) < 0 ? 22 : -14));
    }
    oCtx.restore();
  }
  function niceStep(min) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(min, 1e-9))));
    for (const m of [1, 2, 5, 10]) if (m * p >= min) return Math.max(1, m * p);
    return Math.max(1, 10 * p);
  }
  const formatNum = v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e4 ? (v / 1e3).toFixed(0) + 'k' : String(v);

  // ---------------------------------------------------------
  // 메인 루프
  // ---------------------------------------------------------
  let lastT = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    if (playing) {
      if (speed <= ANIM_MAX_SPEED) {
        if (!anim.active) startAnim();
        if (anim.active) advanceAnim(dt);
      } else {
        if (anim.active) finishAnim();
        acc += speed * dt;
        let k = Math.min(Math.floor(acc), MAX_PER_FRAME);
        acc -= Math.floor(acc);
        while (k-- > 0 && commitTerm()) { /* */ }
      }
      if (seq.length > maxN && !anim.active) setPlaying(false, true);
    }

    view.tick(dt, now);
    drawOverlay();
    updateHud();
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------
  // HUD
  // ---------------------------------------------------------
  const elPast = document.getElementById('seqPast');
  const elNow = document.getElementById('seqNow');
  const elRule = document.getElementById('rule');
  const elN = document.getElementById('statN');
  const elZoom = document.getElementById('statZoom');
  const elStatus = document.getElementById('statStatus');
  let hudKey = '';
  function updateHud() {
    const n = anim.active ? anim.n : seq.length - 1;
    const key = [n, anim.active, Math.round(view.cam.s * 1000), playing, color.paletteKey, color.seed, colorMode].join('|');
    if (key === hudKey) return;
    hudKey = key;
    const shown = seq.slice(Math.max(0, seq.length - 14));
    elPast.textContent = (seq.length > 14 ? '… ' : '') + (anim.active ? shown.join(', ') + ',' : shown.slice(0, -1).join(', ') + (shown.length > 1 ? ',' : ''));
    elNow.textContent = anim.active ? '?' : String(seq[seq.length - 1]);
    elNow.style.color = color.colors[GPU ? lastCol : store.n > 0 ? store.cols[store.n - 1] : 0];

    // 규칙 설명
    const info = anim.active ? anim.info : (seq.length > 1 ? lastInfo() : null);
    if (info) {
      const back = info.p - info.n;
      if (info.dir < 0) {
        elRule.innerHTML = `n=${info.n}: <span class="r-back">${info.p} − ${info.n} = ${info.v} ← 뒤로</span>`;
      } else {
        const why = info.reason === 'neg' ? '0 이하' : '이미 나옴';
        elRule.innerHTML = `n=${info.n}: <span class="r-no">${info.p} − ${info.n} = ${back}</span> (${why}) → <span class="r-fwd">${info.p} + ${info.n} = ${info.v} 앞으로 →</span>`;
      }
    } else elRule.textContent = '';

    elN.textContent = n.toLocaleString('ko-KR');
    elZoom.textContent = view.zoomLabel();
    elStatus.textContent = seq.length > maxN && !anim.active ? '완성' : playing ? '그리는 중' : '일시정지';
  }
  function lastInfo() {
    const n = seq.length - 1, p = seq[n - 1], v = seq[n];
    const back = p - n;
    return { n, p, v, dir: dirs[n], reason: back <= 0 ? 'neg' : 'seen' };
  }

  // ---------------------------------------------------------
  // 컨트롤
  // ---------------------------------------------------------
  const btnPlay = document.getElementById('btnPlay');
  function setPlaying(p, done) {
    playing = p;
    btnPlay.textContent = p ? '⏸ 일시정지' : '▶ 재생';
    if (done) NK.toast(`${maxN.toLocaleString('ko-KR')}개 완성! 가장 큰 숫자 ${maxVal.toLocaleString('ko-KR')}`);
  }
  btnPlay.addEventListener('click', () => {
    if (!playing && seq.length > maxN) { NK.toast('최대 개수까지 다 그렸어요. 최대 개수를 올리거나 처음부터 해보세요'); return; }
    setPlaying(!playing);
  });

  function stepOnce() {
    setPlaying(false);
    if (anim.active) finishAnim();
    else commitTerm();
  }
  document.getElementById('btnStep').addEventListener('click', stepOnce);

  function restart() {
    resetSeq();
    acc = 0;
    view.resetCamera(4);
    if (view.camMode === 'free') view.setCamMode('fit');
    view.resetRenderer(true);
    setPlaying(true);
  }
  document.getElementById('btnReset').addEventListener('click', restart);

  const speedIn = document.getElementById('speed');
  const speedLabel = document.getElementById('speedLabel');
  function updateSpeed() {
    speed = 0.4 * Math.pow(5000, parseFloat(speedIn.value) / 100);     // 0.4 ~ 2000 개/초
    speedLabel.textContent = `${speed < 10 ? speed.toFixed(1) : Math.round(speed).toLocaleString('ko-KR')} 개/초`;
  }
  speedIn.addEventListener('input', updateSpeed);

  const maxIn = document.getElementById('maxN');
  const maxLabel = document.getElementById('maxLabel');
  function updateMax() {
    const raw = 100 * Math.pow(MAX_FACTOR, parseFloat(maxIn.value) / 100);   // GPU 100 ~ 100,000 / 캔버스 100 ~ 20,000
    maxN = raw >= 1000 ? Math.round(raw / 100) * 100 : Math.round(raw / 10) * 10;
    maxLabel.textContent = maxN.toLocaleString('ko-KR');
  }
  maxIn.addEventListener('input', () => {
    updateMax();
    if (seq.length <= maxN && !playing) setPlaying(true);
    syncUrl();
  });

  const cmHint = document.getElementById('colorModeHint');
  const zoneBlock = document.getElementById('zoneBlock');
  const CM_HINT = {
    order: '그린 순서대로 그라데이션이 흘러가요.',
    dir: '뒤로 간 반원과 앞으로 간 반원을 다른 색으로 칠해요.',
    zone: '선이 지나가는 위치의 색 구역 색으로 칠해요.',
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

  document.getElementById('chkAxis').addEventListener('change', e => { showAxis = e.target.checked; });
  document.getElementById('chkPen').addEventListener('change', e => { showPen = e.target.checked; });
  NK.bindPanelToggle();

  function syncUrl() {
    NK.writeParams({ seed: color.seed, zone: color.zoneScale, pal: color.paletteKey, cm: colorMode, max: maxN });
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
  const MAX_FACTOR = GPU ? 1000 : 200;
  const pMax = parseInt(params.get('max'), 10);
  const startMax = Number.isFinite(pMax) ? Math.max(100, Math.min(100 * MAX_FACTOR, pMax)) : 3000;
  maxIn.value = Math.log(startMax / 100) / Math.log(MAX_FACTOR) * 100;
  updateMax();
  updateSpeed();
  updateCmUi();
  setCamSeg(view.camMode);
  resetSeq();
  view.resetCamera(4);
  syncUrl();
  requestAnimationFrame(frame);
})();
