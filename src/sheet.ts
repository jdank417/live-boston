// On phones the sidebar becomes a bottom sheet you can drag between three
// heights: a peek (just the header and tabs), half the screen, and nearly full.

export type Snap = 'peek' | 'half' | 'full';

export const isPhone = () => matchMedia('(max-width: 720px)').matches;

export class Sheet {
  snap: Snap = 'peek';
  private dragging = false;

  constructor(
    private readonly el: HTMLElement,
    handles: HTMLElement[],
    private readonly onChange: () => void,
  ) {
    for (const h of handles) this.bindDrag(h);
    addEventListener('resize', () => this.set(this.snap, false));
    // Lay out without notifying: whoever is listening may not be ready yet.
    this.set('peek', false, false);
  }

  /** Visible height for each snap, in pixels. */
  private heights() {
    const tabs = this.el.querySelector<HTMLElement>('.tabs');
    const peek = tabs ? tabs.offsetTop + tabs.offsetHeight + 14 : 150;
    return { peek, half: Math.round(innerHeight * 0.52), full: Math.round(innerHeight - 56) };
  }

  /** How much of the screen the sheet covers right now. */
  get height() {
    return isPhone() ? this.el.offsetHeight : 0;
  }

  set(snap: Snap, animate = true, notify = true) {
    this.snap = snap;
    if (!isPhone()) {
      this.el.style.height = '';
      if (notify) this.onChange();
      return;
    }
    this.el.classList.toggle('animate', animate);
    this.el.style.height = `${this.heights()[snap]}px`;
    this.el.dataset.snap = snap;
    if (!notify) return;
    // Report once the height transition has settled.
    if (animate) setTimeout(this.onChange, 340);
    else this.onChange();
  }

  /** Opens far enough to read a card, without collapsing a sheet that's already up. */
  reveal() {
    if (isPhone() && this.snap === 'peek') this.set('half');
  }

  private bindDrag(handle: HTMLElement) {
    let startY = 0;
    let startH = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let pointer: number | null = null;

    handle.addEventListener('pointerdown', (e) => {
      if (!isPhone()) return;
      pointer = e.pointerId;
      startY = lastY = e.clientY;
      startH = this.el.getBoundingClientRect().height;
      lastT = performance.now();
      velocity = 0;
      this.dragging = false;
    });

    handle.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointer) return;
      const dy = e.clientY - startY;
      // A small movement is still a tap on a tab.
      if (!this.dragging && Math.abs(dy) < 6) return;
      if (!this.dragging) {
        this.dragging = true;
        handle.setPointerCapture(e.pointerId);
        this.el.classList.remove('animate');
      }
      const now = performance.now();
      velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
      lastY = e.clientY;
      lastT = now;
      const { peek, full } = this.heights();
      this.el.style.height = `${Math.max(peek - 40, Math.min(full, startH - dy))}px`;
    });

    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      if (!this.dragging) return;
      // Swallow the click that ends a drag, so it doesn't also press a tab.
      handle.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true });
      this.dragging = false;
      const h = this.el.getBoundingClientRect().height;
      const heights = this.heights();
      // A flick decides; otherwise settle on the nearest height.
      let snap: Snap;
      if (velocity < -0.5) snap = h > heights.half ? 'full' : 'half';
      else if (velocity > 0.5) snap = h < heights.half ? 'peek' : 'half';
      else
        snap = (Object.entries(heights) as [Snap, number][]).reduce((a, b) =>
          Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a,
        )[0];
      this.set(snap);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
