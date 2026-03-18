import * as api from "../api.js";
import * as dom from "../domElements.js";
import * as ui from "../ui.js";

let state = {};
let viewManager = null;
let listenersAttached = false;

let overviewCache = null;
let selectedDoi = null;
let selectedQueueFilter = "";
let selectedReasonFilter = "";
let selectedTriggerFilter = "";
let selectedSheetLabel = "";

const REASON_CHOICES = [
  {
    id: "human_gold_error",
    label: "Human label / rubric incorrect",
    subtitle: "The spreadsheet gold label or rubric interpretation is wrong.",
  },
  {
    id: "doctype_gate_error",
    label: "Doc-type gate error",
    subtitle: "The paper was routed, run, or skipped by the wrong document-type gate.",
  },
  {
    id: "retrieval_miss",
    label: "Retrieval miss",
    subtitle: "Relevant evidence exists in the paper but was not retrieved.",
  },
  {
    id: "retrieval_wrong_evidence",
    label: "Wrong evidence retrieved",
    subtitle: "The context was present, but it was the wrong support for this field.",
  },
  {
    id: "source_text_issue",
    label: "Source text issue",
    subtitle: "The PDF, OCR, markdown, or full text is degraded or incomplete.",
  },
  {
    id: "extraction_payload_error",
    label: "Extraction payload error",
    subtitle: "The structured booleans or component payload are wrong.",
  },
  {
    id: "adjudication_rule_error",
    label: "Adjudication / rule error",
    subtitle: "The extraction looked plausible, but rules or postprocess mapped it incorrectly.",
  },
  {
    id: "prompt_reasoning_error",
    label: "Prompt reasoning error",
    subtitle: "The model saw relevant evidence but reasoned incorrectly from it.",
  },
  {
    id: "ambiguous_case",
    label: "Ambiguous case",
    subtitle: "This looks genuinely unclear under the current rubric.",
  },
  {
    id: "both_human_ai_incorrect",
    label: "Both human and AI incorrect",
    subtitle: "Use when the spreadsheet label and model output are both clearly wrong.",
  },
];

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(
    /[&<>"']/g,
    (match) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[match] || match)
  );
}

function renderReasonChoice(choice, checkboxClass, disabled = false) {
  return `
    <label class="flex items-start gap-3 bg-black/20 rounded-lg px-3 py-2 border border-white/10 hover:border-white/20 cursor-pointer">
      <input type="checkbox" class="${checkboxClass}" value="${escapeHtml(
        choice.id
      )}" ${disabled ? "disabled" : ""} />
      <span class="min-w-0">
        <span class="block text-sm text-gray-200">${escapeHtml(choice.label)}</span>
        ${
          choice.subtitle
            ? `<span class="block text-[11px] leading-tight text-gray-400 mt-0.5">${escapeHtml(
                choice.subtitle
              )}</span>`
            : ""
        }
      </span>
    </label>
  `;
}

function setLoading(isLoading) {
  const list = document.getElementById("benchmark-doi-list");
  const details = document.getElementById("benchmark-doi-details");
  const placeholder = document.getElementById(
    "benchmark-doi-details-placeholder"
  );
  if (list) {
    list.innerHTML = isLoading
      ? '<div class="loading-spinner mx-auto my-6"></div>'
      : "";
  }
  if (details && placeholder) {
    details.classList.toggle("hidden", true);
    placeholder.classList.toggle("hidden", false);
    placeholder.innerHTML = isLoading
      ? '<div class="loading-spinner mx-auto my-6"></div>'
      : '<p class="text-gray-300">Select a DOI to begin reviewing.</p>';
  }
}

function renderStats(overview) {
  const statsEl = document.getElementById("benchmark-review-stats");
  if (!statsEl) return;
  const stats = overview?.stats || {};
  const source = overview?.source || {};
  const reasonCounts = stats.reason_counts || {};
  const incorrectDist = stats.incorrect_distribution || {};
  const reasonLines = Object.keys(reasonCounts)
    .sort((a, b) => (reasonCounts[b] || 0) - (reasonCounts[a] || 0))
    .slice(0, 6)
    .map(
      (reason) =>
        `<button class="benchmark-reason-chip w-full flex justify-between text-xs text-gray-300 hover:text-white" data-reason="${escapeHtml(
          reason
        )}"><span class="truncate">${escapeHtml(
          reason
        )}</span><span class="text-gray-400">${reasonCounts[reason]}</span></button>`
    )
    .join("");

  const distLabels = ["1", "2", "3-5", "6-10", "11+"];
  const distHtml = distLabels
    .filter((k) => incorrectDist[k])
    .map(
      (k) =>
        `<div class="flex justify-between text-xs text-gray-300"><span>${escapeHtml(
          k
        )} errors</span><span class="text-gray-400">${escapeHtml(
          incorrectDist[k]
        )} DOIs</span></div>`
    )
    .join("");

  statsEl.innerHTML = `
    <div class="glass-effect rounded-2xl p-4 border border-white/10">
      <h3 class="text-lg font-semibold mb-3">Review Stats</h3>
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div class="bg-black/20 rounded-lg p-3">
          <div class="text-gray-400 text-xs">DOIs in queue</div>
          <div class="text-xl font-bold">${escapeHtml(
            stats.queue_dois ?? "—"
          )}</div>
        </div>
        <div class="bg-black/20 rounded-lg p-3">
          <div class="text-gray-400 text-xs">Remaining</div>
          <div class="text-xl font-bold">${escapeHtml(
            stats.remaining_dois ?? "—"
          )}</div>
        </div>
        <div class="bg-black/20 rounded-lg p-3">
          <div class="text-gray-400 text-xs">Submissions</div>
          <div class="text-xl font-bold">${escapeHtml(
            stats.total_submissions ?? "—"
          )}</div>
        </div>
        <div class="bg-black/20 rounded-lg p-3">
          <div class="text-gray-400 text-xs">Fields reviewed</div>
          <div class="text-xl font-bold">${escapeHtml(
            stats.unique_fields_reviewed ?? "—"
          )}</div>
        </div>
      </div>
      <div class="mt-3">
        <div class="text-gray-400 text-xs mb-2">Top reasons</div>
        <div class="space-y-1">${reasonLines || '<div class="text-xs text-gray-500">No reviews yet.</div>'}</div>
      </div>
      <div class="mt-3">
        <div class="text-gray-400 text-xs mb-2">Errors per DOI</div>
        <div class="space-y-1">${distHtml || '<div class="text-xs text-gray-500">—</div>'}</div>
      </div>
      <div class="mt-3 text-xs text-gray-500">
        Source: ${escapeHtml(source.type || "—")}${
          source.uploaded_at_utc ? ` • ${escapeHtml(source.uploaded_at_utc)}` : ""
        }
      </div>
    </div>
  `;
}

function getFilteredQueue(queue) {
  const q = String(selectedQueueFilter || "").trim().toLowerCase();
  return (queue || []).filter((item) => {
    const doi = String(item.doi || "").toLowerCase();
    const dataset = String(item.dataset || "").toLowerCase();
    const docType = String(item.doc_type || "").toLowerCase();
    const matchesSearch =
      !q || doi.includes(q) || dataset.includes(q) || docType.includes(q);
    const reason = String(selectedReasonFilter || "").trim();
    const trigger = String(selectedTriggerFilter || "").trim();
    const matchesReason =
      !reason ||
      (Array.isArray(item.reason_codes) && item.reason_codes.includes(reason));
    const matchesTrigger =
      !trigger ||
      (Array.isArray(item.trigger_names) && item.trigger_names.includes(trigger));
    return matchesSearch && matchesReason && matchesTrigger;
  });
}

function renderActiveFilters() {
  const el = document.getElementById("benchmark-active-filters");
  if (!el) return;
  const parts = [];
  if (selectedSheetLabel) parts.push(`Sheet: ${selectedSheetLabel}`);
  if (selectedReasonFilter) parts.push(`Reason: ${selectedReasonFilter}`);
  if (selectedTriggerFilter) parts.push(`Field: ${selectedTriggerFilter}`);
  el.textContent = parts.length ? parts.join(" • ") : "";
}

async function renderSheetSelector() {
  const sheetSelect = document.getElementById("benchmark-sheet-selector");
  if (!sheetSelect) return;

  const sheets = await api.getSheets().catch(() => []);
  const currentSheetId = String(state.currentSheetId || "").trim();
  const currentSheet = sheets.find((sheet) => String(sheet.id || "") === currentSheetId);

  sheetSelect.innerHTML = sheets.length
    ? sheets
        .map(
          (sheet) =>
            `<option value="${escapeHtml(sheet.id)}">${escapeHtml(
              sheet.name || sheet.id
            )}</option>`
        )
        .join("")
    : '<option value="">No sheets configured</option>';

  if (currentSheetId && sheets.some((sheet) => String(sheet.id || "") === currentSheetId)) {
    sheetSelect.value = currentSheetId;
    selectedSheetLabel = currentSheet?.name || currentSheetId;
  } else if (sheets.length === 1) {
    sheetSelect.value = String(sheets[0].id || "");
    selectedSheetLabel = sheets[0].name || String(sheets[0].id || "");
  } else {
    sheetSelect.value = "";
    selectedSheetLabel = "";
  }

  renderActiveFilters();
}

function renderExploreFilters(overview) {
  const reasonSelect = document.getElementById("benchmark-reason-filter");
  const triggerSelect = document.getElementById("benchmark-trigger-filter");
  if (!reasonSelect || !triggerSelect) return;

  const reasons = overview?.explore?.reasons || [];
  const triggers = overview?.explore?.triggers || [];

  const priorReason = selectedReasonFilter;
  const priorTrigger = selectedTriggerFilter;

  reasonSelect.innerHTML = `<option value="">All reasons</option>${reasons
    .map(
      (r) =>
        `<option value="${escapeHtml(r.reason)}">${escapeHtml(
          r.reason
        )} (${escapeHtml(r.doi_count ?? 0)} DOIs)</option>`
    )
    .join("")}`;
  triggerSelect.innerHTML = `<option value="">All fields</option>${triggers
    .map(
      (t) =>
        `<option value="${escapeHtml(t.trigger_name)}">${escapeHtml(
          t.trigger_name
        )} (${escapeHtml(t.doi_count ?? 0)} DOIs)</option>`
    )
    .join("")}`;

  selectedReasonFilter = priorReason || "";
  selectedTriggerFilter = priorTrigger || "";
  reasonSelect.value = selectedReasonFilter;
  triggerSelect.value = selectedTriggerFilter;
  renderActiveFilters();
}

function renderQueueList(overview) {
  const list = document.getElementById("benchmark-doi-list");
  const emptyEl = document.getElementById("benchmark-doi-empty");
  if (!list) return;

  const queue = getFilteredQueue(overview?.queue || []);
  if (emptyEl) {
    emptyEl.classList.toggle("hidden", queue.length !== 0);
  }

  list.innerHTML = queue
    .map((item) => {
      const isActive = item.doi === selectedDoi;
      const incorrectCount = item.incorrect_count ?? 0;
      const submissionCount = item.submission_count ?? 0;
      const reviewed =
        submissionCount <= 0
          ? "Not reviewed"
          : `Reviews logged: ${submissionCount}`;
      const reviewedClass =
        submissionCount <= 0
          ? "text-gray-300"
          : "text-emerald-300";
      const activeClass = isActive
        ? "border-blue-400/60 bg-blue-500/10"
        : "border-white/10 bg-black/10 hover:bg-black/20";
      const topReasons = Array.isArray(item.top_reasons) ? item.top_reasons : [];
      const topReasonsText = topReasons.length
        ? `Top reasons: ${topReasons
            .map((r) => `${r.reason} (${r.count})`)
            .slice(0, 2)
            .join(", ")}`
        : "";
      return `
        <button class="benchmark-doi-btn w-full text-left glass-effect rounded-xl p-3 border ${activeClass} transition-colors" data-doi="${escapeHtml(
          item.doi
        )}">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-mono text-gray-200 truncate">${escapeHtml(
                item.doi
              )}</div>
              <div class="text-xs text-gray-400 truncate">${escapeHtml(
                item.dataset || ""
              )}${item.doc_type ? ` • ${escapeHtml(item.doc_type)}` : ""}</div>
              ${
                topReasonsText
                  ? `<div class="text-[11px] text-gray-500 truncate mt-1">${escapeHtml(
                      topReasonsText
                    )}</div>`
                  : ""
              }
            </div>
            <div class="flex flex-col items-end shrink-0">
              <div class="text-xs text-gray-400">Incorrect fields</div>
              <div class="text-lg font-bold text-white">${escapeHtml(
                incorrectCount
              )}</div>
              <div class="text-[11px] ${reviewedClass}">${reviewed}${
        item.submission_count ? ` (${item.submission_count})` : ""
      }</div>
            </div>
          </div>
        </button>
      `;
    })
    .join("");
}

function parseReasonCodes(value) {
  const normalize = (items) =>
    (items || [])
      .map((item) => String(item || "").trim())
      .filter((item) => item && item !== "[]" && item !== "{}");

  if (!value) return [];
  if (Array.isArray(value)) return normalize(value);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? normalize(parsed) : [];
  } catch (e) {
    return normalize(
      trimmed
      .split(",")
    );
  }
}

function safeJsonParse(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
}

function parseReviewHistory(value) {
  const parsed = safeJsonParse(value);
  return Array.isArray(parsed)
    ? parsed.filter((item) => item && typeof item === "object")
    : [];
}

function buildSubmissionsFromSheetRows(sheetRows, doi, triggerName = "") {
  const doiKey = String(doi || "").trim();
  const triggerKey = String(triggerName || "").trim();
  const rows = [];

  (sheetRows || []).forEach((row) => {
    const rowDoi = String(row?.doi || "").trim();
    if (!rowDoi || rowDoi !== doiKey) return;
    const rowTrigger = String(row?.trigger_name || "").trim();
    if (triggerKey && rowTrigger !== triggerKey) return;

    const history = parseReviewHistory(row?.review_history_json);
    if (history.length) {
      history.forEach((entry) => {
        const codesValue =
          entry.reason_codes_json !== undefined
            ? entry.reason_codes_json
            : entry.reason_codes;
        rows.push({
          timestamp_utc: String(entry.timestamp_utc || entry.timestamp || ""),
          reviewed_by: String(entry.reviewed_by || ""),
          doi: rowDoi,
          trigger_name: rowTrigger,
          reason_codes_json: Array.isArray(codesValue) || typeof codesValue === "object"
            ? JSON.stringify(codesValue)
            : String(codesValue || "[]"),
          comment: String(entry.comment || ""),
        });
      });
      return;
    }

    const reviewCount = Number.parseInt(String(row?.review_count || "0"), 10) || 0;
    const reasonCodes = String(row?.reason_codes_json || "").trim();
    if (reviewCount > 0 || reasonCodes) {
      rows.push({
        timestamp_utc: String(row.reviewed_at_utc || row.timestamp_utc || ""),
        reviewed_by: String(row.reviewed_by || ""),
        doi: rowDoi,
        trigger_name: rowTrigger,
        reason_codes_json: reasonCodes || "[]",
        comment: String(row.comment || ""),
      });
    }
  });

  rows.sort((a, b) => String(a.timestamp_utc || "").localeCompare(String(b.timestamp_utc || "")));
  return { rows };
}

function formatPayloadKey(key) {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatPayloadValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function getPayloadFromComponentReasoning(rawComponentReasoning, explicitPayload) {
  if (
    explicitPayload &&
    typeof explicitPayload === "object" &&
    !Array.isArray(explicitPayload)
  ) {
    return explicitPayload;
  }
  const parsed = safeJsonParse(rawComponentReasoning);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  if (
    parsed.payload &&
    typeof parsed.payload === "object" &&
    !Array.isArray(parsed.payload)
  ) {
    return parsed.payload;
  }

  return parsed;
}

function renderSubmissionsForDoi(submissionsPayload) {
  const container = document.getElementById("benchmark-previous-submissions");
  if (!container) return;
  const rows = submissionsPayload?.rows || [];
  if (!rows.length) {
    container.innerHTML = `
      <div class="glass-effect rounded-2xl p-4 border border-white/10">
        <h3 class="text-lg font-semibold mb-2">Previous Reviews</h3>
        <div class="text-sm text-gray-400">No submissions for this DOI yet.</div>
      </div>
    `;
    return;
  }

  const items = rows
    .slice()
    .reverse()
    .slice(0, 50)
    .map((row) => {
      const codes = parseReasonCodes(row.reason_codes_json);
      const comment = String(row.comment || "").trim();
      const trigger = String(row.trigger_name || "").trim();
      return `
        <div class="bg-black/20 rounded-xl p-3 border border-white/10">
          <div class="flex justify-between gap-3">
            <div class="text-xs text-gray-400 truncate">${escapeHtml(
              row.timestamp_utc || row.timestamp || ""
            )}</div>
            <div class="text-xs text-gray-300 truncate">by ${escapeHtml(
              row.reviewed_by || "unknown"
            )}</div>
          </div>
          ${
            trigger
              ? `<div class="mt-2 text-sm font-semibold text-white truncate">${escapeHtml(
                  trigger
                )}</div>`
              : ""
          }
          <div class="mt-2 flex flex-wrap gap-2">
            ${(codes || [])
              .map(
                (c) =>
                  `<span class="text-[11px] px-2 py-1 rounded-full bg-blue-500/20 text-blue-200 border border-blue-500/30">${escapeHtml(
                    c
                  )}</span>`
              )
              .join("")}
          </div>
          ${
            comment
              ? `<div class="mt-2 text-sm text-gray-200 whitespace-pre-wrap">${escapeHtml(
                  comment
                )}</div>`
              : ""
          }
        </div>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="glass-effect rounded-2xl p-4 border border-white/10">
      <h3 class="text-lg font-semibold mb-3">Previous Reviews</h3>
      <div class="space-y-2 max-h-[320px] overflow-y-auto pr-1">${items}</div>
    </div>
  `;
}

function renderDoiDetails(doiPayload, submissionsPayload, sheetConnected) {
  const details = document.getElementById("benchmark-doi-details");
  const placeholder = document.getElementById(
    "benchmark-doi-details-placeholder"
  );
  if (!details || !placeholder) return;

  const submissionRows = submissionsPayload?.rows || [];
  const submissionsByTrigger = submissionRows.reduce((acc, row) => {
    const trigger = String(row.trigger_name || "").trim() || "";
    if (!trigger) return acc;
    acc[trigger] = acc[trigger] || [];
    acc[trigger].push(row);
    return acc;
  }, {});

  const doi = doiPayload?.doi || "";
  const dataset = doiPayload?.dataset || "";
  const docType = doiPayload?.doc_type || "";
  const incorrectCount = doiPayload?.incorrect_count ?? 0;
  const annotator = String(doiPayload?.annotator || "").trim();
  const accuracy =
    typeof doiPayload?.summary?.accuracy === "number"
      ? (doiPayload.summary.accuracy * 100).toFixed(1) + "%"
      : "";

  const bulkReasonsHtml = REASON_CHOICES.map((choice) =>
    renderReasonChoice(choice, "benchmark-bulk-reason-checkbox", !sheetConnected)
  ).join("");

  const items = (doiPayload?.incorrect || []).map((item) => {
    const chunks = item.evidence_chunks || [];
    const triggerName = item.trigger_name || "";
    const fieldSubs = submissionsByTrigger[triggerName] || [];
    const lastSub = fieldSubs.length ? fieldSubs[fieldSubs.length - 1] : null;
    const lastCodes = lastSub ? parseReasonCodes(lastSub.reason_codes_json) : [];
    const payload = getPayloadFromComponentReasoning(
      item.component_reasoning,
      item.payload
    );
    const rawComponentReasoning = String(item.component_reasoning || "").trim();
    const payloadReasoning =
      payload && typeof payload.reasoning === "string" ? payload.reasoning : "";
    const payloadEntries = payload
      ? Object.entries(payload).filter(([key]) => key !== "reasoning")
      : [];

    const reasonsHtml = REASON_CHOICES.map((choice) =>
      renderReasonChoice(choice, "benchmark-reason-checkbox", !sheetConnected)
    ).join("");

    const chunksBlock = chunks.length
      ? `
        <details class="mt-3">
          <summary class="text-xs text-blue-300 hover:text-blue-200 cursor-pointer font-semibold">Context provided to model (${chunks.length} chunks)</summary>
          <div class="mt-2 space-y-2">
            ${chunks
              .map((ch, idx) => {
                const headerBits = [
                  ch.section ? `Section: ${escapeHtml(ch.section)}` : "",
                  ch.score !== null && ch.score !== undefined
                    ? `Score: ${escapeHtml(ch.score)}`
                    : "",
                ].filter(Boolean);
                const header = headerBits.length
                  ? `<div class="text-[11px] text-gray-400 mb-1">${headerBits.join(
                      " • "
                    )}</div>`
                  : "";
                return `
                  <div class="bg-black/20 rounded-lg p-3 border border-white/10">
                    <div class="text-[11px] text-gray-500 mb-1">Chunk ${
                      idx + 1
                    }</div>
                    ${header}
                    <pre class="text-xs text-gray-300 whitespace-pre-wrap"><code>${escapeHtml(
                      ch.text || ""
                    )}</code></pre>
                  </div>
                `;
              })
              .join("")}
          </div>
        </details>
      `
      : item.evidence_preview
      ? `
        <details class="mt-3">
          <summary class="text-xs text-blue-300 hover:text-blue-200 cursor-pointer font-semibold">Context provided to model (preview)</summary>
          <div class="mt-2 bg-black/20 rounded-lg p-3 border border-white/10">
            <pre class="text-xs text-gray-300 whitespace-pre-wrap"><code>${escapeHtml(
              item.evidence_preview
            )}</code></pre>
          </div>
        </details>
      `
      : `<div class="mt-3 text-xs text-gray-500">No context captured for this prediction.</div>`;

    return `
      <div class="benchmark-incorrect-item glass-effect rounded-2xl p-4 border border-white/10">
        <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div class="min-w-0">
            <div class="text-xs text-gray-400">Field</div>
            <div class="text-lg font-bold text-white truncate">${escapeHtml(
              item.trigger_name || ""
            )}</div>
          </div>
          <div class="flex gap-3 flex-wrap">
            <div class="bg-black/20 rounded-lg px-3 py-2 border border-white/10">
              <div class="text-[11px] text-gray-400">Human</div>
              <div class="text-sm font-semibold text-yellow-200">${escapeHtml(
                item.human_label ?? ""
              )}</div>
            </div>
            <div class="bg-black/20 rounded-lg px-3 py-2 border border-white/10">
              <div class="text-[11px] text-gray-400">Model</div>
              <div class="text-sm font-semibold text-teal-200">${escapeHtml(
                item.model_label ?? ""
              )}</div>
            </div>
          </div>
        </div>

        <div class="mt-3">
          <div class="text-xs text-gray-400 mb-1">Extraction reasoning</div>
          <pre class="text-xs text-gray-300 whitespace-pre-wrap bg-black/20 rounded-lg p-3 border border-white/10"><code>${escapeHtml(
            item.reasoning || ""
          )}</code></pre>
        </div>

        ${
          payloadEntries.length || payloadReasoning
            ? `
          <div class="mt-3">
            <div class="text-xs text-gray-400 mb-1">LLM payload</div>
            ${
              payloadEntries.length
                ? `<div class="bg-black/20 rounded-lg p-3 border border-white/10 space-y-1">
                    ${payloadEntries
                      .map(
                        ([key, value]) => `
                          <div class="flex flex-wrap items-start gap-x-2 text-xs">
                            <span class="text-gray-400">${escapeHtml(
                              formatPayloadKey(key)
                            )}:</span>
                            <span class="text-gray-200 break-all">${escapeHtml(
                              formatPayloadValue(value)
                            )}</span>
                          </div>
                        `
                      )
                      .join("")}
                  </div>`
                : ""
            }
            ${
              payloadReasoning
                ? `<div class="mt-2">
                    <div class="text-xs text-gray-400 mb-1">LLM payload reasoning</div>
                    <pre class="text-xs text-gray-300 whitespace-pre-wrap bg-black/20 rounded-lg p-3 border border-white/10"><code>${escapeHtml(
                      payloadReasoning
                    )}</code></pre>
                  </div>`
                : ""
            }
          </div>
        `
            : ""
        }
        ${
          rawComponentReasoning && !payloadEntries.length && !payloadReasoning
            ? `
          <div class="mt-3">
            <div class="text-xs text-gray-400 mb-1">LLM component reasoning (raw)</div>
            <pre class="text-xs text-gray-300 whitespace-pre-wrap bg-black/20 rounded-lg p-3 border border-white/10"><code>${escapeHtml(
              rawComponentReasoning
            )}</code></pre>
          </div>
        `
            : ""
        }

        ${chunksBlock}

        <div class="mt-4 border-t border-white/10 pt-4">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="text-sm font-semibold text-gray-200">Submit review for this field</div>
            <div class="text-xs text-gray-500">${
              fieldSubs.length
                ? `${escapeHtml(fieldSubs.length)} submission(s) so far`
                : "No submissions yet"
            }</div>
          </div>
          ${
            lastCodes.length
              ? `<div class="mt-2 flex flex-wrap gap-2">${lastCodes
                  .slice(0, 6)
                  .map(
                    (c) =>
                      `<span class="text-[11px] px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-200 border border-emerald-500/25">${escapeHtml(
                        c
                      )}</span>`
                  )
                  .join("")}</div>`
              : ""
          }
          <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
            ${reasonsHtml}
          </div>
          <textarea class="benchmark-comment mt-3 w-full p-3 bg-black bg-opacity-20 rounded-lg text-white placeholder-gray-400 border border-white/10 focus:outline-none focus:ring-2 focus:ring-blue-500" rows="3" placeholder="Optional comment..." ${
            sheetConnected ? "" : "disabled"
          }></textarea>
          ${
            sheetConnected
              ? ""
              : `<div class="text-xs text-yellow-300 mt-2">Connect to a spreadsheet to submit reviews.</div>`
          }
          <div class="flex justify-end mt-3">
            <button class="benchmark-field-submit-btn btn-primary bg-blue-600 hover:bg-blue-700" data-doi="${escapeHtml(
              doi
            )}" data-trigger-name="${escapeHtml(triggerName)}" ${
        sheetConnected ? "" : "disabled"
      }>Submit</button>
          </div>
        </div>
      </div>
    `;
  });

  details.innerHTML = `
    <div class="mb-4">
      <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div class="min-w-0">
          <div class="text-xs text-gray-400">DOI</div>
          <div class="text-lg font-mono text-white truncate">${escapeHtml(
            doi
          )}</div>
          <div class="text-sm text-gray-400 truncate">${escapeHtml(dataset)}${
    docType ? ` • ${escapeHtml(docType)}` : ""
  }</div>
          ${
            annotator
              ? `<div class="text-xs text-gray-500 mt-1">Annotator: ${escapeHtml(
                  annotator
                )}</div>`
              : ""
          }
        </div>
        <div class="flex gap-3 flex-wrap">
          <div class="bg-black/20 rounded-lg px-3 py-2 border border-white/10">
            <div class="text-[11px] text-gray-400">Incorrect predictions</div>
            <div class="text-xl font-bold text-white">${escapeHtml(
              incorrectCount
            )}</div>
          </div>
          ${
            accuracy
              ? `<div class="bg-black/20 rounded-lg px-3 py-2 border border-white/10"><div class="text-[11px] text-gray-400">Accuracy (overall)</div><div class="text-xl font-bold text-white">${escapeHtml(
                  accuracy
                )}</div></div>`
              : ""
          }
        </div>
      </div>
    </div>

    <div class="glass-effect rounded-2xl p-4 border border-white/10 mb-4">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="text-sm font-semibold text-gray-200">Apply to all fields</div>
          <div class="text-xs text-gray-400">Select reasons once, then apply or submit for every incorrect field in this DOI.</div>
        </div>
        <div class="flex gap-2">
          <button class="benchmark-apply-all-btn btn-secondary">Apply</button>
          <button class="benchmark-submit-all-btn btn-primary bg-blue-600 hover:bg-blue-700" ${
            sheetConnected ? "" : "disabled"
          }>Submit all</button>
          <button class="benchmark-submit-all-perfield-btn btn-primary bg-emerald-600 hover:bg-emerald-700" ${
            sheetConnected ? "" : "disabled"
          }>Submit all (per-field)</button>
        </div>
      </div>
      <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
        ${bulkReasonsHtml}
      </div>
      <textarea id="benchmark-bulk-comment" class="mt-3 w-full p-3 bg-black bg-opacity-20 rounded-lg text-white placeholder-gray-400 border border-white/10 focus:outline-none focus:ring-2 focus:ring-blue-500" rows="3" placeholder="Optional comment (applies to all)..." ${
        sheetConnected ? "" : "disabled"
      }></textarea>
      ${
        sheetConnected
          ? ""
          : `<div class="text-xs text-yellow-300 mt-2">Connect to a spreadsheet to submit reviews.</div>`
      }
    </div>

    <div id="benchmark-incorrect-list" class="space-y-3">
      ${items.join("")}
    </div>
  `;

  placeholder.classList.add("hidden");
  details.classList.remove("hidden");
}

async function loadDoi(doi) {
  selectedDoi = doi;
  renderQueueList(overviewCache);

  const details = document.getElementById("benchmark-doi-details");
  const placeholder = document.getElementById(
    "benchmark-doi-details-placeholder"
  );
  if (details && placeholder) {
    details.classList.add("hidden");
    placeholder.classList.remove("hidden");
    placeholder.innerHTML = '<div class="loading-spinner mx-auto my-6"></div>';
  }

  try {
    const doiPayload =
      overviewCache?.dois?.[doi] ||
      overviewCache?.by_doi?.[doi] ||
      null;
    const submissions =
      buildSubmissionsFromSheetRows(overviewCache?.sheet_rows || [], doi);

    if (!doiPayload) {
      const fetchedDoiPayload = await api.getBenchmarkReviewsForDoi(doi);
      const fetchedSubmissions = await api.getBenchmarkReviewSubmissions(doi);
      renderDoiDetails(
        fetchedDoiPayload,
        fetchedSubmissions,
        Boolean(overviewCache?.sheet_connected)
      );
      renderSubmissionsForDoi(fetchedSubmissions);
      return;
    }

    renderDoiDetails(
      doiPayload,
      submissions,
      Boolean(overviewCache?.sheet_connected)
    );
    renderSubmissionsForDoi(submissions);
  } catch (error) {
    console.error("Failed loading DOI details:", error);
    ui.showToastNotification(error.message || "Failed to load DOI.", "error");
    if (placeholder) {
      placeholder.innerHTML = `<p class="text-red-300 text-sm">${escapeHtml(
        error.message || "Failed to load DOI."
      )}</p>`;
    }
  }
}

function pickNextUnreviewed(overview) {
  const queue = getFilteredQueue(overview?.queue || []);
  const next = queue.find((item) => !item.fully_reviewed);
  return next?.doi || (queue[0] ? queue[0].doi : null);
}

function showEmptyDetails(message) {
  const details = document.getElementById("benchmark-doi-details");
  const placeholder = document.getElementById(
    "benchmark-doi-details-placeholder"
  );
  if (!details || !placeholder) return;
  selectedDoi = null;
  details.classList.add("hidden");
  placeholder.classList.remove("hidden");
  placeholder.innerHTML = `<p class="text-gray-300">${escapeHtml(
    message || "Select a DOI to begin reviewing."
  )}</p>`;
}

function getBulkSelection() {
  const reasonCodes = Array.from(
    document.querySelectorAll(".benchmark-bulk-reason-checkbox:checked")
  ).map((el) => el.value);
  const comment = document.getElementById("benchmark-bulk-comment")?.value || "";
  return { reasonCodes, comment };
}

function setupEventListeners() {
  if (listenersAttached) return;

  const list = document.getElementById("benchmark-doi-list");
  if (list) {
    list.addEventListener("click", (e) => {
      const btn = e.target.closest(".benchmark-doi-btn");
      if (!btn) return;
      const doi = btn.dataset.doi;
      if (!doi) return;
      loadDoi(doi);
    });
  }

  const search = document.getElementById("benchmark-review-search");
  if (search) {
    search.addEventListener("input", () => {
      selectedQueueFilter = search.value || "";
      renderQueueList(overviewCache);
      renderActiveFilters();
    });
  }

  const sheetFilter = document.getElementById("benchmark-sheet-selector");
  if (sheetFilter) {
    sheetFilter.addEventListener("change", async () => {
      const selectedSheetId = sheetFilter.value || "";
      if (!selectedSheetId || !dom.sheetSelector) return;
      if (dom.sheetSelector.value !== selectedSheetId) {
        dom.sheetSelector.value = selectedSheetId;
      }
      dom.sheetSelector.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  const reasonFilter = document.getElementById("benchmark-reason-filter");
  if (reasonFilter) {
    reasonFilter.addEventListener("change", () => {
      selectedReasonFilter = reasonFilter.value || "";
      renderQueueList(overviewCache);
      renderActiveFilters();
    });
  }

  const triggerFilter = document.getElementById("benchmark-trigger-filter");
  if (triggerFilter) {
    triggerFilter.addEventListener("change", () => {
      selectedTriggerFilter = triggerFilter.value || "";
      renderQueueList(overviewCache);
      renderActiveFilters();
    });
  }

  const clearBtn = document.getElementById("benchmark-clear-filters-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      selectedQueueFilter = "";
      selectedReasonFilter = "";
      selectedTriggerFilter = "";
      const searchEl = document.getElementById("benchmark-review-search");
      if (searchEl) searchEl.value = "";
      const reasonEl = document.getElementById("benchmark-reason-filter");
      const triggerEl = document.getElementById("benchmark-trigger-filter");
      if (reasonEl) reasonEl.value = "";
      if (triggerEl) triggerEl.value = "";
      renderQueueList(overviewCache);
      renderActiveFilters();
    });
  }

  document.addEventListener("sheetChanged", async (event) => {
    const detail = event.detail || {};
    selectedSheetLabel = detail.sheetName || detail.sheetLabel || "";
    await renderSheetSelector();
    if (!document.getElementById("reviews-view")?.classList.contains("hidden")) {
      selectedDoi = null;
      await loadData({ autoLoadDoi: true });
    }
  });

  document.body.addEventListener("click", (e) => {
    const chip = e.target.closest(".benchmark-reason-chip");
    if (!chip) return;
    const reason = chip.dataset.reason || "";
    selectedReasonFilter = reason;
    const reasonEl = document.getElementById("benchmark-reason-filter");
    if (reasonEl) reasonEl.value = reason;
    renderQueueList(overviewCache);
    renderActiveFilters();
  });

  const nextBtn = document.getElementById("benchmark-next-unreviewed-btn");
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const next = pickNextUnreviewed(overviewCache);
      if (next) loadDoi(next);
    });
  }

  document.body.addEventListener("click", async (e) => {
    const submitBtn = e.target.closest(".benchmark-field-submit-btn");
    if (!submitBtn) return;
    e.preventDefault();
    if (!overviewCache?.sheet_connected) {
      ui.showToastNotification("Connect to a spreadsheet to submit.", "warning");
      return;
    }
    const doi = submitBtn.dataset.doi;
    const triggerName = submitBtn.dataset.triggerName;
    if (!doi || !triggerName) {
      ui.showToastNotification("Select a DOI first.", "warning");
      return;
    }
    const card = submitBtn.closest(".benchmark-incorrect-item");
    if (!card) return;
    const reasonCodes = Array.from(
      card.querySelectorAll(".benchmark-reason-checkbox:checked")
    ).map((el) => el.value);
    const comment = card.querySelector(".benchmark-comment")?.value || "";
    if (!reasonCodes.length) {
      ui.showToastNotification("Select at least one reason.", "warning");
      return;
    }
    try {
      submitBtn.disabled = true;
      await api.submitBenchmarkReview(doi, triggerName, reasonCodes, comment);
      ui.showToastNotification("Review submitted.", "success");
      await loadData({ keepDoi: true, autoLoadDoi: false });
      // If this DOI is now fully reviewed, advance to the next.
      const current = (overviewCache?.queue || []).find((q) => q.doi === doi);
      if (current?.fully_reviewed) {
        const next = pickNextUnreviewed(overviewCache);
        if (next) await loadDoi(next);
      } else {
        await loadDoi(doi);
      }
    } catch (error) {
      console.error("Submit failed:", error);
      ui.showToastNotification(error.message || "Submit failed.", "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.body.addEventListener("click", async (e) => {
    const applyBtn = e.target.closest(".benchmark-apply-all-btn");
    if (!applyBtn) return;
    e.preventDefault();
    const { reasonCodes, comment } = getBulkSelection();
    if (!reasonCodes.length && !String(comment || "").trim()) {
      ui.showToastNotification(
        "Select at least one reason (or add a comment) to apply.",
        "warning"
      );
      return;
    }
    const cards = document.querySelectorAll(".benchmark-incorrect-item");
    cards.forEach((card) => {
      const checkboxes = card.querySelectorAll(".benchmark-reason-checkbox");
      checkboxes.forEach((cb) => {
        cb.checked = reasonCodes.includes(cb.value);
      });
      const commentEl = card.querySelector(".benchmark-comment");
      if (commentEl && String(comment || "").trim()) {
        commentEl.value = comment;
      }
    });
    ui.showToastNotification("Applied to all fields.", "success");
  });

  document.body.addEventListener("click", async (e) => {
    const submitAllBtn = e.target.closest(".benchmark-submit-all-btn");
    if (!submitAllBtn) return;
    e.preventDefault();
    if (!overviewCache?.sheet_connected) {
      ui.showToastNotification("Connect to a spreadsheet to submit.", "warning");
      return;
    }
    if (!selectedDoi) {
      ui.showToastNotification("Select a DOI first.", "warning");
      return;
    }
    const { reasonCodes, comment } = getBulkSelection();
    if (!reasonCodes.length) {
      ui.showToastNotification("Select at least one reason.", "warning");
      return;
    }
    try {
      submitAllBtn.disabled = true;
      const triggers = Array.from(
        document.querySelectorAll(".benchmark-field-submit-btn")
      )
        .map((btn) => btn.dataset.triggerName)
        .filter(Boolean);
      const result = await api.submitBenchmarkReviewBulk(
        selectedDoi,
        reasonCodes,
        comment || "",
        triggers
      );
      ui.showToastNotification(
        `Submitted ${result.updated_fields || triggers.length} field reviews.`,
        "success"
      );
      await loadData({ keepDoi: true, autoLoadDoi: false });
      const current = (overviewCache?.queue || []).find((q) => q.doi === selectedDoi);
      if (current?.fully_reviewed) {
        const next = pickNextUnreviewed(overviewCache);
        if (next) await loadDoi(next);
      } else {
        await loadDoi(selectedDoi);
      }
    } catch (error) {
      console.error("Bulk submit failed:", error);
      ui.showToastNotification(error.message || "Bulk submit failed.", "error");
    } finally {
      submitAllBtn.disabled = false;
    }
  });

  document.body.addEventListener("click", async (e) => {
    const submitAllBtn = e.target.closest(".benchmark-submit-all-perfield-btn");
    if (!submitAllBtn) return;
    e.preventDefault();
    if (!overviewCache?.sheet_connected) {
      ui.showToastNotification("Connect to a spreadsheet to submit.", "warning");
      return;
    }
    if (!selectedDoi) {
      ui.showToastNotification("Select a DOI first.", "warning");
      return;
    }

    const cards = Array.from(document.querySelectorAll(".benchmark-incorrect-item"));
    if (!cards.length) return;

    const items = [];
    const missing = [];
    cards.forEach((card) => {
      const triggerName =
        card.querySelector(".benchmark-field-submit-btn")?.dataset?.triggerName ||
        "";
      const reasonCodes = Array.from(
        card.querySelectorAll(".benchmark-reason-checkbox:checked")
      ).map((el) => el.value);
      const comment = card.querySelector(".benchmark-comment")?.value || "";
      if (!triggerName) return;
      if (!reasonCodes.length) {
        missing.push(triggerName);
        card.classList.add("border-red-500/50");
        return;
      }
      items.push({ trigger_name: triggerName, reason_codes: reasonCodes, comment });
    });

    if (missing.length) {
      ui.showToastNotification(
        `Missing reasons for ${missing.length} field(s).`,
        "warning"
      );
      setTimeout(() => {
        cards.forEach((c) => c.classList.remove("border-red-500/50"));
      }, 2000);
      return;
    }

    try {
      submitAllBtn.disabled = true;
      const result = await api.submitBenchmarkReviewBulkDetailed(selectedDoi, items);
      ui.showToastNotification(
        `Submitted ${result.updated_fields || items.length} field reviews.`,
        "success"
      );
      await loadData({ keepDoi: true, autoLoadDoi: false });
      const current = (overviewCache?.queue || []).find((q) => q.doi === selectedDoi);
      if (current?.fully_reviewed) {
        const next = pickNextUnreviewed(overviewCache);
        if (next) await loadDoi(next);
      } else {
        await loadDoi(selectedDoi);
      }
    } catch (error) {
      console.error("Per-field bulk submit failed:", error);
      ui.showToastNotification(error.message || "Bulk submit failed.", "error");
    } finally {
      submitAllBtn.disabled = false;
    }
  });

  const uploadBtn = document.getElementById("benchmark-upload-btn");
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async () => {
      const input = document.getElementById("benchmark-upload-input");
      const status = document.getElementById("benchmark-upload-status");
      const file = input?.files?.[0];
      if (!file) {
        ui.showToastNotification("Select a .jsonl file first.", "warning");
        return;
      }
      try {
        uploadBtn.disabled = true;
        if (status) status.textContent = "Uploading…";
        const result = await api.uploadBenchmarkPredictionsJsonl(file, "replace");
        ui.showToastNotification("Upload complete.", "success");
        if (status) {
          status.textContent = `Uploaded ${escapeHtml(
            result.incorrect_item_count
          )} incorrect predictions (${escapeHtml(
            result.doi_count_with_incorrect
          )} DOIs) at ${escapeHtml(result.uploaded_at_utc)}.`;
        }
        selectedDoi = null;
        await loadData({ autoLoadDoi: true });
      } catch (error) {
        console.error("Upload failed:", error);
        ui.showToastNotification(error.message || "Upload failed.", "error");
        const status = document.getElementById("benchmark-upload-status");
        if (status) status.textContent = "";
      } finally {
        uploadBtn.disabled = false;
      }
    });
  }

  listenersAttached = true;
}

async function loadData({ keepDoi = false, autoLoadDoi = true } = {}) {
  setupEventListeners();
  setLoading(true);
  try {
    overviewCache = await api.getBenchmarkReviewsOverview();
    setLoading(false);
    await renderSheetSelector();
    renderStats(overviewCache);
    renderExploreFilters(overviewCache);
    renderQueueList(overviewCache);

    const banner = document.getElementById("benchmark-review-connection-banner");
    if (banner) {
      banner.classList.toggle("hidden", Boolean(overviewCache?.sheet_connected));
    }

    const uploadStatus = document.getElementById("benchmark-upload-status");
    if (uploadStatus) {
      const src = overviewCache?.source || {};
      if (src.type === "sheet" && src.uploaded_at_utc) {
        uploadStatus.textContent = `Current sheet upload: ${escapeHtml(
          src.uploaded_at_utc
        )}`;
      } else if (src.type === "none" && src.detail) {
        uploadStatus.textContent = String(src.detail);
      } else {
        uploadStatus.textContent = "";
      }
    }

    if (autoLoadDoi) {
      const doiToLoad =
        keepDoi && selectedDoi
          ? selectedDoi
          : pickNextUnreviewed(overviewCache);

      if (doiToLoad) {
        await loadDoi(doiToLoad);
      } else {
        showEmptyDetails(
          selectedSheetLabel
            ? `No benchmark predictions found for "${selectedSheetLabel}".`
            : "Select a DOI to begin reviewing."
        );
      }
    }
  } catch (error) {
    console.error("Failed to load benchmark review overview:", error);
    ui.showToastNotification(
      error.message || "Failed to load benchmark reviews.",
      "error"
    );
    setLoading(false);
  }
}

export function initializeReviews(_state, _viewManager) {
  state = _state;
  viewManager = _viewManager;
  return {
    loadData,
  };
}
