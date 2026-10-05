export function createProgram(gl, vertexSource, fragmentSource) {
  const shaders = [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragmentSource],
  ].map(([type, source]) => {
    const shader = gl.createShader(type);
    if (!shader) {
      return null;
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  });

  const program = gl.createProgram();
  if (!program || shaders.some((shader) => !shader)) {
    shaders.forEach((shader) => shader && gl.deleteShader(shader));
    if (program) {
      gl.deleteProgram(program);
    }
    return null;
  }

  shaders.forEach((shader) => gl.attachShader(program, shader));
  gl.linkProgram(program);
  shaders.forEach((shader) => gl.deleteShader(shader));
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

// The crystal follows the display refresh rate; backgrounds can request a lower cadence.
export function animateCanvas(canvas, draw, { frameRate = 0, pixelRatio = 1.5 } = {}) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let visible = false;
  let lost = false;
  let frame = 0;
  let previous = 0;
  let elapsed = 0;
  let pendingTime = 0;
  const interval = frameRate > 0 ? 1000 / frameRate : 0;

  function tick(now) {
    const delta = Math.min(now - previous, 100);
    previous = now;
    elapsed += delta / 1000;
    pendingTime += delta;
    if (!interval || pendingTime + 0.01 >= interval) {
      draw(elapsed);
      pendingTime = interval ? Math.max(0, pendingTime - interval) : 0;
    }
    frame = requestAnimationFrame(tick);
  }

  function sync() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (!lost && visible && !document.hidden && !reducedMotion.matches) {
      previous = performance.now();
      pendingTime = 0;
      frame = requestAnimationFrame(tick);
    }
  }

  function resize() {
    if (lost) {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, pixelRatio);
    canvas.width = Math.max(1, Math.round(bounds.width * scale));
    canvas.height = Math.max(1, Math.round(bounds.height * scale));
    draw(elapsed);
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(canvas);
  } else {
    visible = true;
  }

  if ('ResizeObserver' in window) {
    new ResizeObserver(resize).observe(canvas);
  } else {
    window.addEventListener('resize', resize, { passive: true });
  }

  reducedMotion.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  canvas.addEventListener('webglcontextlost', () => {
    lost = true;
    canvas.style.visibility = 'hidden';
    canvas.parentElement.classList.remove('has-crystal-3d');
    sync();
  });

  resize();
  sync();
}
