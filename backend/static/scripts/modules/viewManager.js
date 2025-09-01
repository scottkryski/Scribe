import * as dom from "../domElements.js";
import * as api from "../api.js";
import * as ui from "../ui.js";
import { stopLockTimer, startLockTimer } from "./lockTimer.js";

let state = {};
let actions = {};

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

export function initializeViewManager(_state, _actions) {
  state = _state;
  actions = _actions;

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
      [dom.mainView, dom.settingsView, dom.guideView, dom.statsView].forEach(
        (v) => v.classList.add("hidden")
      );

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
      }

      viewToShow.classList.remove("hidden");
      updateActiveNavButton(viewToShow);
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

  return viewManager;
}
