import { animateCanvas, createProgram } from './webgl.js';

const vertexSource = `
  attribute vec3 a_position;
  attribute vec3 a_normal;
  uniform float u_time;
  uniform float u_aspect;
  varying vec3 v_normal;
  varying vec3 v_position;
  varying vec2 v_uv;

  void main() {
    float phase = u_time * 0.32;
    float yaw = 0.3 + phase - 0.32 * sin(phase * 2.0);
    float pitch = 0.08;
    mat3 turn = mat3(
      cos(yaw), 0.0, -sin(yaw),
      0.0, 1.0, 0.0,
      sin(yaw), 0.0, cos(yaw)
    );
    mat3 tilt = mat3(
      1.0, 0.0, 0.0,
      0.0, cos(pitch), sin(pitch),
      0.0, -sin(pitch), cos(pitch)
    );
    mat3 rotation = tilt * turn;
    // Narrow the native mesh in width and depth; inverse scale keeps lighting normals correct.
    vec3 scale = vec3(0.9, 1.0, 0.9);
    vec3 position = rotation * (a_position * scale);
    position.y += sin(phase * 0.5 + 0.8) * 0.02;

    // Perspective camera, with near=1 and far=10; the artwork stays mapped to both sides.
    float depth = 4.6 - position.z;
    gl_Position = vec4(
      position.x * 3.5 / u_aspect,
      position.y * 3.5,
      (11.0 * depth - 20.0) / 9.0,
      depth
    );
    v_normal = rotation * normalize(a_normal / scale);
    v_position = position;
    // Same object-space projection as Atmosphere; mirror the rear so its logo stays upright.
    // Y is inverted relative to the app because this texture is uploaded with FLIP_Y.
    float coverX = a_normal.z < 0.0 ? -a_position.x : a_position.x;
    v_uv = vec2(0.5 + coverX / 0.78 * 0.27,
      0.5 + a_position.y / 1.25 * 0.40);
  }
`;

const fragmentSource = `
  precision highp float;
  uniform sampler2D u_logo;
  varying vec3 v_normal;
  varying vec3 v_position;
  varying vec2 v_uv;

  void main() {
    vec3 normal = normalize(v_normal);
    vec3 light = normalize(vec3(-3.0, 4.0, 6.0));
    vec3 view = normalize(vec3(0.0, 0.0, 4.6) - v_position);
    float diffuse = max(dot(normal, light), 0.0);
    float reflection = pow(max(dot(normal, normalize(light + view)), 0.0), 24.0) * diffuse;

    vec4 artwork = texture2D(u_logo, v_uv);
    vec3 surface = mix(vec3(0.68, 0.73, 0.79), artwork.rgb, artwork.a);
    vec3 albedo = pow(surface, vec3(2.2));

    // A stationary soft light describes the diamond volume without hard specular spots.
    float faceLight = 0.82 + diffuse * 0.18;
    vec3 color = albedo * faceLight;
    color += vec3(0.96, 0.98, 1.0) * reflection * 0.015;
    gl_FragColor = vec4(pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
  }
`;

// Keep the solid mesh identical to ui/app/Atmosphere.tsx, including its flat normals.
function crystalGeometry() {
  const points = [
    [0, 1.25, 0],
    [0, -1.25, 0],
    [-0.78, 0, 0],
    [0, 0, 0.78],
    [0.78, 0, 0],
    [0, 0, -0.78],
  ];
  const faces = [
    [0, 2, 3],
    [0, 3, 4],
    [0, 4, 5],
    [0, 5, 2],
    [1, 3, 2],
    [1, 4, 3],
    [1, 5, 4],
    [1, 2, 5],
  ];
  const data = new Float32Array(24 * 6);
  let offset = 0;
  const append = (index, nx, ny, nz) => {
    data.set(points[index], offset);
    data[offset + 3] = nx;
    data[offset + 4] = ny;
    data[offset + 5] = nz;
    offset += 6;
  };
  for (const face of faces) {
    const a = points[face[0]],
      b = points[face[1]],
      c = points[face[2]];
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    for (const index of face) {
      append(index, nx / length, ny / length, nz / length);
    }
  }
  return data;
}

function renderCrystal(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true });
  if (!gl) {
    return;
  }
  const program = createProgram(gl, vertexSource, fragmentSource);
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  if (!program || !buffer || !texture) {
    return;
  }

  const geometry = crystalGeometry();
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry, gl.STATIC_DRAW);
  for (const [name, size, offset] of [
    ['a_position', 3, 0],
    ['a_normal', 3, 12],
  ]) {
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 24, offset);
  }
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  const time = gl.getUniformLocation(program, 'u_time');
  const aspect = gl.getUniformLocation(program, 'u_aspect');

  const artwork = new Image();
  artwork.addEventListener('load', () => {
    if (gl.isContextLost()) {
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // A mipmapped texture keeps the logo stable when the thin object turns edge-on.
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = 1024;
    textureCanvas.height = 1024;
    const painter = textureCanvas.getContext('2d');
    if (painter) {
      painter.imageSmoothingQuality = 'high';
      painter.drawImage(artwork, 0, 0, 1024, 1024);
    }
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      painter ? textureCanvas : artwork,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (painter) {
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      painter ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    if (anisotropy) {
      const maximum = gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, maximum));
    }
    gl.uniform1i(gl.getUniformLocation(program, 'u_logo'), 0);

    animateCanvas(canvas, (elapsed) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform1f(time, elapsed);
      gl.uniform1f(aspect, canvas.width / canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, geometry.length / 6);
    });
    canvas.parentElement.classList.add('has-crystal-3d');
  });
  artwork.src = new URL('./assets/adamant.png', import.meta.url).href;
}

document.querySelectorAll('[data-crystal]').forEach(renderCrystal);
