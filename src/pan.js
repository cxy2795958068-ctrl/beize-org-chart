import "./pan-overrides.css";

const scroller = document.querySelector("#tree-scroller");
const stage = document.querySelector("#tree-stage");
const zoomInButton = document.querySelector("#zoom-in");
const zoomOutButton = document.querySelector("#zoom-out");
const zoomResetButton = document.querySelector("#zoom-reset");
const zoomValue = document.querySelector("#zoom-value");

if (scroller && stage) {
  const panState = {
    x: 0,
    y: 0,
    active: false,
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    startX: 0,
    startY: 0,
  };

  // Own the visual zoom here so the canvas is no longer constrained by the
  // legacy 50% minimum in main.js. Number.EPSILON keeps the CSS value positive
  // without imposing a practical lower zoom limit. The 100% button is always
  // available as a reliable way back if the user zooms extremely far out.
  let visualZoom = Number.parseFloat(stage.style.zoom) || 1;
  let lastWheelZoomAt = 0;
  let applyingZoom = false;

  const formatZoom = (value) => {
    const percent = value * 100;
    if (percent >= 10) return `${Math.round(percent)}%`;
    if (percent >= 1) return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
    if (percent >= 0.01) return `${percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
    return "<0.01%";
  };

  const applyPan = () => {
    stage.style.setProperty("--pan-x", `${panState.x}px`);
    stage.style.setProperty("--pan-y", `${panState.y}px`);
  };

  const applyVisualZoom = () => {
    applyingZoom = true;
    stage.style.zoom = String(visualZoom);
    if (zoomValue) zoomValue.textContent = formatZoom(visualZoom);
    queueMicrotask(() => {
      applyingZoom = false;
    });
  };

  const setVisualZoom = (nextZoom) => {
    if (!Number.isFinite(nextZoom) || nextZoom <= 0) return;
    visualZoom = Math.max(Number.EPSILON, Math.min(1.5, nextZoom));
    applyVisualZoom();
  };

  const zoomOut = () => setVisualZoom(visualZoom * 0.82);
  const zoomIn = () => setVisualZoom(visualZoom / 0.82);
  const resetZoom = () => setVisualZoom(1);

  // main.js re-renders the tree after edits and writes its own zoom value back
  // onto the stage. Re-apply the user's visual zoom so their viewport does not
  // unexpectedly jump back to 50%/100% while editing.
  const styleObserver = new MutationObserver(() => {
    if (applyingZoom) return;
    const renderedZoom = Number.parseFloat(stage.style.zoom) || 1;
    if (Math.abs(renderedZoom - visualZoom) > 1e-10) applyVisualZoom();
  });
  styleObserver.observe(stage, { attributes: true, attributeFilter: ["style"] });

  scroller.addEventListener(
    "pointerdown",
    (event) => {
      if (
        event.button !== 0 ||
        event.ctrlKey ||
        event.target.closest("button, input, select, textarea, a")
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      panState.active = true;
      panState.pointerId = event.pointerId;
      panState.startClientX = event.clientX;
      panState.startClientY = event.clientY;
      panState.startX = panState.x;
      panState.startY = panState.y;

      scroller.setPointerCapture(event.pointerId);
      scroller.classList.add("is-panning", "free-pan-enabled");
    },
    true,
  );

  scroller.addEventListener(
    "pointermove",
    (event) => {
      if (!panState.active || event.pointerId !== panState.pointerId) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      panState.x = panState.startX + (event.clientX - panState.startClientX);
      panState.y = panState.startY + (event.clientY - panState.startClientY);
      applyPan();
    },
    true,
  );

  const stopPan = (event) => {
    if (!panState.active || event.pointerId !== panState.pointerId) return;

    event.stopImmediatePropagation();
    if (scroller.hasPointerCapture(event.pointerId)) {
      scroller.releasePointerCapture(event.pointerId);
    }

    panState.active = false;
    panState.pointerId = null;
    scroller.classList.remove("is-panning");
  };

  scroller.addEventListener("pointerup", stopPan, true);
  scroller.addEventListener("pointercancel", stopPan, true);
  scroller.addEventListener(
    "lostpointercapture",
    () => {
      panState.active = false;
      panState.pointerId = null;
      scroller.classList.remove("is-panning");
    },
    true,
  );

  scroller.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      const now = performance.now();
      if (now - lastWheelZoomAt < 55 || event.deltaY === 0) return;
      lastWheelZoomAt = now;

      if (event.deltaY < 0) zoomIn();
      else zoomOut();
    },
    { capture: true, passive: false },
  );

  const interceptZoomButton = (button, action) => {
    button?.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        action();
      },
      true,
    );
  };

  interceptZoomButton(zoomOutButton, zoomOut);
  interceptZoomButton(zoomInButton, zoomIn);
  interceptZoomButton(zoomResetButton, resetZoom);

  applyPan();
  applyVisualZoom();
}
