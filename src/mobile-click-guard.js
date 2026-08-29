const scroller = document.querySelector("#tree-scroller");

if (scroller) {
  const touches = new Map();
  let gestureHadMultiplePointers = false;
  let suppressedGesture = null;

  const SUPPRESS_MS = 180;
  const SUPPRESS_RADIUS = 42;
  const isInsideCanvas = (event) => event.composedPath?.().includes(scroller) || scroller.contains(event.target);

  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch" || !isInsideCanvas(event)) return;
      touches.set(event.pointerId, {
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
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
      touch.lastX = event.clientX;
      touch.lastY = event.clientY;
      if (Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) >= 7) touch.moved = true;
    },
    true,
  );

  const finish = (event) => {
    const touch = touches.get(event.pointerId);
    if (!touch) return;
    touch.lastX = event.clientX;
    touch.lastY = event.clientY;
    const shouldSuppress = touch.moved || gestureHadMultiplePointers;
    touches.delete(event.pointerId);
    if (shouldSuppress) {
      suppressedGesture = {
        x: touch.lastX,
        y: touch.lastY,
        until: performance.now() + SUPPRESS_MS,
      };
    }
    if (!touches.size) gestureHadMultiplePointers = false;
  };

  window.addEventListener("pointerup", finish, true);
  window.addEventListener("pointercancel", finish, true);

  window.addEventListener(
    "click",
    (event) => {
      if (!suppressedGesture || performance.now() >= suppressedGesture.until || !isInsideCanvas(event)) return;
      const distance = Math.hypot(event.clientX - suppressedGesture.x, event.clientY - suppressedGesture.y);
      if (distance > SUPPRESS_RADIUS) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressedGesture = null;
    },
    true,
  );
}
