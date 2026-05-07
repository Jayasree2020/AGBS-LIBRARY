const state = {
  user: null,
  config: null,
  categories: [],
  resources: [],
  resourceCounts: { total: 0, byCategory: {} },
  storageUsage: null,
  skippedUploads: [],
  reports: null,
  readingSessionId: null,
  activeUpload: null,
  pendingUploadFiles: [],
  uploadActivity: {
    running: false,
    status: "",
    logs: [],
    skippedDetails: [],
    added: 0,
    skipped: 0,
    failed: 0
  }
};

const app = document.querySelector("#app");

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function api(path, options = {}) {
  const baseHeaders = options.body instanceof FormData ? {} : { "Content-Type": "application/json" };
  const headers = { ...baseHeaders, ...(options.headers || {}) };
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || "Request failed.", response.status);
  return data;
}

function isAuthError(error) {
  return error?.status === 401 || error?.status === 403 || /login required|admin access required/i.test(error?.message || "");
}

function isZipFile(file) {
  return (file.webkitRelativePath || file.name || "").toLowerCase().endsWith(".zip");
}

function uploadFilename(file) {
  return file.libraryPath || file.webkitRelativePath || file.name;
}

function isSupportedLibraryFile(name) {
  return /\.(pdf|epub)\s*\.?$/i.test(String(name || "").trim());
}

function mimeForFilename(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".epub")) return "application/epub+zip";
  return "application/octet-stream";
}

let jsZipLoader = null;

async function loadJsZip() {
  if (!jsZipLoader) {
    jsZipLoader = import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm").then((module) => module.default || module.JSZip);
  }
  return await jsZipLoader;
}

async function sendFileChunks(file, fileIndex, totalFiles, onProgress, signal, label = "Uploading") {
  const uploadId = crypto.randomUUID();
  state.activeUpload = { ...(state.activeUpload || {}), uploadId };
  const chunkSize = 1024 * 1024;
  const filename = uploadFilename(file);
  const metadata = {
    fileIndex: 0,
    filename,
    contentType: file.type,
    totalChunks: Math.max(1, Math.ceil(file.size / chunkSize))
  };
  if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
  onProgress(`Starting ${fileIndex + 1} of ${totalFiles}: ${filename}`);
  for (let chunkIndex = 0; chunkIndex < metadata.totalChunks; chunkIndex++) {
    if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
    const start = chunkIndex * chunkSize;
    const chunk = file.slice(start, start + chunkSize);
    const form = new FormData();
    form.append("uploadId", uploadId);
    form.append("fileIndex", "0");
    form.append("chunkIndex", String(chunkIndex));
    form.append("chunk", chunk, `0-${chunkIndex}.part`);
    await api("/api/resources/upload-chunk", { method: "POST", body: form, signal, headers: uploadAuthHeaders() });
    onProgress(`${label} ${filename}: ${chunkIndex + 1} of ${metadata.totalChunks} steps.`);
  }
  return { uploadId, metadata };
}

async function uploadChunkedFile(file, fileIndex, totalFiles, options, onProgress, signal) {
  let uploadId = "";
  try {
    const sent = await sendFileChunks(file, fileIndex, totalFiles, onProgress, signal);
    uploadId = sent.uploadId;
    const metadata = sent.metadata;
    const filename = metadata.filename;
    onProgress(`Saving ${filename} into the library...`);
    return await api("/api/resources/upload-complete", {
      method: "POST",
      body: {
        uploadId,
        files: [metadata],
        autoCategorize: options.autoCategorize,
        targetCategoryId: options.targetCategoryId
      },
      signal,
      headers: uploadAuthHeaders()
    });
  } catch (error) {
    if (uploadId && error.name === "AbortError") {
      await api("/api/resources/upload-cancel", { method: "POST", body: { uploadId }, headers: uploadAuthHeaders() }).catch(() => {});
    }
    throw error;
  }
}

function uploadAuthHeaders() {
  return state.activeUpload?.token ? { "X-Upload-Token": state.activeUpload.token } : {};
}

function uploadFileKey(file) {
  return `${uploadFilename(file)}::${file.size}::${file.lastModified || 0}`;
}

function addPendingUploadFiles(files) {
  const incoming = Array.from(files || []);
  if (!incoming.length) return 0;
  const existing = new Set(state.pendingUploadFiles.map(uploadFileKey));
  const added = [];
  for (const file of incoming) {
    const key = uploadFileKey(file);
    if (existing.has(key)) continue;
    existing.add(key);
    added.push(file);
  }
  state.pendingUploadFiles.push(...added);
  return added.length;
}

async function uploadZipFile(file, fileIndex, totalFiles, options, onProgress, onEntrySaved, signal) {
  const totals = { resources: [], skipped: [], failed: [] };
  const zipName = uploadFilename(file);
  if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
  onProgress(`Opening ZIP ${zipName} in the browser...`);
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const supportedEntries = entries.filter((entry) => isSupportedLibraryFile(entry.name));
  const unsupportedEntries = entries.filter((entry) => !isSupportedLibraryFile(entry.name));
  onProgress(`ZIP ${zipName}: found ${supportedEntries.length} uploadable PDF/EPUB file(s) inside ${entries.length} file(s).`);
  if (unsupportedEntries.length) {
    onProgress(`ZIP ${zipName}: ignoring ${unsupportedEntries.length} non-book file(s). Only PDFs and EPUBs will be imported.`);
  }
  if (!supportedEntries.length) {
    const failed = { filename: zipName, reason: "No supported PDF or EPUB files were found inside this ZIP." };
    totals.failed.push(failed);
    onEntrySaved?.({ resources: [], skipped: [], failed: [failed], progressLabel: `ZIP ${zipName}: no supported files found.` }, fileIndex + 1, totalFiles);
    return totals;
  }
  for (let entryIndex = 0; entryIndex < supportedEntries.length; entryIndex++) {
    if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
    const entry = supportedEntries[entryIndex];
    onProgress(`Opening ZIP folder file ${entryIndex + 1} of ${supportedEntries.length}: ${entry.name}`);
    try {
      const blob = await entry.async("blob");
      const extracted = new File([blob], entry.name.split("/").pop() || entry.name, {
        type: blob.type || mimeForFilename(entry.name)
      });
      extracted.libraryPath = entry.name;
      onProgress(`Uploading ${entry.name} from ZIP into the library...`);
      const data = await uploadChunkedFile(extracted, entryIndex, supportedEntries.length, options, onProgress, signal);
      const addedResources = Array.isArray(data.resources) ? data.resources : [];
      const skipped = Array.isArray(data.skipped) ? data.skipped : [];
      const failed = Array.isArray(data.failed) ? data.failed : [];
      totals.resources.push(...addedResources);
      totals.skipped.push(...skipped);
      totals.failed.push(...failed);
      onEntrySaved?.({ ...data, progressLabel: `ZIP ${zipName}: ${entryIndex + 1} of ${supportedEntries.length} files checked.` }, fileIndex + 1, totalFiles);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (isAuthError(error)) throw error;
      const failed = { filename: entry.name, reason: error.message };
      totals.failed.push(failed);
      onEntrySaved?.({ resources: [], skipped: [], failed: [failed], progressLabel: `ZIP ${zipName}: ${entryIndex + 1} of ${supportedEntries.length} files checked.` }, fileIndex + 1, totalFiles);
    }
  }
  return totals;
}

async function uploadChunked(files, options, onProgress, onFileSaved, signal) {
  const totals = { resources: [], skipped: [], failed: [] };
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
    try {
      if (isZipFile(files[fileIndex])) {
        const zipData = await uploadZipFile(files[fileIndex], fileIndex, files.length, options, onProgress, onFileSaved, signal);
        totals.resources.push(...(Array.isArray(zipData.resources) ? zipData.resources : []));
        totals.skipped.push(...(Array.isArray(zipData.skipped) ? zipData.skipped : []));
        totals.failed.push(...(Array.isArray(zipData.failed) ? zipData.failed : []));
        continue;
      }
      const data = await uploadChunkedFile(files[fileIndex], fileIndex, files.length, options, onProgress, signal);
      const addedResources = Array.isArray(data.resources) ? data.resources : [];
      const skipped = Array.isArray(data.skipped) ? data.skipped : [];
      const failed = Array.isArray(data.failed) ? data.failed : [];
      totals.resources.push(...addedResources);
      totals.skipped.push(...skipped);
      totals.failed.push(...failed);
      onFileSaved?.(data, fileIndex + 1, files.length);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (isAuthError(error)) throw error;
      const filename = uploadFilename(files[fileIndex]);
      totals.failed.push({ filename, reason: error.message });
      onFileSaved?.({ resources: [], skipped: [], failed: [{ filename, reason: error.message }] }, fileIndex + 1, files.length);
    }
  }
  return totals;
}

function route() {
  return window.location.pathname;
}

function go(path) {
  history.pushState(null, "", path);
  render();
}

window.addEventListener("popstate", render);

async function loadMe() {
  const data = await api("/api/me");
  state.user = data.user;
}

async function loadConfig() {
  state.config = await api("/api/config");
}

function layout(content) {
  const staff = ["admin", "director"].includes(state.user?.role);
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <img src="/assets/agbs-logo.jpg" alt="Amazing Grace Biblical Seminary logo">
          <span>AGBS LIBRARY</span>
        </div>
        <nav class="nav">
          <a href="/library" data-link class="${route().startsWith("/library") ? "active" : ""}">Library</a>
          ${staff ? `<a href="/admin" data-link class="${route().startsWith("/admin") ? "active" : ""}">Admin</a>` : ""}
          <button class="secondary" id="logoutBtn">Sign out</button>
        </nav>
      </header>
      ${content}
    </div>
  `;
  wireLinks();
  document.querySelector("#logoutBtn")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    go("/login");
  });
}

function setUploadActivityStatus(message) {
  state.uploadActivity.status = message;
  document.querySelector("#uploadStatus") && (document.querySelector("#uploadStatus").textContent = message);
}

function addUploadActivityLog(message) {
  state.uploadActivity.logs.push(message);
  state.uploadActivity.logs = state.uploadActivity.logs.slice(-80);
  const uploadLog = document.querySelector("#uploadLog");
  if (uploadLog) {
    const line = document.createElement("div");
    line.textContent = message;
    uploadLog.appendChild(line);
    uploadLog.scrollTop = uploadLog.scrollHeight;
  }
}

function recordSkippedUploadDetails(items) {
  const skipped = Array.isArray(items) ? items : [];
  if (!skipped.length) return;
  state.uploadActivity.skippedDetails.push(...skipped.map((item) => ({
    filename: item.filename || "Unknown file",
    reason: item.reason || "Skipped by upload validation"
  })));
  state.uploadActivity.skippedDetails = state.uploadActivity.skippedDetails.slice(-25);
  refreshSkippedDetails();
}

function skippedReasonSummary() {
  const counts = {};
  for (const item of state.uploadActivity.skippedDetails || []) {
    const reason = item.reason || "Skipped";
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return Object.entries(counts).map(([reason, count]) => `${count} ${reason}`).join("; ");
}

function skippedDetailsHtml(limit = 8) {
  const details = state.uploadActivity.skippedDetails || [];
  if (!details.length) return "";
  const recent = details.slice(-limit).reverse();
  return `
    <div class="upload-skipped-details" id="uploadSkippedDetails">
      <strong>Skipped file reasons</strong>
      <p>${escapeHtml(skippedReasonSummary())}</p>
      <ul>
        ${recent.map((item) => `<li><span>${escapeHtml(item.filename)}</span><em>${escapeHtml(item.reason)}</em></li>`).join("")}
      </ul>
    </div>
  `;
}

function refreshSkippedDetails() {
  const existing = document.querySelector("#uploadSkippedDetails");
  const html = skippedDetailsHtml();
  if (existing) {
    if (html) existing.outerHTML = html;
    else existing.remove();
    return;
  }
  if (html) document.querySelector("#uploadLog")?.insertAdjacentHTML("beforebegin", html);
}

function wireLinks() {
  document.querySelectorAll("[data-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      go(link.getAttribute("href"));
    });
  });
}

function loginPage() {
  const params = new URLSearchParams(window.location.search);
  const googleMessage = {
    "not-configured": "Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in Vercel environment variables.",
    failed: "Google sign-in failed. Check the OAuth redirect URL in Google Cloud.",
    unverified: "Google did not return a verified email address."
  }[params.get("google")] || "";
  const googleConfigured = state.config?.googleConfigured;
  app.innerHTML = `
    <main class="login-page">
      <section class="login-card">
        <div class="login-brand">
          <img src="/assets/agbs-logo.jpg" alt="Amazing Grace Biblical Seminary logo">
          <h1>AGBS LIBRARY</h1>
        </div>
        <p class="subtle">Sign in to read approved seminary resources.</p>
        <form class="form" id="loginForm">
          <label>Email <input name="email" type="email" autocomplete="email" required></label>
          <label>Password <input id="loginPassword" name="password" type="password" autocomplete="current-password" required></label>
          <label class="inline-check"><input id="showLoginPassword" type="checkbox"> Show password</label>
          <button>Sign in</button>
          <p class="error" id="loginError"></p>
        </form>
        <div class="form">
          <button class="secondary" id="googleBtn">Sign in with Google</button>
          <p class="${googleMessage ? "error" : "subtle"}">${googleMessage || (googleConfigured ? "Google sign-in is configured." : "Google sign-in needs OAuth environment variables in Vercel.")}</p>
        </div>
        <form class="form" id="setupForm">
          <p class="subtle">First admin setup only: enter the approved admin email and create a new password.</p>
          <label>Admin email <input name="email" type="email" required></label>
          <label>New password <input name="password" type="password" minlength="10" required></label>
          <button class="secondary">Set first admin password</button>
          <p class="error" id="setupError"></p>
        </form>
      </section>
    </main>
  `;
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const data = await api("/api/auth/login", { method: "POST", body: form });
      state.user = data.user;
      go("/library");
    } catch (error) {
      document.querySelector("#loginError").textContent = error.message;
    }
  });
  document.querySelector("#showLoginPassword").addEventListener("change", (event) => {
    document.querySelector("#loginPassword").type = event.currentTarget.checked ? "text" : "password";
  });
  document.querySelector("#setupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api("/api/auth/setup", { method: "POST", body: form });
      document.querySelector("#setupError").textContent = "Password set. You can sign in now.";
    } catch (error) {
      document.querySelector("#setupError").textContent = error.message;
    }
  });
  document.querySelector("#googleBtn").addEventListener("click", () => {
    window.location.href = "/api/auth/google/start";
  });
}

async function loadCategories() {
  const categories = await api("/api/categories");
  state.categories = Array.isArray(categories.categories) ? categories.categories : [];
}

function categoryLabel(category) {
  if (!category) return "Uncategorized";
  return category.parentName ? `${category.parentName} / ${category.name}` : category.name;
}

function mainCategories() {
  return (Array.isArray(state.categories) ? state.categories : []).filter((category) => !category.parentName);
}

function categoryAndChildIds(category) {
  if (!category) return [];
  return [category.id, ...(Array.isArray(state.categories) ? state.categories : [])
    .filter((item) => item.parentId === category.id || item.parentName === category.name)
    .map((item) => item.id)];
}

async function loadResources({ q = "", categoryId = "", limit = 0, sort = "" } = {}) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (categoryId) params.set("category", categoryId);
  if (limit) params.set("limit", String(limit));
  if (sort) params.set("sort", sort);
  const resources = await api(`/api/resources${params.toString() ? `?${params}` : ""}`);
  state.resources = Array.isArray(resources.resources) ? resources.resources : [];
}

async function loadLibrary() {
  await Promise.all([loadCategories(), loadResources()]);
}

async function loadAdminSummary() {
  const summary = await api("/api/resources-summary");
  state.resources = Array.isArray(summary.recentResources) ? summary.recentResources : [];
  state.resourceCounts = summary.counts || { total: 0, byCategory: {} };
}

async function loadStorageUsage() {
  state.storageUsage = await api("/api/storage-usage");
}

async function libraryPage() {
  await loadCategories();
  const staff = ["admin", "director"].includes(state.user?.role);
  const params = new URLSearchParams(window.location.search);
  const categorySlug = params.get("category") || (route().startsWith("/library/") ? decodeURIComponent(route().split("/").pop()) : "");
  const searchText = params.get("q") || "";
  const categories = Array.isArray(state.categories) ? state.categories : [];
  const visibleCategories = mainCategories();
  const currentCategory = categories.find((item) => item.slug === categorySlug || item.id === categorySlug);
  const terms = searchText.toLowerCase().split(/\s+/).filter(Boolean);
  const hasBrowseRequest = Boolean(currentCategory || terms.length);
  if (hasBrowseRequest) await loadResources({ q: searchText, categoryId: currentCategory?.id || "" });
  else state.resources = [];
  const resources = Array.isArray(state.resources) ? state.resources : [];
  const emptyMessage = hasBrowseRequest
    ? "No matching books were found. Try another title, author, file word, or department."
    : "Search a title, author, file word, or choose a department to see books.";
  layout(`
    <main class="page">
      <h1>${currentCategory ? currentCategory.name : "Library"}</h1>
      <p class="subtle">Search or choose a department to list the books you want to read.</p>
      <form class="toolbar searchbar" id="librarySearchForm">
        <label>Search any word <input id="librarySearchInput" name="q" value="${escapeAttr(searchText)}" placeholder="Title, author, topic, department"></label>
        <label>Category
          <select id="libraryCategoryInput" name="category">
            <option value="">All categories</option>
            ${visibleCategories.map((category) => `<option value="${category.slug}" ${currentCategory?.id === category.id ? "selected" : ""}>${escapeHtml(categoryLabel(category))}</option>`).join("")}
          </select>
        </label>
        <button>Search</button>
        <button type="button" class="secondary" id="clearLibrarySearch">Clear</button>
      </form>
      <div class="toolbar">
        <button class="secondary" data-link href="/library">All</button>
        ${visibleCategories.map((category) => `<button class="secondary" data-link href="/library/${category.slug}">${escapeHtml(categoryLabel(category))}</button>`).join("")}
      </div>
      <table class="table library-table">
        <thead><tr><th>Title</th><th>Author</th><th>Category</th><th>Format</th><th>Action</th>${staff ? "<th>Admin edit</th>" : ""}</tr></thead>
        <tbody>${resources.length ? resources.map(libraryResourceRow).join("") : `<tr><td colspan="${staff ? 6 : 5}">${emptyMessage}</td></tr>`}</tbody>
      </table>
    </main>
  `);
  wireResourceButtons();
  wireLibrarySearch();
}

function wireLibrarySearch() {
  document.querySelector("#librarySearchForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const q = document.querySelector("#librarySearchInput").value.trim();
    const category = document.querySelector("#libraryCategoryInput").value;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (category) params.set("category", category);
    go(`/library${params.toString() ? `?${params}` : ""}`);
  });
  document.querySelector("#clearLibrarySearch")?.addEventListener("click", () => go("/library"));
}

function libraryResourceRow(resource) {
  const category = (Array.isArray(state.categories) ? state.categories : []).find((item) => item.id === resource.categoryId);
  const staff = ["admin", "director"].includes(state.user?.role);
  return `
    <tr>
      <td>${escapeHtml(resource.title)}</td>
      <td>${escapeHtml(resource.author || "Unknown author")}</td>
      <td>${escapeHtml(categoryLabel(category))}</td>
      <td><span class="badge published">${escapeHtml(resource.format)}</span></td>
      <td><button data-read="${resource.id}">Read</button></td>
      ${staff ? `
        <td class="library-admin-edit">
          <select data-library-category="${resource.id}" aria-label="Change category for ${escapeAttr(resource.title)}">
            ${state.categories.map((item) => `<option value="${item.id}" ${item.id === resource.categoryId ? "selected" : ""}>${escapeHtml(categoryLabel(item))}</option>`).join("")}
          </select>
          <button class="secondary" data-library-save="${resource.id}">Save category</button>
        </td>
      ` : ""}
    </tr>
  `;
}

function wireResourceButtons() {
  document.querySelectorAll("[data-read]").forEach((button) => {
    button.addEventListener("click", () => go(`/read/${button.dataset.read}`));
  });
  document.querySelectorAll("[data-library-save]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.librarySave;
      const select = document.querySelector(`[data-library-category="${id}"]`);
      if (!select) return;
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "Saving...";
      try {
        await api(`/api/resources/${id}`, { method: "PATCH", body: { categoryId: select.value } });
        button.textContent = "Saved";
        await libraryPage();
      } catch (error) {
        button.disabled = false;
        button.textContent = originalText;
        alert(error.message);
      }
    });
  });
}

async function readPage() {
  const id = route().split("/").pop();
  const resource = (await api(`/api/resources/${id}`)).resource;
  if (!resource) return layout(`<main class="page"><div class="notice">This resource is unavailable.</div></main>`);
  const session = await api("/api/reading/start", { method: "POST", body: { resourceId: id } });
  state.readingSessionId = session.readingSession.id;
  window.addEventListener("beforeunload", endReading);
  layout(`
    <main class="reader">
      <div class="reader-bar ${resource.format === "pdf" ? "reader-bar-pdf" : ""}">
        <div class="reader-title"><strong>${escapeHtml(resource.title)}</strong><span class="subtle">Reading time is recorded.</span></div>
        ${resource.format === "pdf" ? pdfControls() : ""}
        <button class="secondary" id="backLibrary">Back to library</button>
      </div>
      ${readerSurface(resource)}
    </main>
  `);
  document.querySelector("#backLibrary").addEventListener("click", async () => {
    await endReading();
    go("/library");
  });
  if (resource.format === "pdf") await setupPdfViewer(resource.id);
}

function pdfControls() {
  return `
    <div class="pdf-controls">
      <button class="secondary" id="pdfPrev">Previous</button>
      <span id="pdfPageStatus">Loading...</span>
      <button class="secondary" id="pdfNext">Next</button>
      <button class="secondary" id="pdfZoomOut">Zoom out</button>
      <button class="secondary" id="pdfZoomIn">Zoom in</button>
    </div>
  `;
}

function readerSurface(resource) {
  if (resource.format === "pdf") {
    return `
      <section class="pdf-viewer" id="pdfViewer">
        <div class="pdf-stage">
          <canvas id="pdfCanvas" aria-label="PDF page"></canvas>
        </div>
      </section>
    `;
  }
  return `<iframe src="/protected-file/${resource.id}" title="${escapeHtml(resource.title)}"></iframe>`;
}

async function setupPdfViewer(resourceId) {
  const status = document.querySelector("#pdfPageStatus");
  const canvas = document.querySelector("#pdfCanvas");
  const context = canvas.getContext("2d");
    const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
  const response = await fetch(`/protected-file/${resourceId}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to open this PDF.");
  const pdf = await pdfjs.getDocument({ data: await response.arrayBuffer() }).promise;
  let pageNumber = 1;
  let scale = 1.2;
  let rendering = false;

  const renderPage = async () => {
    if (rendering) return;
    rendering = true;
    status.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    await page.render({
      canvasContext: context,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null
    }).promise;
    document.querySelector("#pdfPrev").disabled = pageNumber <= 1;
    document.querySelector("#pdfNext").disabled = pageNumber >= pdf.numPages;
    rendering = false;
  };

  document.querySelector("#pdfPrev").addEventListener("click", async () => {
    if (pageNumber > 1) {
      pageNumber--;
      await renderPage();
    }
  });
  document.querySelector("#pdfNext").addEventListener("click", async () => {
    if (pageNumber < pdf.numPages) {
      pageNumber++;
      await renderPage();
    }
  });
  document.querySelector("#pdfZoomOut").addEventListener("click", async () => {
    scale = Math.max(0.6, scale - 0.2);
    await renderPage();
  });
  document.querySelector("#pdfZoomIn").addEventListener("click", async () => {
    scale = Math.min(2.4, scale + 0.2);
    await renderPage();
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  await renderPage();
}

async function endReading() {
  if (!state.readingSessionId) return;
  const id = state.readingSessionId;
  state.readingSessionId = null;
  await api("/api/reading/end", { method: "POST", body: { readingSessionId: id } }).catch(() => {});
}

async function adminPage() {
  if (!["admin", "director"].includes(state.user?.role)) return layout(`<main class="page"><div class="notice">Admin access required.</div></main>`);
  const [reports] = await Promise.all([api("/api/reports"), loadCategories(), loadAdminSummary(), loadStorageUsage()]);
  state.reports = reports || { users: [], reads: [], logins: [], resources: [] };
  layout(`
    <main class="page">
      <h1>Admin Dashboard</h1>
      <p class="subtle">Upload resources, manage library files, manage categories, and review student history.</p>
      <section class="admin-panels">
        <div class="panel">
          <h2>Upload books</h2>
          <form class="form" id="uploadForm">
            <label>Choose files <input type="file" id="resourceFiles" name="files" accept=".pdf,.epub,.zip" multiple></label>
            <label>Choose folder <input type="file" id="resourceFolder" name="folder" webkitdirectory directory multiple></label>
            <p class="subtle upload-help">Only PDF and EPUB books are allowed. ZIP folders are supported: choose a .zip file and the app will open it, find PDFs/EPUBs inside its folders, and upload each one as a separate library book.</p>
            <label>Upload handling
              <select name="autoCategorize" id="autoCategorize">
                <option value="true">Auto-categorize by file and folder names</option>
                <option value="false">Put everything into one category</option>
              </select>
            </label>
            <label>Category for manual uploads
              <select name="targetCategoryId" id="targetCategoryId">
                ${state.categories.map((category) => `<option value="${category.id}">${escapeHtml(categoryLabel(category))}</option>`).join("")}
              </select>
            </label>
            <div class="button-row">
              <button type="submit" id="uploadSubmit">Upload to library</button>
              <button type="button" class="secondary" id="clearUploadSelection" disabled>Clear selected files</button>
              <button type="button" class="danger" id="stopUpload" disabled>Stop upload</button>
            </div>
            <p class="subtle" id="uploadSelection">No files selected.</p>
            <p class="subtle" id="uploadStatus"></p>
            <div class="upload-log" id="uploadLog"></div>
          </form>
        </div>
        <div class="panel">
          <h2>Add student</h2>
          <form class="form" id="userForm">
            <label>Name <input name="name" required></label>
            <label>Email <input name="email" type="email" required></label>
            <input name="role" type="hidden" value="student">
            <button>Create student login</button>
            <p class="subtle" id="userStatus">Temporary password format: first 3 letters + @agbs2020.</p>
            <div class="temp-password" id="tempPasswordBox" hidden>
              <span>Temporary password</span>
              <strong id="tempPasswordValue"></strong>
            </div>
          </form>
        </div>
        <div class="panel">
          <h2>Add category</h2>
          <form class="form" id="categoryForm">
            <label>Category name <input name="name" required></label>
            <button>Add category</button>
            <p class="subtle" id="categoryStatus"></p>
          </form>
        </div>
      </section>
      <h2>AWS storage</h2>
      <div id="storageUsageSummary">${storageUsageSummary()}</div>
      <div class="section-heading">
        <h2>Classification exports</h2>
        <div class="button-row export-buttons">
          <a class="button-link" href="/api/catalog-export?format=html" target="_blank" rel="noreferrer">HTML</a>
          <a class="button-link" href="/api/catalog-export?format=doc">Word</a>
          <a class="button-link" href="/api/catalog-export?format=xls">Excel</a>
          <a class="button-link" href="/api/catalog-export?format=csv">CSV</a>
          <a class="button-link" href="/api/catalog-export?format=pdf">PDF</a>
        </div>
      </div>
      <h2>Book count</h2>
      <div id="bookCountSummary">${bookCountSummary()}</div>
      <div class="section-heading">
        <h2>Recently added or updated books</h2>
      </div>
      <table class="table" id="resourceReviewTable">
        <thead><tr><th>Title</th><th>Category</th><th>Dewey</th><th>Format</th><th>Action</th></tr></thead>
        <tbody>${resourceRowsHtml()}</tbody>
      </table>
      <h2>Student accounts</h2>
      <div id="studentAccountsWrap">${studentAccountsTable()}</div>
      <h2>Student history</h2>
      ${reportTable()}
    </main>
  `);
  wireAdmin();
}

function formatGb(value) {
  const number = Number(value || 0);
  if (number >= 1000) return `${(number / 1000).toFixed(2)} TB`;
  if (number >= 1) return `${number.toFixed(2)} GB`;
  return `${(number * 1000).toFixed(1)} MB`;
}

function storageUsageSummary() {
  const usage = state.storageUsage || {};
  const remaining = usage.remainingGb === null || usage.remainingGb === undefined ? "Set budget" : formatGb(usage.remainingGb);
  const runway = usage.runwayMonths === null || usage.runwayMonths === undefined
    ? `${Number(usage.planMonths || 12)}+ months`
    : `${Math.max(1, Math.floor(Number(usage.runwayMonths || 0))).toLocaleString()} months`;
  return `
    <section class="stats-grid storage-grid storage-simple">
      <article class="stat-card stat-total">
        <span>Total storage left</span>
        <strong>${remaining}</strong>
      </article>
      <article class="stat-card">
        <span>Month runway</span>
        <strong>${runway}</strong>
      </article>
    </section>
    <p class="subtle">Plan: ${formatGb(usage.budgetGb)} for ${Number(usage.planMonths || 12)} months. This reduces automatically as files are uploaded. Updated ${usage.updatedAt ? new Date(usage.updatedAt).toLocaleString() : "now"}.</p>
  `;
}

function bookCountSummary() {
  const counts = state.resourceCounts || { total: 0, byCategory: {} };
  const categories = mainCategories();
  const categoryCards = categories.map((category) => {
    const count = categoryAndChildIds(category).reduce((sum, id) => sum + Number(counts.byCategory?.[id] || 0), 0);
    return `
      <article class="stat-card">
        <span>${escapeHtml(categoryLabel(category))}</span>
        <strong>${count}</strong>
      </article>
    `;
  }).join("");
  return `
    <section class="stats-grid">
      <article class="stat-card stat-total">
        <span>Total books</span>
        <strong>${Number(counts.total || 0)}</strong>
      </article>
      ${categoryCards}
    </section>
  `;
}

function adminResourceRow(resource) {
  const classification = resource.classification || {};
  return `
    <tr>
      <td><input data-title="${resource.id}" value="${escapeAttr(resource.title)}"></td>
      <td><select data-category="${resource.id}">${state.categories.map((category) => `<option value="${category.id}" ${category.id === resource.categoryId ? "selected" : ""}>${escapeHtml(categoryLabel(category))}</option>`).join("")}</select></td>
      <td><strong>${escapeHtml(classification.number || "")}</strong><br><span class="subtle">${escapeHtml(classification.label || "")}</span></td>
      <td><span class="badge published">${escapeHtml(resource.format)}</span></td>
      <td>
        <button class="secondary" data-save="${resource.id}">Save</button>
        <button class="secondary" data-preview="${resource.id}">View</button>
        <button class="secondary" data-replace="${resource.id}">Replace</button>
        <input class="hidden-file" data-replace-input="${resource.id}" type="file" accept=".pdf,.epub">
        <button class="danger" data-remove="${resource.id}">Remove</button>
      </td>
    </tr>
  `;
}

function studentAccountsTable() {
  const reports = state.reports || { users: [] };
  const users = (Array.isArray(reports.users) ? reports.users : []).filter((user) => user.role === "student");
  const rows = users.map((user) => `
    <tr>
      <td>${escapeHtml(user.name || user.email)}</td>
      <td>${escapeHtml(user.email)}</td>
      <td><span class="badge ${user.active === false ? "pending" : "published"}">${user.active === false ? "removed" : "active"}</span></td>
      <td>${user.removedAt ? escapeHtml(new Date(user.removedAt).toLocaleString()) : ""}</td>
      <td>
        <button class="secondary" data-reset-user="${user.id}">Reset password</button>
        ${user.active === false ? "" : `<button class="danger" data-remove-user="${user.id}">Remove access</button>`}
      </td>
    </tr>
  `).join("");
  return `
    <table class="table">
      <thead><tr><th>Student</th><th>Email</th><th>Status</th><th>Removed at</th><th>Action</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5">No student accounts yet.</td></tr>`}</tbody>
    </table>
  `;
}

function reportTable() {
  const reports = state.reports || { users: [], reads: [], logins: [] };
  const users = (Array.isArray(reports.users) ? reports.users : []).filter((user) => user.role === "student");
  const rows = users.map((user) => {
    const reads = (Array.isArray(reports.reads) ? reports.reads : []).filter((item) => item.userId === user.id);
    const seconds = reads.reduce((sum, item) => sum + Number(item.seconds || 0), 0);
    const books = new Set(reads.map((item) => item.resourceId)).size;
    const logins = (Array.isArray(reports.logins) ? reports.logins : []).filter((item) => item.userId === user.id).length;
    return `<tr><td>${escapeHtml(user.name || user.email)}</td><td>${escapeHtml(user.email)}</td><td>${logins}</td><td>${books}</td><td>${(seconds / 3600).toFixed(2)}</td></tr>`;
  }).join("");
  return `<table class="table"><thead><tr><th>Student</th><th>Email</th><th>Logins</th><th>Books opened</th><th>Reading hours</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No student activity yet.</td></tr>`}</tbody></table>`;
}

function wireAdmin() {
  const resourceInput = document.querySelector("#resourceFiles");
  const folderInput = document.querySelector("#resourceFolder");
  const uploadSelection = document.querySelector("#uploadSelection");
  const uploadStatus = document.querySelector("#uploadStatus");
  const uploadLog = document.querySelector("#uploadLog");
  const uploadButton = document.querySelector("#uploadSubmit");
  const clearUploadButton = document.querySelector("#clearUploadSelection");
  const stopUploadButton = document.querySelector("#stopUpload");
  let uploadController = null;
  const addUploadLog = (message) => {
    addUploadActivityLog(message);
  };
  const selectedUploadFiles = () => state.pendingUploadFiles;
  const updateUploadSelection = () => {
    const files = selectedUploadFiles();
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    const hasZip = files.some(isZipFile);
    const mb = (totalSize / 1024 / 1024).toFixed(2);
    uploadSelection.textContent = files.length ? `${files.length} file(s) selected, ${mb} MB total.` : "No files selected.";
    const message = hasZip
      ? "ZIP mode: the app will open the ZIP folder and upload each PDF/EPUB inside as a separate library book. JPG/image files will be skipped."
      : totalSize > 4 * 1024 * 1024
        ? "Safe upload mode will send each file carefully, then place the finished files into the library."
        : "";
    uploadStatus.textContent = message;
    clearUploadButton.disabled = !files.length || Boolean(uploadController);
  };
  resourceInput.addEventListener("change", () => {
    const added = addPendingUploadFiles(resourceInput.files);
    resourceInput.value = "";
    updateUploadSelection();
    if (added) addUploadLog(`Added ${added} selected file(s) to the upload queue.`);
  });
  folderInput.addEventListener("change", () => {
    const added = addPendingUploadFiles(folderInput.files);
    folderInput.value = "";
    updateUploadSelection();
    if (added) addUploadLog(`Added ${added} file(s) from folder selection to the upload queue.`);
  });
  clearUploadButton.addEventListener("click", () => {
    if (uploadController) return;
    state.pendingUploadFiles = [];
    resourceInput.value = "";
    folderInput.value = "";
    uploadLog.innerHTML = "";
    setUploadActivityStatus("");
    updateUploadSelection();
    addUploadLog("Selection cleared.");
  });
  stopUploadButton.addEventListener("click", async () => {
    if (!uploadController) return;
    stopUploadButton.disabled = true;
    uploadController.abort();
    setUploadActivityStatus("Stopping upload...");
    addUploadLog("Upload stop requested.");
    if (state.activeUpload?.uploadId) {
      try {
        await api("/api/resources/upload-cancel", { method: "POST", body: { uploadId: state.activeUpload.uploadId }, headers: uploadAuthHeaders() });
      } catch {
        addUploadLog("Temporary upload cleanup will finish automatically.");
      }
    }
  });
  document.querySelector("#uploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const files = selectedUploadFiles();
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (!files.length) {
      setUploadActivityStatus("Choose files or a folder first.");
      return;
    }
    const options = {
      autoCategorize: document.querySelector("#autoCategorize").value === "true",
      targetCategoryId: document.querySelector("#targetCategoryId").value
    };
    try {
      uploadController = new AbortController();
      const uploadSession = await api("/api/resources/upload-token", { method: "POST" });
      state.activeUpload = { controller: uploadController, token: uploadSession.uploadToken };
      state.uploadActivity = { running: true, status: "Uploading...", logs: [], skippedDetails: [], added: 0, skipped: 0, failed: 0 };
      uploadButton.disabled = true;
      clearUploadButton.disabled = true;
      stopUploadButton.disabled = false;
      uploadLog.innerHTML = "";
      setUploadActivityStatus("Uploading...");
      let data;
      const streamingUpload = totalSize > 4 * 1024 * 1024 || files.some(isZipFile);
      if (streamingUpload) {
        data = await uploadChunked(files, options, (message) => {
          setUploadActivityStatus(message);
          addUploadLog(message);
        }, async (partial, completed, total) => {
          const addedResources = Array.isArray(partial.resources) ? partial.resources : [];
          const skipped = Array.isArray(partial.skipped) ? partial.skipped : [];
          const failed = Array.isArray(partial.failed) ? partial.failed : [];
          addedResources.forEach((resource) => addUploadLog(`Added to library: ${resource.title}`));
          skipped.forEach((item) => addUploadLog(`Skipped: ${item.filename || "Unknown file"} (${item.reason || "Skipped by upload validation"})`));
          recordSkippedUploadDetails(skipped);
          failed.forEach((item) => addUploadLog(`Failed: ${item.filename} (${item.reason})`));
          const progressLabel = partial.progressLabel || `${completed} of ${total} file(s) checked.`;
          state.uploadActivity.added += addedResources.length;
          state.uploadActivity.skipped += skipped.length;
          state.uploadActivity.failed += failed.length;
          setUploadActivityStatus(`${progressLabel} ${addedResources.length} added in this step, ${skipped.length} skipped, ${failed.length} failed.`);
          state.resources = [...(Array.isArray(state.resources) ? state.resources : []), ...addedResources];
          if (addedResources.length) {
            state.resourceCounts.total = Number(state.resourceCounts.total || 0) + addedResources.length;
            for (const resource of addedResources) {
              state.resourceCounts.byCategory[resource.categoryId || ""] = Number(state.resourceCounts.byCategory[resource.categoryId || ""] || 0) + 1;
            }
            refreshStorageUsage().catch(() => {});
          }
          refreshResourceReviewTable();
          wireResourceActions();
        }, uploadController.signal);
      } else {
        const form = new FormData();
        form.append("autoCategorize", String(options.autoCategorize));
        form.append("targetCategoryId", options.targetCategoryId);
        for (const file of files) {
          form.append("files", file, uploadFilename(file));
        }
        files.forEach((file) => addUploadLog(`Uploading ${uploadFilename(file)}`));
        data = await api("/api/resources/upload", { method: "POST", body: form, signal: uploadController.signal, headers: uploadAuthHeaders() });
      }
      const skippedCount = data.skipped?.length || 0;
      const failedCount = data.failed?.length || 0;
      const addedResources = Array.isArray(data.resources) ? data.resources : [];
      if (!streamingUpload) {
        state.uploadActivity.added += addedResources.length;
        state.uploadActivity.skipped += skippedCount;
        state.uploadActivity.failed += failedCount;
      }
      const completionMessage = `Upload completed. Added: ${addedResources.length}. Skipped: ${skippedCount}. Failed: ${failedCount}.`;
      setUploadActivityStatus(completionMessage);
      if (!streamingUpload) {
        addedResources.forEach((resource) => addUploadLog(`Added to library: ${resource.title}`));
        (data.skipped || []).forEach((item) => addUploadLog(`Skipped: ${item.filename || "Unknown file"} (${item.reason || "Skipped by upload validation"})`));
        recordSkippedUploadDetails(data.skipped || []);
        (data.failed || []).forEach((item) => addUploadLog(`Failed: ${item.filename} (${item.reason})`));
      }
      try {
        await loadAdminSummary();
        refreshResourceReviewTable();
        await refreshStorageUsage();
        wireResourceActions();
      } catch {
        addUploadLog("Upload finished. Refresh the admin page if the newest list is not visible yet.");
      }
      state.pendingUploadFiles = [];
      updateUploadSelection();
    } catch (error) {
      const stopped = error.name === "AbortError";
      const authLost = isAuthError(error);
      setUploadActivityStatus(stopped ? "Upload stopped." : authLost ? "Upload paused because login was lost. Sign in again, then continue with the remaining files." : error.message);
      addUploadLog(stopped ? "Upload stopped before completion." : authLost ? "Login was lost during upload. Already added books remain in the library; sign in again before continuing." : `Error: ${error.message}`);
    } finally {
      uploadButton.disabled = false;
      stopUploadButton.disabled = true;
      uploadController = null;
      state.activeUpload = null;
      state.uploadActivity.running = false;
      updateUploadSelection();
    }
  });
  document.querySelector("#userForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/users", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget)) });
      document.querySelector("#userStatus").textContent = "Student login created. Give this temporary password to the student.";
      document.querySelector("#tempPasswordValue").textContent = result.temporaryPassword;
      document.querySelector("#tempPasswordBox").hidden = false;
      event.currentTarget.reset();
      state.reports = await api("/api/reports");
      refreshStudentAccountsTable();
      wireStudentActions();
    } catch (error) {
      document.querySelector("#userStatus").textContent = error.message;
    }
  });
  document.querySelector("#categoryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/categories", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget)) });
      document.querySelector("#categoryStatus").textContent = "Category added.";
      await adminPage();
    } catch (error) {
      document.querySelector("#categoryStatus").textContent = error.message;
    }
  });
  wireResourceActions();
  wireStudentActions();
}

function refreshResourceReviewTable() {
  const body = document.querySelector("#resourceReviewTable tbody");
  if (!body) return;
  body.innerHTML = resourceRowsHtml();
  refreshBookCountSummary();
}

function resourceRowsHtml() {
  const resources = (Array.isArray(state.resources) ? state.resources : [])
    .slice()
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
    .slice(0, 25);
  return resources.length ? resources.map(adminResourceRow).join("") : `<tr><td colspan="5">No uploaded resources yet.</td></tr>`;
}

function refreshStudentAccountsTable() {
  const wrap = document.querySelector("#studentAccountsWrap");
  if (wrap) wrap.innerHTML = studentAccountsTable();
}

function refreshBookCountSummary() {
  const wrap = document.querySelector("#bookCountSummary");
  if (wrap) wrap.innerHTML = bookCountSummary();
}

async function refreshStorageUsage() {
  const wrap = document.querySelector("#storageUsageSummary");
  if (!wrap) return;
  await loadStorageUsage();
  wrap.innerHTML = storageUsageSummary();
}

function wireStudentActions() {
  document.querySelectorAll("[data-reset-user]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      const result = await api(`/api/users/${button.dataset.resetUser}/reset-password`, { method: "POST" });
      document.querySelector("#userStatus").textContent = `Password reset for ${result.user.name || result.user.email}. Give this temporary password to the student.`;
      document.querySelector("#tempPasswordValue").textContent = result.temporaryPassword;
      document.querySelector("#tempPasswordBox").hidden = false;
      state.reports = await api("/api/reports");
      refreshStudentAccountsTable();
      wireStudentActions();
    });
  });
  document.querySelectorAll("[data-remove-user]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Remove this student's access?")) return;
      await api(`/api/users/${button.dataset.removeUser}`, { method: "DELETE" });
      state.reports = await api("/api/reports");
      refreshStudentAccountsTable();
    });
  });
}

function wireResourceActions() {
  document.querySelectorAll("[data-save]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.save;
      await api(`/api/resources/${id}`, {
        method: "PATCH",
        body: {
          title: document.querySelector(`[data-title="${id}"]`).value,
          categoryId: document.querySelector(`[data-category="${id}"]`).value
        }
      });
      await adminPage();
    });
  });
  document.querySelectorAll("[data-preview]").forEach((button) => {
    button.addEventListener("click", () => {
      window.open(`/protected-file/${button.dataset.preview}`, "_blank", "noopener");
    });
  });
  document.querySelectorAll("[data-replace]").forEach((button) => {
    button.addEventListener("click", () => document.querySelector(`[data-replace-input="${button.dataset.replace}"]`).click());
  });
  document.querySelectorAll("[data-replace-input]").forEach((input) => {
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      const form = new FormData();
      form.append("file", file, file.name);
      await api(`/api/resources/${input.dataset.replaceInput}/replace`, { method: "POST", body: form });
      await adminPage();
    });
  });
  document.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Remove this file from the library?")) return;
      await api(`/api/resources/${button.dataset.remove}`, { method: "DELETE" });
      await adminPage();
    });
  });
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

async function render() {
  try {
    if (!state.config) await loadConfig();
    if (!state.user) await loadMe();
    if (!state.user || route() === "/login") return loginPage();
    if (route().startsWith("/admin")) return await adminPage();
    if (route().startsWith("/read/")) return await readPage();
    return await libraryPage();
  } catch (error) {
    app.innerHTML = `<main class="page"><div class="notice error">${escapeHtml(error.message)}</div></main>`;
  }
}

render();
