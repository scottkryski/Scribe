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

// --- FIX START: New function to check for updates on startup ---
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
    // Fail silently, this is not a critical feature.
    console.warn("Could not check for updates on startup:", error);
  }
}
// --- FIX END ---

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
  };

  // --- Module Initialization ---
  const actions = initializeActions(state);
  initializeLockTimer(state);

  // The viewManager needs a way to tell the dashboard to reload, and the dashboard needs a way to tell the viewManager to switch views.
  // We pass a simplified object to the dashboard so it can call back to the viewManager.
  // Then we pass the fully initialized dashboard to the viewManager.
  let viewManager;
  const dashboard = initializeDashboard(state, {
    showAnnotationViewWithPaper: async (paper) => {
      // This function will be called from the dashboard to switch views
      if (viewManager) {
        await viewManager.showAnnotationViewWithPaper(paper);
      }
    },
  });
  viewManager = initializeViewManager(state, actions, dashboard);

  const settings = initializeSettings(
    state,
    viewManager,
    buildAnnotationFormFromTemplate
  );

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
        controlHTML = `<div class="boolean-button-group"><button type="button" class="boolean-btn" data-value="true">TRUE</button><button type="button" class="boolean-btn" data-value="false">FALSE</button><input type="hidden" id="${field.id}" name="${field.id}" value="" data-context-target="${field.id}_context"></div>`;
      } else if (field.type === "select") {
        const optionsHTML = field.options
          .map((opt) => `<option value="${opt}">${opt}</option>`)
          .join("");
        controlHTML = `<select id="${field.id}" name="${field.id}" data-context-target="${field.id}_context" class="custom-select w-full p-2 bg-white bg-opacity-10 rounded-lg text-white text-sm"><option value="">[Select One]</option>${optionsHTML}</select>`;
      }
      const highlightButtonHTML =
        field.keywords && field.keywords.length > 0
          ? `<button type="button" class="highlight-toggle-btn" data-highlight-trigger="${field.id}" title="Toggle keyword highlights"><svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg></button>`
          : "";
      row.innerHTML = `<div class="flex items-center justify-between gap-2"><div class="flex items-center space-x-2 min-w-0">${highlightButtonHTML}<label for="${field.id}" class="text-gray-200 text-sm font-medium truncate" title="${field.label}">${field.label}</label></div><button type="button" class="reasoning-bubble-btn hidden" data-reasoning-target="${field.id}" aria-label="Show AI reasoning"><svg class="h-4 w-4 text-gray-300 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg></button></div><div class="flex items-center justify-between gap-4 mt-2">${controlHTML}<div class="flex items-center space-x-1 flex-shrink-0">${aiActionButtonsHTML}${lockButtonHTML}</div></div><div id="${field.id}_context" class="hidden mt-2"><textarea name="${field.id}_context" class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white placeholder-gray-200 text-sm" rows="3" placeholder="Context for '${field.label}'"></textarea></div>`;
      dom.annotationFieldsContainer.appendChild(row);
    });

    document.querySelectorAll(".boolean-button-group").forEach((group) => {
      const hiddenInput = group.querySelector('input[type="hidden"]');
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

    // --- FIX: Call the update check function on startup ---
    checkForUpdatesOnLoad();

    viewManager.setupPanelResizing();
    viewManager.setupViewSwitching();
    await settings.setupSettings();
    ui.setupFieldActionControls();

    // --- Event Listeners ---
    dom.sheetSelector.addEventListener("change", actions.handleSheetChange);
    dom.datasetSelector.addEventListener("change", actions.handleDatasetChange);
    dom.submitBtn.addEventListener("click", actions.submitAnnotation);
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
