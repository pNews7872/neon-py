/* =========================================================
   THUE–MORSE — 투에-모스 수열을 읽는 거북이
   t(n) = n의 2진수에서 1의 개수 % 2.  0 → 한 칸 앞으로, 1 → 제자리에서 회전
   ========================================================= */
(() => {
  'use strict';
  const NK = window.NeonKit;

  const MAX = 1 << 22;                       // 약 420만 글자 (선은 그 절반)
  const tm = n => {                          // 1의 개수 홀짝
    n ^= n >>> 16; n ^= n >>> 8; n ^= n >>> 4; n ^= n >>> 2; n ^= n >>> 1;
    return n & 1;
  };

  const params = NK.readParams();
  let angle = Math.max(1, Math.min(179, parseInt(params.get('ang'), 10) || 60));
  let x = 0, y = 0, h = 0, n = 0;

  const walk = NK.Walk({
    unit: 10,
    maxSteps: MAX,
    speedUnit: '글자/초',
    orderCycle: () => 4096,
    reset() { x = 0; y = 0; h = 0; n = 0; },
    head: () => ({ x, y, h }),
    step() {
      if (n >= MAX) return false;
      if (tm(n) === 0) {
        const r = h * Math.PI / 180;
        x += Math.cos(r); y += Math.sin(r);
      } else {
        h = ((h - angle) % 360 + 360) % 360;   // 화면 기준 반시계(왼쪽)로 회전
      }
      n++;
      return true;
    },
    hud(shown) {
      const idx = shown - 1;
      const tape = document.getElementById('tape');
      const rule = document.getElementById('rule');
      if (idx < 0) { tape.textContent = ''; rule.textContent = ''; return; }
      const from = Math.max(0, idx - 40);
      let s = '';
      for (let j = from; j < idx; j++) s += tm(j);
      const v = tm(idx);
      const col = walk.color.colors[walk.store.n ? walk.store.cols[walk.store.n - 1] : 0];
      tape.innerHTML = (from > 0 ? '…' : '') + s + `<b style="color:${col}">${v}</b>`;
      rule.innerHTML = `n = ${idx.toLocaleString('ko-KR')} = <span class="dim">${idx.toString(2)}₂</span> · 1이 ${popcount(idx)}개 → <span class="hl">${v}</span> → ` +
        (v === 0 ? '<span class="hl2">한 칸 앞으로</span>' : `<span class="hl2">${angle}° 회전</span>`);
    },
    hudKey: () => angle,
    status(api) {
      if (api.finished) return `${MAX.toLocaleString('ko-KR')}글자 끝까지 완료`;
      return `선 ${api.store.n.toLocaleString('ko-KR')}개`;
    },
    params: () => ({ ang: angle }),
  });
  function popcount(v) { let c = 0; while (v) { v &= v - 1; c++; } return c; }

  // ---------- 각도 ----------
  const angIn = document.getElementById('ang');
  const angLabel = document.getElementById('angLabel');
  const presets = [...document.querySelectorAll('#angPresets button')];
  function syncAngUi() {
    angIn.value = angle; angLabel.textContent = angle + '°';
    document.getElementById('linkInf').href = 'infinite.html?ang=' + angle;
    presets.forEach(b => b.classList.toggle('on', +b.dataset.a === angle));
  }
  let t = 0;
  function setAngle(a, now) {
    angle = a; syncAngUi();
    clearTimeout(t);
    const go = () => { walk.rebuild(true); walk.syncUrl(); };
    if (now) go(); else t = setTimeout(go, 60);
  }
  angIn.addEventListener('input', () => setAngle(parseInt(angIn.value, 10)));
  presets.forEach(b => b.addEventListener('click', () => setAngle(+b.dataset.a, true)));
  syncAngUi();
  walk.start();
})();
