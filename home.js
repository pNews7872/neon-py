/* 메인 화면: 카드 미리보기 + 배경 효과 */
(() => {
  'use strict';
  const NK = window.NeonKit;
  const K = NK.K;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  // ---------- 원주율 (미리보기용 4000자리) ----------
  function piDigits(digits) {
    const C3_24 = 640320n ** 3n / 24n;
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
      const [P1, Q1, T1] = bs(a, m), [P2, Q2, T2] = bs(m, b);
      return [P1 * P2, Q1 * Q2, T1 * Q2 + P1 * T2];
    }
    function isqrt(n) {
      let x = 1n << BigInt(Math.ceil(n.toString(16).length * 2));
      for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
    }
    const D = digits + 20;
    const [, Q, T] = bs(0n, BigInt(Math.floor(D / 14) + 2));
    const one = 10n ** BigInt(D);
    return ((Q * 426880n * isqrt(10005n * one * one)) / T).toString().slice(0, digits);
  }

  // ---------- 선 만들기 ----------
  function piPath(count) {
    const s = piDigits(count);
    const pts = [[0, 0]];
    let x = 0, y = 0;
    for (let i = 0; i < count; i++) {
      const r = (s.charCodeAt(i) - 48) * 36 * Math.PI / 180;
      x += Math.sin(r); y -= Math.cos(r);
      pts.push([x, y]);
    }
    return pts;
  }
  function dragonPath(gens) {
    const pts = [[0, 0], [1, 0]];
    for (let g = 0; g < gens; g++) {
      const [px, py] = pts[pts.length - 1];
      for (let v = pts.length - 2; v >= 0; v--) {
        const dx = pts[v][0] - px, dy = pts[v][1] - py;
        pts.push([px - dy, py + dx]);
      }
    }
    return pts;
  }

  function recamanPath(count) {
    const seen = new Set([0]);
    const pts = [[0, 0]];
    let p = 0;
    for (let n = 1; n <= count; n++) {
      const v = (p - n > 0 && !seen.has(p - n)) ? p - n : p + n;
      seen.add(v);
      const cx = (p + v) / 2, r = Math.abs(v - p) / 2, d = Math.sign(v - p), side = n % 2 ? -1 : 1;
      const segs = Math.max(8, Math.ceil(Math.sqrt(r) * 6));
      for (let i = 1; i <= segs; i++) {
        const a = Math.PI * i / segs;
        pts.push([cx - d * r * Math.cos(a), side * r * Math.sin(a)]);
      }
      p = v;
    }
    return pts;
  }

  // ---------- 미리보기: 천천히 그려지는 애니메이션 ----------
  function setupPreview(canvas, pts, palette, colorOf) {
    const { colors } = NK.buildColors(palette, 1);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const ctx = canvas.getContext('2d');
    let drawn = 0, s = 1, ox = 0, oy = 0;

    function fit() {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.round(r.width * DPR);
      canvas.height = Math.round(r.height * DPR);
      const pad = 18 * DPR;
      s = Math.min((canvas.width - pad * 2) / (maxX - minX || 1), (canvas.height - pad * 2) / (maxY - minY || 1));
      ox = canvas.width / 2 - (minX + maxX) / 2 * s;
      oy = canvas.height / 2 - (minY + maxY) / 2 * s;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawRange(0, drawn);
    }
    function drawRange(a, b) {
      ctx.lineCap = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.globalAlpha = pass ? 0.95 : 0.18;
        ctx.lineWidth = (pass ? 1.2 : 5) * DPR;
        for (let i = a; i < b; i++) {
          ctx.strokeStyle = colors[colorOf(i, pts.length - 1)];
          ctx.beginPath();
          ctx.moveTo(pts[i][0] * s + ox, pts[i][1] * s + oy);
          ctx.lineTo(pts[i + 1][0] * s + ox, pts[i + 1][1] * s + oy);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
    fit();
    window.addEventListener('resize', fit);

    const total = pts.length - 1;
    const perFrame = Math.max(1, Math.ceil(total / 240));   // 약 4초에 걸쳐 그리기
    (function step() {
      if (drawn >= total) return;
      const next = Math.min(total, drawn + perFrame);
      drawRange(drawn, next);
      drawn = next;
      requestAnimationFrame(step);
    })();
  }

  const piPts = piPath(4000);
  const dragonPts = dragonPath(12);
  for (const card of document.querySelectorAll('.card')) {
    const cv = card.querySelector('.preview');
    if (card.dataset.preview === 'pi') {
      setupPreview(cv, piPts, 'neon', (i, n) => Math.floor(i / n * K) % K);
    } else if (card.dataset.preview === 'recaman') {
      setupPreview(cv, recamanPath(70), 'sunset', (i, n) => Math.floor(i / n * K) % K);
    } else {
      setupPreview(cv, dragonPts, 'cyber', i => {
        const g = i === 0 ? 0 : Math.floor(Math.log2(i)) + 1;
        return Math.floor(((g * 0.13) % 1) * K) % K;
      });
    }
  }

  // ---------- 배경: 느리게 떠다니는 네온 점들 ----------
  const bg = document.getElementById('bgFx');
  const bctx = bg.getContext('2d');
  const { colors: bgColors } = NK.buildColors('neon', 7);
  let dots = [];
  function resizeBg() {
    bg.width = innerWidth * DPR; bg.height = innerHeight * DPR;
    const rng = NK.mulberry32(42);
    dots = Array.from({ length: 70 }, () => ({
      x: rng() * bg.width, y: rng() * bg.height,
      vx: (rng() - 0.5) * 0.25 * DPR, vy: (rng() - 0.5) * 0.25 * DPR,
      r: (0.8 + rng() * 1.8) * DPR, c: bgColors[Math.floor(rng() * K)],
    }));
  }
  resizeBg();
  window.addEventListener('resize', resizeBg);
  (function loop() {
    bctx.clearRect(0, 0, bg.width, bg.height);
    for (const d of dots) {
      d.x = (d.x + d.vx + bg.width) % bg.width;
      d.y = (d.y + d.vy + bg.height) % bg.height;
      bctx.fillStyle = d.c;
      bctx.shadowColor = d.c;
      bctx.shadowBlur = 12 * DPR;
      bctx.beginPath(); bctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); bctx.fill();
    }
    requestAnimationFrame(loop);
  })();
})();
