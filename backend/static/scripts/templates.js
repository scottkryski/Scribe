// static/scripts/templates.js
import * as api from "./api.js";
import { showToastNotification } from "./ui.js";

let templates = [];
let activeTemplateName = null;
let currentTemplateData = null;
let onTemplateChangeCallback = null;

const templateSelector = document.getElementById("template-selector");
const templateBuilderContainer = document.getElementById(
  "template-builder-container"
);
const newTemplateBtn = document.getElementById("new-template-btn");
const deleteTemplateBtn = document.getElementById("delete-template-btn");
const saveTemplateBtn = document.getElementById("save-template-btn");
const addFieldBtn = document.getElementById("add-field-btn");
const openTemplatesFolderBtn = document.getElementById(
  "open-templates-folder-btn"
);
const uploadTemplateBtn = document.getElementById("upload-template-btn");
const templateFileInput = document.getElementById("template-file-input");
const refreshTemplatesBtn = document.getElementById("refresh-templates-btn");

export async function initTemplateManager(callback) {
  onTemplateChangeCallback = callback;
  await loadTemplates();
  setupEventListeners();
}

function setupEventListeners() {
  templateSelector.addEventListener("change", async () => {
    const newTemplateName = templateSelector.value;
    if (newTemplateName) {
      localStorage.setItem("activeTemplate", newTemplateName);
      activeTemplateName = newTemplateName;
      await loadTemplateForEditing(newTemplateName);
      if (onTemplateChangeCallback) {
        onTemplateChangeCallback(currentTemplateData);
      }
    }
  });

  newTemplateBtn.addEventListener("click", createNewTemplate);
  deleteTemplateBtn.addEventListener("click", deleteSelectedTemplate);
  saveTemplateBtn.addEventListener("click", saveCurrentTemplate);

  addFieldBtn.addEventListener("click", () => {
    const newIndex =
      templateBuilderContainer.querySelectorAll(".field-editor").length;
    const newFieldElement = renderFieldEditor(null, newIndex);
    templateBuilderContainer.appendChild(newFieldElement);
  });

  openTemplatesFolderBtn.addEventListener("click", api.openTemplatesFolder);

  uploadTemplateBtn.addEventListener("click", () => {
    templateFileInput.click();
  });

  templateFileInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      await api.uploadTemplate(file);
      showToastNotification(
        `Template '${file.name}' uploaded successfully.`,
        "success"
      );
      await loadTemplates();
      templateSelector.value = file.name;
      templateSelector.dispatchEvent(new Event("change"));
    } catch (error) {
      showToastNotification(`Upload failed: ${error.message}`, "error");
    } finally {
      templateFileInput.value = "";
    }
  });

  refreshTemplatesBtn.addEventListener("click", async () => {
    showToastNotification("Refreshing template list...", "info");
    await loadTemplates();
    templateSelector.dispatchEvent(new Event("change"));
  });
}

async function loadTemplates() {
  try {
    templates = await api.getTemplates();
    templateSelector.innerHTML = "";
    if (templates.length === 0) {
      templateSelector.innerHTML =
        '<option value="">No templates found</option>';
      return;
    }

    templates.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name.replace(".json", "");
      templateSelector.appendChild(option);
    });

    activeTemplateName = localStorage.getItem("activeTemplate") || templates[0];
    if (templates.includes(activeTemplateName)) {
      templateSelector.value = activeTemplateName;
    } else {
      activeTemplateName = templates[0];
      localStorage.setItem("activeTemplate", activeTemplateName);
    }
    await loadTemplateForEditing(activeTemplateName);
  } catch (error) {
    showToastNotification("Error loading templates: " + error.message, "error");
  }
}

async function loadTemplateForEditing(templateName) {
  try {
    currentTemplateData = await api.getTemplate(templateName);
    renderTemplateEditor();
  } catch (error) {
    showToastNotification(
      `Error loading template '${templateName}': ${error.message}`,
      "error"
    );
  }
}

function renderTemplateEditor() {
  templateBuilderContainer.innerHTML = "";
  if (!currentTemplateData || !currentTemplateData.fields) return;

  currentTemplateData.fields.forEach((field, index) => {
    const fieldElement = renderFieldEditor(field, index);
    templateBuilderContainer.appendChild(fieldElement);
  });
}

function renderFieldEditor(field, index) {
  const fieldData = field || {
    id: `new_field_${Date.now()}`,
    label: "",
    type: "boolean",
    description: "",
    keywords: [],
    options: [],
    ai_summary_field: "context",
  };

  const fieldWrapper = document.createElement("div");
  fieldWrapper.className = "glass-effect rounded-xl p-4 space-y-3 field-editor";
  fieldWrapper.dataset.index = index;

  const optionsHTML =
    fieldData.type === "select"
      ? `
        <div class="field-options-container md:col-span-2">
            <label class="text-sm font-medium">Options (one per line)</label>
            <textarea class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-options-textarea" rows="3">${fieldData.options.join(
              "\n"
            )}</textarea>
        </div>
    `
      : "";

  fieldWrapper.innerHTML = `
        <div class="flex justify-between items-center">
            <span class="font-bold text-lg">Field #${index + 1}</span>
            <div>
                <button type="button" class="move-field-up-btn p-1 rounded-full glass-hover" title="Move Up">▲</button>
                <button type="button" class="move-field-down-btn p-1 rounded-full glass-hover" title="Move Down">▼</button>
                <button type="button" class="delete-field-btn p-1 rounded-full glass-hover text-red-400" title="Delete Field">✖</button>
            </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
                <label class="text-sm font-medium">Label</label>
                <input type="text" value="${
                  fieldData.label
                }" class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-label-input" placeholder="e.g., Is Experimental?">
            </div>
            <div>
                <label class="text-sm font-medium">ID</label>
                <input type="text" value="${
                  fieldData.id
                }" class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-id-input" placeholder="e.g., trigger_experimental">
            </div>
            <div>
                <label class="text-sm font-medium">Type</label>
                <select class="custom-select w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-type-selector">
                    <option value="boolean" ${
                      fieldData.type === "boolean" ? "selected" : ""
                    }>Boolean (Toggle)</option>
                    <option value="select" ${
                      fieldData.type === "select" ? "selected" : ""
                    }>Select (Dropdown)</option>
                </select>
            </div>
            ${optionsHTML}
            <div>
                <label class="text-sm font-medium">AI Summary Field</label>
                <select class="custom-select w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-ai-summary-selector">
                    <option value="context" ${
                      (fieldData.ai_summary_field || "context") === "context"
                        ? "selected"
                        : ""
                    }>Context (Direct Quote)</option>
                    <option value="reasoning" ${
                      fieldData.ai_summary_field === "reasoning"
                        ? "selected"
                        : ""
                    }>Reasoning (Explanation)</option>
                </select>
            </div>
            <div class="md:col-span-2">
                <label class="text-sm font-medium">Keywords (comma-separated)</label>
                <textarea class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-keywords-textarea" rows="2" placeholder="e.g., experiment, rct, control group">${fieldData.keywords.join(
                  ", "
                )}</textarea>
            </div>
            <div class="md:col-span-2">
                <label class="text-sm font-medium">AI Prompt Description</label>
                <textarea class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-description-textarea" rows="3" placeholder="Instructions for the AI on how to classify this field.">${
                  fieldData.description
                }</textarea>
            </div>
        </div>
    `;

  fieldWrapper
    .querySelector(".delete-field-btn")
    .addEventListener("click", () => fieldWrapper.remove());

  fieldWrapper
    .querySelector(".field-type-selector")
    .addEventListener("change", (e) => {
      const parent = e.target.closest(".field-editor");
      // Get the current index dynamically to pass to the re-render
      const currentIndex = Array.from(parent.parentNode.children).indexOf(
        parent
      );
      const updatedFieldData = readFieldDataFromDOM(parent);
      updatedFieldData.type = e.target.value;
      const newEditor = renderFieldEditor(updatedFieldData, currentIndex);
      parent.replaceWith(newEditor);
    });

  fieldWrapper
    .querySelector(".move-field-up-btn")
    .addEventListener("click", () => {
      if (fieldWrapper.previousElementSibling) {
        fieldWrapper.parentNode.insertBefore(
          fieldWrapper,
          fieldWrapper.previousElementSibling
        );
      }
    });
  fieldWrapper
    .querySelector(".move-field-down-btn")
    .addEventListener("click", () => {
      if (fieldWrapper.nextElementSibling) {
        fieldWrapper.parentNode.insertBefore(
          fieldWrapper.nextElementSibling,
          fieldWrapper
        );
      }
    });

  return fieldWrapper;
}

function readFieldDataFromDOM(fieldEditorDiv) {
  const getVal = (selector) =>
    fieldEditorDiv.querySelector(selector)?.value.trim() || "";
  const getArr = (selector, separator) =>
    getVal(selector)
      .split(separator)
      .map((s) => s.trim())
      .filter(Boolean);

  const type = getVal(".field-type-selector");
  const fieldData = {
    label: getVal(".field-label-input"),
    id: getVal(".field-id-input"),
    type: type,
    description: getVal(".field-description-textarea"),
    keywords: getArr(".field-keywords-textarea", ","),
    options: type === "select" ? getArr(".field-options-textarea", "\n") : [],
    ai_summary_field: getVal(".field-ai-summary-selector") || "context",
  };
  return fieldData;
}

async function saveCurrentTemplate() {
  const newFields = [];
  document.querySelectorAll(".field-editor").forEach((editor) => {
    newFields.push(readFieldDataFromDOM(editor));
  });

  const updatedTemplate = {
    name: currentTemplateData.name,
    description: currentTemplateData.description,
    fields: newFields,
  };

  try {
    await api.saveTemplate(activeTemplateName, updatedTemplate);
    showToastNotification("Template saved successfully!", "success");
    currentTemplateData = updatedTemplate; // Update local state

    if (onTemplateChangeCallback) {
      onTemplateChangeCallback(currentTemplateData);
    }
  } catch (error) {
    showToastNotification("Error saving template: " + error.message, "error");
  }
}

async function createNewTemplate() {
  const name = prompt("Enter a name for the new template (e.g., 'project-x'):");
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    alert("Invalid name. Use only letters, numbers, underscores, and hyphens.");
    return;
  }
  const filename = `${name}.json`;

  if (templates.includes(filename)) {
    alert("A template with this name already exists.");
    return;
  }

  const newTemplate = {
    name: name,
    description: "A new annotation template.",
    fields: [],
  };

  try {
    await api.saveTemplate(filename, newTemplate);
    showToastNotification("New template created.", "success");
    await loadTemplates(); // Refresh the list
    templateSelector.value = filename;
    templateSelector.dispatchEvent(new Event("change"));
  } catch (error) {
    showToastNotification(
      "Error creating new template: " + error.message,
      "error"
    );
  }
}

async function deleteSelectedTemplate() {
  if (templates.length <= 1) {
    alert("Cannot delete the last template.");
    return;
  }
  if (
    !confirm(
      `Are you sure you want to delete the template '${activeTemplateName}'? This cannot be undone.`
    )
  ) {
    return;
  }

  try {
    await api.deleteTemplate(activeTemplateName);
    showToastNotification("Template deleted.", "success");
    localStorage.removeItem("activeTemplate");
    await loadTemplates(); // Refresh list and load the new default
    templateSelector.dispatchEvent(new Event("change"));
  } catch (error) {
    showToastNotification("Error deleting template: " + error.message, "error");
  }
}

export function getActiveTemplate() {
  return currentTemplateData;
}
