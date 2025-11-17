// static/scripts/app.js

import * as dom from "./scripts/domElements.js";
import * as api from "./scripts/api.js";
import * as ui from "./scripts/ui.js";
import * as highlighting from "./scripts/highlighting.js";
import * as templates from "./scripts/templates.js";
import { HIGHLIGHT_COLOR_PALETTE } from "./scripts/highlighting.js";
import { initializeActions } from "./scripts/modules/actions.js";
import { initializeSettings } from "./scripts/modules/settings.js";
import { initializeViewManager } from "./scripts/modules/viewManager.js";
import { initializeLockTimer } from "./scripts/modules/lockTimer.js";
import { initializeDashboard } from "./scripts/modules/dashboard.js";

const DEFAULT_CHECKLIST_CHOICES = [
  { value: "yes", label: "YES" },
  { value: "no", label: "NO" },
  { value: "na", label: "N/A" },
];

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

function extractPositiveChecklistValues(choices) {
  if (!Array.isArray(choices)) return [];
  const yesValues = choices
    .filter(
      (choice) =>
        choice.value.toLowerCase().startsWith("yes") ||
        choice.label.toLowerCase().startsWith("yes")
    )
    .map((choice) => choice.value.toLowerCase());
  if (yesValues.length > 0) return yesValues;
  return choices
    .map((choice) => choice.value.toLowerCase())
    .filter((val) => val && val !== "na");
}

function parseChecklistState(rawValue) {
  if (!rawValue) return {};
  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn("Failed to parse checklist state:", error);
    return {};
  }
}

async function waitForServerReady() {
  return new Promise((resolve) => {
    ui.showLoading("Connecting to Server", "Please wait...");
    const intervalId = setInterval(async () => {
      const status = await api.getAppStatus();
      if (status.status === "ready") {
        clearInterval(intervalId);
        ui.hideLoading();
        resolve();
      } else if (status.status === "error") {
        ui.showLoading("Connection Error", status.message);
      } else {
        ui.showLoading("Server Starting Up", status.message);
      }
    }, 1500);
  });
}

async function checkForUpdatesOnLoad() {
  try {
    const updateStatus = await api.checkForUpdates();
    if (updateStatus.update_available) {
      const banner = document.getElementById("update-notification-banner");
      if (banner) {
        banner.classList.remove("hidden");
      }
      console.log("Update available:", updateStatus.message);
    } else {
      console.log("Scribe is up to date.");
    }
  } catch (error) {
    console.warn("Could not check for updates on startup:", error);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  dom.init();

  const state = {
    currentPaper: null,
    currentDataset: null,
    currentSheetId: null,
    activeTemplate: null,
    totalPapersInQueue: 0,
    annotatedInSession: 0,
    originalFullTextHTML: "",
    originalAbstractHTML: "",
    activeHighlightIds: new Set(),
    lockTimerInterval: null,
    isAppInitialized: false,
    currentFilterQuery: "",
    sheetTemplateTimestamp: null,
    templatePollInterval: null,
    suppressAutoFill: false,
  };

  const actions = initializeActions(state);
  initializeLockTimer(state);

  let viewManager;
  const dashboard = initializeDashboard(state, {
    showAnnotationViewWithPaper: async (paper) => {
      if (viewManager) {
        await viewManager.showAnnotationViewWithPaper(paper);
      }
    },
  });

  // FIX: Provide the dashboard module reference to the actions module
  if (actions.setDashboardModule) {
    actions.setDashboardModule(dashboard);
  }

  viewManager = initializeViewManager(state, actions, dashboard);

  const settings = initializeSettings(
    state,
    viewManager,
    buildAnnotationFormFromTemplate
  );

  if (actions.setBuildFormCallback) {
    actions.setBuildFormCallback(buildAnnotationFormFromTemplate);
  }

  function generateAndApplyHighlightStyles(template) {
    document.getElementById("dynamic-highlight-styles")?.remove();
    if (!template || !template.fields) return;
    const styleEl = document.createElement("style");
    styleEl.id = "dynamic-highlight-styles";
    let cssRules = "";
    template.fields.forEach((field, index) => {
      if (field.keywords && field.keywords.length > 0) {
        const color =
          HIGHLIGHT_COLOR_PALETTE[index % HIGHLIGHT_COLOR_PALETTE.length];
        cssRules += `
            .highlight-toggle-btn.active[data-highlight-trigger="${field.id}"] svg {
                stroke: ${color.stroke};
            }
        `;
      }
    });
    styleEl.innerHTML = cssRules;
    document.head.appendChild(styleEl);
  }

  function buildAnnotationFormFromTemplate(template) {
    if (!template || !template.fields) {
      dom.annotationFieldsContainer.innerHTML =
        '<p class="text-red-400">Error: Could not load annotation template.</p>';
      return;
    }
    state.activeTemplate = template;
    dom.annotationFieldsContainer.innerHTML = "";

    const parseChecklistState = (raw) => {
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (error) {
        console.warn("Failed to parse checklist state:", error);
        return {};
      }
    };

    const updateChecklistSelection = (
      fieldContainer,
      itemId,
      nextValue,
      { allowToggle = false, silent = false } = {}
    ) => {
      if (!fieldContainer) return;
      const hiddenInput = fieldContainer.querySelector(
        'input[type="hidden"][data-field-type="checklist"]'
      );
      if (!hiddenInput) return;
      const currentState = parseChecklistState(hiddenInput.value);
      const currentValue = currentState[itemId] ?? null;
      let valueToApply = nextValue;
      if (allowToggle && currentValue === nextValue) {
        valueToApply = null;
      }
      currentState[itemId] = valueToApply;
      hiddenInput.value = JSON.stringify(currentState);
      const buttons = fieldContainer.querySelectorAll(
        `.checklist-choice-btn[data-item-id="${itemId}"]`
      );
      buttons.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.value === valueToApply);
      });
      if (!silent) {
        hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };

    const initializeChecklistField = (rowElement, fieldDef) => {
      const container = rowElement.querySelector(
        `.checklist-field[data-field-id="${fieldDef.id}"]`
      );
      if (!container) return;
      const hiddenInput = container.querySelector(
        'input[type="hidden"][data-field-type="checklist"]'
      );
      const itemsContainer = container.querySelector(
        ".checklist-items-container"
      );
      itemsContainer.innerHTML = "";
      const checklistItems = Array.isArray(fieldDef.checklistItems)
        ? fieldDef.checklistItems
        : [];
      const defaultButtonSpecs = normalizeChecklistChoices(
        fieldDef.checklistChoices
      );
      const positiveSet = new Set(
        extractPositiveChecklistValues(defaultButtonSpecs)
      );

      const topActions = document.createElement("div");
      topActions.className =
        "flex items-center justify-between gap-2 py-1 checklist-top-actions";
      const markAllBtn = document.createElement("button");
      markAllBtn.type = "button";
      markAllBtn.className = "boolean-btn checklist-mark-all-na-btn";
      markAllBtn.textContent = "Mark Entire Checklist N/A";
      const hint = document.createElement("span");
      hint.className = "text-xs text-gray-300";
      hint.textContent =
        "Sets every item to N/A; you can still adjust single items afterward.";
      topActions.appendChild(markAllBtn);
      topActions.appendChild(hint);
      container.insertBefore(topActions, itemsContainer);

      const initialState = {};
      if (checklistItems.length === 0) {
        const emptyNotice = document.createElement("p");
        emptyNotice.className =
          "text-xs text-gray-300 italic bg-black/20 rounded p-2";
        emptyNotice.textContent = "No checklist items configured.";
        itemsContainer.appendChild(emptyNotice);
      } else {
        checklistItems.forEach((item) => {
          const itemId = item.id || "";
          initialState[itemId] = null;

          const itemRow = document.createElement("div");
          itemRow.className = "checklist-item";

          const textSection = document.createElement("div");
          textSection.className = "checklist-item-text";

          const titleSpan = document.createElement("span");
          titleSpan.className = "checklist-item-title";
          titleSpan.textContent = item.label || "";
          textSection.appendChild(titleSpan);

          if (item.description) {
            const descSpan = document.createElement("span");
            descSpan.className = "checklist-item-description";
            descSpan.textContent = item.description;
            textSection.appendChild(descSpan);
          }

          const actionSection = document.createElement("div");
          actionSection.className = "checklist-item-actions";

          const buttonGroup = document.createElement("div");
          buttonGroup.className = "checklist-choice-group";
          actionSection.appendChild(buttonGroup);

          const customChoices = Array.isArray(item.choices)
            ? item.choices
            : [];
          const buttonSpecs = normalizeChecklistChoices(
            customChoices.length > 0 ? customChoices : defaultButtonSpecs
          );
          buttonSpecs.forEach(({ value, label }) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "boolean-btn checklist-choice-btn";
            btn.dataset.itemId = itemId;
            btn.dataset.value = value;
            btn.textContent = label;
            btn.addEventListener("click", () => {
              updateChecklistSelection(container, itemId, value, {
                allowToggle: true,
              });
            });
            buttonGroup.appendChild(btn);
          });
          extractPositiveChecklistValues(buttonSpecs).forEach((val) =>
            positiveSet.add(val)
          );

          itemRow.appendChild(textSection);
          itemRow.appendChild(actionSection);
          itemsContainer.appendChild(itemRow);
        });
      }

      const applyState = (nextState, { silent = false } = {}) => {
        hiddenInput.value = JSON.stringify(nextState);
        container.querySelectorAll(".checklist-choice-btn").forEach((btn) => {
          const itemId = btn.dataset.itemId;
          const targetValue =
            itemId !== undefined ? nextState[itemId] ?? null : null;
          btn.classList.toggle("active", btn.dataset.value === targetValue);
        });
        if (!silent) {
          hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
      };

      const allItemsMatch = (state, target) =>
        checklistItems.length > 0 &&
        checklistItems.every((item) => (state[item.id] ?? null) === target);

      const updateMarkAllLabel = () => {
        const state = parseChecklistState(hiddenInput.value);
        const allNA = allItemsMatch(state, "na");
        markAllBtn.textContent = allNA
          ? "Clear All N/A"
          : "Mark Entire Checklist N/A";
        markAllBtn.dataset.checked = allNA ? "true" : "false";
      };

      markAllBtn.addEventListener("click", () => {
        const currentState = parseChecklistState(hiddenInput.value);
        const allNA = allItemsMatch(currentState, "na");
        const nextState = {};
        checklistItems.forEach((item) => {
          const itemId = item.id || "";
          if (!itemId) return;
          nextState[itemId] = allNA ? null : "na";
        });
        applyState(nextState);
        updateMarkAllLabel();
      });

      const serializedState = JSON.stringify(initialState);
      hiddenInput.value = serializedState;
      hiddenInput.dataset.defaultState = serializedState;
      hiddenInput.dataset.itemIds = checklistItems
        .map((item) => item.id || "")
        .join(",");

      hiddenInput.dataset.checklistPositive = Array.from(positiveSet).join(",");
      hiddenInput.addEventListener("change", updateMarkAllLabel);
      updateMarkAllLabel();
    };

    template.fields.forEach((field) => {
      const row = document.createElement("div");
      row.className = "annotation-row glass-effect rounded-xl p-3";

      const lockButtonHTML = `<button type="button" class="autofill-lock-btn" data-target-lock="${field.id}" title="Lock field to prevent auto-fill">
                                  <svg class="icon-unlocked h-5 w-5 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                                      <path stroke-linecap="round" stroke-linejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v3m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                                  </svg>
                                  <svg class="icon-locked hidden h-5 w-5 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                  </svg>
                              </button>`;

      const aiActionButtonsHTML = `<button type="button" class="ai-action-btn revert-ai-btn hidden" data-revert-target="${field.id}" title="Revert AI Suggestion"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg></button><button type="button" class="ai-action-btn clear-ai-btn hidden" data-clear-target="${field.id}" title="Clear AI Suggestion & Context"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg></button>`;
      let controlHTML = "";
      if (field.type === "boolean") {
        controlHTML = `<div class="boolean-button-group"><button type="button" class="boolean-btn" data-value="true">TRUE</button><button type="button" class="boolean-btn" data-value="false">FALSE</button><input type="hidden" id="${field.id}" name="${field.id}" value="" data-context-target="${field.id}_context" data-field-type="boolean"></div>`;
      } else if (field.type === "select") {
        const optionsHTML = field.options
          .map((opt) => `<option value="${opt}">${opt}</option>`)
          .join("");
        controlHTML = `<select id="${field.id}" name="${field.id}" data-context-target="${field.id}_context" data-field-type="select" class="custom-select w-full p-2 bg-white bg-opacity-10 rounded-lg text-white text-sm"><option value="">[Select One]</option>${optionsHTML}</select>`;
      } else if (field.type === "checklist") {
        controlHTML = `<div class="checklist-field space-y-3 flex-1 w-full" data-field-id="${field.id}"><input type="hidden" id="${field.id}" name="${field.id}" value="" data-context-target="${field.id}_context" data-field-type="checklist"><div class="space-y-3 checklist-items-container"></div></div>`;
      }
      const highlightButtonHTML =
        field.keywords && field.keywords.length > 0
          ? `<button type="button" class="highlight-toggle-btn" data-highlight-trigger="${field.id}" title="Toggle keyword highlights"><svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg></button>`
          : "";
      const helperTextHTML =
        field.helperText && field.helperText.trim().length > 0
          ? `<div class="mt-2 text-xs text-gray-300 leading-relaxed whitespace-pre-line">${escapeHtml(
              field.helperText
            )}</div>`
          : "";
      row.innerHTML = `<div class="flex items-center justify-between gap-2"><div class="flex items-center space-x-2 min-w-0">${highlightButtonHTML}<label for="${field.id}" class="text-gray-200 text-sm font-medium truncate" title="${field.label}">${field.label}</label></div><button type="button" class="reasoning-bubble-btn hidden" data-reasoning-target="${field.id}" aria-label="Show AI reasoning"><svg class="h-4 w-4 text-gray-300 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg></button></div>${helperTextHTML}<div class="flex items-center justify-between gap-4 mt-2">${controlHTML}<div class="flex items-center space-x-1 flex-shrink-0">${aiActionButtonsHTML}${lockButtonHTML}</div></div><div id="${field.id}_context" class="hidden mt-2"><textarea name="${field.id}_context" class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white placeholder-gray-200 text-sm" rows="3" placeholder="Context for '${field.label}'"></textarea></div>`;
      dom.annotationFieldsContainer.appendChild(row);
      if (field.type === "checklist") {
        initializeChecklistField(row, field);
      }
    });

    document.querySelectorAll(".boolean-button-group").forEach((group) => {
      const hiddenInput = group.querySelector('input[type="hidden"]');
      if (!hiddenInput) return;
      group.querySelectorAll(".boolean-btn").forEach((button) => {
        button.addEventListener("click", () => {
          const selectedValue = button.dataset.value;
          hiddenInput.value =
            hiddenInput.value === selectedValue ? "" : selectedValue;
          group
            .querySelectorAll(".boolean-btn")
            .forEach((btn) => btn.classList.remove("active"));
          if (hiddenInput.value === selectedValue)
            button.classList.add("active");
          hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });
    });

    ui.setupContextToggles();
    document
      .querySelectorAll(".highlight-toggle-btn")
      .forEach((btn) => btn.addEventListener("click", onHighlightToggle));
    actions.initializeAutoFill(template);
    generateAndApplyHighlightStyles(template);
  }

  function onHighlightToggle(event) {
    highlighting.handleHighlightToggle(
      event,
      state.activeHighlightIds,
      state.activeTemplate
    );
    highlighting.updateAllHighlights(
      state.activeHighlightIds,
      state.originalAbstractHTML,
      state.originalFullTextHTML,
      state.activeTemplate
    );
  }

  async function init() {
    await waitForServerReady();
    checkForUpdatesOnLoad();

    viewManager.setupPanelResizing();
    viewManager.setupViewSwitching();
    await settings.setupSettings();
    ui.setupFieldActionControls();

    dom.sheetSelector.addEventListener("change", (e) => {
      actions.handleSheetChange(e);
    });
    dom.datasetSelector.addEventListener("change", actions.handleDatasetChange);
    dom.submitBtn.addEventListener("click", actions.submitAnnotation);
    dom.submitAugmentBtn.addEventListener(
      "click",
      actions.submitAndAugmentAnnotation
    );
    dom.skipBtn.addEventListener("click", actions.handleSkip);
    dom.getSuggestionsBtn.addEventListener(
      "click",
      actions.handleGetSuggestions
    );
    document
      .getElementById("apply-filter-btn")
      .addEventListener("click", actions.handleApplyFilter);
    document
      .getElementById("clear-filter-btn")
      .addEventListener("click", actions.handleClearFilter);
    document.getElementById("filter-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        actions.handleApplyFilter();
      }
    });
    dom.openDataFolderBtnMain.addEventListener("click", api.openDataFolder);

    const updateNowBannerBtn = document.getElementById("update-now-banner-btn");
    if (updateNowBannerBtn) {
      updateNowBannerBtn.addEventListener("click", () => {
        if (
          confirm("This will update and restart the application. Continue?")
        ) {
          ui.showToastNotification(
            "Update started. The app will restart shortly...",
            "info"
          );
          api.triggerUpdateAndRestart();
        }
      });
    }

    const updateTemplateBtn = document.getElementById(
      "update-template-now-btn"
    );
    if (updateTemplateBtn) {
      updateTemplateBtn.addEventListener("click", async () => {
        if (!state.currentSheetId) return;
        ui.showLoading("Updating Template...", "Fetching latest version...");
        try {
          const newTemplate = await api.getSheetTemplate(state.currentSheetId);
          const newStatus = await api.getSheetTemplateStatus(
            state.currentSheetId
          );

          if (newTemplate) {
            buildAnnotationFormFromTemplate(newTemplate);
            document.dispatchEvent(
              new CustomEvent("loadSheetTemplate", { detail: newTemplate })
            );
            if (newStatus) {
              state.sheetTemplateTimestamp = newStatus.last_updated;
            }
            document
              .getElementById("template-update-banner")
              .classList.add("hidden");
            ui.showToastNotification(
              "Annotation template updated successfully!",
              "success"
            );
          }
        } catch (error) {
          ui.showToastNotification(
            `Failed to update template: ${error.message}`,
            "error"
          );
        } finally {
          ui.hideLoading();
        }
      });
    }

    const setupComplete = await viewManager.runInitialSetupCheck();
    if (setupComplete) {
      viewManager.showView(dom.mainView);
      if (!state.isAppInitialized) {
        const activeTemplate = templates.getActiveTemplate();
        buildAnnotationFormFromTemplate(activeTemplate);
        await settings.initializeSheetSelector();
        state.isAppInitialized = true;
      }
    }
  }

  try {
    init();
  } catch (error) {
    console.error(
      "A critical error occurred during application initialization:",
      error
    );
    document.body.innerHTML = `<div style="padding: 2rem; color: white; font-family: sans-serif;"><h1>Application Failed to Start</h1><p>A critical error prevented the application from loading. Please check the browser's developer console (F12) for more details.</p><p><strong>Error:</strong> ${error.message}</p></div>`;
  }
});
