/* FIBONACCI WORD ∞ — 피보나치 단어 프랙탈을 무한히 확대 (엔진: ../assets/ifszoom.js) */
(() => {
  'use strict';
  const NK = window.NeonKit;
  const MAXA = 101;
  const angIn = document.getElementById('ang');
  const angLabel = document.getElementById('angLabel');
  const presets = [...document.querySelectorAll('#angPresets button')];

  const z = NK.IfsZoom({
    kind: 'fib',
    defaultAngle: 90,
    nearestValid: a => Math.max(1, Math.min(MAXA, a)),
    syncAngle: a => {
      angIn.value = a; angLabel.textContent = a + '°';
      presets.forEach(b => b.classList.toggle('on', +b.dataset.a === a));
    },
  });
  if (!z) return;
  let t = 0;
  angIn.addEventListener('input', () => {
    angLabel.textContent = angIn.value + '°';
    clearTimeout(t);
    t = setTimeout(() => z.setAngle(parseInt(angIn.value, 10)), 40);
  });
  presets.forEach(b => b.addEventListener('click', () => z.setAngle(+b.dataset.a)));
})();
