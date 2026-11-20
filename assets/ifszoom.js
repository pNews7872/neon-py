/* =========================================================
   수열 거북이 무한 확대 엔진 (NeonKit.IfsZoom)

   원리
   · 거북이가 수열 w를 읽으며 그리는 그림에서, 치환 규칙(투에-모스 0→01·1→10,
     피보나치 0→01·1→0)을 q번 적용한 덩어리 하나를 "선분(현) 하나"로 보면
     큰 덩어리 = 작은 덩어리 여러 개를 정해진 위치·각도로 이어 붙인 것.
   · 덩어리가 꺾는 총 각도를 정수(도)로 정확히 따라가며 규칙을 수백 번 돌려서,
     그 배치가 한 모양으로 수렴하면(= 진짜 자기닮음) 그 배치를 그대로 무한 확대에 씀.
     수렴하지 않거나 일직선이 되거나 겹쳐서 면을 채우면 '프랙탈 아님'.
   · 그릴 때는 화면을 덮는 조상 덩어리부터 내려가며, 화면 밖은 건너뛰고,
     선이 몇 px이 되면 직선으로 긋는다. 그 경계에서는 자식들을 부모 직선 쪽으로
     천천히 펴서(모핑) 디테일이 '튀지' 않고 자라나게 함.
   · 숫자 정밀도: 화면 크기쯤 되는 덩어리 하나를 기준(프레임)으로 계속 옮겨 다님.
   ========================================================= */
(function (global) {
  'use strict';
  const NK = global.NeonKit;
  const K = NK.K;

  // ---------------------------------------------------------
  // 1) 자기닮음 배치 계산
  // ---------------------------------------------------------
  const SUBS = { tm: [[0, 1], [1, 0]], fib: [[0, 1], [0]] };
  const E = d => { const r = d * Math.PI / 180; return [Math.cos(r), Math.sin(r)]; };

  function expand(kind, t, q) {
    let w = [t];
    for (let i = 0; i < q; i++) { const n = []; for (const c of w) n.push(...SUBS[kind][c]); w = n; }
    return w;
  }

  // 덩어리 값: [현 x, 현 y, 꺾은 각도(정수 도), 길이 홀짝]
  function analyze(kind, angle) {
    const a = Math.round(angle);
    let v = kind === 'tm'
      ? [[1, 0, 0, 1], [0, 0, a, 1]]
      : [[1, 0, a, 1], [1, 0, 0, 1]];
    const hist = [];
    for (let J = 0; J < 700; J++) {
      const nv = [];
      for (let t = 0; t < 2; t++) {
        let zx = 0, zy = 0, rho = 0, off = 0;
        for (const s of SUBS[kind][t]) {
          let [cx, cy, r, L] = v[s];
          if (kind === 'fib' && (off & 1)) { cy = -cy; r = -r; }
          const [ex, ey] = E(rho);
          zx += ex * cx - ey * cy; zy += ex * cy + ey * cx;
          rho = ((rho + r) % 360 + 360) % 360; off += L;
        }
        nv.push([zx, zy, rho, kind === 'fib' ? off & 1 : 0]);
      }
      const n = Math.max(Math.hypot(nv[0][0], nv[0][1]), Math.hypot(nv[1][0], nv[1][1]), 1e-300);
      for (const x of nv) { x[0] /= n; x[1] /= n; }
      v = nv;
      hist.push(v);
    }
    const last = hist[hist.length - 1];
    let q = 0;
    for (let p = 1; p < 60 && !q; p++) {
      const o = hist[hist.length - 1 - p];
      if (o[0][2] === last[0][2] && o[1][2] === last[1][2] && o[0][3] === last[0][3] && o[1][3] === last[1][3]) q = p;
    }
    if (!q) return null;

    // q, 2q, 3q 단계로 펼쳐서 '가운데쯤에 있는, 같은 종류·안 뒤집힌 자식'이 있는 가장 작은 걸 고름
    {
      const qq = q;
      const vJ = hist[hist.length - 1 - qq];
      const lay = [];
      let ok = true;
      for (let t = 0; t < 2 && ok; t++) {
        const ch = expand(kind, t, qq);
        if (ch.length > 600) { ok = false; break; }
        let zx = 0, zy = 0, rho = 0, off = 0;
        const segs = [];
        for (const s of ch) {
          let [cx, cy, r, L] = vJ[s];
          const mir = kind === 'fib' && (off & 1) ? 1 : 0;
          if (mir) { cy = -cy; r = -r; }
          const [ex, ey] = E(rho);
          const dx = ex * cx - ey * cy, dy = ex * cy + ey * cx;
          segs.push([s, mir, zx, zy, zx + dx, zy + dy]);
          zx += dx; zy += dy; rho = ((rho + r) % 360 + 360) % 360; off += L;
        }
        const d2 = zx * zx + zy * zy;
        if (d2 < 1e-18) { ok = false; break; }
        // 부모 현이 (0,0)→(1,0)이 되도록
        for (const sg of segs) {
          for (const k of [2, 4]) {
            const x = sg[k], y = sg[k + 1];
            sg[k] = (x * zx + y * zy) / d2; sg[k + 1] = (y * zx - x * zy) / d2;
          }
        }
        lay.push(segs);
      }
      if (!ok) return null;
      let maxR = 0, flat = true;
      for (const segs of lay) for (const s of segs) {
        maxR = Math.max(maxR, Math.hypot(s[4] - s[2], s[5] - s[3]));
        if (Math.abs(s[3]) > 1e-7 || Math.abs(s[5]) > 1e-7) flat = false;
      }
      if (flat) return { bad: 'line' };
      if (maxR >= 0.985) return { bad: 'nocontract' };
      // 닮음 차원: 행렬 A(D)[t][s] = Σ(t의 자식 중 종류 s) rᵢ^D 의 최대 고윳값이 1이 되는 D
      const rad = (D) => {
        const A = [[0, 0], [0, 0]];
        lay.forEach((segs, t) => segs.forEach(s => { const r = Math.hypot(s[4] - s[2], s[5] - s[3]); if (r > 1e-12) A[t][s[0]] += Math.pow(r, D); }));
        const tr = A[0][0] + A[1][1], det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
        return (tr + Math.sqrt(Math.max(0, tr * tr - 4 * det))) / 2;
      };
      let lo = 0.5, hi = 6;
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (rad(mid) > 1) lo = mid; else hi = mid; }
      const dim = (lo + hi) / 2;
      if (dim > 1.97) return { bad: 'fill', dim };
      // 사슬 경로: 몇 단계 내려가서(자식→손자…) 같은 종류·안 뒤집힌 채 가운데쯤에 있는 덩어리.
      // 그 덩어리로 가는 지도의 고정점이 '확대해도 제자리인 점' (무한 루프의 중심)
      let cpath = null, bestScore = Infinity;
      let frontier = [{ p: [], t: 0, m: 0, ax: 0, ay: 0, bx: 1, by: 0 }];
      for (let depth = 1; depth <= 4 && !cpath; depth++) {
        const next = [];
        for (const nd of frontier) {
          const dx = nd.bx - nd.ax, dy = nd.by - nd.ay;
          lay[nd.t].forEach((sg, i) => {
            let u0y = sg[3], u1y = sg[5];
            if (nd.m) { u0y = -u0y; u1y = -u1y; }
            const ch = {
              p: nd.p.concat(i), t: sg[0], m: nd.m ^ sg[1],
              ax: nd.ax + dx * sg[2] - dy * u0y, ay: nd.ay + dx * u0y + dy * sg[2],
              bx: nd.ax + dx * sg[4] - dy * u1y, by: nd.ay + dx * u1y + dy * sg[4],
            };
            if (ch.t === 0 && ch.m === 0) {
              const sc = Math.abs((ch.ax + ch.bx) / 2 - 0.5) + Math.abs((ch.ay + ch.by) / 2) * 0.5;
              if (sc < 0.22 && sc < bestScore) { bestScore = sc; cpath = ch.p; }
            }
            if (next.length < 6000) next.push(ch);
          });
        }
        frontier = next;
      }
      if (!cpath) return { bad: 'nocenter' };
      return { q: qq, lay, cpath, dim, maxR };
    }
    return { bad: 'nocenter' };
  }

  // 극한 모양을 촘촘히 펼쳐서 종류별 감싸는 원(현 기준) 계산
  function boundsOf(lay) {
    const out = [];
    for (let t0 = 0; t0 < 2; t0++) {
      const pts = [];
      const maxR = Math.max(...lay[t0].map(s => Math.hypot(s[4] - s[2], s[5] - s[3])));
      const minLen = Math.pow(maxR, Math.log(40000) / Math.log(lay[t0].length));
      const st = [[t0, 0, 0, 0, 1, 0]];
      while (st.length && pts.length < 400000) {
        const [t, m, ax, ay, bx, by] = st.pop();
        const dx = bx - ax, dy = by - ay;
        if (Math.hypot(dx, dy) < minLen) { pts.push(ax, ay, bx, by); continue; }
        for (const s of lay[t]) {
          let u0x = s[2], u0y = s[3], u1x = s[4], u1y = s[5];
          if (m) { u0y = -u0y; u1y = -u1y; }
          st.push([s[0], m ^ s[1], ax + dx * u0x - dy * u0y, ay + dx * u0y + dy * u0x, ax + dx * u1x - dy * u1y, ay + dx * u1y + dy * u1x]);
        }
      }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
        y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
      }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      let r = 0;
      for (let i = 0; i < pts.length; i += 2) r = Math.max(r, Math.hypot(pts[i] - cx, pts[i + 1] - cy));
      out.push({ cx, cy, r: r * 1.04 + 0.01 });
    }
    return out;
  }

  // ---------------------------------------------------------
  // 2) 페이지
  // ---------------------------------------------------------
  function IfsZoom(cfg) {
    const params = NK.readParams();
    const color = new NK.ColorState(NK.colorFromParams(params));
    const $ = id => document.getElementById(id);

    let angle = Math.round(parseFloat(params.get('ang')));
    if (!Number.isFinite(angle)) angle = cfg.defaultAngle;
    let auto = ['in', 'out', 'stop'].includes(params.get('auto')) ? params.get('auto') : 'in';
    let loopOn = params.get('loop') !== '0';
    let counter = params.get('cr') !== '0';
    let leafPx = Math.max(1.5, Math.min(16, parseFloat(params.get('leaf')) || 3));
    let zoomRate = 0.5;       // 초당 몇 배(2배 단위)
    let paused = false;

    // IFS
    // F.cpath: 사슬 경로(맨 위 덩어리 → 같은 모양의 다음 사슬 덩어리). 길이 P.
    // 깊이 d인 덩어리의 '위상' = d mod P. 사슬 위 덩어리는 위상 0, 종류 0, 안 뒤집힘.
    let F = null;
    function setupIfs(a) {
      const r = analyze(cfg.kind, a);
      if (!r || r.bad) return r || { bad: 'none' };
      const bounds = boundsOf(r.lay);
      // 사슬 경로를 따라 내려가며 위상별 종류·뒤집힘, 그리고 합쳐진 지도(현)
      const P = r.cpath.length;
      const chTy = [0], chMi = [0];
      let ax = 0, ay = 0, bx = 1, by = 0;
      for (let k = 0; k < P; k++) {
        const sg = r.lay[chTy[k]][r.cpath[k]];
        let u0y = sg[3], u1y = sg[5];
        if (chMi[k]) { u0y = -u0y; u1y = -u1y; }
        const dx = bx - ax, dy = by - ay;
        const nax = ax + dx * sg[2] - dy * u0y, nay = ay + dx * u0y + dy * sg[2];
        const nbx = ax + dx * sg[4] - dy * u1y, nby = ay + dx * u1y + dy * sg[4];
        ax = nax; ay = nay; bx = nbx; by = nby;
        chTy.push(sg[0]); chMi.push(chMi[k] ^ sg[1]);
      }
      const cdx = bx - ax, cdy = by - ay;
      // 지도 z → A + (B−A)·z 의 고정점 = A / (1 − (B−A))
      const ox = 1 - cdx, oy = -cdy, o2 = ox * ox + oy * oy;
      const zx = (ax * ox + ay * oy) / o2, zy = (ay * ox - ax * oy) / o2;
      F = {
        lay: r.lay, cpath: r.cpath, P, chTy, chMi, bounds, q: r.q, dim: r.dim,
        n: [r.lay[0].length, r.lay[1].length],
        cax: ax, cay: ay, cdx, cdy, g: 1 / Math.hypot(cdx, cdy), crot: Math.atan2(cdy, cdx), zx, zy,
        maxR: r.maxR,
      };
      pack();
      return null;
    }

    // ---------- 프레임 ----------
    // path: 맨 위 사슬 덩어리에서 프레임까지 내려오는 자식 번호들
    // 색: 깊이 d에서 자식 i로 갈 때 (i − 사슬 번호[d mod P]) / n 만큼 → 사슬 위는 늘 0이라 기준을 옮겨도 색이 그대로
    let path = [], tys = [0], mis = [0], hues = [0];
    const HUE_W = 0.37;
    const phaseOf = d => ((d % F.P) + F.P) % F.P;
    function rebuildPathInfo() {
      // 맨 앞이 사슬 경로 한 바퀴면 떼어도 같은 덩어리 → 짧게 유지
      while (path.length >= F.P && F.cpath.every((v, i) => path[i] === v)) path = path.slice(F.P);
      tys = [0]; mis = [0]; hues = [0];
      for (let d = 0; d < path.length; d++) {
        const sg = F.lay[tys[d]][path[d]];
        tys.push(sg[0]); mis.push(mis[d] ^ sg[1]);
        hues.push(hues[d] + (path[d] - F.cpath[phaseOf(d)]) / F.n[tys[d]] * HUE_W);
      }
    }
    // 깊이 d 덩어리의 [종류, 뒤집힘, 색]. d < 0 이면 맨 위보다 위 = 사슬 위 덩어리들
    const nodeInfo = (d) => d >= 0 ? [tys[d], mis[d], hues[d]] : [F.chTy[phaseOf(d)], F.chMi[phaseOf(d)], 0];

    // 카메라: 프레임 좌표의 중심 (x, y), 배율 s (CSS px / 프레임 단위), 회전 rot
    const cam = { x: 0, y: 0, s: 300, rot: 0 };
    let logZoom = 0;          // 처음 대비 log2 배율 (표시용)

    function changeFrame(ax, ay, dx, dy) {
      const d2 = dx * dx + dy * dy;
      const px = cam.x - ax, py = cam.y - ay;
      cam.x = (px * dx + py * dy) / d2;
      cam.y = (py * dx - px * dy) / d2;
      cam.s *= Math.sqrt(d2);
      cam.rot += Math.atan2(dy, dx);
    }

    // 프레임에서 k단계 위 조상 (프레임 좌표)
    function climb(k) {
      let ax = 0, ay = 0, bx = 1, by = 0, d = path.length;
      for (let j = 0; j < k; j++) {
        let pt, pm, idx;
        if (d > 0) { pt = tys[d - 1]; pm = mis[d - 1]; idx = path[d - 1]; }
        else { const ph = phaseOf(d - 1); pt = F.chTy[ph]; pm = F.chMi[ph]; idx = F.cpath[ph]; }
        d--;
        const sg = F.lay[pt][idx];
        let u0x = sg[2], u0y = sg[3], u1x = sg[4], u1y = sg[5];
        if (pm) { u0y = -u0y; u1y = -u1y; }
        const ux = u1x - u0x, uy = u1y - u0y, u2 = ux * ux + uy * uy;
        const cx = bx - ax, cy = by - ay;
        const Dx = (cx * ux + cy * uy) / u2, Dy = (cy * ux - cx * uy) / u2;   // D_p = (B−A)/(u1−u0)
        const nax = ax - (Dx * u0x - Dy * u0y), nay = ay - (Dx * u0y + Dy * u0x);
        ax = nax; ay = nay; bx = nax + Dx; by = nay + Dy;
      }
      return { ax, ay, bx, by, d };
    }
    function circleOf(t, m, ax, ay, bx, by) {
      const b = F.bounds[t];
      const dx = bx - ax, dy = by - ay;
      const cy = m ? -b.cy : b.cy;
      return { x: ax + dx * b.cx - dy * cy, y: ay + dx * cy + dy * b.cx, r: b.r * Math.hypot(dx, dy) };
    }

    // 프레임을 카메라 근처, 화면 크기쯤 되는 덩어리로 옮기기
    function relocate() {
      const S0 = Math.min(view.W, view.H) * 0.35;
      // 1) 카메라를 감싸고 충분히 큰 조상까지
      let k = 0, anc;
      for (k = 1; k < 200; k++) {
        anc = climb(k);
        const [t, m] = nodeInfo(anc.d);
        const c = circleOf(t, m, anc.ax, anc.ay, anc.bx, anc.by);
        const len = Math.hypot(anc.bx - anc.ax, anc.by - anc.ay) * cam.s;
        if (Math.hypot(c.x - cam.x, c.y - cam.y) < c.r && len > S0 * 2) break;
      }
      // 2) 카메라에 가까운 자식으로 내려가기
      let [t, m] = nodeInfo(anc.d);
      let ax = anc.ax, ay = anc.ay, bx = anc.bx, by = anc.by;
      const desc = [];
      for (let guard = 0; guard < 400; guard++) {
        const len = Math.hypot(bx - ax, by - ay) * cam.s;
        if (len <= S0) break;
        const dx = bx - ax, dy = by - ay;
        let best = null, bs = Infinity;
        F.lay[t].forEach((s, i) => {
          let u0x = s[2], u0y = s[3], u1x = s[4], u1y = s[5];
          if (m) { u0y = -u0y; u1y = -u1y; }
          const cax = ax + dx * u0x - dy * u0y, cay = ay + dx * u0y + dy * u0x;
          const cbx = ax + dx * u1x - dy * u1y, cby = ay + dx * u1y + dy * u1x;
          const cm = m ^ s[1];
          const c = circleOf(s[0], cm, cax, cay, cbx, cby);
          const dd = Math.hypot(c.x - cam.x, c.y - cam.y);
          const score = Math.max(0, dd - c.r) * 1e6 + dd / (c.r + 1e-300);
          if (score < bs) { bs = score; best = [i, s[0], cm, cax, cay, cbx, cby]; }
        });
        desc.push(best[0]); t = best[1]; m = best[2];
        ax = best[3]; ay = best[4]; bx = best[5]; by = best[6];
      }
      path = anc.d >= 0 ? path.slice(0, anc.d).concat(desc) : F.cpath.slice(0, phaseOf(anc.d)).concat(desc);
      changeFrame(ax, ay, bx - ax, by - ay);
      rebuildPathInfo();
    }

    // 무한 루프: 프레임은 늘 사슬 위의 덩어리, 카메라 중심은 사슬 지도의 고정점
    function loopRebase() {
      const S0 = Math.min(view.W, view.H) * 0.35;
      path = []; rebuildPathInfo();
      while (cam.s > S0 * F.g) changeFrame(F.cax, F.cay, F.cdx, F.cdy);
      while (cam.s < S0) { const p = climb(F.P); changeFrame(p.ax, p.ay, p.bx - p.ax, p.by - p.ay); }
      cam.x = F.zx; cam.y = F.zy;
    }

    function resetView() {
      path = []; rebuildPathInfo();
      const S0 = Math.min(view.W, view.H) * 0.35;
      cam.x = F.zx; cam.y = F.zy; cam.s = S0 * Math.sqrt(F.g); cam.rot = 0;
      logZoom = 0;
    }

    // ---------- 그리기 ----------
    const view = { W: 0, H: 0, DPR: 1 };
    let forcedSize = null;
    const glCanvas = $('gl');
    const glr = global.NeonGL && global.NeonGL.create(glCanvas);
    if (!glr) {
      $('statStatus').textContent = 'WebGL2가 필요해요 (이 브라우저에서는 무한 모드를 쓸 수 없어요)';
      return;
    }
    const layer = glr.createSegLayer();
    function resize() {
      view.DPR = forcedSize ? forcedSize.DPR : Math.min(global.devicePixelRatio || 1, 2);
      view.W = forcedSize ? forcedSize.W : global.innerWidth;
      view.H = forcedSize ? forcedSize.H : global.innerHeight;
    }
    global.addEventListener('resize', resize);
    resize();

    let buf = new Float32Array(4 * 200000), cols = new Uint8Array(200000), nSeg = 0;
    function ensureCap(extra) {
      while (nSeg + extra > cols.length) {
        const nb = new Float32Array(buf.length * 2); nb.set(buf); buf = nb;
        const nc = new Uint8Array(cols.length * 2); nc.set(cols); cols = nc;
      }
    }
    function emit(ax, ay, bx, by, c) {
      ensureCap(1);
      const o = nSeg * 4;
      buf[o] = ax; buf[o + 1] = ay; buf[o + 2] = bx; buf[o + 3] = by;
      cols[nSeg++] = c;
    }

    const MAX_LEAVES = 900000;
    let boost = 1, lastLeaves = 0, nearX = 0, nearY = 0, nearD = Infinity, cpuMs = 0;
    let ST = new Float64Array(8 * 8192);
    // 종류별 자식 정보를 평평한 배열로 (안쪽 반복을 빠르게)
    let PK = null;
    function pack() {
      PK = F.lay.map((segs, t) => {
        const n = segs.length;
        const o = { n, ty: new Int8Array(n), mi: new Int8Array(n), u0x: new Float64Array(n), u0y: new Float64Array(n), u1x: new Float64Array(n), u1y: new Float64Array(n), hn: HUE_W / n, maxR: 0 };
        segs.forEach((sg, i) => {
          o.ty[i] = sg[0]; o.mi[i] = sg[1]; o.u0x[i] = sg[2]; o.u0y[i] = sg[3]; o.u1x[i] = sg[4]; o.u1y[i] = sg[5];
                    o.maxR = Math.max(o.maxR, Math.hypot(sg[4] - sg[2], sg[5] - sg[3]));
        });
        return o;
      });
    }

    function render() {
      const tStart = performance.now();
      const W = view.W, H = view.H;
      const halfDiag = Math.hypot(W, H) / 2 / cam.s;
      // 화면을 감싸는 조상 + 여유 3단계
      let anc = null, extra = -1;
      for (let k = 0; k < 120; k++) {
        anc = climb(k);
        const [t, m] = nodeInfo(anc.d);
        const c = circleOf(t, m, anc.ax, anc.ay, anc.bx, anc.by);
        if (extra < 0 && Math.hypot(c.x - cam.x, c.y - cam.y) + halfDiag < c.r) extra = 0;
        if (extra >= 3) break;
        if (extra >= 0) extra++;
      }
      const [t0, m0, h0] = nodeInfo(anc.d);
      const cs = Math.cos(cam.rot) * cam.s, sn = Math.sin(cam.rot) * cam.s;
      const sx = (x, y) => (x - cam.x) * cs - (y - cam.y) * sn;
      const sy = (x, y) => (x - cam.x) * sn + (y - cam.y) * cs;
      const T = leafPx * boost;
      const pad = 8, hw = W / 2 + pad, hh = H / 2 + pad;
      const seedOff = (color.seed % 997) / 997;
      // 색: 화면 크기 이상 덩어리에서 정한 위치가 색을 정하고, 잘게 들어갈수록 영향이 줄어듦 (얼룩덜룩 방지)
      const lnLo = Math.log(T * 10), lnHi = Math.log(Math.min(W, H) * 0.6);
      const B0 = F.bounds[0], B1 = F.bounds[1];
      nSeg = 0; nearD = Infinity;
      let sp = 0;
      const push = (t, m, ax, ay, bx, by, h, ph) => {
        if (sp + 8 > ST.length) { const n2 = new Float64Array(ST.length * 2); n2.set(ST); ST = n2; }
        ST[sp] = t; ST[sp + 1] = m; ST[sp + 2] = ax; ST[sp + 3] = ay; ST[sp + 4] = bx; ST[sp + 5] = by; ST[sp + 6] = h; ST[sp + 7] = ph; sp += 8;
      };
      const CP = F.cpath, PP = F.P;
      push(t0, m0, sx(anc.ax, anc.ay), sy(anc.ax, anc.ay), sx(anc.bx, anc.by), sy(anc.bx, anc.by), h0, phaseOf(anc.d));
      let count = 0;
      while (sp > 0) {
        sp -= 8;
        const t = ST[sp], m = ST[sp + 1], ax = ST[sp + 2], ay = ST[sp + 3], bx = ST[sp + 4], by = ST[sp + 5], hue = ST[sp + 6], ph = ST[sp + 7];
        const dx = bx - ax, dy = by - ay;
        const L = Math.sqrt(dx * dx + dy * dy);
        const b = t ? B1 : B0;
        const bcy = m ? -b.cy : b.cy;
        const ccx = ax + dx * b.cx - dy * bcy, ccy = ay + dx * bcy + dy * b.cx, r = b.r * L;
        if (ccx - r > hw || -ccx - r > hw || ccy - r > hh || -ccy - r > hh) continue;
        if (L < T || count > MAX_LEAVES) {
          ensureCap(1);
          const o = nSeg * 4; buf[o] = ax; buf[o + 1] = ay; buf[o + 2] = bx; buf[o + 3] = by;
          let hh2 = (hue + seedOff) % 1; if (hh2 < 0) hh2 += 1; cols[nSeg++] = (hh2 * K) | 0;
          count++;
          continue;
        }
        let w = (L - T) / (T / PK[t].maxR - T);
        w = w >= 1 ? 1 : w * w * (3 - 2 * w);
        let hw8 = (Math.log(L) - lnLo) / (lnHi - lnLo);
        hw8 = hw8 <= 0 ? 0 : hw8 >= 1 ? 1 : hw8;
        const P = PK[t], n = P.n, cidx = CP[ph], hstep = P.hn * hw8, nph = (ph + 1) % PP;
        const leafKids = L * P.maxR < T;
        if (leafKids) ensureCap(n);
        for (let i = 0; i < n; i++) {
          const u0x = P.u0x[i], u1x = P.u1x[i];
          let u0y = P.u0y[i] * w, u1y = P.u1y[i] * w;
          if (m) { u0y = -u0y; u1y = -u1y; }
          const cax = ax + dx * u0x - dy * u0y, cay = ay + dx * u0y + dy * u0x;
          const cbx = ax + dx * u1x - dy * u1y, cby = ay + dx * u1y + dy * u1x;
          const ch = hue + (i - cidx) * hstep;
          if (leafKids) {
            const o = nSeg * 4; buf[o] = cax; buf[o + 1] = cay; buf[o + 2] = cbx; buf[o + 3] = cby;
            let hh2 = (ch + seedOff) % 1; if (hh2 < 0) hh2 += 1; cols[nSeg++] = (hh2 * K) | 0;
            count++;
          } else push(P.ty[i], m ^ P.mi[i], cax, cay, cbx, cby, ch, nph);
        }
      }
      // 화면 중심에서 가장 가까운 선 (계속 확대할 때 따라가기용) — 일부만 훑어봄
      const stride = Math.max(1, (nSeg / 4000) | 0);
      for (let i = 0; i < nSeg; i += stride) {
        const o = i * 4, mx = (buf[o] + buf[o + 2]) / 2, my = (buf[o + 1] + buf[o + 3]) / 2, dd = mx * mx + my * my;
        if (dd < nearD) { nearD = dd; nearX = mx; nearY = my; }
      }
      lastLeaves = count;
      cpuMs = cpuMs * 0.8 + (performance.now() - tStart) * 0.2;
      global.__ifsCpu = cpuMs;
      // 한 프레임 계산이 길면 다음 프레임은 조금 굵게, 여유 있으면 원래대로
      if (!forcedSize) {
        if (cpuMs > 10 || count > MAX_LEAVES * 0.9) boost = Math.min(8, boost * 1.06);
        else if (cpuMs < 5 && boost > 1) boost = Math.max(1, boost / 1.02);
      } else boost = 1;

      const tA = performance.now();
      layer.setSegs(buf, cols, nSeg);
      layer.flush();
      global.__ifsAppend = performance.now() - tA;
      const ss = forcedSize ? 1 : (view.DPR < 1.75 ? 1.25 : 1);
      const px = view.DPR * ss;
      glr.resize(Math.max(1, Math.round(W * px)), Math.max(1, Math.round(H * px)));
      const core = NK.lineStyle.core * px;
      const style = { halfW: Math.max(0.5, core / 2), hot: NK.lineStyle.core >= 1.1 ? 1 : 0, bloom: 0.34 * NK.lineStyle.glow, exposure: 1.3 };
      glr.frame({ x: 0, y: 0, s: px, rot: 0 }, [{ layer }], style, null);
    }

    // ---------- 움직임 ----------
    function zoomBy(f, sxp = 0, syp = 0) {      // 화면 점(중심 기준 CSS px)을 고정하고 f배
      const cs = Math.cos(cam.rot), sn = Math.sin(cam.rot);
      // 그 화면 점의 프레임 좌표
      const wx = cam.x + (sxp * cs + syp * sn) / cam.s, wy = cam.y + (-sxp * sn + syp * cs) / cam.s;
      cam.s *= f;
      cam.x = wx - (sxp * cs + syp * sn) / cam.s; cam.y = wy - (-sxp * sn + syp * cs) / cam.s;
      logZoom += Math.log2(f);
    }
    function panBy(dxp, dyp) {
      const cs = Math.cos(cam.rot), sn = Math.sin(cam.rot);
      cam.x -= (dxp * cs + dyp * sn) / cam.s; cam.y -= (-dxp * sn + dyp * cs) / cam.s;
    }
    function goFree() { if (loopOn) { loopOn = false; $('chkLoop').checked = false; syncUi(); syncUrl(); } }

    let lastT = 0;
    function frame(now) {
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
      lastT = now;
      if (!paused && auto !== 'stop' && dt > 0) {
        const f = Math.pow(2, (auto === 'in' ? 1 : -1) * zoomRate * dt);
        zoomBy(f);
        if (loopOn && counter) cam.rot -= F.crot * Math.log(f) / Math.log(F.g);
        // 계속 확대할 때 곡선 위에 머물도록 가장 가까운 선 쪽으로 천천히
        if (!loopOn && auto === 'in' && nearD < Infinity) {
          const k = Math.min(1, dt * 1.2);
          panBy(-nearX * k, -nearY * k);
        }
      }
      const S0 = Math.min(view.W, view.H) * 0.35;
      if (loopOn) { if (cam.s > S0 * F.g || cam.s < S0) loopRebase(); else { cam.x = F.zx; cam.y = F.zy; } }
      else if (cam.s > S0 * 6 || cam.s < S0 / 6 || Math.hypot(cam.x - 0.5, cam.y) > 6) relocate();
      render();
      updateHud();
      global.__ifsFrames = (global.__ifsFrames || 0) + 1;
      requestAnimationFrame(frame);
    }

    // ---------- HUD ----------
    function fmtZoom(l2) {
      const e = l2 * 0.30103;          // log10
      if (Math.abs(e) < 4) { const v = Math.pow(2, l2); return '×' + (v >= 10 ? v.toFixed(0) : v.toFixed(2)); }
      return `×10^${e.toFixed(1)}`;
    }
    let hudT = 0;
    function updateHud() {
      const now = performance.now();
      if (now - hudT < 120) return;
      hudT = now;
      $('zoomNow').textContent = fmtZoom(logZoom);
      $('statLeaves').textContent = `선 ${lastLeaves.toLocaleString('ko-KR')}개` + (boost > 1.05 ? ` (디테일 ×${(1 / boost).toFixed(2)})` : '');
      $('statStatus').textContent = paused ? '멈춤' : auto === 'stop' ? '정지' : auto === 'in' ? '확대 중' : '축소 중';
    }

    // ---------- 입력 ----------
    const stage = $('stage');
    const pointers = new Map();
    let pinch = null;
    const rel = (e) => [e.clientX - view.W / 2, e.clientY - view.H / 2];
    stage.addEventListener('pointerdown', e => {
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, rel(e));
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
    });
    stage.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      const p = rel(e), old = pointers.get(e.pointerId);
      pointers.set(e.pointerId, p);
      goFree();
      if (pointers.size === 1) panBy(p[0] - old[0], p[1] - old[1]);
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) zoomBy(d / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        pinch = d;
      }
    });
    const up = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      goFree();
      const [x, y] = rel(e);
      zoomBy(Math.pow(1.0015, -e.deltaY), x, y);
    }, { passive: false });

    // ---------- 컨트롤 ----------
    function syncUrl() {
      NK.writeParams({ ang: angle, auto, loop: loopOn ? 1 : 0, cr: counter ? 1 : 0, leaf: leafPx, seed: color.seed, pal: color.paletteKey });
      const fin = $('linkFinite');
      if (fin) fin.href = `index.html?ang=${angle}`;
    }
    const setAutoSeg = NK.bindSeg($('autoSeg'), 'auto', a => { auto = a; paused = false; setAutoSeg(a); syncUrl(); });
    const zs = $('zspeed'), zsl = $('zspeedLabel');
    const updZ = () => { zoomRate = 0.08 * Math.pow(50, parseFloat(zs.value) / 100); zsl.textContent = `${Math.pow(2, zoomRate).toFixed(2)}배/초`; };
    zs.addEventListener('input', updZ);
    $('chkLoop').addEventListener('change', e => {
      loopOn = e.target.checked;
      if (loopOn) loopRebase(); else relocate();
      syncUi(); syncUrl();
    });
    $('chkCounter').addEventListener('change', e => { counter = e.target.checked; syncUrl(); });
    const leafIn = $('leaf'), leafLabel = $('leafLabel');
    leafIn.addEventListener('input', () => { leafPx = parseFloat(leafIn.value); leafLabel.textContent = leafPx.toFixed(1) + 'px'; syncUrl(); });
    $('btnHome').addEventListener('click', () => { loopOn = true; $('chkLoop').checked = true; resetView(); syncUi(); syncUrl(); });

    function syncUi() {
      $('chkLoop').checked = loopOn;
      $('chkCounter').checked = counter;
      $('counterRow').style.opacity = loopOn ? 1 : 0.4;
      leafIn.value = leafPx; leafLabel.textContent = leafPx.toFixed(1) + 'px';
      if (cfg.syncAngle) cfg.syncAngle(angle);
      $('shapeInfo').textContent = F ? `자식 ${F.n[0]}개로 된 자기닮음 · 프랙탈 차원 ≈ ${F.dim.toFixed(3)} · 한 바퀴 ${F.g.toFixed(2)}배` : '';
    }

    const colorUi = NK.bindColorControls(color, {
      palette: 'paletteSel', gradBar: 'gradBar', seed: 'seedInput', reseed: 'btnReseed',
    }, () => { glr.setPalette(color.rgb); syncUrl(); });
    NK.bindPanelToggle();
    NK.bindCapture({
      ok: () => true,
      sources: () => [glCanvas],
      setForced: (f) => { forcedSize = f; resize(); },
      maxSide: () => glr.gl.getParameter(glr.gl.MAX_TEXTURE_SIZE),
    });

    global.addEventListener('keydown', e => {
      if (NK.isTyping(e)) return;
      switch (e.key) {
        case ' ': e.preventDefault(); paused = !paused; break;
        case 'i': case 'I': setAutoSeg('in'); auto = 'in'; syncUrl(); break;
        case 'o': case 'O': setAutoSeg('out'); auto = 'out'; syncUrl(); break;
        case 'h': case 'H': $('btnHome').click(); break;
        case 's': case 'S': colorUi.reseed(); break;
        case '+': case '=': goFree(); zoomBy(1.25); break;
        case '-': case '_': goFree(); zoomBy(0.8); break;
      }
    });

    // 모양(각도) 바꾸기. 프랙탈이 아니면 false
    function setAngle(a, quiet) {
      const err = setupIfs(a);
      if (err) {
        if (!quiet) {
          const why = err.bad === 'line' ? '확대해 나가면 결국 일직선이 돼요'
            : err.bad === 'fill' ? '조각들이 겹쳐서 면을 꽉 채워버려요'
            : '같은 모양이 반복되지 않아요';
          NK.toast(`${a}°는 ${why}. 무한 확대가 되는 각도를 골라주세요`);
        }
        return false;
      }
      angle = a;
      resetView();
      syncUi(); syncUrl();
      return true;
    }

    const api = { setAngle, analyze: (a) => analyze(cfg.kind, a), get angle() { return angle; } };

    // 시작
    if (!setAngle(angle, true)) {
      const asked = angle;
      const near = cfg.nearestValid(asked);
      setAngle(near, true);
      setTimeout(() => NK.toast(`${asked}°는 무한히 확대하면 프랙탈이 아니라서 가장 가까운 ${near}°로 열었어요`), 400);
    }
    setAutoSeg(auto);
    zs.value = params.get('zs') || 45; updZ();
    glr.setPalette(color.rgb);
    syncUi(); syncUrl();
    requestAnimationFrame(frame);
    return api;
  }

  NK.IfsZoom = IfsZoom;
  NK.ifsAnalyze = analyze;
})(window);
