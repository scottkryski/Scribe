import * as dom from "./scripts/domElements.js";
import * as api from "./scripts/api.js";
import * as ui from "./scripts/ui.js";
import * as highlighting from "./scripts/highlighting.js";
import * as templates from "./scripts/templates.js";

document.addEventListener("DOMContentLoaded", () => {
  // Initialize all DOM element references safely
  dom.init();

  // --- STATE MANAGEMENT ---
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
    isAppInitialized: false, // Prevents re-initialization of dataset logic
  };

  // --- DOM ELEMENT REFERENCES ---
  const mainContentGrid = document.getElementById("main-content-grid");
  const resizeHandle = document.getElementById("resize-handle");
  const themeButtons = document.querySelectorAll(".theme-btn");
  const loadPdfOnlyToggle = document.getElementById("load-pdf-only-toggle");
  const prioritizeIncompleteToggle = document.getElementById(
    "prioritize-incomplete-toggle"
  );
  const noDatasetsMessage = document.getElementById("no-datasets-message");
  const openDataFolderBtn = document.getElementById("open-data-folder-btn");
  const updateNotificationBanner = document.getElementById(
    "update-notification-banner"
  );
  const updateNowBannerBtn = document.getElementById("update-now-banner-btn");
  const manualPdfUploadInput = document.getElementById("manual-pdf-upload");

  // Update Functions
  async function runStartupUpdateCheck() {
    try {
      const result = await api.checkForUpdates();
      if (result.update_available) {
        // Show the banner if an update is available
        if (updateNotificationBanner) {
          updateNotificationBanner.classList.remove("hidden");
        }
      }
    } catch (error) {
      // Fail silently on startup. The user can still check manually in settings.
      console.warn("Could not check for updates on startup:", error.message);
    }
  }

  // =================================================================
  //  RESIZING LOGIC
  // =================================================================
  function setupPanelResizing() {
    if (!resizeHandle || !mainContentGrid) return;

    const onMouseDown = (e) => {
      e.preventDefault();
      resizeHandle.classList.add("is-resizing");

      const onMouseMove = (moveEvent) => {
        const parentRect = mainContentGrid.getBoundingClientRect();
        const minWidth = 320; // Minimum width in pixels for panels
        const handleWidth = resizeHandle.offsetWidth;

        // Calculate new width for the paper panel
        let newPaperWidth = moveEvent.clientX - parentRect.left;

        // Enforce minimum width for the left panel
        if (newPaperWidth < minWidth) {
          newPaperWidth = minWidth;
        }

        // Enforce minimum width for the right panel
        if (parentRect.width - newPaperWidth - handleWidth < minWidth) {
          newPaperWidth = parentRect.width - minWidth - handleWidth;
        }

        // Set the grid template with explicit widths to avoid gap issues
        mainContentGrid.style.gridTemplateColumns = `${newPaperWidth}px ${handleWidth}px 1fr`;
      };

      const onMouseUp = () => {
        resizeHandle.classList.remove("is-resizing");
        if (mainContentGrid.style.gridTemplateColumns) {
          // Save layout based on widescreen state
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
      mainContentGrid.style.gridTemplateColumns = ""; // Reset to CSS default
      // Remove both layout keys
      localStorage.removeItem("panelLayoutNarrow");
      localStorage.removeItem("panelLayoutWide");
    };

    resizeHandle.addEventListener("mousedown", onMouseDown);
    resizeHandle.addEventListener("dblclick", onDoubleClick);
  }

  // =================================================================
  //  MAIN ANNOTATOR LOGIC
  // =================================================================

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

  function buildAnnotationFormFromTemplate(template) {
    if (!template || !template.fields) {
      console.error("Invalid or missing template for form building.");
      dom.annotationFieldsContainer.innerHTML =
        '<p class="text-red-400">Error: Could not load annotation template.</p>';
      return;
    }
    state.activeTemplate = template;
    dom.annotationFieldsContainer.innerHTML = ""; // Clear existing form

    template.fields.forEach((field) => {
      const row = document.createElement("div");
      row.className = "annotation-row glass-effect rounded-xl p-3";

      let controlHTML = "";
      if (field.type === "boolean") {
        controlHTML = `<label class="toggle-switch"><input type="checkbox" id="${field.id}" name="${field.id}" data-context-target="${field.id}_context"><span class="slider"></span></label>`;
      } else if (field.type === "select") {
        const optionsHTML = field.options
          .map((opt) => `<option value="${opt}">${opt}</option>`)
          .join("");
        controlHTML = `
          <select id="${field.id}" name="${field.id}" data-context-target="${field.id}_context" class="custom-select w-48 p-2 bg-white bg-opacity-10 rounded-lg text-white text-sm">
              <option value="">[Select One]</option>
              ${optionsHTML}
          </select>`;
      }

      const highlightButtonHTML =
        field.keywords && field.keywords.length > 0
          ? `
          <button type="button" class="highlight-toggle-btn" data-highlight-trigger="${field.id}" title="Toggle keyword highlights">
              <svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
          </button>`
          : "";

      row.innerHTML = `
        <div class="flex items-center justify-between">
            <div class="flex items-center space-x-2">
                ${highlightButtonHTML}
                <label for="${field.id}" class="text-gray-200 text-sm">${field.label}</label>
                <button type="button" class="reasoning-bubble-btn hidden" data-reasoning-target="${field.id}" aria-label="Show AI reasoning"><svg class="h-4 w-4 text-gray-300 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg></button>
            </div>
            ${controlHTML}
        </div>
        <div id="${field.id}_context" class="hidden mt-2">
            <textarea name="${field.id}_context" class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white placeholder-gray-200 text-sm" rows="3" placeholder="Context for '${field.label}'"></textarea>
        </div>
      `;
      dom.annotationFieldsContainer.appendChild(row);
    });

    // Re-attach event listeners for newly created elements
    ui.setupContextToggles();
    document
      .querySelectorAll(".highlight-toggle-btn")
      .forEach((btn) => btn.addEventListener("click", onHighlightToggle));
  }

  async function handleDatasetChange() {
    const selectedDataset = dom.datasetSelector.value;
    if (!selectedDataset || !state.currentSheetId) {
      // Don't proceed if no dataset or sheet is selected
      return;
    }
    state.currentDataset = selectedDataset;
    localStorage.setItem(
      `currentDataset_${state.currentSheetId}`,
      selectedDataset
    );

    ui.showLoading("Loading Dataset", "Filtering against sheet records...");
    try {
      const result = await api.loadDataset(state.currentDataset);
      state.totalPapersInQueue = result.queued_count;
      state.annotatedInSession = 0;
      await fetchAndDisplayNextPaper();
    } catch (error) {
      ui.hideLoading();
      alert(`Error loading dataset: ${error.message}`);
    }
  }

  async function handleSheetChange() {
    const selectedSheetId = dom.sheetSelector.value;
    if (!selectedSheetId) {
      // Reset UI if no sheet is selected
      dom.datasetSelector.disabled = true;
      dom.datasetSelector.innerHTML =
        '<option value="">Select Dataset</option>';
      return;
    }

    ui.showLoading("Connecting to Sheet", "Loading sheet metadata...");
    try {
      // We still call connectToSheet to load the data, we just don't display the count in the header
      await api.connectToSheet(selectedSheetId);
      state.currentSheetId = selectedSheetId;
      localStorage.setItem("currentSheetId", selectedSheetId); // Save active sheet

      // Populate and enable dataset selector
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

      // Try to load the last used dataset for this sheet
      const lastDataset = localStorage.getItem(
        `currentDataset_${selectedSheetId}`
      );
      if (lastDataset && datasets.includes(lastDataset)) {
        dom.datasetSelector.value = lastDataset;
        await handleDatasetChange(); // This will fetch the first paper
      } else {
        dom.paperView.classList.remove("hidden");
        dom.paperTitle.textContent = "Select a dataset to begin...";
        dom.paperContentContainer.classList.add("hidden");
        dom.annotationView.classList.add("hidden");
      }

      ui.showToastNotification("Successfully connected to sheet.", "success");
    } catch (error) {
      alert(`Failed to connect to sheet: ${error.message}`);
      dom.sheetSelector.value = ""; // Reset dropdown on failure
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
        // If no sheet is selected, still populate the dataset list initially
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
        // Restore previous selection if it still exists
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

  async function fetchAndDisplayNextPaper(retryCount = 0) {
    if (!state.currentDataset) return;

    stopLockTimer();
    // Only show the full loading overlay on the first attempt
    if (retryCount === 0) {
      ui.showLoading(
        "Finding & Loading Paper",
        "Please wait while we fetch the data and PDF..."
      );
    }

    try {
      state.currentPaper = await api.fetchNextPaper(state.currentDataset);

      // Make the main panels visible now that we have data
      dom.paperView.classList.remove("hidden");
      dom.annotationView.classList.remove("hidden");
      dom.paperContentContainer.classList.remove("hidden");

      if (window.innerWidth >= 1024) {
        resizeHandle.style.display = "flex";
      } else {
        resizeHandle.style.display = "none";
      }

      const { originalAbstractHTML, originalFullTextHTML } =
        await ui.renderPaper(state.currentPaper);

      // --- Pass the initial lock info from the API response ---
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
      // Hide loading on success
      ui.hideLoading();
    } catch (error) {
      // If the paper was locked by someone else, and we haven't retried too many times...
      if (error.message.includes("locked by another user") && retryCount < 5) {
        console.warn(
          `Attempt ${retryCount + 1}: Paper was locked, retrying...`
        );
        ui.showToastNotification(
          "That paper was just taken. Finding another...",
          "info"
        );
        // Automatically try to get the next paper again after a short delay.
        await new Promise((resolve) => setTimeout(resolve, 500));
        return fetchAndDisplayNextPaper(retryCount + 1);
      }

      // For any other error, or if we've retried too many times, show the final alert.
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
        if (field.type === "boolean") {
          annotations[field.id] = element.checked ? "TRUE" : "FALSE";
        } else {
          annotations[field.id] = element.value;
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
      // This will restore the button if fetchAndDisplayNextPaper fails,
      // allowing the user to try again. If it succeeds, the button is re-rendered anyway.
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
    stopLockTimer(); // Always clear any previous timer

    if (!state.currentPaper) return;

    const timerDisplay = document.getElementById("lock-timer-display");
    const countdownElement = document.getElementById("lock-timer-countdown");

    // Always fetch the latest status from the server when starting a timer.
    // This makes the logic robust and simple.
    const initialStatus = await api.getLockStatus(state.currentPaper.doi);

    if (!initialStatus.locked || initialStatus.remaining_seconds <= 0) {
      return; // No active lock, so don't start the timer.
    }

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

    // The main timer interval that runs every second
    state.lockTimerInterval = setInterval(async () => {
      remainingSeconds--;
      syncCounter++;
      displayTime(); // Update the UI every second

      // Every 30 seconds, sync with the server to correct any drift
      if (syncCounter >= 120) {
        syncCounter = 0;
        const status = await api.getLockStatus(state.currentPaper.doi);
        if (status.locked) {
          // Correct our local timer with the official server time
          remainingSeconds = status.remaining_seconds;
        } else {
          // If the server says the lock is gone, stop the timer
          remainingSeconds = 0;
        }
      }
    }, 1000); // Run this function every 1000ms (1 second)

    // Display the initial time immediately after fetching it
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
    const isApiKeySet = apiKeyResult.is_set;

    if (!state.currentPaper?.pdf_filename) {
      alert("Cannot get suggestions. The PDF filename is missing.");
      return;
    }
    if (!isApiKeySet) {
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

  // =================================================================
  //  SETTINGS PAGE LOGIC
  // =================================================================

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
    // Load saved values from localStorage
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

    // Initialize the template manager and AWAIT its completion
    await templates.initTemplateManager((newTemplate) => {
      buildAnnotationFormFromTemplate(newTemplate);
    });

    // Initialize the new Sheets Management UI
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
              // We don't wait for this, as the server will die
              api.triggerUpdateAndRestart();
            }
          } else {
            ui.showToastNotification(result.message, "success");
          }
        } catch (error) {
          alert(`Error: ${error.message}`);
        } finally {
          // Only re-enable the button if no update was started
          updateBtn.textContent = originalText;
          updateBtn.disabled = false;
        }
      });
    }
  }

  function refreshSettingsView() {
    // This function is called every time the settings view is shown.
    // It populates fields with the latest saved values.
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
      dom.apiKeyInput.value = ""; // Clear input on success

      // After saving, re-run the setup check.
      const setupNowComplete = await runInitialSetupCheck();

      if (setupNowComplete) {
        // If setup is now complete, initialize the main app logic
        // and switch the user to the annotator view.
        ui.showToastNotification(
          "API Key saved! Taking you to the annotator...",
          "success"
        );
        await proceedToMainApp();
        showView(dom.mainView);
      } else {
        // If setup is still not complete (e.g., annotator name is missing),
        // just update the status on the settings page.
        ui.showToastNotification("API Key saved successfully.", "success");
        updateApiKeyStatus();
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
    } finally {
      dom.saveApiKeyBtn.disabled = false;
      dom.saveApiKeyBtn.textContent = "Save";
      // This is now redundant if the above logic works, but safe to keep.
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
            div.innerHTML = `
                        <div>
                            <p class="font-semibold">${sheet.name}</p>
                            <p class="text-xs text-gray-400">${sheet.id}</p>
                        </div>
                        <button data-id="${sheet.id}" class="delete-sheet-btn text-red-400 hover:text-red-200 p-2 rounded-full">🗑️</button>
                    `;
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
            await initializeSheetSelector(); // Refresh main page dropdown
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
        await initializeSheetSelector(); // Refresh main page dropdown
        ui.showToastNotification("Sheet saved.", "success");
        cancelBtn.click(); // Hide form and clear inputs
      } catch (error) {
        alert(`Error saving sheet: ${error.message}`);
      }
    });

    await renderList();
  }

  // =================================================================
  //  SPA VIEW SWITCHING LOGIC
  // =================================================================

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
    if (!guideContainer || guideContainer.dataset.loaded) return; // Exit if no container or already loaded

    try {
      const response = await fetch("/static/guide.html");
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);

      const text = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");
      const guideMainContent = doc.querySelector("main");

      if (guideMainContent) {
        guideContainer.innerHTML = ""; // Clear loading spinner
        guideContainer.appendChild(guideMainContent);
        guideContainer.dataset.loaded = "true"; // Mark as loaded
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
    // 1. Stop any background processes from the view we are leaving.
    if (!dom.mainView.classList.contains("hidden")) {
      stopLockTimer();
    }

    // 2. Hide all views first.
    dom.mainView.classList.add("hidden");
    dom.settingsView.classList.add("hidden");
    dom.guideView.classList.add("hidden");
    dom.statsView.classList.add("hidden");

    // 3. Prepare and show the new view.
    switch (viewToShow) {
      case dom.mainView:
        // If a paper is loaded, restart its timer by fetching the current status.
        if (state.currentPaper) {
          startLockTimer();
        }
        break;
      case dom.settingsView:
        refreshSettingsView();
        updateApiKeyStatus(); // Also refresh API key status when showing settings
        break;
      case dom.statsView:
        showStatsView();
        break;
      case dom.guideView:
        loadGuideContent(); // Fetch and inject the guide content
        break;
    }

    // 4. Finally, make the correct view visible and update nav icon.
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

  // =================================================================
  //  INITIALIZATION
  // =================================================================

  async function runInitialSetupCheck() {
    try {
      const apiKeyStatus = await api.checkApiKeyStatus();
      const annotatorName = localStorage.getItem("annotatorName");
      const setupMessage = document.getElementById("setup-message");

      if (!apiKeyStatus.is_set || !annotatorName) {
        console.log("Setup incomplete. Forcing settings view.");
        if (setupMessage) setupMessage.classList.remove("hidden");
        showView(dom.settingsView);
        return false; // Indicates setup is not complete
      }

      console.log("Setup complete. Proceeding to main application.");
      if (setupMessage) setupMessage.classList.add("hidden");
      return true; // Indicates setup is complete
    } catch (error) {
      alert(
        "Could not connect to the backend server. Please restart the application."
      );
      return false;
    }
  }

  async function proceedToMainApp() {
    if (state.isAppInitialized) return; // Don't re-run if already done

    try {
      // Build the form based on the active template
      const activeTemplate = templates.getActiveTemplate();
      buildAnnotationFormFromTemplate(activeTemplate);

      // This function will handle populating the sheet selector
      // and triggering the rest of the loading cascade.
      await initializeSheetSelector();

      state.isAppInitialized = true; // Mark as initialized
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

    // Get the expected filename that was stored on the input element
    const expectedFilename = fileInput.dataset.expectedFilename;

    // The confirmation dialog has been removed.
    if (!expectedFilename) {
      alert("Error: Could not determine the expected filename for the upload.");
      return;
    }

    try {
      ui.showLoading("Uploading & Renaming PDF", "Please wait...");
      // Call the updated API function with both the file and the desired name
      const result = await api.uploadPdf(file, expectedFilename);

      ui.showToastNotification(
        `PDF uploaded as "${result.filename}"!`,
        "success"
      );

      // Reload the PDF viewer with the newly uploaded and correctly named file
      dom.pdfViewerContainer.innerHTML = `<h3 class="text-lg font-semibold text-white mb-4">PDF Viewer</h3><iframe class="pdf-iframe" src="${result.url}#view=FitH" type="application/pdf"></iframe>`;

      // Update the application's state with the correct, new filename
      if (state.currentPaper) {
        state.currentPaper.pdf_filename = result.filename;
      }
    } catch (error) {
      alert(`Failed to upload PDF: ${error.message}`);
    } finally {
      ui.hideLoading();
      fileInput.value = ""; // Reset the file input
    }
  }

  function setupManualUploadListener() {
    // Use event delegation on a static parent.
    dom.pdfViewerContainer.addEventListener("click", (event) => {
      if (event.target.id === "manual-upload-trigger") {
        const uploader = document.getElementById("manual-pdf-upload");
        uploader.dataset.expectedFilename =
          event.target.dataset.expectedFilename;
        uploader.click();
      }
    });
  }

  // scripts/script.js

  async function init() {
    // Setup for main annotation view
    setupPanelResizing();

    // Apply widescreen from localStorage to all containers
    const isWidescreenOnLoad = localStorage.getItem("widescreen") === "true";
    document.querySelectorAll(".page-container").forEach((container) => {
      container.classList.toggle("widescreen", isWidescreenOnLoad);
    });
    setWidescreenIcon(isWidescreenOnLoad);

    // Apply saved panel layout based on current widescreen state
    const storageKey = isWidescreenOnLoad
      ? "panelLayoutWide"
      : "panelLayoutNarrow";
    const savedLayout = localStorage.getItem(storageKey);
    if (savedLayout && window.innerWidth >= 1024) {
      mainContentGrid.style.gridTemplateColumns = savedLayout;
    }

    setupReasoningTooltips();
    setupSettingsAccordions();

    // Setup for settings page
    await setupSettings();

    // Setup for SPA navigation
    setupViewSwitching();

    // Add event listeners for main page controls (static elements)
    dom.sheetSelector.addEventListener("change", handleSheetChange);
    dom.datasetSelector.addEventListener("change", handleDatasetChange);
    dom.submitBtn.addEventListener("click", submitAnnotation);
    dom.skipBtn.addEventListener("click", handleSkip);
    dom.getSuggestionsBtn.addEventListener("click", handleGetSuggestions);

    // --- DELEGATED EVENT LISTENERS FOR DYNAMIC CONTENT ---
    // This is the main change. We listen on `document.body` which always exists.
    document.body.addEventListener("click", (event) => {
      // This part handles clicking the "Upload Manually" button.
      if (event.target.id === "manual-upload-trigger") {
        const uploader = document.getElementById("manual-pdf-upload");
        if (uploader) {
          // Pass the expected filename from the button to the input
          uploader.dataset.expectedFilename =
            event.target.dataset.expectedFilename;
          uploader.click(); // Programmatically click the hidden file input
        }
      }
    });

    document.body.addEventListener("change", (event) => {
      // This part handles what happens after you've selected a file.
      if (event.target.id === "manual-pdf-upload") {
        handleManualPdfUpload(event);
      }
    });

    // Widescreen toggle resets/applies the correct layout
    document.querySelectorAll(".widescreen-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pageContainers = document.querySelectorAll(".page-container");
        if (pageContainers.length === 0) return;

        // Toggle the class and check the new state
        const isNowWidescreen =
          pageContainers[0].classList.toggle("widescreen");

        // Apply the same state to all other page containers
        for (let i = 1; i < pageContainers.length; i++) {
          pageContainers[i].classList.toggle("widescreen", isNowWidescreen);
        }

        // Save the new state
        localStorage.setItem("widescreen", isNowWidescreen);

        // Determine which saved layout to use for the new mode
        const newStorageKey = isNowWidescreen
          ? "panelLayoutWide"
          : "panelLayoutNarrow";
        const layoutForNewMode = localStorage.getItem(newStorageKey);

        // Apply the saved layout or reset to default
        if (layoutForNewMode && window.innerWidth >= 1024) {
          mainContentGrid.style.gridTemplateColumns = layoutForNewMode;
        } else {
          mainContentGrid.style.gridTemplateColumns = "";
        }

        // Update the button icon
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
          // We use the same API calls as the settings button
          ui.showToastNotification(
            "Update started. The application will restart shortly...",
            "info"
          );
          api.triggerUpdateAndRestart();
        }
      });
    }

    // --- CORE STARTUP LOGIC ---
    const setupComplete = await runInitialSetupCheck();
    if (setupComplete) {
      showView(dom.mainView);
      await proceedToMainApp();
      await runStartupUpdateCheck(); // Check for updates after the main app is ready
    }
  }

  try {
    init();
  } catch (error) {
    console.error(
      "A critical error occurred during application initialization:",
      error
    );
    document.body.innerHTML = `
      <div style="padding: 2rem; color: white; font-family: sans-serif;">
        <h1>Application Failed to Start</h1>
        <p>A critical error prevented the application from loading. Please check the browser's developer console (F12) for more details and restart the application.</p>
        <p><strong>Error:</strong> ${error.message}</p>
      </div>
    `;
  }
});
