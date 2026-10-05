const header = document.querySelector('.site-header');

if (header) {
  const sections = [...document.querySelectorAll('[data-section-tone]')];
  const links = [...header.querySelectorAll('.nav-links a')];
  const navigation = header.querySelector('.nav-links');
  const sideItems = [...header.querySelectorAll('.brand, .nav-action')];
  let previousY = window.scrollY;
  let direction = 0;
  let distance = 0;
  let frame = 0;
  let headerSpace = 84;
  let headerTop = 24;
  let navigationTop = 2;
  let navigationHeight = 52;

  function show() {
    header.dataset.hidden = 'false';
  }

  function updateSection(compact) {
    // Sample the section beneath the resting bar, even while the bar is offscreen.
    const probeY = headerTop + (compact ? 0 : navigationTop) + navigationHeight / 2;
    const section = sections.find((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top <= probeY && bounds.bottom > probeY;
    });
    const background = section?.dataset.sectionTone ?? 'dark';
    header.dataset.theme = background === 'light' ? 'dark' : 'light';
    for (const link of links) {
      if (section?.id && link.getAttribute('href') === `#${section.id}`) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    }
  }

  function update() {
    frame = 0;
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const y = Math.max(0, Math.min(window.scrollY, maxY));
    const delta = y - previousY;
    const compact = y > 24;

    if (header.dataset.compact !== String(compact)) {
      header.dataset.compact = String(compact);
      for (const item of sideItems) {
        item.inert = compact;
      }
    }

    if (delta !== 0) {
      const nextDirection = Math.sign(delta);
      if (nextDirection !== direction) {
        distance = 0;
        direction = nextDirection;
      }
      distance += delta;
    }

    if (y <= 24 || header.querySelector(':focus-visible')) {
      show();
      distance = 0;
    } else if (distance < -8) {
      show();
    } else if (distance > 16 && y > headerSpace + 40) {
      header.dataset.hidden = 'true';
    }

    updateSection(compact);
    previousY = y;
  }

  function schedule() {
    if (!frame) {
      frame = requestAnimationFrame(update);
    }
  }

  function measure() {
    headerTop = Number.parseFloat(window.getComputedStyle(header).top) || 0;
    const height = header.offsetHeight;
    navigationTop = navigation.offsetTop;
    navigationHeight = navigation.offsetHeight;
    headerSpace = headerTop + height;
    header.style.setProperty('--nav-compact-offset', `${navigationTop}px`);
    document.documentElement.style.setProperty('--header-space', `${headerSpace}px`);
    schedule();
  }

  header.addEventListener('focusin', show);
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', measure, { passive: true });
  window.addEventListener('pageshow', schedule);
  if ('ResizeObserver' in window) {
    new ResizeObserver(measure).observe(header);
  }
  measure();
}
