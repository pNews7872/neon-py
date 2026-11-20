/* =========================================================
   NeonKit — 모든 페이지가 같이 쓰는 공통 코드
   · 색 팔레트(그라데이션) / 시드
   · 색 구역 노이즈
   · 선 데이터 저장소 (이어진 꺾은선)
   · 백그라운드 렌더러(Web Worker) + 화면 이동·확대 뷰
   ========================================================= */
(function (global) {
  'use strict';
  // 이 파일이 있는 폴더 (녹화용 라이브러리를 필요할 때 불러오려고)
  const SCRIPT_BASE = ((document.currentScript && document.currentScript.src) || '').replace(/[^/]*$/, '');

  const K = 96;                    // 그라데이션 단계 수
  const GLOW_PX = 6;               // 선 번짐(글로우) 두께 (화면 px)
  const CORE_PX = 1.3;             // 선 심지 두께 (화면 px)
  const BUF_MARGIN = 3;            // 미리 그려둘 범위: 화면 크기의 몇 배 (가로·세로 각각)
  const BUF_MAX_PIXELS = 48e6;     // 버퍼 최대 픽셀 수 (메모리 보호)
  const RERENDER_ZOOM = 1.25;      // 버퍼 대비 이만큼 확대/축소되면 선명하게 다시 그림

  // ---------------------------------------------------------
  // 선 스타일 (모든 페이지 공통, 브라우저에 저장)
  // core: 선 심지 굵기(화면 px), glow: 번짐 세기(0~2)
  // ---------------------------------------------------------
  const STYLE_KEY = 'neon-lines-style';
  const lineStyle = { core: 1.8, glow: 1 };
  try { Object.assign(lineStyle, JSON.parse(localStorage.getItem(STYLE_KEY) || '{}')); } catch (e) { /* 저장소 없음 */ }
  const styleListeners = [];
  function setLineStyle(patch) {
    Object.assign(lineStyle, patch);
    try { localStorage.setItem(STYLE_KEY, JSON.stringify(lineStyle)); } catch (e) { /* */ }
    styleListeners.forEach(f => f(lineStyle));
  }

  // 네온관처럼 4겹으로 긋기: 넓은 번짐 → 중간 번짐 → 심지(색) → 가운데 하이라이트(흰빛)
  // items: [{ path, color }], scale: 좌표 1 = 기기 px 몇 개, st: { core, glow, dpr }
  function neonStroke(ctx, items, scale, st) {
    const px = (v) => (v * st.dpr) / scale;
    const passes = [
      { w: 8, a: 0.09 * st.glow, white: false },
      { w: 3.6, a: 0.18 * st.glow, white: false },
      { w: st.core, a: 1, white: false },
      { w: Math.max(0.5, st.core * 0.42), a: 0.5, white: true },
    ];
    for (const p of passes) {
      if (p.a <= 0.001) continue;
      if (p.white && st.core < 1.1) continue;
      ctx.globalAlpha = Math.min(1, p.a);
      ctx.lineWidth = px(p.w);
      for (const it of items) {
        ctx.strokeStyle = p.white ? '#ffffff' : it.color;
        ctx.stroke(it.path);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------
  // 팔레트
  // ---------------------------------------------------------
  const PALETTES = {
    neon:   { name: '네온 무지개', stops: ['#ff3366', '#ff6a00', '#ffe600', '#39ff14', '#00f0ff', '#8a5cff', '#ff2bd6'] },
    cyber:  { name: '사이버펑크', stops: ['#ff2bd6', '#8a5cff', '#2d6bff', '#00f0ff'] },
    aurora: { name: '오로라', stops: ['#39ff14', '#00ffa3', '#00f0ff', '#2d6bff', '#b44cff'] },
    sunset: { name: '선셋', stops: ['#ffe600', '#ff6a00', '#ff3366', '#ff2bd6', '#8a5cff'] },
    random: { name: '시드 랜덤 색', stops: null },
  };

  function hexToRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn;
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const f = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s === 0) return [l * 255, l * 255, l * 255].map(Math.round);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)].map(v => Math.round(v * 255));
  }
  function mulberry32(a) {
    return () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  // 시드로 네온 느낌의 랜덤 색 조합 만들기 (채도 100%, 밝기 55~62%)
  function randomStops(sd) {
    const rng = mulberry32(sd * 7919 + 17);
    const cnt = 3 + Math.floor(rng() * 4);
    const h = rng() * 360;
    const span = 140 + rng() * 220;
    const out = [];
    for (let i = 0; i < cnt; i++) {
      const hh = h + (span / cnt) * i + (rng() - 0.5) * 18;
      const rgb = hslToRgb(hh, 1, 0.55 + rng() * 0.07);
      out.push('#' + rgb.map(v => v.toString(16).padStart(2, '0')).join(''));
    }
    return out;
  }
  // 기준색들을 색상환 기준으로 보간해 K단계 그라데이션 생성
  function buildColors(paletteKey, seed) {
    const hex = paletteKey === 'random' ? randomStops(seed) : PALETTES[paletteKey].stops;
    const hsl = hex.map(h => rgbToHsl(hexToRgb(h)));
    const m = hsl.length;
    const colors = [], rgb = [];
    for (let q = 0; q < K; q++) {
      const pos = (q / K) * m;
      const i = Math.floor(pos), f = pos - i;
      const e = f * f * (3 - 2 * f);
      const A = hsl[i % m], B = hsl[(i + 1) % m];
      const dh = ((B[0] - A[0]) % 360 + 540) % 360 - 180;
      const c = hslToRgb(A[0] + dh * e, A[1] + (B[1] - A[1]) * e, A[2] + (B[2] - A[2]) * e);
      rgb.push(c);
      colors.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    }
    return { colors, rgb };
  }

  // ---------------------------------------------------------
  // 색 구역 노이즈 (워커에서도 쓰도록 외부 변수 참조 없음)
  // ---------------------------------------------------------
  function zoneFactory(seed, zoneScale, K) {
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
    return function zoneAt(x, y) {
      let u = x / zoneScale, v = y / zoneScale;
      const wx = fbm(u + 5.2, v + 1.3, seed + 1000);
      const wy = fbm(u - 3.1, v + 7.7, seed + 2000);
      u += wx * 1.4; v += wy * 1.4;
      const a = fbm(u, v, seed);
      const b = fbm(u + 11.7, v - 4.4, seed + 500);
      const t = Math.atan2(b, a) / (Math.PI * 2) + 0.5;
      return Math.floor(t * K) % K;
    };
  }

  // 색 상태: 팔레트·시드·구역 크기를 한곳에서 관리
  class ColorState {
    constructor(opts = {}) {
      this.paletteKey = opts.paletteKey || 'neon';
      this.seed = opts.seed != null ? opts.seed : (Math.random() * 1e6) | 0;
      this.zoneScale = opts.zoneScale || 1200;
      this.showZones = false;
      this.update();
    }
    update() {
      const { colors, rgb } = buildColors(this.paletteKey, this.seed);
      this.colors = colors;
      this.rgb = rgb;
      this.zoneAt = zoneFactory(this.seed, this.zoneScale, K);
    }
    gradientCss() {
      const stops = [];
      for (let q = 0; q <= K; q += 8) stops.push(this.colors[q % K]);
      return `linear-gradient(90deg, ${stops.join(',')})`;
    }
  }

  // ---------------------------------------------------------
  // 선 데이터: 이어진 꺾은선 (꼭짓점 n+1개, 선 n개, 선마다 색 번호)
  // ---------------------------------------------------------
  class SegStore {
    constructor() {
      this.cap = 1 << 16;
      this.pts = new Float64Array(this.cap * 2 + 2);
      this.cols = new Uint8Array(this.cap);
      this.reset();
    }
    reset(x = 0, y = 0) {
      this.n = 0;
      this.pts[0] = x; this.pts[1] = y;
      this.bounds = { minX: x, minY: y, maxX: x, maxY: y };
    }
    ensure(extra) {
      if (this.n + extra <= this.cap) return;
      while (this.n + extra > this.cap) this.cap *= 2;
      const p2 = new Float64Array(this.cap * 2 + 2); p2.set(this.pts); this.pts = p2;
      const c2 = new Uint8Array(this.cap); c2.set(this.cols); this.cols = c2;
    }
    get lastX() { return this.pts[this.n * 2]; }
    get lastY() { return this.pts[this.n * 2 + 1]; }
    push(x, y, c) {
      if (this.n >= this.cap) this.ensure(1);
      const i = this.n;
      this.pts[i * 2 + 2] = x; this.pts[i * 2 + 3] = y;
      this.cols[i] = c;
      const b = this.bounds;
      if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
      this.n++;
    }
    // 보이지 않게 (x, y) 로 이동 (나무처럼 갈라지는 그림용). 색 255 = 그리지 않음
    jumpTo(x, y) {
      if (this.n === 0 && this.pts[0] === x && this.pts[1] === y) return;
      if (this.lastX === x && this.lastY === y) return;
      this.push(x, y, 255);
    }
    // fn(i, x0, y0, x1, y1) → 색 번호
    recolor(fn) {
      const p = this.pts;
      for (let i = 0; i < this.n; i++) if (this.cols[i] !== 255) this.cols[i] = fn(i, p[i * 2], p[i * 2 + 1], p[i * 2 + 2], p[i * 2 + 3]);
    }
  }

  // ---------------------------------------------------------
  // 렌더러 (Web Worker + OffscreenCanvas)
  // ---------------------------------------------------------
  function rendererMain(zoneFactory, port, makeCanvas) {
    let K = 96, colors = [], colorsRgb = [], zoneAt = null, showZones = false;
    let paths = [], count = 0, lastX = [], lastY = [];
    let canvas = null, ctx = null, small = null, smallCtx = null;
    const resetPaths = () => {
      paths = Array.from({ length: K }, () => new Path2D()); count = 0;
      lastX = new Array(K).fill(NaN); lastY = new Array(K).fill(NaN);
    };
    resetPaths();

    function drawZones(m) {
      const cell = 12;
      const cw = Math.ceil(m.w / cell) + 1, ch = Math.ceil(m.h / cell) + 1;
      if (!small || small.width !== cw || small.height !== ch) { small = makeCanvas(cw, ch); smallCtx = small.getContext('2d'); }
      const img = smallCtx.createImageData(cw, ch);
      const d = img.data;
      for (let j = 0; j < ch; j++) {
        const wy = (j * cell - m.h / 2) / m.s + m.cy;
        for (let i = 0; i < cw; i++) {
          const wx = (i * cell - m.w / 2) / m.s + m.cx;
          const rgb = colorsRgb[zoneAt(wx, wy)];
          const p = (j * cw + i) * 4;
          d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2]; d[p + 3] = 34;
        }
      }
      smallCtx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(small, 0, 0, cw, ch, 0, 0, cw * cell, ch * cell);
    }

    function render(m) {
      if (!canvas || canvas.width !== m.w || canvas.height !== m.h) {
        canvas = makeCanvas(m.w, m.h);
        ctx = canvas.getContext('2d');
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, m.w, m.h);
      if (showZones && zoneAt) drawZones(m);
      ctx.setTransform(m.s, 0, 0, m.s, m.w / 2 - m.cx * m.s, m.h / 2 - m.cy * m.s);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const items = [];
      for (let k = 0; k < K; k++) if (count) items.push({ path: paths[k], color: colors[k] });
      neonStroke(ctx, items, m.s, m.style);
      const bitmap = canvas.transferToImageBitmap ? canvas.transferToImageBitmap() : canvas;
      const out = { type: 'rendered', id: m.id, gen: m.gen, cx: m.cx, cy: m.cy, s: m.s, w: m.w, h: m.h, upTo: count, bitmap };
      if (canvas.transferToImageBitmap) port.postMessage(out, [bitmap]);
      else port.postMessage(out);
    }

    port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'config') {
        const kChanged = m.K !== K;
        K = m.K; colors = m.colors; colorsRgb = m.colorsRgb; showZones = m.showZones;
        zoneAt = zoneFactory(m.seed, m.zoneScale, m.K);
        if (kChanged) resetPaths();
      } else if (m.type === 'reset') {
        resetPaths();
      } else if (m.type === 'append') {
        const p = m.pts, c = m.cols;
        for (let i = 0; i < c.length; i++) {
          const k = c[i];
          if (k === 255) continue;                 // 255 = 보이지 않는 이동(점프)
          const path = paths[k];
          const x0 = p[i * 2], y0 = p[i * 2 + 1];
          // 같은 색 선이 이어지면 한 줄로 (이음매에 번짐이 겹쳐 밝은 점이 생기지 않게)
          if (x0 !== lastX[k] || y0 !== lastY[k]) path.moveTo(x0, y0);
          path.lineTo(p[i * 2 + 2], p[i * 2 + 3]);
          lastX[k] = p[i * 2 + 2]; lastY[k] = p[i * 2 + 3];
        }
        count = m.start + c.length;
      } else if (m.type === 'render') {
        render(m);
      }
    };
  }

  function createRenderer() {
    const handlers = { onResult: null };
    try {
      if (typeof OffscreenCanvas === 'undefined' || !OffscreenCanvas.prototype.transferToImageBitmap) throw new Error('no offscreen');
      const src = zoneFactory.toString() + '\n' + neonStroke.toString() + '\n(' + rendererMain.toString() +
        ')(zoneFactory, self, (w, h) => new OffscreenCanvas(w, h));';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (e) => handlers.onResult && handlers.onResult(e.data);
      return { post: (m, t) => w.postMessage(m, t || []), handlers };
    } catch (err) {
      const port = { onmessage: null, postMessage: (m) => setTimeout(() => handlers.onResult && handlers.onResult(m), 0) };
      rendererMain(zoneFactory, port, (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
      return { post: (m) => port.onmessage({ data: m }), handlers };
    }
  }

  // ---------------------------------------------------------
  // 뷰: 카메라 + 미리 그려둔 버퍼 + 마우스/터치 조작
  // 화면 이동·확대는 버퍼 이미지를 옮기고 늘리기만 하고,
  // 필요할 때만 워커가 백그라운드에서 다시 그린다.
  // ---------------------------------------------------------
  const views = [];
  class NeonView {
    /**
     * opts.trail, opts.overlay : 캔버스
     * opts.store : SegStore
     * opts.color : ColorState
     * opts.onCamMode(mode) : 카메라 모드 바뀔 때 (UI 갱신)
     * opts.followPoint() : 따라가기 모드에서 따라갈 [x, y]
     * opts.fitBounds() : 전체 맞춤에서 쓸 범위 (기본: store.bounds)
     */
    constructor(opts) {
      this.trail = opts.trail;
      this.overlay = opts.overlay;
      this.tCtx = this.trail.getContext('2d');
      this.store = opts.store;
      this.color = opts.color;
      this.onCamMode = opts.onCamMode || (() => {});
      this.followPoint = opts.followPoint || (() => [this.store.lastX, this.store.lastY]);
      this.fitBounds = opts.fitBounds || (() => this.store.bounds);
      this.maxFitScale = opts.maxFitScale || 3;

      this.W = 0; this.H = 0; this.DPR = 1;
      this.cam = { x: 0, y: 0, s: 2 };
      this.target = { x: 0, y: 0, s: 2 };
      this.camMode = opts.camMode || 'follow';
      this.dirty = true;

      this.renderer = createRenderer();
      this.buf = document.createElement('canvas');
      this.bufCtx = this.buf.getContext('2d');
      this.bufCam = null;
      this.bufUpTo = 0;
      this.bufStale = false;
      this.gen = 0;
      this.sentUpTo = 0;
      this.inflight = false;
      this.forceRender = true;
      this.renderId = 0;
      this.lastFlush = 0;
      this.renderer.handlers.onResult = (m) => this._onResult(m);

      // GPU(WebGL2) 렌더링: 되면 매 프레임 GPU로 전부 그림, 안 되면 위의 캔버스 방식
      this.gpu = false;
      this.drawsFn = opts.draws || null;   // 페이지가 그릴 목록을 직접 정할 때
      const noGl = /[?&]gl=0\b/.test(location.search);
      if (!noGl && opts.gpu !== false && global.NeonGL) {
        try {
          const cv = document.createElement('canvas');
          cv.id = 'gl';
          this.trail.parentNode.insertBefore(cv, this.trail);
          const glr = global.NeonGL.create(cv);
          if (glr) {
            this.glr = glr; this.glCanvas = cv; this.gpu = true;
            this.segLayer = glr.createSegLayer();
            this.uploaded = 0;
            this._gpuReset = false;
            this.trail.style.display = 'none';
            const mobile = global.matchMedia && global.matchMedia('(pointer: coarse)').matches;
            this.ss = !mobile && (global.devicePixelRatio || 1) < 1.75 ? 1.25 : 1;   // 슈퍼샘플링
            cv.addEventListener('webglcontextlost', (e) => {
              e.preventDefault();
              this.gpu = false; this.trail.style.display = 'block'; cv.style.display = 'none';
              this.forceRender = true; this.bufCam = null; this.dirty = true;
              this.sendConfig(); this.resetRenderer();
              toast('GPU 그리기가 중단돼서 기본 방식으로 바꿨어요');
            });
          } else { cv.remove(); this.gpuError = 'WebGL2를 지원하지 않는 브라우저'; }
        } catch (err) {
          console.warn('WebGL2 사용 불가', err);
          this.gpuError = String(err && err.message || err).slice(0, 80);
          const c = document.getElementById('gl'); if (c) c.remove();
        }
      }
      // 지금 어떤 방식으로 그리는지 HUD에 표시 (문제 확인용)
      const stats = document.querySelector('#hud .stats');
      if (stats) {
        const tag = document.createElement('span');
        tag.className = 'render-tag';
        tag.textContent = this.gpu ? ' · GPU' : ' · 캔버스';
        tag.title = this.gpu ? 'GPU(WebGL2)로 그리는 중' : ('기본 캔버스 방식으로 그리는 중' + (this.gpuError ? ' — ' + this.gpuError : ''));
        stats.appendChild(tag);
      }
      if (!this.gpu && this.gpuError && !noGl) setTimeout(() => toast('GPU를 쓰지 못해서 기본 방식으로 그려요: ' + this.gpuError), 800);

      this._bindInput();
      views.push(this);
      styleListeners.push(() => { this.forceRender = true; });
      window.addEventListener('resize', () => this.resize());
      this.resize();
      this.sendConfig();
    }

    // ---------- 녹화·사진 저장 ----------
    captureAdapter() {
      return {
        ok: () => this.gpu,
        sources: () => [this.gpu ? this.glCanvas : this.trail, this.overlay],
        setForced: (f) => {
          this.forced = f; this.resize();
          // 패널을 피하던 배치를 영상 기준으로 다시 (녹화 시작 땐 바로 맞춤)
          if (this.camMode === 'fit') {
            this.fitTarget(true);
            if (f) { this.cam.x = this.target.x; this.cam.y = this.target.y; this.cam.s = this.target.s; }
          }
        },
        maxSide: () => (this.gpu ? this.glr.gl.getParameter(this.glr.gl.MAX_TEXTURE_SIZE) : 8192),
      };
    }

    // ---------- 좌표 ----------
    worldToScreen(x, y) {
      return [(x - this.cam.x) * this.cam.s + this.W / 2, (y - this.cam.y) * this.cam.s + this.H / 2];
    }
    screenToWorld(sx, sy) {
      return [(sx - this.W / 2) / this.cam.s + this.cam.x, (sy - this.H / 2) / this.cam.s + this.cam.y];
    }
    // 월드 좌표 → 기기 픽셀 변환을 ctx에 설정
    setWorldTransform(ctx) {
      const s = this.cam.s * this.DPR;
      ctx.setTransform(s, 0, 0, s, this.DPR * (this.W / 2 - this.cam.x * this.cam.s), this.DPR * (this.H / 2 - this.cam.y * this.cam.s));
    }

    resize() {
      const f = this.forced;                     // 녹화·사진 저장 중에는 정해진 해상도로
      this.DPR = f ? f.DPR : Math.min(window.devicePixelRatio || 1, 2);
      this.W = f ? f.W : window.innerWidth; this.H = f ? f.H : window.innerHeight;
      for (const c of [this.trail, this.overlay]) {
        c.width = Math.round(this.W * this.DPR);
        c.height = Math.round(this.H * this.DPR);
      }
      this.forceRender = true;
      this.dirty = true;
    }

    // ---------- 렌더러와 통신 ----------
    sendConfig() {
      const c = this.color;
      if (this.gpu) this.glr.setPalette(c.rgb);
      this.renderer.post({ type: 'config', K, colors: c.colors, colorsRgb: c.rgb, seed: c.seed, zoneScale: c.zoneScale, showZones: c.showZones });
    }
    // 선 데이터가 통째로 바뀌었을 때 (색 변경·다시 계산·처음부터)
    resetRenderer(clear) {
      if (this.gpu) { this._gpuReset = true; return; }
      this.gen++;
      this.renderer.post({ type: 'reset' });
      this.sentUpTo = 0;
      this.bufStale = true;
      this.forceRender = true;
      if (clear) { this.bufCam = null; this.dirty = true; }
    }
    rerender() { this.forceRender = true; }

    flushAppends() {
      const st = this.store;
      if (this.sentUpTo >= st.n) return;
      const p = st.pts.slice(this.sentUpTo * 2, st.n * 2 + 2);
      const c = st.cols.slice(this.sentUpTo, st.n);
      this.renderer.post({ type: 'append', start: this.sentUpTo, pts: p, cols: c }, [p.buffer, c.buffer]);
      this.sentUpTo = st.n;
    }

    bufferSize() {
      const wd = this.W * this.DPR, hd = this.H * this.DPR;
      const m = Math.max(1.3, Math.min(BUF_MARGIN, Math.sqrt(BUF_MAX_PIXELS / (wd * hd))));
      let w = Math.min(16000, Math.round(wd * m)), h = Math.min(16000, Math.round(hd * m));
      // 화면 캔버스와 짝·홀을 맞춰서, 멈췄을 때 버퍼가 정확히 정수 픽셀에 놓이게
      if ((w - this.trail.width) % 2) w--;
      if ((h - this.trail.height) % 2) h--;
      return [w, h];
    }

    requestRender() {
      if (this.inflight) return;
      this.flushAppends();
      const [w, h] = this.bufferSize();
      const t = this.target;
      this.renderer.post({
        type: 'render', id: ++this.renderId, gen: this.gen,
        cx: t.x, cy: t.y, s: t.s * this.DPR, w, h,
        style: { core: lineStyle.core, glow: lineStyle.glow, dpr: this.DPR },
      });
      this.lastRenderView = { x: t.x, y: t.y, s: t.s };
      this.inflight = true;
      this.forceRender = false;
    }

    _onResult(m) {
      if (m.type !== 'rendered') return;
      this.inflight = false;
      if (m.gen !== this.gen) {
        if (m.bitmap && m.bitmap.close) m.bitmap.close();
        this.forceRender = true;
        return;
      }
      const buf = this.buf;
      if (buf.width !== m.w || buf.height !== m.h) { buf.width = m.w; buf.height = m.h; }
      this.bufCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.bufCtx.clearRect(0, 0, m.w, m.h);
      this.bufCtx.drawImage(m.bitmap, 0, 0);
      if (m.bitmap.close) m.bitmap.close();
      this.bufCam = { x: m.cx, y: m.cy, s: m.s, w: m.w, h: m.h };
      this.bufUpTo = m.upTo;
      this.bufStale = false;
      this.bufVersion = (this.bufVersion || 0) + 1;
      this.drawNewIntoBuf();
      this.dirty = true;
    }

    // 새로 생긴 선만 버퍼에 덧그리기. 너무 많으면 워커에 통째로 맡김
    drawNewIntoBuf(maxDirect = Infinity) {
      const st = this.store;
      if (!this.bufCam || this.bufStale || this.bufUpTo >= st.n) return;
      if (st.n - this.bufUpTo > maxDirect) { this.forceRender = true; return; }
      const tmp = new Array(K).fill(null);
      const p = st.pts, cols = st.cols;
      const lx = new Array(K).fill(NaN), ly = new Array(K).fill(NaN);
      for (let i = this.bufUpTo; i < st.n; i++) {
        const c = cols[i];
        if (c === 255) continue;                   // 보이지 않는 이동
        if (!tmp[c]) tmp[c] = new Path2D();
        const x0 = p[i * 2], y0 = p[i * 2 + 1];
        if (x0 !== lx[c] || y0 !== ly[c]) tmp[c].moveTo(x0, y0);
        tmp[c].lineTo(p[i * 2 + 2], p[i * 2 + 3]);
        lx[c] = p[i * 2 + 2]; ly[c] = p[i * 2 + 3];
      }
      const b = this.bufCam, s = b.s, ctx = this.bufCtx;
      ctx.setTransform(s, 0, 0, s, b.w / 2 - b.x * s, b.h / 2 - b.y * s);
      // 조금씩 덧그릴 땐 끝을 둥글게 하지 않음: 앞에 그린 선 끝과 겹쳐 밝은 점이 생기지 않게
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      const items = [];
      for (let k = 0; k < K; k++) if (tmp[k]) items.push({ path: tmp[k], color: this.color.colors[k] });
      neonStroke(ctx, items, s, { core: lineStyle.core, glow: lineStyle.glow, dpr: this.DPR });
      this.bufUpTo = st.n;
      this.bufVersion = (this.bufVersion || 0) + 1;
      this.dirty = true;
    }

    needsRender() {
      if (this.forceRender || !this.bufCam) return true;
      const t = this.target, b = this.bufCam;
      const r = (t.s * this.DPR) / b.s;
      if (r > RERENDER_ZOOM || r < 1 / RERENDER_ZOOM) return true;
      const bhw = b.w / 2 / b.s, bhh = b.h / 2 / b.s;
      const hw = this.W / 2 / t.s, hh = this.H / 2 / t.s;
      const pad = 0.2;
      return Math.abs(t.x - b.x) + hw * (1 + pad) > bhw ||
             Math.abs(t.y - b.y) + hh * (1 + pad) > bhh;
    }

    // 버퍼 픽셀 → 월드 좌표 변환을 ctx의 현재 변환 뒤에 이어붙임
    applyBufferToWorld(ctx) {
      const b = this.bufCam;
      ctx.translate(b.x - b.w / 2 / b.s, b.y - b.h / 2 / b.s);
      ctx.scale(1 / b.s, 1 / b.s);
    }

    composite() {
      const ctx = this.tCtx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.trail.width, this.trail.height);
      if (!this.bufCam) return;
      const k = (this.cam.s * this.DPR) / this.bufCam.s;
      const b = this.bufCam;
      const offX = (b.x - this.cam.x) * this.cam.s * this.DPR, offY = (b.y - this.cam.y) * this.cam.s * this.DPR;
      if (Math.abs(k - 1) < 1e-9) {
        // 배율이 같으면 늘리지 않고 정수 픽셀 위치에 그대로 찍음 (흐려지지 않음)
        const dx = Math.round((this.trail.width - b.w) / 2 + offX), dy = Math.round((this.trail.height - b.h) / 2 + offY);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.buf, dx, dy);
        ctx.imageSmoothingEnabled = true;
        return;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = k < 1 ? 'high' : 'low';
      this.setWorldTransform(ctx);
      this.applyBufferToWorld(ctx);
      ctx.drawImage(this.buf, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ---------- 카메라 ----------
    setCamMode(m) {
      this.camMode = m;
      if (m === 'follow') {
        const [x, y] = this.followPoint();
        this.target.x = x; this.target.y = y;
        if (this.target.s < 0.6) this.target.s = 1.5;
      } else if (m === 'fit') {
        this.fitTarget(true);
      } else {
        this.target.x = this.cam.x; this.target.y = this.cam.y; this.target.s = this.cam.s;
      }
      this.onCamMode(m);
    }

    fitTarget(force, boundsOverride) {
      const bounds = boundsOverride || this.fitBounds();
      const pad = 40, H = this.H, t = this.target;
      const inset = this.rightInset();           // 오른쪽 패널에 가려지는 폭
      const W = this.W - inset;
      const bw = Math.max(bounds.maxX - bounds.minX, 120);
      const bh = Math.max(bounds.maxY - bounds.minY, 120);
      if (!force) {
        // 보이는 영역(패널 제외) 안에 다 들어오면 그대로 둔다
        const left = t.x - (this.W / 2 - pad) / t.s;
        const right = t.x + (this.W / 2 - inset - pad) / t.s;
        const hh = (H / 2 - pad) / t.s;
        if (bounds.minX > left && bounds.maxX < right &&
            bounds.minY > t.y - hh && bounds.maxY < t.y + hh) return;
      }
      const room = force ? 1.15 : 1.6;
      let s = Math.min((W - pad * 2) / (bw * room), (H - pad * 2) / (bh * room));
      s = Math.min(s, this.maxFitScale);
      t.x = (bounds.minX + bounds.maxX) / 2 + inset / 2 / s;
      t.y = (bounds.minY + bounds.maxY) / 2;
      t.s = s;
    }

    rightInset() {
      if (this.forced) return 0;                 // 녹화·사진에는 패널이 없으니 가리는 것도 없음
      const panel = document.getElementById('panel');
      if (!panel || panel.classList.contains('collapsed') || this.W <= 720) return 0;
      const r = panel.getBoundingClientRect();
      return Math.max(0, this.W - r.left);
    }

    updateCameraTarget() {
      if (this.camMode === 'follow') {
        const [x, y] = this.followPoint();
        const [sx, sy] = this.worldToScreen(x, y);
        const mx = this.W * 0.25, my = this.H * 0.25;
        if (sx < mx || sx > this.W - mx || sy < my || sy > this.H - my) {
          this.target.x = x; this.target.y = y;
        }
      } else if (this.camMode === 'fit') {
        this.fitTarget(false);
      }
    }

    stepCamera(dt) {
      const cam = this.cam, t = this.target;
      const f = 1 - Math.exp(-dt * 5);
      const dx = t.x - cam.x, dy = t.y - cam.y;
      const ds = Math.log(t.s / cam.s);
      if (Math.abs(dx) * cam.s < 0.3 && Math.abs(dy) * cam.s < 0.3 && Math.abs(ds) < 0.001) {
        if (dx || dy || ds) { cam.x = t.x; cam.y = t.y; cam.s = t.s; this.dirty = true; }
        return;
      }
      cam.x += dx * f; cam.y += dy * f; cam.s *= Math.exp(ds * f);
      this.dirty = true;
    }

    resetCamera(s = 2) {
      this.cam.x = this.cam.y = this.target.x = this.target.y = 0;
      this.cam.s = this.target.s = s;
      this.dirty = true;
    }

    // 매 프레임 호출: 카메라 이동, 버퍼 갱신, 화면 합성
    // GPU 한 프레임: 새로 생긴 선만 GPU에 덧붙이고, 지금 카메라 그대로 전부 그림
    gpuFrame() {
      const st = this.store, L = this.segLayer;
      if (this._gpuReset || st.n < this.uploaded) { L.reset(); this.uploaded = 0; this._gpuReset = false; }
      if (st.n > this.uploaded) { L.appendFrom(st.pts, st.cols, this.uploaded, st.n); this.uploaded = st.n; }
      const ss = this.forced ? 1 : this.ss;
      const w = Math.max(1, Math.round(this.W * this.DPR * ss)), h = Math.max(1, Math.round(this.H * this.DPR * ss));
      this.glr.resize(w, h);
      const px = this.DPR * ss;
      const core = lineStyle.core * px;
      const style = { halfW: Math.max(0.5, core / 2), hot: lineStyle.core >= 1.1 ? 1 : 0, bloom: 0.34 * lineStyle.glow, exposure: 1.3 };
      const draws = this.drawsFn ? this.drawsFn(L) : [{ layer: L }];
      const zone = this.color.showZones ? { seed: this.color.seed, scale: this.color.zoneScale, alpha: 0.12 } : null;
      this.glr.frame({ x: this.cam.x, y: this.cam.y, s: this.cam.s * px, rot: 0 }, draws, style, zone);
    }

    tick(dt, now, opts = {}) {
      this.updateCameraTarget();
      this.stepCamera(dt);
      if (this.gpu) { this.gpuFrame(); return true; }
      // 카메라가 잠깐 멈추면, 지금 배율·위치 그대로 정확히 다시 그려 선명하게
      const c = this.cam, pc = this._prevCam || (this._prevCam = { x: NaN, y: NaN, s: NaN });
      if (c.x !== pc.x || c.y !== pc.y || c.s !== pc.s) { this._lastMove = now; pc.x = c.x; pc.y = c.y; pc.s = c.s; }
      else if (now - (this._lastMove || 0) > 150 && this.bufCam && !this.inflight && !this.forceRender && !this.bufStale) {
        const b = this.bufCam;
        const k = (c.s * this.DPR) / b.s;
        const offX = (b.x - c.x) * c.s * this.DPR, offY = (b.y - c.y) * c.s * this.DPR;
        const fracX = Math.abs(((this.trail.width - b.w) / 2 + offX) % 1), fracY = Math.abs(((this.trail.height - b.h) / 2 + offY) % 1);
        if (Math.abs(k - 1) > 1e-9 || (fracX > 0.02 && fracX < 0.98) || (fracY > 0.02 && fracY < 0.98)) {
          this.target.x = c.x; this.target.y = c.y; this.target.s = c.s;
          this.forceRender = true;
        }
      }
      this.drawNewIntoBuf(opts.maxDirect);
      if (this.needsRender()) this.requestRender();
      else if (!this.inflight && this.sentUpTo < this.store.n && now - this.lastFlush > 250) {
        this.flushAppends(); this.lastFlush = now;
      }
      if (this.dirty || opts.alwaysComposite) {
        this.composite();
        this.dirty = false;
        return true;
      }
      return false;
    }

    zoomLabel(base = 2) {
      const z = this.cam.s / base * 100;
      return z >= 10 ? Math.round(z) + '%' : z.toFixed(2) + '%';
    }

    // ---------- 마우스 / 터치 ----------
    goFree() { if (this.camMode !== 'free') this.setCamMode('free'); }

    zoomAt(sx, sy, factor) {
      this.goFree();
      const cam = this.cam;
      const [wx, wy] = this.screenToWorld(sx, sy);
      const ns = Math.min(60, Math.max(0.0002, cam.s * factor));
      cam.s = ns;
      cam.x = wx - (sx - this.W / 2) / ns;
      cam.y = wy - (sy - this.H / 2) / ns;
      this.target.x = cam.x; this.target.y = cam.y; this.target.s = cam.s;
      this.dirty = true;
    }

    _bindInput() {
      const ov = this.overlay;
      const pointers = new Map();
      let pinch = null;

      ov.addEventListener('wheel', e => {
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
        this.zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0015));
      }, { passive: false });

      ov.addEventListener('pointerdown', e => {
        ov.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        ov.classList.add('dragging');
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        }
      });
      ov.addEventListener('pointermove', e => {
        if (!pointers.has(e.pointerId)) return;
        const prev = pointers.get(e.pointerId);
        const cur = { x: e.clientX, y: e.clientY };
        pointers.set(e.pointerId, cur);
        if (pointers.size === 1) {
          const dx = cur.x - prev.x, dy = cur.y - prev.y;
          if (!dx && !dy) return;
          this.goFree();
          this.cam.x -= dx / this.cam.s; this.cam.y -= dy / this.cam.s;
          this.target.x = this.cam.x; this.target.y = this.cam.y; this.target.s = this.cam.s;
          this.dirty = true;
        } else if (pointers.size === 2 && pinch) {
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          this.goFree();
          this.cam.x -= (mx - pinch.mx) / this.cam.s;
          this.cam.y -= (my - pinch.my) / this.cam.s;
          this.zoomAt(mx, my, d / pinch.d);
          pinch = { d, mx, my };
        }
      });
      const end = e => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        if (pointers.size === 0) ov.classList.remove('dragging');
      };
      ov.addEventListener('pointerup', end);
      ov.addEventListener('pointercancel', end);
    }
  }

  // ---------------------------------------------------------
  // 작은 UI 도우미
  // ---------------------------------------------------------
  let toastTimer = 0;
  function toast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // 세그먼트 버튼 묶음: <div class="seg"><button data-x="..."> 형태
  function bindSeg(container, attr, onPick) {
    const btns = [...container.querySelectorAll('button')];
    const set = (v) => btns.forEach(b => b.classList.toggle('on', b.dataset[attr] === v));
    btns.forEach(b => b.addEventListener('click', () => onPick(b.dataset[attr])));
    return set;
  }

  // 색 조합·구역 크기·시드·구역 보기 컨트롤 연결
  // ids: { palette, gradBar, zone, zoneLabel, seed, reseed, zones }
  function bindColorControls(color, ids, onChange) {
    const $ = id => document.getElementById(id);
    const pal = $(ids.palette), bar = $(ids.gradBar), zone = $(ids.zone), zoneLabel = $(ids.zoneLabel);
    const seedIn = $(ids.seed), reseed = $(ids.reseed), zones = $(ids.zones);
    const sync = () => {
      pal.value = color.paletteKey;
      bar.style.background = color.gradientCss();
      if (zone) { zone.value = color.zoneScale; zoneLabel.textContent = color.zoneScale; }
      seedIn.value = color.seed;
      if (zones) zones.checked = color.showZones;
    };
    const apply = (what) => { color.update(); sync(); onChange(what); };
    pal.addEventListener('change', () => { color.paletteKey = pal.value; apply('palette'); });
    let zt = 0;
    if (zone) zone.addEventListener('input', () => {
      zoneLabel.textContent = zone.value;
      clearTimeout(zt);
      zt = setTimeout(() => { color.zoneScale = parseFloat(zone.value); apply('zone'); }, 120);
    });
    const setSeed = v => { color.seed = Math.max(0, Math.min(999999, v | 0)); apply('seed'); };
    reseed.addEventListener('click', () => { setSeed((Math.random() * 1e6) | 0); toast(`시드 ${color.seed} — 색을 새로 배치했어요`); });
    seedIn.addEventListener('change', () => {
      const v = parseInt(seedIn.value, 10);
      if (Number.isFinite(v)) setSeed(v); else seedIn.value = color.seed;
    });
    if (zones) zones.addEventListener('change', () => { color.showZones = zones.checked; onChange('zones'); });
    sync();
    return { sync, reseed: () => reseed.click() };
  }

  // 주소창 파라미터 읽기/쓰기 (링크 공유용)
  function readParams() { return new URLSearchParams(location.search); }
  function writeParams(obj) {
    const p = new URLSearchParams();
    for (const k in obj) p.set(k, obj[k]);
    try { history.replaceState(null, '', '?' + p.toString()); } catch (e) { /* file:// 등 */ }
  }
  function colorFromParams(p) {
    const opts = {};
    const sd = parseInt(p.get('seed'), 10);
    if (Number.isFinite(sd)) opts.seed = Math.max(0, Math.min(999999, sd));
    const z = parseFloat(p.get('zone'));
    if (Number.isFinite(z)) opts.zoneScale = Math.max(200, Math.min(8000, z));
    if (PALETTES[p.get('pal')]) opts.paletteKey = p.get('pal');
    return opts;
  }

  // 화면 패널 접기
  function bindPanelToggle() {
    const panel = document.getElementById('panel');
    const btn = document.getElementById('panelToggle');
    if (panel && btn) btn.addEventListener('click', () => panel.classList.toggle('collapsed'));
    bindLineStyle();
    if (views.length) bindCapture(views[0].captureAdapter());
    // 좁은 화면(모바일)에서는 그림이 보이도록 접은 채로 시작
    if (panel && window.innerWidth <= 720) panel.classList.add('collapsed');
  }

  // 공통 단축키 (+/- 확대, F/A 카메라)
  function isTyping(e) {
    const t = e.target;
    return (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox') || t.tagName === 'SELECT';
  }


  // ---------------------------------------------------------
  // 녹화·사진 저장
  // 화면을 실시간으로 찍지 않고, 정해진 해상도로 프레임을 하나씩 정확한 시간 간격으로 그려서 저장한다.
  // (그래서 화면이 버거운 장면도 영상은 끊김 없이 나옴)
  // 페이지의 매 프레임 함수는 requestAnimationFrame 으로 돌기 때문에, 녹화 중에는 그걸 가로채서
  // 가상의 시간으로 한 프레임씩 직접 돌린다.
  // ---------------------------------------------------------
  const capture = { active: false, stop: false };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function hijackFrames() {
    const real = global.requestAnimationFrame.bind(global);
    let queue = [];
    global.requestAnimationFrame = (cb) => { queue.push(cb); return 0; };
    return {
      async ready() { for (let i = 0; i < 200 && !queue.length; i++) await sleep(5); },
      run(t) { const q = queue; queue = []; for (const cb of q) cb(t); },
      restore() { global.requestAnimationFrame = real; const q = queue; queue = []; for (const cb of q) real(cb); },
    };
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = src; el.onload = res; el.onerror = () => rej(new Error('불러오기 실패: ' + src));
      document.head.appendChild(el);
    });
  }

  function stamp() {
    const d = new Date(), p = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function pageName() {
    const parts = location.pathname.split('/').filter(Boolean);
    let last = parts.pop() || 'home';
    if (/^index\.html?$/.test(last)) last = parts.pop() || 'home';
    return last.replace(/\.html?$/, '');
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }

  // 목표 세로 해상도 → 강제할 화면 크기 (가로는 지금 창 비율 그대로, 짝수로)
  function sizeFor(targetH, adapter) {
    const iw = global.innerWidth, ih = global.innerHeight;
    let H = targetH === 'screen' ? Math.round(ih * Math.min(global.devicePixelRatio || 1, 2)) : targetH;
    let W = Math.round(H * iw / ih);
    const max = adapter.maxSide ? adapter.maxSide() : 8192;
    if (W > max || H > max) { const k = max / Math.max(W, H); W = Math.floor(W * k); H = Math.floor(H * k); }
    W -= W % 2; H -= H % 2;
    return { W, H, forced: { W: iw, H: ih, DPR: H / ih } };
  }

  function compose(comp, ctx, adapter) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, comp.width, comp.height);
    for (const src of adapter.sources()) if (src && src.width) ctx.drawImage(src, 0, 0, comp.width, comp.height);
  }

  // 녹화 중 표시
  let badge = null;
  function showBadge(text, onStop) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'rec-badge';
      badge.innerHTML = '<span class="rec-dot"></span><span class="rec-text"></span><button class="rec-stop">■ 중지</button>';
      document.body.appendChild(badge);
    }
    badge.querySelector('.rec-text').textContent = text;
    const btn = badge.querySelector('.rec-stop');
    btn.style.display = onStop ? '' : 'none';
    btn.onclick = onStop || null;
    badge.style.display = 'flex';
  }
  function hideBadge() { if (badge) badge.style.display = 'none'; }

  async function savePhoto(adapter, targetH) {
    if (capture.active) return;
    capture.active = true;
    const frames = hijackFrames();
    try {
      showBadge('사진 그리는 중…');
      await frames.ready();
      const { W, H, forced } = sizeFor(targetH, adapter);
      adapter.setForced(forced);
      const t = performance.now();
      frames.run(t);                 // 새 해상도로 한 프레임 (시간은 거의 안 흐름)
      frames.run(t + 0.01);
      const comp = document.createElement('canvas');
      comp.width = W; comp.height = H;
      const ctx = comp.getContext('2d');
      compose(comp, ctx, adapter);
      const blob = await new Promise(r => comp.toBlob(r, 'image/png'));
      download(blob, `neon-lines-${pageName()}-${stamp()}.png`);
      toast(`사진 저장! ${W.toLocaleString()}×${H.toLocaleString()}`);
    } catch (err) {
      console.error(err);
      toast('사진 저장 실패: ' + (err.message || err));
    } finally {
      adapter.setForced(null);
      frames.restore();
      hideBadge();
      capture.active = false;
    }
  }

  async function recordVideo(adapter, opts) {
    if (capture.active) return;
    if (!('VideoEncoder' in global)) { toast('이 브라우저는 영상 녹화를 지원하지 않아요. 크롬이나 엣지에서 해보세요'); return; }
    capture.active = true; capture.stop = false;
    const frames = hijackFrames();
    let encoder = null;
    try {
      showBadge('녹화 준비 중…');
      if (!global.Mp4Muxer) await loadScript(SCRIPT_BASE + 'vendor/mp4-muxer.js');
      const fps = opts.fps;
      const { W, H, forced } = sizeFor(opts.height, adapter);
      const bitrate = Math.min(120e6, Math.round(W * H * fps * 0.12));
      // 되는 코덱 찾기 (H.264 → VP9)
      let cfg = null, muxCodec = 'avc';
      for (const codec of ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4d0034', 'avc1.42003e']) {
        const c = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
        try { if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; break; } } catch (e) { /* 다음 */ }
      }
      if (!cfg) {
        const c = { codec: 'vp09.00.51.08', width: W, height: H, bitrate, framerate: fps };
        if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; muxCodec = 'vp9'; }
      }
      if (!cfg) throw new Error(`${W}×${H} 영상을 만들 수 있는 코덱이 없어요. 해상도를 낮춰보세요`);

      const muxer = new global.Mp4Muxer.Muxer({
        target: new global.Mp4Muxer.ArrayBufferTarget(),
        video: { codec: muxCodec, width: W, height: H, frameRate: fps },
        fastStart: 'in-memory',
      });
      let encErr = null;
      encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
      encoder.configure(cfg);

      await frames.ready();
      adapter.setForced(forced);
      const comp = document.createElement('canvas');
      comp.width = W; comp.height = H;
      const ctx = comp.getContext('2d');

      const total = opts.seconds > 0 ? Math.round(opts.seconds * fps) : fps * 600;   // '중지할 때까지'는 최대 10분
      const label = `${H >= 2160 ? '4K' : H + 'p'} ${fps}fps`;
      let vt = performance.now();
      frames.run(vt);                // 새 해상도 적용용 한 프레임
      let f = 0;
      for (; f < total && !capture.stop; f++) {
        if (encErr) throw encErr;
        vt += 1000 / fps;
        frames.run(vt);
        compose(comp, ctx, adapter);
        const frame = new VideoFrame(comp, { timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
        frame.close();
        while (encoder.encodeQueueSize > 6) await sleep(2);
        if (f % 3 === 0) {
          const sec = (f + 1) / fps;
          showBadge(`녹화 중 ${sec.toFixed(1)}초${opts.seconds > 0 ? ' / ' + opts.seconds + '초' : ''} · ${label}`, () => { capture.stop = true; });
          await sleep(0);
        }
      }
      showBadge('영상 파일 만드는 중…');
      await encoder.flush();
      muxer.finalize();
      const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
      download(blob, `neon-lines-${pageName()}-${stamp()}.mp4`);
      toast(`영상 저장! ${(f / fps).toFixed(1)}초 · ${W}×${H} · ${(blob.size / 1e6).toFixed(1)}MB`);
    } catch (err) {
      console.error(err);
      toast('녹화 실패: ' + (err.message || err));
    } finally {
      try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (e) { /* */ }
      adapter.setForced(null);
      frames.restore();
      hideBadge();
      capture.active = false;
    }
  }

  // 패널에 '저장' 칸 붙이기
  function bindCapture(adapter) {
    const body = document.querySelector('#panel .panel-body');
    if (!body || body.querySelector('.capture-sec')) return;
    const sec = document.createElement('section');
    sec.className = 'capture-sec';
    sec.innerHTML = `
      <label class="label">저장</label>
      <div class="row buttons">
        <button class="cap-photo">📷 사진 저장</button>
        <button class="cap-video primary">🎬 영상 녹화</button>
      </div>
      <div class="cap-opts">
        <label>사진 <select class="cap-psize">
          <option value="screen2">화면 ×2</option><option value="2160">4K</option><option value="4320" selected>8K</option>
        </select></label>
        <label>영상 <select class="cap-vsize">
          <option value="1080">1080p</option><option value="1440">1440p</option><option value="2160" selected>4K</option>
        </select></label>
        <label>프레임 <select class="cap-fps"><option value="30">30</option><option value="60" selected>60</option></select></label>
        <label>길이 <select class="cap-len">
          <option value="5">5초</option><option value="10" selected>10초</option><option value="20">20초</option>
          <option value="30">30초</option><option value="60">1분</option><option value="120">2분</option><option value="0">중지할 때까지</option>
        </select></label>
      </div>
      <div class="hint">화면을 그대로 찍는 게 아니라 한 프레임씩 정확히 그려서 저장해요. 그래서 버거운 장면도 영상은 끊김 없이 나와요(대신 녹화 시간은 더 걸릴 수 있어요). 가로세로 비율은 지금 창과 같아요.</div>`;
    body.appendChild(sec);
    const q = (c) => sec.querySelector(c);
    const supported = adapter.ok();
    if (!supported) {
      q('.hint').textContent = 'GPU로 그릴 때만 저장할 수 있어요. 지금은 기본 캔버스 방식이에요.';
      q('.cap-photo').disabled = true; q('.cap-video').disabled = true;
      return;
    }
    q('.cap-photo').addEventListener('click', () => {
      const v = q('.cap-psize').value;
      const h = v === 'screen2' ? Math.round(global.innerHeight * Math.min(global.devicePixelRatio || 1, 2) * 2) : parseInt(v, 10);
      savePhoto(adapter, h);
    });
    q('.cap-video').addEventListener('click', () => {
      recordVideo(adapter, { height: parseInt(q('.cap-vsize').value, 10), fps: parseInt(q('.cap-fps').value, 10), seconds: parseInt(q('.cap-len').value, 10) });
    });
    // 단축키: P 사진, V 녹화 시작/중지
    global.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (e.key === 'p' || e.key === 'P') q('.cap-photo').click();
      if (e.key === 'v' || e.key === 'V') { if (capture.active) capture.stop = true; else q('.cap-video').click(); }
    });
  }

  // 선 굵기·번짐 슬라이더를 패널 맨 아래에 붙임 (모든 페이지 공통)
  function bindLineStyle() {
    const body = document.querySelector('#panel .panel-body');
    if (!body) return;
    const sec = document.createElement('section');
    sec.innerHTML = `
      <label class="label">선 굵기 <span class="value" id="lsCoreLabel"></span></label>
      <input id="lsCore" type="range" min="0.6" max="4" step="0.1">
      <label class="label" style="margin-top:12px">번짐 <span class="value" id="lsGlowLabel"></span></label>
      <input id="lsGlow" type="range" min="0" max="2" step="0.05">
      <div class="hint">모든 페이지에 똑같이 적용되고, 이 브라우저에 기억돼요.</div>`;
    body.appendChild(sec);
    const core = sec.querySelector('#lsCore'), glow = sec.querySelector('#lsGlow');
    const cl = sec.querySelector('#lsCoreLabel'), gl = sec.querySelector('#lsGlowLabel');
    const sync = () => {
      core.value = lineStyle.core; glow.value = lineStyle.glow;
      cl.textContent = lineStyle.core.toFixed(1) + 'px';
      gl.textContent = Math.round(lineStyle.glow * 100) + '%';
    };
    let t = 0;
    const apply = () => {
      cl.textContent = parseFloat(core.value).toFixed(1) + 'px';
      gl.textContent = Math.round(parseFloat(glow.value) * 100) + '%';
      clearTimeout(t);
      t = setTimeout(() => setLineStyle({ core: parseFloat(core.value), glow: parseFloat(glow.value) }), 120);
    };
    core.addEventListener('input', apply);
    glow.addEventListener('input', apply);
    sync();
  }

  const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  global.NeonKit = {
    K, GLOW_PX, CORE_PX, PALETTES,
    buildColors, zoneFactory, mulberry32, hslToRgb,
    ColorState, SegStore, NeonView,
    toast, bindSeg, bindColorControls, readParams, writeParams, colorFromParams,
    bindPanelToggle, isTyping, easeInOut,
    lineStyle, setLineStyle, onLineStyle: (f) => styleListeners.push(f), bindLineStyle, neonStroke,
    bindCapture, capture,
  };
})(window);
