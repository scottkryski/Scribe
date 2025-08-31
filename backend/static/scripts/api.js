const API_BASE_URL = "http://127.0.0.1:8000";

// --- API Key Management ---

export async function checkApiKeyStatus() {
  try {
    const response = await fetch(`${API_BASE_URL}/check-api-key`);
    if (!response.ok) return { is_set: false };
    return await response.json();
  } catch (error) {
    console.error("Failed to check API key status:", error);
    return { is_set: false };
  }
}

export async function saveApiKey(key) {
  const response = await fetch(`${API_BASE_URL}/save-api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(
      errorData.detail || "Failed to save the key on the server."
    );
  }
  return await response.json();
}

// --- AI Suggestions & Models ---

export async function getGeminiModels() {
  try {
    const response = await fetch(`${API_BASE_URL}/get-gemini-models`);
    if (!response.ok) return [];
    return await response.json();
  } catch (error) {
    console.error("Could not fetch Gemini models:", error);
    return [];
  }
}

// --- Statistics ---

export async function getSheetStats() {
  try {
    const response = await fetch(`${API_BASE_URL}/get-sheet-stats`);
    if (!response.ok) return { completed_count: 0, incomplete_count: 0 };
    return await response.json();
  } catch (error) {
    console.error("Could not fetch sheet stats:", error);
    return { completed_count: 0, incomplete_count: 0 };
  }
}

export async function getDetailedStats() {
  const response = await fetch(`${API_BASE_URL}/get-detailed-stats`);
  if (!response.ok) {
    throw new Error("Could not fetch detailed statistics from server.");
  }
  return response.json();
}

export async function fetchGeminiSuggestions(
  pdf_filename,
  model_name,
  template
) {
  const response = await fetch(`${API_BASE_URL}/get-gemini-suggestions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pdf_filename, model_name, template }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || "Failed to get AI suggestions.");
  }
  return data;
}

// --- Dataset and Paper Management ---

export async function getDatasets() {
  const response = await fetch(
    `${API_BASE_URL}/get-datasets?_=${new Date().getTime()}`
  );
  if (!response.ok)
    throw new Error("Could not fetch dataset list from server.");
  return response.json();
}

export async function loadDataset(datasetName) {
  const prioritizeIncomplete =
    localStorage.getItem("prioritizeIncomplete") === null
      ? true
      : localStorage.getItem("prioritizeIncomplete") === "true";

  const response = await fetch(`${API_BASE_URL}/load-dataset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dataset: datasetName,
      prioritize_incomplete: prioritizeIncomplete,
    }),
  });
  if (!response.ok) throw new Error((await response.json()).detail);
  return response.json();
}

export async function fetchNextPaper(datasetName, skipDoi = null) {
  const pdfRequired =
    localStorage.getItem("loadPdfOnly") === null
      ? "true"
      : localStorage.getItem("loadPdfOnly");
  const annotatorName = localStorage.getItem("annotatorName") || "unknown";

  let url = `${API_BASE_URL}/get-next-paper?dataset=${datasetName}&annotator=${annotatorName}&pdf_required=${pdfRequired}`;
  if (skipDoi) {
    url += `&skip_doi=${encodeURIComponent(skipDoi)}`;
  }

  const response = await fetch(url);

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.detail || "Failed to fetch the next paper.");
  }
  return response.json();
}

export async function fetchPaperByDoi(doi, dataset) {
  const response = await fetch(
    `${API_BASE_URL}/get-paper-by-doi?doi=${encodeURIComponent(
      doi
    )}&dataset=${dataset}`
  );
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(
      errorData.detail || `Failed to fetch paper with DOI ${doi}.`
    );
  }
  return response.json();
}

export async function checkForResumablePaper(annotatorName) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/check-for-resumable-paper?annotator=${encodeURIComponent(
        annotatorName
      )}`
    );
    if (!response.ok) return { resumable: false };
    return await response.json();
  } catch (error) {
    console.error("Failed to check for resumable paper:", error);
    return { resumable: false };
  }
}

export async function getLockStatus(doi) {
  try {
    const response = await fetch(`${API_BASE_URL}/get-lock-status/${doi}`);
    if (!response.ok) {
      return { locked: false, remaining_seconds: 0 };
    }
    return await response.json();
  } catch (error) {
    console.error("Failed to fetch lock status:", error);
    return { locked: false, remaining_seconds: 0 };
  }
}

export async function skipPaper(datasetName, doi) {
  const response = await fetch(`${API_BASE_URL}/skip-paper`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset: datasetName, doi: doi }),
  });
  if (!response.ok) throw new Error((await response.json()).detail);
  return response.json();
}

export async function submitAnnotation(payload) {
  const response = await fetch(`${API_BASE_URL}/submit-annotation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Submission failed");
  return response.json();
}

export async function downloadPdf(pdfData) {
  const response = await fetch(`${API_BASE_URL}/download-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pdfData),
  });

  if (!response.ok) {
    const errorData = await response.json();
    const author = (pdfData.author || "UnknownAuthor").replace(/[^\w-]/g, "");
    const year = pdfData.year || "UnknownYear";
    const safeTitle = (pdfData.title || "untitled_paper")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase();
    const titleFragment = safeTitle.split(/\s+/).slice(0, 4).join("_");
    const filename = `${author}${year}-${titleFragment}.pdf`;

    errorData.expected_filename = filename;
    errorData.attempted_url = pdfData.url;
    throw errorData;
  }

  const filename = response.headers.get("X-Saved-Filename");
  const blob = await response.blob();
  return { blob, filename };
}

export async function uploadPdf(file, expectedFilename) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("expected_filename", expectedFilename);

  const response = await fetch(`${API_BASE_URL}/upload-pdf`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.detail || "Failed to upload PDF.");
  }
  return response.json();
}

export async function openDataFolder() {
  try {
    const response = await fetch(`${API_BASE_URL}/open-data-folder`, {
      method: "POST",
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || "Failed to open folder.");
    }
    return await response.json();
  } catch (error) {
    console.error("Error opening data folder:", error);
    alert(
      `Could not open the data folder automatically. Please navigate to it manually. Error: ${error.message}`
    );
  }
}

// --- Template Management API Functions ---

export async function getTemplates() {
  const response = await fetch(`${API_BASE_URL}/api/templates`);
  if (!response.ok) throw new Error("Failed to fetch templates.");
  return response.json();
}

export async function getTemplate(templateName) {
  const response = await fetch(`${API_BASE_URL}/api/templates/${templateName}`);
  if (!response.ok)
    throw new Error(`Failed to fetch template ${templateName}.`);
  return response.json();
}

export async function saveTemplate(templateName, data) {
  const response = await fetch(
    `${API_BASE_URL}/api/templates/${templateName}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }
  );
  if (!response.ok) throw new Error("Failed to save template.");
  return response.json();
}

export async function deleteTemplate(templateName) {
  const response = await fetch(
    `${API_BASE_URL}/api/templates/${templateName}`,
    {
      method: "DELETE",
    }
  );
  if (!response.ok) throw new Error("Failed to delete template.");
  return response.json();
}

export async function openTemplatesFolder() {
  try {
    const response = await fetch(`${API_BASE_URL}/open-templates-folder`, {
      method: "POST",
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || "Failed to open folder.");
    }
    return await response.json();
  } catch (error) {
    console.error("Error opening templates folder:", error);
    alert(`Could not open the folder automatically. Error: ${error.message}`);
  }
}

export async function uploadTemplate(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_BASE_URL}/upload-template`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.detail || "Failed to upload template.");
  }
  return response.json();
}

// --- Google Sheet Management API Functions ---

export async function getSheets() {
  const response = await fetch(`${API_BASE_URL}/api/sheets`);
  if (!response.ok) throw new Error("Failed to fetch sheet configurations.");
  return response.json();
}

export async function addSheet(name, url) {
  const response = await fetch(`${API_BASE_URL}/api/sheets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, url }),
  });
  if (!response.ok) throw new Error((await response.json()).detail);
  return response.json();
}

export async function deleteSheet(id) {
  const response = await fetch(`${API_BASE_URL}/api/sheets/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error((await response.json()).detail);
  return response.json();
}

export async function connectToSheet(sheet_id) {
  const response = await fetch(`${API_BASE_URL}/connect-to-sheet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sheet_id }),
  });
  if (!response.ok) throw new Error((await response.json()).detail);
  return response.json();
}

export async function checkForUpdates() {
  const response = await fetch(`${API_BASE_URL}/check-for-updates`);
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.detail || "Failed to check for updates.");
  }
  return response.json();
}

export async function triggerUpdateAndRestart() {
  try {
    await fetch(`${API_BASE_URL}/update-and-restart`, { method: "POST" });
  } catch (error) {
    console.log("Server shutdown initiated for update.");
  }
}

// --- Filter Management ---

export async function setFilter(dataset, query, template) {
  const response = await fetch(`${API_BASE_URL}/api/filter/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset, query, template }),
  });
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.detail || "Failed to set filter.");
  }
  return response.json();
}

export async function clearFilter(dataset) {
  const response = await fetch(`${API_BASE_URL}/api/filter/clear`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset }),
  });
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.detail || "Failed to clear filter.");
  }
  return response.json();
}

export async function getFilterStatus(dataset) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/filter/status?dataset=${dataset}`
    );
    if (!response.ok) return { is_active: false };
    return await response.json();
  } catch (error) {
    console.error("Failed to get filter status:", error);
    return { is_active: false };
  }
}

// --- Application Status ---
export async function getAppStatus() {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/status?_=${new Date().getTime()}`
    );
    if (!response.ok) {
      return { status: "error", message: "Cannot connect to server." };
    }
    return await response.json();
  } catch (error) {
    return {
      status: "error",
      message: "Server is not responding. Please wait...",
    };
  }
}
