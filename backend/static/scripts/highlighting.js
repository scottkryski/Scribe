// scripts/highlighting.js
import * as dom from "./domElements.js";

// Moved from keywordMap.js
export const HIGHLIGHT_COLORS = {
  "highlight-experimental": "#FBBF24",
  "highlight-humans": "#A7F3D0",
  "highlight-animals": "#FBCFE8",
  "highlight-sensitive-data": "#FECACA",
  "highlight-ethics-declaration": "#BFDBFE",
  "highlight-consent": "#C4B5FD",
  "highlight-coi": "#FDBA74",
  "highlight-data-protection": "#A5F3FC",
};

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

  if (!activeTemplate) return;

  const colors = Object.values(HIGHLIGHT_COLORS);
  let colorIndex = 0;

  activeHighlightIds.forEach((triggerId) => {
    const field = activeTemplate.fields.find((f) => f.id === triggerId);
    if (field && field.keywords && field.keywords.length > 0) {
      const colorClass = `highlight-${field.id.replace(/_/g, "-")}`;

      // Use predefined color if it exists, otherwise cycle.
      let highlightColor;
      if (HIGHLIGHT_COLORS[colorClass]) {
        highlightColor = HIGHLIGHT_COLORS[colorClass];
      } else {
        highlightColor = colors[colorIndex % colors.length];
        colorIndex++; // Only increment for cycled colors to maintain consistency
      }

      const regex = new RegExp(
        `\\b(${field.keywords
          .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")})\\b`,
        "gi"
      );

      abstractHTML = abstractHTML.replace(
        regex,
        (match) =>
          `<mark class="highlight" style="background-color:${highlightColor}; color: #000;">${match}</mark>`
      );
      fullTextHTML = fullTextHTML.replace(
        regex,
        (match) =>
          `<mark class="highlight" style="background-color:${highlightColor}; color: #000;">${match}</mark>`
      );
    }
  });

  dom.paperAbstract.innerHTML = abstractHTML;
  dom.paperFullText.innerHTML = fullTextHTML;

  setTimeout(() => updateScrollGlows(activeHighlightIds), 50);
}

export function updateScrollGlows(activeHighlightIds) {
  if (activeHighlightIds.size === 0) {
    dom.scrollTopGlow.classList.remove("visible");
    dom.scrollBottomGlow.classList.remove("visible");
    return;
  }

  const marks = Array.from(
    dom.paperContentContainer.querySelectorAll(".highlight")
  );
  if (marks.length === 0) {
    dom.scrollTopGlow.classList.remove("visible");
    dom.scrollBottomGlow.classList.remove("visible");
    return;
  }

  const { scrollTop, clientHeight } = dom.paperContentContainer;
  const firstMarkAbove = marks.find(
    (mark) => mark.offsetTop + mark.offsetHeight < scrollTop
  );
  const firstMarkBelow = marks.find(
    (mark) => mark.offsetTop > scrollTop + clientHeight
  );

  const getColor = (element) => {
    // Since we are using inline styles now, get it from there
    return element.style.backgroundColor;
  };

  const topColor = firstMarkAbove ? getColor(firstMarkAbove) : null;
  if (topColor) {
    dom.scrollTopGlow.style.background = `linear-gradient(to bottom, ${topColor}99, transparent)`;
    dom.scrollTopGlow.classList.add("visible");
  } else {
    dom.scrollTopGlow.classList.remove("visible");
  }

  const bottomColor = firstMarkBelow ? getColor(firstMarkBelow) : null;
  if (bottomColor) {
    dom.scrollBottomGlow.style.background = `linear-gradient(to top, ${bottomColor}99, transparent)`;
    dom.scrollBottomGlow.classList.add("visible");
  } else {
    dom.scrollBottomGlow.classList.remove("visible");
  }
}
