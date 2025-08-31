import * as dom from "./scripts/domElements.js";
import * as api from "./scripts/api.js";
import * as ui from "./scripts/ui.js";
import * as highlighting from "./scripts/highlighting.js";
import * as templates from "./scripts/templates.js";

// --- NEW: Function to poll the backend until it's ready ---
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
  };

  const mainContentGrid = document.getElementById("main-content-grid");
  const resizeHandle = document.getElementById("resize-handle");
  const themeButtons = document.querySelectorAll(".theme-btn");
  const loadPdfOnlyToggle = document.getElementById("load-pdf-only-toggle");
  const prioritizeIncompleteToggle = document.getElementById(
    "prioritize-incomplete-toggle"
  );
  const noDatasetsMessage = document.getElementById("no-datasets-message");
  const updateNotificationBanner = document.getElementById(
    "update-notification-banner"
  );
  const updateNowBannerBtn = document.getElementById("update-now-banner-btn");

  async function runStartupUpdateCheck() {
    try {
      const result = await api.checkForUpdates();
      if (result.update_available) {
        if (updateNotificationBanner) {
          updateNotificationBanner.classList.remove("hidden");
        }
      }
    } catch (error) {
      console.warn("Could not check for updates on startup:", error.message);
    }
  }

  function setupPanelResizing() {
    if (!resizeHandle || !mainContentGrid) return;
    const onMouseDown = (e) => {
      e.preventDefault();
      resizeHandle.classList.add("is-resizing");
      const onMouseMove = (moveEvent) => {
        const parentRect = mainContentGrid.getBoundingClientRect();
        const minWidth = 320;
        const handleWidth = resizeHandle.offsetWidth;
        let newPaperWidth = moveEvent.clientX - parentRect.left;
        if (newPaperWidth < minWidth) {
          newPaperWidth = minWidth;
        }
        if (parentRect.width - newPaperWidth - handleWidth < minWidth) {
          newPaperWidth = parentRect.width - minWidth - handleWidth;
        }
        mainContentGrid.style.gridTemplateColumns = `${newPaperWidth}px ${handleWidth}px 1fr`;
      };
      const onMouseUp = () => {
        resizeHandle.classList.remove("is-resizing");
        if (mainContentGrid.style.gridTemplateColumns) {
          const isWidescreen = document
            .querySelector(".page-container")
            .classList.contains("widescreen");
          const storageKey = isWidescreen
            ? "panelLayoutWide"
            : "panelLayoutNarrow";
          localStorage.setItem(
            storageKey,
            mainContentGrid.style.gridTemplateColumns
          );
        }
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };
    const onDoubleClick = () => {
      mainContentGrid.style.gridTemplateColumns = "";
      localStorage.removeItem("panelLayoutNarrow");
      localStorage.removeItem("panelLayoutWide");
    };
    resizeHandle.addEventListener("mousedown", onMouseDown);
    resizeHandle.addEventListener("dblclick", onDoubleClick);
  }

  function setWidescreenIcon(isWidescreen) {
    const toggleButtons = document.querySelectorAll(".widescreen-toggle-btn");
    toggleButtons.forEach((btn) => {
      const iconExpand = btn.querySelector(".icon-expand");
      const iconCompress = btn.querySelector(".icon-compress");
      if (iconExpand && iconCompress) {
        iconExpand.classList.toggle("hidden", isWidescreen);
        iconCompress.classList.toggle("hidden", !isWidescreen);
      }
    });
  }

  function applyAutoFillRule(rule, triggerId) {
    const targetEl = document.getElementById(rule.targetId);
    if (!targetEl || targetEl.dataset.locked === "true") return;
    let valueChanged = false;
    if (
      targetEl.type === "hidden" &&
      targetEl.parentElement.classList.contains("boolean-button-group")
    ) {
      const group = targetEl.parentElement;
      const valueToSet = rule.targetValue.toString();
      if (targetEl.value !== valueToSet) {
        targetEl.value = valueToSet;
        valueChanged = true;
        group.querySelectorAll(".boolean-btn").forEach((button) => {
          button.classList.toggle(
            "active",
            button.dataset.value === valueToSet
          );
        });
      }
    } else if (targetEl.tagName === "SELECT") {
      if (targetEl.value !== rule.targetValue) {
        targetEl.value = rule.targetValue;
        valueChanged = true;
      }
    }
    if (valueChanged) {
      ui.showDebouncedAutoFillNotification();
      targetEl.dataset.autofilledBy = triggerId;
      targetEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function resetField(fieldElement) {
    if (!fieldElement || fieldElement.dataset.locked === "true") return;
    const originalValue = fieldElement.value;
    if (
      fieldElement.type === "hidden" &&
      fieldElement.parentElement.classList.contains("boolean-button-group")
    ) {
      const group = fieldElement.parentElement;
      group
        .querySelectorAll(".boolean-btn")
        .forEach((btn) => btn.classList.remove("active"));
      fieldElement.value = "";
    } else if (fieldElement.tagName === "SELECT") {
      fieldElement.value = "";
    }
    if (originalValue !== fieldElement.value) {
      ui.showDebouncedAutoFillNotification();
      delete fieldElement.dataset.autofilledBy;
      fieldElement.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function initializeAutoFill(template) {
    if (!template || !template.fields) return;
    template.fields.forEach((field) => {
      if (!field.autoFillRules || field.autoFillRules.length === 0) return;
      const triggerEl = document.getElementById(field.id);
      if (!triggerEl) return;
      triggerEl.addEventListener("change", (e) => {
        const whoSetMe = e.target.dataset.autofilledBy;
        const triggerId = e.target.id;
        const currentValue = e.target.value;
        document
          .querySelectorAll(`[data-autofilled-by="${triggerId}"]`)
          .forEach((fieldToReset) => {
            if (fieldToReset.id === whoSetMe) return;
            resetField(fieldToReset);
          });
        field.autoFillRules.forEach((rule) => {
          if (currentValue === rule.triggerValue.toString()) {
            applyAutoFillRule(rule, triggerId);
          }
        });
      });
    });
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
      const lockButtonHTML = `<button type="button" class="autofill-lock-btn" data-target-lock="${field.id}" title="Lock field to prevent auto-fill"><svg class="icon-unlocked h-5 w-5 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H4.5a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg><svg class="icon-locked hidden h-5 w-5 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H4.5a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg></button>`;
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
          if (button.classList.contains("active")) {
            hiddenInput.value = "";
            button.classList.remove("active");
          } else {
            hiddenInput.value = selectedValue;
            group
              .querySelectorAll(".boolean-btn")
              .forEach((btn) => btn.classList.remove("active"));
            button.classList.add("active");
          }
          hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });
    });
    ui.setupContextToggles();
    document
      .querySelectorAll(".highlight-toggle-btn")
      .forEach((btn) => btn.addEventListener("click", onHighlightToggle));
    initializeAutoFill(template);
  }

  async function handleDatasetChange() {
    const selectedDataset = dom.datasetSelector.value;
    if (!selectedDataset || !state.currentSheetId) {
      return;
    }
    state.currentDataset = selectedDataset;
    localStorage.setItem(
      `currentDataset_${state.currentSheetId}`,
      selectedDataset
    );
    ui.showLoading("Loading Session", "Checking for resumable papers...");
    try {
      const annotatorName = localStorage.getItem("annotatorName");
      let doiToSkip = null;
      if (annotatorName) {
        const resumable = await api.checkForResumablePaper(annotatorName);
        if (resumable && resumable.resumable && resumable.dataset) {
          const resume = confirm(
            `You were previously working on the paper:\n\n"${resumable.title}"\n(from dataset: ${resumable.dataset})\n\nWould you like to resume?`
          );
          if (resume) {
            ui.showLoading("Resuming Session", "Loading correct dataset...");
            dom.datasetSelector.value = resumable.dataset;
            state.currentDataset = resumable.dataset;
            localStorage.setItem(
              `currentDataset_${state.currentSheetId}`,
              resumable.dataset
            );
            await api.loadDataset(resumable.dataset);
            await fetchAndDisplaySpecificPaper(
              resumable.doi,
              resumable.dataset
            );
            return;
          } else {
            ui.showToastNotification(
              "Lock released. Finding a new paper...",
              "info"
            );
            await api.skipPaper(resumable.dataset, resumable.doi);
            doiToSkip = resumable.doi;
          }
        }
      }
      ui.showLoading("Loading Dataset", "Filtering against sheet records...");
      const result = await api.loadDataset(state.currentDataset);
      state.totalPapersInQueue = result.queued_count;
      state.annotatedInSession = 0;
      await fetchAndDisplayNextPaper(0, doiToSkip);
    } catch (error) {
      ui.hideLoading();
      alert(`Error loading dataset: ${error.message}`);
    }
  }

  async function handleSheetChange() {
    const selectedSheetId = dom.sheetSelector.value;
    if (!selectedSheetId) {
      dom.datasetSelector.disabled = true;
      dom.datasetSelector.innerHTML =
        '<option value="">Select Dataset</option>';
      return;
    }
    ui.showLoading("Connecting to Sheet", "Loading sheet metadata...");
    try {
      await api.connectToSheet(selectedSheetId);
      state.currentSheetId = selectedSheetId;
      localStorage.setItem("currentSheetId", selectedSheetId);
      const datasets = await api.getDatasets();
      dom.datasetSelector.innerHTML =
        '<option value="">Select Dataset</option>';
      datasets.forEach((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        dom.datasetSelector.appendChild(option);
      });
      dom.datasetSelector.disabled = false;
      const lastDataset = localStorage.getItem(
        `currentDataset_${selectedSheetId}`
      );
      if (lastDataset && datasets.includes(lastDataset)) {
        dom.datasetSelector.value = lastDataset;
        await handleDatasetChange();
      } else {
        dom.paperView.classList.remove("hidden");
        dom.paperTitle.textContent = "Select a dataset to begin...";
        dom.paperContentContainer.classList.add("hidden");
        dom.annotationView.classList.add("hidden");
      }
      ui.showToastNotification("Successfully connected to sheet.", "success");
    } catch (error) {
      alert(`Failed to connect to sheet: ${error.message}`);
      dom.sheetSelector.value = "";
      state.currentSheetId = null;
    } finally {
      ui.hideLoading();
    }
  }

  async function initializeSheetSelector() {
    try {
      const sheets = await api.getSheets();
      dom.sheetSelector.innerHTML =
        '<option value="">-- Select a Sheet --</option>';
      if (sheets.length === 0) {
        dom.sheetSelector.innerHTML =
          '<option value="">-- No Sheets Configured --</option>';
        ui.showToastNotification(
          "Please add a Google Sheet in Settings to begin.",
          "warning"
        );
        return;
      }
      sheets.forEach((sheet) => {
        const option = document.createElement("option");
        option.value = sheet.id;
        option.textContent = sheet.name;
        dom.sheetSelector.appendChild(option);
      });
      const savedSheetId = localStorage.getItem("currentSheetId");
      if (savedSheetId && sheets.some((s) => s.id === savedSheetId)) {
        dom.sheetSelector.value = savedSheetId;
        await handleSheetChange();
      } else {
        await refreshDatasetSelectors();
      }
    } catch (error) {
      alert("Could not load sheet configurations from server.");
    }
  }

  async function refreshDatasetSelectors() {
    try {
      const datasets = await api.getDatasets();
      const mainSelector = dom.datasetSelector;
      const currentVal = mainSelector.value;
      mainSelector.innerHTML = '<option value="">Select Dataset</option>';
      if (datasets.length > 0) {
        noDatasetsMessage.classList.add("hidden");
        datasets.forEach((name) => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          mainSelector.appendChild(option);
        });
        if (datasets.includes(currentVal)) {
          mainSelector.value = currentVal;
        }
      } else {
        noDatasetsMessage.classList.remove("hidden");
        mainSelector.innerHTML =
          '<option value="">-- No Datasets Found --</option>';
      }
      ui.showToastNotification("Dataset list refreshed.", "success");
    } catch (error) {
      ui.showToastNotification(
        `Error refreshing datasets: ${error.message}`,
        "error"
      );
    }
  }

  async function fetchAndDisplaySpecificPaper(doi, dataset) {
    if (!dataset) {
      alert(
        "An internal error occurred: Cannot fetch paper without a dataset specified."
      );
      return;
    }
    stopLockTimer();
    ui.showLoading(
      "Resuming Session",
      "Please wait while we fetch your previous paper..."
    );
    try {
      state.currentPaper = await api.fetchPaperByDoi(doi, dataset);
      await displayPaper(state.currentPaper);
    } catch (error) {
      ui.hideLoading();
      alert(
        `Error resuming paper: ${error.message}. Getting a new paper instead.`
      );
      await fetchAndDisplayNextPaper();
    }
  }

  async function displayPaper(paper) {
    state.currentPaper = paper;
    dom.paperView.classList.remove("hidden");
    dom.annotationView.classList.remove("hidden");
    dom.paperContentContainer.classList.remove("hidden");
    if (window.innerWidth >= 1024) {
      resizeHandle.style.display = "flex";
    } else {
      resizeHandle.style.display = "none";
    }
    const { originalAbstractHTML, originalFullTextHTML } = await ui.renderPaper(
      state.currentPaper
    );
    startLockTimer(state.currentPaper.lock_info);
    state.originalAbstractHTML = originalAbstractHTML;
    state.originalFullTextHTML = originalFullTextHTML;
    state.activeHighlightIds.clear();
    document
      .querySelectorAll(".highlight-toggle-btn")
      .forEach((btn) => btn.classList.remove("active"));
    highlighting.updateAllHighlights(
      state.activeHighlightIds,
      state.originalAbstractHTML,
      state.originalFullTextHTML,
      state.activeTemplate
    );
    ui.hideLoading();
  }

  async function fetchAndDisplayNextPaper(retryCount = 0, skipDoi = null) {
    if (!state.currentDataset) return;
    stopLockTimer();
    if (retryCount === 0) {
      ui.showLoading(
        "Finding & Loading Paper",
        "Please wait while we fetch the data and PDF..."
      );
    }
    try {
      const paper = await api.fetchNextPaper(state.currentDataset, skipDoi);
      await displayPaper(paper);
    } catch (error) {
      if (error.message.includes("locked by another user") && retryCount < 5) {
        ui.showToastNotification(
          "That paper was just taken. Finding another...",
          "info"
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        return fetchAndDisplayNextPaper(retryCount + 1, skipDoi);
      }
      ui.hideLoading();
      alert(error.message);
      dom.paperView.classList.remove("hidden");
      dom.paperTitle.textContent =
        "Error loading paper. Please try again or skip.";
      dom.paperContentContainer.classList.add("hidden");
      dom.annotationView.classList.add("hidden");
      resizeHandle.style.display = "none";
    }
  }

  async function submitAnnotation() {
    const annotatorName = localStorage.getItem("annotatorName") || "";
    if (!state.currentPaper || !annotatorName) {
      alert(
        'Please go to the Settings page and enter your name in the "Annotator" field before submitting.'
      );
      return;
    }
    const annotations = {};
    state.activeTemplate.fields.forEach((field) => {
      const element = document.getElementById(field.id);
      if (element) {
        let value = element.value;
        if (field.type === "boolean") {
          if (value === "true") annotations[field.id] = "TRUE";
          else if (value === "false") annotations[field.id] = "FALSE";
          else annotations[field.id] = "";
        } else {
          annotations[field.id] = value;
        }
        const contextEl = document.querySelector(
          `[name="${field.id}_context"]`
        );
        if (contextEl) {
          annotations[`${field.id}_context`] = contextEl.value;
        }
      }
    });
    const payload = {
      dataset: state.currentDataset,
      doi: state.currentPaper.doi,
      title: state.currentPaper.title,
      annotator: annotatorName,
      annotations: annotations,
    };
    ui.setButtonLoading(dom.submitBtn, true, "Submitting...");
    try {
      await api.submitAnnotation(payload);
      ui.showToastNotification("Annotation submitted successfully!", "success");
      stopLockTimer();
      state.annotatedInSession++;
      state.totalPapersInQueue--;
      await fetchAndDisplayNextPaper();
    } catch (error) {
      alert("There was an error submitting your annotation. Please try again.");
    } finally {
      ui.setButtonLoading(dom.submitBtn, false, "Submit");
    }
  }

  async function handleSkip() {
    if (!state.currentDataset || !state.currentPaper) return;
    try {
      await api.skipPaper(state.currentDataset, state.currentPaper.doi);
      stopLockTimer();
      state.totalPapersInQueue--;
      await fetchAndDisplayNextPaper();
    } catch (error) {
      alert(
        `An error occurred while trying to skip the paper: ${error.message}`
      );
    }
  }

  async function startLockTimer() {
    stopLockTimer();
    if (!state.currentPaper) return;
    const timerDisplay = document.getElementById("lock-timer-display");
    const countdownElement = document.getElementById("lock-timer-countdown");
    const initialStatus = await api.getLockStatus(state.currentPaper.doi);
    if (!initialStatus.locked || initialStatus.remaining_seconds <= 0) return;
    let remainingSeconds = initialStatus.remaining_seconds;
    let syncCounter = 0;
    function displayTime() {
      if (remainingSeconds <= 0) {
        countdownElement.textContent = "00:00:00";
        timerDisplay.classList.add("hidden");
        ui.showToastNotification(
          "Your lock on this paper has expired.",
          "warning"
        );
        stopLockTimer();
        return;
      }
      const hours = Math.floor(remainingSeconds / 3600);
      const minutes = Math.floor((remainingSeconds % 3600) / 60);
      const seconds = remainingSeconds % 60;
      countdownElement.textContent = `${String(hours).padStart(
        2,
        "0"
      )}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
        2,
        "0"
      )}`;
      timerDisplay.classList.remove("hidden");
    }
    state.lockTimerInterval = setInterval(async () => {
      remainingSeconds--;
      syncCounter++;
      displayTime();
      if (syncCounter >= 120) {
        syncCounter = 0;
        const status = await api.getLockStatus(state.currentPaper.doi);
        if (status.locked) {
          remainingSeconds = status.remaining_seconds;
        } else {
          remainingSeconds = 0;
        }
      }
    }, 1000);
    displayTime();
  }

  function stopLockTimer() {
    if (state.lockTimerInterval) {
      clearInterval(state.lockTimerInterval);
      state.lockTimerInterval = null;
    }
    const timerDisplay = document.getElementById("lock-timer-display");
    if (timerDisplay) {
      timerDisplay.classList.add("hidden");
    }
  }

  async function handleGetSuggestions() {
    const apiKeyResult = await api.checkApiKeyStatus();
    if (!state.currentPaper?.pdf_filename) {
      alert("Cannot get suggestions. The PDF filename is missing.");
      return;
    }
    if (!apiKeyResult.is_set) {
      alert(
        "Please set your Gemini API key in the Settings page before requesting suggestions."
      );
      return;
    }
    const model = localStorage.getItem("geminiModel");
    if (!model) {
      alert("Please select a default AI model in the Settings page.");
      return;
    }
    if (!state.activeTemplate) {
      alert(
        "No active annotation template found. Please configure one in Settings."
      );
      return;
    }
    const originalButtonText = "Get AI Suggestions";
    ui.setButtonLoading(dom.getSuggestionsBtn, true, "Getting Suggestions...");
    try {
      const suggestions = await api.fetchGeminiSuggestions(
        state.currentPaper.pdf_filename,
        model,
        state.activeTemplate
      );
      ui.applyGeminiSuggestions(
        suggestions.GeminiResponse || suggestions,
        state.activeTemplate
      );
      ui.showToastNotification(
        "AI suggestions have been applied to the form.",
        "success"
      );
    } catch (error) {
      ui.showToastNotification(
        `Failed to get AI suggestions: ${error.message}`,
        "error"
      );
    } finally {
      ui.setButtonLoading(dom.getSuggestionsBtn, false, originalButtonText);
    }
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

  function setupReasoningTooltips() {
    if (!dom.reasoningTooltip) return;
    document.addEventListener("mouseover", (e) => {
      const btn = e.target.closest(".reasoning-bubble-btn");
      if (!btn || btn.classList.contains("hidden")) return;
      const text = btn.dataset.reasoningText;
      if (!text) return;
      dom.reasoningTooltip.textContent = text;
      const btnRect = btn.getBoundingClientRect();
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      dom.reasoningTooltip.style.visibility = "hidden";
      dom.reasoningTooltip.style.display = "block";
      const tooltipRect = dom.reasoningTooltip.getBoundingClientRect();
      let top =
        btnRect.top + scrollY + btnRect.height / 2 - tooltipRect.height / 2;
      let left = btnRect.left + scrollX - tooltipRect.width - 12;
      let arrowClass = "arrow-right";
      if (left < 8) {
        left = btnRect.right + scrollX + 12;
        arrowClass = "arrow-left";
      }
      top = Math.max(
        8,
        Math.min(top, window.innerHeight + scrollY - tooltipRect.height - 8)
      );
      dom.reasoningTooltip.style.top = `${top}px`;
      dom.reasoningTooltip.style.left = `${left}px`;
      dom.reasoningTooltip.classList.remove(
        "arrow-right",
        "arrow-left",
        "visible"
      );
      dom.reasoningTooltip.classList.add("visible", arrowClass);
      dom.reasoningTooltip.style.visibility = "visible";
    });
    document.addEventListener("mouseout", (e) => {
      if (
        e.target.closest(".reasoning-bubble-btn") ||
        e.target.closest("#reasoning-tooltip")
      )
        return;
      if (
        e.relatedTarget &&
        (e.relatedTarget.closest(".reasoning-bubble-btn") ||
          e.relatedTarget.closest("#reasoning-tooltip"))
      )
        return;
      dom.reasoningTooltip.classList.remove("visible");
    });
  }

  function setupSettingsAccordions() {
    document
      .querySelectorAll(".settings-accordion-toggle")
      .forEach((button) => {
        button.addEventListener("click", () => {
          button.classList.toggle("active");
          const content = button.nextElementSibling;
          content.classList.toggle("open");
        });
      });
  }

  async function setupSettings() {
    dom.annotatorInput.value = localStorage.getItem("annotatorName") || "";
    const savedPdfOnly = localStorage.getItem("loadPdfOnly");
    loadPdfOnlyToggle.checked =
      savedPdfOnly === null ? true : savedPdfOnly === "true";
    const savedPrioritize = localStorage.getItem("prioritizeIncomplete");
    prioritizeIncompleteToggle.checked =
      savedPrioritize === null ? true : savedPrioritize === "true";
    updateApiKeyStatus();
    updateActiveThemeButton();
    populateAndSetModels();
    dom.annotatorInput.addEventListener("input", () => {
      localStorage.setItem("annotatorName", dom.annotatorInput.value);
    });
    dom.geminiModelSelector.addEventListener("change", () => {
      localStorage.setItem("geminiModel", dom.geminiModelSelector.value);
    });
    dom.saveApiKeyBtn.addEventListener("click", onSaveApiKey);
    themeButtons.forEach((button) => {
      button.addEventListener("click", onThemeChange);
    });
    loadPdfOnlyToggle.addEventListener("change", () => {
      localStorage.setItem("loadPdfOnly", loadPdfOnlyToggle.checked);
    });
    prioritizeIncompleteToggle.addEventListener("change", () => {
      localStorage.setItem(
        "prioritizeIncomplete",
        prioritizeIncompleteToggle.checked
      );
    });
    await templates.initTemplateManager((newTemplate) => {
      buildAnnotationFormFromTemplate(newTemplate);
    });
    await initializeSheetsManagementUI();
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
  }

  function refreshSettingsView() {
    dom.annotatorInput.value = localStorage.getItem("annotatorName") || "";
    const savedPdfOnly = localStorage.getItem("loadPdfOnly");
    loadPdfOnlyToggle.checked =
      savedPdfOnly === null ? true : savedPdfOnly === "true";
    const savedPrioritize = localStorage.getItem("prioritizeIncomplete");
    prioritizeIncompleteToggle.checked =
      savedPrioritize === null ? true : savedPrioritize === "true";
  }

  async function onSaveApiKey() {
    const key = dom.apiKeyInput.value.trim();
    if (!key) {
      alert("Please enter an API key.");
      return;
    }
    dom.saveApiKeyBtn.disabled = true;
    dom.saveApiKeyBtn.textContent = "Saving...";
    try {
      await api.saveApiKey(key);
      dom.apiKeyInput.value = "";
      const setupNowComplete = await runInitialSetupCheck();
      if (setupNowComplete) {
        ui.showToastNotification(
          "API Key saved! Taking you to the annotator...",
          "success"
        );
        await proceedToMainApp();
        showView(dom.mainView);
      } else {
        ui.showToastNotification("API Key saved successfully.", "success");
        updateApiKeyStatus();
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
    } finally {
      dom.saveApiKeyBtn.disabled = false;
      dom.saveApiKeyBtn.textContent = "Save";
      updateApiKeyStatus();
    }
  }

  function onThemeChange(event) {
    const theme = event.currentTarget.dataset.theme;
    document.documentElement.classList.remove(
      "theme-default",
      "theme-glass",
      "theme-warm",
      "theme-cyberpunk",
      "theme-forest"
    );
    document.documentElement.classList.add(`theme-${theme}`);
    localStorage.setItem("theme", theme);
    updateActiveThemeButton();
  }

  async function updateApiKeyStatus() {
    const data = await api.checkApiKeyStatus();
    const setupMessage = document.getElementById("setup-message");
    const allApiKeyStatusElements =
      document.querySelectorAll("#api-key-status");
    allApiKeyStatusElements.forEach((statusEl) => {
      if (data.is_set) {
        statusEl.textContent = "A key is currently set on the server.";
        statusEl.closest(".grid").querySelector("input").placeholder =
          "Enter a new key to overwrite";
      } else {
        statusEl.textContent = "No API key found on the server.";
        statusEl.closest(".grid").querySelector("input").placeholder =
          "Enter your Gemini API Key";
      }
    });
    if (setupMessage) {
      setupMessage.classList.toggle("hidden", data.is_set);
    }
  }

  function updateActiveThemeButton() {
    const currentTheme = localStorage.getItem("theme") || "default";
    themeButtons.forEach((btn) => {
      btn.classList.toggle("active-theme", btn.dataset.theme === currentTheme);
    });
  }

  async function populateAndSetModels() {
    try {
      const models = await api.getGeminiModels();
      const modelSelectors = document.querySelectorAll(
        "#gemini-model-selector"
      );
      modelSelectors.forEach((selector) => {
        if (models && models.length > 0) {
          selector.innerHTML = "";
          models.forEach((modelName) => {
            const option = document.createElement("option");
            option.value = modelName;
            option.textContent = modelName;
            selector.appendChild(option);
          });
          const savedModel = localStorage.getItem("geminiModel");
          if (savedModel && models.includes(savedModel)) {
            selector.value = savedModel;
          } else if (models.length > 0) {
            const defaultModel = models[0];
            localStorage.setItem("geminiModel", defaultModel);
            selector.value = defaultModel;
          }
        } else {
          selector.innerHTML =
            '<option value="">-- No models found --</option>';
        }
      });
    } catch (error) {
      console.error("Could not fetch Gemini models:", error);
      document
        .querySelectorAll("#gemini-model-selector")
        .forEach((selector) => {
          selector.innerHTML =
            '<option value="">-- Error loading models --</option>';
        });
    }
  }

  async function initializeSheetsManagementUI() {
    const container = document.getElementById("sheets-list-container");
    const addForm = document.getElementById("add-sheet-form");
    const addBtn = document.getElementById("add-new-sheet-btn");
    const cancelBtn = document.getElementById("cancel-add-sheet-btn");
    const saveBtn = document.getElementById("save-new-sheet-btn");
    const nameInput = document.getElementById("new-sheet-name");
    const idInput = document.getElementById("new-sheet-id");
    async function renderList() {
      container.innerHTML = "<p>Loading...</p>";
      try {
        const sheets = await api.getSheets();
        container.innerHTML = "";
        if (sheets.length === 0) {
          container.innerHTML =
            '<p class="text-gray-400 text-sm">No sheets configured yet.</p>';
        } else {
          sheets.forEach((sheet) => {
            const div = document.createElement("div");
            div.className =
              "flex justify-between items-center bg-black bg-opacity-20 p-2 rounded-lg";
            div.innerHTML = `<div><p class="font-semibold">${sheet.name}</p><p class="text-xs text-gray-400">${sheet.id}</p></div><button data-id="${sheet.id}" class="delete-sheet-btn text-red-400 hover:text-red-200 p-2 rounded-full">🗑️</button>`;
            container.appendChild(div);
          });
        }
      } catch (error) {
        container.innerHTML = `<p class="text-red-400">Error loading sheets: ${error.message}</p>`;
      }
    }
    container.addEventListener("click", async (e) => {
      if (e.target.closest(".delete-sheet-btn")) {
        const idToDelete = e.target.closest(".delete-sheet-btn").dataset.id;
        if (
          confirm("Are you sure you want to delete this sheet configuration?")
        ) {
          try {
            await api.deleteSheet(idToDelete);
            await renderList();
            await initializeSheetSelector();
            ui.showToastNotification("Sheet deleted.", "success");
          } catch (error) {
            alert(`Error: ${error.message}`);
          }
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
      idInput.value = "";
    });
    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const id = idInput.value.trim();
      if (!name || !id) {
        alert("Both Sheet Name and ID are required.");
        return;
      }
      try {
        await api.addSheet(name, id);
        await renderList();
        await initializeSheetSelector();
        ui.showToastNotification("Sheet saved.", "success");
        cancelBtn.click();
      } catch (error) {
        alert(`Error saving sheet: ${error.message}`);
      }
    });
    await renderList();
  }

  async function showStatsView() {
    const statsLoading = document.getElementById("stats-loading");
    const statsContent = document.getElementById("stats-content");
    const statsError = document.getElementById("stats-error");
    statsLoading.classList.remove("hidden");
    statsContent.classList.add("hidden");
    statsError.classList.add("hidden");
    try {
      const [detailedStats, summaryStats] = await Promise.all([
        api.getDetailedStats(),
        api.getSheetStats(),
      ]);
      ui.renderDetailedStats(detailedStats, summaryStats);
      statsContent.classList.remove("hidden");
    } catch (error) {
      console.error("Failed to load detailed stats:", error);
      statsError.classList.remove("hidden");
    } finally {
      statsLoading.classList.add("hidden");
    }
  }

  async function loadGuideContent() {
    const guideContainer = document.querySelector("#guide-view main");
    if (!guideContainer || guideContainer.dataset.loaded) return;
    try {
      const response = await fetch("/static/guide.html");
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);
      const text = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");
      const guideMainContent = doc.querySelector("main");
      if (guideMainContent) {
        guideContainer.innerHTML = "";
        guideContainer.appendChild(guideMainContent);
        guideContainer.dataset.loaded = "true";
      } else {
        throw new Error("<main> element not found in guide.html");
      }
    } catch (error) {
      guideContainer.innerHTML =
        '<p class="text-red-400 p-6">Error loading guide. Please check the console and ensure guide.html exists.</p>';
      console.error("Failed to load and inject guide content:", error);
    }
  }

  function updateActiveNavButton(activeView) {
    document
      .querySelectorAll(".nav-btn")
      .forEach((btn) => btn.classList.remove("active-nav"));
    const targetViewId = activeView.id;
    const buttonsToActivate = document.querySelectorAll(
      `.nav-btn[data-target-view="${targetViewId}"]`
    );
    buttonsToActivate.forEach((btn) => btn.classList.add("active-nav"));
  }

  function showView(viewToShow) {
    if (!dom.mainView.classList.contains("hidden")) {
      stopLockTimer();
    }
    dom.mainView.classList.add("hidden");
    dom.settingsView.classList.add("hidden");
    dom.guideView.classList.add("hidden");
    dom.statsView.classList.add("hidden");
    switch (viewToShow) {
      case dom.mainView:
        if (state.currentPaper) {
          startLockTimer();
        }
        break;
      case dom.settingsView:
        refreshSettingsView();
        updateApiKeyStatus();
        break;
      case dom.statsView:
        showStatsView();
        break;
      case dom.guideView:
        loadGuideContent();
        break;
    }
    viewToShow.classList.remove("hidden");
    updateActiveNavButton(viewToShow);
  }

  function setupViewSwitching() {
    document.body.addEventListener("click", async (e) => {
      const navBtn = e.target.closest(".nav-btn");
      if (!navBtn || !navBtn.dataset.targetView) return;
      const targetViewId = navBtn.dataset.targetView;
      const targetView = document.getElementById(targetViewId);
      if (!targetView) return;
      if (targetViewId === "main-view") {
        const canProceed = await runInitialSetupCheck();
        if (canProceed) {
          showView(targetView);
        } else {
          ui.showToastNotification(
            "Please complete setup in Settings before proceeding.",
            "warning"
          );
        }
      } else {
        showView(targetView);
      }
    });
  }

  async function runInitialSetupCheck() {
    try {
      const apiKeyStatus = await api.checkApiKeyStatus();
      const annotatorName = localStorage.getItem("annotatorName");
      const setupMessage = document.getElementById("setup-message");
      if (!apiKeyStatus.is_set || !annotatorName) {
        if (setupMessage) setupMessage.classList.remove("hidden");
        showView(dom.settingsView);
        return false;
      }
      if (setupMessage) setupMessage.classList.add("hidden");
      return true;
    } catch (error) {
      alert(
        "Could not connect to the backend server. Please restart the application."
      );
      return false;
    }
  }

  async function proceedToMainApp() {
    if (state.isAppInitialized) return;
    try {
      const activeTemplate = templates.getActiveTemplate();
      buildAnnotationFormFromTemplate(activeTemplate);
      await initializeSheetSelector();
      state.isAppInitialized = true;
    } catch (error) {
      alert(
        "Could not connect to the backend. Please ensure the server is running."
      );
    }
  }

  async function handleManualPdfUpload(event) {
    const fileInput = event.target;
    const file = fileInput.files[0];
    if (!file) return;
    const expectedFilename = fileInput.dataset.expectedFilename;
    if (!expectedFilename) {
      alert("Error: Could not determine the expected filename for the upload.");
      return;
    }
    try {
      ui.showLoading("Uploading & Renaming PDF", "Please wait...");
      const result = await api.uploadPdf(file, expectedFilename);
      ui.showToastNotification(
        `PDF uploaded as "${result.filename}"!`,
        "success"
      );
      dom.pdfViewerContainer.innerHTML = `<h3 class="text-lg font-semibold text-white mb-4">PDF Viewer</h3><iframe class="pdf-iframe" src="${result.url}#view=FitH" type="application/pdf"></iframe>`;
      if (state.currentPaper) {
        state.currentPaper.pdf_filename = result.filename;
      }
    } catch (error) {
      alert(`Failed to upload PDF: ${error.message}`);
    } finally {
      ui.hideLoading();
      fileInput.value = "";
    }
  }

  async function init() {
    await waitForServerReady();
    setupPanelResizing();
    const isWidescreenOnLoad = localStorage.getItem("widescreen") === "true";
    document.querySelectorAll(".page-container").forEach((container) => {
      container.classList.toggle("widescreen", isWidescreenOnLoad);
    });
    setWidescreenIcon(isWidescreenOnLoad);
    const storageKey = isWidescreenOnLoad
      ? "panelLayoutWide"
      : "panelLayoutNarrow";
    const savedLayout = localStorage.getItem(storageKey);
    if (savedLayout && window.innerWidth >= 1024) {
      mainContentGrid.style.gridTemplateColumns = savedLayout;
    }
    setupReasoningTooltips();
    ui.setupFieldActionControls();
    setupSettingsAccordions();
    await setupSettings();
    setupViewSwitching();
    dom.sheetSelector.addEventListener("change", handleSheetChange);
    dom.datasetSelector.addEventListener("change", handleDatasetChange);
    dom.submitBtn.addEventListener("click", submitAnnotation);
    dom.skipBtn.addEventListener("click", handleSkip);
    dom.getSuggestionsBtn.addEventListener("click", handleGetSuggestions);
    dom.annotationFieldsContainer.addEventListener("click", (event) => {
      const lockBtn = event.target.closest(".autofill-lock-btn");
      if (lockBtn) {
        const fieldId = lockBtn.dataset.targetLock;
        const fieldEl = document.getElementById(fieldId);
        const fieldLabel =
          state.activeTemplate.fields.find((f) => f.id === fieldId)?.label ||
          fieldId;
        if (fieldEl) {
          const isNowLocked = !(fieldEl.dataset.locked === "true");
          fieldEl.dataset.locked = isNowLocked;
          lockBtn
            .querySelector(".icon-unlocked")
            .classList.toggle("hidden", isNowLocked);
          lockBtn
            .querySelector(".icon-locked")
            .classList.toggle("hidden", !isNowLocked);
          lockBtn.classList.toggle("active", isNowLocked);
          const message = isNowLocked
            ? `Field '${fieldLabel}' is now locked and will not be auto-filled.`
            : `Field '${fieldLabel}' is now unlocked and can be auto-filled.`;
          ui.showToastNotification(message, "info");
        }
        return;
      }
    });
    dom.annotationFieldsContainer.addEventListener("change", (event) => {
      if (!event.isTrusted) return;
      const fieldEl = event.target;
      if (fieldEl.dataset.autofilledBy) {
        if (!fieldEl.dataset.locked || fieldEl.dataset.locked === "false") {
          const lockButton = fieldEl
            .closest(".annotation-row")
            .querySelector(".autofill-lock-btn");
          if (lockButton) {
            lockButton.click();
          }
        }
        delete fieldEl.dataset.autofilledBy;
      }
    });
    document.body.addEventListener("click", (event) => {
      if (event.target.id === "manual-upload-trigger") {
        const uploader = document.getElementById("manual-pdf-upload");
        if (uploader) {
          uploader.dataset.expectedFilename =
            event.target.dataset.expectedFilename;
          uploader.click();
        }
      }
    });
    document.body.addEventListener("change", (event) => {
      if (event.target.id === "manual-pdf-upload") {
        handleManualPdfUpload(event);
      }
    });
    document.querySelectorAll(".widescreen-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pageContainers = document.querySelectorAll(".page-container");
        if (pageContainers.length === 0) return;
        const isNowWidescreen =
          pageContainers[0].classList.toggle("widescreen");
        for (let i = 1; i < pageContainers.length; i++) {
          pageContainers[i].classList.toggle("widescreen", isNowWidescreen);
        }
        localStorage.setItem("widescreen", isNowWidescreen);
        const newStorageKey = isNowWidescreen
          ? "panelLayoutWide"
          : "panelLayoutNarrow";
        const layoutForNewMode = localStorage.getItem(newStorageKey);
        if (layoutForNewMode && window.innerWidth >= 1024) {
          mainContentGrid.style.gridTemplateColumns = layoutForNewMode;
        } else {
          mainContentGrid.style.gridTemplateColumns = "";
        }
        setWidescreenIcon(isNowWidescreen);
      });
    });
    dom.paperContentContainer.addEventListener("scroll", () => {
      window.requestAnimationFrame(() =>
        highlighting.updateScrollGlows(state.activeHighlightIds)
      );
    });
    dom.openDataFolderBtnMain.addEventListener("click", api.openDataFolder);
    dom.openDataFolderBtnSettings.addEventListener("click", api.openDataFolder);
    dom.refreshDatasetsBtn.addEventListener("click", refreshDatasetSelectors);
    if (updateNowBannerBtn) {
      updateNowBannerBtn.addEventListener("click", () => {
        if (
          confirm(
            "This will update the application and restart it. Are you sure?"
          )
        ) {
          const btn = updateNowBannerBtn;
          btn.textContent = "Updating...";
          btn.disabled = true;
          ui.showToastNotification(
            "Update started. The application will restart shortly...",
            "info"
          );
          api.triggerUpdateAndRestart();
        }
      });
    }
    const setupComplete = await runInitialSetupCheck();
    if (setupComplete) {
      showView(dom.mainView);
      await proceedToMainApp();
      await runStartupUpdateCheck();
    }
  }

  try {
    init();
  } catch (error) {
    console.error(
      "A critical error occurred during application initialization:",
      error
    );
    document.body.innerHTML = `<div style="padding: 2rem; color: white; font-family: sans-serif;"><h1>Application Failed to Start</h1><p>A critical error prevented the application from loading. Please check the browser's developer console (F12) for more details and restart the application.</p><p><strong>Error:</strong> ${error.message}</p></div>`;
  }
});
