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
  let absZoom0 = 0;            // 처음 배율 (표시용)

  // 프레임 바꾸기: 새 좌표 q = (p − A) / D  (복소수)
  function changeFrame(ax, ay, dx, dy) {
    const d2 = dx * dx + dy * dy;
    const mag = Math.sqrt(d2), ang = Math.atan2(dy, dx);
    const px = cam.x - ax, py = cam.y - ay;
    cam.x = (px * dx + py * dy) / d2;
    cam.y = (py * dx - px * dy) / d2;
    cam.s *= mag;
    cam.rot = (cam.rot + ang) % (Math.PI * 2);
    // 타일 앵커도 같이: a' = a/D, b' = (b − A)/D
    for (const an of anchors) {
      const ar = an.ar, ai = an.ai, br = an.br - ax, bi = an.bi - ay;
      an.ar = (ar * dx + ai * dy) / d2; an.ai = (ai * dx - ar * dy) / d2;
      an.br = (br * dx + bi * dy) / d2; an.bi = (bi * dx - br * dy) / d2;
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
      if (m.opaque) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, m.w, m.h); }   // 타일은 불투명: 겹쳐 그리면 덮어씀

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
      const out = { id: m.id, kind: m.kind, key: m.key, gen: m.gen, leaves, bitmap, w: m.w, h: m.h };
      if (canvas.transferToImageBitmap) port.postMessage(out, [bitmap]); else port.postMessage(out);
    };
  }

  // 렌더 작업자 여러 개 (CPU 코어를 나눠 씀)
  const pool = (() => {
    const h = { onResult: null };
    const workers = [];
    try {
      if (typeof OffscreenCanvas === 'undefined' || !OffscreenCanvas.prototype.transferToImageBitmap) throw new Error('no offscreen');
      const src = '(' + infRenderer.toString() + ')(self, (w, h) => new OffscreenCanvas(w, h));';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
      for (let i = 0; i < n; i++) {
        const wk = new Worker(url);
        const w = { busy: 0, post: (m) => wk.postMessage(m) };
        wk.onmessage = (e) => { w.busy--; h.onResult && h.onResult(e.data); };
        workers.push(w);
      }
    } catch (err) {
      const port = { onmessage: null, postMessage: null };
      const w = { busy: 0, post: (m) => port.onmessage({ data: m }) };
      port.postMessage = (m) => setTimeout(() => { w.busy--; h.onResult && h.onResult(m); }, 0);
      infRenderer(port, (ww, hh) => { const c = document.createElement('canvas'); c.width = ww; c.height = hh; return c; });
      workers.push(w);
    }
    return {
      h, workers,
      idle(maxBusy) { let best = null; for (const w of workers) if (w.busy < maxBusy && (!best || w.busy < best.busy)) best = w; return best; },
      post(w, m) { w.busy++; w.post(m); },
    };
  })();

  // ---------------------------------------------------------
  // 화면
  // ---------------------------------------------------------
  const trail = document.getElementById('trail');
  const overlay = document.getElementById('overlay');
  const tCtx = trail.getContext('2d');
  const oCtx = overlay.getContext('2d');
  const view = { W: 0, H: 0, DPR: 1 };
  let dirty = true, lastLeaves = 0;

  function resize() {
    const oldDpr = view.DPR;
    view.DPR = Math.min(window.devicePixelRatio || 1, 2);
    view.W = window.innerWidth; view.H = window.innerHeight;
    for (const c of [trail, overlay]) { c.width = Math.round(view.W * view.DPR); c.height = Math.round(view.H * view.DPR); }
    if (oldDpr !== view.DPR && typeof invalidateTiles === 'function') invalidateTiles();
    dirty = true;
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

  // ---------------------------------------------------------
  // 타일 (자유 탐색용)
  // 화면을 정사각형 타일로 나눠 각각 따로 그려 두고 재사용한다.
  // 확대하면 타일 하나 → 더 세밀한 타일 4개, 축소하면 4개 → 큰 타일 1개.
  // 아직 안 그려진 곳은 이미 있는 큰(흐린) 타일이나 작은 타일로 메꾼다.
  // 타일 격자는 "앵커" 좌표계에 고정 → 기준 선분이 바뀌어도 타일을 계속 쓸 수 있음.
  // ---------------------------------------------------------
  const TILE = 384;             // 타일 한 변 (기기 px)
  const TMARGIN = 24;           // 타일 가장자리 여유 (번짐이 잘리지 않게, 그린 뒤 잘라냄)
  const TW = TILE + TMARGIN * 2;
  const MAX_TILES = 360;
  const tiles = new Map();      // key → { anc, L, i, j, bmp }
  let staleTiles = [];          // 설정 바뀌기 전 타일 (새 타일이 올 때까지 밑에 깔아 둠)
  let tileGen = 0;
  const tileInflight = new Set();
  let anchors = [];             // 앵커: 격자 좌표 → 프레임 좌표, z_f = a·z_g + b (복소수)
  let anchor = null, anchorSeq = 0;
  let tileNeed = 0, tileHave = 0, coverageComplete = false;

  function newAnchor() {
    anchor = { id: ++anchorSeq, ar: 1, ai: 0, br: cam.x, bi: cam.y };
    anchors.push(anchor);
  }
  function clearTiles() {
    for (const t of tiles.values()) t.bmp.close && t.bmp.close();
    for (const t of staleTiles) t.bmp.close && t.bmp.close();
    tiles.clear(); staleTiles = []; tileInflight.clear();
    tileGen++;
    anchors = []; newAnchor();
    dirty = true;
  }
  // 색·세밀도 등이 바뀜: 지금 타일은 밑그림으로 남기고 새로 그림
  function invalidateTiles() {
    for (const t of tiles.values()) staleTiles.push(t);
    tiles.clear(); tileInflight.clear();
    tileGen++;
    dirty = true;
  }

  const gridFromFrame = (anc, x, y) => {
    const px = x - anc.br, py = y - anc.bi, d2 = anc.ar * anc.ar + anc.ai * anc.ai;
    return [(px * anc.ar + py * anc.ai) / d2, (py * anc.ar - px * anc.ai) / d2];
  };

  function requestTile(w, L, i, j, key) {
    const anc = anchor;
    const u = Math.pow(2, -L);
    const gx = (i + 0.5) * u, gy = (j + 0.5) * u;
    const fx = anc.ar * gx - anc.ai * gy + anc.br, fy = anc.ar * gy + anc.ai * gx + anc.bi;
    const amag = Math.hypot(anc.ar, anc.ai);
    const sDev = TILE / (u * amag);
    const v = { x: fx, y: fy, s: sDev / view.DPR, rot: -Math.atan2(anc.ai, anc.ar) };
    const root = findRoot(v, (TW * Math.SQRT1_2) / sDev);
    const map = makeMap(v, sDev, TW / 2, TW / 2);
    const [ax, ay] = map(root.ax, root.ay);
    const [bx, by] = map(root.bx, root.by);
    tileInflight.add(key);
    pool.post(w, {
      id: 0, kind: 'tile', key, gen: tileGen, opaque: true, w: TW, h: TW,
      root: { ax, ay, bx, by, sign: root.sign, level: root.level, count: root.count, H: root.H },
      gs, thr: leafPx * view.DPR, radius: RADIUS, pad: 6 * view.DPR,
      glow: 5 * view.DPR, core: 1.3 * view.DPR,
      colors: color.colors, colorsRgb: color.rgb, mode: colorMode, genStep: GEN_STEP, depthStep: DEPTH_STEP,
      maxLeaves: MAX_LEAVES,
      meta: { anc: anc.id, L, i, j },
    });
  }

  function onTileResult(m) {
    tileInflight.delete(m.key);
    if (m.gen !== tileGen || tiles.has(m.key)) { m.bitmap.close && m.bitmap.close(); return; }
    const [ancId, L, i, j] = m.key.split('|').map(Number);
    const anc = anchors.find(a => a.id === ancId);
    if (!anc) { m.bitmap.close && m.bitmap.close(); return; }
    tiles.set(m.key, { anc, L, i, j, bmp: m.bitmap });
    // 오래 안 보인 타일부터 버림
    while (tiles.size + staleTiles.length > MAX_TILES) {
      if (staleTiles.length) { const t = staleTiles.shift(); t.bmp.close && t.bmp.close(); continue; }
      const [k, t] = tiles.entries().next().value;
      tiles.delete(k); t.bmp.close && t.bmp.close();
    }
    dirty = true;
  }

  // 이번 프레임에 필요한 타일 계산 + 요청
  function tilesTick() {
    const amag = Math.hypot(anchor.ar, anchor.ai);
    const [cgx, cgy] = gridFromFrame(anchor, cam.x, cam.y);
    // 앵커가 너무 멀어지거나 배율 차이가 커지면 새 앵커 (정밀도 유지)
    if (amag > 4096 || amag < 1 / 4096 || Math.hypot(cgx, cgy) * amag > 64) {
      newAnchor();
      return tilesTick();
    }
    const pg = Math.hypot(anchor.ar, anchor.ai) * cam.s * view.DPR;   // 기기 px / 격자 단위
    const L = Math.round(Math.log2(pg / TILE));
    // 화면 네 모서리 → 격자 좌표 범위
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [sx, sy] of [[0, 0], [view.W, 0], [0, view.H], [view.W, view.H]]) {
      const [fx, fy] = screenToFrame(sx, sy);
      const [gx, gy] = gridFromFrame(anchor, fx, fy);
      minX = Math.min(minX, gx); maxX = Math.max(maxX, gx);
      minY = Math.min(minY, gy); maxY = Math.max(maxY, gy);
    }
    const listFor = (Lx, margin) => {
      const u = Math.pow(2, -Lx);
      const i0 = Math.floor(minX / u) - margin, i1 = Math.floor(maxX / u) + margin;
      const j0 = Math.floor(minY / u) - margin, j1 = Math.floor(maxY / u) + margin;
      const out = [];
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 600) return out;
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        out.push({ L: Lx, i, j, key: `${anchor.id}|${Lx}|${i}|${j}`, d: Math.hypot((i + 0.5) * u - cgx, (j + 0.5) * u - cgy) });
      }
      return out;
    };
    const touch = (n) => { const t = tiles.get(n.key); if (t) { tiles.delete(n.key); tiles.set(n.key, t); } return t; };
    // 1) 한 단계 큰 타일(개수 1/4)로 화면+주변을 먼저 빠르게 덮고  2) 그다음 화면 해상도 타일
    const coarse = listFor(L - 1, 1);
    const need = listFor(L, 0);
    tileNeed = need.length;
    tileHave = 0;
    for (const n of need) if (touch(n)) tileHave++;
    coverageComplete = tileHave === tileNeed && tileNeed > 0;
    const todo = [];
    const coarseMissing = coarse.filter(n => !touch(n) && !tileInflight.has(n.key)).sort((p, q) => p.d - q.d);
    const fineMissing = need.filter(n => !tiles.has(n.key) && !tileInflight.has(n.key)).sort((p, q) => p.d - q.d);
    // 화면 안쪽 큰 타일 → 화면 해상도 타일 → 화면 밖 여유 큰 타일
    const u1 = Math.pow(2, -(L - 1));
    const inView = (n) => (n.i + 1) * u1 > minX && n.i * u1 < maxX && (n.j + 1) * u1 > minY && n.j * u1 < maxY;
    todo.push(...coarseMissing.filter(inView), ...fineMissing, ...coarseMissing.filter(n => !inView(n)));
    for (const n of todo) {
      const w = pool.idle(2);
      if (!w) break;
      requestTile(w, n.L, n.i, n.j, n.key);
    }
  }

  pool.h.onResult = (m) => {
    if (m.kind === 'loop') onLoopResult(m);
    else if (m.kind === 'tile') onTileResult(m);
  };

  // 타일 합성: 큰(거친) 타일부터 그리고 작은(세밀한) 타일로 덮음
  function compositeTiles() {
    const DPR = view.DPR;
    tCtx.setTransform(1, 0, 0, 1, 0, 0);
    tCtx.clearRect(0, 0, trail.width, trail.height);
    const list = [];
    const halfDiag = Math.hypot(view.W, view.H) / 2;
    const addAll = (arr, stale) => {
      for (const t of arr) {
        const u = Math.pow(2, -t.L);
        const amag = Math.hypot(t.anc.ar, t.anc.ai);
        const side = u * amag * cam.s;                  // 화면 CSS px
        if (side < 6) continue;
        const gx = (t.i + 0.5) * u, gy = (t.j + 0.5) * u;
        const fx = t.anc.ar * gx - t.anc.ai * gy + t.anc.br, fy = t.anc.ar * gy + t.anc.ai * gx + t.anc.bi;
        const dist = Math.hypot(fx - cam.x, fy - cam.y) * cam.s;
        if (dist > halfDiag + side) continue;           // 화면 밖
        list.push({ t, side, stale });
      }
    };
    addAll(staleTiles, true);
    addAll(tiles.values(), false);
    list.sort((p, q) => (p.stale !== q.stale ? (p.stale ? -1 : 1) : q.side - p.side));
    tCtx.imageSmoothingEnabled = true;
    let curAnc = null;
    for (const { t, side } of list) {
      if (t.anc !== curAnc) {
        curAnc = t.anc;
        tCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
        tCtx.translate(view.W / 2, view.H / 2);
        tCtx.rotate(cam.rot);
        tCtx.scale(cam.s, cam.s);
        tCtx.translate(-cam.x, -cam.y);
        tCtx.transform(curAnc.ar, curAnc.ai, -curAnc.ai, curAnc.ar, curAnc.br, curAnc.bi);
      }
      tCtx.imageSmoothingQuality = side * DPR < TILE ? 'high' : 'low';
      const u = Math.pow(2, -t.L);
      // 약간 겹치게 그려 타일 사이 틈 방지
      const e = u * 0.002;
      tCtx.drawImage(t.bmp, TMARGIN, TMARGIN, TILE, TILE, t.i * u - e, t.j * u - e, u + 2 * e, u + 2 * e);
    }
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
    clearTiles();
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
    dirty = true;
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

  const wantLoop = () => !glMode && loopOn && autoMode !== 'stop';
  const loopKey = () => [color.paletteKey, color.seed, colorMode, leafPx, gs, view.W, view.H, view.DPR].join('|');

  function enterLoop() {
    looping = true;
    // 왼쪽 사슬(시작점에서 무한히 커지는 선분들) 위의 프레임, 시작점 = (0,0)
    frame.level = 0; frame.bits = []; frame.cnt = [0]; frame.firstOne = -1;
    clearTiles();
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
    pool.post(pool.idle(99), {
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
  // GPU(WebGL2) 렌더링: 매 프레임 정확한 배율로 새로 그림 → 완전히 이어지는 무한 줌
  // CPU는 화면 속 "큰 선분"(인스턴스)만 고르고, GPU가 각각을 2^K개 선의 드래곤 조각으로 펼친다.
  // ---------------------------------------------------------
  const IS_MOBILE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const TPL_K = IS_MOBILE ? 9 : 10;               // 템플릿 깊이 (인스턴스 하나 = 선 2^K개)
  const MAX_INST = 80000;
  const glCanvas = document.getElementById('gl');
  let glr = null;
  if (params.get('gl') !== '0') {
    try { glr = window.DragonGL && window.DragonGL.create(glCanvas); } catch (err) { console.warn('WebGL2 사용 불가', err); glr = null; }
  }
  let glMode = !!glr;
  const instBuf = [new Float32Array(MAX_INST * 7), new Float32Array(MAX_INST * 7)];
  const instCnt = [0, 0];
  const nodeStack = new Float64Array(9 * 400);
  let glPalKey = '', glSegs = 0;

  // 자동 품질 조절: 프레임이 밀리면 촘촘함(선 길이 배수)을 "연속으로" 조금씩 낮추고, 여유 있으면 올림.
  // 촘촘함이 연속으로 변하는 건 확대·축소와 같은 원리라 화면에 이음매가 생기지 않는다.
  // 해상도는 기기에 맞춰 정하고, 촘촘함을 최대로 낮춰도 버거울 때만 한 번 낮춘다.
  const qFix = parseInt(params.get('q'), 10);           // 테스트용: 품질 고정 (0 = 최고)
  const BOOST_MAX = 3;
  let resScale = IS_MOBILE ? 0.75 : 1;
  let boost = 1, boostTarget = Number.isFinite(qFix) ? Math.pow(1.25, Math.max(0, qFix)) : (IS_MOBILE ? 1.25 : 1);
  boost = boostTarget;
  const frameTimes = [];
  let lastQChange = 0, blockUpUntil = 0;
  function adaptQuality(dtMs, now, dt) {
    // 목표 쪽으로 부드럽게 (초당 약 1/3 단계)
    boost *= Math.pow(boostTarget / boost, Math.min(1, dt * 1.5));
    if (!glMode || document.hidden || Number.isFinite(qFix)) return;
    frameTimes.push(dtMs);
    if (frameTimes.length > 240) frameTimes.shift();
    if (frameTimes.length < 60) return;
    let minDt = Infinity; for (const t of frameTimes) if (t >= 3.5 && t < minDt) minDt = t;
    const refresh = Math.max(minDt, IS_MOBILE ? 16.6 : 4);       // 모바일은 60프레임 목표
    let avg20 = 0; for (let i = frameTimes.length - 20; i < frameTimes.length; i++) avg20 += frameTimes[i] / 20;
    const avgAll = frameTimes.reduce((x, y) => x + y, 0) / frameTimes.length;
    if (now - lastQChange > 700 && avg20 > refresh * 1.5) {
      if (boostTarget < BOOST_MAX) boostTarget = Math.min(BOOST_MAX, boostTarget * 1.25);
      else if (resScale > 0.5) resScale = Math.max(0.5, resScale * 0.85);
      lastQChange = now; blockUpUntil = now + 15000; frameTimes.length = 0;
    } else if (now - lastQChange > 3000 && now > blockUpUntil && avgAll < refresh * 1.12 && boostTarget > 1) {
      boostTarget = Math.max(1, boostTarget / 1.25);
      lastQChange = now; frameTimes.length = 0;
    }
  }
  const qualityPct = () => Math.round((resScale / boost) * 100);

  function glFrame() {
    const q = { scale: resScale, boost };
    const w = Math.max(1, Math.round(view.W * view.DPR * q.scale));
    const h = Math.max(1, Math.round(view.H * view.DPR * q.scale));
    glr.resize(w, h);
    glr.setTemplate(TPL_K, gs);
    const pk = color.paletteKey + '|' + color.seed;
    if (pk !== glPalKey) { glr.setPalette(color.rgb); glPalKey = pk; }

    const sDev = cam.s * view.DPR * q.scale;
    const leaf = leafPx * view.DPR * q.scale * q.boost;          // GPU 화면 px 기준 선 길이
    const Lmin = leaf * Math.pow(Math.SQRT2, TPL_K);              // 인스턴스 최소 길이
    const Lsplit2 = (Lmin * Math.SQRT2) ** 2;
    const halfUnits = Math.hypot(view.W, view.H) / 2 / cam.s;
    const root = findRoot(cam, halfUnits);
    const map = makeMap(cam, sDev, w / 2, h / 2);
    const [rax, ray] = map(root.ax, root.ay);
    const [rbx, rby] = map(root.bx, root.by);

    // 화면에 보이는 인스턴스 고르기 (스택으로 나무 내려가기)
    instCnt[0] = instCnt[1] = 0;
    const st = nodeStack;
    let sp = 0;
    const NONE = -1e15;
    const push = (ax, ay, bx, by, sig, lv, cnt, H) => {
      if (sp + 8 > st.length) return;
      st[sp++] = ax; st[sp++] = ay; st[sp++] = bx; st[sp++] = by; st[sp++] = sig; st[sp++] = lv; st[sp++] = cnt; st[sp++] = H;
    };
    push(rax, ray, rbx, rby, root.sign, root.level, root.count, root.H === null ? NONE : root.H);
    let tL = -1;
    const pad = 4;
    while (sp > 0) {
      const H = st[--sp], cnt = st[--sp], lv = st[--sp], sig = st[--sp];
      const by = st[--sp], bx = st[--sp], ay = st[--sp], ax = st[--sp];
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
      const r = Math.sqrt(L2) * RADIUS + pad;
      if (mx + r < 0 || mx - r > w || my + r < 0 || my - r > h) continue;
      if (L2 < Lsplit2) {
        const gi = sig > 0 ? 0 : 1;
        if (instCnt[gi] >= MAX_INST) continue;
        const b = instBuf[gi], o = instCnt[gi] * 7;
        b[o] = ax; b[o + 1] = ay; b[o + 2] = bx; b[o + 3] = by;
        b[o + 4] = H === NONE ? -1 : (((H * GEN_STEP) % 1) + 1) % 1;
        b[o + 5] = (((lv * GEN_STEP) % 1) + 1) % 1;
        b[o + 6] = (((cnt * DEPTH_STEP) % 1) + 1) % 1;
        instCnt[gi]++;
        if (tL < 0) tL = Math.sqrt(L2);
        continue;
      }
      const qx = mx - sig * dy * 0.5, qy = my + sig * dx * 0.5;
      // 스택이라 뒤 절반을 먼저 넣음
      push(qx, qy, bx, by, -gs, lv - 1, cnt + 1, H === NONE ? lv : H);
      push(ax, ay, qx, qy, gs, lv - 1, cnt, H);
    }
    // 지오모핑: 인스턴스 길이가 Lmin→√2·Lmin 로 커지는 동안 마지막 접힘 0→100%
    const t = tL > 0 ? Math.min(1, Math.max(0, 2 * Math.log2(tL / Lmin))) : 0;
    glSegs = (instCnt[0] + instCnt[1]) * (1 << TPL_K);
    glr.render(instBuf, instCnt, {
      t, mode: colorMode === 'gen' ? 0 : 1, genStep: GEN_STEP, depthStep: DEPTH_STEP,
      intensity: 0.9, bloom: 0.32, exposure: 1.25,
    });
  }

  // 시작점(곡선이 시작되는 점)을 화면 정중앙으로: 지금 배율은 유지
  function centerOnOrigin() {
    const z = absZoom();
    const S0 = Math.min(view.W, view.H) * 0.42;
    const lv = -2 * Math.round(z - Math.log2(S0));
    frame.level = lv; frame.bits = []; frame.cnt = [0]; frame.firstOne = -1;
    cam.x = 0; cam.y = 0;
    cam.s = Math.pow(2, z + lv / 2);
    rebase();
    dirty = true;
  }

  function setGlMode(on) {
    glMode = on && !!glr;
    glCanvas.style.display = glMode ? 'block' : 'none';
    trail.style.display = glMode ? 'none' : 'block';
    dirty = true;
  }
  glCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); setGlMode(false); NK.toast('GPU 그리기가 중단돼서 기본 방식으로 바꿨어요'); });

  // ---------------------------------------------------------
  // 메인 루프
  // ---------------------------------------------------------
  let lastT = performance.now();
  function frameLoop(now) {
    const rawDt = now - lastT;
    const dt = Math.min(0.1, rawDt / 1000);
    lastT = now;

    if (glMode) {
      if (!paused && autoMode !== 'stop') {
        const f = Math.pow(2, (autoMode === 'in' ? 1 : -1) * zoomSpeed * dt);
        zoomAt(view.W / 2, view.H / 2, f);
        if (autoMode === 'in' && followCurve && !loopOn) {
          const [ccx, ccy] = screenToFrame(view.W / 2, view.H / 2);
          const [tx, ty] = nearestCurvePoint(ccx, ccy);
          const k = 1 - Math.exp(-dt * 2.5);
          cam.x += (tx - ccx) * k; cam.y += (ty - ccy) * k;
        }
      }
      glFrame();
      adaptQuality(rawDt, now, dt);
      drawCrosshair();
      updateHud();
      requestAnimationFrame(frameLoop);
      return;
    }

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
      tilesTick();
      if (loop.hold && coverageComplete) { loop.hold = false; dirty = true; }
      if (loop.hold) compositeLoop();
      else if (dirty) { compositeTiles(); dirty = false; }
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
    const info = glMode
      ? `GPU · 선 ${glSegs.toLocaleString('ko-KR')}개 · 품질 ${qualityPct()}%`
      : looping || loop.hold
      ? (loop.ready ? `루프 그림 선 ${lastLeaves.toLocaleString('ko-KR')}개` : '루프 그림 그리는 중…')
      : (coverageComplete ? `타일 ${tileHave}개 완료` : `타일 ${tileHave}/${tileNeed} 그리는 중…`);
    const key = z.toFixed(1) + '|' + info + '|' + autoMode + paused + color.paletteKey + color.seed;
    if (key === hudKey) return;
    hudKey = key;
    const zz = Math.abs(z) < 0.05 ? 0 : z;
    elZoom.textContent = zz === 0 ? '×1' : zz > 0 ? `×2^${zz.toFixed(1)}` : `÷2^${(-zz).toFixed(1)}`;
    elZoom.style.color = color.colors[Math.floor(((zz * 0.05) % 1 + 1) % 1 * K)];
    elLeaves.textContent = info;
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
    if (glMode) {
      autoHint.textContent = autoMode === 'stop' ? AUTO_HINT.stop
        : loopOn ? '곡선의 시작점을 중심으로 끝없이 ' + (autoMode === 'in' ? '확대돼요.' : '축소돼요.') + ' 매 프레임 새로 그려서 끊김이 없어요.'
        : '화면 정중앙(＋)을 중심으로 끝없이 ' + (autoMode === 'in' ? '확대돼요.' : '축소돼요.');
      return;
    }
    autoHint.textContent = autoMode !== 'stop' && loopOn ? AUTO_HINT.loop : AUTO_HINT[autoMode];
  }
  const setAutoSeg = NK.bindSeg(document.getElementById('autoSeg'), 'auto', a => {
    const wasStop = autoMode === 'stop';
    autoMode = a; paused = false; setAutoSeg(a); updateAutoHint(); syncUrl();
    if (glMode && loopOn && a !== 'stop' && wasStop) centerOnOrigin();
  });

  const zsIn = document.getElementById('zspeed');
  const zsLabel = document.getElementById('zspeedLabel');
  function updateZoomSpeed() {
    zoomSpeed = 0.05 * Math.pow(60, parseFloat(zsIn.value) / 100);     // 0.05 ~ 3 옥타브/초
    zsLabel.textContent = `${Math.pow(2, zoomSpeed).toFixed(2)}배/초`;
  }
  zsIn.addEventListener('input', updateZoomSpeed);

  const chkLoop = document.getElementById('chkLoop');
  chkLoop.addEventListener('change', () => {
    loopOn = chkLoop.checked; updateAutoHint(); syncUrl();
    if (glMode && loopOn && autoMode !== 'stop') centerOnOrigin();
  });

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
    leafTimer = setTimeout(() => { leafPx = parseFloat(leafIn.value); invalidateTiles(); loop.key = ''; syncUrl(); }, 100);
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
    colorMode = cm; setCmSeg(cm); cmHint.textContent = CM_HINT[cm]; invalidateTiles(); loop.key = ''; syncUrl();
  });

  NK.bindColorControls(color, { palette: 'paletteSel', gradBar: 'gradBar', seed: 'seedInput', reseed: 'btnReseed' }, () => {
    invalidateTiles(); loop.key = ''; syncUrl();
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
  // GPU 모드에서는 "무한 루프" 대신 "시작점 중심"
  if (glr) {
    chkLoop.parentElement.lastChild.textContent = ' 시작점 중심 (소용돌이 무한 줌)';
    const hint = chkLoop.parentElement.nextElementSibling;
    if (hint) hint.textContent = '켜면 곡선의 시작점을 화면 정중앙에 두고 확대·축소해요. 끄면 지금 화면 정중앙(＋)을 기준으로 해요. 어느 쪽이든 매 프레임 새로 그려서 끊김이 없어요.';
    chkFollow.parentElement.lastChild.textContent = ' 시작점 중심을 끈 채 계속 확대할 때 곡선 따라가기';
  }

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
  setGlMode(glMode);
  updateAutoHint();
  goHome();
  if (glMode && loopOn && autoMode !== 'stop') centerOnOrigin();
  syncUrl();
  requestAnimationFrame(frameLoop);
})();
