/* =========================================================
   DRAGON CURVE ∞ — 끝없이 확대·축소되는 드래곤 커브

   원리
   · 드래곤 커브는 "선분 하나 = 직각으로 꺾인 선분 두 개"로 끝없이 쪼갤 수 있고
     (확대 방향), 반대로 지금 곡선은 더 큰 곡선의 앞 절반이다 (축소 방향).
   · 선을 저장하지 않고, 매번 화면에 보이는 부분만 나무 구조로 내려가며 계산한다.
     화면 밖 덩어리는 통째로 건너뛰고, 선이 몇 px 크기가 되면 멈추고 긋는다.
   · 숫자 정밀도가 깨지지 않도록 "기준 선분(프레임)"을 화면 크기 근처의 선분으로
     계속 옮겨 다닌다. 그래서 확대·축소에 끝이 없다.
   ========================================================= */
(() => {
  'use strict';
  const NK = window.NeonKit;
  const K = NK.K;

  const RADIUS = 0.92;          // 선분 AB의 하위 곡선은 중점에서 |AB|×0.8972 안에 있음 (+여유)
  const EXTRA_LEVELS = 6;       // 화면을 감싸는 조상보다 이만큼 더 올라가서 그리기 시작 (빠짐 방지)
  const MAX_CLIMB = 90;
  const MAX_LEAVES = 40e6;      // 한 번에 그리는 선 최대 개수 (멈춤 방지)
  const FAR = 4;                // 카메라가 프레임에서 이보다 멀어지면(프레임 단위) 프레임을 옮김
  const BUF_SCALE = 1.35;       // 버퍼 한 변 = 화면 대각선 × 이 값 (회전해도 화면을 덮도록)
  const BUF_MAX_PIXELS = 40e6;
  const GEN_STEP = 0.13;        // 세대별 색: 세대마다 그라데이션에서 이동하는 양
  const DEPTH_STEP = 0.03;     // 접힘 그라데이션: 오른쪽으로 접힐 때마다 이동하는 양

  // ---------------------------------------------------------
  // 설정 (주소창에서 읽기)
  // ---------------------------------------------------------
  const params = NK.readParams();
  const color = new NK.ColorState(NK.colorFromParams(params));
  let gs = params.get('dir') === 'ccw' ? -1 : 1;
  let colorMode = params.get('cm') === 'depth' ? 'depth' : 'gen';
  let autoMode = ['out', 'in', 'stop'].includes(params.get('auto')) ? params.get('auto') : 'out';
  let counterRotate = params.get('cr') === '1';
  let leafPx = Math.max(1, Math.min(48, parseFloat(params.get('leaf')) || 2));
  let zoomSpeed = 0.5;          // 초당 몇 배(옥타브)
  let paused = false;
  let followCurve = params.get('follow') !== '0';   // 계속 확대할 때 곡선 위로 따라가기

  // ---------------------------------------------------------
  // 프레임(기준 선분)
  // 프레임 = 무한 곡선 속의 선분 하나. 그 선분을 (0,0)→(1,0)으로 두는 좌표계에서 모든 걸 계산.
  // bits[j] = 왼쪽 사슬(시작점에서 무한히 커지는 조상들)에서 프레임까지 내려오는 길 (0=앞 절반, 1=뒤 절반)
  // ---------------------------------------------------------
  const frame = { level: 0, bits: [], cnt: [0], firstOne: -1 };

  const signOfDepth = (idx) => (idx > 0 && frame.bits[idx - 1] ? -gs : gs);   // idx개 비트까지 내려온 노드의 부호
  const frameSign = () => signOfDepth(frame.bits.length);

  // 카메라: 프레임 좌표의 중심(x,y), 배율 s(CSS px / 프레임 단위), 화면 회전 rot(라디안)
  const cam = { x: 0.5, y: 0, s: 300, rot: 0 };
  let bufView = null;          // 버퍼가 그려진 시점의 카메라 (프레임 좌표)
  let pendingView = null;      // 렌더 요청 중인 카메라
  let absZoom0 = 0;            // 처음 배율 (표시용)

  // 프레임 바꾸기: 새 좌표 q = (p − A) / D  (복소수)
  function changeFrame(ax, ay, dx, dy) {
    const d2 = dx * dx + dy * dy;
    const mag = Math.sqrt(d2), ang = Math.atan2(dy, dx);
    for (const v of [cam, bufView, pendingView]) {
      if (!v) continue;
      const px = v.x - ax, py = v.y - ay;
      v.x = (px * dx + py * dy) / d2;
      v.y = (py * dx - px * dy) / d2;
      v.s *= mag;
      v.rot = (v.rot + ang) % (Math.PI * 2);
    }
  }

  // 현재 프레임 좌표계에서 k단계 위 조상 선분
  function ancestorAt(k) {
    let ax = 0, ay = 0, bx = 1, by = 0;
    let idx = frame.bits.length;
    for (let j = 0; j < k; j++) {
      const bit = idx > 0 ? frame.bits[idx - 1] : 0;
      if (idx > 0) idx--;
      const sp = signOfDepth(idx);
      // 자식 좌표계에서 본 부모 선분: 앞 절반이면 (0,0)→(1,−sp), 뒤 절반이면 (0,−sp)→(1,0)
      const lay = bit === 0 ? 0 : -sp, lby = bit === 0 ? -sp : 0;
      const dx = bx - ax, dy = by - ay;
      const nax = ax - lay * dy, nay = ay + lay * dx;
      const nbx = ax + dx - lby * dy, nby = ay + dy + lby * dx;
      ax = nax; ay = nay; bx = nbx; by = nby;
    }
    return { ax, ay, bx, by, idx, level: frame.level + k, sign: signOfDepth(idx) };
  }

  // 프레임을 "카메라 근처에서, 화면에 적당한 크기(S0~√2·S0)인 선분"으로 옮긴다.
  // 카메라를 감싸는 조상까지 올라간 뒤, 카메라에 가까운 선분들만 남기며 목표 크기까지 내려감.
  function relocate() {
    const S0 = Math.min(view.W, view.H) * 0.3;
    const down = Math.floor(2 * Math.log2(cam.s / S0));     // 몇 단계 내려갈지 (음수면 올라감)
    const targetLevel = frame.level - down;
    // 1) 조상 찾기: 목표보다 2단계 이상 위 + 카메라 주변을 넉넉히 감싸는 것
    let k = Math.max(0, -down) + 2, anc = null, extra = -1;
    for (; k < 160; k++) {
      anc = ancestorAt(k);
      const len = Math.hypot(anc.bx - anc.ax, anc.by - anc.ay);
      const d = Math.hypot((anc.ax + anc.bx) / 2 - cam.x, (anc.ay + anc.by) / 2 - cam.y);
      if (extra < 0 && d <= RADIUS * len * 0.5) extra = 0;
      if (extra >= 3) break;
      if (extra >= 0) extra++;
    }
    // 2) 카메라에 가까운 선분들만 남기며 내려가기 (빔 탐색)
    let beam = [{ ax: anc.ax, ay: anc.ay, bx: anc.bx, by: anc.by, sig: anc.sign, path: [] }];
    for (let lv = anc.level; lv > targetLevel; lv--) {
      const next = [];
      for (const n of beam) {
        const dx = n.bx - n.ax, dy = n.by - n.ay;
        const qx = (n.ax + n.bx) / 2 - n.sig * dy / 2, qy = (n.ay + n.by) / 2 + n.sig * dx / 2;
        next.push({ ax: n.ax, ay: n.ay, bx: qx, by: qy, sig: gs, path: n.path.concat(0) });
        next.push({ ax: qx, ay: qy, bx: n.bx, by: n.by, sig: -gs, path: n.path.concat(1) });
      }
      for (const n of next) {
        const len = Math.hypot(n.bx - n.ax, n.by - n.ay);
        n.score = Math.max(0, Math.hypot((n.ax + n.bx) / 2 - cam.x, (n.ay + n.by) / 2 - cam.y) - RADIUS * len) / len;
      }
      next.sort((p, q) => p.score - q.score);
      beam = next.slice(0, 12);
    }
    // 3) 목표 크기에서 카메라와 가장 가까운 선분을 새 프레임으로
    let best = beam[0], bestD = Infinity;
    for (const n of beam) {
      const d = Math.hypot((n.ax + n.bx) / 2 - cam.x, (n.ay + n.by) / 2 - cam.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    changeFrame(best.ax, best.ay, best.bx - best.ax, best.by - best.ay);
    frame.bits = frame.bits.slice(0, anc.idx).concat(best.path);
    frame.cnt = [0];
    frame.firstOne = -1;
    for (let i = 0; i < frame.bits.length; i++) {
      frame.cnt.push(frame.cnt[i] + frame.bits[i]);
      if (frame.bits[i] && frame.firstOne < 0) frame.firstOne = i;
    }
    frame.level = targetLevel;
  }

  function rebase() {
    const S0 = Math.min(view.W, view.H) * 0.3;
    const dist = Math.hypot(cam.x - 0.5, cam.y);
    if (cam.s < S0 || cam.s >= S0 * 2 || dist > FAR) relocate();
  }

  // 절대 배율 (log2): 처음 세대 0 선분 기준
  const absZoom = () => Math.log2(cam.s) - frame.level * 0.5;

  // ---------------------------------------------------------
  // 렌더러 (Web Worker)
  // ---------------------------------------------------------
  function infRenderer(port, makeCanvas) {
    let canvas = null, ctx = null;
    port.onmessage = (e) => {
      const m = e.data;
      if (!canvas || canvas.width !== m.w || canvas.height !== m.h) { canvas = makeCanvas(m.w, m.h); ctx = canvas.getContext('2d'); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, m.w, m.h);

      const K = m.colors.length, gs = m.gs, w = m.w, h = m.h, R = m.radius, pad = m.pad;
      const thr2 = m.thr * m.thr;
      const depthMode = m.mode === 'depth';
      const NONE = -1e15;
      let leaves = 0;
      const gcol = (g) => { const t = ((g * m.genStep) % 1 + 1) % 1; return Math.floor(t * K) % K; };
      const dcol = (c) => { const t = ((c * m.depthStep) % 1 + 1) % 1; return Math.floor(t * K) % K; };

      // 선이 아주 짧으면(몇 px) 선 대신 픽셀을 직접 찍는다 → 훨씬 빠르고 촘촘하게 가능
      const pixelMode = m.thr <= 4.5;
      const paths = pixelMode ? null : new Array(K).fill(null);
      let img = null, px32 = null, col32 = null;
      if (pixelMode) {
        img = new ImageData(w, h);
        px32 = new Uint32Array(img.data.buffer);
        col32 = m.colorsRgb.map(([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0);
      }

      function leaf(ax, ay, bx, by, c) {
        leaves++;
        if (!pixelMode) {
          let p = paths[c];
          if (!p) p = paths[c] = new Path2D();
          p.moveTo(ax, ay); p.lineTo(bx, by);
          return;
        }
        const dx = bx - ax, dy = by - ay;
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
        const v = col32[c];
        for (let i = 0; i <= n; i++) {
          const x = (ax + dx * i / n) | 0, y = (ay + dy * i / n) | 0;
          if (x >= 0 && y >= 0 && x < w && y < h) px32[y * w + x] = v;
        }
      }

      function d(ax, ay, bx, by, sig, lv, cnt, H) {
        const dx = bx - ax, dy = by - ay;
        const L2 = dx * dx + dy * dy;
        const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
        const r = Math.sqrt(L2) * R + pad;
        if (mx + r < 0 || mx - r > w || my + r < 0 || my - r > h) return;   // 화면 밖: 통째로 건너뜀
        if (L2 <= thr2 || leaves >= m.maxLeaves) {
          // relGen: 무한 루프용. 세대를 "선 크기 기준 상대값"으로 칠해서 2배 확대해도 색이 똑같음
          const g = H === NONE ? lv : H;
          leaf(ax, ay, bx, by, depthMode ? dcol(cnt) : gcol(m.relGen ? g - lv : g));
          return;
        }
        const qx = mx - sig * dy * 0.5, qy = my + sig * dx * 0.5;          // 꺾이는 점
        d(ax, ay, qx, qy, gs, lv - 1, cnt, H);                              // 앞 절반
        d(qx, qy, bx, by, -gs, lv - 1, cnt + 1, H === NONE ? lv : H);       // 뒤 절반 (오른쪽 접힘)
      }
      const r = m.root;
      d(r.ax, r.ay, r.bx, r.by, r.sign, r.level, r.count, r.H === null ? NONE : r.H);

      if (pixelMode) {
        // 픽셀 → 캔버스, 번짐은 작게 줄였다 늘려서(흐림 효과) 아래에 깔기
        const core = makeCanvas(w, h);
        core.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        for (const [div, alpha] of [[10, 0.55], [4, 0.45]]) {
          const sw = Math.max(1, Math.round(w / div)), sh = Math.max(1, Math.round(h / div));
          const small = makeCanvas(sw, sh);
          const sc = small.getContext('2d');
          sc.imageSmoothingEnabled = true;
          sc.imageSmoothingQuality = 'high';
          sc.drawImage(core, 0, 0, sw, sh);
          ctx.globalAlpha = alpha;
          ctx.drawImage(small, 0, 0, w, h);
        }
        ctx.globalAlpha = 1;
        ctx.drawImage(core, 0, 0);
      } else {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let pass = 0; pass < 2; pass++) {
          ctx.globalAlpha = pass === 0 ? 0.16 : 0.95;
          ctx.lineWidth = pass === 0 ? m.glow : m.core;
          for (let k = 0; k < K; k++) {
            if (!paths[k]) continue;
            ctx.strokeStyle = m.colors[k];
            ctx.stroke(paths[k]);
          }
        }
        ctx.globalAlpha = 1;
      }
      const bitmap = canvas.transferToImageBitmap ? canvas.transferToImageBitmap() : canvas;
      const out = { id: m.id, kind: m.kind, leaves, bitmap, w: m.w, h: m.h };
      if (canvas.transferToImageBitmap) port.postMessage(out, [bitmap]); else port.postMessage(out);
    };
  }

  const renderer = (() => {
    const h = { onResult: null };
    try {
      if (typeof OffscreenCanvas === 'undefined' || !OffscreenCanvas.prototype.transferToImageBitmap) throw new Error('no offscreen');
      const src = '(' + infRenderer.toString() + ')(self, (w, h) => new OffscreenCanvas(w, h));';
      const wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      wk.onmessage = (e) => h.onResult && h.onResult(e.data);
      return { post: (m) => wk.postMessage(m), h };
    } catch (err) {
      const port = { onmessage: null, postMessage: (m) => setTimeout(() => h.onResult && h.onResult(m), 0) };
      infRenderer(port, (w, hh) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; return c; });
      return { post: (m) => port.onmessage({ data: m }), h };
    }
  })();

  // ---------------------------------------------------------
  // 화면
  // ---------------------------------------------------------
  const trail = document.getElementById('trail');
  const overlay = document.getElementById('overlay');
  const tCtx = trail.getContext('2d');
  const oCtx = overlay.getContext('2d');
  const buf = document.createElement('canvas');
  const bufCtx = buf.getContext('2d');
  const view = { W: 0, H: 0, DPR: 1 };
  let dirty = true, inflight = false, forceRender = true, renderId = 0, lastLeaves = 0;
  let renderStart = 0, renderMs = 200;

  function resize() {
    view.DPR = Math.min(window.devicePixelRatio || 1, 2);
    view.W = window.innerWidth; view.H = window.innerHeight;
    for (const c of [trail, overlay]) { c.width = Math.round(view.W * view.DPR); c.height = Math.round(view.H * view.DPR); }
    forceRender = true; dirty = true;
  }

  function bufferSide() {
    const diag = Math.hypot(view.W, view.H) * view.DPR * BUF_SCALE;
    return Math.round(Math.min(diag, Math.sqrt(BUF_MAX_PIXELS), 12000));
  }

  // 프레임 좌표 → (버퍼 또는 화면) 픽셀: pix = sDev·e^{iθ}(p − c) + center
  function makeMap(v, sDev, cx0, cy0) {
    const cs = Math.cos(v.rot) * sDev, sn = Math.sin(v.rot) * sDev;
    return (x, y) => {
      const px = x - v.x, py = y - v.y;
      return [px * cs - py * sn + cx0, px * sn + py * cs + cy0];
    };
  }

  // 화면(버퍼)을 다 덮는 조상 선분 찾기
  function findRoot(v, halfDiagUnits) {
    let ax = 0, ay = 0, bx = 1, by = 0;
    let idx = frame.bits.length, level = frame.level;
    let extra = -1;
    for (let k = 0; k < MAX_CLIMB; k++) {
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const len = Math.hypot(bx - ax, by - ay);
      if (extra < 0 && Math.hypot(mx - v.x, my - v.y) + halfDiagUnits <= RADIUS * len) extra = 0;
      if (extra >= EXTRA_LEVELS) break;
      if (extra >= 0) extra++;
      // 한 단계 위로
      const bit = idx > 0 ? frame.bits[idx - 1] : 0;
      if (idx > 0) idx--;
      const sp = signOfDepth(idx);
      const lax = bit === 0 ? 0 : 0, lay = bit === 0 ? 0 : -sp;
      const lbx = 1, lby = bit === 0 ? -sp : 0;
      const dx = bx - ax, dy = by - ay;
      const nax = ax + lax * dx - lay * dy, nay = ay + lax * dy + lay * dx;
      const nbx = ax + lbx * dx - lby * dy, nby = ay + lbx * dy + lby * dx;
      ax = nax; ay = nay; bx = nbx; by = nby;
      level++;
    }
    const H = frame.firstOne >= 0 && frame.firstOne < idx ? frame.level + frame.bits.length - frame.firstOne : null;
    return { ax, ay, bx, by, sign: signOfDepth(idx), level, count: frame.cnt[idx], H };
  }

  function requestRender() {
    if (inflight) return;
    const side = bufferSide();
    const v = { x: cam.x, y: cam.y, s: cam.s, rot: cam.rot };
    // 계속 축소 중이면 렌더가 끝날 즈음의 배율로 미리 넓게 그려 둠 (가장자리가 비지 않게)
    if (!paused && autoMode === 'out') {
      const lat = Math.min(2, Math.max(0.05, renderMs * 1.5 / 1000));
      v.s *= Math.pow(2, -zoomSpeed * lat);
    }
    const sDev = v.s * view.DPR;
    const root = findRoot(v, (side * Math.SQRT1_2) / sDev);
    const map = makeMap(v, sDev, side / 2, side / 2);
    const [ax, ay] = map(root.ax, root.ay);
    const [bx, by] = map(root.bx, root.by);
    // 회전이 들어가면 부호(꺾이는 방향)는 그대로: 회전은 방향을 보존하는 변환
    renderer.post({
      id: ++renderId, w: side, h: side,
      root: { ax, ay, bx, by, sign: root.sign, level: root.level, count: root.count, H: root.H },
      gs, thr: leafPx * view.DPR, radius: RADIUS, pad: 6 * view.DPR,
      glow: 5 * view.DPR, core: 1.3 * view.DPR,
      colors: color.colors, colorsRgb: color.rgb, mode: colorMode, genStep: GEN_STEP, depthStep: DEPTH_STEP,
      maxLeaves: MAX_LEAVES,
    });
    pendingView = v;
    renderStart = performance.now();
    inflight = true;
    forceRender = false;
  }

  renderer.h.onResult = (m) => {
    if (m.kind === 'loop') { onLoopResult(m); return; }
    inflight = false;
    if (m.id !== renderId || !pendingView) { if (m.bitmap.close) m.bitmap.close(); return; }
    if (buf.width !== m.w || buf.height !== m.h) { buf.width = m.w; buf.height = m.h; }
    bufCtx.setTransform(1, 0, 0, 1, 0, 0);
    bufCtx.clearRect(0, 0, m.w, m.h);
    bufCtx.drawImage(m.bitmap, 0, 0);
    if (m.bitmap.close) m.bitmap.close();
    bufView = pendingView;
    pendingView = null;
    lastLeaves = m.leaves;
    renderMs = renderMs * 0.6 + (performance.now() - renderStart) * 0.4;
    dirty = true;
  };

  function needsRender() {
    if (forceRender || !bufView) return true;
    const r = cam.s / bufView.s;
    const autoOut = !paused && autoMode === 'out', autoIn = !paused && autoMode === 'in';
    if ((r > 1.25 && !autoOut) || (autoOut && r > 2)) return true;   // 축소 중엔 미리 작게 그려 둔 걸 쓰므로 확대 쪽 검사 완화
    if (r < 0.8 && !(autoIn && r > 0.5)) return true;
    const side = buf.width;
    const off = Math.hypot(cam.x - bufView.x, cam.y - bufView.y) * cam.s * view.DPR;
    const halfDiag = Math.hypot(view.W, view.H) / 2 * view.DPR;
    return off + halfDiag > (side / 2) * r * 0.97;
  }

  function composite() {
    tCtx.setTransform(1, 0, 0, 1, 0, 0);
    tCtx.clearRect(0, 0, trail.width, trail.height);
    if (!bufView) return;
    const DPR = view.DPR;
    tCtx.imageSmoothingEnabled = true;
    tCtx.imageSmoothingQuality = cam.s < bufView.s ? 'high' : 'low';
    tCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    tCtx.translate(view.W / 2, view.H / 2);
    tCtx.rotate(cam.rot);
    tCtx.scale(cam.s, cam.s);
    tCtx.translate(-cam.x, -cam.y);
    // 버퍼 픽셀 → 프레임 좌표
    tCtx.translate(bufView.x, bufView.y);
    tCtx.rotate(-bufView.rot);
    const inv = 1 / (bufView.s * DPR);
    tCtx.scale(inv, inv);
    tCtx.translate(-buf.width / 2, -buf.height / 2);
    tCtx.drawImage(buf, 0, 0);
    tCtx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---------------------------------------------------------
  // 카메라 조작
  // ---------------------------------------------------------
  function screenToFrame(sx, sy) {
    const dx = sx - view.W / 2, dy = sy - view.H / 2;
    const c = Math.cos(-cam.rot), s = Math.sin(-cam.rot);
    return [(dx * c - dy * s) / cam.s + cam.x, (dx * s + dy * c) / cam.s + cam.y];
  }

  function zoomAt(sx, sy, factor) {
    const [wx, wy] = screenToFrame(sx, sy);
    cam.s *= factor;
    // 자기 닮음 보정: √2배 확대 = −45°·부호 회전과 같은 그림
    if (counterRotate) cam.rot += -gs * (Math.PI / 2) * Math.log2(factor);
    // 커서 아래 점이 그대로 있도록 중심 이동
    const dx = sx - view.W / 2, dy = sy - view.H / 2;
    const c = Math.cos(-cam.rot), s = Math.sin(-cam.rot);
    cam.x = wx - (dx * c - dy * s) / cam.s;
    cam.y = wy - (dx * s + dy * c) / cam.s;
    rebase();
    dirty = true;
  }

  function panBy(dxPx, dyPx) {
    const c = Math.cos(-cam.rot), s = Math.sin(-cam.rot);
    cam.x -= (dxPx * c - dyPx * s) / cam.s;
    cam.y -= (dxPx * s + dyPx * c) / cam.s;
    dirty = true;
  }

  // 계속 확대할 때 화면 가운데가 곡선 위에 머물도록: 가운데에서 가장 가까워 보이는 쪽으로 내려가며 곡선 위의 점 찾기
  function nearestCurvePoint(px, py) {
    const halfUnits = Math.hypot(view.W, view.H) / 2 / cam.s;
    const root = findRoot(cam, halfUnits);
    let ax = root.ax, ay = root.ay, bx = root.bx, by = root.by, sig = root.sign;
    const stopLen = 2 / cam.s;     // 화면에서 2px
    for (let i = 0; i < 200; i++) {
      const dx = bx - ax, dy = by - ay;
      if (Math.hypot(dx, dy) < stopLen) break;
      const qx = (ax + bx) / 2 - sig * dy / 2, qy = (ay + by) / 2 + sig * dx / 2;
      // 두 자식 중 카메라에 더 가까운 원(중점+반지름) 쪽으로
      const m0x = (ax + qx) / 2, m0y = (ay + qy) / 2, m1x = (qx + bx) / 2, m1y = (qy + by) / 2;
      const d0 = Math.hypot(m0x - px, m0y - py), d1 = Math.hypot(m1x - px, m1y - py);
      if (d0 <= d1) { bx = qx; by = qy; sig = gs; } else { ax = qx; ay = qy; sig = -gs; }
    }
    return [(ax + bx) / 2, (ay + by) / 2];
  }

  function bindInput() {
    const pointers = new Map();
    let pinch = null;
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
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      }
    });
    overlay.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const cur = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, cur);
      if (pointers.size === 1) panBy(cur.x - prev.x, cur.y - prev.y);
      else if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        panBy(mx - pinch.mx, my - pinch.my);
        zoomAt(mx, my, d / pinch.d);
        pinch = { d, mx, my };
      }
    });
    const end = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) overlay.classList.remove('dragging');
    };
    overlay.addEventListener('pointerup', end);
    overlay.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------
  // 처음 위치: 세대 12 곡선 전체가 보이게
  // ---------------------------------------------------------
  function goHome() {
    zoomOffset = 0; looping = false; loop.hold = false; loop.n = 0;
    frame.level = 12; frame.bits = []; frame.cnt = [0]; frame.firstOne = -1;
    bufView = null; pendingView = null; renderId++; inflight = false;
    // 왼쪽 사슬 12세대 선분 (0,0)→(1,0)의 곡선 범위를 계산해서 화면에 맞춤
    const pts = [];
    (function d(ax, ay, bx, by, sig, lv) {
      if (lv === 0) { pts.push(bx, by); return; }
      const dx = bx - ax, dy = by - ay, qx = (ax + bx) / 2 - sig * dy / 2, qy = (ay + by) / 2 + sig * dx / 2;
      d(ax, ay, qx, qy, gs, lv - 1); d(qx, qy, bx, by, -gs, lv - 1);
    })(0, 0, 1, 0, gs, 12);
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
    }
    const inset = rightInset();
    cam.rot = 0;
    cam.s = Math.min((view.W - inset * 2 - 80) / (maxX - minX), (view.H - 80) / (maxY - minY));
    cam.x = (minX + maxX) / 2;           // 곡선 가운데 = 화면 정중앙
    cam.y = (minY + maxY) / 2;
    absZoom0 = absZoom();
    rebase();
    forceRender = true; dirty = true;
  }

  function rightInset() {
    const panel = document.getElementById('panel');
    if (!panel || panel.classList.contains('collapsed') || view.W <= 720) return 0;
    return Math.max(0, view.W - panel.getBoundingClientRect().left);
  }

  // ---------------------------------------------------------
  // 무한 루프 (시작점 중심)
  // 드래곤 커브는 시작점을 중심으로 2배 확대하면 90° 돌아간 똑같은 그림이 된다.
  // → 그림을 한 장만 그려 두고, 바깥은 그 그림을 확대해서, 가운데는 같은 그림을
  //   절반 크기로 줄이고 90° 돌려서 겹쳐 그리면 새로 그리지 않고도 끝없이 확대·축소된다.
  // ---------------------------------------------------------
  const LOOP_R = 1.25;          // 루프 그림 반지름 = 화면 반대각선 × 이 값
  const LOOP_Q = 1.2;           // 루프 그림 해상도 여유 (확대돼도 덜 흐리게)
  let loopOn = params.get('loop') !== '0';
  const loop = {
    f: 0, n: 0,                  // 배율 = 2^(n+f), f는 0~1
    s0: 300,                     // f=0일 때 프레임 단위 크기 (CSS px)
    img: document.createElement('canvas'),
    ready: false, key: '', reqId: 0, inflight: false, pendingKey: '',
    hold: false,                 // 루프를 끝낸 직후 자유 모드 그림이 올 때까지 루프 그림 유지
  };
  const tmpA = document.createElement('canvas'), tmpACtx = tmpA.getContext('2d');
  const tmpB = document.createElement('canvas'), tmpBCtx = tmpB.getContext('2d');
  let zoomOffset = 0;            // 루프를 거치며 생략된 배율(표시용)
  let looping = false;

  const wantLoop = () => loopOn && autoMode !== 'stop';
  const loopKey = () => [color.paletteKey, color.seed, colorMode, leafPx, gs, view.W, view.H, view.DPR].join('|');

  function enterLoop() {
    looping = true;
    // 왼쪽 사슬(시작점에서 무한히 커지는 선분들) 위의 프레임, 시작점 = (0,0)
    frame.level = 0; frame.bits = []; frame.cnt = [0]; frame.firstOne = -1;
    bufView = null; pendingView = null; renderId++; inflight = false;
    loop.s0 = Math.min(view.W, view.H) * 0.45;
    // 현재 배율의 소수 부분은 이어 가고, 정수 부분은 표시용으로만 기억
    const z = absZoom() + zoomOffset;
    loop.n = Math.floor(z - Math.log2(loop.s0));
    loop.f = z - Math.log2(loop.s0) - loop.n;
    zoomOffset = 0;
    cam.x = 0; cam.y = 0; cam.s = loop.s0 * Math.pow(2, loop.f);
    loop.hold = false;
    if (loop.key !== loopKey()) requestLoopImage();
    dirty = true;
  }

  // 루프 끝: 지금 보이는 그림과 똑같은 자유 모드 상태로 넘겨줌
  function exitLoop() {
    looping = false;
    cam.x = 0; cam.y = 0;
    cam.s = loop.s0 * Math.pow(2, loop.f);
    cam.rot = (cam.rot + loop.n * gs * Math.PI / 2) % (Math.PI * 2);
    zoomOffset += loop.n;
    loop.n = 0;
    loop.hold = loop.ready;
    forceRender = true;
    rebase();
    dirty = true;
  }

  function requestLoopImage() {
    if (loop.inflight) { loop.pendingKey = 'again'; return; }
    const halfDiag = Math.hypot(view.W, view.H) / 2 * view.DPR;
    let side = Math.round(2 * LOOP_R * halfDiag * LOOP_Q);
    side = Math.min(side, Math.floor(Math.sqrt(48e6)), 12000);
    const q = side / (2 * LOOP_R * halfDiag);             // 실제 해상도 여유
    const sDev = loop.s0 * view.DPR * q;                   // f=0 배율 × 여유
    // 왼쪽 사슬 프레임(레벨 0) 기준으로 화면을 덮는 조상 찾기
    const saved = { level: frame.level, bits: frame.bits, cnt: frame.cnt, firstOne: frame.firstOne };
    frame.level = 0; frame.bits = []; frame.cnt = [0]; frame.firstOne = -1;
    const v = { x: 0, y: 0, s: sDev / view.DPR, rot: 0 };
    const root = findRoot(v, (side * Math.SQRT1_2) / sDev);
    Object.assign(frame, saved);
    const map = makeMap(v, sDev, side / 2, side / 2);
    const [ax, ay] = map(root.ax, root.ay);
    const [bx, by] = map(root.bx, root.by);
    loop.reqId++;
    loop.inflight = true;
    loop.pendingKey = loopKey();
    loop.q = q;
    renderer.post({
      id: loop.reqId, kind: 'loop', w: side, h: side, relGen: true,
      root: { ax, ay, bx, by, sign: root.sign, level: root.level, count: root.count, H: root.H },
      gs, thr: leafPx * view.DPR * q, radius: RADIUS, pad: 6 * view.DPR,
      glow: 5 * view.DPR, core: 1.3 * view.DPR,
      colors: color.colors, colorsRgb: color.rgb, mode: colorMode, genStep: GEN_STEP, depthStep: DEPTH_STEP,
      maxLeaves: MAX_LEAVES,
    });
  }

  function onLoopResult(m) {
    loop.inflight = false;
    const again = loop.pendingKey === 'again' || loop.pendingKey !== loopKey();
    if (m.id === loop.reqId && !again) {
      const c = loop.img;
      if (c.width !== m.w || c.height !== m.h) { c.width = m.w; c.height = m.h; }
      const cx = c.getContext('2d');
      cx.clearRect(0, 0, m.w, m.h);
      cx.drawImage(m.bitmap, 0, 0);
      loop.ready = true;
      loop.key = loopKey();
      loop.qReady = loop.q;
      lastLeaves = m.leaves;
      dirty = true;
    }
    if (m.bitmap.close) m.bitmap.close();
    if (again) requestLoopImage();
  }

  // 한 레이어: 루프 그림을 배율 k, 회전 rot로 화면 중앙에 그림
  function drawLoopLayer(ctx, k, rot) {
    const img = loop.img;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.translate(trail.width / 2, trail.height / 2);
    ctx.rotate(rot);
    ctx.scale(k, k);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = k < 1 ? 'high' : 'low';
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function compositeLoop() {
    tCtx.setTransform(1, 0, 0, 1, 0, 0);
    tCtx.clearRect(0, 0, trail.width, trail.height);
    if (!loop.ready) return;
    for (const c of [tmpA, tmpB]) if (c.width !== trail.width || c.height !== trail.height) { c.width = trail.width; c.height = trail.height; }
    const f = looping ? loop.f : Math.log2(cam.s / loop.s0);
    const n = looping ? loop.n : 0;
    const phi = cam.rot + n * gs * Math.PI / 2;
    const kA = Math.pow(2, f) / loop.qReady;               // 바깥: 그림을 확대
    const kB = kA / 2;                                      // 가운데: 절반 크기 + 90° 회전 (= 같은 그림)
    const rB = (loop.img.width / 2) * kB;
    const cx = trail.width / 2, cy = trail.height / 2;
    const mask = (ctx) => {
      const g = ctx.createRadialGradient(cx, cy, rB * 0.72, cx, cy, rB * 0.98);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, trail.width, trail.height);
      ctx.globalCompositeOperation = 'source-over';
    };
    drawLoopLayer(tmpACtx, kA, phi);
    tmpACtx.globalCompositeOperation = 'destination-out'; mask(tmpACtx);   // 바깥만 남김
    drawLoopLayer(tmpBCtx, kB, phi + gs * Math.PI / 2);
    tmpBCtx.globalCompositeOperation = 'destination-in'; mask(tmpBCtx);    // 가운데만 남김
    tCtx.drawImage(tmpA, 0, 0);
    tCtx.drawImage(tmpB, 0, 0);
  }

  // ---------------------------------------------------------
  // 메인 루프
  // ---------------------------------------------------------
  let lastT = performance.now();
  function frameLoop(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    if (wantLoop() && !looping) enterLoop();
    else if (!wantLoop() && looping) exitLoop();

    if (looping) {
      // 무한 루프: 새로 그리지 않고 배율만 바꿈
      if (!paused) {
        const dz = (autoMode === 'in' ? 1 : -1) * zoomSpeed * dt;
        loop.f += dz;
        if (counterRotate) cam.rot += -gs * (Math.PI / 2) * dz;
        while (loop.f >= 1) { loop.f -= 1; loop.n++; }
        while (loop.f < 0) { loop.f += 1; loop.n--; }
        cam.s = loop.s0 * Math.pow(2, loop.f);
      }
      if ((!loop.ready || loop.key !== loopKey()) && !loop.inflight) requestLoopImage();
      compositeLoop();
    } else {
      if (!paused && autoMode !== 'stop') {
        const f = Math.pow(2, (autoMode === 'in' ? 1 : -1) * zoomSpeed * dt);
        const cx = view.W / 2, cy = view.H / 2;           // 화면 정중앙을 기준으로
        zoomAt(cx, cy, f);
        if (autoMode === 'in' && followCurve) {
          // 화면 가운데를 곡선 위로 천천히 끌어당김
          const [ccx, ccy] = screenToFrame(cx, cy);
          const [tx, ty] = nearestCurvePoint(ccx, ccy);
          const k = 1 - Math.exp(-dt * 2.5);
          cam.x += (tx - ccx) * k; cam.y += (ty - ccy) * k;
        }
      }
      if (needsRender()) requestRender();
      if (loop.hold && bufView) loop.hold = false;
      if (loop.hold) compositeLoop();
      else if (dirty) { composite(); dirty = false; }
    }
    drawCrosshair();
    updateHud();
    requestAnimationFrame(frameLoop);
  }

  // 자동 확대·축소의 중심(화면 정중앙) 표시
  function drawCrosshair() {
    const W = view.W, H = view.H;
    oCtx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
    oCtx.clearRect(0, 0, W, H);
    if (paused || autoMode === 'stop') return;
    const x = W / 2, y = H / 2;
    oCtx.strokeStyle = 'rgba(255,255,255,0.55)';
    oCtx.lineWidth = 1;
    oCtx.beginPath();
    oCtx.moveTo(x - 14, y); oCtx.lineTo(x - 5, y);
    oCtx.moveTo(x + 5, y); oCtx.lineTo(x + 14, y);
    oCtx.moveTo(x, y - 14); oCtx.lineTo(x, y - 5);
    oCtx.moveTo(x, y + 5); oCtx.lineTo(x, y + 14);
    oCtx.stroke();
  }

  // ---------------------------------------------------------
  // HUD & 컨트롤
  // ---------------------------------------------------------
  const elZoom = document.getElementById('zoomNow');
  const elLeaves = document.getElementById('statLeaves');
  const elStatus = document.getElementById('statStatus');
  let hudKey = '';
  function updateHud() {
    const z = absZoom() + zoomOffset + (looping ? loop.n : 0) - absZoom0;
    const key = z.toFixed(1) + '|' + lastLeaves + '|' + autoMode + paused + color.paletteKey + color.seed;
    if (key === hudKey) return;
    hudKey = key;
    const zz = Math.abs(z) < 0.05 ? 0 : z;
    elZoom.textContent = zz === 0 ? '×1' : zz > 0 ? `×2^${zz.toFixed(1)}` : `÷2^${(-zz).toFixed(1)}`;
    elZoom.style.color = color.colors[Math.floor(((zz * 0.05) % 1 + 1) % 1 * K)];
    elLeaves.textContent = lastLeaves.toLocaleString('ko-KR');
    elStatus.textContent = paused || autoMode === 'stop' ? '멈춤' : autoMode === 'in' ? '계속 확대 중' : '계속 축소 중';
  }

  const autoHint = document.getElementById('autoHint');
  const AUTO_HINT = {
    out: '곡선이 끝없이 펼쳐지며 멀어져요.',
    stop: '마우스로 자유롭게 확대·축소해 보세요. 끝이 없어요.',
    in: '화면 가운데의 곡선 속으로 끝없이 파고들어요.',
    loop: '시작점을 중심으로 끊김 없이 무한 반복돼요. 새로 그리지 않아서 아주 부드러워요.',
  };
  function updateAutoHint() {
    autoHint.textContent = autoMode !== 'stop' && loopOn ? AUTO_HINT.loop : AUTO_HINT[autoMode];
  }
  const setAutoSeg = NK.bindSeg(document.getElementById('autoSeg'), 'auto', a => {
    autoMode = a; paused = false; setAutoSeg(a); updateAutoHint(); syncUrl();
  });

  const zsIn = document.getElementById('zspeed');
  const zsLabel = document.getElementById('zspeedLabel');
  function updateZoomSpeed() {
    zoomSpeed = 0.05 * Math.pow(60, parseFloat(zsIn.value) / 100);     // 0.05 ~ 3 옥타브/초
    zsLabel.textContent = `${Math.pow(2, zoomSpeed).toFixed(2)}배/초`;
  }
  zsIn.addEventListener('input', updateZoomSpeed);

  const chkLoop = document.getElementById('chkLoop');
  chkLoop.addEventListener('change', () => { loopOn = chkLoop.checked; updateAutoHint(); syncUrl(); });

  const chkFollow = document.getElementById('chkFollow');
  chkFollow.addEventListener('change', () => { followCurve = chkFollow.checked; syncUrl(); });

  const chkCounter = document.getElementById('chkCounter');
  chkCounter.addEventListener('change', () => { counterRotate = chkCounter.checked; syncUrl(); });

  const leafIn = document.getElementById('leafPx');
  const leafLabel = document.getElementById('leafLabel');
  let leafTimer = 0;
  leafIn.addEventListener('input', () => {
    leafLabel.textContent = leafIn.value + 'px';
    clearTimeout(leafTimer);
    leafTimer = setTimeout(() => { leafPx = parseFloat(leafIn.value); forceRender = true; loop.key = ''; syncUrl(); }, 100);
  });

  const setDirSeg = NK.bindSeg(document.getElementById('dirSeg'), 'dir', d => {
    const s = d === 'ccw' ? -1 : 1;
    if (s === gs) return;
    gs = s; setDirSeg(d); loop.key = ''; loop.ready = false; goHome(); syncUrl();
  });

  const cmHint = document.getElementById('colorModeHint');
  const CM_HINT = {
    depth: '선이 뒤 절반으로 접힐 때마다 색이 조금씩 바뀌어요. 확대할수록 색이 계속 흘러가요.',
    gen: '세대 모드처럼, 어느 세대에서 복사된 부분인지에 따라 색이 정해져요.',
  };
  const setCmSeg = NK.bindSeg(document.getElementById('colorModeSeg'), 'cm', cm => {
    colorMode = cm; setCmSeg(cm); cmHint.textContent = CM_HINT[cm]; forceRender = true; loop.key = ''; syncUrl();
  });

  NK.bindColorControls(color, { palette: 'paletteSel', gradBar: 'gradBar', seed: 'seedInput', reseed: 'btnReseed' }, () => {
    forceRender = true; loop.key = ''; syncUrl();
  });

  document.getElementById('btnHome').addEventListener('click', goHome);
  NK.bindPanelToggle();

  function syncUrl() {
    const p = { seed: color.seed, pal: color.paletteKey, cm: colorMode, dir: gs < 0 ? 'ccw' : 'cw', auto: autoMode, leaf: leafPx };
    if (counterRotate) p.cr = 1;
    if (!followCurve) p.follow = 0;
    if (!loopOn) p.loop = 0;
    NK.writeParams(p);
    // 세대 모드로 갈 때 색 설정 유지
    document.getElementById('linkFinite').href = `index.html?seed=${color.seed}&pal=${color.paletteKey}&dir=${gs < 0 ? 'ccw' : 'cw'}`;
  }

  window.addEventListener('keydown', e => {
    if (NK.isTyping(e)) return;
    switch (e.key) {
      case ' ': e.preventDefault(); paused = !paused; break;
      case 'r': case 'R': goHome(); break;
      case 'c': case 'C': chkCounter.click(); break;
      case '+': case '=': zoomAt(view.W / 2, view.H / 2, 1.25); break;
      case '-': case '_': zoomAt(view.W / 2, view.H / 2, 0.8); break;
    }
  });
  window.addEventListener('resize', () => { resize(); rebase(); });

  // ---------------------------------------------------------
  // 시작
  // ---------------------------------------------------------
  resize();
  bindInput();
  chkCounter.checked = counterRotate;
  leafIn.value = leafPx; leafLabel.textContent = leafPx + 'px';
  chkFollow.checked = followCurve;
  chkLoop.checked = loopOn;
  setAutoSeg(autoMode); updateAutoHint();
  setDirSeg(gs < 0 ? 'ccw' : 'cw');
  setCmSeg(colorMode); cmHint.textContent = CM_HINT[colorMode];
  updateZoomSpeed();
  goHome();
  syncUrl();
  requestAnimationFrame(frameLoop);
})();
