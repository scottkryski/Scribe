// static/scripts/modules/dashboard.js
import * as api from "../api.js";
import { showToastNotification, showLoading, hideLoading } from "../ui.js";

let table = null;
let state = {};
let viewManager = null;
let listenersAttached = false;

const COLS_KEY = "dashboard.visible.columns.v1";
let allHeaders = [];
let visibleFields = [];
let commentsModal = null;
let activeDashboardTab = "annotations"; // 'annotations' or 'synthetic'

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

    // 2. Construct the new annotator string
    const originalAnnotator = paper.existing_annotation.annotator || "Original";
    let newAnnotator = originalAnnotator;
    if (currentUser !== originalAnnotator) {
      newAnnotator = `${originalAnnotator} (orig) + ${currentUser}`;
    }

    // 3. Build the full payload
    const payload = {
      doi: paper.doi,
      title: paper.title,
      abstract: paper.abstract,
      dataset: state.currentDataset,
      annotator: newAnnotator,
      model_name:
        localStorage.getItem("geminiModel") || "gemini-1.5-flash-latest",
      sample_count: parseInt(
        localStorage.getItem("augmentSampleCount") || "3",
        10
      ),
      annotations: paper.existing_annotation,
      template: state.activeTemplate,
    };

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

function buildAnnotationsColumns() {
  const cols = [
    {
      title: "Status",
      field: "status",
      width: 120,
      formatter: statusFormatter,
      headerSort: true,
    },
    { title: "Title", field: "title", minWidth: 300, tooltip: true },
    { title: "DOI", field: "doi", width: 220, tooltip: true },
    { title: "Annotator", field: "annotator", width: 150 },
    {
      title: "Latest Comment",
      field: "latest_comment",
      minWidth: 200,
      tooltip: true,
    },
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
  return cols;
}

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
  if (activeDashboardTab === "annotations") {
    document.getElementById("columnsBtn").style.display = "block";
    loadAnnotationsData();
  } else {
    document.getElementById("columnsBtn").style.display = "none";
    loadSyntheticData();
  }
}

function setupEventListeners() {
  if (listenersAttached) return;
  document
    .getElementById("dashboard-refresh-btn")
    .addEventListener("click", loadData);

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

  ensureCommentsModal();
  listenersAttached = true;
}

export function initializeDashboard(_state, _viewManager) {
  state = _state;
  viewManager = _viewManager;
  setupEventListeners();
  return {
    loadData,
  };
}
