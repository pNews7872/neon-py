/* =========================================================
   거북이 산책 공통 엔진 (NeonKit.Walk)
   — 규칙에 따라 한 걸음씩 움직이며 선을 긋는 페이지들이 함께 씀
   (지수합 커리큘, 피보나치 단어, 투에-모스, 가우스 소수 나선)

   페이지가 넘겨주는 것:
     unit            : 한 걸음 길이(월드 단위)
     reset()         : 처음 상태로
     step()          : 한 걸음 진행. 더 갈 수 없으면 false
     head()          : 지금 거북이 { x, y, h }  (걸음 단위 좌표, h = 화면 기준 각도°, 0 = 오른쪽, 시계방향 +)
     maxSteps        : 최대 걸음 수
     orderCycle()    : '그린 순서' 색칠에서 무지개 한 바퀴 = 선 몇 개
     hud(k, animating): HUD의 수열 표시 갱신 (선택)
     status()        : 상태 글 (선택)
     params()        : 주소창에 남길 페이지 설정 (선택)
     speedUnit       : '줄/초' 등
     onKey(e)        : 페이지 전용 단축키 (선택)
   ========================================================= */
(function (global) {
  'use strict';
  const NK = global.NeonKit;
  const K = NK.K;

  function Walk(page) {
    const params = NK.readParams();
    const color = new NK.ColorState(NK.colorFromParams(params));
    const store = new NK.SegStore();
    const U = page.unit || 10;
    let colorMode = params.get('cm') === 'zone' ? 'zone' : (params.get('cm') === 'order' ? 'order' : (page.defaultColorMode || 'order'));
    let showTurtle = true;

    let k = 0;               // 끝낸 걸음 수
    let finished = false;
    let playing = true;
    let speed = 2, acc = 0;
    const ANIM_MAX = 40;     // 이 속도 이하면 한 걸음씩 자라는 모습
    const anim = { active: false, t: 0, from: null, to: null, moved: false, color: 0 };

    const view = new NK.NeonView({
      trail: document.getElementById('trail'),
      overlay: document.getElementById('overlay'),
      store, color,
      camMode: params.get('cam') === 'follow' ? 'follow' : 'fit',
      onCamMode: m => setCamSeg && setCamSeg(m),
      followPoint: () => { const p = turtle(); return [p.x * U, p.y * U]; },
    });
    const oCtx = view.overlay.getContext('2d');

    // ---------- 색 ----------
    function colorFor(i, x0, y0, x1, y1) {
      if (colorMode === 'zone') return color.zoneAt((x0 + x1) / 2, (y0 + y1) / 2);
      const cyc = Math.max(1, page.orderCycle ? page.orderCycle() : 4000);
      return Math.floor((i % cyc) / cyc * K) % K;
    }
    function recolor() {
      store.recolor((i, x0, y0, x1, y1) => colorFor(i, x0, y0, x1, y1));
      if (anim.active && anim.moved) anim.color = colorFor(store.n, anim.from.x * U, anim.from.y * U, anim.to.x * U, anim.to.y * U);
      view.sendConfig();
      view.resetRenderer();
    }

    // ---------- 걸음 ----------
    const snap = () => { const h = page.head(); return { x: h.x, y: h.y, h: h.h }; };

    // 한 걸음: 페이지 상태를 진행시키고 { from, to, moved } 반환 (선은 아직 안 넣음)
    function advance() {
      if (finished) return null;
      if (k >= page.maxSteps) { finished = true; return null; }
      const from = snap();
      if (page.step() === false) { finished = true; return null; }
      const to = snap();
      return { from, to, moved: from.x !== to.x || from.y !== to.y };
    }
    function pushSeg(r) {
      k++;
      if (!r.moved) return;
      const x1 = r.to.x * U, y1 = r.to.y * U;
      store.push(x1, y1, colorFor(store.n, store.lastX, store.lastY, x1, y1));
    }
    function commitOne() {
      const r = advance();
      if (!r) return false;
      pushSeg(r);
      return true;
    }

    function startAnim() {
      const r = advance();
      if (!r) return false;
      anim.from = r.from; anim.to = r.to; anim.moved = r.moved; anim.t = 0; anim.active = true;
      anim.color = r.moved ? colorFor(store.n, r.from.x * U, r.from.y * U, r.to.x * U, r.to.y * U) : 0;
      return true;
    }
    function finishAnim() {
      if (!anim.active) return;
      anim.active = false;
      pushSeg(anim);
    }

    function lerpAngle(a, b, t) {
      const d = ((b - a) % 360 + 540) % 360 - 180;
      return a + d * t;
    }
    // 화면에 보일 거북이 위치 (움직이는 중이면 중간)
    function turtle() {
      if (!anim.active) return snap();
      const t = anim.t;
      if (!anim.moved) return { x: anim.to.x, y: anim.to.y, h: lerpAngle(anim.from.h, anim.to.h, NK.easeInOut(t)) };
      // 움직이면서 방향이 바뀌는 걸음(가우스 나선 등)은 앞 70%는 이동, 뒤 30%는 회전
      const turns = Math.abs(((anim.to.h - anim.from.h) % 360 + 540) % 360 - 180) > 0.01;
      const mt = turns ? Math.min(1, t / 0.7) : t;
      const rt = turns ? Math.max(0, (t - 0.7) / 0.3) : 0;
      return {
        x: anim.from.x + (anim.to.x - anim.from.x) * mt,
        y: anim.from.y + (anim.to.y - anim.from.y) * mt,
        h: lerpAngle(anim.from.h, anim.to.h, NK.easeInOut(rt)),
      };
    }

    // 처음부터 다시 (count 걸음까지 바로 계산)
    function rebuild(count = 0) {
      page.reset(); { const h0 = page.head(); store.reset(h0.x * U, h0.y * U); } k = 0; finished = false; anim.active = false; acc = 0;
      const t0 = performance.now();
      while (k < count && commitOne()) {
        if (performance.now() - t0 > 4000) break;   // 너무 오래 걸리면 거기까지만
      }
      view.resetRenderer(true);
      if (view.camMode === 'fit') view.fitTarget(true);
    }

    // 카메라를 출발점으로
    function camHome() {
      view.resetCamera(page.startScale || 2);
      const c = view.cam, t = view.target;
      c.x = t.x = store.pts[0]; c.y = t.y = store.pts[1];
    }

    // ---------- 그리기 ----------
    function drawOverlay() {
      const W = view.W, H = view.H;
      oCtx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
      oCtx.clearRect(0, 0, W, H);
      const p = turtle();
      const COL = color.colors;
      const [hx, hy] = view.worldToScreen(p.x * U, p.y * U);

      if (anim.active && anim.moved) {
        const [ax, ay] = view.worldToScreen(anim.from.x * U, anim.from.y * U);
        oCtx.lineCap = 'round';
        oCtx.strokeStyle = COL[anim.color];
        oCtx.globalAlpha = 0.25; oCtx.lineWidth = NK.lineStyle.core * 3.5;
        oCtx.beginPath(); oCtx.moveTo(ax, ay); oCtx.lineTo(hx, hy); oCtx.stroke();
        oCtx.globalAlpha = 1; oCtx.lineWidth = NK.lineStyle.core;
        oCtx.beginPath(); oCtx.moveTo(ax, ay); oCtx.lineTo(hx, hy); oCtx.stroke();
      }
      if (!showTurtle || finished && !anim.active && page.hideTurtleWhenDone) return;
      if (hx < -40 || hy < -40 || hx > W + 40 || hy > H + 40) return;
      const last = store.n > 0 ? store.cols[store.n - 1] : 0;
      const c = COL[anim.active && anim.moved ? anim.color : (last === 255 ? 0 : last)];
      const a = p.h * Math.PI / 180;
      const fx = Math.cos(a), fy = Math.sin(a);
      const R = 11;
      oCtx.save();
      oCtx.translate(hx, hy);
      oCtx.shadowColor = c; oCtx.shadowBlur = 14;
      oCtx.fillStyle = 'rgba(10,10,20,0.55)';
      oCtx.strokeStyle = c; oCtx.lineWidth = 1.6;
      oCtx.beginPath();
      oCtx.moveTo(fx * R * 1.3, fy * R * 1.3);
      oCtx.lineTo(-fx * R * 0.7 - fy * R * 0.75, -fy * R * 0.7 + fx * R * 0.75);
      oCtx.lineTo(-fx * R * 0.35, -fy * R * 0.35);
      oCtx.lineTo(-fx * R * 0.7 + fy * R * 0.75, -fy * R * 0.7 - fx * R * 0.75);
      oCtx.closePath();
      oCtx.fill(); oCtx.stroke();
      oCtx.shadowBlur = 0;
      oCtx.fillStyle = '#fff';
      oCtx.beginPath(); oCtx.arc(0, 0, 2, 0, Math.PI * 2); oCtx.fill();
      oCtx.restore();
    }

    // ---------- 메인 루프 ----------
    let lastT = performance.now();
    function frame(now) {
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      if (playing && !finished) {
        if (speed <= ANIM_MAX) {
          if (!anim.active) startAnim();
          if (anim.active) { anim.t += dt * speed; if (anim.t >= 1) finishAnim(); }
        } else {
          if (anim.active) finishAnim();
          acc += speed * dt;
          let n = Math.floor(acc); acc -= n;
          const t0 = performance.now();
          while (n-- > 0 && commitOne()) {
            if ((n & 255) === 0 && performance.now() - t0 > 12) { acc = 0; break; }   // 한 프레임 12ms까지만
          }
        }
      }
      view.tick(dt, now);
      drawOverlay();
      updateHud();
      requestAnimationFrame(frame);
    }

    // ---------- HUD ----------
    const elCount = document.getElementById('statCount');
    const elZoom = document.getElementById('statZoom');
    const elStatus = document.getElementById('statStatus');
    let hudKey = '';
    function updateHud() {
      const shown = anim.active ? k + 1 : k;
      const key = shown + '|' + Math.round(view.cam.s * 1000) + '|' + finished + '|' + playing + '|' + color.seed + color.paletteKey + colorMode + (page.hudKey ? page.hudKey() : '');
      if (key === hudKey) return;
      hudKey = key;
      elCount.textContent = shown.toLocaleString('ko-KR');
      elZoom.textContent = view.zoomLabel();
      if (page.hud) page.hud(shown, anim.active, api);
      elStatus.textContent = page.status ? page.status(api) : (finished ? '끝까지 그렸어요' : (playing ? '그리는 중' : '멈춤'));
    }

    // ---------- 컨트롤 ----------
    const $ = id => document.getElementById(id);
    const btnPlay = $('btnPlay');
    function setPlaying(p) { playing = p; btnPlay.textContent = p ? '⏸ 일시정지' : '▶ 재생'; }
    btnPlay.addEventListener('click', () => {
      if (finished && !playing) { restart(); return; }
      setPlaying(!playing);
    });
    function stepOnce() {
      setPlaying(false);
      if (anim.active) finishAnim(); else commitOne();
    }
    $('btnStep').addEventListener('click', stepOnce);
    function restart() {
      rebuild(0);
      camHome();
      if (view.camMode === 'free') view.setCamMode('fit');
      setPlaying(true);
    }
    $('btnReset').addEventListener('click', restart);

    const speedInput = $('speed'), speedLabel = $('speedLabel');
    const sliderToSpeed = v => 0.5 * Math.pow(400000, v / 100);
    function updateSpeed() {
      speed = sliderToSpeed(parseFloat(speedInput.value));
      const txt = speed < 10 ? speed.toFixed(1) : Math.round(speed).toLocaleString('ko-KR');
      speedLabel.textContent = `${txt} ${page.speedUnit || '걸음/초'}`;
    }
    speedInput.addEventListener('input', updateSpeed);

    const setCamSeg = NK.bindSeg($('camSeg'), 'cam', m => view.setCamMode(m));

    const zoneBlock = $('zoneBlock');
    const setCmSeg = NK.bindSeg($('cmSeg'), 'cm', cm => {
      if (cm === colorMode) return;
      colorMode = cm; setCmSeg(cm); zoneBlock.classList.toggle('disabled', cm !== 'zone');
      recolor(); syncUrl();
    });

    function syncUrl() {
      const p = { seed: color.seed, pal: color.paletteKey, cm: colorMode };
      if (colorMode === 'zone') p.zone = color.zoneScale;
      Object.assign(p, page.params ? page.params() : {});
      NK.writeParams(p);
    }

    const colorUi = NK.bindColorControls(color, {
      palette: 'paletteSel', gradBar: 'gradBar', zone: 'zoneSize', zoneLabel: 'zoneLabel',
      seed: 'seedInput', reseed: 'btnReseed', zones: 'chkZones',
    }, what => {
      if (what === 'zones') { view.sendConfig(); view.rerender && view.rerender(); return; }
      recolor(); syncUrl();
    });
    $('chkTurtle').addEventListener('change', e => { showTurtle = e.target.checked; });
    NK.bindPanelToggle();

    global.addEventListener('keydown', e => {
      if (NK.isTyping(e)) return;
      if (page.onKey && page.onKey(e)) return;
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

    const api = {
      view, store, color,
      get k() { return k; }, get finished() { return finished; }, get playing() { return playing; },
      get colorMode() { return colorMode; },
      setPlaying, restart, syncUrl, recolor,
      // 설정이 바뀌었을 때: 같은 걸음 수까지 바로 다시 그림 (keep=false면 처음부터)
      rebuild(keep = true) {
        const n = keep ? k : 0;
        rebuild(n);
        if (!keep) { camHome(); if (view.camMode === 'free') view.setCamMode('fit'); setPlaying(true); }
        hudKey = '';
      },
      refreshHud() { hudKey = ''; },
      start() {
        setCmSeg(colorMode);
        zoneBlock.classList.toggle('disabled', colorMode !== 'zone');
        setCamSeg(view.camMode);
        updateSpeed();
        rebuild(0);
        camHome();
        if (view.camMode === 'fit') view.fitTarget(true);
        syncUrl();
        requestAnimationFrame(frame);
      },
    };
    return api;
  }

  NK.Walk = Walk;
})(window);
