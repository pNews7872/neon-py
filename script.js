/* =========================================================
   π WALK — 원주율의 각 자릿수(0~9)를 36°씩 나눈 방향으로
   선을 이어 그리는 네온 드로잉
   ========================================================= */
(() => {
  'use strict';

  // ---------------------------------------------------------
  // 설정값
  // ---------------------------------------------------------
  const STEP = 10;                 // 선 하나의 길이 (월드 단위)
  const DEG_PER_DIGIT = 36;        // 360 / 10
  const ANIM_MAX_SPEED = 30;       // 이 속도(줄/초) 이하에서는 원판 애니메이션 표시
  const MAX_PER_FRAME = 60000;     // 한 프레임에 그을 수 있는 최대 줄 수
  const HEAVY = 80000;             // 이보다 줄이 많으면 화면 이동 중엔 미리보기로 처리
  const PI_STAGES = [2000, 20000, 200000, 1000000];
  const DISC_R = 92;               // 원판 반지름 (화면 px)
  const DISC_INNER = 58;

  const PALETTE = [
    '#ff2bd6', // 마젠타
    '#00f0ff', // 시안
    '#39ff14', // 라임
    '#ffe600', // 옐로
    '#ff6a00', // 오렌지
    '#8a5cff', // 바이올렛
    '#ff3366', // 핑크레드
  ];
  const K = PALETTE.length;
  const PALETTE_RGB = PALETTE.map(h => [
    parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
  ]);

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
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const worker = new Worker(url);
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
    // 워커를 못 쓰는 환경이면 메인 스레드에서 2만 자리만 계산
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
  // 색 구역: 도메인 워핑한 value noise 두 개의 각도로 유기적 얼룩 생성
  // ---------------------------------------------------------
  let seed = (Math.random() * 1e6) | 0;
  let zoneScale = 400;

  function hash(ix, iy, s) {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, s), b = hash(ix + 1, iy, s);
    const c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
    return (a + (b - a) * ux + (c - a + (a - b + d - c) * ux) * uy) * 2 - 1;
  }
  function fbm(x, y, s) {
    let sum = 0, amp = 0.5, f = 1;
    for (let i = 0; i < 4; i++) {
      sum += amp * vnoise(x * f, y * f, s + i * 131);
      f *= 2.03; amp *= 0.5;
    }
    return sum;
  }
  function zoneAt(x, y) {
    let u = x / zoneScale, v = y / zoneScale;
    const wx = fbm(u + 5.2, v + 1.3, seed + 1000);
    const wy = fbm(u - 3.1, v + 7.7, seed + 2000);
    u += wx * 1.4; v += wy * 1.4;
    const a = fbm(u, v, seed);
    const b = fbm(u + 11.7, v - 4.4, seed + 500);
    const t = Math.atan2(b, a) / (Math.PI * 2) + 0.5;
    return Math.min(K - 1, Math.floor(t * K));
  }

  // ---------------------------------------------------------
  // 걷기(선) 데이터
  // ---------------------------------------------------------
  let mode = 'absolute';           // 'absolute' | 'relative'
  let cap = 1 << 16;
  let pts = new Float64Array(cap * 2 + 2); // 꼭짓점 좌표 (n+1개)
  let cols = new Uint8Array(cap);          // 각 선의 색 구역
  let n = 0;                               // 그어진 선 개수
  let heading = 0;                         // 상대 회전 모드의 현재 방향(도)
  let lastDir = 0;                         // 마지막으로 그은 방향(도)
  let paths = [];                          // 색별 Path2D
  let drawnUpTo = 0;                       // trail 캔버스에 반영된 선 개수
  let bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  function resetWalk() {
    n = 0; heading = 0; lastDir = 0; drawnUpTo = 0;
    pts[0] = 0; pts[1] = 0;
    paths = PALETTE.map(() => new Path2D());
    bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  function grow() {
    cap *= 2;
    const p2 = new Float64Array(cap * 2 + 2); p2.set(pts); pts = p2;
    const c2 = new Uint8Array(cap); c2.set(cols); cols = c2;
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
    if (n >= PI.length) return false;
    if (n >= cap) grow();
    const nd = nextDir(n);
    const [dx, dy] = dirVec(nd.dir);
    const x0 = pts[n * 2], y0 = pts[n * 2 + 1];
    const x1 = x0 + dx * STEP, y1 = y0 + dy * STEP;
    const c = zoneAt((x0 + x1) / 2, (y0 + y1) / 2);
    pts[n * 2 + 2] = x1; pts[n * 2 + 3] = y1;
    cols[n] = c;
    paths[c].moveTo(x0, y0);
    paths[c].lineTo(x1, y1);
    heading = nd.heading;
    lastDir = nd.dir;
    if (x1 < bounds.minX) bounds.minX = x1;
    if (x1 > bounds.maxX) bounds.maxX = x1;
    if (y1 < bounds.minY) bounds.minY = y1;
    if (y1 > bounds.maxY) bounds.maxY = y1;
    n++;
    return true;
  }

  // 같은 개수만큼 처음부터 다시 계산 (각도 방식·색 구역을 바꿨을 때)
  function rebuild(count) {
    resetWalk();
    while (n < count && commit()) { /* */ }
    anim.active = false;
    requestFull();
  }

  // ---------------------------------------------------------
  // 캔버스 & 카메라
  // ---------------------------------------------------------
  const bgCanvas = document.getElementById('bg');
  const trailCanvas = document.getElementById('trail');
  const overlay = document.getElementById('overlay');
  const bgCtx = bgCanvas.getContext('2d');
  const tCtx = trailCanvas.getContext('2d');
  const oCtx = overlay.getContext('2d');
  const cache = document.createElement('canvas');
  const cacheCtx = cache.getContext('2d');
  const zoneSmall = document.createElement('canvas');
  const zoneSmallCtx = zoneSmall.getContext('2d');

  let W = 0, H = 0, DPR = 1;
  const cam = { x: 0, y: 0, s: 2 };
  const target = { x: 0, y: 0, s: 2 };
  let renderCam = { x: 0, y: 0, s: 2 };
  let camMode = 'follow';
  let needFull = true;
  let previewing = false;
  let lastViewChange = 0;
  let showZones = false;
  let showDisc = true;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    for (const c of [bgCanvas, trailCanvas, overlay, cache]) {
      c.width = Math.round(W * DPR);
      c.height = Math.round(H * DPR);
    }
    requestFull();
  }

  function requestFull() { needFull = true; }

  function worldToScreen(x, y) {
    return [(x - cam.x) * cam.s + W / 2, (y - cam.y) * cam.s + H / 2];
  }
  function screenToWorld(sx, sy) {
    return [(sx - W / 2) / cam.s + cam.x, (sy - H / 2) / cam.s + cam.y];
  }

  function setWorldTransform(ctx) {
    const s = cam.s * DPR;
    ctx.setTransform(s, 0, 0, s, DPR * (W / 2 - cam.x * cam.s), DPR * (H / 2 - cam.y * cam.s));
  }

  function strokeStyleFor(ctx, k, glow) {
    ctx.strokeStyle = PALETTE[k];
    if (glow) { ctx.globalAlpha = 0.16; ctx.lineWidth = 6 / cam.s; }
    else { ctx.globalAlpha = 0.95; ctx.lineWidth = 1.3 / cam.s; }
  }

  function fullRedraw() {
    tCtx.setTransform(1, 0, 0, 1, 0, 0);
    tCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
    setWorldTransform(tCtx);
    tCtx.lineCap = 'round';
    tCtx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < K; k++) {
        strokeStyleFor(tCtx, k, pass === 0);
        tCtx.stroke(paths[k]);
      }
    }
    tCtx.globalAlpha = 1;
    drawnUpTo = n;
    renderCam = { x: cam.x, y: cam.y, s: cam.s };
    previewing = false;
    needFull = false;
    renderZones();
  }

  function incrementalDraw() {
    if (drawnUpTo >= n) return;
    const tmp = PALETTE.map(() => null);
    for (let i = drawnUpTo; i < n; i++) {
      const c = cols[i];
      if (!tmp[c]) tmp[c] = new Path2D();
      tmp[c].moveTo(pts[i * 2], pts[i * 2 + 1]);
      tmp[c].lineTo(pts[i * 2 + 2], pts[i * 2 + 3]);
    }
    setWorldTransform(tCtx);
    tCtx.lineCap = 'round';
    tCtx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < K; k++) {
        if (!tmp[k]) continue;
        strokeStyleFor(tCtx, k, pass === 0);
        tCtx.stroke(tmp[k]);
      }
    }
    tCtx.globalAlpha = 1;
    drawnUpTo = n;
  }

  // 줄이 아주 많을 때 화면 이동 중엔 이전 렌더 결과를 늘려/옮겨서 보여줌
  function drawPreview() {
    if (!previewing) {
      cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
      cacheCtx.clearRect(0, 0, cache.width, cache.height);
      cacheCtx.drawImage(trailCanvas, 0, 0);
      previewing = true;
    }
    const k = cam.s / renderCam.s;
    const ox = W / 2 - (W / 2) * k + (renderCam.x - cam.x) * cam.s;
    const oy = H / 2 - (H / 2) * k + (renderCam.y - cam.y) * cam.s;
    tCtx.setTransform(1, 0, 0, 1, 0, 0);
    tCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
    tCtx.drawImage(cache, ox * DPR, oy * DPR, cache.width * k, cache.height * k);
    renderZones();
  }

  function viewChanged() {
    lastViewChange = performance.now();
    if (n < HEAVY) requestFull();
    else drawPreview();
  }

  function renderZones() {
    bgCtx.setTransform(1, 0, 0, 1, 0, 0);
    bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    if (!showZones) return;
    const cell = 10;
    const cw = Math.ceil(W / cell) + 1, ch = Math.ceil(H / cell) + 1;
    if (zoneSmall.width !== cw || zoneSmall.height !== ch) { zoneSmall.width = cw; zoneSmall.height = ch; }
    const img = zoneSmallCtx.createImageData(cw, ch);
    const d = img.data;
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        const [wx, wy] = screenToWorld(i * cell, j * cell);
        const rgb = PALETTE_RGB[zoneAt(wx, wy)];
        const p = (j * cw + i) * 4;
        d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2]; d[p + 3] = 34;
      }
    }
    zoneSmallCtx.putImageData(img, 0, 0);
    bgCtx.imageSmoothingEnabled = true;
    bgCtx.drawImage(zoneSmall, 0, 0, cw, ch, 0, 0, cw * cell * DPR, ch * cell * DPR);
  }

  // ---------------------------------------------------------
  // 애니메이션 상태 (한 줄 긋기: 바늘 회전 → 선 긋기)
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

  function discRotationAtRest() {
    return mode === 'relative' ? heading : 0;
  }

  function startAnim() {
    if (n >= PI.length) return false;
    const nd = nextDir(n);
    const [dx, dy] = dirVec(nd.dir);
    anim.x0 = pts[n * 2]; anim.y0 = pts[n * 2 + 1];
    anim.x1 = anim.x0 + dx * STEP; anim.y1 = anim.y0 + dy * STEP;
    anim.digit = nd.digit;
    anim.color = zoneAt((anim.x0 + anim.x1) / 2, (anim.y0 + anim.y1) / 2);
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

  const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  function lerpAngle(a, b, t) {
    let d = ((b - a) % 360 + 540) % 360 - 180;
    return a + d * t;
  }

  // 현재 펜(원판) 위치와 원판 상태
  function penState() {
    if (anim.active) {
      const t = anim.t;
      const ROT = 0.45;
      if (t < ROT) {
        const e = easeInOut(t / ROT);
        return {
          x: anim.x0, y: anim.y0, len: 0,
          needle: lerpAngle(anim.needleFrom, anim.needleTo, e),
          rot: anim.rotFrom, digit: anim.digit, color: anim.color, highlight: e,
        };
      }
      const e = easeInOut((t - ROT) / (1 - ROT));
      return {
        x: anim.x0 + (anim.x1 - anim.x0) * e,
        y: anim.y0 + (anim.y1 - anim.y0) * e,
        len: e,
        needle: anim.needleTo,
        rot: lerpAngle(anim.rotFrom, anim.rotTo, e),
        digit: anim.digit, color: anim.color, highlight: 1,
      };
    }
    const last = n > 0 ? PI.charCodeAt(n - 1) - 48 : -1;
    return {
      x: pts[n * 2], y: pts[n * 2 + 1], len: 0,
      needle: lastDir, rot: discRotationAtRest(),
      digit: last, color: n > 0 ? cols[n - 1] : zoneAt(0, 0), highlight: n > 0 ? 1 : 0,
    };
  }

  // ---------------------------------------------------------
  // 원판 그리기
  // ---------------------------------------------------------
  function toCanvasRad(deg) { return (deg - 90) * Math.PI / 180; }

  function drawOverlay(ps) {
    oCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    oCtx.clearRect(0, 0, W, H);

    // 긋고 있는 중인 선
    if (anim.active && ps.len > 0) {
      const [ax, ay] = worldToScreen(anim.x0, anim.y0);
      const [bx, by] = worldToScreen(ps.x, ps.y);
      oCtx.lineCap = 'round';
      oCtx.strokeStyle = PALETTE[anim.color];
      oCtx.globalAlpha = 0.25; oCtx.lineWidth = 7;
      oCtx.beginPath(); oCtx.moveTo(ax, ay); oCtx.lineTo(bx, by); oCtx.stroke();
      oCtx.globalAlpha = 1; oCtx.lineWidth = 2;
      oCtx.beginPath(); oCtx.moveTo(ax, ay); oCtx.lineTo(bx, by); oCtx.stroke();
    }

    if (!showDisc) return;
    const [cx, cy] = worldToScreen(ps.x, ps.y);
    if (cx < -DISC_R * 2 || cy < -DISC_R * 2 || cx > W + DISC_R * 2 || cy > H + DISC_R * 2) return;
    const col = PALETTE[ps.color];

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
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      const active = d === ps.digit;
      oCtx.save();
      oCtx.translate(x, y);
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
    // 바늘 끝 삼각형
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
  // 카메라 자동 이동
  // ---------------------------------------------------------
  function updateCameraTarget(ps) {
    if (camMode === 'follow') {
      const [sx, sy] = worldToScreen(ps.x, ps.y);
      const mx = W * 0.25, my = H * 0.25;
      if (sx < mx || sx > W - mx || sy < my || sy > H - my) {
        target.x = ps.x; target.y = ps.y;
      }
    } else if (camMode === 'fit') {
      fitTarget(false);
    }
  }

  function fitTarget(force) {
    const pad = 40;
    const bw = Math.max(bounds.maxX - bounds.minX, 120);
    const bh = Math.max(bounds.maxY - bounds.minY, 120);
    const cxw = (bounds.minX + bounds.maxX) / 2, cyw = (bounds.minY + bounds.maxY) / 2;
    // 현재 목표 화면 안에 다 들어오면 그대로 둔다 (불필요한 재렌더 방지)
    if (!force) {
      const hw = (W / 2 - pad) / target.s, hh = (H / 2 - pad) / target.s;
      if (bounds.minX > target.x - hw && bounds.maxX < target.x + hw &&
          bounds.minY > target.y - hh && bounds.maxY < target.y + hh) return;
    }
    const room = force ? 1.15 : 1.6;  // 여유를 두고 축소
    let s = Math.min((W - pad * 2) / (bw * room), (H - pad * 2) / (bh * room));
    s = Math.min(s, 3);
    target.x = cxw; target.y = cyw; target.s = s;
  }

  function stepCamera(dt) {
    const f = 1 - Math.exp(-dt * 5);
    const dx = target.x - cam.x, dy = target.y - cam.y;
    const ds = Math.log(target.s / cam.s);
    if (Math.abs(dx) * cam.s < 0.3 && Math.abs(dy) * cam.s < 0.3 && Math.abs(ds) < 0.001) {
      if (dx || dy || ds) { cam.x = target.x; cam.y = target.y; cam.s = target.s; viewChanged(); }
      return;
    }
    cam.x += dx * f; cam.y += dy * f; cam.s *= Math.exp(ds * f);
    viewChanged();
  }

  function setCamMode(m) {
    camMode = m;
    document.querySelectorAll('#camSeg button').forEach(b => b.classList.toggle('on', b.dataset.cam === m));
    if (m === 'follow') {
      const ps = penState();
      target.x = ps.x; target.y = ps.y;
      if (target.s < 0.6) target.s = 1.5;
    } else if (m === 'fit') {
      fitTarget(true);
    } else {
      target.x = cam.x; target.y = cam.y; target.s = cam.s;
    }
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

    const ps = penState();
    updateCameraTarget(ps);
    stepCamera(dt);

    if (previewing && now - lastViewChange > 160) needFull = true;
    if (needFull) fullRedraw();
    else if (!previewing) incrementalDraw();

    drawOverlay(ps);
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
    const idx = anim.active ? n : n - 1;   // 지금 표시할 자릿수의 위치
    const key = idx + '|' + Math.round(cam.s * 1000) + '|' + PI.length;
    if (key === hudKey) return;
    hudKey = key;
    if (idx >= 0 && PI.length) {
      const from = Math.max(0, idx - 36);
      let past = PI.slice(from, idx);
      if (from === 0 && past.length) past = past[0] + '.' + past.slice(1);
      else if (from > 0) past = '…' + past;
      elPast.textContent = past;
      elNow.textContent = PI[idx];
      const c = anim.active ? anim.color : cols[idx];
      elNow.style.color = PALETTE[c];
    } else {
      elPast.textContent = '';
      elNow.textContent = '';
    }
    elCount.textContent = Math.max(0, idx + 1).toLocaleString('ko-KR');
    elZoom.textContent = cam.s * 50 >= 10 ? Math.round(cam.s * 50) + '%' : (cam.s * 50).toFixed(2) + '%';
    updateStatus();
  }

  function updateStatus() {
    if (!PI.length) { elStatus.textContent = '원주율 계산 중…'; return; }
    if (n >= PI.length && piFinal) { elStatus.textContent = `${PI.length.toLocaleString('ko-KR')}자리 끝까지 완료`; return; }
    if (n >= PI.length) { elStatus.textContent = '다음 자릿수 계산 중…'; return; }
    elStatus.textContent = `${PI.length.toLocaleString('ko-KR')}자리 준비됨` + (piFinal ? '' : ' (계산 계속 중)');
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------------------------------------------------------
  // 컨트롤
  // ---------------------------------------------------------
  const btnPlay = document.getElementById('btnPlay');
  const speedInput = document.getElementById('speed');
  const speedLabel = document.getElementById('speedLabel');
  const zoneInput = document.getElementById('zoneSize');
  const zoneLabel = document.getElementById('zoneLabel');

  function setPlaying(p) {
    playing = p;
    btnPlay.textContent = p ? '⏸ 일시정지' : '▶ 재생';
  }
  btnPlay.addEventListener('click', () => setPlaying(!playing));

  document.getElementById('btnStep').addEventListener('click', stepOnce);
  function stepOnce() {
    setPlaying(false);
    if (anim.active) finishAnim();
    else commit();
  }

  document.getElementById('btnReset').addEventListener('click', restart);
  function restart() {
    resetWalk();
    anim.active = false;
    acc = 0;
    cam.x = cam.y = target.x = target.y = 0;
    cam.s = target.s = 2;
    if (camMode === 'free') setCamMode('follow');
    requestFull();
    setPlaying(true);
  }

  function sliderToSpeed(v) { return 0.5 * Math.pow(40000, v / 100); }
  function updateSpeed() {
    speed = sliderToSpeed(parseFloat(speedInput.value));
    const txt = speed < 10 ? speed.toFixed(1) : Math.round(speed).toLocaleString('ko-KR');
    speedLabel.textContent = `${txt} 줄/초`;
  }
  speedInput.addEventListener('input', updateSpeed);

  document.querySelectorAll('#modeSeg button').forEach(b => {
    b.addEventListener('click', () => {
      if (mode === b.dataset.mode) return;
      mode = b.dataset.mode;
      document.querySelectorAll('#modeSeg button').forEach(x => x.classList.toggle('on', x === b));
      document.getElementById('modeHint').textContent = mode === 'absolute'
        ? '숫자 n → 항상 n×36° 방향으로 긋기 (0 = 위쪽, 시계방향)'
        : '숫자 n → 지금 가던 방향에서 n×36°만큼 꺾어서 긋기 (0 = 직진)';
      rebuild(n);
      if (camMode === 'fit') fitTarget(true);
      if (camMode === 'follow') setCamMode('follow');
      toast(`${mode === 'absolute' ? '절대 방향' : '상대 회전'}으로 지금까지 그린 ${n.toLocaleString('ko-KR')}줄을 다시 그렸어요`);
    });
  });

  document.querySelectorAll('#camSeg button').forEach(b => {
    b.addEventListener('click', () => setCamMode(b.dataset.cam));
  });

  let zoneTimer = 0;
  zoneInput.addEventListener('input', () => {
    zoneLabel.textContent = zoneInput.value;
    clearTimeout(zoneTimer);
    zoneTimer = setTimeout(() => { zoneScale = parseFloat(zoneInput.value); recolor(); }, 120);
  });
  document.getElementById('btnReseed').addEventListener('click', () => {
    seed = (Math.random() * 1e6) | 0;
    recolor();
    toast('색 구역을 새로 배치했어요');
  });
  function recolor() {
    paths = PALETTE.map(() => new Path2D());
    for (let i = 0; i < n; i++) {
      const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[i * 2 + 2], y1 = pts[i * 2 + 3];
      const c = zoneAt((x0 + x1) / 2, (y0 + y1) / 2);
      cols[i] = c;
      paths[c].moveTo(x0, y0);
      paths[c].lineTo(x1, y1);
    }
    if (anim.active) anim.color = zoneAt((anim.x0 + anim.x1) / 2, (anim.y0 + anim.y1) / 2);
    requestFull();
  }

  document.getElementById('chkZones').addEventListener('change', e => { showZones = e.target.checked; renderZones(); });
  document.getElementById('chkDisc').addEventListener('change', e => { showDisc = e.target.checked; });

  const panel = document.getElementById('panel');
  document.getElementById('panelToggle').addEventListener('click', () => panel.classList.toggle('collapsed'));

  // 범례: 숫자별 각도
  const legend = document.getElementById('legend');
  for (let d = 0; d < 10; d++) {
    const el = document.createElement('div');
    el.className = 'chip';
    el.innerHTML = `<b>${d}</b>${d * DEG_PER_DIGIT}°`;
    legend.appendChild(el);
  }

  // ---------------------------------------------------------
  // 마우스 / 터치: 드래그 이동, 휠·핀치 확대
  // ---------------------------------------------------------
  const pointers = new Map();
  let pinchStart = null;

  function goFree() { if (camMode !== 'free') setCamMode('free'); }

  function zoomAt(sx, sy, factor) {
    goFree();
    const [wx, wy] = screenToWorld(sx, sy);
    const ns = Math.min(60, Math.max(0.0002, cam.s * factor));
    cam.s = ns;
    cam.x = wx - (sx - W / 2) / ns;
    cam.y = wy - (sy - H / 2) / ns;
    target.x = cam.x; target.y = cam.y; target.s = cam.s;
    viewChanged();
  }

  overlay.addEventListener('wheel', e => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0015));
  }, { passive: false });

  overlay.addEventListener('pointerdown', e => {
    overlay.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    overlay.classList.add('dragging');
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
  });
  overlay.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) {
      const dx = cur.x - prev.x, dy = cur.y - prev.y;
      if (!dx && !dy) return;
      goFree();
      cam.x -= dx / cam.s; cam.y -= dy / cam.s;
      target.x = cam.x; target.y = cam.y; target.s = cam.s;
      viewChanged();
    } else if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      goFree();
      cam.x -= (mx - pinchStart.mx) / cam.s;
      cam.y -= (my - pinchStart.my) / cam.s;
      zoomAt(mx, my, d / pinchStart.d);
      pinchStart = { d, mx, my };
    }
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) overlay.classList.remove('dragging');
  }
  overlay.addEventListener('pointerup', endPointer);
  overlay.addEventListener('pointercancel', endPointer);

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    switch (e.key) {
      case ' ': e.preventDefault(); setPlaying(!playing); break;
      case 'ArrowRight': e.preventDefault(); stepOnce(); break;
      case 'r': case 'R': restart(); break;
      case 'f': case 'F': setCamMode('follow'); break;
      case 'a': case 'A': setCamMode('fit'); break;
      case '+': case '=': zoomAt(W / 2, H / 2, 1.25); break;
      case '-': case '_': zoomAt(W / 2, H / 2, 0.8); break;
    }
  });

  window.addEventListener('resize', resize);

  // ---------------------------------------------------------
  // 시작
  // ---------------------------------------------------------
  resetWalk();
  resize();
  updateSpeed();
  startPi();
  requestAnimationFrame(frame);
})();
