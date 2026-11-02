// Direction-lock touch gestures so vertical lists and editable controls keep
// their native behavior. A cancelled or short drag restores the open drawer.
export function installDrawerDismiss(panel, { enabled, close }) {
  let gesture = null, suppressClickUntil = 0;
  const reset = () => { gesture = null; panel.removeAttribute('data-swiping'); panel.style.removeProperty('--drawer-offset'); };
  panel.addEventListener('touchstart', event => {
    reset();
    if (!enabled() || event.touches.length !== 1 || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    const touch = event.touches[0];
    gesture = { id:touch.identifier, x:touch.clientX, y:touch.clientY, distance:0, horizontal:false };
  }, { passive:true });
  panel.addEventListener('touchmove', event => {
    if (!gesture) return;
    if (!enabled() || event.touches.length !== 1) { reset(); return; }
    const touch = [...event.touches].find(touch => touch.identifier === gesture.id);
    if (!touch) { reset(); return; }
    const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (!gesture.horizontal) {
      if (Math.max(Math.abs(dx),Math.abs(dy)) < 10) return;
      if (dx >= 0 || Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
      gesture.horizontal = true;
    }
    event.preventDefault();
    gesture.distance = Math.min(panel.getBoundingClientRect().width,Math.max(0,-dx));
    panel.dataset.swiping = '';
    panel.style.setProperty('--drawer-offset', `${-gesture.distance}px`);
  }, { passive:false });
  panel.addEventListener('touchend', () => {
    if (!gesture) return;
    const dismiss = enabled() && gesture.distance >= Math.min(80,panel.getBoundingClientRect().width * .25);
    if (gesture.horizontal) suppressClickUntil = Date.now() + 400;
    reset();
    if (dismiss) close();
  });
  panel.addEventListener('touchcancel', reset, { passive:true });
  panel.addEventListener('click', event => { if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  addEventListener('resize',reset);
  return { reset };
}
