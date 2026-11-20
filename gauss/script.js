/* =========================================================
   GAUSSIAN PRIME SPIRAL — 가우스 소수를 밟으면 왼쪽으로 꺾기
   한 '걸음' = 다음 가우스 소수까지 쭉 직진하는 선 하나
   ========================================================= */
(() => {
  'use strict';
  const NK = window.NeonKit;

  // ---------- 소수 판별 (n < 4,759,123,141 에서 정확: 밑 2, 7, 61) ----------
  const LIMIT = 4759123141;
  function mulmod(a, b, m) {
    const bh = Math.floor(b / 65536), bl = b - bh * 65536;
    return ((a * bh % m) * 65536 + a * bl) % m;
  }
  function powmod(b, e, m) {
    let r = 1; b %= m;
    while (e > 0) {
      if (e % 2 === 1) r = mulmod(r, b, m);
      b = mulmod(b, b, m);
      e = Math.floor(e / 2);
    }
    return r;
  }
  const SMALL = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71];
  function isPrime(n) {
    if (n < 2) return false;
    for (const p of SMALL) { if (n === p) return true; if (n % p === 0) return false; }
    if (n < 5329) return true;                 // 73²
    let d = n - 1, s = 0;
    while (d % 2 === 0) { d /= 2; s++; }
    outer: for (const a of [2, 7, 61]) {
      let x = powmod(a, d, n);
      if (x === 1 || x === n - 1) continue;
      for (let r = 1; r < s; r++) {
        x = mulmod(x, x, n);
        if (x === n - 1) continue outer;
      }
      return false;
    }
    return true;
  }
  function gaussPrime(a, b) {
    if (a === 0) { const v = Math.abs(b); return v % 4 === 3 && isPrime(v); }
    if (b === 0) { const v = Math.abs(a); return v % 4 === 3 && isPrime(v); }
    return isPrime(a * a + b * b);
  }

  // ---------- 걷기 ----------
  const BOUND = 48000;                         // a² + b² < LIMIT 이 되도록
  const params = NK.readParams();
  let a0 = clampInt(params.get('a'), 5), b0 = clampInt(params.get('b'), 23);
  function clampInt(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(-40000, Math.min(40000, n)) : d; }

  let a = 0, b = 0, da = 1, db = 0, closed = false, outOfRange = false, units = 0, turns = 0;

  // 한 줄: 다음 가우스 소수까지 직진. 닫히면 closed
  function run(st) {
    for (;;) {
      st.a += st.da; st.b += st.db; st.units++;
      if (Math.abs(st.a) > BOUND || Math.abs(st.b) > BOUND) { st.out = true; return; }
      let turned = false;
      if (gaussPrime(st.a, st.b)) { const t = st.da; st.da = -st.db; st.db = t; st.turns++; turned = true; }
      if (st.a === a0 && st.b === b0 && st.da === 1 && st.db === 0) { st.closed = true; return; }
      if (turned) return;
    }
  }

  // 한 바퀴 길이(선 개수)를 미리 재기 — 색을 정확히 한 바퀴에 맞추려고. 오래 걸리면 포기
  const loopCache = new Map();
  function measureLoop(A, B, budgetMs = 600) {
    const key = A + ',' + B;
    if (loopCache.has(key)) return loopCache.get(key);
    const st = { a: A, b: B, da: 1, db: 0, units: 0, turns: 0, closed: false, out: false };
    const prevA = a0, prevB = b0;
    a0 = A; b0 = B;
    const t0 = performance.now();
    let lines = 0, res = null;
    for (;;) {
      run(st); lines++;
      if (st.closed) { res = { lines, units: st.units }; break; }
      if (st.out) { res = { lines: -1 }; break; }
      if ((lines & 1023) === 0 && performance.now() - t0 > budgetMs) break;
    }
    a0 = prevA; b0 = prevB;
    if (res) loopCache.set(key, res);
    return res;
  }
  let loop = null;

  const walk = NK.Walk({
    unit: 10,
    maxSteps: 20000000,
    speedUnit: '줄/초',
    defaultColorMode: 'order',
    orderCycle: () => (loop && loop.lines > 0 ? loop.lines : 4000),
    reset() {
      a = a0; b = b0; da = 1; db = 0; closed = false; outOfRange = false; units = 0; turns = 0;
    },
    // 화면 좌표: x = a, y = −b (위가 +i)
    head: () => ({ x: a, y: -b, h: -Math.atan2(db, da) * 180 / Math.PI }),
    step() {
      if (closed || outOfRange) return false;
      const st = { a, b, da, db, units, turns, closed: false, out: false };
      run(st);
      a = st.a; b = st.b; da = st.da; db = st.db; units = st.units; turns = st.turns;
      closed = st.closed; outOfRange = st.out;
      return true;
    },
    hud(shown) {
      const tape = document.getElementById('tape');
      const rule = document.getElementById('rule');
      const sgn = v => (v < 0 ? '− ' + (-v) : '+ ' + v);
      tape.innerHTML = `<span class="dim">출발 ${a0} ${sgn(b0)}i →</span> 지금 <b style="color:#fff;font-size:19px">${a} ${sgn(b)}i</b>`;
      const nrm = a * a + b * b;
      rule.innerHTML = closed
        ? `<span class="hl">출발점으로 돌아왔어요!</span> 선 ${walk.store.n.toLocaleString('ko-KR')}개 · ${units.toLocaleString('ko-KR')}칸`
        : `a²+b² = <span class="hl">${nrm.toLocaleString('ko-KR')}</span>${a !== 0 && b !== 0 ? ' (소수)' : ''} → <span class="hl2">왼쪽 90°</span> · ${units.toLocaleString('ko-KR')}칸 걸음`;
    },
    hudKey: () => a0 + ',' + b0 + closed + (loop ? loop.lines : ''),
    status(api) {
      if (outOfRange) return '계산 범위(±48000) 밖으로 나가서 멈췄어요';
      if (closed) return '닫힌 무늬 완성';
      if (loop && loop.lines > 0) return `한 바퀴 ${loop.lines.toLocaleString('ko-KR')}줄 중 ${Math.floor(api.store.n / loop.lines * 100)}%`;
      return '아주 큰 고리 — 끝까지 가봐야 알아요';
    },
    params: () => ({ a: a0, b: b0 }),
  });

  // ---------- UI ----------
  const $ = id => document.getElementById(id);
  const inA = $('startA'), inB = $('startB');
  const presetBtns = [...document.querySelectorAll('#startPresets button')];
  function syncUi() {
    inA.value = a0; inB.value = b0;
    presetBtns.forEach(btn => btn.classList.toggle('on', btn.dataset.s === a0 + ',' + b0));
    walk.refreshHud();
  }
  function setStart(A, B) {
    a0 = A; b0 = B;
    loop = measureLoop(A, B);
    syncUi();
    walk.rebuild(false);
    if (walk.colorMode === 'order') walk.recolor();
    walk.syncUrl();
  }
  presetBtns.forEach(btn => btn.addEventListener('click', () => { const [A, B] = btn.dataset.s.split(',').map(Number); setStart(A, B); }));
  const useInputs = () => setStart(clampInt(inA.value, a0), clampInt(inB.value, b0));
  $('btnStart').addEventListener('click', useInputs);
  [inA, inB].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') useInputs(); }));

  // 아무 시작점: 너무 작지도, 너무 크지도 않은 고리가 나올 때까지 몇 번 시도
  $('btnRandomStart').addEventListener('click', () => {
    let best = null;
    const t0 = performance.now();
    for (let i = 0; i < 60 && performance.now() - t0 < 1500; i++) {
      const A = 1 + Math.floor(Math.random() * 600), B = 1 + Math.floor(Math.random() * 600);
      const r = measureLoop(A, B, 120);
      if (r && r.lines >= 200 && r.lines <= 200000) { best = [A, B, r.lines]; break; }
      if (r && r.lines > 40 && (!best || r.lines > best[2])) best = [A, B, r.lines];
    }
    if (!best) { NK.toast('이번엔 못 찾았어요. 한 번 더 눌러주세요'); return; }
    setStart(best[0], best[1]);
    NK.toast(`${best[0]} + ${best[1]}i — 한 바퀴 ${best[2].toLocaleString('ko-KR')}줄`);
  });

  loop = measureLoop(a0, b0);
  syncUi();
  walk.start();
})();
