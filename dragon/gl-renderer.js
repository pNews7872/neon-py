/* =========================================================
   DragonGL — 무한 드래곤 커브를 GPU(WebGL2)로 매 프레임 그리는 렌더러

   · 템플릿 곡선 + 인스턴싱: "선분 하나 → 드래곤 조각(2^K 개 선)" 을 미리 만들어 두고,
     CPU가 고른 화면 속 큰 선분(인스턴스)마다 GPU가 도장처럼 찍는다.
   · 지오모핑: 템플릿의 마지막 접힘을 0~100% 로 연속 조절 → 세대 경계가 보이지 않음.
     (선분이 √2 배 커질 때 마지막 접힘 0→100%, 그 순간 인스턴스가 둘로 나뉘며 접힘은 다시 0%:
      두 상태가 정확히 같은 그림이라 이음매가 없다)
   · 굵기 있는 선(셰이더 안티에일리어싱, 겹침은 MAX 혼합) → 듀얼 카와세 블룸(네온 번짐) → 색 보존 톤매핑
   ========================================================= */
(function (global) {
  'use strict';

  // 선 하나 = 사각형 2개(삼각형). 가장자리를 셰이더에서 부드럽게 깎아 굵기를 자유롭게.
  const VS_LINE = `#version 300 es
layout(location=0) in vec4 aE1;      // 템플릿 선분 양 끝 (완전히 접힌 위치) a.xy b.zw
layout(location=1) in vec4 aE0;      // 템플릿 선분 양 끝 (마지막 단계를 펴 둔 위치)
layout(location=2) in vec2 aSeg;     // x: 첫 오른쪽 접힘까지 단계 수, y: 오른쪽 접힘 횟수
layout(location=3) in vec2 aCorner;  // x: 0=시작 끝 1=끝 쪽, y: −1/+1 옆
layout(location=5) in vec4 aInst;    // 인스턴스 선분 A(x,y) B(x,y) (화면 px)
layout(location=6) in vec3 aInstC;   // x: 세대 색 위상(정해졌으면, 아니면 −1), y: 레벨 위상, z: 접힘 수 위상
uniform float uT;
uniform vec2 uRes;
uniform int uMode;
uniform float uGenStep;
uniform float uDepthStep;
uniform float uHalfW;
flat out float vPhase;
out float vDist;
vec2 place(vec2 q) {
  vec2 a = aInst.xy, d = aInst.zw - aInst.xy;
  return a + q.x * d + q.y * vec2(-d.y, d.x);
}
void main() {
  vec2 A = place(mix(aE0.xy, aE1.xy, uT));
  vec2 B = place(mix(aE0.zw, aE1.zw, uT));
  vec2 dir = B - A;
  float len = length(dir);
  vec2 u = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 n = vec2(-u.y, u.x);
  float ext = uHalfW + 1.0;                       // 가장자리 부드럽게 할 여유 1px
  vec2 P = (aCorner.x < 0.5 ? A - u * uHalfW : B + u * uHalfW) + n * (aCorner.y * ext);
  vDist = aCorner.y * ext;
  vec2 c = P / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  float ph;
  if (uMode == 0) ph = aInstC.x >= 0.0 ? aInstC.x : fract(aInstC.y - aSeg.x * uGenStep);
  else ph = fract(aInstC.z + aSeg.y * uDepthStep);
  vPhase = ph;
}`;

  const FS_LINE = `#version 300 es
precision highp float;
flat in float vPhase;
in float vDist;
uniform sampler2D uPal;
uniform float uIntensity;
uniform float uHalfW;
uniform float uHot;
out vec4 o;
void main() {
  float d = abs(vDist);
  float a = clamp(uHalfW - d + 0.5, 0.0, 1.0);        // 가장자리 안티에일리어싱
  vec3 c = texture(uPal, vec2(vPhase, 0.5)).rgb;
  float hot = uHot * (1.0 - smoothstep(0.0, max(0.6, uHalfW * 0.55), d));
  c = mix(c, vec3(1.0), hot * 0.55);                 // 네온관 가운데 흰빛
  o = vec4(c * uIntensity * a, 1.0);
}`;

  const VS_FULL = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // 듀얼 카와세 블룸: 내려가며 흐리게
  const FS_DOWN = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uTex; uniform vec2 uHalf; out vec4 o;
void main() {
  vec4 s = texture(uTex, vUv) * 4.0;
  s += texture(uTex, vUv - uHalf);
  s += texture(uTex, vUv + uHalf);
  s += texture(uTex, vUv + vec2(uHalf.x, -uHalf.y));
  s += texture(uTex, vUv - vec2(uHalf.x, -uHalf.y));
  o = s / 8.0;
}`;
  // 올라오며 넓게 퍼뜨림
  const FS_UP = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uTex; uniform vec2 uHalf; out vec4 o;
void main() {
  vec2 h = uHalf;
  vec4 s = texture(uTex, vUv + vec2(-2.0 * h.x, 0.0));
  s += texture(uTex, vUv + vec2(-h.x, h.y)) * 2.0;
  s += texture(uTex, vUv + vec2(0.0, 2.0 * h.y));
  s += texture(uTex, vUv + vec2(h.x, h.y)) * 2.0;
  s += texture(uTex, vUv + vec2(2.0 * h.x, 0.0));
  s += texture(uTex, vUv + vec2(h.x, -h.y)) * 2.0;
  s += texture(uTex, vUv + vec2(0.0, -2.0 * h.y));
  s += texture(uTex, vUv + vec2(-h.x, -h.y)) * 2.0;
  o = s / 12.0;
}`;
  // 최종: 장면 + 번짐, 색을 유지하는 톤매핑
  const FS_FINAL = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uScene; uniform sampler2D uBloom;
uniform float uBloomK; uniform float uExposure; out vec4 o;
void main() {
  vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uBloomK;
  float L = max(max(c.r, c.g), c.b);
  vec3 m = L > 1e-5 ? c * ((1.0 - exp(-L * uExposure)) / L) : vec3(0.0);
  o = vec4(m, 1.0);
}`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  // 템플릿: 선분 (0,0)→(1,0), 부호 sig, 자식 부호 (gs, −gs), 깊이 K → 선 2^K개를 사각형으로
  function buildTemplate(K, sig, gs) {
    const N = 1 << K;
    const P1 = new Float64Array((N + 1) * 2);
    let idx = 1;
    (function d(ax, ay, bx, by, s, lv) {
      if (lv === 0) { P1[idx * 2] = bx; P1[idx * 2 + 1] = by; idx++; return; }
      const dx = bx - ax, dy = by - ay;
      const qx = (ax + bx) / 2 - s * dy / 2, qy = (ay + by) / 2 + s * dx / 2;
      d(ax, ay, qx, qy, gs, lv - 1);
      d(qx, qy, bx, by, -gs, lv - 1);
    })(0, 0, 1, 0, sig, K);
    const P0 = new Float64Array(P1);
    for (let j = 1; j < N; j += 2) {
      P0[j * 2] = (P1[j * 2 - 2] + P1[j * 2 + 2]) / 2;
      P0[j * 2 + 1] = (P1[j * 2 - 1] + P1[j * 2 + 3]) / 2;
    }
    const CORNERS = [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]];
    const F = 12;                                 // 꼭짓점 하나에 float 12개
    const data = new Float32Array(N * 6 * F);
    let o = 0;
    for (let s = 0; s < N; s++) {
      const offset = s === 0 ? K : K - 1 - Math.floor(Math.log2(s));
      let cnt = 0; for (let v = s; v; v &= v - 1) cnt++;
      for (const [ex, side] of CORNERS) {
        data[o++] = P1[s * 2]; data[o++] = P1[s * 2 + 1]; data[o++] = P1[s * 2 + 2]; data[o++] = P1[s * 2 + 3];
        data[o++] = P0[s * 2]; data[o++] = P0[s * 2 + 1]; data[o++] = P0[s * 2 + 2]; data[o++] = P0[s * 2 + 3];
        data[o++] = offset; data[o++] = cnt;
        data[o++] = ex; data[o++] = side;
      }
    }
    return { data, verts: N * 6, N };
  }

  function create(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) return null;
    const floatOk = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    const fmt = floatOk ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;

    const pLine = program(gl, VS_LINE, FS_LINE);
    const pDown = program(gl, VS_FULL, FS_DOWN);
    const pUp = program(gl, VS_FULL, FS_UP);
    const pFinal = program(gl, VS_FULL, FS_FINAL);
    const emptyVao = gl.createVertexArray();

    // 팔레트 텍스처 (1차원)
    const palTex = gl.createTexture();
    function setPalette(rgb) {
      const K = rgb.length;
      const px = new Uint8Array(K * 4);
      rgb.forEach((c, i) => px.set([c[0], c[1], c[2], 255], i * 4));
      gl.bindTexture(gl.TEXTURE_2D, palTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, K, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // 템플릿 2종 (부호 +1 / −1) + 인스턴스 버퍼
    const groups = [+1, -1].map(() => ({ vao: gl.createVertexArray(), tpl: gl.createBuffer(), inst: gl.createBuffer(), verts: 0, count: 0 }));
    let tplK = 0, tplGs = 0;
    function setTemplate(K, gs) {
      if (K === tplK && gs === tplGs) return;
      tplK = K; tplGs = gs;
      [+1, -1].forEach((sg, gi) => {
        const t = buildTemplate(K, sg, gs);
        const g = groups[gi];
        g.verts = t.verts;
        gl.bindVertexArray(g.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.tpl);
        gl.bufferData(gl.ARRAY_BUFFER, t.data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 48, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 48, 16);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 48, 32);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 48, 40);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.inst);
        gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 28, 0); gl.vertexAttribDivisor(5, 1);
        gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 3, gl.FLOAT, false, 28, 16); gl.vertexAttribDivisor(6, 1);
        gl.bindVertexArray(null);
      });
    }

    // 화면 버퍼들
    let W = 0, H = 0, samples = 0;
    let msaaFbo = null, msaaRb = null, sceneFbo = null, sceneTex = null;
    let mips = [];   // { fbo, tex, w, h }
    function makeTex(w, h) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, gl.RGBA, fmt.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { fbo: f, tex: t, w, h };
    }
    function freeTargets() {
      if (msaaFbo) { gl.deleteFramebuffer(msaaFbo); gl.deleteRenderbuffer(msaaRb); }
      if (sceneFbo) { gl.deleteFramebuffer(sceneFbo); gl.deleteTexture(sceneTex); }
      for (const m of mips) { gl.deleteFramebuffer(m.fbo); gl.deleteTexture(m.tex); }
      msaaFbo = msaaRb = sceneFbo = sceneTex = null; mips = [];
    }
    function resize(w, h) {
      if (w === W && h === H) return;
      W = w; H = h;
      canvas.width = w; canvas.height = h;
      freeTargets();
      const sc = makeTex(w, h); sceneFbo = sc.fbo; sceneTex = sc.tex;
      samples = 0;   // 선 가장자리를 셰이더에서 부드럽게 하므로 MSAA 불필요 (메모리 절약)
      if (samples > 1) {
        msaaRb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, msaaRb);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt.internal, w, h);
        msaaFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msaaRb);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          gl.deleteFramebuffer(msaaFbo); gl.deleteRenderbuffer(msaaRb); msaaFbo = msaaRb = null; samples = 0;
        }
      }
      let mw = w, mh = h;
      for (let i = 0; i < 6; i++) {
        mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
        if (mw < 4 || mh < 4) break;
        mips.push(makeTex(mw, mh));
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    function fullPass(prog, srcTex, srcW, srcH, dst) {
      gl.useProgram(prog.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(prog.u.uTex, 0);
      gl.uniform2f(prog.u.uHalf, 0.5 / srcW, 0.5 / srcH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /**
     * 한 프레임 그리기
     * inst: [Float32Array(부호 +1 그룹), Float32Array(부호 −1 그룹)] 각 7개씩 (ax,ay,bx,by, 세대위상, 레벨위상, 접힘위상)
     * opts: { t, mode(0 세대/1 접힘), genStep, depthStep, intensity, bloom, exposure }
     */
    function render(inst, counts, opts) {
      gl.bindVertexArray(null);
      // 1) 선 그리기 (가산 혼합, MSAA)
      const target = msaaFbo || sceneFbo;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // 겹치는 곳은 더 밝은 쪽만 남김(MAX): 선 이음매·교차점에 밝은 점이 생기지 않게
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.useProgram(pLine.p);
      gl.uniform1f(pLine.u.uHalfW, opts.halfW);
      gl.uniform1f(pLine.u.uHot, opts.hot);
      gl.uniform1f(pLine.u.uT, opts.t);
      gl.uniform2f(pLine.u.uRes, W, H);
      gl.uniform1i(pLine.u.uMode, opts.mode);
      gl.uniform1f(pLine.u.uGenStep, opts.genStep);
      gl.uniform1f(pLine.u.uDepthStep, opts.depthStep);
      gl.uniform1f(pLine.u.uIntensity, opts.intensity);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, palTex);
      gl.uniform1i(pLine.u.uPal, 0);
      for (let gi = 0; gi < 2; gi++) {
        const g = groups[gi];
        if (!counts[gi]) continue;
        gl.bindVertexArray(g.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.inst);
        gl.bufferData(gl.ARRAY_BUFFER, inst[gi].subarray(0, counts[gi] * 7), gl.STREAM_DRAW);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, g.verts, counts[gi]);
      }
      gl.bindVertexArray(emptyVao);
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.BLEND);
      if (msaaFbo) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaaFbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sceneFbo);
        gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      // 2) 블룸: 내려가기 → 올라오며 더하기
      if (mips.length) {
        fullPass(pDown, sceneTex, W, H, mips[0]);
        for (let i = 1; i < mips.length; i++) fullPass(pDown, mips[i - 1].tex, mips[i - 1].w, mips[i - 1].h, mips[i]);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        for (let i = mips.length - 1; i > 0; i--) fullPass(pUp, mips[i].tex, mips[i].w, mips[i].h, mips[i - 1]);
        gl.disable(gl.BLEND);
      }
      // 3) 최종 합성 + 톤매핑
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(pFinal.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTex); gl.uniform1i(pFinal.u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mips.length ? mips[0].tex : sceneTex); gl.uniform1i(pFinal.u.uBloom, 1);
      gl.uniform1f(pFinal.u.uBloomK, mips.length ? opts.bloom : 0);
      gl.uniform1f(pFinal.u.uExposure, opts.exposure);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    }

    return {
      gl, floatOk, get samples() { return samples; },
      setPalette, setTemplate, resize, render,
      isLost: () => gl.isContextLost(),
    };
  }

  global.DragonGL = { create };
})(window);
