/* =========================================================
   CURLICUE — 지수합 소용돌이
   상수 모드: n번째 걸음 방향 θₙ = π·s·n²  (= s·n²/2 바퀴)
   날짜 모드: n번째 걸음 방향 = n/월 + n²/일 + n³/연도 바퀴  (John D. Cook의 '오늘의 지수합')
   ========================================================= */
(() => {
  'use strict';
  const NK = window.NeonKit;

  const CONSTS = {
    pi:    { name: 'π',   v: '3.141592653589793238462643383279502884' },
    e:     { name: 'e',   v: '2.718281828459045235360287471352662497' },
    phi:   { name: 'φ',   v: '1.618033988749894848204586834365638117' },
    sqrt2: { name: '√2',  v: '1.414213562373095048801688724209698078' },
    sqrt3: { name: '√3',  v: '1.732050807568877293527446341505872366' },
    ln2:   { name: 'ln 2', v: '0.693147180559945309417232121458176568' },
    gamma: { name: 'γ',   v: '0.577215664901532860606512090082402431' },
    frac:  { name: '13/31', v: '13/31' },
  };
  const MAX_CONST = 2000000;
  const TWO64 = 1n << 64n, MASK65 = (1n << 65n) - 1n;

  // "3.14…" 또는 "p/q" → s·2⁶⁴ (정수, BigInt).  실패하면 null
  function parseS(str) {
    str = String(str).trim().replace(/\s+/g, '');
    let m = str.match(/^(-?)(\d+)\/(\d+)$/);
    if (m) {
      const q = BigInt(m[3]);
      if (q === 0n) return null;
      const F = BigInt(m[2]) * TWO64 / q;
      return m[1] ? -F : F;
    }
    m = str.match(/^(-?)(\d*)(?:\.(\d*))?$/);
    if (!m || (!m[2] && !m[3])) return null;
    const frac = (m[3] || '').slice(0, 60);
    const F = BigInt((m[2] || '0') + frac) * TWO64 / (10n ** BigInt(frac.length));
    return m[1] ? -F : F;
  }

  const params = NK.readParams();
  let mode = params.get('mode') === 'date' ? 'date' : 'const';
  let constKey = CONSTS[params.get('c')] ? params.get('c') : (params.get('s') ? 'custom' : 'pi');
  let customS = params.get('s') || '';
  let F = parseS(constKey === 'custom' ? customS : CONSTS[constKey].v);
  if (F === null) { constKey = 'pi'; F = parseS(CONSTS.pi.v); }

  // 날짜
  const pad = v => String(v).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  let dateStr = /^\d{4}-\d{2}-\d{2}$/.test(params.get('d') || '') ? params.get('d') : today();
  let dm = 1, dd = 1, dy = 1, dM = 1, dL = 1;
  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
  const lcm = (a, b) => a / gcd(a, b) * b;
  function setDateParts() {
    const [Y, Mo, D] = dateStr.split('-').map(Number);
    dm = Mo; dd = D; dy = Y % 100 || 100;
    dM = dm * dd * dy;
    dL = lcm(lcm(dm, dd), dy);
  }
  setDateParts();

  // 걷기 상태
  let x = 0, y = 0, h = 0, n = 0;
  let A = 0n, D = 0n;          // A = F·n² mod 2⁶⁵,  D = F·(2n+1) mod 2⁶⁵

  function dateTurn(i) {        // i번째 걸음의 방향 (바퀴, 0~1)
    const r = i % dM;
    const r2 = (r * r) % dM;
    const r3 = (r2 * r) % dM;
    const num = (r * dd * dy + r2 * dm * dy + r3 * dm * dd) % dM;
    return num / dM;
  }

  const walk = NK.Walk({
    unit: 10,
    get maxSteps() { return mode === 'date' ? dL : MAX_CONST; },
    speedUnit: '걸음/초',
    orderCycle: () => mode === 'date' ? dL : 20000,
    reset() {
      x = 0; y = 0; n = 0;
      A = 0n; D = ((F % (MASK65 + 1n)) + (MASK65 + 1n)) & MASK65;   // n=0 → D = F
      h = mode === 'date' ? dateTurn(0) * 360 : 0;
    },
    head: () => ({ x, y, h }),
    step() {
      let turn;
      if (mode === 'date') {
        if (n >= dL) return false;
        turn = dateTurn(n);
      } else {
        turn = Number(A >> 33n) / 4294967296;     // A / 2⁶⁵
        A = (A + D) & MASK65;
        D = (D + (F << 1n)) & MASK65;
      }
      const r = turn * 2 * Math.PI;
      x += Math.cos(r); y -= Math.sin(r);         // 수학 좌표(위가 +)로 그림
      n++;
      // 다음 걸음이 향할 방향을 거북이 머리 방향으로
      const nt = mode === 'date' ? dateTurn(n) : Number(A >> 33n) / 4294967296;
      h = -nt * 360;
      return true;
    },
    hud(shown) {
      const tape = document.getElementById('tape');
      const rule = document.getElementById('rule');
      if (mode === 'date') {
        tape.innerHTML = `<span class="dim">${dateStr}</span> → <b style="color:#fff;font-size:18px">n/${dm} + n²/${dd} + n³/${dy}</b> <span class="dim">바퀴</span>`;
        rule.innerHTML = `한 바퀴 = <span class="hl">${dL.toLocaleString('ko-KR')}</span>걸음 · 지금 n = <span class="hl2">${shown.toLocaleString('ko-KR')}</span>`;
      } else {
        const name = constKey === 'custom' ? customS : CONSTS[constKey].name;
        const val = constKey === 'custom' ? '' : ` = ${CONSTS[constKey].v.slice(0, 14)}…`;
        tape.innerHTML = `s = <b style="color:#fff;font-size:18px">${escapeHtml(name)}</b><span class="dim">${val}</span>`;
        rule.innerHTML = `θ<sub>n</sub> = π·s·n² · n = <span class="hl2">${shown.toLocaleString('ko-KR')}</span> → <span class="hl">${(((-h % 360) + 360) % 360).toFixed(1)}°</span>`;
      }
    },
    hudKey: () => mode + constKey + customS + dateStr,
    status(api) {
      if (mode === 'date') return api.finished ? '한 바퀴 완성 — 여기서부터는 같은 모양이 반복돼요' : `${Math.floor(api.k / dL * 100)}%`;
      return api.finished ? `${MAX_CONST.toLocaleString('ko-KR')}걸음 끝까지 완료` : '그리는 중';
    },
    params: () => mode === 'date' ? { mode, d: dateStr } : (constKey === 'custom' ? { s: customS } : { c: constKey }),
    onKey(e) {
      if (mode !== 'date') return false;
      if (e.key === '[') { shiftDate(-1); return true; }
      if (e.key === ']') { shiftDate(1); return true; }
      return false;
    },
  });
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- UI ----------
  const $ = id => document.getElementById(id);
  const constBlock = $('constBlock'), dateBlock = $('dateBlock');
  const presetBtns = [...document.querySelectorAll('#constPresets button')];
  const dateIn = $('dateIn'), dateHint = $('dateHint'), customIn = $('customS');

  function syncUi() {
    setModeSeg(mode);
    constBlock.style.display = mode === 'const' ? '' : 'none';
    dateBlock.style.display = mode === 'date' ? '' : 'none';
    presetBtns.forEach(b => b.classList.toggle('on', b.dataset.c === constKey));
    if (constKey === 'custom') customIn.value = customS;
    dateIn.value = dateStr;
    dateHint.textContent = `${dm}월 ${dd}일, ${dy}년 → 한 바퀴 ${dL.toLocaleString('ko-KR')}걸음. 날짜마다 다른 무늬가 나와요. [ ] 키로 하루씩 넘겨보세요.`;
    walk.refreshHud();
  }
  const setModeSeg = NK.bindSeg($('modeSeg'), 'mode', m => {
    if (m === mode) return;
    mode = m; syncUi(); walk.rebuild(false); walk.syncUrl();
  });

  function pickConst(key) {
    constKey = key; F = parseS(CONSTS[key].v);
    syncUi(); walk.rebuild(false); walk.syncUrl();
  }
  presetBtns.forEach(b => b.addEventListener('click', () => pickConst(b.dataset.c)));
  function useCustom() {
    const v = customIn.value.trim();
    const f = parseS(v);
    if (f === null) { NK.toast('숫자(예: 0.618)나 분수(예: 5/17)로 넣어주세요'); return; }
    constKey = 'custom'; customS = v; F = f;
    syncUi(); walk.rebuild(false); walk.syncUrl();
  }
  $('btnCustom').addEventListener('click', useCustom);
  customIn.addEventListener('keydown', e => { if (e.key === 'Enter') useCustom(); });

  function setDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return;
    dateStr = s; setDateParts(); syncUi(); walk.rebuild(false); walk.syncUrl();
  }
  function shiftDate(dlt) {
    const [Y, Mo, Dd] = dateStr.split('-').map(Number);
    const d = new Date(Y, Mo - 1, Dd + dlt);
    setDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  dateIn.addEventListener('change', () => setDate(dateIn.value));
  $('datePrev').addEventListener('click', () => shiftDate(-1));
  $('dateNext').addEventListener('click', () => shiftDate(1));
  $('dateToday').addEventListener('click', () => setDate(today()));
  $('dateRandom').addEventListener('click', () => {
    const d = new Date(2000 + Math.floor(Math.random() * 50), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28));
    setDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  });

  syncUi();
  walk.start();
})();
