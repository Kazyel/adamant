import { animateCanvas, createProgram } from './webgl.js';

const vertexSource = `
  attribute vec2 a_position;

  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentSource = `
  precision highp float;

  uniform vec2 u_resolution;
  uniform vec2 u_drift;
  uniform vec3 u_base;
  uniform vec3 u_accent;
  uniform float u_seed;
  uniform float u_scale;
  uniform float u_strength;
  uniform float u_levels;
  uniform float u_pixelSize;
  uniform float u_time;

  float bayer2(vec2 bits) {
    return 2.0 * bits.x + 3.0 * bits.y - 4.0 * bits.x * bits.y;
  }

  float bayer4(vec2 pixel) {
    vec2 cell = mod(floor(pixel), 4.0);
    return (4.0 * bayer2(mod(cell, 2.0)) + bayer2(floor(cell * 0.5)) + 0.5) / 16.0;
  }

  float hash(vec2 point) {
    vec3 p = fract(vec3(point.xyx) * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 f = fract(point);
    vec2 blend = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(
      mix(hash(cell), hash(cell + vec2(1.0, 0.0)), blend.x),
      mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), blend.x),
      blend.y
    );
  }

  void main() {
    // Keep each square anchored and uniform while the light travels beneath it.
    vec2 cell = floor(gl_FragCoord.xy / u_pixelSize);
    vec2 uv = (cell + 0.5) * u_pixelSize / u_resolution;
    vec2 p = uv * vec2(u_resolution.x / u_resolution.y, 1.0) * u_scale;
    p += vec2(u_seed, u_seed * 0.37);
    vec2 drift = u_drift * u_time * 2.5;

    // Diffuse light with visible ordered dithering, without geometric contours.
    float field = noise(p + drift) * 0.7;
    field += noise(p.yx * 1.7 - drift * 0.6 + vec2(8.2, 3.7)) * 0.3;
    // Blend across each Bayer threshold instead of popping to the next tone.
    float threshold = bayer4(cell);
    float intensity = field * u_levels + threshold;
    float tone = 0.0;
    for (int level = 1; level <= 3; level++) {
      if (float(level) <= u_levels) {
        tone += smoothstep(float(level) - 0.16, float(level) + 0.16, intensity);
      }
    }
    tone /= u_levels;
    vec3 color = mix(u_base, u_accent, tone * u_strength);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const palettes = {
  hero: {
    base: [12, 13, 15],
    accent: [56, 73, 98],
    seed: 1.3,
    scale: 1.4,
    strength: 0.6,
    levels: 3,
    pixelSize: 2.5,
    drift: [0.025, -0.018],
  },
  workspace: {
    base: [248, 250, 253],
    accent: [205, 219, 236],
    seed: 4.6,
    scale: 1.8,
    strength: 0.6,
    levels: 2,
    pixelSize: 2.5,
    drift: [-0.018, 0.014],
  },
  vault: {
    base: [233, 238, 244],
    accent: [185, 207, 219],
    seed: 8.2,
    scale: 1.5,
    strength: 0.55,
    levels: 2,
    pixelSize: 2.5,
    drift: [0.016, 0.02],
  },
  connections: {
    base: [23, 26, 31],
    accent: [59, 77, 100],
    seed: 12.7,
    scale: 1.6,
    strength: 0.6,
    levels: 3,
    pixelSize: 2.5,
    drift: [-0.022, -0.014],
  },
  closing: {
    base: [248, 250, 253],
    accent: [211, 225, 239],
    seed: 17.1,
    scale: 1.3,
    strength: 0.55,
    levels: 2,
    pixelSize: 2.5,
    drift: [0.02, -0.012],
  },
};

function renderDither(canvas) {
  if (window.matchMedia('(prefers-contrast: more)').matches) {
    return;
  }

  const palette = palettes[canvas.dataset.dither];
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    powerPreference: 'low-power',
  });
  if (!palette || !gl) {
    return;
  }

  const program = createProgram(gl, vertexSource, fragmentSource);
  const buffer = gl.createBuffer();
  if (!program || !buffer) {
    canvas.style.display = 'none';
    return;
  }

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  gl.uniform3fv(
    gl.getUniformLocation(program, 'u_base'),
    new Float32Array(palette.base.map((value) => value / 255)),
  );
  gl.uniform3fv(
    gl.getUniformLocation(program, 'u_accent'),
    new Float32Array(palette.accent.map((value) => value / 255)),
  );
  gl.uniform2fv(gl.getUniformLocation(program, 'u_drift'), new Float32Array(palette.drift));
  gl.uniform1f(gl.getUniformLocation(program, 'u_seed'), palette.seed);
  gl.uniform1f(gl.getUniformLocation(program, 'u_scale'), palette.scale);
  gl.uniform1f(gl.getUniformLocation(program, 'u_strength'), palette.strength);
  gl.uniform1f(gl.getUniformLocation(program, 'u_levels'), palette.levels);
  gl.uniform1f(gl.getUniformLocation(program, 'u_pixelSize'), palette.pixelSize);

  const resolution = gl.getUniformLocation(program, 'u_resolution');
  const time = gl.getUniformLocation(program, 'u_time');

  animateCanvas(
    canvas,
    (elapsed) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, elapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    { frameRate: 30, pixelRatio: 1 },
  );
}

document.querySelectorAll('[data-dither]').forEach(renderDither);
