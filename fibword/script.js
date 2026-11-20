/* =========================================================
   FIBONACCI WORD — 피보나치 단어를 읽으며 꺾는 거북이
   k번째 글자: 한 칸 긋고, 글자가 0이면 k가 짝수일 때 왼쪽·홀수일 때 오른쪽으로 꺾기
   ========================================================= */
(() => {
  'use strict';
  const NK = window.NeonKit;

  // 피보나치 단어: S(n) = S(n-1) + S(n-2), 앞부분은 늘 같으니 한 버퍼에 이어 붙이면 됨
  const MAX = 2178309;                       // 피보나치 수 F(32)
  const word = new Uint8Array(MAX + 8);
  const fibLens = [1, 2];
  word[0] = 0; word[1] = 1;                  // "01"
  {
    let a = 1, b = 2;                        // |S(n-2)|, |S(n-1)|
    while (b < MAX) {
      const n = Math.min(MAX, b + a);
      word.copyWithin(b, 0, n - b);
      a = b; b = n; fibLens.push(n);
    }
  }

  const params = NK.readParams();
  let angle = Math.max(1, Math.min(179, parseInt(params.get('ang'), 10) || 90));
  let x = 0, y = 0, h = 0, i = 0;            // i = 다음에 읽을 글자 위치(0부터)

  const nextFib = n => fibLens.find(f => f > n) || MAX;
  const prevFib = n => { let p = 0; for (const f of fibLens) { if (f <= n) p = f; else break; } return p; };

  const walk = NK.Walk({
    unit: 10,
    maxSteps: MAX,
    speedUnit: '글자/초',
    orderCycle: () => 6765,
    reset() { x = 0; y = 0; h = -90; i = 0; },
    head: () => ({ x, y, h }),
    step() {
      if (i >= MAX) return false;
      const r = h * Math.PI / 180;
      x += Math.cos(r); y += Math.sin(r);
      x = Math.round(x * 1e9) / 1e9; y = Math.round(y * 1e9) / 1e9;   // 90°일 때 누적 오차 없애기
      const k = i + 1;
      if (word[i] === 0) h += (k % 2 === 0 ? -angle : angle);          // 화면 기준 −가 왼쪽
      h = ((h % 360) + 360) % 360;
      i++;
      return true;
    },
    hud(shown) {
      const idx = shown - 1;
      const tape = document.getElementById('tape');
      const rule = document.getElementById('rule');
      if (idx < 0) { tape.textContent = ''; rule.textContent = ''; return; }
      const from = Math.max(0, idx - 40);
      let s = '';
      for (let j = from; j < idx; j++) s += word[j];
      tape.innerHTML = (from > 0 ? '…' : '') + s + `<b style="color:${walk.color.colors[walk.store.n ? walk.store.cols[walk.store.n - 1] : 0]}">${word[idx]}</b>`;
      const k = idx + 1;
      rule.innerHTML = word[idx] === 0
        ? `${k.toLocaleString('ko-KR')}번째 = <span class="hl">0</span> · ${k % 2 === 0 ? '짝수 번째' : '홀수 번째'} → <span class="hl2">${k % 2 === 0 ? '왼쪽' : '오른쪽'} ${angle}°</span>`
        : `${k.toLocaleString('ko-KR')}번째 = <span class="hl">1</span> → 직진`;
    },
    hudKey: () => angle,
    status(api) {
      const n = api.k;
      if (api.finished) return `${MAX.toLocaleString('ko-KR')}글자 끝까지 완료`;
      const p = prevFib(n), nx = nextFib(n);
      if (n === p && n > 2) return `피보나치 수 ${n.toLocaleString('ko-KR')}글자 — 완성 모양!`;
      return `다음 완성: ${nx.toLocaleString('ko-KR')}글자`;
    },
    params: () => ({ ang: angle }),
  });

  // ---------- 각도 ----------
  const angIn = document.getElementById('ang');
  const angLabel = document.getElementById('angLabel');
  const presets = [...document.querySelectorAll('#angPresets button')];
  function syncAngUi() {
    angIn.value = angle; angLabel.textContent = angle + '°';
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
