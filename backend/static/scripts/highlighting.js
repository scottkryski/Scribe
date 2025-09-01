// scripts/highlighting.js
import * as dom from "./domElements.js";

// A beautiful, high-contrast color palette for cycling through highlights.
// Each object contains a background color for the <mark> tag and a stroke color for the SVG icon.
export const HIGHLIGHT_COLOR_PALETTE = [
  { bg: "#FBBF24", stroke: "#FBBF24" }, // Amber
  { bg: "#A7F3D0", stroke: "#A7F3D0" }, // Mint
  { bg: "#FBCFE8", stroke: "#FBCFE8" }, // Pink
  { bg: "#BFDBFE", stroke: "#BFDBFE" }, // Blue
  { bg: "#FDBA74", stroke: "#FDBA74" }, // Orange
  { bg: "#C4B5FD", stroke: "#C4B5FD" }, // Violet
  { bg: "#A5F3FC", stroke: "#A5F3FC" }, // Cyan
  { bg: "#FECACA", stroke: "#FECACA" }, // Red
];

function countKeywords(text, keywords) {
  if (!text || !keywords || keywords.length === 0) return 0;
  const escapedKeywords = keywords.map((kw) =>
    kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  const regex = new RegExp(`\\b(${escapedKeywords.join("|")})\\b`, "gi");
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function displayKeywordCount(keywords) {
  const combinedText =
    (dom.paperAbstract.textContent || "") +
    " " +
    (dom.paperFullText.textContent || "");
  const count = countKeywords(combinedText, keywords);

  let message =
    count === 0
      ? "No keywords found"
      : `${count} keyword${count > 1 ? "s" : ""} found`;

  const notification = document.createElement("div");
  notification.className =
    "fixed top-4 right-4 bg-white bg-opacity-90 text-gray-800 px-4 py-2 rounded-lg shadow-lg z-50 fade-in";
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 3000);
}

export function handleHighlightToggle(
  event,
  activeHighlightIds,
  activeTemplate
) {
  const clickedButton = event.currentTarget;
  const triggerId = clickedButton.dataset.highlightTrigger;

  if (activeHighlightIds.has(triggerId)) {
    activeHighlightIds.delete(triggerId);
    clickedButton.classList.remove("active");
  } else {
    activeHighlightIds.add(triggerId);
    clickedButton.classList.add("active");
    const field = activeTemplate.fields.find((f) => f.id === triggerId);
    if (field && field.keywords) {
      displayKeywordCount(field.keywords);
    }
  }
}

export function updateAllHighlights(
  activeHighlightIds,
  originalAbstractHTML,
  originalFullTextHTML,
  activeTemplate
) {
  let abstractHTML = originalAbstractHTML;
  let fullTextHTML = originalFullTextHTML;

  if (!activeTemplate || !activeTemplate.fields) return;

  activeHighlightIds.forEach((triggerId) => {
    const field = activeTemplate.fields.find((f) => f.id === triggerId);
    // Find the index of the field to get a consistent color from the palette
    const fieldIndex = activeTemplate.fields.findIndex(
      (f) => f.id === triggerId
    );

    if (
      field &&
      field.keywords &&
      field.keywords.length > 0 &&
      fieldIndex !== -1
    ) {
      // Cycle through the color palette based on the field's position in the template
      const color =
        HIGHLIGHT_COLOR_PALETTE[fieldIndex % HIGHLIGHT_COLOR_PALETTE.length];

      const regex = new RegExp(
        `\\b(${field.keywords
          .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")})\\b`,
        "gi"
      );

      abstractHTML = abstractHTML.replace(
        regex,
        (match) =>
          `<mark class="highlight" style="background-color:${color.bg};">${match}</mark>`
      );
      fullTextHTML = fullTextHTML.replace(
        regex,
        (match) =>
          `<mark class="highlight" style="background-color:${color.bg};">${match}</mark>`
      );
    }
  });

  dom.paperAbstract.innerHTML = abstractHTML;
  dom.paperFullText.innerHTML = fullTextHTML;

  setTimeout(() => updateScrollGlows(activeHighlightIds), 50);
}

export function updateScrollGlows(activeHighlightIds) {
  if (activeHighlightIds.size === 0) {
    dom.scrollTopGlow.style.opacity = 0;
    dom.scrollBottomGlow.style.opacity = 0;
    return;
  }
  const marks = Array.from(
    dom.paperContentContainer.querySelectorAll(".highlight")
  );
  if (marks.length === 0) {
    dom.scrollTopGlow.style.opacity = 0;
    dom.scrollBottomGlow.style.opacity = 0;
    return;
  }

  const { scrollTop, clientHeight, scrollHeight } = dom.paperContentContainer;
  const firstMarkAbove = marks.find((mark) => mark.offsetTop < scrollTop);
  const firstMarkBelow = marks.find(
    (mark) => mark.offsetTop > scrollTop + clientHeight
  );

  const getColor = (element) => element.style.backgroundColor;

  if (firstMarkAbove) {
    const topColor = getColor(firstMarkAbove);
    dom.scrollTopGlow.style.background = `radial-gradient(circle at 50% 0, ${topColor} 0%, transparent 70%)`;
    dom.scrollTopGlow.style.opacity = 1;
  } else {
    dom.scrollTopGlow.style.opacity = 0;
  }

  if (firstMarkBelow) {
    const bottomColor = getColor(firstMarkBelow);
    dom.scrollBottomGlow.style.background = `radial-gradient(circle at 50% 100%, ${bottomColor} 0%, transparent 70%)`;
    dom.scrollBottomGlow.style.opacity = 1;
  } else {
    dom.scrollBottomGlow.style.opacity = 0;
  }
}
