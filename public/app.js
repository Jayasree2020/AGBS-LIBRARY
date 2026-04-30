const state = {
  user: null,
  config: null,
  categories: [],
  resources: [],
  skippedUploads: [],
  reports: null,
  readingSessionId: null,
  activeUpload: null
};

const app = document.querySelector("#app");

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...options,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function uploadChunkedFile(file, fileIndex, totalFiles, options, onProgress, signal) {
  const uploadId = crypto.randomUUID();
  state.activeUpload = { uploadId };
  const chunkSize = 1024 * 1024;
  const filename = file.webkitRelativePath || file.name;
  const metadata = {
    fileIndex: 0,
    filename,
    contentType: file.type,
    totalChunks: Math.max(1, Math.ceil(file.size / chunkSize))
  };
  try {
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
      await api("/api/resources/upload-chunk", { method: "POST", body: form, signal });
      onProgress(`Uploading ${filename}: ${chunkIndex + 1} of ${metadata.totalChunks} steps.`);
    }
    onProgress(`Saving ${filename} into the library...`);
    return await api("/api/resources/upload-complete", {
      method: "POST",
      body: {
        uploadId,
        files: [metadata],
        autoCategorize: options.autoCategorize,
        targetCategoryId: options.targetCategoryId
      },
      signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      await api("/api/resources/upload-cancel", { method: "POST", body: { uploadId } }).catch(() => {});
    }
    throw error;
  }
}

async function uploadChunked(files, options, onProgress, onFileSaved, signal) {
  const totals = { resources: [], skipped: [], failed: [] };
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
    try {
      const data = await uploadChunkedFile(files[fileIndex], fileIndex, files.length, options, onProgress, signal);
      const addedResources = Array.isArray(data.resources) ? data.resources : [];
      const skipped = Array.isArray(data.skipped) ? data.skipped : [];
      totals.resources.push(...addedResources);
      totals.skipped.push(...skipped);
      onFileSaved?.(data, fileIndex + 1, files.length);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      const filename = files[fileIndex].webkitRelativePath || files[fileIndex].name;
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
        <div class="brand">AGBS LIBRARY</div>
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
        <h1>AGBS LIBRARY</h1>
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

async function loadLibrary() {
  const [categories, resources] = await Promise.all([api("/api/categories"), api("/api/resources")]);
  state.categories = Array.isArray(categories.categories) ? categories.categories : [];
  state.resources = Array.isArray(resources.resources) ? resources.resources : [];
}

async function libraryPage() {
  await loadLibrary();
  const params = new URLSearchParams(window.location.search);
  const categorySlug = params.get("category") || (route().startsWith("/library/") ? decodeURIComponent(route().split("/").pop()) : "");
  const searchText = params.get("q") || "";
  const categories = Array.isArray(state.categories) ? state.categories : [];
  const allResources = Array.isArray(state.resources) ? state.resources : [];
  const currentCategory = categories.find((item) => item.slug === categorySlug || item.id === categorySlug);
  const terms = searchText.toLowerCase().split(/\s+/).filter(Boolean);
  const resources = allResources.filter((resource) => {
    const category = categories.find((item) => item.id === resource.categoryId);
    const haystack = `${resource.title || ""} ${resource.author || ""} ${resource.format || ""} ${resource.originalFilename || ""} ${category?.name || ""}`.toLowerCase();
    const categoryMatches = !currentCategory || resource.categoryId === currentCategory.id;
    const textMatches = !terms.length || terms.some((term) => haystack.includes(term));
    return categoryMatches && textMatches;
  });
  layout(`
    <main class="page">
      <h1>${currentCategory ? currentCategory.name : "Library"}</h1>
      <p class="subtle">Browse approved PDF and EPUB resources by department.</p>
      <form class="toolbar searchbar" id="librarySearchForm">
        <label>Search any word <input id="librarySearchInput" name="q" value="${escapeAttr(searchText)}" placeholder="Title, author, topic, department"></label>
        <label>Category
          <select id="libraryCategoryInput" name="category">
            <option value="">All categories</option>
            ${categories.map((category) => `<option value="${category.slug}" ${currentCategory?.id === category.id ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}
          </select>
        </label>
        <button>Search</button>
        <button type="button" class="secondary" id="clearLibrarySearch">Clear</button>
      </form>
      <div class="toolbar">
        <button class="secondary" data-link href="/library">All</button>
        ${categories.map((category) => `<button class="secondary" data-link href="/library/${category.slug}">${category.name}</button>`).join("")}
      </div>
      <table class="table library-table">
        <thead><tr><th>Title</th><th>Author</th><th>Category</th><th>Format</th><th>Action</th></tr></thead>
        <tbody>${resources.length ? resources.map(libraryResourceRow).join("") : `<tr><td colspan="5">No resources are available here yet.</td></tr>`}</tbody>
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
  return `
    <tr>
      <td>${escapeHtml(resource.title)}</td>
      <td>${escapeHtml(resource.author || "Unknown author")}</td>
      <td>${escapeHtml(category?.name || "Uncategorized")}</td>
      <td><span class="badge published">${escapeHtml(resource.format)}</span></td>
      <td><button data-read="${resource.id}">Read</button></td>
    </tr>
  `;
}

function wireResourceButtons() {
  document.querySelectorAll("[data-read]").forEach((button) => {
    button.addEventListener("click", () => go(`/read/${button.dataset.read}`));
  });
}

async function readPage() {
  await loadLibrary();
  const id = route().split("/").pop();
  const resource = (Array.isArray(state.resources) ? state.resources : []).find((item) => item.id === id);
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
  const pdfjs = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
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
  await loadLibrary();
  const [reports, skipped] = await Promise.all([api("/api/reports"), api("/api/skipped-uploads")]);
  state.reports = reports || { users: [], reads: [], logins: [], resources: [] };
  state.skippedUploads = Array.isArray(skipped.skipped) ? skipped.skipped : [];
  layout(`
    <main class="page">
      <h1>Admin Dashboard</h1>
      <p class="subtle">Upload resources, manage library files, manage categories, and review student history.</p>
      <section class="admin-panels">
        <div class="panel">
          <h2>Upload books</h2>
          <form class="form" id="uploadForm">
            <label>Choose files <input type="file" id="resourceFiles" name="files" accept=".pdf,.epub,.zip,.png,.jpg,.jpeg,.webp,.gif" multiple></label>
            <label>Choose folder <input type="file" id="resourceFolder" name="folder" webkitdirectory directory multiple></label>
            <label>Upload handling
              <select name="autoCategorize" id="autoCategorize">
                <option value="true">Auto-categorize by file and folder names</option>
                <option value="false">Put everything into one category</option>
              </select>
            </label>
            <label>Category for manual uploads
              <select name="targetCategoryId" id="targetCategoryId">
                ${state.categories.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join("")}
              </select>
            </label>
            <div class="button-row">
              <button type="submit" id="uploadSubmit">Upload to library</button>
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
            <p class="subtle" id="userStatus">Temporary password format: first 3 letters + @agbs.</p>
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
      <h2>Book count</h2>
      <div id="bookCountSummary">${bookCountSummary()}</div>
      <div class="section-heading">
        <h2>Library files</h2>
      </div>
      <table class="table" id="resourceReviewTable">
        <thead><tr><th>Title</th><th>Category</th><th>Format</th><th>Action</th></tr></thead>
        <tbody>${resourceRowsHtml()}</tbody>
      </table>
      <h2>Skipped duplicate uploads</h2>
      <div id="skippedUploadsWrap">${skippedUploadsTable()}</div>
      <h2>Student accounts</h2>
      <div id="studentAccountsWrap">${studentAccountsTable()}</div>
      <h2>Student history</h2>
      ${reportTable()}
    </main>
  `);
  wireAdmin();
}

function bookCountSummary() {
  const resources = Array.isArray(state.resources) ? state.resources : [];
  const categories = Array.isArray(state.categories) ? state.categories : [];
  const categoryCards = categories.map((category) => {
    const count = resources.filter((resource) => resource.categoryId === category.id).length;
    return `
      <article class="stat-card">
        <span>${escapeHtml(category.name)}</span>
        <strong>${count}</strong>
      </article>
    `;
  }).join("");
  return `
    <section class="stats-grid">
      <article class="stat-card stat-total">
        <span>Total books</span>
        <strong>${resources.length}</strong>
      </article>
      ${categoryCards}
    </section>
  `;
}

function adminResourceRow(resource) {
  return `
    <tr>
      <td><input data-title="${resource.id}" value="${escapeAttr(resource.title)}"></td>
      <td><select data-category="${resource.id}">${state.categories.map((category) => `<option value="${category.id}" ${category.id === resource.categoryId ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}</select></td>
      <td><span class="badge published">${escapeHtml(resource.format)}</span></td>
      <td>
        <button class="secondary" data-save="${resource.id}">Save</button>
        <button class="secondary" data-preview="${resource.id}">View</button>
        <button class="secondary" data-replace="${resource.id}">Replace</button>
        <input class="hidden-file" data-replace-input="${resource.id}" type="file" accept=".pdf,.epub,.png,.jpg,.jpeg,.webp,.gif">
        <button class="danger" data-remove="${resource.id}">Remove</button>
      </td>
    </tr>
  `;
}

function skippedUploadsTable() {
  const rows = state.skippedUploads.map((item) => `
    <tr>
      <td>${escapeHtml(item.filename)}</td>
      <td>${escapeHtml(item.reason)}</td>
      <td>${formatBytes(item.size)}</td>
      <td>${escapeHtml(new Date(item.createdAt).toLocaleString())}</td>
    </tr>
  `).join("");
  return `
    <table class="table">
      <thead><tr><th>File</th><th>Reason</th><th>Size</th><th>Skipped at</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4">No skipped duplicate uploads yet.</td></tr>`}</tbody>
    </table>
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
      <td>${user.active === false ? "" : `<button class="danger" data-remove-user="${user.id}">Remove access</button>`}</td>
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
  const stopUploadButton = document.querySelector("#stopUpload");
  let uploadController = null;
  const addUploadLog = (message) => {
    const line = document.createElement("div");
    line.textContent = message;
    uploadLog.appendChild(line);
    uploadLog.scrollTop = uploadLog.scrollHeight;
  };
  const selectedUploadFiles = () => [...resourceInput.files, ...folderInput.files];
  const updateUploadSelection = () => {
    const files = selectedUploadFiles();
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    const mb = (totalSize / 1024 / 1024).toFixed(2);
    uploadSelection.textContent = files.length ? `${files.length} file(s) selected, ${mb} MB total.` : "No files selected.";
    uploadStatus.textContent = totalSize > 4 * 1024 * 1024 ? "Large upload mode will send each PDF/file safely, then place the finished files into folders." : "";
  };
  resourceInput.addEventListener("change", updateUploadSelection);
  folderInput.addEventListener("change", updateUploadSelection);
  stopUploadButton.addEventListener("click", async () => {
    if (!uploadController) return;
    stopUploadButton.disabled = true;
    uploadController.abort();
    uploadStatus.textContent = "Stopping upload...";
    addUploadLog("Upload stop requested.");
    if (state.activeUpload?.uploadId) {
      try {
        await api("/api/resources/upload-cancel", { method: "POST", body: { uploadId: state.activeUpload.uploadId } });
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
      uploadStatus.textContent = "Choose files or a folder first.";
      return;
    }
    const options = {
      autoCategorize: document.querySelector("#autoCategorize").value === "true",
      targetCategoryId: document.querySelector("#targetCategoryId").value
    };
    try {
      uploadController = new AbortController();
      uploadButton.disabled = true;
      stopUploadButton.disabled = false;
      uploadLog.innerHTML = "";
      uploadStatus.textContent = "Uploading...";
      let data;
      if (totalSize > 4 * 1024 * 1024) {
        data = await uploadChunked(files, options, (message) => {
          uploadStatus.textContent = message;
          addUploadLog(message);
        }, async (partial, completed, total) => {
          const addedResources = Array.isArray(partial.resources) ? partial.resources : [];
          const skipped = Array.isArray(partial.skipped) ? partial.skipped : [];
          const failed = Array.isArray(partial.failed) ? partial.failed : [];
          addedResources.forEach((resource) => addUploadLog(`Added to library: ${resource.title}`));
          skipped.forEach((item) => addUploadLog(`Skipped: ${item.filename} (${item.reason})`));
          failed.forEach((item) => addUploadLog(`Failed: ${item.filename} (${item.reason})`));
          uploadStatus.textContent = `${completed} of ${total} file(s) checked. ${addedResources.length} added in this step, ${skipped.length} skipped, ${failed.length} failed.`;
          state.resources = [...(Array.isArray(state.resources) ? state.resources : []), ...addedResources];
          state.skippedUploads = [...(Array.isArray(state.skippedUploads) ? state.skippedUploads : []), ...skipped];
          refreshResourceReviewTable();
          refreshSkippedUploadsTable();
          wireResourceActions();
        }, uploadController.signal);
      } else {
        const form = new FormData();
        form.append("autoCategorize", String(options.autoCategorize));
        form.append("targetCategoryId", options.targetCategoryId);
        for (const file of files) {
          form.append("files", file, file.webkitRelativePath || file.name);
        }
        files.forEach((file) => addUploadLog(`Uploading ${file.webkitRelativePath || file.name}`));
        data = await api("/api/resources/upload", { method: "POST", body: form, signal: uploadController.signal });
      }
      const skippedCount = data.skipped?.length || 0;
      const failedCount = data.failed?.length || 0;
      const addedResources = Array.isArray(data.resources) ? data.resources : [];
      uploadStatus.textContent = `${addedResources.length} file(s) added to the library. ${skippedCount} skipped. ${failedCount} failed.`;
      addedResources.forEach((resource) => addUploadLog(`Added to library: ${resource.title}`));
      (data.skipped || []).forEach((item) => addUploadLog(`Skipped: ${item.filename} (${item.reason})`));
      (data.failed || []).forEach((item) => addUploadLog(`Failed: ${item.filename} (${item.reason})`));
      await loadLibrary();
      state.reports = await api("/api/reports");
      state.skippedUploads = (await api("/api/skipped-uploads")).skipped || [];
      refreshResourceReviewTable();
      refreshSkippedUploadsTable();
      wireResourceActions();
    } catch (error) {
      const stopped = error.name === "AbortError";
      uploadStatus.textContent = stopped ? "Upload stopped." : error.message;
      addUploadLog(stopped ? "Upload stopped before completion." : `Error: ${error.message}`);
    } finally {
      uploadButton.disabled = false;
      stopUploadButton.disabled = true;
      uploadController = null;
      state.activeUpload = null;
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
  const resources = Array.isArray(state.resources) ? state.resources : [];
  return resources.length ? resources.map(adminResourceRow).join("") : `<tr><td colspan="4">No uploaded resources yet.</td></tr>`;
}

function refreshSkippedUploadsTable() {
  const wrap = document.querySelector("#skippedUploadsWrap");
  if (wrap) wrap.innerHTML = skippedUploadsTable();
}

function refreshStudentAccountsTable() {
  const wrap = document.querySelector("#studentAccountsWrap");
  if (wrap) wrap.innerHTML = studentAccountsTable();
}

function refreshBookCountSummary() {
  const wrap = document.querySelector("#bookCountSummary");
  if (wrap) wrap.innerHTML = bookCountSummary();
}

function wireStudentActions() {
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
