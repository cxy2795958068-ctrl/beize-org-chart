const scroller = document.querySelector("#tree-scroller");
const stage = document.querySelector("#tree-stage");

if (scroller) {
  const touches = new Map();
  let gestureHadMultiplePointers = false;
  let suppressedGesture = null;

  const SUPPRESS_MS = 100;
  const SUPPRESS_RADIUS = 28;
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
      if (!suppressedGesture || !isInsideCanvas(event)) return;

      // A click following a touch gesture is only suppressed when the browser
      // explicitly identifies it as touch-originated. Mouse clicks and a fresh
      // pointer click must never be swallowed by the gesture guard.
      const pointerType = typeof event.pointerType === "string" ? event.pointerType : "";
      const firesTouchEvents = event.sourceCapabilities?.firesTouchEvents === true;
      const touchOriginated = pointerType === "touch" || firesTouchEvents;
      if (!touchOriginated) return;
      if (performance.now() >= suppressedGesture.until) return;

      const distance = Math.hypot(event.clientX - suppressedGesture.x, event.clientY - suppressedGesture.y);
      if (distance > SUPPRESS_RADIUS) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressedGesture = null;
    },
    true,
  );
}

if (stage && window.matchMedia("(max-width: 700px)").matches) {
  let completed = false;
  const fitInitialTree = () => {
    if (completed) return true;
    if (!stage.querySelector(".org-tree") || !window.BeizeCanvas?.fitToContent) return false;
    window.BeizeCanvas.fitToContent({ force: true });
    stage.dataset.initialFit = "done";
    completed = true;
    return true;
  };

  if (!fitInitialTree()) {
    const observer = new MutationObserver(() => {
      if (!fitInitialTree()) return;
      observer.disconnect();
    });
    observer.observe(stage, { childList: true });
  }
}
