/* THUE–MORSE ∞ — 투에-모스 거북이를 무한히 확대 (엔진: ../assets/ifszoom.js) */
(() => {
  'use strict';
  const NK = window.NeonKit;
  // 무한 확대가 되는 각도 (자기닮음 계산으로 찾은 것)
  const VALID = [];
  for (let a = 1; a < 180; a++) { const r = NK.ifsAnalyze('tm', a); if (r && !r.bad) VALID.push(a); }
  const presets = [...document.querySelectorAll('#angPresets button')];
  const angIn = document.getElementById('angIn');

  const z = NK.IfsZoom({
    kind: 'tm',
    defaultAngle: 60,
    nearestValid: a => VALID.reduce((b, v) => (Math.abs(v - a) < Math.abs(b - a) ? v : b), 60),
    syncAngle: a => {
      presets.forEach(b => b.classList.toggle('on', +b.dataset.a === a));
      angIn.value = a;
    },
  });
  if (!z) return;
  presets.forEach(b => b.addEventListener('click', () => z.setAngle(+b.dataset.a)));
  const go = () => { const a = parseInt(angIn.value, 10); if (Number.isFinite(a) && !z.setAngle(a)) angIn.value = z.angle; };
  document.getElementById('angGo').addEventListener('click', go);
  angIn.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  angIn.title = '무한 확대가 되는 각도: ' + VALID.join(', ');
})();
