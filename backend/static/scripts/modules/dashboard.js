// static/scripts/modules/dashboard.js
import * as api from "../api.js";
import {
  showToastNotification,
  showLoading,
  hideLoading,
  setButtonLoading,
} from "../ui.js";

let table = null;
let state = {};
let viewManager = null;
let listenersAttached = false;

const COLS_KEY = "dashboard.visible.columns.v1";
let allHeaders = [];
let visibleFields = [];
let commentsModal = null;
let activeDashboardTab = "annotations"; // 'annotations' or 'synthetic'

const BULK_SETTINGS_KEY = "dashboard.bulk.generator.settings.v1";
const DEFAULT_BULK_SETTINGS = {
  requestsPerMinute: 15,
  maxPapers: 0,
  targetStatus: "completed",
};
const BULK_TARGET_FILTERS = {
  completed: (row) => row.status === "Completed",
  completed_incomplete: (row) =>
    row.status === "Completed" || row.status === "Incomplete",
  all: () => true,
};
const bulkGenerationState = {
  isRunning: false,
  cancelRequested: false,
  queue: [],
  processed: 0,
  successes: 0,
  failures: 0,
  skipped: 0,
  lastAugmentStartedAt: 0,
  statusMessage: "Awaiting start",
  errors: [],
};

// --- Helper Functions ---

function statusFormatter(cell) {
  const data = cell.getRow().getData();
  const status = data.status;
  const annotator = data.annotator;

  const colorClasses = {
    Completed: "bg-green-500/20 text-green-300 border-green-500/30",
    Incomplete: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
    Locked: "bg-red-500/20 text-red-300 border-red-500/30",
    Available: "bg-gray-500/20 text-gray-300 border-gray-500/30",
    Reviewing: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  };
  const color = colorClasses[status] || colorClasses["Available"];

  let tooltip = `Status: ${status}`;
  if (status === "Locked" && annotator) {
    tooltip = `Locked by: ${annotator}`;
  } else if (status === "Reviewing" && annotator) {
    tooltip = `Under review by: ${annotator}`;
  }

  return `<span class="status-badge ${color}" title="${tooltip}">${status}</span>`;
}

function actionFormatter(cell) {
  const data = cell.getRow().getData();
  const status = data.status;

  if (status === "Available") {
    return `<button class="reopen-btn btn-primary text-xs py-1 px-2">Open</button>`;
  }
  if (status === "Locked" || status === "Reviewing") {
    const annotator = data.annotator || "another user";
    return `<button class="btn-secondary text-xs py-1 px-2" disabled title="This paper is currently locked by ${annotator}.">Locked</button>`;
  }

  // --- FIX: Show both Reopen and Generate for Completed and Incomplete ---
  if (status === "Completed" || status === "Incomplete") {
    return `
            <div class="flex flex-col gap-1">
                <button class="reopen-btn btn-primary text-xs py-1 px-2">Reopen</button>
                <button class="generate-btn btn-primary text-xs py-1 px-2 bg-blue-600 hover:bg-blue-700">Generate</button>
            </div>
        `;
  }

  return ""; // Default empty
}

// --- FIX: Unified click handler for the actions column ---
function handleActionClick(e, cell) {
  const target = e.target;
  if (target.classList.contains("generate-btn")) {
    handleGenerateClick(e, cell);
  } else if (target.classList.contains("reopen-btn")) {
    handleReopenClick(e, cell);
  }
}

async function handleReopenClick(e, cell) {
  const data = cell.getRow().getData();
  const annotatorName = localStorage.getItem("annotatorName");

  if (!state.currentDataset || !annotatorName) {
    showToastNotification(
      "Cannot open paper: Dataset or annotator name is not set.",
      "error"
    );
    return;
  }

  try {
    await api.setLock(data.doi, annotatorName, state.currentDataset);

    const paper = await api.reopenAnnotation(data.doi, state.currentDataset);
    viewManager.showAnnotationViewWithPaper(paper);
    loadData();
  } catch (error) {
    showToastNotification(`Error opening paper: ${error.message}`, "error");
  }
}

async function handleGenerateClick(e, cell) {
  const data = cell.getRow().getData();
  const currentUser = localStorage.getItem("annotatorName");

  if (!currentUser) {
    showToastNotification(
      "Set your annotator name in Settings to generate data.",
      "error"
    );
    return;
  }

  if (
    !confirm(
      `Generate synthetic data based on the annotation for "${data.title}"?`
    )
  ) {
    return;
  }

  showLoading("Preparing Augmentation...", `Fetching data for ${data.doi}`);

  try {
    // 1. Fetch the full paper data and its existing annotation
    const paper = await api.reopenAnnotation(data.doi, state.currentDataset);
    if (!paper.existing_annotation) {
      throw new Error(
        "Could not find the completed annotation data for this paper."
      );
    }

    if (!state.activeTemplate) {
      throw new Error(
        "No active template is loaded. Open an annotation to load the template before generating."
      );
    }

    // 2. Build the full payload
    const payload = buildAugmentationPayload(
      paper,
      currentUser,
      state.currentDataset
    );

    showLoading(
      "Augmenting Data...",
      "Generating synthetic samples with AI..."
    );

    // 4. Call the augment API
    const result = await api.augmentData(payload);
    showToastNotification(
      result.message || "Synthetic data generated successfully!",
      "success"
    );

    // 5. If the synthetic tab is active, refresh it
    if (activeDashboardTab === "synthetic") {
      await loadSyntheticData();
    }
  } catch (error) {
    showToastNotification(`Generation failed: ${error.message}`, "error");
  } finally {
    hideLoading();
  }
}

function loadVisibleFields(defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem(COLS_KEY));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return defaults;
}
function saveVisibleFields(fields) {
  localStorage.setItem(COLS_KEY, JSON.stringify(fields));
}

function loadBulkSettings() {
  try {
    const stored = localStorage.getItem(BULK_SETTINGS_KEY);
    if (!stored) return { ...DEFAULT_BULK_SETTINGS };
    const parsed = JSON.parse(stored);
    const rpm = Number.parseInt(parsed.requestsPerMinute, 10);
    const maxPapers = Number.parseInt(parsed.maxPapers, 10);
    const targetStatus =
      parsed.targetStatus && BULK_TARGET_FILTERS[parsed.targetStatus]
        ? parsed.targetStatus
        : DEFAULT_BULK_SETTINGS.targetStatus;
    return {
      requestsPerMinute:
        Number.isFinite(rpm) && rpm > 0
          ? Math.min(rpm, 60)
          : DEFAULT_BULK_SETTINGS.requestsPerMinute,
      maxPapers:
        Number.isFinite(maxPapers) && maxPapers > 0
          ? maxPapers
          : DEFAULT_BULK_SETTINGS.maxPapers,
      targetStatus,
    };
  } catch (error) {
    console.warn("Could not load bulk generation settings:", error);
    return { ...DEFAULT_BULK_SETTINGS };
  }
}

function saveBulkSettings(settings) {
  try {
    localStorage.setItem(BULK_SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("Could not persist bulk generation settings:", error);
  }
}

function applyBulkSettingsToInputs(settings) {
  const rateInput = document.getElementById("bulk-rate-input");
  const maxInput = document.getElementById("bulk-max-count");
  const targetSelect = document.getElementById("bulk-target-select");
  if (rateInput) rateInput.value = settings.requestsPerMinute;
  if (maxInput) maxInput.value = settings.maxPapers;
  if (targetSelect) targetSelect.value = settings.targetStatus;
}

function readBulkSettingsFromInputs() {
  const defaults = loadBulkSettings();
  const rateInput = document.getElementById("bulk-rate-input");
  const maxInput = document.getElementById("bulk-max-count");
  const targetSelect = document.getElementById("bulk-target-select");

  let rpm = Number.parseInt(rateInput?.value ?? defaults.requestsPerMinute, 10);
  if (!Number.isFinite(rpm) || rpm <= 0) rpm = defaults.requestsPerMinute;
  rpm = Math.min(Math.max(rpm, 1), 60);

  let maxPapers = Number.parseInt(
    maxInput?.value ?? defaults.maxPapers,
    10
  );
  if (!Number.isFinite(maxPapers) || maxPapers < 0) {
    maxPapers = defaults.maxPapers;
  }

  const targetStatus =
    targetSelect && BULK_TARGET_FILTERS[targetSelect.value]
      ? targetSelect.value
      : defaults.targetStatus;

  return {
    requestsPerMinute: rpm,
    maxPapers,
    targetStatus,
  };
}

function setBulkStatusMessage(message) {
  bulkGenerationState.statusMessage = message;
  updateBulkProgressUi();
}

function updateBulkProgressUi() {
  const progressBar = document.getElementById("bulk-progress-bar");
  const summaryEl = document.getElementById("bulk-progress-summary");
  const statusEl = document.getElementById("bulk-progress-status");
  const total = bulkGenerationState.queue.length;
  const processed = bulkGenerationState.processed;
  const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  if (progressBar) {
    progressBar.style.width = `${percent}%`;
  }
  if (summaryEl) {
    if (total) {
      summaryEl.textContent = `${processed} / ${total} processed • ${bulkGenerationState.successes} success • ${bulkGenerationState.failures} failed • ${bulkGenerationState.skipped} skipped`;
    } else {
      summaryEl.textContent = "Idle";
    }
  }
  if (statusEl) {
    statusEl.textContent = bulkGenerationState.statusMessage || "Awaiting start";
  }
}

function setBulkRunningUiState(isRunning) {
  const startBtn = document.getElementById("bulk-start-btn");
  const cancelBtn = document.getElementById("bulk-cancel-btn");
  const rateInput = document.getElementById("bulk-rate-input");
  const maxInput = document.getElementById("bulk-max-count");
  const targetSelect = document.getElementById("bulk-target-select");

  if (startBtn) {
    startBtn.disabled = isRunning;
    if (!isRunning) startBtn.textContent = "Start Run";
    else startBtn.textContent = "Running...";
  }
  if (cancelBtn) {
    cancelBtn.classList.toggle("hidden", !isRunning);
    cancelBtn.disabled = !isRunning;
  }
  [rateInput, maxInput, targetSelect].forEach((el) => {
    if (el) el.disabled = isRunning;
  });
}

function toggleBulkPanel() {
  const panel = document.getElementById("bulk-generate-panel");
  if (!panel || bulkGenerationState.isRunning) return;
  panel.classList.toggle("hidden");
}

function ensureBulkPanelVisible() {
  const panel = document.getElementById("bulk-generate-panel");
  if (panel) panel.classList.remove("hidden");
}

function handleBulkSettingChange() {
  if (bulkGenerationState.isRunning) return;
  const settings = readBulkSettingsFromInputs();
  saveBulkSettings(settings);
}

function getBulkCandidateRows(settings) {
  if (!table) return [];
  const data = table.getData();
  if (!Array.isArray(data)) return [];

  const filterFn =
    BULK_TARGET_FILTERS[settings.targetStatus] ||
    BULK_TARGET_FILTERS[DEFAULT_BULK_SETTINGS.targetStatus];

  const seen = new Set();
  const results = [];
  for (const row of data) {
    if (!row || !row.doi) continue;
    if (seen.has(row.doi)) continue;
    seen.add(row.doi);
    if (filterFn(row)) {
      results.push({
        doi: row.doi,
        title: row.title,
        status: row.status,
      });
    }
  }

  if (settings.maxPapers > 0) {
    return results.slice(0, settings.maxPapers);
  }
  return results;
}

async function respectRateLimit(minIntervalMs, label) {
  if (!bulkGenerationState.lastAugmentStartedAt || minIntervalMs <= 0) return;
  const elapsed = Date.now() - bulkGenerationState.lastAugmentStartedAt;
  if (elapsed >= minIntervalMs) return;
  const waitMs = minIntervalMs - elapsed;
  setBulkStatusMessage(
    `Waiting ${Math.ceil(waitMs / 1000)}s before ${label} to honor rate limit`
  );
  await wait(waitMs);
}

async function handleBulkStart() {
  if (bulkGenerationState.isRunning) return;

  ensureBulkPanelVisible();

  if (!state.currentDataset) {
    showToastNotification(
      "Load a dataset before starting bulk augmentation.",
      "error"
    );
    return;
  }

  const annotatorName = localStorage.getItem("annotatorName");
  if (!annotatorName) {
    showToastNotification(
      "Set your annotator name in Settings before running bulk generation.",
      "error"
    );
    return;
  }

  if (!state.activeTemplate) {
    showToastNotification(
      "Bulk generation needs an active template. Open an annotation to load it first.",
      "error"
    );
    return;
  }

  if (!table) {
    showToastNotification(
      "The dashboard table is not ready yet. Try again in a moment.",
      "error"
    );
    return;
  }

  const settings = readBulkSettingsFromInputs();
  saveBulkSettings(settings);

  const queue = getBulkCandidateRows(settings);
  if (!queue.length) {
    showToastNotification(
      "No papers matched the current bulk generation settings.",
      "warning"
    );
    return;
  }

  bulkGenerationState.isRunning = true;
  bulkGenerationState.cancelRequested = false;
  bulkGenerationState.queue = queue;
  bulkGenerationState.processed = 0;
  bulkGenerationState.successes = 0;
  bulkGenerationState.failures = 0;
  bulkGenerationState.skipped = 0;
  bulkGenerationState.errors = [];
  bulkGenerationState.lastAugmentStartedAt = 0;
  setBulkRunningUiState(true);
  setBulkStatusMessage("Starting bulk generation run…");

  try {
    await runBulkGeneration(settings, annotatorName);
  } catch (error) {
    console.error("Bulk generation run failed:", error);
    showToastNotification(
      `Bulk generation failed: ${error.message}`,
      "error"
    );
  } finally {
    bulkGenerationState.isRunning = false;
    const wasCanceled = bulkGenerationState.cancelRequested;
    bulkGenerationState.cancelRequested = false;
    setBulkRunningUiState(false);
    if (!wasCanceled && !bulkGenerationState.queue.length) {
      // Ensure UI resets if run failed before queue assignment.
      updateBulkProgressUi();
    }
  }
}

function handleBulkCancel() {
  if (!bulkGenerationState.isRunning) return;
  bulkGenerationState.cancelRequested = true;
  setBulkStatusMessage("Cancel requested… finishing current paper");
}

async function runBulkGeneration(settings, annotatorName) {
  const total = bulkGenerationState.queue.length;
  const minIntervalMs = Math.floor(
    60000 / Math.max(1, settings.requestsPerMinute)
  );

  updateBulkProgressUi();

  for (let index = 0; index < total; index += 1) {
    if (bulkGenerationState.cancelRequested) break;

    const candidate = bulkGenerationState.queue[index];
    const label = `${index + 1}/${total}`;

    if (!candidate.doi) {
      bulkGenerationState.skipped += 1;
      bulkGenerationState.processed += 1;
      setBulkStatusMessage(`Skipping entry without DOI (${label})`);
      continue;
    }

    setBulkStatusMessage(
      `Preparing augmentation for ${candidate.doi} (${label})`
    );
    updateBulkProgressUi();

    let paper = null;
    try {
      paper = await api.reopenAnnotation(candidate.doi, state.currentDataset);
    } catch (error) {
      bulkGenerationState.failures += 1;
      bulkGenerationState.errors.push({
        doi: candidate.doi,
        message: error.message,
      });
      bulkGenerationState.processed += 1;
      setBulkStatusMessage(
        `Failed to fetch annotation for ${candidate.doi}: ${error.message}`
      );
      updateBulkProgressUi();
      continue;
    }

    if (!paper || !paper.existing_annotation) {
      bulkGenerationState.skipped += 1;
      bulkGenerationState.processed += 1;
      setBulkStatusMessage(
        `No completed annotation found for ${candidate.doi}, skipping`
      );
      updateBulkProgressUi();
      continue;
    }

    await respectRateLimit(
      minIntervalMs,
      `processing ${candidate.doi}`
    );

    setBulkStatusMessage(
      `Submitting augmentation for ${candidate.doi} (${label})`
    );
    updateBulkProgressUi();

    const payload = buildAugmentationPayload(
      paper,
      annotatorName,
      state.currentDataset
    );

    try {
      bulkGenerationState.lastAugmentStartedAt = Date.now();
      const response = await api.augmentData(payload);
      const message =
        response.message ||
        `Generated synthetic data for ${candidate.doi}`;
      bulkGenerationState.successes += 1;
      setBulkStatusMessage(message);
    } catch (error) {
      bulkGenerationState.failures += 1;
      bulkGenerationState.errors.push({
        doi: candidate.doi,
        message: error.message,
      });
      setBulkStatusMessage(
        `Generation failed for ${candidate.doi}: ${error.message}`
      );
    } finally {
      bulkGenerationState.processed += 1;
      updateBulkProgressUi();
    }
  }

  const canceled = bulkGenerationState.cancelRequested;
  const summaryPrefix = canceled ? "Bulk generation canceled" : "Bulk generation finished";
  let summary = `${summaryPrefix}: ${bulkGenerationState.successes} success`;
  summary += `, ${bulkGenerationState.failures} failed`;
  summary += `, ${bulkGenerationState.skipped} skipped`;

  const toastType = canceled
    ? "warning"
    : bulkGenerationState.failures > 0
    ? "warning"
    : "success";
  setBulkStatusMessage(summary);
  showToastNotification(summary, toastType, 7000);

  if (bulkGenerationState.errors.length) {
    console.warn("Bulk augmentation errors:", bulkGenerationState.errors);
  }

  if (
    bulkGenerationState.successes > 0 &&
    activeDashboardTab === "synthetic"
  ) {
    await loadSyntheticData();
  }

  updateBulkProgressUi();
}

function buildAugmentationPayload(paper, currentUser, datasetName) {
  const annotatorData = paper.existing_annotation || {};
  const originalAnnotator = annotatorData.annotator || "Original";
  const newAnnotator =
    currentUser === originalAnnotator
      ? originalAnnotator
      : `${originalAnnotator} (orig) + ${currentUser}`;

  let sampleCount = Number.parseInt(
    localStorage.getItem("augmentSampleCount") || "3",
    10
  );
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
    sampleCount = 3;
  }

  return {
    doi: paper.doi,
    title: paper.title,
    abstract: paper.abstract,
    dataset: datasetName,
    annotator: newAnnotator,
    model_name:
      localStorage.getItem("geminiModel") || "gemini-1.5-flash-latest",
    sample_count: sampleCount,
    annotations: annotatorData,
    template: state.activeTemplate,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- START FIX for Column Filter ---
// This function is now dynamic and builds columns based on the 'visibleFields' array.
function buildAnnotationsColumns() {
  // These columns are always present and not user-configurable
  const staticStartCols = [
    {
      title: "Status",
      field: "status",
      width: 120,
      formatter: statusFormatter,
      headerSort: true,
    },
  ];

  const staticEndCols = [
    {
      title: "Actions",
      width: 100,
      hozAlign: "center",
      formatter: actionFormatter,
      cellClick: handleActionClick,
      headerSort: false,
    },
    {
      title: "Comments",
      field: "__comments",
      width: 130,
      hozAlign: "center",
      headerSort: false,
      formatter: () =>
        `<button class="btn-primary text-xs py-1 px-2">Comment</button>`,
      cellClick: (e, cell) => {
        const row = cell.getRow().getData();
        openCommentsModal(row.doi, row.title);
      },
    },
  ];

  // Create column definitions from the user-selected visibleFields array
  const dynamicCols = visibleFields.map((header) => {
    // The 'field' must match the key in the data object from the API (lowercase_with_underscores)
    const fieldKey = header.replace(/ /g, "_").toLowerCase();

    const colDef = {
      title: header,
      field: fieldKey,
      tooltip: true,
    };

    // Apply specific widths/minWidths for known columns to preserve original layout
    switch (header.toLowerCase()) {
      case "title":
        colDef.minWidth = 300;
        break;
      case "doi":
        colDef.width = 220;
        break;
      case "annotator":
        colDef.width = 150;
        break;
      case "latest comment":
        colDef.minWidth = 200;
        break;
      default:
        colDef.minWidth = 150; // A sensible default for other fields
        break;
    }
    return colDef;
  });

  return [...staticStartCols, ...dynamicCols, ...staticEndCols];
}
// --- END FIX for Column Filter ---

function buildSyntheticColumns(headers = []) {
  if (!headers.length) return [];
  return headers.map((header) => {
    const col = {
      title: header.charAt(0).toUpperCase() + header.slice(1), // Capitalize
      field: header,
      minWidth: 150,
      tooltip: true,
      headerFilter: "input",
    };
    if (header === "title" || header === "abstract") {
      col.minWidth = 300;
    }
    if (header === "doi") {
      col.width = 220;
    }
    return col;
  });
}

async function openColumnsPicker() {
  // --- FIX: Fetch headers if they don't exist yet ---
  if (!allHeaders.length && state.currentDataset) {
    try {
      const payload = await api.getSheetData(state.currentDataset);
      allHeaders = (payload.headers || [])
        .map((h) => String(h || "").trim())
        .filter(Boolean);
    } catch (error) {
      showToastNotification("Could not fetch column data.", "error");
      return;
    }
  }

  if (!allHeaders.length) {
    showToastNotification("Load a sheet and dataset first.", "error");
    return;
  }

  const pickerId = "columns-picker-modal";
  if (document.getElementById(pickerId)) return;
  const wrapper = document.createElement("div");
  wrapper.id = pickerId;
  wrapper.className = "glass-effect rounded-3xl p-6 text-white";
  wrapper.style.cssText =
    "position:fixed; right:2rem; top:8rem; z-index:9999; width:320px;";
  wrapper.innerHTML = `
        <h3 class="text-xl font-bold mb-4">Choose Columns</h3>
        <div id="col-list" class="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-2"></div>
        <div class="flex justify-end gap-2 mt-4 pt-4 border-t border-white/20">
        <button id="col-cancel" class="btn-secondary">Close</button>
        <button id="col-apply" class="btn-primary">Apply</button>
        </div>
    `;
  document.body.appendChild(wrapper);
  const list = wrapper.querySelector("#col-list");
  const pickable = allHeaders.filter((h) => !["status"].includes(h));
  pickable.forEach((h) => {
    const id = `col_${h.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const checked = visibleFields.includes(h) ? "checked" : "";
    const row = document.createElement("label");
    row.className =
      "flex items-center gap-2 p-1 rounded-md hover:bg-white/10 transition-colors";
    row.innerHTML = `<input type="checkbox" id="${id}" data-field-name="${h}" class="custom-checkbox" ${checked}/> <span class="truncate">${h}</span>`;
    list.appendChild(row);
  });
  wrapper.querySelector("#col-cancel").onclick = () => wrapper.remove();
  wrapper.querySelector("#col-apply").onclick = () => {
    const selectedFields = [];
    wrapper
      .querySelectorAll('#col-list input[type="checkbox"]:checked')
      .forEach((input) => {
        selectedFields.push(input.dataset.fieldName);
      });
    visibleFields = selectedFields;
    saveVisibleFields(visibleFields);
    table.setColumns(buildAnnotationsColumns());
    wrapper.remove();
  };
}

function ensureCommentsModal() {
  if (commentsModal) return;
  commentsModal = document.createElement("div");
  commentsModal.id = "comments-modal";
  commentsModal.className =
    "glass-effect rounded-3xl p-6 text-white flex flex-col";
  commentsModal.style.cssText =
    "display:none; position:fixed; inset:0; margin:auto; max-width:720px; width:90%; max-height:80vh; overflow:hidden; z-index:9999;";
  commentsModal.innerHTML = `
    <div class="flex justify-between items-center mb-4 flex-shrink-0">
      <h3 id="cm-title" class="text-xl font-bold truncate pr-4">Comments</h3>
      <button id="cm-close" class="btn-secondary text-lg">&times;</button>
    </div>
    <div id="cm-thread" class="flex-grow overflow-y-auto pr-2 -mr-2 mb-4"></div>
    <div class="flex-shrink-0 border-t border-white/20 pt-4">
      <textarea id="cm-input" class="w-full p-2 bg-black bg-opacity-20 rounded-lg text-white placeholder-gray-400" rows="3" placeholder="Add a comment…"></textarea>
      <div class="flex justify-end mt-2 gap-2">
        <button id="cm-cancel" class="btn-secondary">Cancel</button>
        <button id="cm-save" class="btn-primary">Post</button>
      </div>
    </div>
  `;
  document.body.appendChild(commentsModal);
  document.getElementById("cm-close").onclick = () =>
    (commentsModal.style.display = "none");
  document.getElementById("cm-cancel").onclick = () =>
    (commentsModal.style.display = "none");
  document.getElementById("cm-save").onclick = postCommentFromModal;
}

let currentDOIForComments = null;

function renderThread(items) {
  const thread = document.getElementById("cm-thread");
  thread.innerHTML =
    (items || [])
      .map(
        (it) => `
    <div class="bg-black/20 p-3 rounded-lg mb-2">
      <div class="text-sm text-gray-400 mb-1">
        <strong class="text-white">${
          it.annotator || "Anon"
        }</strong> &middot; ${it.timestamp || ""}
      </div>
      <div class="text-gray-200 whitespace-pre-wrap">${escapeHtml(
        it.comment || ""
      )}</div>
    </div>
  `
      )
      .join("") ||
    `<div class="text-center text-gray-400 p-4">No comments yet.</div>`;
}

async function openCommentsModal(doi, title) {
  ensureCommentsModal();
  currentDOIForComments = doi;
  document.getElementById("cm-title").textContent = `Comments · ${
    title || doi
  }`;
  document.getElementById("cm-input").value = "";
  commentsModal.style.display = "flex";
  renderThread(null);
  try {
    const data = await api.getComments(doi);
    renderThread(data.items || []);
  } catch (e) {
    showToastNotification(`Could not load comments: ${e.message}`, "error");
    renderThread([]);
  }
}

async function postCommentFromModal() {
  const input = document.getElementById("cm-input");
  const text = input.value.trim();
  if (!text || !currentDOIForComments) return;
  const annotator = localStorage.getItem("annotatorName") || "Anon";
  try {
    await api.addComment({
      doi: currentDOIForComments,
      annotator,
      comment: text,
    });
    input.value = "";
    const data = await api.getComments(currentDOIForComments);
    renderThread(data.items || []);
    loadData();
  } catch (e) {
    showToastNotification(`Could not post comment: ${e.message}`, "error");
  }
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        m
      ])
  );
}

function initializeOrReinitializeTable(columns, placeholder) {
  const container = document.getElementById("dashboard-table-container");
  if (table) {
    table.destroy();
  }
  table = new Tabulator(container, {
    height: "calc(100vh - 320px)",
    layout: "fitData",
    placeholder: placeholder,
    columns: columns,
  });
}

async function loadAnnotationsData() {
  if (!state.currentDataset) {
    initializeOrReinitializeTable([], "Select a dataset to view annotations.");
    return;
  }
  try {
    initializeOrReinitializeTable([], "Loading Annotations...");
    const payload = await api.getSheetData(state.currentDataset);
    allHeaders = (payload.headers || [])
      .map((h) => String(h || "").trim())
      .filter(Boolean);
    table.setColumns(buildAnnotationsColumns());
    table.setData(payload.rows || []);
  } catch (err) {
    console.error("Error loading annotation data into table:", err);
    showToastNotification("Could not load annotation data.", "error");
    if (table) initializeOrReinitializeTable([], "Error loading data.");
  }
}

async function loadSyntheticData() {
  try {
    initializeOrReinitializeTable([], "Loading Synthetic Data...");
    const payload = await api.getSyntheticSheetData();
    table.setColumns(buildSyntheticColumns(payload.headers || []));
    table.setData(payload.rows || []);
  } catch (err) {
    console.error("Error loading synthetic data into table:", err);
    showToastNotification("Could not load synthetic data.", "error");
    if (table) initializeOrReinitializeTable([], "Error loading data.");
  }
}

function loadData() {
  // ADD THIS NEW VARIABLE
  const reviewsBoard = document.getElementById("dashboard-reviews-board");

  // HIDE/SHOW the correct containers
  document
    .getElementById("dashboard-table-container")
    .classList.toggle("hidden", activeDashboardTab === "reviews");
  reviewsBoard.classList.toggle("hidden", activeDashboardTab !== "reviews"); // CHANGED

  if (activeDashboardTab === "annotations") {
    document.getElementById("columnsBtn").style.display = "block";
    loadAnnotationsData();
  } else if (activeDashboardTab === "synthetic") {
    document.getElementById("columnsBtn").style.display = "none";
    loadSyntheticData();
  } else if (activeDashboardTab === "reviews") {
    // ADD THIS BLOCK
    document.getElementById("columnsBtn").style.display = "none";
    loadReviewsData();
  }
}

function setupEventListeners() {
  if (listenersAttached) return;
  document
    .getElementById("dashboard-refresh-btn")
    .addEventListener("click", loadData);

  const bulkToggleBtn = document.getElementById("bulk-generate-btn");
  const bulkStartBtn = document.getElementById("bulk-start-btn");
  const bulkCancelBtn = document.getElementById("bulk-cancel-btn");
  if (bulkToggleBtn) bulkToggleBtn.addEventListener("click", toggleBulkPanel);
  if (bulkStartBtn) bulkStartBtn.addEventListener("click", handleBulkStart);
  if (bulkCancelBtn) bulkCancelBtn.addEventListener("click", handleBulkCancel);
  ["bulk-rate-input", "bulk-max-count", "bulk-target-select"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", handleBulkSettingChange);
  });
  applyBulkSettingsToInputs(loadBulkSettings());
  updateBulkProgressUi();

  const searchInput = document.getElementById("dashboard-search");
  searchInput.addEventListener("keyup", function () {
    const filterValue = searchInput.value;
    table.setFilter(
      filterValue
        ? [
            [
              { field: "title", type: "like", value: filterValue },
              { field: "doi", type: "like", value: filterValue },
            ],
          ]
        : []
    );
  });

  const colsBtn = document.getElementById("columnsBtn");
  if (colsBtn) colsBtn.addEventListener("click", openColumnsPicker);

  // Tab switching logic
  document.querySelectorAll(".dashboard-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeDashboardTab = tab.dataset.tab;
      document
        .querySelectorAll(".dashboard-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      loadData();
    });
  });

  document
    .getElementById("dashboard-reviews-board")
    .addEventListener("click", handleReviewCardClick);

  document
    .getElementById("dashboard-reviews-board")
    .addEventListener("click", (e) => {
      const toggleBtn = e.target.closest(".toggle-context-btn");
      if (!toggleBtn) return;

      e.preventDefault();
      const contextPanel = toggleBtn.nextElementSibling;
      const isHidden = contextPanel.classList.toggle("hidden");

      const textSpan = toggleBtn.querySelector("span");
      if (textSpan) {
        textSpan.textContent = isHidden
          ? "Show Context Provided to AI"
          : "Hide Context";
      }
    });

  ensureCommentsModal();
  listenersAttached = true;
}

export function initializeDashboard(_state, _viewManager) {
  state = _state;
  viewManager = _viewManager;
  // --- START FIX for Column Filter ---
  // Load saved column preferences or set defaults when the dashboard is initialized.
  visibleFields = loadVisibleFields([
    "Title",
    "DOI",
    "Annotator",
    "Latest Comment",
  ]);
  // --- END FIX for Column Filter ---
  setupEventListeners();
  return {
    loadData,
  };
}

async function loadReviewsData() {
  // Get references to all columns and counters
  const columns = {
    pending: document.getElementById("pending-reviews-col"),
    confirmedHuman: document.getElementById("confirmed-human-col"),
    correctedAI: document.getElementById("corrected-ai-col"),
  };
  const counts = {
    pending: document.getElementById("pending-count"),
    confirmedHuman: document.getElementById("confirmed-human-count"),
    correctedAI: document.getElementById("corrected-ai-count"),
  };
  const cardTemplate = document.getElementById("review-card-template");

  // Set loading state
  Object.values(columns).forEach(
    (col) =>
      (col.innerHTML = '<div class="loading-spinner mx-auto mt-8"></div>')
  );
  Object.values(counts).forEach((count) => (count.textContent = "..."));

  try {
    const data = await api.getReviewsData();
    Object.values(columns).forEach((col) => (col.innerHTML = "")); // Clear spinners

    if (data.rows.length === 0) {
      Object.values(counts).forEach((count) => (count.textContent = "0"));
      columns.pending.innerHTML =
        '<p class="text-center text-gray-400 py-4">The review queue is empty!</p>';
      return;
    }

    let pendingCount = 0,
      confirmedHumanCount = 0,
      correctedAICount = 0;

    data.rows.forEach((item) => {
      const card = cardTemplate.content.cloneNode(true).firstElementChild;

      // --- FIX 1 START: Populate Reviewer_Reasoning field BEFORE the logic block ---
      // This ensures the element has content when the show/hide logic runs.
      card.querySelector('[data-field="Title"]').textContent = item.Title;
      card.querySelector('[data-field="DOI"]').textContent = item.DOI;
      card.querySelector(
        '[data-field="Trigger_Name"]'
      ).textContent = `Trigger: ${item.Trigger_Name}`; // Changed "Trigger:" to "Disagreement on:"
      card.querySelector('[data-field="Human_Label"]').textContent =
        item.Human_Label;
      card.querySelector(
        '[data-field="Annotator"]'
      ).textContent = `(${item.Annotator})`;
      card.querySelector('[data-field="AI_Label"]').textContent = item.AI_Label;
      card.querySelector('[data-field="AI_Reasoning"]').textContent =
        item.AI_Reasoning;
      card.querySelector(
        '[data-field="Reviewed_By"]'
      ).textContent = `(${item.Reviewed_By})`;
      card.querySelector(
        '[data-field="Relevant_Context_Provided_to_AI"]'
      ).textContent = item.Relevant_Context_Provided_to_AI;
      // This is the critical line that was missing.
      card.querySelector('[data-field="Reviewer_Reasoning"]').textContent =
        item.Reviewer_Reasoning || "";
      // --- FIX 1 END ---

      // Store data on the card element
      card.dataset.doi = item.DOI;
      card.dataset.triggerName = item.Trigger_Name;
      card.dataset.aiLabel = item.AI_Label;
      card.dataset.dataset = state.currentDataset;

      // --- This logic block is now correct and will work as intended ---
      const status = item.Review_Status;
      const reviewerReasoning = item.Reviewer_Reasoning;
      const aiReasoningSection = card.querySelector(".ai-reasoning-section");
      const reviewerReasoningSection = card.querySelector(
        ".reviewer-reasoning-section"
      );
      if (
        (status === "Confirmed Human" || status === "Corrected to AI") &&
        reviewerReasoning
      ) {
        aiReasoningSection.classList.add("hidden");
        reviewerReasoningSection.classList.remove("hidden");
        // No need to set textContent here again, it's already done above.
      }

      const buttonContainer = card.querySelector(".flex-shrink-0");
      buttonContainer.className =
        "flex-shrink-0 flex flex-col items-stretch gap-1";

      if (status === "Confirmed Human") {
        confirmedHumanCount++;
        buttonContainer.innerHTML = `
          <button class="btn-primary bg-yellow-600 hover:bg-yellow-700 text-xs py-1 px-2" data-action="undo">Undo</button>
          <button class="btn-primary bg-red-600 hover:bg-red-700 text-xs py-1 px-2" data-action="reopen">Reopen</button>
        `;
        columns.confirmedHuman.appendChild(card);
      } else if (status === "Corrected to AI") {
        correctedAICount++;
        buttonContainer.innerHTML = `
          <button class="btn-primary bg-red-600 hover:bg-red-700 text-xs py-1 px-2" data-action="undo">Undo</button>
          <button class="btn-primary bg-yellow-600 hover:bg-yellow-700 text-xs py-1 px-2" data-action="reopen">Reopen</button>
        `;
        columns.correctedAI.appendChild(card);
      } else {
        // Pending
        pendingCount++;
        buttonContainer.innerHTML = `
          <button class="btn-primary bg-yellow-600 hover:bg-yellow-700 text-xs py-1 px-2" data-action="reopen">Reopen</button>
          <button class="btn-primary bg-green-600 hover:bg-green-700 text-xs py-1 px-2" data-action="confirm">Confirm Human</button>
          <button class="btn-primary bg-blue-600 hover:bg-blue-700 text-xs py-1 px-2" data-action="correct">Correct to AI</button>
        `;
        columns.pending.appendChild(card);
      }
    });

    // Update the counts in the headers
    counts.pending.textContent = pendingCount;
    counts.confirmedHuman.textContent = confirmedHumanCount;
    counts.correctedAI.textContent = correctedAICount;
  } catch (error) {
    Object.values(columns).forEach((col) => (col.innerHTML = ""));
    columns.pending.innerHTML = `<p class="text-center text-red-400 py-4">Error: ${error.message}</p>`;
  }
}

async function handleReviewCardClick(e) {
  const button = e.target.closest("button");
  if (!button) return;

  const card = button.closest(".review-card");
  if (!card) return;

  const { doi, triggerName, dataset } = card.dataset;
  const action = button.dataset.action;

  if (!action) return;

  // Don't disable the button here, let the modal handle the state
  card.style.opacity = "0.5";

  try {
    if (action === "reopen") {
      const paper = await api.reopenAnnotation(doi, dataset);
      viewManager.showAnnotationViewWithPaper(paper);
      card.style.opacity = "1"; // Restore on success
    } else if (action === "confirm" || action === "correct") {
      // Instead of calling the API, open the modal
      openReasoningModal(card, action);
    } else if (action === "undo") {
      await api.resolveReviewItem(doi, triggerName, "Pending", ""); // Pass empty reasoning
      showToastNotification("Action undone.", "info");
      moveCardToColumn(card, "pending-reviews-col");
    }
  } catch (error) {
    showToastNotification(`Action failed: ${error.message}`, "error");
    card.style.opacity = "1"; // Restore on any error
  }
}

function moveCardToColumn(cardElement, targetColumnId) {
  const targetColumn = document.getElementById(targetColumnId);
  if (!targetColumn) return;

  const buttonContainer = cardElement.querySelector(".flex-shrink-0");
  if (buttonContainer) {
    buttonContainer.innerHTML = "";
    buttonContainer.className =
      "flex-shrink-0 flex flex-col items-stretch gap-1";
  }

  // Add the correct buttons based on the destination column
  if (targetColumnId === "pending-reviews-col") {
    // Add the full set of action buttons for pending items
    buttonContainer.innerHTML = `
            <button class="btn-primary bg-yellow-600 hover:bg-yellow-700 text-xs py-1 px-2" data-action="reopen">Reopen</button>
            <button class="btn-primary bg-green-600 hover:bg-green-700 text-xs py-1 px-2" data-action="confirm">Confirm Human</button>
            <button class="btn-primary bg-blue-600 hover:bg-blue-700 text-xs py-1 px-2" data-action="correct">Correct to AI</button>
        `;

    // --- START: NEW FIX ---
    // When moving back to pending, revert the reasoning visibility.
    const aiReasoningSection = cardElement.querySelector(
      ".ai-reasoning-section"
    );
    const reviewerReasoningSection = cardElement.querySelector(
      ".reviewer-reasoning-section"
    );

    aiReasoningSection.classList.remove("hidden");
    reviewerReasoningSection.classList.add("hidden");
    // --- END: NEW FIX ---
  } else {
    // Add "Undo" and "Reopen" for completed items
    buttonContainer.innerHTML = `
            <button class="btn-primary bg-red-600 hover:bg-red-700 text-xs py-1 px-2" data-action="undo">Undo</button>
            <button class="btn-primary bg-yellow-600 hover:bg-yellow-700 text-xs py-1 px-2" data-action="reopen">Reopen</button>
        `;
  }

  cardElement.style.opacity = "1";
  targetColumn.prepend(cardElement);

  // Update column counts
  document.getElementById("pending-count").textContent =
    document.querySelectorAll("#pending-reviews-col .review-card").length;
  document.getElementById("confirmed-human-count").textContent =
    document.querySelectorAll("#confirmed-human-col .review-card").length;
  document.getElementById("corrected-ai-count").textContent =
    document.querySelectorAll("#corrected-ai-col .review-card").length;
}

function openReasoningModal(card, action) {
  const modal = document.getElementById("reasoning-modal");
  const overlay = document.getElementById("modal-overlay");
  const title = document.getElementById("reasoning-modal-title");
  const input = document.getElementById("reasoning-modal-input");
  const cancelBtn = document.getElementById("reasoning-modal-cancel");
  const submitBtn = document.getElementById("reasoning-modal-submit");

  setButtonLoading(submitBtn, false, "Submit");
  title.textContent =
    action === "confirm" ? "Confirm Human Label" : "Confirm AI Label";
  input.value = "";

  // --- START FIX: Define closeModal in the outer scope ---
  const closeModal = () => {
    modal.classList.add("hidden");
    overlay.classList.add("hidden");
    // Restore card opacity in case the user cancels
    card.style.opacity = "1";
    // Clean up listeners to prevent them from stacking up on repeated clicks
    submitBtn.removeEventListener("click", handleSubmit);
    cancelBtn.removeEventListener("click", closeModal);
    overlay.removeEventListener("click", closeModal);
  };
  // --- END FIX ---

  const handleSubmit = async () => {
    const reasoning = input.value.trim();
    if (!reasoning) {
      showToastNotification(
        "Please provide a reason for your decision.",
        "warning"
      );
      return;
    }

    const { doi, triggerName } = card.dataset;
    const resolution =
      action === "confirm" ? "Confirmed Human" : "Corrected to AI";
    const targetColumnId =
      action === "confirm" ? "confirmed-human-col" : "corrected-ai-col";

    setButtonLoading(submitBtn, true, "Submitting...");
    try {
      await api.resolveReviewItem(doi, triggerName, resolution, reasoning);
      showToastNotification("Review submitted successfully!", "success");

      const aiReasoningSection = card.querySelector(".ai-reasoning-section");
      const reviewerReasoningSection = card.querySelector(
        ".reviewer-reasoning-section"
      );
      reviewerReasoningSection.querySelector(
        '[data-field="Reviewer_Reasoning"]'
      ).textContent = reasoning;
      const reviewerName = localStorage.getItem("annotatorName") || "unknown";
      reviewerReasoningSection.querySelector(
        '[data-field="Reviewed_By"]'
      ).textContent = `(${reviewerName})`;

      aiReasoningSection.classList.add("hidden");
      reviewerReasoningSection.classList.remove("hidden");

      moveCardToColumn(card, targetColumnId);
      closeModal(); // This will now work correctly
    } catch (error) {
      showToastNotification(`Submission failed: ${error.message}`, "error");
      // Also restore card opacity on failure
      card.style.opacity = "1";
    } finally {
      setButtonLoading(submitBtn, false, "Submit");
    }
  };

  // Show the modal
  overlay.classList.remove("hidden");
  modal.classList.remove("hidden");
  input.focus();

  // --- FIX: Use addEventListener for cleaner event management ---
  submitBtn.addEventListener("click", handleSubmit);
  cancelBtn.addEventListener("click", closeModal);
  overlay.addEventListener("click", closeModal);
}
