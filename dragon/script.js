/* =========================================================
   DRAGON CURVE — 지금까지 그린 선 전체를 끝점 기준으로 90° 돌려
   이어 붙이는 것을 반복해서 만드는 드래곤 커브(Heighway dragon)
   ========================================================= */
(() => {
  'use strict';
  const NK = window.NeonKit;
  const K = NK.K;

  const STEP = 10;                 // 처음 선 하나의 길이 (월드 단위)
  const MAX_DIRECT = 40000;        // 한 번에 이보다 많이 늘어나면 백그라운드 렌더에 맡김
  const GEN_COLOR_STEP = 0.13;     // 세대별 색칠: 세대마다 그라데이션에서 이동하는 양

  // ---------------------------------------------------------
  // 상태
  // ---------------------------------------------------------
  const params = NK.readParams();
  const color = new NK.ColorState(NK.colorFromParams(params));
  const store = new NK.SegStore();

  let gen = 0;                                         // 현재 세대 (선 2^gen 개)
  let maxGen = clampInt(params.get('max'), 1, 20, 16);
  let dirSign = params.get('dir') === 'ccw' ? -1 : 1;  // 1 = 시계 방향(화면 기준)
  let colorMode = ['gen', 'order', 'zone'].includes(params.get('cm')) ? params.get('cm') : 'gen';
  let playing = true;
  let duration = 1.5;                                  // 회전 한 번에 걸리는 시간(초)
  let showPivot = true;

  // 회전 애니메이션
  const anim = { active: false, t: 0, px: 0, py: 0, wait: 0 };
  // 회전이 끝난 뒤 새 버퍼가 올 때까지 90° 돌린 복사본을 대신 보여줌
  const ghost = { active: false, px: 0, py: 0, needN: 0, tint: -1 };

  function clampInt(v, lo, hi, def) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  }

  const genColor = g => Math.floor(((g * GEN_COLOR_STEP) % 1) * K) % K;
  const genOf = i => (i === 0 ? 0 : Math.floor(Math.log2(i)) + 1);

  function segColor(i, x0, y0, x1, y1) {
    if (colorMode === 'gen') return genColor(genOf(i));
    if (colorMode === 'order') return Math.min(K - 1, Math.floor((i / Math.max(1, store.n)) * K));
    return color.zoneAt((x0 + x1) / 2, (y0 + y1) / 2);
  }

  // ---------------------------------------------------------
  // 뷰
  // ---------------------------------------------------------
  const view = new NK.NeonView({
    trail: document.getElementById('trail'),
    overlay: document.getElementById('overlay'),
    store, color,
    camMode: 'fit',
    maxFitScale: 8,
    onCamMode: m => setCamSeg(m),
    followPoint: () => [store.lastX, store.lastY],
    fitBounds: () => (anim.active ? predictedBounds() : store.bounds),
  });
  const oCtx = view.overlay.getContext('2d');
  const tmp = document.createElement('canvas');
  const tmpCtx = tmp.getContext('2d');

  // ---------------------------------------------------------
  // 드래곤 커브 만들기
  // ---------------------------------------------------------
  // (x, y)를 (px, py) 기준으로 dirSign*90° 회전 (화면 좌표: y 아래 방향)
  function rot90(x, y, px, py) {
    const dx = x - px, dy = y - py;
    return [px - dy * dirSign, py + dx * dirSign];
  }

  function resetCurve() {
    store.reset(0, 0);
    store.push(STEP, 0, 0);
    store.cols[0] = segColor(0, 0, 0, STEP, 0);
    gen = 0;
    anim.active = false;
    ghost.active = false;
  }

  // 다음 세대: 기존 꼭짓점을 거꾸로 돌면서 끝점 기준 90° 회전해 이어 붙임
  function nextGeneration() {
    if (gen >= 20) return;
    const oldN = store.n;
    const px = store.lastX, py = store.lastY;
    store.ensure(oldN);
    const p = store.pts;
    for (let v = oldN - 1; v >= 0; v--) {
      const [x, y] = rot90(p[v * 2], p[v * 2 + 1], px, py);
      store.push(x, y, 0);
    }
    gen++;
    if (colorMode === 'order') {
      store.recolor(segColor);
      view.resetRenderer();
    } else {
      const q = store.pts;
      for (let i = oldN; i < store.n; i++) {
        store.cols[i] = segColor(i, q[i * 2], q[i * 2 + 1], q[i * 2 + 2], q[i * 2 + 3]);
      }
    }
    // 새 선이 많으면 워커가 다시 그려 올 때까지 돌린 복사본을 대신 보여줌
    if (colorMode === 'order' || oldN > MAX_DIRECT) {
      ghost.active = true;
      ghost.px = px; ghost.py = py;
      ghost.needN = store.n;
      ghost.tint = colorMode === 'gen' ? genColor(gen) : -1;
    }
  }

  // 같은 세대까지 처음부터 다시 만들기 (방향·색칠 방식 변경)
  function rebuild(toGen) {
    resetCurve();
    while (gen < toGen) nextGeneration();
    ghost.active = false;
    store.recolor(segColor);
    view.resetRenderer();
  }

  function recolorAll() {
    store.recolor(segColor);
    view.sendConfig();
    view.resetRenderer();
  }

  // 회전 중 화면에 맞출 범위: 지금 범위 + 90° 돌린 범위
  function predictedBounds() {
    const b = store.bounds;
    const px = anim.px, py = anim.py;
    const out = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
    for (const [x, y] of [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]]) {
      const [rx, ry] = rot90(x, y, px, py);
      if (rx < out.minX) out.minX = rx; if (rx > out.maxX) out.maxX = rx;
      if (ry < out.minY) out.minY = ry; if (ry > out.maxY) out.maxY = ry;
    }
    return out;
  }

  // 버퍼에 지금 세대가 다 그려져 있는지 (돌릴 복사본으로 쓸 수 있는지)
  const bufferReady = () => view.bufCam && !view.bufStale && view.bufUpTo >= store.n;

  function startRotation() {
    anim.active = true;
    anim.t = 0;
    anim.px = store.lastX;
    anim.py = store.lastY;
    if (view.camMode === 'fit') view.fitTarget(true, predictedBounds());
  }

  function finishRotation() {
    anim.active = false;
    nextGeneration();
    anim.wait = Math.min(0.6, duration * 0.35);
    if (gen >= maxGen) {
      setPlaying(false);
      NK.toast(`${gen}세대 완성! 선 ${store.n.toLocaleString('ko-KR')}개`);
    }
  }

  // ---------------------------------------------------------
  // 그리기: 버퍼를 회전시켜 복사본을 보여줌
  // ---------------------------------------------------------
  function drawRotatedCopy(theta, px, py, tintIdx) {
    if (!view.bufCam) return;
    const dst = view.tCtx;
    const useTint = tintIdx >= 0;
    if (useTint && (tmp.width !== view.trail.width || tmp.height !== view.trail.height)) {
      tmp.width = view.trail.width; tmp.height = view.trail.height;
    }
    const ctx = useTint ? tmpCtx : dst;
    if (useTint) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, tmp.width, tmp.height); }
    ctx.save();
    view.setWorldTransform(ctx);
    ctx.translate(px, py);
    ctx.rotate(theta);
    ctx.translate(-px, -py);
    view.applyBufferToWorld(ctx);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(view.buf, 0, 0);
    ctx.restore();
    if (useTint) {
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = color.colors[tintIdx];
      ctx.fillRect(0, 0, tmp.width, tmp.height);
      ctx.globalCompositeOperation = 'source-over';
      dst.setTransform(1, 0, 0, 1, 0, 0);
      dst.drawImage(tmp, 0, 0);
    }
  }

  function drawOverlay() {
    const W = view.W, H = view.H;
    oCtx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
    oCtx.clearRect(0, 0, W, H);
    if (!showPivot) return;

    const px = anim.active ? anim.px : store.lastX;
    const py = anim.active ? anim.py : store.lastY;
    const [cx, cy] = view.worldToScreen(px, py);
    const [sx, sy] = view.worldToScreen(0, 0);            // 곡선의 시작점
    const baseAng = Math.atan2(sy - cy, sx - cx);
    const e = anim.active ? NK.easeInOut(Math.min(1, anim.t)) : 0;
    const theta = dirSign * (Math.PI / 2) * e;
    const nextCol = colorMode === 'gen' ? color.colors[genColor(gen + 1)] : '#ffffff';
    const R = 46;

    oCtx.save();
    oCtx.lineCap = 'round';
    // 시작점까지 점선
    if (Math.hypot(sx - cx, sy - cy) > 4) {
      oCtx.setLineDash([4, 6]);
      oCtx.strokeStyle = 'rgba(255,255,255,0.28)';
      oCtx.lineWidth = 1;
      oCtx.beginPath(); oCtx.moveTo(cx, cy); oCtx.lineTo(sx, sy); oCtx.stroke();
      oCtx.setLineDash([]);
    }
    // 회전 각도 호
    if (anim.active) {
      oCtx.strokeStyle = nextCol;
      oCtx.shadowColor = nextCol;
      oCtx.shadowBlur = 10;
      oCtx.lineWidth = 2.5;
      oCtx.beginPath();
      oCtx.arc(cx, cy, R, baseAng, baseAng + theta, dirSign < 0);
      oCtx.stroke();
      const a2 = baseAng + theta;
      oCtx.lineWidth = 1.5;
      oCtx.beginPath(); oCtx.moveTo(cx, cy); oCtx.lineTo(cx + Math.cos(a2) * (R + 14), cy + Math.sin(a2) * (R + 14)); oCtx.stroke();
      oCtx.shadowBlur = 0;
      oCtx.font = '700 13px Consolas, monospace';
      oCtx.fillStyle = '#fff';
      oCtx.textAlign = 'center';
      oCtx.textBaseline = 'middle';
      const mid = baseAng + theta / 2;
      oCtx.fillText(`${Math.round(90 * e)}°`, cx + Math.cos(mid) * (R + 22), cy + Math.sin(mid) * (R + 22));
    }
    // 회전축
    oCtx.fillStyle = '#fff';
    oCtx.shadowColor = nextCol;
    oCtx.shadowBlur = 16;
    oCtx.beginPath(); oCtx.arc(cx, cy, 5, 0, Math.PI * 2); oCtx.fill();
    oCtx.shadowBlur = 0;
    oCtx.strokeStyle = 'rgba(255,255,255,0.5)';
    oCtx.lineWidth = 1;
    oCtx.beginPath(); oCtx.arc(cx, cy, 11, 0, Math.PI * 2); oCtx.stroke();
    oCtx.restore();
  }

  // ---------------------------------------------------------
  // 메인 루프
  // ---------------------------------------------------------
  let lastT = performance.now();

  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    if (ghost.active && bufferReady() && view.bufUpTo >= ghost.needN) ghost.active = false;

    if (anim.active) {
      if (playing) anim.t += dt / duration;
      if (anim.t >= 1) finishRotation();
    } else if (playing && gen < maxGen) {
      anim.wait -= dt;
      if (anim.wait <= 0 && bufferReady() && !ghost.active) startRotation();
    }

    const drawCopy = anim.active || ghost.active;
    view.tick(dt, now, { maxDirect: MAX_DIRECT, alwaysComposite: drawCopy });
    if (anim.active) {
      const e = NK.easeInOut(Math.min(1, anim.t));
      drawRotatedCopy(dirSign * (Math.PI / 2) * e, anim.px, anim.py, colorMode === 'gen' ? genColor(gen + 1) : -1);
    } else if (ghost.active) {
      drawRotatedCopy(dirSign * (Math.PI / 2), ghost.px, ghost.py, ghost.tint);
    }

    drawOverlay();
    updateHud();
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------
  // HUD
  // ---------------------------------------------------------
  const elGen = document.getElementById('genNow');
  const elGenMax = document.getElementById('genMax');
  const elSegs = document.getElementById('statSegs');
  const elZoom = document.getElementById('statZoom');
  const elStatus = document.getElementById('statStatus');
  let hudKey = '';

  function updateHud() {
    const status = anim.active ? 'rot' : gen >= maxGen ? 'done' : playing ? 'wait' : 'pause';
    const key = [gen, maxGen, store.n, Math.round(view.cam.s * 1000), status, color.paletteKey, color.seed, colorMode].join('|');
    if (key === hudKey) return;
    hudKey = key;
    elGen.textContent = gen;
    elGen.style.color = colorMode === 'gen' ? color.colors[genColor(gen)] : '#fff';
    elGenMax.textContent = maxGen;
    elSegs.textContent = store.n.toLocaleString('ko-KR');
    elZoom.textContent = view.zoomLabel();
    elStatus.textContent = {
      rot: `${gen + 1}세대로 회전 중`,
      done: '완성',
      wait: '다음 회전 준비',
      pause: '일시정지',
    }[status];
  }

  // ---------------------------------------------------------
  // 컨트롤
  // ---------------------------------------------------------
  const btnPlay = document.getElementById('btnPlay');
  function setPlaying(p) {
    playing = p;
    btnPlay.textContent = p ? '⏸ 일시정지' : '▶ 재생';
  }
  btnPlay.addEventListener('click', () => {
    if (!playing && gen >= maxGen && !anim.active) { NK.toast('최대 세대까지 다 그렸어요. 최대 세대를 올리거나 처음부터 해보세요'); return; }
    setPlaying(!playing);
  });

  function stepOnce() {
    setPlaying(false);
    if (anim.active) { finishRotation(); return; }
    if (gen >= 20) { NK.toast('20세대가 최대예요'); return; }
    if (gen >= maxGen) { maxGen = gen + 1; syncMax(); }
    anim.px = store.lastX; anim.py = store.lastY;
    nextGeneration();
    if (view.camMode === 'fit') view.fitTarget(true);
  }
  document.getElementById('btnStep').addEventListener('click', stepOnce);

  function restart() {
    resetCurve();
    view.resetCamera(4);
    if (view.camMode === 'free') view.setCamMode('fit');
    else if (view.camMode === 'fit') view.fitTarget(true);
    view.resetRenderer(true);
    anim.wait = 0.4;
    setPlaying(true);
  }
  document.getElementById('btnReset').addEventListener('click', restart);

  const durInput = document.getElementById('duration');
  const durLabel = document.getElementById('durLabel');
  function updateDuration() {
    duration = 5 * Math.pow(0.03, parseFloat(durInput.value) / 100);   // 5초 ~ 0.15초
    durLabel.textContent = duration >= 1 ? `${duration.toFixed(1)}초` : `${duration.toFixed(2)}초`;
  }
  durInput.addEventListener('input', updateDuration);

  const maxInput = document.getElementById('maxGen');
  const maxLabel = document.getElementById('maxLabel');
  function syncMax() {
    maxInput.value = maxGen;
    maxLabel.textContent = maxGen;
    syncUrl();
  }
  maxInput.addEventListener('input', () => {
    maxGen = parseInt(maxInput.value, 10);
    maxLabel.textContent = maxGen;
    if (gen > maxGen) {
      rebuild(maxGen);
      if (view.camMode === 'fit') view.fitTarget(true);
    } else if (gen < maxGen && !playing && !anim.active) {
      setPlaying(true);
    }
    syncUrl();
  });

  const setDirSeg = NK.bindSeg(document.getElementById('dirSeg'), 'dir', d => {
    const s = d === 'ccw' ? -1 : 1;
    if (s === dirSign) return;
    dirSign = s;
    setDirSeg(d);
    rebuild(gen);
    if (view.camMode === 'fit') view.fitTarget(true);
    syncUrl();
  });

  const cmHint = document.getElementById('colorModeHint');
  const zoneBlock = document.getElementById('zoneBlock');
  const CM_HINT = {
    gen: '세대마다 새로 복사된 부분이 다음 색이 돼요.',
    order: '곡선의 처음부터 끝까지 그라데이션으로 칠해요.',
    zone: '파이처럼, 선이 지나가는 위치의 색 구역 색으로 칠해요.',
  };
  function updateColorModeUi() {
    setCmSeg(colorMode);
    cmHint.textContent = CM_HINT[colorMode];
    zoneBlock.classList.toggle('disabled', colorMode !== 'zone');
  }
  const setCmSeg = NK.bindSeg(document.getElementById('colorModeSeg'), 'cm', cm => {
    if (cm === colorMode) return;
    colorMode = cm;
    updateColorModeUi();
    ghost.active = false;
    recolorAll();
    syncUrl();
  });

  const setCamSeg = NK.bindSeg(document.getElementById('camSeg'), 'cam', m => view.setCamMode(m));

  function syncUrl() {
    NK.writeParams({ seed: color.seed, zone: color.zoneScale, pal: color.paletteKey, cm: colorMode, dir: dirSign < 0 ? 'ccw' : 'cw', max: maxGen });
  }

  const colorUi = NK.bindColorControls(color, {
    palette: 'paletteSel', gradBar: 'gradBar', zone: 'zoneSize', zoneLabel: 'zoneLabel',
    seed: 'seedInput', reseed: 'btnReseed',
  }, () => {
    ghost.active = false;
    recolorAll();
    syncUrl();
  });

  document.getElementById('chkPivot').addEventListener('change', e => { showPivot = e.target.checked; });
  NK.bindPanelToggle();

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
  setDirSeg(dirSign < 0 ? 'ccw' : 'cw');
  updateColorModeUi();
  setCamSeg(view.camMode);
  syncMax();
  updateDuration();
  resetCurve();
  view.resetCamera(4);
  view.fitTarget(true);
  view.cam.x = view.target.x; view.cam.y = view.target.y; view.cam.s = view.target.s;
  anim.wait = 0.6;
  syncUrl();
  requestAnimationFrame(frame);
})();
