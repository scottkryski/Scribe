import * as dom from "../domElements.js";
import * as api from "../api.js";
import * as ui from "../ui.js";
import * as templates from "../templates.js";

let state, showView, buildAnnotationFormFromTemplate;

function setupSettingsAccordions() {
  document.querySelectorAll(".settings-accordion-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      button.classList.toggle("active");
      const content = button.nextElementSibling;
      content.classList.toggle("open");
    });
  });
}

async function onSaveApiKey() {
  const key = dom.apiKeyInput.value.trim();
  if (!key) return;
  dom.saveApiKeyBtn.disabled = true;
  dom.saveApiKeyBtn.textContent = "Saving...";
  try {
    await api.saveApiKey(key);
    dom.apiKeyInput.value = "";
    ui.showToastNotification("API Key saved successfully.", "success");
    await updateApiKeyStatus();
  } catch (error) {
    alert(`Error: ${error.message}`);
  } finally {
    dom.saveApiKeyBtn.disabled = false;
    dom.saveApiKeyBtn.textContent = "Save";
  }
}

function onThemeChange(event) {
  const theme = event.currentTarget.dataset.theme;
  document.documentElement.className = ""; // Clear all classes
  document.documentElement.classList.add(`theme-${theme}`);
  localStorage.setItem("theme", theme);
  updateActiveThemeButton();
}

async function updateApiKeyStatus() {
  const data = await api.checkApiKeyStatus();
  const statusEl = document.getElementById("api-key-status");
  if (data.is_set) {
    statusEl.textContent = "A key is currently set on the server.";
    dom.apiKeyInput.placeholder = "Enter a new key to overwrite";
  } else {
    statusEl.textContent = "No API key found on the server.";
    dom.apiKeyInput.placeholder = "Enter your Gemini API Key";
  }
}

function updateActiveThemeButton() {
  const currentTheme = localStorage.getItem("theme") || "default";
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.classList.toggle("active-theme", btn.dataset.theme === currentTheme);
  });
}

async function populateAndSetModels() {
  try {
    const models = await api.getGeminiModels();
    dom.geminiModelSelector.innerHTML = models.length
      ? models.map((m) => `<option value="${m}">${m}</option>`).join("")
      : '<option value="">-- No models found --</option>';

    const savedModel = localStorage.getItem("geminiModel");
    if (savedModel && models.includes(savedModel)) {
      dom.geminiModelSelector.value = savedModel;
    } else if (models.length > 0) {
      dom.geminiModelSelector.value = models[0];
      localStorage.setItem("geminiModel", models[0]);
    }
  } catch (error) {
    dom.geminiModelSelector.innerHTML =
      '<option value="">-- Error loading --</option>';
  }
}

async function initializeSheetsManagementUI() {
  const container = document.getElementById("sheets-list-container");
  const addForm = document.getElementById("add-sheet-form");
  const addBtn = document.getElementById("add-new-sheet-btn");
  const cancelBtn = document.getElementById("cancel-add-sheet-btn");
  const saveBtn = document.getElementById("save-new-sheet-btn");
  const nameInput = document.getElementById("new-sheet-name");
  const urlInput = document.getElementById("new-sheet-id");

  async function renderList() {
    const sheets = await api.getSheets();
    container.innerHTML =
      sheets.length === 0
        ? '<p class="text-gray-400 text-sm">No sheets configured.</p>'
        : sheets
            .map(
              (sheet) => `
                <div class="flex justify-between items-center bg-black bg-opacity-20 p-2 rounded-lg">
                    <div><p class="font-semibold">${sheet.name}</p><p class="text-xs text-gray-400">${sheet.id}</p></div>
                    <button data-id="${sheet.id}" class="delete-sheet-btn text-red-400 hover:text-red-200 p-2 rounded-full">🗑️</button>
                </div>`
            )
            .join("");
  }

  container.addEventListener("click", async (e) => {
    if (e.target.closest(".delete-sheet-btn")) {
      const id = e.target.closest(".delete-sheet-btn").dataset.id;
      if (confirm("Delete this sheet configuration?")) {
        await api.deleteSheet(id);
        await renderList();
        await initializeSheetSelector();
      }
    }
  });

  addBtn.addEventListener("click", () => {
    addForm.classList.remove("hidden");
    addBtn.classList.add("hidden");
  });
  cancelBtn.addEventListener("click", () => {
    addForm.classList.add("hidden");
    addBtn.classList.remove("hidden");
    nameInput.value = "";
    urlInput.value = "";
  });
  saveBtn.addEventListener("click", async () => {
    if (!nameInput.value || !urlInput.value) return;
    try {
      await api.addSheet(nameInput.value, urlInput.value);
      await renderList();
      await initializeSheetSelector();
      cancelBtn.click();
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  });

  await renderList();
}

export async function initializeSheetSelector() {
  const sheets = await api.getSheets();
  dom.sheetSelector.innerHTML =
    '<option value="">-- Select a Sheet --</option>' +
    sheets.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");

  const savedSheetId = localStorage.getItem("currentSheetId");
  if (savedSheetId && sheets.some((s) => s.id === savedSheetId)) {
    dom.sheetSelector.value = savedSheetId;
    dom.sheetSelector.dispatchEvent(new Event("change"));
  }
}

export function initializeSettings(_state, _viewManager, _buildAnnotationForm) {
  state = _state;
  showView = _viewManager.showView;
  buildAnnotationFormFromTemplate = _buildAnnotationForm;

  return {
    setupSettings: async () => {
      dom.annotatorInput.value = localStorage.getItem("annotatorName") || "";
      dom.annotatorInput.addEventListener("input", () =>
        localStorage.setItem("annotatorName", dom.annotatorInput.value)
      );

      document
        .getElementById("load-pdf-only-toggle")
        .addEventListener("change", (e) =>
          localStorage.setItem("loadPdfOnly", e.target.checked)
        );
      document
        .getElementById("prioritize-incomplete-toggle")
        .addEventListener("change", (e) =>
          localStorage.setItem("prioritizeIncomplete", e.target.checked)
        );

      dom.saveApiKeyBtn.addEventListener("click", onSaveApiKey);
      document
        .querySelectorAll(".theme-btn")
        .forEach((btn) => btn.addEventListener("click", onThemeChange));
      dom.geminiModelSelector.addEventListener("change", () =>
        localStorage.setItem("geminiModel", dom.geminiModelSelector.value)
      );

      document
        .getElementById("open-data-folder-btn-settings")
        .addEventListener("click", api.openDataFolder);
      document
        .getElementById("refresh-datasets-btn")
        .addEventListener("click", async () => {
          const datasets = await api.getDatasets();
          const currentVal = dom.datasetSelector.value;
          dom.datasetSelector.innerHTML =
            '<option value="">Select Dataset</option>' +
            datasets
              .map((name) => `<option value="${name}">${name}</option>`)
              .join("");
          if (datasets.includes(currentVal))
            dom.datasetSelector.value = currentVal;
        });

      const updateBtn = document.getElementById("check-for-updates-btn");
      if (updateBtn) {
        updateBtn.addEventListener("click", async () => {
          const originalText = updateBtn.textContent;
          updateBtn.textContent = "Checking...";
          updateBtn.disabled = true;
          try {
            const result = await api.checkForUpdates();
            if (result.update_available) {
              if (
                confirm(
                  "A new version is available! Do you want to update and restart now?"
                )
              ) {
                ui.showToastNotification(
                  "Update started. The application will restart shortly...",
                  "info"
                );
                api.triggerUpdateAndRestart();
              }
            } else {
              ui.showToastNotification(result.message, "success");
            }
          } catch (error) {
            alert(`Error: ${error.message}`);
          } finally {
            updateBtn.textContent = originalText;
            updateBtn.disabled = false;
          }
        });
      }

      await templates.initTemplateManager(buildAnnotationFormFromTemplate);
      await initializeSheetsManagementUI();
      await populateAndSetModels();
      updateActiveThemeButton();
      updateApiKeyStatus();
      setupSettingsAccordions();
    },
    initializeSheetSelector,
  };
}
