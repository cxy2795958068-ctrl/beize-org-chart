import "./pan-overrides.css";

const scroller = document.querySelector("#tree-scroller");
const stage = document.querySelector("#tree-stage");

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

  const applyPan = () => {
    stage.style.setProperty("--pan-x", `${panState.x}px`);
    stage.style.setProperty("--pan-y", `${panState.y}px`);
  };

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

  applyPan();
}
