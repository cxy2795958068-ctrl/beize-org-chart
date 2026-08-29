import "./connector-visibility.css";

const scroller = document.querySelector("#tree-scroller");
const stage = document.querySelector("#tree-stage");

if (scroller) {
  const touches = new Map();
  let gestureHadMultiplePointers = false;
  let suppressedGesture = null;

  const SUPPRESS_MS = 220;
  const SUPPRESS_RADIUS = 32;
  const isInsideCanvas = (event) => event.composedPath?.().includes(scroller) || scroller.contains(event.target);
  const nodeCardFromEvent = (event) => event.target instanceof Element ? event.target.closest(".node-card") : null;
  const interactiveFromEvent = (event) => event.target instanceof Element ? event.target.closest("button, input, select, textarea, a") : null;

  window.addEventListener(
    "pointerdown",
    (event) => {
      if ((event.pointerType === "mouse" || event.pointerType === "pen") && nodeCardFromEvent(event) && !interactiveFromEvent(event) && isInsideCanvas(event)) {
        event.stopPropagation();
      }
    },
    true,
  );

  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch" || !isInsideCanvas(event) || interactiveFromEvent(event)) return;
      const card = nodeCardFromEvent(event);
      touches.set(event.pointerId, {
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        nodeId: card?.dataset.nodeId ?? null,
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
    const wasMultiPointerGesture = gestureHadMultiplePointers;
    const wasGesture = touch.moved || wasMultiPointerGesture;
    const wasNodeTap = !wasGesture && Boolean(touch.nodeId);

    touches.delete(event.pointerId);
    if (!touches.size) gestureHadMultiplePointers = false;

    if (wasGesture) {
      suppressedGesture = {
        x: touch.lastX,
        y: touch.lastY,
        until: performance.now() + SUPPRESS_MS,
      };
      return;
    }

    if (wasNodeTap) {
      suppressedGesture = {
        x: touch.lastX,
        y: touch.lastY,
        until: performance.now() + SUPPRESS_MS,
      };
      queueMicrotask(() => {
        const card = stage?.querySelector(`[data-node-id="${CSS.escape(String(touch.nodeId))}"]`);
        card?.click();
      });
    }
  };

  window.addEventListener("pointerup", finish, true);
  window.addEventListener("pointercancel", finish, true);

  window.addEventListener(
    "click",
    (event) => {
      if (!suppressedGesture || !isInsideCanvas(event)) return;
      const pointerType = typeof event.pointerType === "string" ? event.pointerType : "";
      const firesTouchEvents = event.sourceCapabilities?.firesTouchEvents === true;
      const touchOriginated = pointerType === "touch" || firesTouchEvents;
      if (!touchOriginated || performance.now() >= suppressedGesture.until) return;

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
  const focusInitialTree = () => {
    if (completed) return true;
    const root = stage.querySelector(".type-company[data-node-id]");
    if (!root || !window.BeizeCanvas?.focusNode) return false;
    window.BeizeCanvas.focusNode(root.dataset.nodeId, { minZoom: 0.42, maxZoom: 0.42 });
    stage.dataset.initialFit = "done";
    completed = true;
    return true;
  };

  if (!focusInitialTree()) {
    const observer = new MutationObserver(() => {
      if (!focusInitialTree()) return;
      observer.disconnect();
    });
    observer.observe(stage, { childList: true });
  }
}
