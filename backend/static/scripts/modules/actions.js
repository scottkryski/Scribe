// frontend/static/scripts/modules/actions.js
import * as dom from "../domElements.js";
import * as api from "../api.js";
import * as ui from "../ui.js";
import * as highlighting from "../highlighting.js";
import { startLockTimer, stopLockTimer } from "./lockTimer.js";
import * as templates from "../templates.js";

let state = {};
let buildAnnotationFormFromTemplateRef;
let dashboardModule = null; // FIX: Add a reference to the dashboard module

// --- FIX: Moved template polling logic here to fix scope issues ---
async function checkTemplateForUpdates() {
  if (!state.currentSheetId || !state.sheetTemplateTimestamp) {
    return;
  }
  ui.showToastNotification(
    "Checking for template updates...",
    "checking",
    2000
  );
  const status = await api.getSheetTemplateStatus(state.currentSheetId);
  const banner = document.getElementById("template-update-banner");
  if (status && status.last_updated) {
    if (status.last_updated > state.sheetTemplateTimestamp) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }
}

function startTemplatePolling() {
  stopTemplatePolling();
  if (state.sheetTemplateTimestamp) {
    state.templatePollInterval = setInterval(checkTemplateForUpdates, 30000);
  }
}

function stopTemplatePolling() {
  if (state.templatePollInterval) {
    clearInterval(state.templatePollInterval);
    state.templatePollInterval = null;
  }
  document.getElementById("template-update-banner").classList.add("hidden");
}

// --- Helper function to avoid code duplication in submit actions ---
async function performSubmit(buttonToLoad) {
  const annotatorName = localStorage.getItem("annotatorName") || "";
  if (!state.currentPaper || !annotatorName) {
    alert("Please set your Annotator Name in Settings before submitting.");
    return { success: false };
  }
  const annotations = {};
    state.activeTemplate.fields.forEach((field) => {
      const element = document.getElementById(field.id);
      if (element) {
        let value = element.value;
        if (field.type === "boolean") {
          if (value === "true") value = true;
          else if (value === "false") value = false;
          else value = null;
        } else if (field.type === "checklist") {
          try {
            const parsed = JSON.parse(value || "{}");
            value = parsed && typeof parsed === "object" ? parsed : {};
          } catch (error) {
            console.warn(`Failed to parse checklist value for ${field.id}`, error);
            value = {};
          }
        }
        annotations[field.id] = value;
        const contextEl = document.querySelector(`[name="${field.id}_context"]`);
        if (contextEl) annotations[`${field.id}_context`] = contextEl.value;
      }
  });
  const payload = {
    dataset: state.currentDataset,
    doi: state.currentPaper.doi,
    title: state.currentPaper.title,
    annotator: annotatorName,
    annotations: annotations,
  };

  ui.setButtonLoading(buttonToLoad, true, "Submitting...");
  try {
    await api.submitAnnotation(payload);

    // --- THIS BLOCK IS NOW REMOVED ---
    // const pendingCorrectionJSON = sessionStorage.getItem('pendingCorrection');
    // ... (all the logic inside this block) ...
    // sessionStorage.removeItem('pendingCorrection');

    return { success: true, payload };
  } catch (error) {
    alert("Submission error. Please try again.");
    ui.setButtonLoading(buttonToLoad, false, buttonToLoad.textContent);
    return { success: false };
  }
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
        button.classList.toggle("active", button.dataset.value === valueToSet);
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
    delete fieldElement.dataset.autofilledBy;
    fieldElement.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
async function displayPaper(paper) {
  const suppressAutoFillForLoad = Boolean(paper?.existing_annotation);
  if (suppressAutoFillForLoad) {
    state.suppressAutoFill = true;
  }

  try {
    state.currentPaper = paper;
    dom.paperView.classList.remove("hidden");
    dom.annotationView.classList.remove("hidden");
    dom.paperContentContainer.classList.remove("hidden");
    if (window.innerWidth >= 1024) {
      document.getElementById("resize-handle").style.display = "flex";
    } else {
      document.getElementById("resize-handle").style.display = "none";
    }
    const { originalAbstractHTML, originalFullTextHTML } = await ui.renderPaper(
      paper
    );
    startLockTimer();
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
  } finally {
    if (suppressAutoFillForLoad) {
      state.suppressAutoFill = false;
    }
  }
}
async function fetchAndDisplayNextPaper(retryCount = 0, skipDoi = null) {
  if (!state.currentDataset) return;
  stopLockTimer();
  if (retryCount === 0) {
    ui.showLoading("Finding & Loading Paper", "Please wait...");
  }
  try {
    const paper = await api.fetchNextPaper(state.currentDataset, skipDoi);
    await displayPaper(paper);
  } catch (error) {
    ui.hideLoading();
    alert(error.message);
    dom.paperView.classList.remove("hidden");
    dom.paperTitle.textContent =
      "Error loading paper. Please try again or select a dataset.";
    dom.paperContentContainer.classList.add("hidden");
    dom.annotationView.classList.add("hidden");
    document.getElementById("resize-handle").style.display = "none";
  }
}
async function fetchAndDisplaySpecificPaper(doi, dataset) {
  stopLockTimer();
  ui.showLoading("Resuming Session", "Fetching your previous paper...");
  try {
    state.currentPaper = await api.fetchPaperByDoi(doi, dataset);
    await displayPaper(state.currentPaper);
  } catch (error) {
    ui.hideLoading();
    alert(`Error resuming paper: ${error.message}. Getting a new paper.`);
    await fetchAndDisplayNextPaper();
  }
}

export function initializeActions(_state) {
  state = _state;

  const actionsApi = {
    setBuildFormCallback: (callback) => {
      buildAnnotationFormFromTemplateRef = callback;
    },
    // FIX: Add function to link the dashboard module
    setDashboardModule: (dashboard) => {
      dashboardModule = dashboard;
    },

    displaySpecificPaper: async (paper) => {
      stopLockTimer();
      ui.showLoading("Loading Paper...", `Loading ${paper.doi}...`);
      await displayPaper(paper);
    },

    submitAnnotation: async () => {
      const result = await performSubmit(dom.submitBtn);
      if (result.success) {
        ui.showToastNotification(
          "Annotation submitted successfully!",
          "success"
        );
        stopLockTimer();
        await fetchAndDisplayNextPaper();
      }
      ui.setButtonLoading(dom.submitBtn, false, "Submit");
    },

    submitAndAugmentAnnotation: async () => {
      const submitResult = await performSubmit(dom.submitAugmentBtn);

      if (!submitResult.success) {
        ui.setButtonLoading(dom.submitAugmentBtn, false, "Submit & Augment");
        return;
      }

      ui.showLoading(
        "Augmenting Data...",
        "Generating synthetic samples with AI..."
      );

      try {
        const augmentPayload = {
          doi: state.currentPaper.doi,
          title: state.currentPaper.title,
          abstract: state.currentPaper.abstract,
          dataset: state.currentDataset,
          annotator: localStorage.getItem("annotatorName") || "unknown",
          model_name:
            localStorage.getItem("geminiModel") || "gemini-1.5-flash-latest",
          sample_count: parseInt(
            localStorage.getItem("augmentSampleCount") || "3",
            10
          ),
          annotations: submitResult.payload.annotations,
          template: state.activeTemplate,
        };

        const augmentResult = await api.augmentData(augmentPayload);

        ui.showToastNotification(
          augmentResult.message || "Augmentation complete!",
          "success"
        );
      } catch (error) {
        ui.showToastNotification(
          `Augmentation failed: ${error.message}`,
          "error"
        );
      } finally {
        stopLockTimer();
        await fetchAndDisplayNextPaper();
        ui.setButtonLoading(dom.submitAugmentBtn, false, "Submit & Augment");
      }
    },

    handleSkip: async () => {
      if (!state.currentDataset || !state.currentPaper) return;
      await api.skipPaper(state.currentDataset, state.currentPaper.doi);
      stopLockTimer();
      await fetchAndDisplayNextPaper();
    },

    handleGetSuggestions: async () => {
      if (!state.currentPaper?.pdf_filename) {
        alert("PDF filename is missing.");
        return;
      }
      if (!localStorage.getItem("geminiModel")) {
        alert("Please select an AI model in Settings.");
        return;
      }
      ui.setButtonLoading(
        dom.getSuggestionsBtn,
        true,
        "Getting Suggestions..."
      );
      try {
        const suggestions = await api.fetchGeminiSuggestions(
          state.currentPaper.pdf_filename,
          localStorage.getItem("geminiModel"),
          state.activeTemplate
        );
        ui.applyGeminiSuggestions(
          suggestions.GeminiResponse || suggestions,
          state.activeTemplate
        );
        ui.showToastNotification("AI suggestions applied.", "success");
      } catch (error) {
        ui.showToastNotification(`AI Error: ${error.message}`, "error");
      } finally {
        ui.setButtonLoading(dom.getSuggestionsBtn, false, "Get AI Suggestions");
      }
    },

    handleSheetChange: async (e) => {
      stopTemplatePolling();
      const selectedSheetId = e.target.value;
      document.getElementById("filter-controls").classList.remove("hidden");
      document
        .getElementById("filter-status-container")
        .classList.add("hidden");
      document.getElementById("filter-input").value = "";
      state.sheetTemplateTimestamp = null;

      if (!selectedSheetId) {
        dom.datasetSelector.disabled = true;
        dom.datasetSelector.innerHTML =
          '<option value="">Select Dataset</option>';
        document.dispatchEvent(
          new CustomEvent("sheetTemplateActive", {
            detail: { active: false, hasTemplate: false },
          })
        );
        return;
      }

      ui.showLoading("Connecting to Sheet...", "Loading metadata...");

      try {
        const connectionResult = await api.connectToSheet(selectedSheetId);
        state.currentSheetId = selectedSheetId;
        localStorage.setItem("currentSheetId", selectedSheetId);

        if (connectionResult.has_sheet_template) {
          state.sheetTemplateTimestamp = connectionResult.template_timestamp;
          startTemplatePolling();

          ui.showLoading(
            "Connecting to Sheet...",
            "Found sheet template, loading..."
          );
          const sheetTemplate = await api.getSheetTemplate(selectedSheetId);
          if (sheetTemplate && buildAnnotationFormFromTemplateRef) {
            buildAnnotationFormFromTemplateRef(sheetTemplate);
            document.dispatchEvent(
              new CustomEvent("loadSheetTemplate", { detail: sheetTemplate })
            );
            document.dispatchEvent(
              new CustomEvent("sheetTemplateActive", {
                detail: { active: true, hasTemplate: true },
              })
            );
            ui.showToastNotification(
              "Loaded template from Google Sheet.",
              "success"
            );
          } else {
            const activeLocalTemplate = templates.getActiveTemplate();
            if (activeLocalTemplate)
              buildAnnotationFormFromTemplateRef(activeLocalTemplate);
            document.dispatchEvent(
              new CustomEvent("sheetTemplateActive", {
                detail: { active: true, hasTemplate: false },
              })
            );
            ui.showToastNotification(
              "Could not load sheet template, using local fallback.",
              "warning"
            );
          }
        } else {
          const activeLocalTemplate = templates.getActiveTemplate();
          if (activeLocalTemplate && buildAnnotationFormFromTemplateRef) {
            buildAnnotationFormFromTemplateRef(activeLocalTemplate);
          }
          document.dispatchEvent(
            new CustomEvent("sheetTemplateActive", {
              detail: { active: true, hasTemplate: false },
            })
          );
        }

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
          dom.datasetSelector.dispatchEvent(new Event("change"));
        }
        ui.showToastNotification("Connected to sheet.", "success");
      } catch (error) {
        alert(`Failed to connect to sheet: ${error.message}`);
        e.target.value = "";
        state.currentSheetId = null;
        document.dispatchEvent(
          new CustomEvent("sheetTemplateActive", {
            detail: { active: false, hasTemplate: false },
          })
        );
      } finally {
        ui.hideLoading();
      }
    },

    handleDatasetChange: async (e) => {
      const selectedDataset = e.target.value;
      if (!selectedDataset || !state.currentSheetId) return;
      state.currentDataset = selectedDataset;
      localStorage.setItem(
        `currentDataset_${state.currentSheetId}`,
        selectedDataset
      );

      // FIX: Refresh the dashboard if it's the active view
      if (
        dashboardModule &&
        !document.getElementById("dashboard-view").classList.contains("hidden")
      ) {
        dashboardModule.loadData();
      }

      const filterStatus = await api.getFilterStatus(selectedDataset);
      document.dispatchEvent(
        new CustomEvent("updateFilterUI", { detail: filterStatus })
      );

      // Only fetch next paper if we are on the main annotation view
      if (!document.getElementById("main-view").classList.contains("hidden")) {
        ui.showLoading(
          "Loading Session...",
          "Checking for resumable papers..."
        );
        try {
          const annotatorName = localStorage.getItem("annotatorName");
          if (annotatorName) {
            const resumable = await api.checkForResumablePaper(annotatorName);
            if (resumable.resumable && resumable.dataset === selectedDataset) {
              if (confirm(`Resume working on "${resumable.title}"?`)) {
                await api.loadDataset(resumable.dataset);
                await fetchAndDisplaySpecificPaper(
                  resumable.doi,
                  resumable.dataset
                );
                return;
              } else {
                await api.skipPaper(resumable.dataset, resumable.doi);
              }
            }
          }
          await api.loadDataset(state.currentDataset);
          await fetchAndDisplayNextPaper();
        } catch (error) {
          ui.hideLoading();
          alert(`Error loading dataset: ${error.message}`);
        }
      }
    },

    handleApplyFilter: async () => {
      const query = document.getElementById("filter-input").value.trim();
      if (!query || !state.currentDataset) return;
      ui.showLoading("Applying Filter...", `Searching for "${query}"...`);
      try {
        const result = await api.setFilter(
          state.currentDataset,
          query,
          state.activeTemplate
        );
        document.dispatchEvent(
          new CustomEvent("updateFilterUI", {
            detail: {
              is_active: true,
              query: result.query,
              match_count: result.match_count,
            },
          })
        );
        if (result.match_count > 0) {
          ui.showToastNotification(
            `Filter applied. Found ${result.match_count} papers.`,
            "success"
          );
          await fetchAndDisplayNextPaper();
        } else {
          ui.hideLoading();
          ui.showToastNotification("Filter returned 0 results.", "warning");
        }
      } catch (error) {
        ui.hideLoading();
        alert(`Error applying filter: ${error.message}`);
      }
    },

    handleClearFilter: async () => {
      if (!state.currentDataset) return;
      ui.showLoading("Clearing Filter...", "Reloading queue...");
      try {
        await api.clearFilter(state.currentDataset);
        document.dispatchEvent(
          new CustomEvent("updateFilterUI", { detail: { is_active: false } })
        );
        ui.showToastNotification("Filter cleared.", "success");
        await fetchAndDisplayNextPaper();
      } catch (error) {
        ui.hideLoading();
        alert(`Error clearing filter: ${error.message}`);
      }
    },

    initializeAutoFill: (template) => {
      if (!template || !template.fields) return;
      template.fields.forEach((field) => {
        if (!field.autoFillRules || field.autoFillRules.length === 0) return;
        const triggerEl = document.getElementById(field.id);
        if (!triggerEl) return;
        triggerEl.addEventListener("change", (e) => {
          if (state.suppressAutoFill) {
            return;
          }
          const triggerId = e.target.id;
          const currentValue = e.target.value;
          document
            .querySelectorAll(`[data-autofilled-by="${triggerId}"]`)
            .forEach((fieldToReset) => {
              const isTargetOfAnotherRule = field.autoFillRules.some(
                (rule) =>
                  rule.targetId === fieldToReset.id &&
                  currentValue === rule.triggerValue.toString()
              );
              if (!isTargetOfAnotherRule) {
                resetField(fieldToReset);
              }
            });
          field.autoFillRules.forEach((rule) => {
            if (currentValue === rule.triggerValue.toString()) {
              applyAutoFillRule(rule, triggerId);
            }
          });
        });
      });
    },
  };

  return actionsApi;
}
