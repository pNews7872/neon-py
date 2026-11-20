/* =========================================================
   NeonGL — 모든 페이지가 같이 쓰는 GPU(WebGL2) 렌더러
   · 매 프레임 지금 카메라 그대로 전부 다시 그림 → 늘림·흐림·바꿔 끼우기 없음
   · 선분 레이어: 이어진 꺾은선. 6만5천 개씩 묶음(청크)으로 나누고, 묶음마다
     시작점 기준 상대 좌표로 저장 → 아주 멀리·깊이 확대해도 좌표가 흔들리지 않음
   · 반원 레이어: 셰이더가 원 위의 점을 직접 계산하고, 화면 픽셀마다 원까지의
     거리로 가장자리를 깎아서 아무리 확대해도 각이 지지 않는 매끈한 반원
   · 선은 가장자리를 셰이더에서 부드럽게(안티에일리어싱), 겹치면 밝은 쪽만(MAX)
   · 네온 번짐: 듀얼 카와세 블룸, 마지막에 색을 유지하는 톤매핑
   · 색 구역 배경: JS와 같은 노이즈를 셰이더로 옮겨 계산
   ========================================================= */
(function (global) {
  'use strict';

  const CHUNK = 65536;          // 선분 묶음 크기
  const ARC_CHUNK = 16384;
  const ARC_PIECES = 48;        // 반원 하나를 덮는 띠 조각 수 (실제 모양은 픽셀 단위로 계산)

  // 공통: 월드 → 화면 (묶음 원점 상대 좌표, 회전 복사본 변환 포함)
  const VS_COMMON = `
uniform vec2 uA;        // 묶음 원점 − 회전축
uniform vec2 uB;        // 회전축 − 카메라
uniform vec2 uRot;      // 복사본 회전 (cos, sin)
uniform vec2 uCam;      // 카메라 회전 (cos, sin) × 배율
uniform vec2 uCenter;   // 화면 중심 (px)
uniform vec2 uRes;
vec2 toScreen(vec2 rel) {
  vec2 p = rel + uA;
  p = vec2(p.x * uRot.x - p.y * uRot.y, p.x * uRot.y + p.y * uRot.x) + uB;
  p = vec2(p.x * uCam.x - p.y * uCam.y, p.x * uCam.y + p.y * uCam.x);
  return p + uCenter;
}
vec4 toClip(vec2 s) { vec2 c = s / uRes * 2.0 - 1.0; return vec4(c.x, -c.y, 0.0, 1.0); }
`;

  const VS_SEG = `#version 300 es
layout(location=0) in vec2 aCorner;          // 사각형 꼭짓점 (x: 0 시작 / 1 끝, y: −1/+1 옆)
layout(location=1) in vec4 aSeg;             // 선분 양 끝 (묶음 원점 기준)
layout(location=2) in uint aCol;             // 색 번호
${VS_COMMON}
uniform float uHalfW;
uniform float uK;
uniform float uTint;
flat out float vPhase;
out float vDist;
void main() {
  if (aCol == 255u) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vPhase = 0.0; vDist = 0.0; return; }   // 보이지 않는 이동
  vec2 A = toScreen(aSeg.xy), B = toScreen(aSeg.zw);
  vec2 d = B - A;
  float len = length(d);
  vec2 u = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-u.y, u.x);
  float ext = uHalfW + 1.0;
  vec2 P = (aCorner.x < 0.5 ? A - u * uHalfW : B + u * uHalfW) + n * (aCorner.y * ext);
  vDist = aCorner.y * ext;
  gl_Position = toClip(P);
  vPhase = uTint >= 0.0 ? uTint : (float(aCol) + 0.5) / uK;
}`;

  const FS_SEG = `#version 300 es
precision highp float;
flat in float vPhase;
in float vDist;
uniform sampler2D uPal;
uniform float uHalfW;
uniform float uHot;
uniform float uAlpha;
out vec4 o;
void main() {
  float d = abs(vDist);
  float a = clamp(uHalfW - d + 0.5, 0.0, 1.0);
  vec3 c = texture(uPal, vec2(vPhase, 0.5)).rgb;
  float hot = uHot * (1.0 - smoothstep(0.0, max(0.6, uHalfW * 0.55), d));
  c = mix(c, vec3(1.0), hot * 0.55);
  o = vec4(c * a * uAlpha, 1.0);
}`;

  // 반원: 인스턴스 = (시작 x, 끝 x, 위/아래, 그린 비율, 색)
  const VS_ARC = `#version 300 es
layout(location=0) in vec3 aPiece;           // x: 조각 번호, y: 0/1 조각 앞/뒤, z: −1/+1 안/밖
layout(location=1) in vec4 aArc;             // x0, x1 (묶음 원점 기준), side, tEnd
layout(location=2) in uint aCol;
${VS_COMMON}
uniform float uHalfW;
uniform float uK;
uniform float uPieces;
flat out float vPhase;
flat out vec3 vCircle;                       // 화면에서 원 중심 (x, y) 과 반지름
flat out vec4 vClip;                         // 반원 쪽(위/아래) 판별용: 축 위 점, 법선
void main() {
  float x0 = aArc.x, x1 = aArc.y, side = aArc.z, tEnd = aArc.w;
  float c = (x0 + x1) * 0.5, r = abs(x1 - x0) * 0.5, dir = sign(x1 - x0);
  float t = (aPiece.x + aPiece.y) / uPieces * tEnd;
  float ang = 3.14159265 * t;
  vec2 W = vec2(c - dir * r * cos(ang), side * r * sin(ang));
  vec2 C = toScreen(vec2(c, 0.0));
  vec2 P = toScreen(W);
  float rs = length(toScreen(vec2(c + r, 0.0)) - C);
  // 조각 띠가 원호를 덮도록: 선 굵기 + 현과 호의 차이(사지타)만큼 안/밖으로
  float sag = rs * (1.0 - cos(3.14159265 / uPieces * 0.5 * tEnd)) + 1.0;
  vec2 radial = rs > 1e-6 ? (P - C) / max(length(P - C), 1e-6) : vec2(0.0, 1.0);
  P += radial * aPiece.z * (uHalfW + sag + 1.0);
  gl_Position = toClip(P);
  vCircle = vec3(C, rs);
  vec2 axisDir = toScreen(vec2(c + 1.0, 0.0)) - C;
  vec2 nrm = normalize(vec2(-axisDir.y, axisDir.x)) * side;
  vClip = vec4(C, nrm);
  vPhase = (float(aCol) + 0.5) / uK;
}`;

  const FS_ARC = `#version 300 es
precision highp float;
flat in float vPhase;
flat in vec3 vCircle;
flat in vec4 vClip;
uniform sampler2D uPal;
uniform float uHalfW;
uniform float uHot;
uniform vec2 uRes;
uniform float uAlpha;
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float d = abs(length(p - vCircle.xy) - vCircle.z);
  // 반대쪽 반원은 그리지 않음 (축 근처는 선 굵기만큼 허용)
  float sideDist = dot(p - vClip.xy, vClip.zw);
  if (sideDist < -uHalfW - 1.0) discard;
  float a = clamp(uHalfW - d + 0.5, 0.0, 1.0);
  if (a <= 0.0) discard;
  vec3 c = texture(uPal, vec2(vPhase, 0.5)).rgb;
  float hot = uHot * (1.0 - smoothstep(0.0, max(0.6, uHalfW * 0.55), d));
  c = mix(c, vec3(1.0), hot * 0.55);
  o = vec4(c * a * uAlpha, 1.0);
}`;

  const VS_FULL = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // 색 구역 배경: neon.js 의 zoneFactory 와 같은 계산
  const FS_ZONE = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform sampler2D uPal;
uniform vec2 uCamPos;     // 카메라 월드 좌표
uniform float uScale;     // 기기 px / 월드
uniform vec2 uRes;
uniform int uSeed;
uniform float uZone;
out vec4 o;
float hash(int ix, int iy, int s) {
  uint h = uint(ix) * 374761393u + uint(iy) * 668265263u + uint(s) * 1442695041u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h ^= h >> 16u;
  return float(h) / 4294967296.0;
}
float vnoise(vec2 q, int s) {
  vec2 i = floor(q), f = q - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  int ix = int(i.x), iy = int(i.y);
  float a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return (a + (b - a) * u.x + (c - a + (a - b + d - c) * u.x) * u.y) * 2.0 - 1.0;
}
float fbm(vec2 q, int s) {
  float sum = 0.0, amp = 0.5, f = 1.0;
  for (int i = 0; i < 4; i++) { sum += amp * vnoise(q * f, s + i * 131); f *= 2.03; amp *= 0.5; }
  return sum;
}
void main() {
  vec2 px = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);
  vec2 w = (px - uRes * 0.5) / uScale + uCamPos;
  vec2 q = w / uZone;
  float wx = fbm(q + vec2(5.2, 1.3), uSeed + 1000);
  float wy = fbm(q + vec2(-3.1, 7.7), uSeed + 2000);
  q += vec2(wx, wy) * 1.4;
  float a = fbm(q, uSeed), b = fbm(q + vec2(11.7, -4.4), uSeed + 500);
  float t = atan(b, a) / 6.28318530718 + 0.5;
  o = vec4(texture(uPal, vec2(t, 0.5)).rgb, 1.0);
}`;

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
  const FS_FINAL = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uScene; uniform sampler2D uBloom; uniform sampler2D uZoneTex;
uniform float uBloomK; uniform float uExposure; uniform float uZoneA; out vec4 o;
void main() {
  vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uBloomK;
  float L = max(max(c.r, c.g), c.b);
  vec3 m = L > 1e-5 ? c * ((1.0 - exp(-L * uExposure)) / L) : vec3(0.0);
  // 색 구역 배경은 번짐·톤매핑과 따로, 아주 옅게 깔기
  m += texture(uZoneTex, vUv).rgb * uZoneA * (1.0 - min(1.0, L));
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

  function create(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) return null;
    const floatOk = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    const fmt = floatOk ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };

    const pSeg = program(gl, VS_SEG, FS_SEG);
    const pArc = program(gl, VS_ARC, FS_ARC);
    const pZone = program(gl, VS_FULL, FS_ZONE);
    const pDown = program(gl, VS_FULL, FS_DOWN);
    const pUp = program(gl, VS_FULL, FS_UP);
    const pFinal = program(gl, VS_FULL, FS_FINAL);
    const emptyVao = gl.createVertexArray();

    // 사각형 꼭짓점 6개 (선분용)
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]), gl.STATIC_DRAW);
    // 반원 띠 조각 꼭짓점
    const arcTpl = [];
    for (let k = 0; k < ARC_PIECES; k++) {
      for (const [e, s] of [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]]) arcTpl.push(k, e, s);
    }
    const arcTplBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, arcTplBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arcTpl), gl.STATIC_DRAW);

    // 팔레트
    const palTex = gl.createTexture();
    let K = 96;
    function setPalette(rgb) {
      K = rgb.length;
      const px = new Uint8Array(K * 4);
      rgb.forEach((c, i) => px.set([c[0], c[1], c[2], 255], i * 4));
      gl.bindTexture(gl.TEXTURE_2D, palTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, K, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // ---------- 선분 레이어 ----------
    function createSegLayer() {
      const chunks = [];       // { buf, colBuf, vao, n, ox, oy, data: Float32Array, cols: Uint8Array }
      let total = 0;
      function newChunk(ox, oy) {
        const c = { buf: gl.createBuffer(), colBuf: gl.createBuffer(), vao: gl.createVertexArray(), n: 0, ox, oy,
          data: new Float32Array(CHUNK * 4), cols: new Uint8Array(CHUNK), dirtyFrom: 0, colDirty: false };
        gl.bindVertexArray(c.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.buf);
        gl.bufferData(gl.ARRAY_BUFFER, c.data.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.colBuf);
        gl.bufferData(gl.ARRAY_BUFFER, c.cols.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, 0, 0); gl.vertexAttribDivisor(2, 1);
        gl.bindVertexArray(null);
        chunks.push(c);
        return c;
      }
      return {
        type: 'seg',
        get count() { return total; },
        chunks,
        reset() {
          for (const c of chunks) { gl.deleteBuffer(c.buf); gl.deleteBuffer(c.colBuf); gl.deleteVertexArray(c.vao); }
          chunks.length = 0; total = 0;
        },
        // 꺾은선 저장소(pts: 꼭짓점 x,y 연속, cols: 선 색)의 [from, to) 선을 덧붙임
        appendFrom(pts, cols, from, to) {
          for (let i = from; i < to; i++) {
            let c = chunks[chunks.length - 1];
            if (!c || c.n >= CHUNK) c = newChunk(pts[i * 2], pts[i * 2 + 1]);
            const o = c.n * 4;
            c.data[o] = pts[i * 2] - c.ox; c.data[o + 1] = pts[i * 2 + 1] - c.oy;
            c.data[o + 2] = pts[i * 2 + 2] - c.ox; c.data[o + 3] = pts[i * 2 + 3] - c.oy;
            c.cols[c.n] = cols[i];
            c.n++; total++;
          }
        },
        // 서로 떨어진 선분 목록 [x0,y0,x1,y1,...] 덧붙이기 (자라는 가지처럼 매 프레임 바뀌는 것용)
        appendSegs(arr, cols, count) {
          for (let i = 0; i < count; i++) {
            let c = chunks[chunks.length - 1];
            if (!c || c.n >= CHUNK) c = newChunk(arr[i * 4], arr[i * 4 + 1]);
            if (c.n === 0) { c.ox = arr[i * 4]; c.oy = arr[i * 4 + 1]; }
            const o = c.n * 4;
            c.data[o] = arr[i * 4] - c.ox; c.data[o + 1] = arr[i * 4 + 1] - c.oy;
            c.data[o + 2] = arr[i * 4 + 2] - c.ox; c.data[o + 3] = arr[i * 4 + 3] - c.oy;
            c.cols[c.n] = cols[i];
            c.n++; total++;
          }
        },
        // 매 프레임 통째로 바꾸는 선분 목록 (화면 좌표처럼 작은 값일 때). 묶음은 재사용하고 덩어리째 복사
        setSegs(arr, cols, count) {
          let used = 0;
          for (let off = 0; off < count; off += CHUNK) {
            const c = chunks[used] || newChunk(0, 0);
            const n = Math.min(CHUNK, count - off);
            c.ox = 0; c.oy = 0;
            c.data.set(arr.subarray(off * 4, (off + n) * 4));
            c.cols.set(cols.subarray(off, off + n));
            c.n = n; c.dirtyFrom = 0; c.colDirty = false;
            used++;
          }
          for (let i = used; i < chunks.length; i++) { chunks[i].n = 0; chunks[i].dirtyFrom = 0; }
          total = count;
        },
        // 버퍼는 남겨두고 내용만 비움 (매 프레임 다시 채우는 레이어용)
        clear() {
          while (chunks.length > 1) { const c = chunks.pop(); gl.deleteBuffer(c.buf); gl.deleteBuffer(c.colBuf); gl.deleteVertexArray(c.vao); }
          if (chunks[0]) { chunks[0].n = 0; chunks[0].dirtyFrom = 0; chunks[0].colDirty = false; }
          total = 0;
        },
        // 색만 다시 (위치는 그대로)
        recolorFrom(cols) {
          let i = 0;
          for (const c of chunks) { for (let k = 0; k < c.n; k++) c.cols[k] = cols[i++]; c.colDirty = true; }
        },
        flush() {
          for (const c of chunks) {
            if (c.dirtyFrom < c.n) {
              gl.bindBuffer(gl.ARRAY_BUFFER, c.buf);
              gl.bufferSubData(gl.ARRAY_BUFFER, c.dirtyFrom * 16, c.data, c.dirtyFrom * 4, (c.n - c.dirtyFrom) * 4);
              gl.bindBuffer(gl.ARRAY_BUFFER, c.colBuf);
              if (!c.colDirty) gl.bufferSubData(gl.ARRAY_BUFFER, c.dirtyFrom, c.cols, c.dirtyFrom, c.n - c.dirtyFrom);
              c.dirtyFrom = c.n;
            }
            if (c.colDirty) {
              gl.bindBuffer(gl.ARRAY_BUFFER, c.colBuf);
              gl.bufferSubData(gl.ARRAY_BUFFER, 0, c.cols, 0, c.n);
              c.colDirty = false;
            }
          }
        },
      };
    }

    // ---------- 반원 레이어 ----------
    function createArcLayer() {
      const chunks = [];
      let total = 0;
      function newChunk(ox) {
        const c = { buf: gl.createBuffer(), colBuf: gl.createBuffer(), vao: gl.createVertexArray(), n: 0, ox, oy: 0,
          data: new Float32Array(ARC_CHUNK * 4), cols: new Uint8Array(ARC_CHUNK), dirtyFrom: 0, colDirty: false };
        gl.bindVertexArray(c.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, arcTplBuf);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.buf);
        gl.bufferData(gl.ARRAY_BUFFER, c.data.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.colBuf);
        gl.bufferData(gl.ARRAY_BUFFER, c.cols.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, 0, 0); gl.vertexAttribDivisor(2, 1);
        gl.bindVertexArray(null);
        chunks.push(c);
        return c;
      }
      return {
        type: 'arc',
        get count() { return total; },
        chunks,
        reset() {
          for (const c of chunks) { gl.deleteBuffer(c.buf); gl.deleteBuffer(c.colBuf); gl.deleteVertexArray(c.vao); }
          chunks.length = 0; total = 0;
        },
        // 반원 하나 추가 (x0 → x1, side: −1 위 / +1 아래, tEnd: 그린 비율)
        push(x0, x1, side, tEnd, col) {
          let c = chunks[chunks.length - 1];
          if (!c || c.n >= ARC_CHUNK) c = newChunk(x0);
          const o = c.n * 4;
          c.data[o] = x0 - c.ox; c.data[o + 1] = x1 - c.ox; c.data[o + 2] = side; c.data[o + 3] = tEnd;
          c.cols[c.n] = col;
          c.n++; total++;
        },
        // 마지막 반원의 그린 비율만 바꿈 (펜 애니메이션)
        setLastT(tEnd) {
          const c = chunks[chunks.length - 1];
          if (!c || !c.n) return;
          c.data[(c.n - 1) * 4 + 3] = tEnd;
          c.dirtyFrom = Math.min(c.dirtyFrom, c.n - 1);
        },
        setColor(i, col) {
          const c = chunks[Math.floor(i / ARC_CHUNK)];
          if (!c) return;
          c.cols[i % ARC_CHUNK] = col; c.colDirty = true;
        },
        flush() {
          for (const c of chunks) {
            if (c.dirtyFrom < c.n) {
              gl.bindBuffer(gl.ARRAY_BUFFER, c.buf);
              gl.bufferSubData(gl.ARRAY_BUFFER, c.dirtyFrom * 16, c.data, c.dirtyFrom * 4, (c.n - c.dirtyFrom) * 4);
              gl.bindBuffer(gl.ARRAY_BUFFER, c.colBuf);
              gl.bufferSubData(gl.ARRAY_BUFFER, c.dirtyFrom, c.cols, c.dirtyFrom, c.n - c.dirtyFrom);
              c.dirtyFrom = c.n;
            }
            if (c.colDirty) {
              gl.bindBuffer(gl.ARRAY_BUFFER, c.colBuf);
              gl.bufferSubData(gl.ARRAY_BUFFER, 0, c.cols, 0, c.n);
              c.colDirty = false;
            }
          }
        },
      };
    }

    // ---------- 화면 버퍼 ----------
    let W = 0, H = 0, sceneFbo = null, sceneTex = null, mips = [], zoneT = null;
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
    function resize(w, h) {
      if (w === W && h === H) return;
      W = w; H = h;
      canvas.width = w; canvas.height = h;
      if (sceneFbo) { gl.deleteFramebuffer(sceneFbo); gl.deleteTexture(sceneTex); }
      for (const m of mips) { gl.deleteFramebuffer(m.fbo); gl.deleteTexture(m.tex); }
      const sc = makeTex(w, h); sceneFbo = sc.fbo; sceneTex = sc.tex;
      if (zoneT) { gl.deleteFramebuffer(zoneT.fbo); gl.deleteTexture(zoneT.tex); }
      zoneT = makeTex(Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4)));   // 색 구역은 1/4 해상도
      mips = [];
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
     * 한 프레임
     * view: { x, y (카메라 월드 좌표), s (기기 px / 월드), rot }
     * draws: [{ layer, pivot?:[x,y], angle?, tint? (0~1, 없으면 −1), alpha? }]
     * style: { halfW, hot, bloom, exposure }
     * zone: 없으면 배경 없음, 있으면 { seed, scale, alpha }
     */
    function frame(view, draws, style, zone) {
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, palTex);

      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      const camC = Math.cos(view.rot || 0) * view.s, camS = Math.sin(view.rot || 0) * view.s;
      for (const d of draws) {
        const L = d.layer;
        if (!L || !L.count) continue;
        L.flush();
        const prog = L.type === 'arc' ? pArc : pSeg;
        gl.useProgram(prog.p);
        gl.uniform1i(prog.u.uPal, 0);
        gl.uniform1f(prog.u.uK, K);
        gl.uniform1f(prog.u.uHalfW, style.halfW);
        gl.uniform1f(prog.u.uHot, style.hot);
        gl.uniform1f(prog.u.uAlpha, d.alpha == null ? 1 : d.alpha);
        gl.uniform2f(prog.u.uRes, W, H);
        gl.uniform2f(prog.u.uCenter, W / 2, H / 2);
        gl.uniform2f(prog.u.uCam, camC, camS);
        const ang = d.angle || 0;
        gl.uniform2f(prog.u.uRot, Math.cos(ang), Math.sin(ang));
        if (prog.u.uTint) gl.uniform1f(prog.u.uTint, d.tint == null ? -1 : d.tint);
        if (prog.u.uPieces) gl.uniform1f(prog.u.uPieces, ARC_PIECES);
        const px = d.pivot ? d.pivot[0] : view.x, py = d.pivot ? d.pivot[1] : view.y;
        gl.uniform2f(prog.u.uB, px - view.x, py - view.y);
        for (const c of L.chunks) {
          if (!c.n) continue;
          // 묶음 원점 − 회전축 을 배정밀도로 계산한 뒤 넘김 (정밀도 유지)
          gl.uniform2f(prog.u.uA, c.ox - px, c.oy - py);
          gl.bindVertexArray(c.vao);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, L.type === 'arc' ? ARC_PIECES * 6 : 6, c.n);
        }
      }
      gl.bindVertexArray(emptyVao);
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.BLEND);

      // 색 구역 배경 (1/4 해상도)
      if (zone) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, zoneT.fbo);
        gl.viewport(0, 0, zoneT.w, zoneT.h);
        gl.useProgram(pZone.p);
        gl.bindVertexArray(emptyVao);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, palTex);
        gl.uniform1i(pZone.u.uPal, 0);
        gl.uniform2f(pZone.u.uCamPos, view.x, view.y);
        gl.uniform1f(pZone.u.uScale, view.s * zoneT.w / W);
        gl.uniform2f(pZone.u.uRes, zoneT.w, zoneT.h);
        gl.uniform1i(pZone.u.uSeed, zone.seed | 0);
        gl.uniform1f(pZone.u.uZone, zone.scale);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // 블룸
      if (mips.length && style.bloom > 0) {
        fullPass(pDown, sceneTex, W, H, mips[0]);
        for (let i = 1; i < mips.length; i++) fullPass(pDown, mips[i - 1].tex, mips[i - 1].w, mips[i - 1].h, mips[i]);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        for (let i = mips.length - 1; i > 0; i--) fullPass(pUp, mips[i].tex, mips[i].w, mips[i].h, mips[i - 1]);
        gl.disable(gl.BLEND);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(pFinal.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTex); gl.uniform1i(pFinal.u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mips.length ? mips[0].tex : sceneTex); gl.uniform1i(pFinal.u.uBloom, 1);
      gl.uniform1f(pFinal.u.uBloomK, mips.length ? style.bloom : 0);
      gl.uniform1f(pFinal.u.uExposure, style.exposure);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, zoneT.tex); gl.uniform1i(pFinal.u.uZoneTex, 2);
      gl.uniform1f(pFinal.u.uZoneA, zone ? zone.alpha : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    }

    return { gl, setPalette, createSegLayer, createArcLayer, resize, frame, isLost: () => gl.isContextLost() };
  }

  global.NeonGL = { create };
})(window);
