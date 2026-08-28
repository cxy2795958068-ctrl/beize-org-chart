import "./simple-mode.css";

const fieldType = document.querySelector("#field-type");
const fieldName = document.querySelector("#field-name");
const fieldTitle = document.querySelector("#field-title");
const fieldParent = document.querySelector("#field-parent");
const fieldNotes = document.querySelector("#field-notes");
const addChildButton = document.querySelector("#add-child-button");
const inspectorTitle = document.querySelector("#inspector-title");
const modalContent = document.querySelector("#modal-content");
const modalActions = document.querySelector("#modal-actions");
const searchInput = document.querySelector("#search-input");
const statPositions = document.querySelector("#stat-positions");

function labelFor(element) {
  return element?.closest("label") ?? null;
}

const typeLabel = labelFor(fieldType);
const nameLabel = labelFor(fieldName);
const titleLabel = labelFor(fieldTitle);
const parentLabel = labelFor(fieldParent);
const notesLabel = labelFor(fieldNotes);

function setLabelText(label, text) {
  const span = label?.querySelector(":scope > span");
  if (span) span.textContent = text;
}

function hideLegacyTypeOptions(select) {
  if (!select) return;
  for (const option of select.options) {
    if (option.value === "company" || option.value === "position") {
      option.hidden = true;
    }
  }
}

function filterParentOptions(type) {
  if (!fieldParent) return;
  for (const option of fieldParent.options) {
    if (!option.value) {
      option.hidden = type === "person";
      continue;
    }

    const text = option.textContent?.trim() ?? "";
    const isDepartment = text.startsWith("部门 ·");
    const isPerson = text.startsWith("人员 ·");
    const isCompany = text.startsWith("公司 ·");
    const isCurrent = option.value === fieldParent.value;

    if (type === "person" || type === "department") {
      option.hidden = !(isDepartment || isPerson || isCompany || isCurrent);
    } else {
      option.hidden = false;
    }
  }
}

function syncInspector() {
  if (!fieldType) return;
  hideLegacyTypeOptions(fieldType);
  const type = fieldType.value;

  typeLabel?.classList.toggle("field-hidden", type === "company");

  if (type === "department") {
    setLabelText(nameLabel, "部门名称");
    setLabelText(parentLabel, "上级（公司 / 部门 / 人员）");
    titleLabel?.classList.add("field-hidden");
    notesLabel?.classList.add("field-hidden");
    if (addChildButton) {
      addChildButton.classList.remove("field-hidden");
      addChildButton.textContent = "＋ 添加下级部门 / 人员";
    }
  } else if (type === "person") {
    setLabelText(nameLabel, "人员姓名");
    setLabelText(titleLabel, "岗位");
    setLabelText(parentLabel, "上级（部门 / 人员）");
    setLabelText(notesLabel, "备注");
    titleLabel?.classList.remove("field-hidden");
    notesLabel?.classList.remove("field-hidden");
    if (addChildButton) {
      addChildButton.classList.remove("field-hidden");
      addChildButton.textContent = "＋ 添加下级部门 / 人员";
    }
  } else if (type === "company") {
    setLabelText(nameLabel, "公司名称");
    titleLabel?.classList.add("field-hidden");
    parentLabel?.classList.add("field-hidden");
    notesLabel?.classList.add("field-hidden");
    if (addChildButton) {
      addChildButton.classList.remove("field-hidden");
      addChildButton.textContent = "＋ 添加部门 / 人员";
    }
  } else {
    // 兼容已有“岗位”旧节点：允许用户在类型下拉中直接改成部门或人员。
    setLabelText(nameLabel, "名称");
    setLabelText(titleLabel, "岗位");
    setLabelText(parentLabel, "上级节点");
    titleLabel?.classList.remove("field-hidden");
    notesLabel?.classList.remove("field-hidden");
    if (addChildButton) {
      addChildButton.classList.remove("field-hidden");
      addChildButton.textContent = "＋ 添加下级部门 / 人员";
    }
  }

  if (type !== "company") parentLabel?.classList.remove("field-hidden");
  filterParentOptions(type);
}

function configureCreateModal() {
  const form = modalContent?.querySelector("form");
  if (!form) return;
  const select = form.querySelector("select");
  if (!select) return;

  hideLegacyTypeOptions(select);
  if (select.value === "position" || select.value === "company") select.value = "person";

  const labels = [...form.querySelectorAll(":scope > label")];
  const nameInput = labels[1]?.querySelector("input") ?? null;
  const titleInput = labels[2]?.querySelector("input") ?? null;
  const nameFieldLabel = nameInput?.closest("label") ?? null;
  const titleFieldLabel = titleInput?.closest("label") ?? null;

  let notesFieldLabel = form.querySelector("label[data-simple-notes]");
  let notesTextarea = notesFieldLabel?.querySelector("textarea") ?? null;
  if (!notesFieldLabel) {
    notesFieldLabel = document.createElement("label");
    notesFieldLabel.dataset.simpleNotes = "true";
    const span = document.createElement("span");
    span.textContent = "备注（可选）";
    notesTextarea = document.createElement("textarea");
    notesTextarea.rows = 4;
    notesTextarea.maxLength = 1000;
    notesTextarea.placeholder = "职责范围、联系方式或补充说明";
    notesFieldLabel.append(span, notesTextarea);
    form.append(notesFieldLabel);
  }

  const apply = () => {
    const type = select.value;
    if (type === "department") {
      setLabelText(nameFieldLabel, "部门名称");
      titleFieldLabel?.classList.add("field-hidden");
      notesFieldLabel?.classList.add("field-hidden");
      if (titleInput) titleInput.value = "";
      if (notesTextarea) notesTextarea.value = "";
    } else {
      select.value = "person";
      setLabelText(nameFieldLabel, "人员姓名");
      setLabelText(titleFieldLabel, "岗位");
      titleFieldLabel?.classList.remove("field-hidden");
      notesFieldLabel?.classList.remove("field-hidden");
    }
  };

  select.addEventListener("change", apply);
  apply();

  const createButton = [...(modalActions?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("创建节点"));
  if (createButton && !createButton.dataset.simpleNotesBound) {
    createButton.dataset.simpleNotesBound = "true";
    createButton.addEventListener(
      "click",
      () => {
        const expectedName = nameInput?.value.trim() ?? "";
        const note = notesTextarea?.value.trim() ?? "";
        if (!expectedName || select.value !== "person" || !note) return;
        window.setTimeout(() => {
          if (fieldType?.value === "person" && fieldName?.value.trim() === expectedName && fieldNotes) {
            fieldNotes.value = note;
            fieldNotes.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }, 120);
      },
      true,
    );
  }
}

hideLegacyTypeOptions(fieldType);
fieldType?.addEventListener("change", () => window.setTimeout(syncInspector, 0));
fieldParent && new MutationObserver(() => syncInspector()).observe(fieldParent, { childList: true });
inspectorTitle && new MutationObserver(() => syncInspector()).observe(inspectorTitle, { childList: true, characterData: true, subtree: true });
modalContent && new MutationObserver(() => window.setTimeout(configureCreateModal, 0)).observe(modalContent, { childList: true, subtree: true });
modalActions && new MutationObserver(() => window.setTimeout(configureCreateModal, 0)).observe(modalActions, { childList: true, subtree: true });

document.addEventListener("click", (event) => {
  if (event.target.closest(".node-card")) window.setTimeout(syncInspector, 0);
});

if (searchInput) searchInput.placeholder = "搜索部门、人员或岗位";
statPositions?.closest(".stat-card")?.remove();
for (const item of document.querySelectorAll(".legend-list li")) {
  if (item.querySelector(".swatch-company") || item.querySelector(".swatch-position")) item.remove();
}

syncInspector();
