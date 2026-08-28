const scroller = document.querySelector("#tree-scroller");

if (scroller) {
  const touches = new Map();
  let suppressClickUntil = 0;
  let gestureHadMultiplePointers = false;

  const isInsideCanvas = (event) => event.composedPath?.().includes(scroller) || scroller.contains(event.target);

  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch" || !isInsideCanvas(event)) return;
      touches.set(event.pointerId, {
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      });
      if (touches.size > 1) gestureHadMultiplePointers = true;
    },
    true,
  );

  window.addEventListener(
    "pointermove",
    (event) => {
      const touch = touches.get(event.pointerId);
      if (!touch) return;
      if (Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) >= 7) {
        touch.moved = true;
      }
    },
    true,
  );

  const finish = (event) => {
    const touch = touches.get(event.pointerId);
    if (!touch) return;
    const shouldSuppress = touch.moved || gestureHadMultiplePointers;
    touches.delete(event.pointerId);
    if (shouldSuppress) suppressClickUntil = performance.now() + 420;
    if (!touches.size) gestureHadMultiplePointers = false;
  };

  window.addEventListener("pointerup", finish, true);
  window.addEventListener("pointercancel", finish, true);

  scroller.addEventListener(
    "click",
    (event) => {
      if (performance.now() >= suppressClickUntil) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}
