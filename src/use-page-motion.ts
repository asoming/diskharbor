import { useEffect, useLayoutEffect, type RefObject } from 'react';

export function usePageMotion(main: RefObject<HTMLElement | null>, page: string) {
  useLayoutEffect(() => {
    const surface = main.current;
    if (!surface || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animations = [...surface.querySelectorAll<HTMLElement>('.heading h1, .page-view, .history-panel')]
      .map(element => element.animate([
        { opacity: 0.65, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 190, easing: 'cubic-bezier(.2,.7,.2,1)' }));
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const cancel = () => animations.forEach(animation => animation.cancel());
    reducedMotion.addEventListener('change', cancel);
    return () => { cancel(); reducedMotion.removeEventListener('change', cancel); };
  }, [main, page]);

  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      document.querySelectorAll<HTMLDetailsElement>('.permission-control[open]').forEach(details => {
        if (event instanceof KeyboardEvent) {
          if (event.key !== 'Escape') return;
          if (details.contains(document.activeElement)) details.querySelector<HTMLElement>('summary')?.focus();
        } else if (event.target instanceof Node && details.contains(event.target)) return;
        details.open = false;
      });
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, []);
}
