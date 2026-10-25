// The Island orb: a small WebGL sphere with slowly flowing light inside (the "living orb").
// One shader drives every orb in the app; state sets how lively it is.
//   idle      calm and slow, then rests after a few seconds (nothing moves for long on its own)
//   thinking  a little brighter
//   working   livelier (using your PC)
//   listening ripples with the voice level
//   done      still
// With Windows animations off (prefers-reduced-motion) every orb stays still.
(() => {
  const FRAG = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_level;
uniform vec3 u_deep, u_mid, u_light, u_glow;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
void main() {
  float s = 0.5 * min(u_resolution.x, u_resolution.y);
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / s;
  float t = u_time;
  float lvl = clamp(u_level, 0.0, 1.0);
  float a = atan(uv.y, uv.x);
  float breathe = 0.018 * sin(t * 1.4);
  float ripple = (0.002 + 0.045 * lvl * lvl) * (0.6 * sin(3.0 * a + t * 1.3) + 0.4 * sin(5.0 * a - t * 1.9));
  float r = 0.70 + breathe + ripple;
  float d = length(uv);
  float aa = 1.5 / s;
  float inside = 1.0 - smoothstep(r - aa, r + aa, d);
  vec2 p = uv * 1.35;
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.10)), fbm(p + vec2(3.1, 7.4) - t * 0.09));
  float n = fbm(p * 1.3 + 2.4 * q + vec2(t * 0.06, -t * 0.04));
  vec3 col = mix(u_deep, u_mid, smoothstep(0.30, 0.62, n));
  col = mix(col, u_light, pow(smoothstep(0.52, 0.80, n), 1.3) * (0.55 + 0.35 * lvl));
  vec2 cpos = vec2(0.14 * sin(t * 0.5), 0.10 * cos(t * 0.37));
  float core = exp(-dot(uv - cpos, uv - cpos) * 2.4);
  col = mix(col, u_light, core * (0.12 + 0.28 * lvl));
  float rr = clamp(d / r, 0.0, 1.0);
  float z = sqrt(max(0.0, 1.0 - rr * rr));
  vec3 nrm = normalize(vec3(uv / r, z + 0.0001));
  vec3 lig = normalize(vec3(-0.45, 0.55, 0.7));
  col *= 0.78 + 0.32 * clamp(dot(nrm, lig), 0.0, 1.0);
  float spec = pow(clamp(dot(reflect(-lig, nrm), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 28.0);
  col += vec3(1.0) * spec * 0.45;
  float rim = smoothstep(r - 0.09, r - aa, d) * inside;
  col = mix(col, u_light, rim * 0.15);
  col = mix(col, u_glow, pow(1.0 - z, 3.0) * 0.3);
  float outD = max(d - r, 0.0);
  float glow = exp(-outD * 7.0) * (0.22 + 0.25 * lvl) * (1.0 - inside) * (1.0 - smoothstep(0.78, 0.98, d));
  gl_FragColor = vec4(col * inside + u_glow * glow, clamp(inside + glow, 0.0, 1.0));
}`;
  const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';

  // How lively each state is: [level, speed].
  const STATES = {
    idle: [0.15, 0.5],
    thinking: [0.4, 1.0],
    working: [0.65, 1.3],
    listening: [0.9, 1.2],
    approval: [0.3, 0.6],
    done: [0.2, 0],
  };
  const IDLE_REST_MS = 4000; // idle orbs settle to still after this

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const orbs = new Set();
  let raf = 0;
  let last = 0;

  const hex = (v) => {
    const m = /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(v || '');
    return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [0.2, 0.7, 0.6];
  };
  let colours = null;
  function readColours() {
    const cs = getComputedStyle(document.documentElement);
    colours = ['--orb-deep', '--orb-mid', '--orb-light', '--orb-glow'].map((k) => hex(cs.getPropertyValue(k).trim()));
    for (const o of orbs) o.dirty = true;
    kick();
  }
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', readColours);
  reduced.addEventListener('change', () => { for (const o of orbs) o.dirty = true; kick(); });

  function build(canvas) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const u = (n) => gl.getUniformLocation(prog, n);
    return { gl, res: u('u_resolution'), time: u('u_time'), level: u('u_level'), cols: ['u_deep', 'u_mid', 'u_light', 'u_glow'].map(u) };
  }

  function draw(o) {
    const c = o.canvas;
    const px = Math.round(o.size * (window.devicePixelRatio || 1));
    if (c.width !== px) (c.width = px), (c.height = px);
    const { gl } = o.ctx;
    gl.viewport(0, 0, px, px);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(o.ctx.res, px, px);
    gl.uniform1f(o.ctx.time, o.t);
    gl.uniform1f(o.ctx.level, o.level + o.voice * 0.5);
    o.ctx.cols.forEach((loc, i) => gl.uniform3fv(loc, colours[i]));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    o.dirty = false;
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    let moving = false;
    for (const o of orbs) {
      if (!o.canvas.isConnected) { orbs.delete(o); continue; }
      const visible = o.canvas.offsetParent !== null && !document.hidden;
      let [tLevel, tSpeed] = STATES[o.state] || STATES.idle;
      if (o.state === 'idle' && now - o.since > IDLE_REST_MS) tSpeed = 0;
      if (reduced.matches) tSpeed = 0;
      // Ease towards the target so state changes blend instead of jumping.
      const k = 1 - Math.exp(-dt * 4);
      o.level += (tLevel - o.level) * k;
      o.speed += (tSpeed - o.speed) * k;
      if (Math.abs(o.speed) < 0.004 && tSpeed === 0) o.speed = 0;
      o.t += dt * o.speed;
      const settling = Math.abs(tLevel - o.level) > 0.002 || o.speed > 0 || o.voice > 0.01;
      if (visible && (settling || o.dirty)) draw(o);
      if (visible && settling) moving = true;
    }
    if (moving) raf = requestAnimationFrame(frame);
    else last = 0;
  }

  function kick() {
    if (!raf && orbs.size) raf = requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', kick);

  // Mount an orb inside `host` (any element). Returns a small handle.
  function mount(host, size, state = 'idle') {
    if (!colours) readColours();
    const canvas = document.createElement('canvas');
    canvas.className = 'orb-canvas';
    canvas.style.width = canvas.style.height = `${size}px`;
    host.appendChild(canvas);
    let ctx = null;
    try { ctx = build(canvas); } catch (e) { console.warn('orb shader', e); }
    if (!ctx) { canvas.remove(); host.classList.add('orb-fallback'); return { set() {}, voice() {}, wake() {} }; }
    const o = { canvas, ctx, size, state, level: (STATES[state] || STATES.idle)[0], speed: 0, voice: 0, t: Math.random() * 20, since: performance.now(), dirty: true };
    orbs.add(o);
    kick();
    return {
      set(s) {
        if (o.state !== s) { o.state = s; o.since = performance.now(); }
        kick();
      },
      voice(l) { o.voice = Math.max(0, Math.min(1, l || 0)); kick(); },
      // Opening the panel gives an idle orb one short sway before it rests again.
      wake() { o.since = performance.now(); o.dirty = true; kick(); },
    };
  }

  // Island's app states -> orb states.
  const fromIsland = (s) => ({ thinking: 'thinking', tool: 'working', control: 'working', listening: 'listening', approval: 'approval', ready: 'done', error: 'done' })[s] || 'idle';

  window.Orb = { mount, fromIsland };
})();
