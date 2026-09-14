import { useEffect, useRef } from 'react';
import crystalLogo from '../../assets/adamant.png';

const vertexSource = `
  precision mediump float;
  attribute vec3 a_position;
  attribute vec3 a_normal;
  uniform float u_time;
  uniform float u_aspect;
  varying float v_light;
  varying float v_depth;
  varying float v_glint;
  varying vec2 v_uv;

  void main() {
    float angle = 0.55 + u_time * 0.07;
    float c = cos(angle);
    float s = sin(angle);
    mat3 turn = mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
    mat3 tilt = mat3(1.0, 0.0, 0.0, 0.0, 0.985, -0.174, 0.0, 0.174, 0.985);
    vec3 position = tilt * turn * a_position;
    vec3 normal = tilt * turn * a_normal;
    float depth = 3.8 - position.z;
    gl_Position = vec4(position.x * 2.0 / u_aspect,
      position.y * 2.0, 1.0202 * depth - 0.20202, depth);
    v_light = 0.25 + 0.75 * max(dot(normal, normalize(vec3(-0.4, 0.7, 1.0))), 0.0);
    v_glint = pow(max(dot(normal, normalize(vec3(-0.45, 0.8, 1.7))), 0.0), 16.0);
    v_depth = clamp(0.5 + position.z * 0.5, 0.0, 1.0);
    // Project the logo's crystal bounds onto the existing octahedron.
    // Object-space coordinates keep the engraving attached during rotation.
    v_uv = vec2(0.5 + a_position.x / 0.78 * 0.27,
      0.5 - a_position.y / 1.25 * 0.40);
  }
`;

const fragmentSource = `
  precision mediump float;
  varying float v_glint;
  uniform float u_wire;
  varying float v_light;
  varying float v_depth;
  varying vec2 v_uv;
  uniform sampler2D u_logo;

  void main() {
    vec4 logo = texture2D(u_logo, v_uv);
    vec3 silver = mix(vec3(0.68, 0.72, 0.78), logo.rgb, logo.a);
    vec3 facet = silver * mix(0.55, 1.0, v_light) + 0.08 * v_glint;
    vec3 wire = vec3(mix(0.55, 0.85, v_depth));
    gl_FragColor = vec4(mix(facet, wire, u_wire), 1.0);
  }
`;

// Eight flat-shaded faces followed by twelve wire edges, uploaded only once.
const geometry = (() => {
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
  const edges = [
    [0, 2],
    [0, 3],
    [0, 4],
    [0, 5],
    [1, 2],
    [1, 3],
    [1, 4],
    [1, 5],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 2],
  ];
  const data = new Float32Array(48 * 6);
  let offset = 0;
  const append = (index: number, nx = 0, ny = 0, nz = 0) => {
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
  for (const edge of edges) {
    append(edge[0]);
    append(edge[1]);
  }
  return data;
})();

export default function Atmosphere() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const gl = (() => {
      try {
        return canvas.getContext('webgl', {
          alpha: true,
          antialias: true,
          depth: true,
          powerPreference: 'low-power',
        });
      } catch {
        return null;
      }
    })();
    if (!gl) {
      return;
    }

    const vertex = gl.createShader(gl.VERTEX_SHADER);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    const logo = new Image();
    const releaseGpu = () => {
      logo.onload = null;
      logo.onerror = null;
      gl.useProgram(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.deleteBuffer(buffer);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
    if (!vertex || !fragment || !program || !buffer || !texture) {
      releaseGpu();
      return;
    }
    gl.shaderSource(vertex, vertexSource);
    gl.shaderSource(fragment, fragmentSource);
    gl.compileShader(vertex);
    gl.compileShader(fragment);
    if (
      !gl.getShaderParameter(vertex, gl.COMPILE_STATUS) ||
      !gl.getShaderParameter(fragment, gl.COMPILE_STATUS)
    ) {
      releaseGpu();
      return;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      releaseGpu();
      return;
    }

    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(program, 'u_logo'), 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry, gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    const normal = gl.getAttribLocation(program, 'a_normal');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(normal);
    gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, 24, 12);
    const time = gl.getUniformLocation(program, 'u_time');
    const aspect = gl.getUniformLocation(program, 'u_aspect');
    const wire = gl.getUniformLocation(program, 'u_wire');
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 0);
    if (gl.getError() !== gl.NO_ERROR) {
      releaseGpu();
      return;
    }

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let previous = 0;
    let elapsed = 0;
    let failed = false;
    let ready = false;
    let hasSize = false;
    let textureReady = false;
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const draw = (seconds: number) => {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform1f(time, seconds);
      gl.uniform1f(wire, 0);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 24);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.uniform1f(wire, 1);
      gl.drawArrays(gl.LINES, 24, 24);
      if (!ready && !gl.isContextLost()) {
        canvas.dataset.ready = 'true';
        ready = true;
      }
    };
    const animate = (now: number) => {
      frame = 0;
      if (failed || document.hidden || motion.matches || !hasSize) {
        return;
      }
      if (now - previous >= 1000 / 24) {
        elapsed += Math.min(now - previous, 100) / 1000;
        previous = now;
        draw(elapsed);
      }
      frame = requestAnimationFrame(animate);
    };
    const sync = () => {
      stop();
      if (failed || !textureReady) {
        return;
      }
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      hasSize = width > 0 && height > 0;
      if (!hasSize || document.hidden) {
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const pixelWidth = Math.max(1, Math.min(320, Math.round(width * dpr)));
      const pixelHeight = Math.max(1, Math.min(280, Math.round(height * dpr)));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(aspect, width / height);
      draw(motion.matches ? 0 : elapsed);
      previous = performance.now();
      if (!motion.matches) {
        frame = requestAnimationFrame(animate);
      }
    };
    const loseContext = () => {
      // This ornament falls back permanently; restoring a GPU is not a workbench concern.
      failed = true;
      stop();
      delete canvas.dataset.ready;
    };
    const observer = new ResizeObserver(sync);
    logo.onload = () => {
      if (failed) {
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, logo);
      if (gl.getError() !== gl.NO_ERROR) {
        loseContext();
        return;
      }
      textureReady = true;
      sync();
    };
    logo.src = crystalLogo;
    observer.observe(canvas);
    canvas.addEventListener('webglcontextlost', loseContext);
    document.addEventListener('visibilitychange', sync);
    motion.addEventListener('change', sync);
    sync();

    return () => {
      stop();
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', loseContext);
      document.removeEventListener('visibilitychange', sync);
      motion.removeEventListener('change', sync);
      delete canvas.dataset.ready;
      releaseGpu();
    };
  }, []);

  return (
    <div className="atmosphere" aria-hidden="true">
      <canvas className="atmosphere__canvas" ref={canvasRef} width={260} height={240} />
      <img className="atmosphere__fallback" src={crystalLogo} alt="" />
    </div>
  );
}
