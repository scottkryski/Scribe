import * as dom from "../domElements.js";
import * as api from "../api.js";
import * as ui from "../ui.js";
import { stopLockTimer, startLockTimer } from "./lockTimer.js";

let state = {};
let actions = {};
let dashboardModule = null; // To hold the initialized dashboard module

function setWidescreenIcon(isWidescreen) {
  document.querySelectorAll(".widescreen-toggle-btn").forEach((btn) => {
    const iconExpand = btn.querySelector(".icon-expand");
    const iconCompress = btn.querySelector(".icon-compress");
    if (iconExpand && iconCompress) {
      iconExpand.classList.toggle("hidden", isWidescreen);
      iconCompress.classList.toggle("hidden", !isWidescreen);
    }
  });
}

function setupWidescreenToggle() {
  const mainContentGrid = document.getElementById("main-content-grid");
  document.querySelectorAll(".widescreen-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pageContainers = document.querySelectorAll(".page-container");
      if (pageContainers.length === 0) return;

      const isNowWidescreen = pageContainers[0].classList.toggle("widescreen");
      pageContainers.forEach((container) =>
        container.classList.toggle("widescreen", isNowWidescreen)
      );

      localStorage.setItem("widescreen", isNowWidescreen);

      const storageKey = isNowWidescreen
        ? "panelLayoutWide"
        : "panelLayoutNarrow";
      const layoutForNewMode = localStorage.getItem(storageKey);

      if (layoutForNewMode && window.innerWidth >= 1024) {
        mainContentGrid.style.gridTemplateColumns = layoutForNewMode;
      } else {
        mainContentGrid.style.gridTemplateColumns = "";
      }
      setWidescreenIcon(isNowWidescreen);
    });
  });
}

async function showStatsView() {
  document.getElementById("stats-loading").classList.remove("hidden");
  document.getElementById("stats-content").classList.add("hidden");
  document.getElementById("stats-error").classList.add("hidden");
  try {
    const [detailedStats, summaryStats] = await Promise.all([
      api.getDetailedStats(),
      api.getSheetStats(),
    ]);
    ui.renderDetailedStats(detailedStats, summaryStats);
    document.getElementById("stats-content").classList.remove("hidden");
  } catch (error) {
    console.error("Failed to load stats:", error);
    document.getElementById("stats-error").classList.remove("hidden");
  } finally {
    document.getElementById("stats-loading").classList.add("hidden");
  }
}

async function loadGuideContent() {
  const container = document.querySelector("#guide-view main");
  if (container.dataset.loaded) return;
  try {
    const response = await fetch("/static/guide.html");
    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, "text/html");
    container.innerHTML = doc.querySelector("main").innerHTML;
    container.dataset.loaded = "true";
  } catch (error) {
    container.innerHTML = `<p class="text-red-400">Error loading guide.</p>`;
  }
}

function updateActiveNavButton(activeView) {
  document
    .querySelectorAll(".nav-btn")
    .forEach((btn) => btn.classList.remove("active-nav"));
  document
    .querySelectorAll(`.nav-btn[data-target-view="${activeView.id}"]`)
    .forEach((btn) => btn.classList.add("active-nav"));
}

export function initializeViewManager(_state, _actions, _dashboardModule) {
  state = _state;
  actions = _actions;
  dashboardModule = _dashboardModule;

  document.addEventListener("updateFilterUI", (e) => {
    const status = e.detail;
    const filterControls = document.getElementById("filter-controls");
    const statusContainer = document.getElementById("filter-status-container");
    if (status.is_active) {
      filterControls.classList.add("hidden");
      statusContainer.classList.remove("hidden");
      document.getElementById(
        "filter-status-text"
      ).textContent = `Filtered by "${status.query}" (${status.match_count} found)`;
    } else {
      filterControls.classList.remove("hidden");
      statusContainer.classList.add("hidden");
    }
  });

  const viewManager = {
    showView: (viewToShow) => {
      if (!dom.mainView.classList.contains("hidden")) stopLockTimer();
      [
        dom.mainView,
        dom.settingsView,
        dom.guideView,
        dom.statsView,
        dom.dashboardView,
      ].forEach((v) => v.classList.add("hidden"));

      switch (viewToShow) {
        case dom.mainView:
          if (state.currentPaper) startLockTimer();
          break;
        case dom.statsView:
          showStatsView();
          break;
        case dom.guideView:
          loadGuideContent();
          break;
        case dom.dashboardView:
          if (dashboardModule) dashboardModule.loadData();
          break;
      }

      viewToShow.classList.remove("hidden");
      updateActiveNavButton(viewToShow);
    },

    showAnnotationViewWithPaper: async (paper) => {
      // This is a new method to bridge the dashboard and the main annotator view
      await actions.displaySpecificPaper(paper);
      viewManager.showView(dom.mainView);
    },

    runInitialSetupCheck: async () => {
      const apiKeyStatus = await api.checkApiKeyStatus();
      const annotatorName = localStorage.getItem("annotatorName");
      if (!apiKeyStatus.is_set || !annotatorName) {
        viewManager.showView(dom.settingsView);
        document.getElementById("setup-message").classList.remove("hidden");
        return false;
      }
      document.getElementById("setup-message").classList.add("hidden");
      return true;
    },

    setupViewSwitching: () => {
      document.body.addEventListener("click", async (e) => {
        const navBtn = e.target.closest(".nav-btn");
        if (!navBtn || !navBtn.dataset.targetView) return;
        const targetView = document.getElementById(navBtn.dataset.targetView);
        if (targetView) {
          if (
            targetView === dom.dashboardView &&
            (!state.currentSheetId || !state.currentDataset)
          ) {
            ui.showToastNotification(
              "Please select a sheet and dataset first.",
              "warning"
            );
            return;
          }
          if (
            targetView === dom.mainView &&
            !(await viewManager.runInitialSetupCheck())
          ) {
            ui.showToastNotification("Please complete setup first.", "warning");
          } else {
            viewManager.showView(targetView);
          }
        }
      });
    },

    setupPanelResizing: () => {
      const grid = document.getElementById("main-content-grid");
      const handle = document.getElementById("resize-handle");

      // Initial setup
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
        grid.style.gridTemplateColumns = savedLayout;
      }

      // Event Listeners
      if (handle) {
        handle.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const onMouseMove = (moveEvent) => {
            let newWidth =
              moveEvent.clientX - grid.getBoundingClientRect().left;
            if (newWidth > 320 && grid.offsetWidth - newWidth > 320) {
              grid.style.gridTemplateColumns = `${newWidth}px 1rem 1fr`;
            }
          };
          const onMouseUp = () => {
            const isWidescreen = document
              .querySelector(".page-container")
              .classList.contains("widescreen");
            const currentStorageKey = isWidescreen
              ? "panelLayoutWide"
              : "panelLayoutNarrow";
            localStorage.setItem(
              currentStorageKey,
              grid.style.gridTemplateColumns
            );
            document.removeEventListener("mousemove", onMouseMove);
          };
          document.addEventListener("mousemove", onMouseMove);
          document.addEventListener("mouseup", onMouseUp, { once: true });
        });
      }
      setupWidescreenToggle();
    },
  };

  document.addEventListener("stats:reopen", async (event) => {
    const detail = event.detail || {};
    const doi = detail.doi;
    const datasetFromEvent = detail.dataset;
    const button = detail.button;

    if (!doi) {
      ui.showToastNotification("Missing DOI for this annotation.", "error");
      return;
    }

    const targetDataset = datasetFromEvent || state.currentDataset;
    if (!targetDataset) {
      ui.showToastNotification(
        "Cannot reopen: no dataset specified for this record.",
        "error"
      );
      return;
    }

    const annotatorName = localStorage.getItem("annotatorName");
    if (!annotatorName) {
      ui.showToastNotification(
        "Set your annotator name in Settings before reopening.",
        "warning"
      );
      return;
    }

    const disableButton = () => {
      if (!button) return;
      button.disabled = true;
      button.classList.add("opacity-50", "cursor-not-allowed");
    };
    const restoreButton = () => {
      if (!button) return;
      button.disabled = false;
      button.classList.remove("opacity-50", "cursor-not-allowed");
    };

    disableButton();

    try {
      await api.setLock(doi, annotatorName, targetDataset);
    } catch (error) {
      ui.showToastNotification(
        `Could not lock ${doi}: ${error.message}`,
        "error"
      );
      restoreButton();
      return;
    }

    try {
      const paper = await api.reopenAnnotation(doi, targetDataset);
      await viewManager.showAnnotationViewWithPaper(paper);
      ui.showToastNotification(`Reopened ${doi} for annotation.`, "success");
    } catch (error) {
      ui.showToastNotification(
        `Error reopening ${doi}: ${error.message}`,
        "error"
      );
    } finally {
      restoreButton();
    }
  });

  return viewManager;
}
