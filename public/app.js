const state = {
  user: null,
  config: null,
  categories: [],
  resources: [],
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

async function uploadChunked(files, options, onProgress, signal) {
  const uploadId = crypto.randomUUID();
  state.activeUpload = { uploadId, controller: signal ? null : state.activeUpload?.controller };
  const chunkSize = 1024 * 1024;
  const metadata = files.map((file, fileIndex) => ({
    fileIndex,
    filename: file.webkitRelativePath || file.name,
    contentType: file.type,
    totalChunks: Math.max(1, Math.ceil(file.size / chunkSize))
  }));
  const totalChunks = metadata.reduce((sum, file) => sum + file.totalChunks, 0);
  let sentChunks = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
    const file = files[fileIndex];
    onProgress(`Starting ${metadata[fileIndex].filename}`);
    for (let chunkIndex = 0; chunkIndex < metadata[fileIndex].totalChunks; chunkIndex++) {
      if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
      const start = chunkIndex * chunkSize;
      const chunk = file.slice(start, start + chunkSize);
      const form = new FormData();
      form.append("uploadId", uploadId);
      form.append("fileIndex", String(fileIndex));
      form.append("chunkIndex", String(chunkIndex));
      form.append("chunk", chunk, `${fileIndex}-${chunkIndex}.part`);
      await api("/api/resources/upload-chunk", { method: "POST", body: form, signal });
      sentChunks++;
      onProgress(`Uploading ${metadata[fileIndex].filename}: ${chunkIndex + 1} of ${metadata[fileIndex].totalChunks} steps. Total ${sentChunks} of ${totalChunks}.`);
    }
    onProgress(`Finished ${metadata[fileIndex].filename}`);
  }
  onProgress("Processing uploaded PDFs/files into the selected folders...");
  return api("/api/resources/upload-complete", {
    method: "POST",
    body: {
      uploadId,
      files: metadata,
      autoCategorize: options.autoCategorize,
      targetCategoryId: options.targetCategoryId
    },
    signal
  });
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
  state.categories = categories.categories;
  state.resources = resources.resources;
}

async function libraryPage() {
  await loadLibrary();
  const params = new URLSearchParams(window.location.search);
  const categorySlug = params.get("category") || (route().startsWith("/library/") ? decodeURIComponent(route().split("/").pop()) : "");
  const searchText = params.get("q") || "";
  const currentCategory = state.categories.find((item) => item.slug === categorySlug || item.id === categorySlug);
  const terms = searchText.toLowerCase().split(/\s+/).filter(Boolean);
  const resources = state.resources.filter((resource) => {
    const category = state.categories.find((item) => item.id === resource.categoryId);
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
            ${state.categories.map((category) => `<option value="${category.slug}" ${currentCategory?.id === category.id ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}
          </select>
        </label>
        <button>Search</button>
        <button type="button" class="secondary" id="clearLibrarySearch">Clear</button>
      </form>
      <div class="toolbar">
        <button class="secondary" data-link href="/library">All</button>
        ${state.categories.map((category) => `<button class="secondary" data-link href="/library/${category.slug}">${category.name}</button>`).join("")}
      </div>
      <section class="grid">
        ${resources.length ? resources.map(resourceCard).join("") : `<div class="notice">No published resources are available here yet.</div>`}
      </section>
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

function resourceCard(resource) {
  const category = state.categories.find((item) => item.id === resource.categoryId);
  return `
    <article class="card">
      <span class="badge ${resource.status}">${resource.format}</span>
      <h3>${escapeHtml(resource.title)}</h3>
      <div class="subtle">${escapeHtml(resource.author || "Unknown author")}</div>
      <div class="subtle">${escapeHtml(category?.name || "Uncategorized")}</div>
      <button data-read="${resource.id}">Read</button>
    </article>
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
  const resource = state.resources.find((item) => item.id === id);
  if (!resource) return layout(`<main class="page"><div class="notice">This resource is unavailable.</div></main>`);
  const session = await api("/api/reading/start", { method: "POST", body: { resourceId: id } });
  state.readingSessionId = session.readingSession.id;
  window.addEventListener("beforeunload", endReading);
  layout(`
    <main class="reader">
      <div class="reader-bar">
        <div><strong>${escapeHtml(resource.title)}</strong><div class="subtle">Reading time is being recorded.</div></div>
        <button class="secondary" id="backLibrary">Back to library</button>
      </div>
      <iframe src="/protected-file/${resource.id}" title="${escapeHtml(resource.title)}"></iframe>
    </main>
  `);
  document.querySelector("#backLibrary").addEventListener("click", async () => {
    await endReading();
    go("/library");
  });
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
  state.reports = (await api("/api/reports"));
  layout(`
    <main class="page">
      <h1>Admin Dashboard</h1>
      <p class="subtle">Upload resources, publish books, manage categories, and review student history.</p>
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
              <button type="submit" id="uploadSubmit">Upload for review</button>
              <button type="button" class="danger" id="stopUpload" disabled>Stop upload</button>
            </div>
            <p class="subtle" id="uploadSelection">No files selected.</p>
            <p class="subtle" id="uploadStatus"></p>
            <div class="upload-log" id="uploadLog"></div>
          </form>
        </div>
        <div class="panel">
          <h2>Add student/user</h2>
          <form class="form" id="userForm">
            <label>Name <input name="name" required></label>
            <label>Email <input name="email" type="email" required></label>
            <label>Role <select name="role"><option>student</option><option>admin</option><option>director</option></select></label>
            <label>Temporary password <input name="password" type="password" minlength="10" required></label>
            <button>Create user</button>
            <p class="subtle" id="userStatus"></p>
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
      <div class="section-heading">
        <h2>Resources awaiting/admin review</h2>
        <button id="publishAllPending">Publish all pending</button>
      </div>
      <table class="table" id="resourceReviewTable">
        <thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${state.resources.length ? state.resources.map(adminResourceRow).join("") : `<tr><td colspan="4">No uploaded resources yet.</td></tr>`}</tbody>
      </table>
      <h2>Student history</h2>
      ${reportTable()}
    </main>
  `);
  wireAdmin();
}

function adminResourceRow(resource) {
  return `
    <tr>
      <td><input data-title="${resource.id}" value="${escapeAttr(resource.title)}"></td>
      <td><select data-category="${resource.id}">${state.categories.map((category) => `<option value="${category.id}" ${category.id === resource.categoryId ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}</select></td>
      <td><span class="badge ${resource.status}">${resource.status}</span></td>
      <td>
        <button data-publish="${resource.id}">Publish</button>
        <button class="secondary" data-save="${resource.id}">Save</button>
        <button class="secondary" data-preview="${resource.id}">View</button>
      </td>
    </tr>
  `;
}

function reportTable() {
  const users = state.reports.users.filter((user) => user.role === "student");
  const rows = users.map((user) => {
    const reads = state.reports.reads.filter((item) => item.userId === user.id);
    const seconds = reads.reduce((sum, item) => sum + Number(item.seconds || 0), 0);
    const books = new Set(reads.map((item) => item.resourceId)).size;
    const logins = state.reports.logins.filter((item) => item.userId === user.id).length;
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
      uploadStatus.textContent = `${data.resources.length} file(s) uploaded for review.`;
      data.resources.forEach((resource) => addUploadLog(`Ready for review: ${resource.title}`));
      await loadLibrary();
      state.reports = await api("/api/reports");
      refreshResourceReviewTable();
      wireResourceActions();
    } catch (error) {
      const stopped = error.name === "AbortError";
      uploadStatus.textContent = stopped ? "Upload stopped." : error.message;
      addUploadLog(stopped ? "Upload stopped before publishing for review." : `Error: ${error.message}`);
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
      await api("/api/users", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget)) });
      document.querySelector("#userStatus").textContent = "User created.";
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
  document.querySelector("#publishAllPending").addEventListener("click", async () => {
    const pending = state.resources.filter((resource) => resource.status !== "published");
    await Promise.all(pending.map((resource) => api(`/api/resources/${resource.id}`, { method: "PATCH", body: { status: "published" } })));
    await adminPage();
  });
}

function refreshResourceReviewTable() {
  const body = document.querySelector("#resourceReviewTable tbody");
  if (!body) return;
  body.innerHTML = state.resources.length ? state.resources.map(adminResourceRow).join("") : `<tr><td colspan="4">No uploaded resources yet.</td></tr>`;
}

function wireResourceActions() {
  document.querySelectorAll("[data-publish], [data-save]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.publish || button.dataset.save;
      await api(`/api/resources/${id}`, {
        method: "PATCH",
        body: {
          title: document.querySelector(`[data-title="${id}"]`).value,
          categoryId: document.querySelector(`[data-category="${id}"]`).value,
          status: button.dataset.publish ? "published" : undefined
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
