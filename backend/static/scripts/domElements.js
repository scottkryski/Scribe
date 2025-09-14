// scripts/domElements.js

// --- Main Views & Containers ---
export let paperView = null;
export let annotationView = null;
export let paperContentContainer = null;
export let pdfViewerContainer = null;
export let abstractContainer = null;
export let fullTextContainer = null;
export let mainView = null;
export let settingsView = null;
export let guideView = null;
export let statsView = null;
export let dashboardView = null; // New

// --- Controls & Inputs ---
export let datasetSelector = null;
export let submitBtn = null;
export let submitAugmentBtn = null;
export let skipBtn = null;
export let highlightToggleButtons = null;
export let annotatorInput = null;
export let annotationForm = null;
export let getSuggestionsBtn = null;
export let saveApiKeyBtn = null;
export let geminiModelSelector = null;
export let apiKeyInput = null;

// --- Navigation Buttons ---
export let showStatsBtn = null;
export let backFromStatsBtn = null;
export let showSettingsBtn = null;
export let backFromSettingsBtn = null;
export let showGuideBtn = null;
export let backFromGuideBtn = null;

// --- Annotation Containers ---
export let annotationFieldsContainer = null;

// --- Paper Content Display ---
export let paperTitle = null;
export let paperAbstract = null;
export let paperFullText = null;
export let paperDoiInput = null;

// --- Progress & Notifications ---
export let loadingOverlay = null;
export let loadingText = null;
export let loadingTitle = null;
export let datasetsAvailableStat = null;
export let reasoningTooltip = null;
export let apiKeyStatus = null;

// --- Scroll Glows ---
export let scrollTopGlow = null;
export let scrollBottomGlow = null;

export let sheetSelector = null;

export let openDataFolderBtnSettings = null;
export let openDataFolderBtnMain = null;
export let refreshDatasetsBtn = null;

// --- Dashboard Elements (New) ---
export let dashboardTableContainer = null;
export let dashboardRefreshBtn = null;
export let dashboardSearchInput = null;

export function init() {
  // This function is called once the DOM is fully loaded

  // --- Main Views & Containers ---
  paperView = document.getElementById("paper-view");
  annotationView = document.getElementById("annotation-view");
  paperContentContainer = document.getElementById("paper-content-container");
  pdfViewerContainer = document.getElementById("pdf-viewer-container");
  abstractContainer = document.getElementById("abstract-container");
  fullTextContainer = document.getElementById("full-text-container");
  mainView = document.getElementById("main-view");
  settingsView = document.getElementById("settings-view");
  guideView = document.getElementById("guide-view");
  statsView = document.getElementById("stats-view");
  dashboardView = document.getElementById("dashboard-view"); // New

  // --- Controls & Inputs ---
  datasetSelector = document.getElementById("dataset-selector");
  submitBtn = document.getElementById("submit-btn");
  submitAugmentBtn = document.getElementById("submit-augment-btn");
  skipBtn = document.getElementById("skip-btn");
  highlightToggleButtons = document.querySelectorAll(".highlight-toggle-btn");
  annotatorInput = document.getElementById("annotator-name");
  annotationForm = document.getElementById("annotation-form");
  getSuggestionsBtn = document.getElementById("get-suggestions-btn");
  saveApiKeyBtn = document.getElementById("save-api-key-btn");
  geminiModelSelector = document.getElementById("gemini-model-selector");
  apiKeyInput = document.getElementById("gemini-api-key-input");

  // --- Navigation Buttons ---
  showStatsBtn = document.getElementById("show-stats-btn");
  backFromStatsBtn = document.getElementById("back-to-main-btn-from-stats");
  showSettingsBtn = document.getElementById("show-settings-btn");
  backFromSettingsBtn = document.getElementById(
    "back-to-main-btn-from-settings"
  );
  showGuideBtn = document.getElementById("show-guide-btn");
  backFromGuideBtn = document.getElementById("back-to-main-btn-from-guide");

  // --- Annotation Containers ---
  annotationFieldsContainer = document.getElementById(
    "annotation-fields-container"
  );

  // --- Paper Content Display ---
  paperTitle = document.getElementById("paper-title");
  paperAbstract = document.getElementById("paper-abstract");
  paperFullText = document.getElementById("paper-full-text");
  paperDoiInput = document.getElementById("paper-doi");

  // --- Progress & Notifications ---
  loadingOverlay = document.getElementById("loading-overlay");
  loadingText = document.getElementById("loading-text");
  loadingTitle = document.getElementById("loading-title");
  datasetsAvailableStat = document.getElementById("datasets-available-stat");
  reasoningTooltip = document.getElementById("reasoning-tooltip");
  apiKeyStatus = document.getElementById("api-key-status");

  // --- Scroll Glows ---
  scrollTopGlow = document.getElementById("scroll-glow-top");
  scrollBottomGlow = document.getElementById("scroll-glow-bottom");

  // --- Sheet Elements ---
  sheetSelector = document.getElementById("sheet-selector");

  openDataFolderBtnSettings = document.getElementById(
    "open-data-folder-btn-settings"
  );
  openDataFolderBtnMain = document.getElementById("open-data-folder-btn");
  refreshDatasetsBtn = document.getElementById("refresh-datasets-btn");

  // --- Dashboard Elements (New) ---
  dashboardTableContainer = document.getElementById(
    "dashboard-table-container"
  );
  dashboardRefreshBtn = document.getElementById("dashboard-refresh-btn");
  dashboardSearchInput = document.getElementById("dashboard-search");
}
