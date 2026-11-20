/* =========================================================
   π WALK — 원주율의 각 자릿수(0~9)를 36°씩 나눈 방향으로
   선을 이어 그리는 네온 드로잉
   ========================================================= */
(() => {
  'use strict';
  const NK = window.NeonKit;

  // ---------------------------------------------------------
  // 설정값
  // ---------------------------------------------------------
  const STEP = 10;                 // 선 하나의 길이 (월드 단위)
  const DEG_PER_DIGIT = 36;        // 360 / 10
  const ANIM_MAX_SPEED = 30;       // 이 속도(줄/초) 이하에서는 원판 애니메이션 표시
  const MAX_PER_FRAME = 60000;     // 한 프레임에 그을 수 있는 최대 줄 수
  const PI_STAGES = [2000, 20000, 200000, 1000000];
  const DISC_R = 92;               // 원판 반지름 (화면 px)
  const DISC_INNER = 58;

  // ---------------------------------------------------------
  // 원주율 계산 (Chudnovsky + binary splitting, Web Worker)
  // ---------------------------------------------------------
  function piWorkerSource() {
    const C = 640320n;
    const C3_24 = C ** 3n / 24n;
    function bs(a, b) {
      if (b - a === 1n) {
        let P, Q;
        if (a === 0n) { P = 1n; Q = 1n; }
        else { P = (6n * a - 5n) * (2n * a - 1n) * (6n * a - 1n); Q = a * a * a * C3_24; }
        let T = P * (13591409n + 545140134n * a);
        if (a & 1n) T = -T;
        return [P, Q, T];
      }
      const m = (a + b) / 2n;
      const [P1, Q1, T1] = bs(a, m);
      const [P2, Q2, T2] = bs(m, b);
      return [P1 * P2, Q1 * Q2, T1 * Q2 + P1 * T2];
    }
    function isqrt(n) {
      if (n < 2n) return n;
      let x = 1n << BigInt(Math.ceil(n.toString(16).length * 2));
      for (;;) {
        const y = (x + n / x) >> 1n;
        if (y >= x) return x;
        x = y;
      }
    }
    function pi(digits) {
      const D = digits + 20;
      const N = BigInt(Math.floor(D / 14) + 2);
      const [, Q, T] = bs(0n, N);
      const one = 10n ** BigInt(D);
      const s = isqrt(10005n * one * one);
      return ((Q * 426880n * s) / T).toString().slice(0, digits);
    }
    self.onmessage = (e) => {
      for (const n of e.data.stages) self.postMessage({ digits: pi(n), final: n === e.data.stages[e.data.stages.length - 1] });
    };
    self.__pi = pi;
  }

  let PI = '';
  let piFinal = false;

  function startPi() {
    try {
      const src = '(' + piWorkerSource.toString() + ')()';
      const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = (e) => {
        if (e.data.digits.length > PI.length) PI = e.data.digits;
        if (e.data.final) piFinal = true;
        updateStatus();
      };
      worker.onerror = () => fallbackPi();
      worker.postMessage({ stages: PI_STAGES });
    } catch (err) {
      fallbackPi();
    }
  }
  function fallbackPi() {
    if (PI.length) return;
    const prev = self.onmessage;
    piWorkerSource();
    const fn = self.__pi;
    self.onmessage = prev;
    PI = fn(20000);
    piFinal = true;
    updateStatus();
  }

  // ---------------------------------------------------------
  // 상태
  // ---------------------------------------------------------
  const params = NK.readParams();
  const color = new NK.ColorState(NK.colorFromParams(params));
  const store = new NK.SegStore();
  let mode = params.get('mode') === 'relative' ? 'relative' : 'absolute';
  let heading = 0;                 // 상대 회전 모드의 현재 방향(도)
  let lastDir = 0;                 // 마지막으로 그은 방향(도)
  let showDisc = true;

  const view = new NK.NeonView({
    trail: document.getElementById('trail'),
    overlay: document.getElementById('overlay'),
    store, color,
    camMode: 'follow',
    onCamMode: m => setCamSeg(m),
    followPoint: () => { const ps = penState(); return [ps.x, ps.y]; },
  });
  const oCtx = view.overlay.getContext('2d');

  function resetWalk() {
    store.reset();
    heading = 0; lastDir = 0;
  }

  // i번째 자릿수로 다음 선의 방향 계산
  function nextDir(i) {
    const d = PI.charCodeAt(i) - 48;
    if (mode === 'absolute') return { digit: d, dir: d * DEG_PER_DIGIT, heading: d * DEG_PER_DIGIT };
    const h = (heading + d * DEG_PER_DIGIT) % 360;
    return { digit: d, dir: h, heading: h };
  }
  function dirVec(deg) {
    const r = deg * Math.PI / 180;
    return [Math.sin(r), -Math.cos(r)];   // 0° = 위쪽, 시계방향
  }

  function commit() {
    const n = store.n;
    if (n >= PI.length) return false;
    const nd = nextDir(n);
    const [dx, dy] = dirVec(nd.dir);
    const x0 = store.lastX, y0 = store.lastY;
    const x1 = x0 + dx * STEP, y1 = y0 + dy * STEP;
    store.push(x1, y1, color.zoneAt((x0 + x1) / 2, (y0 + y1) / 2));
    heading = nd.heading;
    lastDir = nd.dir;
    return true;
  }

  // 같은 개수만큼 처음부터 다시 계산 (각도 방식을 바꿨을 때)
  function rebuild(count) {
    resetWalk();
    while (store.n < count && commit()) { /* */ }
    anim.active = false;
    view.resetRenderer();
  }

  function recolor() {
    store.recolor((i, x0, y0, x1, y1) => color.zoneAt((x0 + x1) / 2, (y0 + y1) / 2));
    if (anim.active) anim.color = color.zoneAt((anim.x0 + anim.x1) / 2, (anim.y0 + anim.y1) / 2);
    view.sendConfig();
    view.resetRenderer();
  }

  // ---------------------------------------------------------
  // 애니메이션 (한 줄 긋기: 바늘 회전 → 선 긋기)
  // ---------------------------------------------------------
  const anim = {
    active: false, t: 0,
    x0: 0, y0: 0, x1: 0, y1: 0,
    needleFrom: 0, needleTo: 0,
    rotFrom: 0, rotTo: 0,
    digit: 0, color: 0,
  };
  let playing = true;
  let speed = 2;
  let acc = 0;

  const discRotationAtRest = () => mode === 'relative' ? heading : 0;

  function startAnim() {
    const n = store.n;
    if (n >= PI.length) return false;
    const nd = nextDir(n);
    const [dx, dy] = dirVec(nd.dir);
    anim.x0 = store.lastX; anim.y0 = store.lastY;
    anim.x1 = anim.x0 + dx * STEP; anim.y1 = anim.y0 + dy * STEP;
    anim.digit = nd.digit;
    anim.color = color.zoneAt((anim.x0 + anim.x1) / 2, (anim.y0 + anim.y1) / 2);
    anim.rotFrom = discRotationAtRest();
    anim.rotTo = mode === 'relative' ? nd.heading : 0;
    anim.needleFrom = mode === 'relative' ? heading : lastDir;
    anim.needleTo = nd.dir;
    anim.t = 0;
    anim.active = true;
    return true;
  }
  function finishAnim() {
    anim.active = false;
    commit();
  }

  function lerpAngle(a, b, t) {
    const d = ((b - a) % 360 + 540) % 360 - 180;
    return a + d * t;
  }

  // 현재 펜(원판) 위치와 원판 상태
  function penState() {
    const ease = NK.easeInOut;
    if (anim.active) {
      const t = anim.t, ROT = 0.45;
      if (t < ROT) {
        const e = ease(t / ROT);
        return {
          x: anim.x0, y: anim.y0, len: 0,
          needle: lerpAngle(anim.needleFrom, anim.needleTo, e),
          rot: anim.rotFrom, digit: anim.digit, color: anim.color, highlight: e,
        };
      }
      const e = ease((t - ROT) / (1 - ROT));
      return {
        x: anim.x0 + (anim.x1 - anim.x0) * e,
        y: anim.y0 + (anim.y1 - anim.y0) * e,
        len: e,
        needle: anim.needleTo,
        rot: lerpAngle(anim.rotFrom, anim.rotTo, e),
        digit: anim.digit, color: anim.color, highlight: 1,
      };
    }
    const n = store.n;
    return {
      x: store.lastX, y: store.lastY, len: 0,
      needle: lastDir, rot: discRotationAtRest(),
      digit: n > 0 ? PI.charCodeAt(n - 1) - 48 : -1,
      color: n > 0 ? store.cols[n - 1] : color.zoneAt(0, 0), highlight: n > 0 ? 1 : 0,
    };
  }

  // ---------------------------------------------------------
  // 원판 그리기
  // ---------------------------------------------------------
  const toCanvasRad = deg => (deg - 90) * Math.PI / 180;

  function drawOverlay(ps) {
    const W = view.W, H = view.H;
    oCtx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
    oCtx.clearRect(0, 0, W, H);
    const COLORS = color.colors;

    // 긋고 있는 중인 선
    if (anim.active && ps.len > 0) {
      const [ax, ay] = view.worldToScreen(anim.x0, anim.y0);
      const [bx, by] = view.worldToScreen(ps.x, ps.y);
      oCtx.lineCap = 'round';
      oCtx.strokeStyle = COLORS[anim.color];
      oCtx.globalAlpha = 0.25; oCtx.lineWidth = 7;
      oCtx.beginPath(); oCtx.moveTo(ax, ay); oCtx.lineTo(bx, by); oCtx.stroke();
      oCtx.globalAlpha = 1; oCtx.lineWidth = 2;
      oCtx.beginPath(); oCtx.moveTo(ax, ay); oCtx.lineTo(bx, by); oCtx.stroke();
    }

    if (!showDisc) return;
    const [cx, cy] = view.worldToScreen(ps.x, ps.y);
    if (cx < -DISC_R * 2 || cy < -DISC_R * 2 || cx > W + DISC_R * 2 || cy > H + DISC_R * 2) return;
    const col = COLORS[ps.color];

    oCtx.save();
    oCtx.translate(cx, cy);

    // 링 바탕
    oCtx.beginPath();
    oCtx.arc(0, 0, DISC_R, 0, Math.PI * 2);
    oCtx.arc(0, 0, DISC_INNER, 0, Math.PI * 2, true);
    oCtx.fillStyle = 'rgba(8, 8, 18, 0.62)';
    oCtx.fill('evenodd');
    oCtx.lineWidth = 1;
    oCtx.strokeStyle = 'rgba(255,255,255,0.35)';
    oCtx.beginPath(); oCtx.arc(0, 0, DISC_R, 0, Math.PI * 2); oCtx.stroke();
    oCtx.strokeStyle = 'rgba(255,255,255,0.15)';
    oCtx.beginPath(); oCtx.arc(0, 0, DISC_INNER, 0, Math.PI * 2); oCtx.stroke();

    // 눈금 (원판 자체가 회전)
    oCtx.save();
    oCtx.rotate(ps.rot * Math.PI / 180);
    for (let i = 0; i < 360; i += 2) {
      const major = i % 36 === 0;
      const mid = i % 18 === 0;
      const len = major ? 13 : mid ? 7 : 3.5;
      const a = toCanvasRad(i);
      const c = Math.cos(a), s = Math.sin(a);
      oCtx.strokeStyle = major ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.28)';
      oCtx.lineWidth = major ? 1.6 : 1;
      oCtx.beginPath();
      oCtx.moveTo(c * DISC_R, s * DISC_R);
      oCtx.lineTo(c * (DISC_R - len), s * (DISC_R - len));
      oCtx.stroke();
    }
    // 숫자 0~9
    oCtx.textAlign = 'center';
    oCtx.textBaseline = 'middle';
    for (let d = 0; d < 10; d++) {
      const a = toCanvasRad(d * DEG_PER_DIGIT);
      const r = DISC_R - 25;
      const active = d === ps.digit;
      oCtx.save();
      oCtx.translate(Math.cos(a) * r, Math.sin(a) * r);
      oCtx.rotate(-ps.rot * Math.PI / 180);  // 글자는 똑바로
      if (active) {
        oCtx.font = '700 17px Consolas, monospace';
        oCtx.fillStyle = col;
        oCtx.shadowColor = col;
        oCtx.shadowBlur = 12 * ps.highlight;
      } else {
        oCtx.font = '500 13px Consolas, monospace';
        oCtx.fillStyle = 'rgba(255,255,255,0.55)';
      }
      oCtx.fillText(String(d), 0, 0);
      oCtx.restore();
    }
    oCtx.restore();

    // 바늘
    const na = toCanvasRad(ps.needle);
    const nx = Math.cos(na), ny = Math.sin(na);
    oCtx.lineCap = 'round';
    oCtx.strokeStyle = col;
    oCtx.shadowColor = col;
    oCtx.shadowBlur = 14;
    oCtx.lineWidth = 2.2;
    oCtx.beginPath();
    oCtx.moveTo(nx * 10, ny * 10);
    oCtx.lineTo(nx * (DISC_R + 12), ny * (DISC_R + 12));
    oCtx.stroke();
    oCtx.fillStyle = col;
    oCtx.beginPath();
    const tipR = DISC_R + 16;
    oCtx.moveTo(nx * tipR, ny * tipR);
    oCtx.lineTo(nx * (tipR - 9) - ny * 5, ny * (tipR - 9) + nx * 5);
    oCtx.lineTo(nx * (tipR - 9) + ny * 5, ny * (tipR - 9) - nx * 5);
    oCtx.closePath();
    oCtx.fill();
    oCtx.shadowBlur = 0;

    // 중심점
    oCtx.fillStyle = '#fff';
    oCtx.beginPath(); oCtx.arc(0, 0, 3, 0, Math.PI * 2); oCtx.fill();

    // 원판 아래 설명
    if (ps.digit >= 0) {
      oCtx.font = '600 12px Consolas, monospace';
      oCtx.fillStyle = 'rgba(255,255,255,0.75)';
      oCtx.textAlign = 'center';
      const deg = ps.digit * DEG_PER_DIGIT;
      const label = mode === 'relative' ? `${ps.digit} → +${deg}° 회전` : `${ps.digit} → ${deg}°`;
      oCtx.fillText(label, 0, DISC_R + 34);
    }
    oCtx.restore();
  }

  // ---------------------------------------------------------
  // 메인 루프
  // ---------------------------------------------------------
  let lastT = performance.now();

  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    if (playing && PI.length > 0) {
      if (speed <= ANIM_MAX_SPEED) {
        if (!anim.active) startAnim();
        if (anim.active) {
          anim.t += dt * speed;
          if (anim.t >= 1) finishAnim();
        }
      } else {
        if (anim.active) finishAnim();
        acc += speed * dt;
        let k = Math.min(Math.floor(acc), MAX_PER_FRAME);
        acc -= Math.floor(acc);
        while (k-- > 0 && commit()) { /* */ }
      }
    }

    view.tick(dt, now);
    drawOverlay(penState());
    updateHud();
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------
  // HUD
  // ---------------------------------------------------------
  const elPast = document.getElementById('digitsPast');
  const elNow = document.getElementById('digitNow');
  const elCount = document.getElementById('statCount');
  const elZoom = document.getElementById('statZoom');
  const elStatus = document.getElementById('statStatus');
  let hudKey = '';

  function updateHud() {
    const n = store.n;
    const idx = anim.active ? n : n - 1;   // 지금 표시할 자릿수의 위치
    const key = idx + '|' + Math.round(view.cam.s * 1000) + '|' + PI.length + '|' + color.seed + color.paletteKey;
    if (key === hudKey) return;
    hudKey = key;
    if (idx >= 0 && PI.length) {
      const from = Math.max(0, idx - 36);
      let past = PI.slice(from, idx);
      if (from === 0 && past.length) past = past[0] + '.' + past.slice(1);
      else if (from > 0) past = '…' + past;
      elPast.textContent = past;
      elNow.textContent = PI[idx];
      elNow.style.color = color.colors[anim.active ? anim.color : store.cols[idx]];
    } else {
      elPast.textContent = '';
      elNow.textContent = '';
    }
    elCount.textContent = Math.max(0, idx + 1).toLocaleString('ko-KR');
    elZoom.textContent = view.zoomLabel();
    updateStatus();
  }

  function updateStatus() {
    const n = store.n;
    if (!PI.length) { elStatus.textContent = '원주율 계산 중…'; return; }
    if (n >= PI.length && piFinal) { elStatus.textContent = `${PI.length.toLocaleString('ko-KR')}자리 끝까지 완료`; return; }
    if (n >= PI.length) { elStatus.textContent = '다음 자릿수 계산 중…'; return; }
    elStatus.textContent = `${PI.length.toLocaleString('ko-KR')}자리 준비됨` + (piFinal ? '' : ' (계산 계속 중)');
  }

  // ---------------------------------------------------------
  // 컨트롤
  // ---------------------------------------------------------
  const btnPlay = document.getElementById('btnPlay');
  const speedInput = document.getElementById('speed');
  const speedLabel = document.getElementById('speedLabel');

  function setPlaying(p) {
    playing = p;
    btnPlay.textContent = p ? '⏸ 일시정지' : '▶ 재생';
  }
  btnPlay.addEventListener('click', () => setPlaying(!playing));

  function stepOnce() {
    setPlaying(false);
    if (anim.active) finishAnim();
    else commit();
  }
  document.getElementById('btnStep').addEventListener('click', stepOnce);

  function restart() {
    resetWalk();
    anim.active = false;
    acc = 0;
    view.resetCamera(2);
    if (view.camMode === 'free') view.setCamMode('follow');
    view.resetRenderer(true);
    setPlaying(true);
  }
  document.getElementById('btnReset').addEventListener('click', restart);

  const sliderToSpeed = v => 0.5 * Math.pow(40000, v / 100);
  function updateSpeed() {
    speed = sliderToSpeed(parseFloat(speedInput.value));
    const txt = speed < 10 ? speed.toFixed(1) : Math.round(speed).toLocaleString('ko-KR');
    speedLabel.textContent = `${txt} 줄/초`;
  }
  speedInput.addEventListener('input', updateSpeed);

  const modeHint = document.getElementById('modeHint');
  const setModeSeg = NK.bindSeg(document.getElementById('modeSeg'), 'mode', m => {
    if (mode === m) return;
    mode = m;
    setModeSeg(m);
    updateModeHint();
    rebuild(store.n);
    syncUrl();
    if (view.camMode === 'fit') view.fitTarget(true);
    if (view.camMode === 'follow') view.setCamMode('follow');
    NK.toast(`${mode === 'absolute' ? '절대 방향' : '상대 회전'}으로 지금까지 그린 ${store.n.toLocaleString('ko-KR')}줄을 다시 그렸어요`);
  });
  function updateModeHint() {
    modeHint.textContent = mode === 'absolute'
      ? '숫자 n → 항상 n×36° 방향으로 긋기 (0 = 위쪽, 시계방향)'
      : '숫자 n → 지금 가던 방향에서 n×36°만큼 꺾어서 긋기 (0 = 직진)';
  }

  const setCamSeg = NK.bindSeg(document.getElementById('camSeg'), 'cam', m => view.setCamMode(m));

  function syncUrl() {
    NK.writeParams({ seed: color.seed, zone: color.zoneScale, pal: color.paletteKey, mode });
  }

  const colorUi = NK.bindColorControls(color, {
    palette: 'paletteSel', gradBar: 'gradBar', zone: 'zoneSize', zoneLabel: 'zoneLabel',
    seed: 'seedInput', reseed: 'btnReseed', zones: 'chkZones',
  }, what => {
    if (what === 'zones') { view.sendConfig(); view.rerender(); return; }
    recolor();
    syncUrl();
  });

  document.getElementById('chkDisc').addEventListener('change', e => { showDisc = e.target.checked; });
  NK.bindPanelToggle();

  // 범례: 숫자별 각도
  const legend = document.getElementById('legend');
  for (let d = 0; d < 10; d++) {
    const el = document.createElement('div');
    el.className = 'chip';
    el.innerHTML = `<b>${d}</b>${d * DEG_PER_DIGIT}°`;
    legend.appendChild(el);
  }

  window.addEventListener('keydown', e => {
    if (NK.isTyping(e)) return;
    switch (e.key) {
      case ' ': e.preventDefault(); setPlaying(!playing); break;
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
  setModeSeg(mode);
  updateModeHint();
  setCamSeg(view.camMode);
  resetWalk();
  updateSpeed();
  syncUrl();
  startPi();
  requestAnimationFrame(frame);
})();
