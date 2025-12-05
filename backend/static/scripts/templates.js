// static/scripts/templates.js
import * as api from "./api.js";
import { showToastNotification, setButtonLoading } from "./ui.js";

let templates = [];
let activeTemplateName = null;
let currentTemplateData = null;
let onTemplateChangeCallback = null;
let state = {};

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(
    /[&<>"']/g,
    (match) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[match] || match)
  );
}

function slugify(value) {
  if (!value) return "";
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

const DEFAULT_CHECKLIST_CHOICES = [
  { value: "yes", label: "YES" },
  { value: "no", label: "NO" },
  { value: "na", label: "N/A" },
];

function normalizeChecklistChoices(rawChoices) {
  if (!Array.isArray(rawChoices)) {
    return DEFAULT_CHECKLIST_CHOICES.map((choice) => ({ ...choice }));
  }

  const seen = new Set();
  const normalized = rawChoices
    .map((choice) => ({
      value: String(choice.value || "").trim(),
      label: String(choice.label || "").trim(),
    }))
    .filter((choice) => {
      if (!choice.value) return false;
      const key = choice.value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((choice) => ({
      value: choice.value,
      label: choice.label || choice.value,
    }));

  return normalized.length > 0
    ? normalized
    : DEFAULT_CHECKLIST_CHOICES.map((choice) => ({ ...choice }));
}

function normalizeChecklistScoring(scoring) {
  if (!scoring || typeof scoring !== "object") return null;
  const mode = String(scoring.mode || "sum").trim() || "sum";
  const naLabel = scoring.naLabel ? String(scoring.naLabel).trim() : "N/A";
  let naValues = [];
  if (Array.isArray(scoring.naValues)) {
    naValues = scoring.naValues
      .map((v) => String(v || "").trim())
      .filter(Boolean);
  } else if (typeof scoring.naValues === "string") {
    naValues = scoring.naValues
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (naValues.length === 0) {
    naValues = ["na"];
  }
  const buckets = Array.isArray(scoring.buckets)
    ? scoring.buckets
        .map((bucket) => ({
          label: bucket?.label ? String(bucket.label).trim() : "",
          min:
            bucket?.min === 0 || Number.isFinite(Number(bucket?.min))
              ? Number(bucket.min)
              : null,
          max:
            bucket?.max === 0 || Number.isFinite(Number(bucket?.max))
              ? Number(bucket.max)
              : null,
        }))
        .filter(
          (bucket) =>
            bucket.label && (bucket.min !== null || bucket.max !== null)
        )
    : [];
  const downgradeRules = Array.isArray(scoring.downgradeRules)
    ? scoring.downgradeRules
        .map((rule) => ({
          itemId: rule?.itemId
            ? String(rule.itemId).trim()
            : rule?.item_id
            ? String(rule.item_id).trim()
            : "",
          matchValues: Array.isArray(rule?.matchValues)
            ? rule.matchValues
                .map((v) => String(v || "").trim())
                .filter(Boolean)
            : [],
          targetLabel: rule?.targetLabel
            ? String(rule.targetLabel).trim()
            : rule?.target_label
            ? String(rule.target_label).trim()
            : "",
        }))
        .filter(
          (rule) =>
            rule.itemId && rule.targetLabel && rule.matchValues.length > 0
        )
    : [];
  if (buckets.length === 0 && downgradeRules.length === 0) return null;
  return {
    mode,
    naLabel: naLabel || "N/A",
    naValues,
    buckets,
    downgradeRules,
  };
}

const templateSelector = document.getElementById("template-selector");
const templateBuilderContainer = document.getElementById(
  "template-builder-container"
);
const newTemplateBtn = document.getElementById("new-template-btn");
const deleteTemplateBtn = document.getElementById("delete-template-btn");
const saveTemplateBtn = document.getElementById("save-template-btn");
const saveToSheetBtn = document.getElementById("save-template-to-sheet-btn");
const addFieldBtn = document.getElementById("add-field-btn");
const openTemplatesFolderBtn = document.getElementById(
  "open-templates-folder-btn"
);
const uploadTemplateBtn = document.getElementById("upload-template-btn");
const templateFileInput = document.getElementById("template-file-input");
const refreshTemplatesBtn = document.getElementById("refresh-templates-btn");

const sheetTemplateStatus = document.getElementById("sheet-template-status");

function loadSheetTemplateIntoEditor(templateData) {
  if (!templateData) return;
  currentTemplateData = templateData;
  activeTemplateName = "sheet-template"; // Use a placeholder name
  renderTemplateEditor();
}

export async function initTemplateManager(callback, _state) {
  onTemplateChangeCallback = callback;
  state = _state;
  await loadTemplates();
  setupEventListeners();

  document.addEventListener("sheetTemplateActive", (e) => {
    const { active, hasTemplate } = e.detail;

    saveToSheetBtn.classList.toggle("hidden", !active);
    templateBuilderContainer.classList.remove("disabled-ui");
    addFieldBtn.disabled = false;

    if (hasTemplate) {
      sheetTemplateStatus.innerHTML = `<p class="text-blue-200">The annotation template is currently being managed by the connected Google Sheet.</p>`;
      sheetTemplateStatus.classList.remove("hidden");
      saveTemplateBtn.textContent = "Save as Local Copy";
      templateSelector.disabled = true;
      newTemplateBtn.disabled = true;
      deleteTemplateBtn.disabled = true;
    } else if (active) {
      sheetTemplateStatus.innerHTML = `<p class="text-yellow-200">No template found on this sheet. You can save your active local template to the sheet to get started.</p>`;
      sheetTemplateStatus.classList.remove("hidden");
      saveTemplateBtn.textContent = "Save Template";
      templateSelector.disabled = false;
      newTemplateBtn.disabled = false;
      deleteTemplateBtn.disabled = false;
    } else {
      sheetTemplateStatus.classList.add("hidden");
      saveTemplateBtn.textContent = "Save Template";
      templateSelector.disabled = false;
      newTemplateBtn.disabled = false;
      deleteTemplateBtn.disabled = false;
    }
  });

  document.addEventListener("loadSheetTemplate", (e) => {
    loadSheetTemplateIntoEditor(e.detail);
  });
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
  saveTemplateBtn.addEventListener("click", saveCurrentLocalTemplate);
  saveToSheetBtn.addEventListener("click", saveCurrentTemplateToSheet);

  addFieldBtn.addEventListener("click", () => {
    const newIndex =
      templateBuilderContainer.querySelectorAll(".field-editor").length;
    const allFields = readAllFieldsFromDOM();
    const newFieldElement = renderFieldEditor(null, newIndex, allFields);
    templateBuilderContainer.appendChild(newFieldElement);
  });

  openTemplatesFolderBtn.addEventListener("click", api.openTemplatesFolder);
  uploadTemplateBtn.addEventListener("click", () => templateFileInput.click());
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
  });
}

async function loadTemplates() {
  const isSheetTemplateActive = templateSelector.disabled;

  try {
    templates = await api.getTemplates();
    const currentLocalSelection = templateSelector.value;
    templateSelector.innerHTML = "";

    if (templates.length === 0) {
      templateSelector.innerHTML =
        '<option value="">No local templates</option>';
      if (!isSheetTemplateActive) {
        currentTemplateData = {
          name: "new-template",
          description: "A new annotation template.",
          fields: [],
        };
        if (onTemplateChangeCallback)
          onTemplateChangeCallback(currentTemplateData);
        renderTemplateEditor();
      }
      return;
    }

    templates.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name.replace(".json", "");
      templateSelector.appendChild(option);
    });

    if (isSheetTemplateActive) {
      if (templates.includes(currentLocalSelection)) {
        templateSelector.value = currentLocalSelection;
      }
      return; // Exit early to prevent overriding the editor
    }

    let templateToSelect =
      localStorage.getItem("activeTemplate") || templates[0];
    if (!templates.includes(templateToSelect)) {
      templateToSelect = templates[0];
      localStorage.setItem("activeTemplate", templateToSelect);
    }

    if (templateSelector.value !== templateToSelect) {
      templateSelector.value = templateToSelect;
      templateSelector.dispatchEvent(new Event("change"));
    } else {
      await loadTemplateForEditing(templateToSelect);
    }
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
  const allFields = currentTemplateData.fields;
  allFields.forEach((field, index) => {
    const fieldElement = renderFieldEditor(field, index, allFields);
    templateBuilderContainer.appendChild(fieldElement);
  });
}

function renderSingleRuleEditor(rule, allFields, triggerFieldId) {
  const ruleData = rule || { triggerValue: "", targetId: "", targetValue: "" };
  const targetOptionsHTML = allFields
    .filter((f) => f.id !== triggerFieldId)
    .map(
      (f) =>
        `<option value="${f.id}" ${
          ruleData.targetId === f.id ? "selected" : ""
        }>${f.label || f.id}</option>`
    )
    .join("");
  const ruleWrapper = document.createElement("div");
  ruleWrapper.className =
    "autofill-rule-editor grid grid-cols-1 md:grid-cols-4 gap-2 items-end bg-black bg-opacity-20 p-2 rounded-lg";
  ruleWrapper.innerHTML = `
        <div class="md:col-span-1"><label class="text-xs font-medium">When value is...</label><input type="text" value="${ruleData.triggerValue}" class="w-full p-1 bg-white bg-opacity-10 rounded text-white text-xs rule-trigger-value" placeholder="e.g., true or Review"></div>
        <div class="md:col-span-1"><label class="text-xs font-medium">...then set field...</label><select class="custom-select w-full p-1 bg-white bg-opacity-10 rounded text-white text-xs rule-target-id"><option value="">-- Select Target --</option>${targetOptionsHTML}</select></div>
        <div class="md:col-span-1"><label class="text-xs font-medium">...to value...</label><input type="text" value="${ruleData.targetValue}" class="w-full p-1 bg-white bg-opacity-10 rounded text-white text-xs rule-target-value" placeholder="e.g., false or Irrelevant"></div>
        <button type="button" class="delete-rule-btn p-1 rounded glass-hover text-red-400 self-center justify-self-end">Delete Rule</button>`;
  ruleWrapper
    .querySelector(".delete-rule-btn")
    .addEventListener("click", () => ruleWrapper.remove());
  return ruleWrapper;
}

function renderFieldEditor(field, index, allFields) {
  const fieldData = field || {
    id: `new_field_${Date.now()}`,
    label: "",
    type: "boolean",
    helperText: "",
    description: "",
    keywords: [],
    options: [],
    checklistItems: [],
    checklistChoices: DEFAULT_CHECKLIST_CHOICES.map((choice) => ({
      ...choice,
    })),
    checklistScoring: null,
    ai_summary_field: "context",
    autoFillRules: [],
  };
  const fieldWrapper = document.createElement("div");
  fieldWrapper.className = "glass-effect rounded-xl p-4 space-y-3 field-editor";
  fieldWrapper.dataset.index = index;
  const optionsHTML =
    fieldData.type === "select"
      ? `<div class="field-options-container md:col-span-2"><label class="text-sm font-medium">Options (one per line)</label><textarea class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-options-textarea" rows="3">${fieldData.options.join(
          "\n"
        )}</textarea></div>`
      : "";
  const checklistChoicesHTML =
    fieldData.type === "checklist"
      ? `<div class="field-checklist-container md:col-span-2"><label class="text-sm font-medium">Checklist Choices</label><div class="space-y-2 mt-2 checklist-choices-container"></div><button type="button" class="add-checklist-choice-btn btn-primary text-xs px-3 py-1 mt-2">Add Choice</button><p class="text-xs text-gray-300 mt-1">These choices become the buttons for each checklist item. Values must be unique.</p></div>`
      : "";
  const scoringConfig = normalizeChecklistScoring(fieldData.checklistScoring);
  const scoringEnabled = Boolean(scoringConfig);
  const checklistScoringHTML =
    fieldData.type === "checklist"
      ? `<div class="field-checklist-container md:col-span-2">
            <div class="flex items-center justify-between gap-2">
              <label class="text-sm font-medium">Checklist Scoring (Statistics)</label>
              <label class="flex items-center gap-2 text-xs text-gray-300">
                <input type="checkbox" class="checklist-enable-scoring" ${
                  scoringEnabled ? "checked" : ""
                }>
                <span>Show score buckets on stats</span>
              </label>
            </div>
            <div class="checklist-scoring-block ${
              scoringEnabled ? "" : "hidden"
            } space-y-3 mt-2">
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Mode</label>
                  <select class="custom-select w-full p-2 bg-black bg-opacity-20 rounded text-white text-sm checklist-scoring-mode">
                    <option value="sum" ${
                      (scoringConfig?.mode || "sum") === "sum"
                        ? "selected"
                        : ""
                    }>Sum numeric choices</option>
                  </select>
                </div>
                <div>
                  <label class="text-xs font-medium uppercase tracking-wide text-gray-300">N/A Label</label>
                  <input type="text" value="${escapeHtml(
                    scoringConfig?.naLabel || "N/A"
                  )}" class="w-full p-2 bg-black bg-opacity-20 rounded text-white text-sm checklist-scoring-na-label" placeholder="N/A">
                </div>
                <div>
                  <label class="text-xs font-medium uppercase tracking-wide text-gray-300">N/A Values (comma-separated)</label>
                  <input type="text" value="${escapeHtml(
                    (scoringConfig?.naValues || ["na"]).join(", ")
                  )}" class="w-full p-2 bg-black bg-opacity-20 rounded text-white text-sm checklist-scoring-na-values" placeholder="na, none">
                </div>
              </div>
              <div class="space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs font-semibold text-gray-300 uppercase tracking-wide">Score Ranges</span>
                  <button type="button" class="add-scoring-bucket-btn btn-primary text-xs px-3 py-1">Add Range</button>
                </div>
                <div class="space-y-2 checklist-scoring-buckets"></div>
                <p class="text-xs text-gray-400">Example: 0-3 Poor, 4-6 Weak, 7-10 Strong. Leave max blank for an open-ended top range.</p>
              </div>
              <div class="space-y-2 pt-2 border-t border-white/10">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs font-semibold text-gray-300 uppercase tracking-wide">Auto Downgrade Rules</span>
                  <button type="button" class="add-downgrade-rule-btn btn-primary text-xs px-3 py-1">Add Rule</button>
                </div>
                <div class="space-y-2 checklist-downgrade-rules"></div>
                <p class="text-xs text-gray-400">If an item matches, override the bucket to the target label (e.g., force Poor when multiplicity is NO).</p>
              </div>
            </div>
          </div>`
      : "";
  fieldWrapper.innerHTML = `
        <div class="flex justify-between items-center"><span class="font-bold text-lg">Field #${
          index + 1
        }</span><div><button type="button" class="move-field-up-btn p-1 rounded-full glass-hover" title="Move Up">▲</button><button type="button" class="move-field-down-btn p-1 rounded-full glass-hover" title="Move Down">▼</button><button type="button" class="delete-field-btn p-1 rounded-full glass-hover text-red-400" title="Delete Field">✖</button></div></div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label class="text-sm font-medium">Label</label><input type="text" value="${
              fieldData.label
            }" class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-label-input" placeholder="e.g., Is Experimental?"></div>
            <div><label class="text-sm font-medium">ID</label><input type="text" value="${
              fieldData.id
            }" class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-id-input" placeholder="e.g., trigger_experimental"></div>
            <div><label class="text-sm font-medium">Type</label><select class="custom-select w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-type-selector"><option value="boolean" ${
              fieldData.type === "boolean" ? "selected" : ""
            }>Boolean (Toggle)</option><option value="select" ${
    fieldData.type === "select" ? "selected" : ""
  }>Select (Dropdown)</option><option value="checklist" ${
    fieldData.type === "checklist" ? "selected" : ""
  }>Checklist</option></select></div>
            ${optionsHTML}
            ${
              fieldData.type === "checklist"
                ? `${checklistChoicesHTML}<div class="field-checklist-container md:col-span-2"><label class="text-sm font-medium">Checklist Items</label><div class="space-y-3 mt-2 checklist-items-container"></div><button type="button" class="add-checklist-item-btn btn-primary text-xs px-3 py-1 mt-2">Add Checklist Item</button></div>`
                : ""
            }
            ${checklistScoringHTML}
            <div><label class="text-sm font-medium">AI Summary Field</label><select class="custom-select w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-ai-summary-selector"><option value="context" ${
              (fieldData.ai_summary_field || "context") === "context"
                ? "selected"
                : ""
            }>Context (Direct Quote)</option><option value="reasoning" ${
    fieldData.ai_summary_field === "reasoning" ? "selected" : ""
  }>Reasoning (Explanation)</option></select></div>
            <div class="md:col-span-2"><label class="text-sm font-medium">Keywords (comma-separated)</label><textarea class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-keywords-textarea" rows="2" placeholder="e.g., experiment, rct, control group">${fieldData.keywords.join(
              ", "
            )}</textarea></div>
            <div class="md:col-span-2"><label class="text-sm font-medium">Helper Text (optional)</label><textarea class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-helper-text-textarea" rows="3" placeholder="Shown to annotators under the field label.">${escapeHtml(
              fieldData.helperText || ""
            )}</textarea></div>
            <div class="md:col-span-2"><label class="text-sm font-medium">AI Prompt Description</label><textarea class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white text-sm field-description-textarea" rows="3" placeholder="Instructions for the AI on how to classify this field.">${
              fieldData.description
            }</textarea></div>
        </div>
        <div class="pt-3 mt-3 border-t border-white/10"><h4 class="text-md font-semibold mb-2">Automatic Fill-in Rules</h4><div class="autofill-rules-container space-y-2"></div><button type="button" class="add-autofill-rule-btn btn-primary text-sm px-3 py-1 mt-2">Add Rule</button></div>`;
  const rulesContainer = fieldWrapper.querySelector(
    ".autofill-rules-container"
  );
  if (fieldData.autoFillRules) {
    fieldData.autoFillRules.forEach((rule) => {
      const ruleEditor = renderSingleRuleEditor(rule, allFields, fieldData.id);
      rulesContainer.appendChild(ruleEditor);
    });
  }
  fieldWrapper
    .querySelector(".add-autofill-rule-btn")
    .addEventListener("click", (e) => {
      const allCurrentFields = readAllFieldsFromDOM();
      const triggerId = fieldWrapper.querySelector(".field-id-input").value;
      const newRuleEditor = renderSingleRuleEditor(
        null,
        allCurrentFields,
        triggerId
      );
      e.target.previousElementSibling.appendChild(newRuleEditor);
    });
  fieldWrapper
    .querySelector(".delete-field-btn")
    .addEventListener("click", () => fieldWrapper.remove());
  if (fieldData.type === "checklist") {
    const normalizedChoices = normalizeChecklistChoices(
      fieldData.checklistChoices
    );
    const choicesContainer = fieldWrapper.querySelector(
      ".checklist-choices-container"
    );
    normalizedChoices.forEach((choice) => {
      const choiceEditor = renderChecklistChoiceEditor(choice);
      choicesContainer.appendChild(choiceEditor);
    });
    fieldWrapper
      .querySelector(".add-checklist-choice-btn")
      .addEventListener("click", () => {
        choicesContainer.appendChild(
          renderChecklistChoiceEditor({ label: "", value: "" })
        );
      });

    const checklistContainer = fieldWrapper.querySelector(
      ".checklist-items-container"
    );
    const itemsToRender =
      fieldData.checklistItems && fieldData.checklistItems.length > 0
        ? fieldData.checklistItems
        : [{ id: "", label: "", description: "", choices: [] }];
    itemsToRender.forEach((item) => {
      const itemEditor = renderChecklistItemEditor(item);
      checklistContainer.appendChild(itemEditor);
    });
    fieldWrapper
      .querySelector(".add-checklist-item-btn")
      .addEventListener("click", () => {
        const newItemEditor = renderChecklistItemEditor({
          id: "",
          label: "",
          description: "",
        });
        checklistContainer.appendChild(newItemEditor);
      });

    const scoringBucketsContainer = fieldWrapper.querySelector(
      ".checklist-scoring-buckets"
    );
    const downgradeRulesContainer = fieldWrapper.querySelector(
      ".checklist-downgrade-rules"
    );
    const scoringToggle = fieldWrapper.querySelector(
      ".checklist-enable-scoring"
    );
    const scoringBlock = fieldWrapper.querySelector(
      ".checklist-scoring-block"
    );
    const addBucketBtn = fieldWrapper.querySelector(
      ".add-scoring-bucket-btn"
    );
    const addDowngradeRuleBtn = fieldWrapper.querySelector(
      ".add-downgrade-rule-btn"
    );
    const bucketsToRender =
      scoringConfig?.buckets && scoringConfig.buckets.length > 0
        ? scoringConfig.buckets
        : [];
    if (scoringBucketsContainer) {
      bucketsToRender.forEach((bucket) => {
        scoringBucketsContainer.appendChild(
          renderChecklistScoringBucketEditor(bucket)
        );
      });
    }
    addBucketBtn?.addEventListener("click", () => {
      scoringBucketsContainer?.appendChild(
        renderChecklistScoringBucketEditor({ label: "", min: "", max: "" })
      );
    });
    const rulesToRender =
      scoringConfig?.downgradeRules && scoringConfig.downgradeRules.length > 0
        ? scoringConfig.downgradeRules
        : [];
    if (downgradeRulesContainer) {
      rulesToRender.forEach((rule) => {
        downgradeRulesContainer.appendChild(
          renderChecklistDowngradeRuleEditor(rule)
        );
      });
    }
    addDowngradeRuleBtn?.addEventListener("click", () => {
      downgradeRulesContainer?.appendChild(
        renderChecklistDowngradeRuleEditor({
          itemId: "",
          matchValues: [],
          targetLabel: "",
        })
      );
    });
    scoringToggle?.addEventListener("change", (e) => {
      const enabled = e.target.checked;
      scoringBlock?.classList.toggle("hidden", !enabled);
      if (
        enabled &&
        scoringBucketsContainer &&
        scoringBucketsContainer.children.length === 0
      ) {
        scoringBucketsContainer.appendChild(
          renderChecklistScoringBucketEditor({ label: "", min: "", max: "" })
        );
      }
      if (
        enabled &&
        downgradeRulesContainer &&
        downgradeRulesContainer.children.length === 0
      ) {
        downgradeRulesContainer.appendChild(
          renderChecklistDowngradeRuleEditor({
            itemId: "",
            matchValues: [],
            targetLabel: "",
          })
        );
      }
    });
  }
  fieldWrapper
    .querySelector(".field-type-selector")
    .addEventListener("change", (e) => {
      const parent = e.target.closest(".field-editor");
      const allCurrentFields = readAllFieldsFromDOM();
      const currentIndex = Array.from(parent.parentNode.children).indexOf(
        parent
      );
      const updatedFieldData = readFieldDataFromDOM(parent);
      updatedFieldData.type = e.target.value;
      if (
        updatedFieldData.type === "checklist" &&
        (!updatedFieldData.checklistChoices ||
          updatedFieldData.checklistChoices.length === 0)
      ) {
        updatedFieldData.checklistChoices = DEFAULT_CHECKLIST_CHOICES.map(
          (choice) => ({
            ...choice,
          })
        );
      }
      const newEditor = renderFieldEditor(
        updatedFieldData,
        currentIndex,
        allCurrentFields
      );
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

function readAllFieldsFromDOM() {
  const fields = [];
  document.querySelectorAll(".field-editor").forEach((editor) => {
    fields.push(readFieldDataFromDOM(editor));
  });
  return fields;
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
  const autoFillRules = [];
  fieldEditorDiv
    .querySelectorAll(".autofill-rule-editor")
    .forEach((ruleEditor) => {
      const triggerValue = ruleEditor.querySelector(
        ".rule-trigger-value"
      ).value;
      const targetId = ruleEditor.querySelector(".rule-target-id").value;
      const targetValue = ruleEditor.querySelector(".rule-target-value").value;
      if (triggerValue && targetId && targetValue) {
        autoFillRules.push({ triggerValue, targetId, targetValue });
      }
    });
  let checklistItems = [];
  let checklistChoices = [];
  let checklistScoring = null;
  if (type === "checklist") {
    const parseNumber = (raw) => {
      if (raw === null || raw === undefined) return null;
      const trimmed = String(raw).trim();
      if (trimmed === "") return null;
      const num = Number(trimmed);
      return Number.isFinite(num) ? num : null;
    };
    const usedIds = new Set();
    fieldEditorDiv.querySelectorAll(".checklist-item-editor").forEach((item) => {
      const label =
        item.querySelector(".checklist-item-label")?.value.trim() || "";
      if (!label) return;
      const description =
        item.querySelector(".checklist-item-description")?.value.trim() || "";
      let itemId =
        item.querySelector(".checklist-item-id")?.value.trim() || "";
      if (!itemId) {
        itemId = slugify(label);
      }
      let baseId = itemId || slugify(label) || "item";
      let counter = 1;
      while (!itemId || usedIds.has(itemId)) {
        itemId = counter === 1 ? baseId : `${baseId}_${counter}`;
        counter += 1;
      }
      usedIds.add(itemId);
      const useCustomChoices =
        item.querySelector(".checklist-item-enable-custom")?.checked || false;
      let itemChoices = [];
      if (useCustomChoices) {
        const usedChoiceValues = new Set();
        item
          .querySelectorAll(
            ".checklist-item-choices-container .checklist-choice-editor"
          )
          .forEach((el) => {
            const choiceLabel =
              el.querySelector(".checklist-choice-label")?.value.trim();
            const rawChoiceValue = el
              .querySelector(".checklist-choice-value")
              ?.value.trim();
            const choiceValue = rawChoiceValue || slugify(choiceLabel);
            if (!choiceLabel || !choiceValue) return;
            const normalizedChoiceValue = choiceValue.toLowerCase();
            if (usedChoiceValues.has(normalizedChoiceValue)) return;
            usedChoiceValues.add(normalizedChoiceValue);
            itemChoices.push({ label: choiceLabel, value: choiceValue });
          });
        if (itemChoices.length > 0) {
          itemChoices = normalizeChecklistChoices(itemChoices);
        }
      }
      checklistItems.push({
        id: itemId,
        label,
        description,
        choices: useCustomChoices ? itemChoices : [],
      });
    });

    const usedChoiceValues = new Set();
    fieldEditorDiv
      .querySelectorAll(
        ".checklist-choices-container .checklist-choice-editor"
      )
      .forEach((el) => {
        const label = el.querySelector(".checklist-choice-label")?.value.trim();
        const rawValue =
          el.querySelector(".checklist-choice-value")?.value.trim();
        const value = rawValue || slugify(label);
        if (!label || !value) return;
        const normalizedValue = value.toLowerCase();
        if (usedChoiceValues.has(normalizedValue)) return;
        usedChoiceValues.add(normalizedValue);
        checklistChoices.push({ label, value });
      });

    if (checklistChoices.length === 0) {
      checklistChoices = DEFAULT_CHECKLIST_CHOICES.map((choice) => ({
        ...choice,
      }));
    }

    const scoringEnabled =
      fieldEditorDiv.querySelector(".checklist-enable-scoring")?.checked ||
      false;
    if (scoringEnabled) {
      const mode =
        fieldEditorDiv.querySelector(".checklist-scoring-mode")?.value ||
        "sum";
      const naLabel =
        fieldEditorDiv.querySelector(".checklist-scoring-na-label")?.value ||
        "N/A";
      const naValuesRaw =
        fieldEditorDiv.querySelector(".checklist-scoring-na-values")?.value ||
        "";
      const naValues = naValuesRaw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      const scoringBuckets = [];
      const downgradeRules = [];
      fieldEditorDiv
        .querySelectorAll(".checklist-scoring-bucket")
        .forEach((bucketEl) => {
          const label =
            bucketEl.querySelector(".scoring-bucket-label")?.value.trim() ||
            "";
          if (!label) return;
          const minVal = parseNumber(
            bucketEl.querySelector(".scoring-bucket-min")?.value
          );
          const maxVal = parseNumber(
            bucketEl.querySelector(".scoring-bucket-max")?.value
          );
          if (minVal === null && maxVal === null) return;
          scoringBuckets.push({
            label,
            min: minVal,
            max: maxVal,
          });
        });
      fieldEditorDiv
        .querySelectorAll(".checklist-downgrade-rule")
        .forEach((ruleEl) => {
          const itemId =
            ruleEl.querySelector(".downgrade-item-id")?.value.trim() || "";
          const matchValuesRaw =
            ruleEl.querySelector(".downgrade-values")?.value || "";
          const matchValues = matchValuesRaw
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
          const targetLabel =
            ruleEl.querySelector(".downgrade-target-label")?.value.trim() ||
            "";
          if (!itemId || !targetLabel || matchValues.length === 0) return;
          downgradeRules.push({
            itemId,
            matchValues,
            targetLabel,
          });
        });
      if (scoringBuckets.length > 0 || downgradeRules.length > 0) {
        checklistScoring = {
          mode,
          naLabel: naLabel || "N/A",
          naValues: naValues.length > 0 ? naValues : ["na"],
          buckets: scoringBuckets,
          downgradeRules,
        };
      }
    }
  }
  return {
    label: getVal(".field-label-input"),
    id: getVal(".field-id-input"),
    type: type,
    description: getVal(".field-description-textarea"),
    keywords: getArr(".field-keywords-textarea", ","),
    options: type === "select" ? getArr(".field-options-textarea", "\n") : [],
    helperText: getVal(".field-helper-text-textarea"),
    checklistItems: type === "checklist" ? checklistItems : [],
    checklistChoices: type === "checklist" ? checklistChoices : [],
    checklistScoring: type === "checklist" ? checklistScoring : null,
    ai_summary_field: getVal(".field-ai-summary-selector") || "context",
    autoFillRules: autoFillRules,
  };
}

function renderChecklistChoiceEditor(choice, { extraClasses = "" } = {}) {
  const choiceData = {
    value: choice?.value || "",
    label: choice?.label || "",
  };
  const wrapper = document.createElement("div");
  wrapper.className = `checklist-choice-editor bg-black bg-opacity-20 rounded-lg p-3 space-y-3 ${extraClasses}`.trim();
  wrapper.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
      <div class="md:col-span-3">
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Choice Label</label>
        <input type="text" value="${escapeHtml(
          choiceData.label
        )}" class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm checklist-choice-label" placeholder="e.g., Yes (2)">
      </div>
      <div class="md:col-span-2 md:max-w-xs">
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Saved Value</label>
        <input type="text" value="${escapeHtml(
          choiceData.value
        )}" class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm checklist-choice-value" placeholder="e.g., yes_2">
      </div>
      <div class="md:col-span-1 flex justify-end">
        <button type="button" class="delete-checklist-choice-btn text-xs text-red-300 hover:text-red-200">Remove</button>
      </div>
    </div>`;
  wrapper
    .querySelector(".delete-checklist-choice-btn")
    .addEventListener("click", () => wrapper.remove());
  return wrapper;
}

function renderChecklistScoringBucketEditor(bucket) {
  const bucketData = {
    label: bucket?.label || "",
    min:
      bucket?.min === 0 || bucket?.min === "0" || Number.isFinite(bucket?.min)
        ? bucket.min
        : bucket?.min || "",
    max:
      bucket?.max === 0 || bucket?.max === "0" || Number.isFinite(bucket?.max)
        ? bucket.max
        : bucket?.max || "",
  };
  const wrapper = document.createElement("div");
  wrapper.className =
    "checklist-scoring-bucket bg-black bg-opacity-20 rounded-lg p-3";
  wrapper.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
      <div class="md:col-span-3">
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Label</label>
        <input type="text" value="${escapeHtml(
          bucketData.label
        )}" class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm scoring-bucket-label" placeholder="e.g., Strong">
      </div>
      <div>
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Min</label>
        <input type="number" step="0.1" value="${bucketData.min ?? ""}" class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm scoring-bucket-min" placeholder="0">
      </div>
      <div>
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Max</label>
        <input type="number" step="0.1" value="${bucketData.max ?? ""}" class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm scoring-bucket-max" placeholder="3">
      </div>
      <div class="md:col-span-1 flex justify-end">
        <button type="button" class="delete-scoring-bucket-btn text-xs text-red-300 hover:text-red-200">Remove</button>
      </div>
    </div>`;
  wrapper
    .querySelector(".delete-scoring-bucket-btn")
    .addEventListener("click", () => wrapper.remove());
  return wrapper;
}

function renderChecklistDowngradeRuleEditor(rule) {
  const ruleData = {
    itemId: rule?.itemId || rule?.item_id || "",
    matchValues: Array.isArray(rule?.matchValues)
      ? rule.matchValues.join(", ")
      : "",
    targetLabel: rule?.targetLabel || rule?.target_label || "",
  };
  const wrapper = document.createElement("div");
  wrapper.className =
    "checklist-downgrade-rule bg-black bg-opacity-20 rounded-lg p-3";
  wrapper.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
      <div class="md:col-span-2">
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Item ID</label>
        <input type="text" value="${escapeHtml(
          ruleData.itemId
        )}" class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm downgrade-item-id" placeholder="e.g., multiplicity_handled">
      </div>
      <div class="md:col-span-2">
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Match Values (comma-separated)</label>
        <input type="text" value="${escapeHtml(
          ruleData.matchValues
        )}" class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm downgrade-values" placeholder="e.g., 0, no">
      </div>
      <div class="md:col-span-1">
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Force Label</label>
        <input type="text" value="${escapeHtml(
          ruleData.targetLabel
        )}" class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm downgrade-target-label" placeholder="e.g., Poor">
      </div>
      <div class="md:col-span-1 flex justify-end">
        <button type="button" class="delete-downgrade-rule-btn text-xs text-red-300 hover:text-red-200">Remove</button>
      </div>
    </div>`;
  wrapper
    .querySelector(".delete-downgrade-rule-btn")
    .addEventListener("click", () => wrapper.remove());
  return wrapper;
}

function renderChecklistItemEditor(item) {
  const itemData = {
    id: item?.id || "",
    label: item?.label || "",
    description: item?.description || "",
    choices: Array.isArray(item?.choices) ? item.choices : [],
  };
  const hasCustomChoices =
    Array.isArray(itemData.choices) && itemData.choices.length > 0;
  const normalizedChoices = hasCustomChoices
    ? normalizeChecklistChoices(itemData.choices)
    : [];
  const wrapper = document.createElement("div");
  wrapper.className =
    "checklist-item-editor bg-black bg-opacity-20 rounded-lg p-3 space-y-3";
  wrapper.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-6 gap-3">
      <div class="md:col-span-2">
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Item Label</label>
        <input type="text" value="${escapeHtml(
          itemData.label
        )}" class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm checklist-item-label" placeholder="e.g., A) Test/model choice justified">
      </div>
      <div class="md:col-span-2 md:max-w-xs">
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Item ID</label>
        <input type="text" value="${escapeHtml(
          itemData.id
        )}" class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm checklist-item-id" placeholder="auto-generated">
      </div>
      <div class="md:col-span-6">
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Item Description (optional)</label>
        <textarea class="w-full p-2 bg-black bg-opacity-40 rounded text-white text-sm checklist-item-description" rows="3" placeholder="Guidance shown beneath the item label.">${escapeHtml(
          itemData.description
        )}</textarea>
      </div>
      <div class="md:col-span-6 space-y-2">
        <label class="text-xs font-medium uppercase tracking-wide text-gray-300">Custom Choices (optional)</label>
        <div class="flex items-center gap-2 text-xs text-gray-300">
          <input type="checkbox" class="checklist-item-enable-custom" ${
            hasCustomChoices ? "checked" : ""
          }>
          <span>Use custom choices for this item (otherwise the field defaults apply).</span>
        </div>
        <div class="checklist-item-choices-block ${
          hasCustomChoices ? "" : "hidden"
        } space-y-2 mt-1">
          <div class="space-y-2 checklist-item-choices-container"></div>
          <button type="button" class="add-checklist-item-choice-btn btn-primary text-xs px-3 py-1">Add Choice</button>
          <p class="text-xs text-gray-400">Each choice renders as a button for this item only. Values must be unique.</p>
        </div>
      </div>
    </div>
    <div class="flex justify-end">
      <button type="button" class="delete-checklist-item-btn text-xs text-red-300 hover:text-red-200">Remove Item</button>
    </div>`;
  wrapper
    .querySelector(".delete-checklist-item-btn")
    .addEventListener("click", () => wrapper.remove());

  const choicesBlock = wrapper.querySelector(".checklist-item-choices-block");
  const choicesContainer = wrapper.querySelector(
    ".checklist-item-choices-container"
  );
  if (hasCustomChoices) {
    normalizedChoices.forEach((choice) => {
      const editor = renderChecklistChoiceEditor(choice, {
        extraClasses: "checklist-item-choice-editor",
      });
      choicesContainer.appendChild(editor);
    });
  }
  const addChoiceBtn = wrapper.querySelector(".add-checklist-item-choice-btn");
  addChoiceBtn?.addEventListener("click", () => {
    choicesContainer.appendChild(
      renderChecklistChoiceEditor(
        { label: "", value: "" },
        { extraClasses: "checklist-item-choice-editor" }
      )
    );
  });

  const toggleCustomCheckbox = wrapper.querySelector(
    ".checklist-item-enable-custom"
  );
  toggleCustomCheckbox?.addEventListener("change", (e) => {
    const enabled = e.target.checked;
    choicesBlock.classList.toggle("hidden", !enabled);
    if (!enabled) {
      choicesContainer.innerHTML = "";
    }
  });

  return wrapper;
}

async function saveCurrentLocalTemplate() {
  const newFields = readAllFieldsFromDOM();
  const isSheetTemplateActive = templateSelector.disabled;

  let finalTemplateName;
  let isNewLocalCopy = false;

  if (isSheetTemplateActive) {
    isNewLocalCopy = true;
    const newName = prompt(
      "Enter a new name for this local template copy (e.g., 'my-custom-version'):"
    );
    if (!newName || !/^[a-zA-Z0-9_-]+$/.test(newName)) {
      if (newName !== null)
        alert(
          "Invalid name. Use only letters, numbers, underscores, and hyphens."
        );
      return;
    }
    finalTemplateName = `${newName}.json`;
  } else {
    finalTemplateName = templateSelector.value;
    if (!finalTemplateName) {
      showToastNotification("Cannot save. No template selected.", "error");
      return;
    }
  }

  const updatedTemplate = {
    name: finalTemplateName.replace(".json", ""),
    description: currentTemplateData.description || "Custom template.",
    fields: newFields,
  };

  setButtonLoading(saveTemplateBtn, true, "Saving...");
  try {
    await api.saveTemplate(finalTemplateName, updatedTemplate);
    showToastNotification(
      `Template saved locally as '${finalTemplateName}'!`,
      "success"
    );

    await loadTemplates();

    if (isNewLocalCopy) {
      document.dispatchEvent(
        new CustomEvent("sheetTemplateActive", {
          detail: { active: false, hasTemplate: false },
        })
      );
      templateSelector.value = finalTemplateName;
      templateSelector.dispatchEvent(new Event("change"));
    } else {
      if (onTemplateChangeCallback) {
        onTemplateChangeCallback(updatedTemplate);
      }
      await loadTemplateForEditing(finalTemplateName);
    }
  } catch (error) {
    showToastNotification("Error saving template: " + error.message, "error");
  } finally {
    const buttonText = isSheetTemplateActive
      ? "Save Template"
      : saveTemplateBtn.textContent;
    setButtonLoading(saveTemplateBtn, false, buttonText);
  }
}

async function saveCurrentTemplateToSheet() {
  if (!state.currentSheetId) {
    showToastNotification("No active Google Sheet selected.", "error");
    return;
  }
  const newFields = readAllFieldsFromDOM();
  const updatedTemplate = {
    ...currentTemplateData,
    fields: newFields,
    name: currentTemplateData.name || "sheet-template",
    description:
      currentTemplateData.description || "Template managed by Google Sheet.",
  };
  setButtonLoading(saveToSheetBtn, true, "Saving...");
  try {
    await api.saveTemplateToSheet(state.currentSheetId, updatedTemplate);
    showToastNotification(
      "Template successfully saved to Google Sheet!",
      "success"
    );
    currentTemplateData = updatedTemplate;
    if (onTemplateChangeCallback) {
      onTemplateChangeCallback(currentTemplateData);
    }
    document.dispatchEvent(
      new CustomEvent("sheetTemplateActive", {
        detail: { active: true, hasTemplate: true },
      })
    );
  } catch (error) {
    showToastNotification(`Error: ${error.message}`, "error");
  } finally {
    setButtonLoading(saveToSheetBtn, false, "Save to Sheet");
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
    await loadTemplates();
    templateSelector.value = filename;
    templateSelector.dispatchEvent(new Event("change"));
  } catch (error) {
    showToastNotification(
      `Error creating new template: ${error.message}`,
      "error"
    );
  }
}

async function deleteSelectedTemplate() {
  const selectedTemplate = templateSelector.value;
  if (templates.length <= 1) {
    alert("Cannot delete the last template.");
    return;
  }
  if (
    !confirm(
      `Are you sure you want to delete the template '${selectedTemplate}'? This cannot be undone.`
    )
  ) {
    return;
  }
  try {
    await api.deleteTemplate(selectedTemplate);
    showToastNotification("Template deleted.", "success");
    localStorage.removeItem("activeTemplate");
    await loadTemplates();
    templateSelector.dispatchEvent(new Event("change"));
  } catch (error) {
    showToastNotification("Error deleting template: " + error.message, "error");
  }
}

export function getActiveTemplate() {
  return currentTemplateData;
}
