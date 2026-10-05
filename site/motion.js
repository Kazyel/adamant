const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

if (!reducedMotion.matches) {
  const revealedContent = document.querySelectorAll('[data-reveal], [data-copy-reveal]');

  if ('IntersectionObserver' in window) {
    document.documentElement.classList.add('has-motion');

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -40px 0px', threshold: 0.08 },
    );

    revealedContent.forEach((element) => observer.observe(element));
  }
}
