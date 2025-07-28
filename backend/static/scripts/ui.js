// scripts/ui.js
import * as dom from "./domElements.js";
import * as api from "./api.js";

// --- Notifications & Loaders ---

export function showLoading(title, text) {
  dom.loadingTitle.textContent = title;
  dom.loadingText.textContent = text;
  dom.loadingOverlay.classList.remove("hidden");
}

export function hideLoading() {
  dom.loadingOverlay.classList.add("hidden");
}

export function setButtonLoading(button, isLoading, text = "") {
  if (isLoading) {
    button.disabled = true;
    button.innerHTML = `
            <div class="flex items-center justify-center">
                <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>${text}</span>
            </div>
        `;
  } else {
    button.disabled = false;
    button.innerHTML = text;
  }
}

export function showToastNotification(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const notification = document.createElement("div");

  const typeClasses = {
    success: "bg-green-600/80 border-green-700",
    error: "bg-red-600/80 border-red-700",
    warning: "bg-yellow-500/80 border-yellow-600",
    info: "bg-blue-600/80 border-blue-700",
  };

  notification.className = `toast-notification fade-in ${
    typeClasses[type] || typeClasses["info"]
  }`;
  notification.innerHTML = `<p>${message}</p>`;

  container.appendChild(notification);

  setTimeout(() => {
    notification.classList.replace("fade-in", "fade-out");
    notification.addEventListener("animationend", () => notification.remove());
  }, 5000);
}

function showIncompleteAnnotationNotification() {
  const message = `<p class="font-bold text-white">Incomplete Annotation Found</p><p class="text-sm text-white">This paper was partially saved. Missing fields are highlighted.</p>`;
  showToastNotification(message, "warning");
}

// --- Form & Content Management ---

function highlightMissingFields(annotationData) {
  document
    .querySelectorAll(".field-missing")
    .forEach((el) => el.classList.remove("field-missing"));

  const form = document.getElementById("annotation-form");
  if (!form) return;

  const requiredElements = form.querySelectorAll("[id]");

  requiredElements.forEach((element) => {
    const fieldId = element.id;
    if (!fieldId || fieldId.endsWith("_context")) return;

    const value = annotationData[fieldId];
    if (value === undefined || String(value).trim() === "") {
      const container = element.closest(".annotation-row");
      if (container) container.classList.add("field-missing");
    }
  });
}

function applyExistingAnnotation(annotationData) {
  if (!annotationData) return;

  for (const key in annotationData) {
    const value = annotationData[key];
    const element = document.getElementById(key);

    if (element) {
      if (element.type === "checkbox") {
        element.checked =
          String(value).trim().toLowerCase() === "true" || value === true;
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event("change"));
    }

    const contextTextarea = document.querySelector(`[name="${key}_context"]`);
    if (contextTextarea && annotationData[`${key}_context`]) {
      contextTextarea.value = annotationData[`${key}_context`];
    }
  }
}

export function applyGeminiSuggestions(suggestions, activeTemplate) {
  if (!suggestions || !activeTemplate) return;

  document
    .querySelectorAll(".reasoning-bubble-btn")
    .forEach((btn) => btn.classList.add("hidden"));

  for (const key in suggestions) {
    if (key.endsWith("_context") || key.endsWith("_reasoning")) continue;

    const element = document.getElementById(key);
    if (!element) continue;

    const fieldDef = activeTemplate.fields.find((f) => f.id === key);

    const value = suggestions[key];
    const context = suggestions[`${key}_context`];
    const reasoning = suggestions[`${key}_reasoning`];

    if (element.type === "checkbox") {
      element.checked = value;
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("change"));

    if (element.dataset.contextTarget) {
      const contextTextarea = document.querySelector(
        `[name="${element.dataset.contextTarget}"]`
      );
      if (contextTextarea) {
        // This block implements the fallback behavior.
        const summaryFieldType = fieldDef?.ai_summary_field || "context";
        let textToApply = "";

        if (summaryFieldType === "reasoning") {
          // If the user explicitly wants reasoning, use it.
          textToApply = reasoning || "";
        } else {
          // Default to 'context' but fall back to 'reasoning' if context is empty.
          textToApply = context || reasoning || "";
        }
        contextTextarea.value = textToApply;
      }
    }

    const reasoningBtn = document.querySelector(
      `.reasoning-bubble-btn[data-reasoning-target="${key}"]`
    );
    if (reasoningBtn && reasoning) {
      reasoningBtn.dataset.reasoningText = reasoning;
      reasoningBtn.classList.remove("hidden");
    }
  }
}

export function resetForm() {
  if (dom.annotationForm) {
    dom.annotationForm.reset();
    dom.annotationForm
      .querySelectorAll('input[type="checkbox"], select')
      .forEach((el) => {
        el.dispatchEvent(new Event("change"));
      });
  }
  document
    .querySelectorAll(".field-missing")
    .forEach((el) => el.classList.remove("field-missing"));
  document.querySelectorAll(".reasoning-bubble-btn").forEach((btn) => {
    btn.classList.add("hidden");
    btn.dataset.reasoningText = "";
  });
}

export function setupContextToggles() {
  document.querySelectorAll("[data-context-target]").forEach((control) => {
    control.addEventListener("change", (event) => {
      const targetId = event.target.dataset.contextTarget;
      const contextBox = document.getElementById(targetId);
      if (contextBox) {
        let shouldShow =
          event.target.type === "checkbox"
            ? event.target.checked
            : !!event.target.value;
        contextBox.classList.toggle("hidden", !shouldShow);
      }
    });
  });
}

async function loadPdf(paper) {
  dom.pdfViewerContainer.innerHTML = `<h3 class="text-lg font-semibold text-white mb-4">PDF Viewer</h3><p class="text-gray-300">Attempting to load PDF...</p>`;
  const url =
    typeof paper.open_access_pdf === "object"
      ? paper.open_access_pdf?.url
      : paper.open_access_pdf;

  if (!url || !url.startsWith("http")) {
    dom.pdfViewerContainer.innerHTML += `<p class="text-yellow-400 mt-2">No valid PDF link found in data.</p>`;
    paper.pdf_filename = null;
    return;
  }

  try {
    const nameParts = paper.authors?.[0]?.name?.trim().split(" ") || [];
    const authorLastName =
      nameParts.length > 0 ? nameParts[nameParts.length - 1] : "UnknownAuthor";

    const { blob, filename } = await api.downloadPdf({
      url: url,
      title: paper.title || "Untitled Paper",
      author: authorLastName,
      year: paper.year || 0,
    });

    paper.pdf_filename = filename;

    const objectURL = URL.createObjectURL(blob);
    dom.pdfViewerContainer.innerHTML = `<h3 class="text-lg font-semibold text-white mb-4">PDF Viewer</h3><iframe class="pdf-iframe" src="${objectURL}#view=FitH" type="application/pdf"></iframe>`;
  } catch (error) {
    console.error("PDF Load Error:", error);
    paper.pdf_filename = null;
    dom.pdfViewerContainer.innerHTML += `<div class="mt-2 p-4 bg-red-900 bg-opacity-50 rounded-lg"><p class="font-bold text-red-300">Could not load PDF</p><p class="text-red-400 text-sm mt-1">Reason: ${error.message}</p></div>`;
  }
}

export async function renderPaper(paper) {
  dom.paperTitle.textContent = paper.title || "No Title Provided";
  dom.paperDoiInput.value = paper.doi;

  const abstractHTML = paper.abstract || "";
  if (abstractHTML) {
    dom.paperAbstract.innerHTML = abstractHTML;
    dom.abstractContainer.classList.remove("hidden");
  } else {
    dom.abstractContainer.classList.add("hidden");
  }

  const fullTextHTML = paper.full_text
    ? paper.full_text
        .split("\n")
        .map((p) => `<p class="mb-4">${p.trim()}</p>`)
        .join("")
    : "";
  if (fullTextHTML) {
    dom.paperFullText.innerHTML = fullTextHTML;
    dom.fullTextContainer.classList.remove("hidden");
  } else {
    dom.fullTextContainer.classList.add("hidden");
  }

  dom.pdfViewerContainer.classList.remove("hidden");
  await loadPdf(paper);

  if (paper.existing_annotation) {
    applyExistingAnnotation(paper.existing_annotation);
    showIncompleteAnnotationNotification();
    highlightMissingFields(paper.existing_annotation);
  } else {
    resetForm();
  }

  return {
    originalAbstractHTML: abstractHTML,
    originalFullTextHTML: fullTextHTML,
  };
}

export function renderDetailedStats(stats, summary) {
  const {
    total_annotations,
    overall_counts,
    doc_type_distribution,
    leaderboard,
    dataset_stats,
  } = stats;
  const { completed_count, incomplete_count } = summary;

  document.getElementById("stats-total-annotations").textContent =
    total_annotations;
  document.getElementById("stats-completed-annotations").textContent =
    completed_count;
  document.getElementById("stats-incomplete-annotations").textContent =
    incomplete_count;

  const breakdownContainer = document.getElementById("stats-overall-breakdown");
  breakdownContainer.innerHTML = "";

  for (const key in overall_counts) {
    const counts = overall_counts[key] || {};
    const trueCount = counts["TRUE"] || 0;
    const totalForField = (counts["TRUE"] || 0) + (counts["FALSE"] || 0);
    const percentage =
      totalForField > 0 ? ((trueCount / totalForField) * 100).toFixed(1) : 0;

    const card = `
            <div class="glass-effect p-4 rounded-xl">
                <div class="flex justify-between items-center mb-2">
                    <span class="font-semibold text-gray-200 truncate pr-2">${key}</span>
                    <span class="font-bold text-white">${trueCount}</span>
                </div>
                <div class="w-full bg-black bg-opacity-20 rounded-full h-2.5">
                    <div class="bg-purple-500 h-2.5 rounded-full" style="width: ${percentage}%"></div>
                </div>
                <p class="text-right text-sm text-gray-400 mt-1">${percentage}% TRUE</p>
            </div>
        `;
    breakdownContainer.innerHTML += card;
  }

  const docTypeContainer = document.getElementById("stats-doc-type-dist");
  docTypeContainer.innerHTML = "";
  if (doc_type_distribution && Object.keys(doc_type_distribution).length > 0) {
    const sortedDocTypes = Object.entries(doc_type_distribution).sort(
      ([, a], [, b]) => b - a
    );
    for (const [docType, count] of sortedDocTypes) {
      const percentage =
        total_annotations > 0
          ? ((count / total_annotations) * 100).toFixed(1)
          : 0;
      const item = `
                <div>
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-sm font-medium text-gray-200">${docType}</span>
                        <span class="text-sm text-gray-300">${count} (${percentage}%)</span>
                    </div>
                    <div class="w-full bg-black bg-opacity-20 rounded-full h-2">
                        <div class="bg-indigo-500 h-2 rounded-full" style="width: ${percentage}%"></div>
                    </div>
                </div>
            `;
      docTypeContainer.innerHTML += item;
    }
  } else {
    docTypeContainer.innerHTML = `<p class="text-sm text-gray-400">No 'attribute_docType' data found.</p>`;
  }

  const leaderboardContainer = document.getElementById("stats-leaderboard");
  leaderboardContainer.innerHTML = "";
  leaderboard.slice(0, 5).forEach((entry, index) => {
    const item = `
            <div class="flex items-center gap-4">
                <div class="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center font-bold text-lg ${
                  index < 3 ? "bg-pink-500" : "bg-gray-500"
                }">${index + 1}</div>
                <div class="flex-grow">
                    <p class="font-semibold text-white">${entry.annotator}</p>
                    <p class="text-sm text-gray-400">${
                      entry.count
                    } annotations</p>
                </div>
            </div>
        `;
    leaderboardContainer.innerHTML += item;
  });

  const datasetContainer = document.getElementById("stats-dataset-dist");
  datasetContainer.innerHTML = "";
  const sortedDatasets = Object.entries(dataset_stats).sort(
    ([, a], [, b]) => b - a
  );
  for (const [name, count] of sortedDatasets) {
    const percentage =
      total_annotations > 0
        ? ((count / total_annotations) * 100).toFixed(1)
        : 0;
    const item = `
             <div>
                <div class="flex justify-between items-center mb-1">
                    <span class="text-sm font-medium text-gray-200 truncate pr-2">${name}</span>
                    <span class="text-sm text-gray-300 flex-shrink-0">${count} (${percentage}%)</span>
                </div>
                <div class="w-full bg-black bg-opacity-20 rounded-full h-2">
                    <div class="bg-blue-500 h-2 rounded-full" style="width: ${percentage}%"></div>
                </div>
            </div>
        `;
    datasetContainer.innerHTML += item;
  }
}
