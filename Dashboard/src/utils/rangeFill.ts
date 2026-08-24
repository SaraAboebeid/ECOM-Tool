/**
 * Keeps `--range-fill` in step with every range input's value.
 *
 * WebKit has no pseudo-element for the filled part of a track (Firefox's
 * `::-moz-range-progress` has no counterpart), so the fill has to be painted as
 * a gradient stop on the track itself - and a gradient cannot read the input's
 * value on its own. This writes the value out as a percentage the stylesheet
 * can use, which is what lets the slider styling live entirely in CSS.
 *
 * Delegated from the document rather than wired per component: the sliders are
 * spread over eight files and several mount long after start-up, so anything
 * per-instance would need touching each one and would still miss new ones.
 */

const isRange = (el: Element | null): el is HTMLInputElement =>
  el instanceof HTMLInputElement && el.type === 'range';

const paint = (el: HTMLInputElement): void => {
  const min = Number(el.min === '' ? 0 : el.min);
  const max = Number(el.max === '' ? 100 : el.max);
  const span = max - min;
  // A zero span would divide by zero; treat a degenerate range as full.
  const ratio = span > 0 ? (Number(el.value) - min) / span : 1;
  const pct = Math.min(100, Math.max(0, ratio * 100));
  el.style.setProperty('--range-fill', `${pct}%`);
};

const paintAll = (root: ParentNode = document): void => {
  root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(paint);
};

export const initRangeFill = (): void => {
  // Dragging and keyboard both raise `input`; `change` covers programmatic
  // commits that some browsers only report there.
  const onValue = (event: Event) => {
    if (isRange(event.target as Element)) paint(event.target as HTMLInputElement);
  };
  document.addEventListener('input', onValue, true);
  document.addEventListener('change', onValue, true);

  // React sets `value` as a DOM property, which fires no event and mutates no
  // attribute - so a slider driven by state (the timeline while playing, a
  // sweep resetting its bounds) would move its thumb and leave the fill behind.
  // Wrapping the native setter is how React's own value tracker follows the
  // same thing, and it catches every write regardless of who made it.
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  );
  if (descriptor?.set && descriptor.get) {
    const { get, set } = descriptor;
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      ...descriptor,
      set(this: HTMLInputElement, next: string) {
        set.call(this, next);
        if (this.type === 'range') paint(this);
      },
      get(this: HTMLInputElement) {
        return get.call(this);
      },
    });
  }

  // Panels mount long after start-up, so newly added sliders need a first paint.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (isRange(node as Element)) paint(node as HTMLInputElement);
        else if (node instanceof HTMLElement) paintAll(node);
      });
      // `min`/`max` can change under a slider whose value stayed put.
      if (record.type === 'attributes' && isRange(record.target as Element)) {
        paint(record.target as HTMLInputElement);
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['min', 'max'],
  });

  paintAll();
};

export default initRangeFill;
