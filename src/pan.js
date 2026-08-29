import "./pan-overrides.css";

const scroller = document.querySelector("#tree-scroller");
const stage = document.querySelector("#tree-stage");
const zoomInButton = document.querySelector("#zoom-in");
const zoomOutButton = document.querySelector("#zoom-out");
const zoomResetButton = document.querySelector("#zoom-reset");
const zoomValue = document.querySelector("#zoom-value");
const canvasHint = document.querySelector(".canvas-hint");

if (scroller && stage) {
  const MIN_ZOOM = 0.02;
  const MAX_ZOOM = 2.2;
  const TOUCH_PAN_GAIN = 1.38;
  const MOUSE_PAN_GAIN = 1;
  const DRAG_THRESHOLD = 4;
  const INERTIA_FRICTION = 0.92;
  const INERTIA_STOP_SPEED = 0.018;

  const pointers = new Map();
  const view = {
    x: 0,
    y: 0,
    zoom: 1,
    mode: "idle",
    primaryId: null,
    dragStartX: 0,
    dragStartY: 0,
    dragStartPanX: 0,
    dragStartPanY: 0,
    dragPointerType: "mouse",
    dragged: false,
    velocityX: 0,
    velocityY: 0,
    lastMoveX: 0,
    lastMoveY: 0,
    lastMoveAt: 0,
    pinchStartZoom: 1,
    pinchStartDistance: 0,
    pinchAnchorX: 0,
    pinchAnchorY: 0,
    inertiaFrame: null,
    applyingLegacyZoomReset: false,
  };

  const formatZoom = (value) => {
    const percent = value * 100;
    if (percent >= 10) return `${Math.round(percent)}%`;
    if (percent >= 1) return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
    return `${percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
  };

  const clampZoom = (value) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));

  const applyView = () => {
    stage.style.setProperty("--pan-x", `${view.x}px`);
    stage.style.setProperty("--pan-y", `${view.y}px`);
    stage.style.setProperty("--visual-zoom", String(view.zoom));
    if (zoomValue) zoomValue.textContent = formatZoom(view.zoom);
  };

  const resetLegacyZoom = () => {
    const legacyZoom = Number.parseFloat(stage.style.zoom) || 1;
    if (Math.abs(legacyZoom - 1) < 1e-9) return;
    view.applyingLegacyZoomReset = true;
    stage.style.zoom = "1";
    queueMicrotask(() => { view.applyingLegacyZoomReset = false; });
  };

  const styleObserver = new MutationObserver(() => {
    if (!view.applyingLegacyZoomReset) resetLegacyZoom();
    applyView();
  });
  styleObserver.observe(stage, { attributes: true, attributeFilter: ["style"] });

  const localPoint = (clientX, clientY) => {
    const rect = scroller.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const stopInertia = () => {
    if (view.inertiaFrame) cancelAnimationFrame(view.inertiaFrame);
    view.inertiaFrame = null;
  };

  const startInertia = () => {
    stopInertia();
    if (view.dragPointerType !== "touch") return;
    if (Math.hypot(view.velocityX, view.velocityY) < INERTIA_STOP_SPEED) return;
    let previous = performance.now();
    const tick = (now) => {
      const dt = Math.min(34, now - previous);
      previous = now;
      view.x += view.velocityX * dt;
      view.y += view.velocityY * dt;
      const friction = Math.pow(INERTIA_FRICTION, dt / 16.67);
      view.velocityX *= friction;
      view.velocityY *= friction;
      applyView();
      if (Math.hypot(view.velocityX, view.velocityY) >= INERTIA_STOP_SPEED) view.inertiaFrame = requestAnimationFrame(tick);
      else view.inertiaFrame = null;
    };
    view.inertiaFrame = requestAnimationFrame(tick);
  };

  const pointerPair = () => [...pointers.values()].slice(0, 2);

  const beginDrag = (pointer) => {
    stopInertia();
    view.mode = "drag";
    view.primaryId = pointer.id;
    view.dragStartX = pointer.clientX;
    view.dragStartY = pointer.clientY;
    view.dragStartPanX = view.x;
    view.dragStartPanY = view.y;
    view.dragPointerType = pointer.pointerType;
    view.dragged = false;
    view.velocityX = 0;
    view.velocityY = 0;
    view.lastMoveX = pointer.clientX;
    view.lastMoveY = pointer.clientY;
    view.lastMoveAt = performance.now();
    scroller.classList.add("free-pan-enabled");
  };

  const beginPinch = () => {
    const pair = pointerPair();
    if (pair.length < 2) return;
    stopInertia();
    const [a, b] = pair;
    const centerClientX = (a.clientX + b.clientX) / 2;
    const centerClientY = (a.clientY + b.clientY) / 2;
    const center = localPoint(centerClientX, centerClientY);
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    view.mode = "pinch";
    view.primaryId = null;
    view.pinchStartZoom = view.zoom;
    view.pinchStartDistance = Math.max(distance, 1);
    view.pinchAnchorX = (center.x - view.x) / view.zoom;
    view.pinchAnchorY = (center.y - view.y) / view.zoom;
    view.dragged = true;
    scroller.classList.add("is-pinching", "free-pan-enabled");
    scroller.classList.remove("is-panning");
  };

  const zoomAround = (nextZoom, clientX, clientY) => {
    const next = clampZoom(nextZoom);
    if (Math.abs(next - view.zoom) < 1e-9) return;
    const point = localPoint(clientX, clientY);
    const anchorX = (point.x - view.x) / view.zoom;
    const anchorY = (point.y - view.y) / view.zoom;
    view.zoom = next;
    view.x = point.x - anchorX * view.zoom;
    view.y = point.y - anchorY * view.zoom;
    applyView();
  };

  const zoomAtViewportCenter = (factor) => {
    const rect = scroller.getBoundingClientRect();
    zoomAround(view.zoom * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const resetZoom = () => {
    const rect = scroller.getBoundingClientRect();
    zoomAround(1, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const elementPointInStage = (element) => {
    let x = 0;
    let y = 0;
    let current = element;
    while (current && current !== stage) {
      x += current.offsetLeft || 0;
      y += current.offsetTop || 0;
      current = current.offsetParent;
    }
    return { x, y };
  };

  const fitToContent = ({ maxZoom = 1, padding } = {}) => {
    stopInertia();
    const rect = scroller.getBoundingClientRect();
    const pad = Number.isFinite(padding) ? padding : (rect.width < 700 ? 18 : 42);
    const content = stage.querySelector(".org-tree") || stage.firstElementChild;
    if (!content) return;
    const width = Math.max(content.scrollWidth || content.offsetWidth || 1, 1);
    const height = Math.max(content.scrollHeight || content.offsetHeight || 1, 1);
    const availableWidth = Math.max(80, rect.width - pad * 2);
    const availableHeight = Math.max(80, rect.height - pad * 2);
    view.zoom = clampZoom(Math.min(availableWidth / width, availableHeight / height, maxZoom));
    const point = elementPointInStage(content);
    view.x = (rect.width - width * view.zoom) / 2 - point.x * view.zoom;
    view.y = (rect.height - height * view.zoom) / 2 - point.y * view.zoom;
    applyView();
  };

  const focusNode = (nodeId, { minZoom = 0.55, maxZoom = 1.1 } = {}) => {
    if (!nodeId) return;
    const target = stage.querySelector(`[data-node-id="${CSS.escape(String(nodeId))}"]`);
    if (!target) return;
    stopInertia();
    const rect = scroller.getBoundingClientRect();
    const point = elementPointInStage(target);
    const nextZoom = clampZoom(Math.min(maxZoom, Math.max(minZoom, view.zoom)));
    view.zoom = nextZoom;
    view.x = rect.width / 2 - (point.x + target.offsetWidth / 2) * view.zoom;
    view.y = rect.height * 0.38 - (point.y + target.offsetHeight / 2) * view.zoom;
    applyView();
  };

  scroller.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.target.closest("button, input, select, textarea, a")) return;
    const pointer = { id: event.pointerId, pointerType: event.pointerType || "mouse", clientX: event.clientX, clientY: event.clientY };
    pointers.set(event.pointerId, pointer);
    stopInertia();
    if (event.pointerType === "touch") event.preventDefault();
    event.stopImmediatePropagation();
    try { scroller.setPointerCapture(event.pointerId); } catch {}
    if (pointers.size >= 2) beginPinch(); else beginDrag(pointer);
  }, true);

  scroller.addEventListener("pointermove", (event) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    if (event.pointerType === "touch") event.preventDefault();
    event.stopImmediatePropagation();

    if (pointers.size >= 2) {
      if (view.mode !== "pinch") beginPinch();
      const [a, b] = pointerPair();
      if (!a || !b) return;
      const centerClientX = (a.clientX + b.clientX) / 2;
      const centerClientY = (a.clientY + b.clientY) / 2;
      const center = localPoint(centerClientX, centerClientY);
      const distance = Math.max(Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), 1);
      view.zoom = clampZoom(view.pinchStartZoom * (distance / view.pinchStartDistance));
      view.x = center.x - view.pinchAnchorX * view.zoom;
      view.y = center.y - view.pinchAnchorY * view.zoom;
      applyView();
      return;
    }

    if (view.mode !== "drag" || view.primaryId !== event.pointerId) return;
    const gain = view.dragPointerType === "touch" ? TOUCH_PAN_GAIN : MOUSE_PAN_GAIN;
    const dx = (event.clientX - view.dragStartX) * gain;
    const dy = (event.clientY - view.dragStartY) * gain;
    if (!view.dragged && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
      view.dragged = true;
      scroller.classList.add("is-panning");
    }
    view.x = view.dragStartPanX + dx;
    view.y = view.dragStartPanY + dy;
    const now = performance.now();
    const dt = Math.max(1, now - view.lastMoveAt);
    const velocityGain = view.dragPointerType === "touch" ? TOUCH_PAN_GAIN : 1;
    const instantVX = ((event.clientX - view.lastMoveX) * velocityGain) / dt;
    const instantVY = ((event.clientY - view.lastMoveY) * velocityGain) / dt;
    view.velocityX = view.velocityX * 0.55 + instantVX * 0.45;
    view.velocityY = view.velocityY * 0.55 + instantVY * 0.45;
    view.lastMoveX = event.clientX;
    view.lastMoveY = event.clientY;
    view.lastMoveAt = now;
    applyView();
  }, true);

  const finishPointer = (event) => {
    if (!pointers.has(event.pointerId)) return;
    const wasDragging = view.mode === "drag" && view.primaryId === event.pointerId;
    pointers.delete(event.pointerId);
    event.stopImmediatePropagation();
    try { if (scroller.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId); } catch {}
    if (pointers.size >= 2) { beginPinch(); return; }
    scroller.classList.remove("is-pinching");
    if (pointers.size === 1) { beginDrag([...pointers.values()][0]); return; }
    scroller.classList.remove("is-panning");
    view.mode = "idle";
    view.primaryId = null;
    if (wasDragging && view.dragged) startInertia();
  };

  scroller.addEventListener("pointerup", finishPointer, true);
  scroller.addEventListener("pointercancel", finishPointer, true);
  scroller.addEventListener("lostpointercapture", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (!pointers.size) {
      view.mode = "idle";
      view.primaryId = null;
      scroller.classList.remove("is-panning", "is-pinching");
    }
  }, true);

  scroller.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.deltaY) return;
    zoomAround(view.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX, event.clientY);
  }, { capture: true, passive: false });

  const interceptZoomButton = (button, action) => {
    button?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      action();
    }, true);
  };
  interceptZoomButton(zoomOutButton, () => zoomAtViewportCenter(1 / 1.18));
  interceptZoomButton(zoomInButton, () => zoomAtViewportCenter(1.18));
  interceptZoomButton(zoomResetButton, resetZoom);

  window.BeizeCanvas = Object.freeze({
    fitToContent,
    focusNode,
    resetZoom,
    getView: () => ({ x: view.x, y: view.y, zoom: view.zoom }),
  });

  window.addEventListener("resize", applyView);
  if (canvasHint) canvasHint.textContent = "拖动画布 · 滚轮 / 双指缩放";
  resetLegacyZoom();
  applyView();
}
