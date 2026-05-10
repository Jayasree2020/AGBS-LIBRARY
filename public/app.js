const state = {
  user: null,
  config: null,
  categories: [],
  resources: [],
  resourceCounts: { total: 0, byCategory: {} },
  resourceHashes: new Set(),
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
    failed: 0,
    progressCompleted: 0,
    progressTotal: 0
  }
};

const app = document.querySelector("#app");
const UPLOAD_DB_NAME = "agbs-upload-queue";
const UPLOAD_STORE_NAME = "files";
const UPLOAD_STATE_KEY = "agbs-upload-state";
const LARGE_UPLOAD_CHUNK_SIZE = 3 * 1024 * 1024;
const DIRECT_FILE_UPLOAD_LIMIT = 3 * 1024 * 1024;
const DIRECT_UPLOAD_CONCURRENCY = 4;
let catalogWriteQueue = Promise.resolve();

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

function isZipFilename(name) {
  return String(name || "").toLowerCase().endsWith(".zip");
}

function uploadFilename(file) {
  return file.libraryPath || file.webkitRelativePath || file.name;
}

function isSupportedLibraryFile(name) {
  return /\.(pdf|epub)\s*\.?$/i.test(String(name || "").trim());
}

function isUploadableLibraryFile(file) {
  return isZipFile(file) || isSupportedLibraryFile(uploadFilename(file));
}

function uploadSelectionSummary(files) {
  const items = Array.from(files || []);
  const supported = items.filter(isUploadableLibraryFile);
  const unsupported = items.length - supported.length;
  const folderPaths = new Set();
  let pdfCount = 0;
  let epubCount = 0;
  let zipCount = 0;
  let nestedFiles = 0;
  for (const file of items) {
    const name = uploadFilename(file);
    if (/\.pdf\s*\.?$/i.test(name)) pdfCount += 1;
    if (/\.epub\s*\.?$/i.test(name)) epubCount += 1;
    if (isZipFilename(name)) zipCount += 1;
    const parts = String(name || "").split(/[\\/]/).filter(Boolean);
    if (parts.length > 1) folderPaths.add(parts.slice(0, -1).join("/"));
    if (parts.length > 2) nestedFiles += 1;
  }
  return { total: items.length, supported, unsupported, folderCount: folderPaths.size, nestedFiles, pdfCount, epubCount, zipCount };
}

function joinLibraryPath(parent, child) {
  return [parent, child].map((part) => String(part || "").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
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

function openUploadDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("This browser cannot remember uploads after refresh."));
    const request = indexedDB.open(UPLOAD_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(UPLOAD_STORE_NAME)) db.createObjectStore(UPLOAD_STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Upload queue storage failed."));
  });
}

async function withUploadStore(mode, callback) {
  const db = await openUploadDb();
  return await new Promise((resolve, reject) => {
    const transaction = db.transaction(UPLOAD_STORE_NAME, mode);
    const store = transaction.objectStore(UPLOAD_STORE_NAME);
    const result = callback(store);
    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Upload queue storage failed."));
    };
  });
}

async function saveUploadQueueFiles(files) {
  const items = Array.from(files || []);
  if (!items.length) return;
  await withUploadStore("readwrite", (store) => {
    for (const file of items) {
      store.put({
        key: uploadFileKey(file),
        filename: uploadFilename(file),
        libraryPath: uploadFilename(file),
        type: file.type,
        size: file.size,
        lastModified: file.lastModified || Date.now(),
        file
      });
    }
  });
}

async function loadUploadQueueFiles() {
  try {
    const records = await withUploadStore("readonly", (store) => new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("Upload queue could not be loaded."));
    }));
    return records.map((record) => {
      const file = record.file;
      if (file && record.libraryPath) file.libraryPath = record.libraryPath;
      return file;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function removeUploadQueueFile(file) {
  try {
    await withUploadStore("readwrite", (store) => store.delete(uploadFileKey(file)));
  } catch {}
}

async function clearUploadQueueFiles() {
  try {
    await withUploadStore("readwrite", (store) => store.clear());
  } catch {}
}

function fileFromEntry(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkDroppedEntry(entry, parentPath = "") {
  const fullPath = joinLibraryPath(parentPath, entry.name);
  if (entry.isFile) {
    const file = await fileFromEntry(entry);
    file.libraryPath = fullPath;
    return [file];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const files = [];
  while (true) {
    const entries = await readDirectoryEntries(reader);
    if (!entries.length) break;
    for (const child of entries) files.push(...await walkDroppedEntry(child, fullPath));
  }
  return files;
}

async function filesFromDrop(event) {
  const items = Array.from(event.dataTransfer?.items || []);
  if (items.length && items.some((item) => typeof item.webkitGetAsEntry === "function")) {
    const files = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) files.push(...await walkDroppedEntry(entry));
    }
    return files;
  }
  return Array.from(event.dataTransfer?.files || []);
}

async function walkDirectoryHandle(handle, parentPath = "") {
  const files = [];
  for await (const [name, child] of handle.entries()) {
    const childPath = joinLibraryPath(parentPath, name);
    if (child.kind === "file") {
      const file = await child.getFile();
      file.libraryPath = childPath;
      files.push(file);
    } else if (child.kind === "directory") {
      files.push(...await walkDirectoryHandle(child, childPath));
    }
  }
  return files;
}

function rememberUploadState(options, running = true) {
  localStorage.setItem(UPLOAD_STATE_KEY, JSON.stringify({ running, options, savedAt: Date.now() }));
}

function readRememberedUploadState() {
  try {
    return JSON.parse(localStorage.getItem(UPLOAD_STATE_KEY) || "{}");
  } catch {
    return {};
  }
}

function clearRememberedUploadState() {
  localStorage.removeItem(UPLOAD_STATE_KEY);
}

function hexFromBytes(buffer) {
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fileSha256(file) {
  return hexFromBytes(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

async function duplicateSkipForFile(file, seenHashes, knownHashes) {
  const hash = await fileSha256(file);
  file.libraryHash = hash;
  if (seenHashes.has(hash)) {
    return { skipped: { filename: uploadFilename(file), reason: "Exact duplicate in this upload ignored", hash } };
  }
  seenHashes.add(hash);
  return { hash };
}

function requestWithUploadProgress(url, { method = "POST", body, headers = {}, signal, jsonResponse = true, onUploadProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = !/^https?:\/\//i.test(url) || url.startsWith(window.location.origin);
    for (const [name, value] of Object.entries(headers || {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof onUploadProgress === "function") {
        onUploadProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!jsonResponse) return resolve({ ok: true, status: xhr.status });
        try {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : {});
        } catch {
          reject(new Error("Upload response could not be read."));
        }
      } else {
        reject(new ApiError(`Upload failed with status ${xhr.status}.`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error("Upload connection failed."));
    xhr.onabort = () => reject(new DOMException("Upload stopped.", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function uploadWithPresignedPost(ticket, file, fileIndex, totalFiles, signal) {
  const form = new FormData();
  for (const [name, value] of Object.entries(ticket.uploadPost.fields || {})) form.append(name, value);
  form.append("file", file);
  await requestWithUploadProgress(ticket.uploadPost.url, {
    method: "POST",
    body: form,
    signal,
    jsonResponse: false,
    onUploadProgress: (fraction) => setUploadFileProgress(fileIndex, totalFiles, fraction, `Uploading ${uploadFilename(file)}: ${Math.round(fraction * 100)}%`)
  });
}

function enqueueCatalogWrite(task) {
  const run = catalogWriteQueue.then(task, task);
  catalogWriteQueue = run.catch(() => {});
  return run;
}

async function sendFileChunks(file, fileIndex, totalFiles, onProgress, signal, label = "Uploading") {
  const uploadId = crypto.randomUUID();
  state.activeUpload = { ...(state.activeUpload || {}), uploadId };
  const chunkSize = LARGE_UPLOAD_CHUNK_SIZE;
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
    await requestWithUploadProgress("/api/resources/upload-chunk", {
      method: "POST",
      body: form,
      signal,
      headers: uploadAuthHeaders(),
      onUploadProgress: (fraction) => setUploadProgress(fileIndex + ((chunkIndex + fraction) / metadata.totalChunks), totalFiles, `${label} ${filename}: ${Math.round(((chunkIndex + fraction) / metadata.totalChunks) * 100)}%`)
    });
    setUploadProgress(fileIndex + ((chunkIndex + 1) / metadata.totalChunks), totalFiles, `${label} ${filename}: ${chunkIndex + 1} of ${metadata.totalChunks} steps.`);
    onProgress(`${label} ${filename}: ${chunkIndex + 1} of ${metadata.totalChunks} steps.`);
  }
  return { uploadId, metadata };
}

async function uploadDirectFile(file, fileIndex, totalFiles, options, onProgress, signal) {
  const hash = file.libraryHash || await fileSha256(file);
  file.libraryHash = hash;
  onProgress(`Requesting fast AWS upload for ${uploadFilename(file)}...`);
  try {
    const ticket = await api("/api/resources/direct-upload-url", {
      method: "POST",
      body: {
        filename: uploadFilename(file),
        contentType: file.type || mimeForFilename(uploadFilename(file)),
        size: file.size,
        hash,
        autoCategorize: options.autoCategorize,
        targetCategoryId: options.targetCategoryId
      },
      signal,
      headers: uploadAuthHeaders()
    });
    if (Array.isArray(ticket.resources)) {
      setUploadFileProgress(fileIndex, totalFiles, 1, `Catalog updated for ${uploadFilename(file)}`);
      return { resources: ticket.resources, skipped: Array.isArray(ticket.skipped) ? ticket.skipped : [], failed: [] };
    }
    if (ticket.skipped) {
      setUploadFileProgress(fileIndex, totalFiles, 1, `Skipped ${uploadFilename(file)}`);
      return { resources: [], skipped: [ticket.skipped], failed: [] };
    }
    if (ticket.direct && ticket.storageName) {
      onProgress(`Uploading ${uploadFilename(file)} directly to AWS...`);
      let uploadedDirectly = false;
      let directError = null;
      if (ticket.uploadUrl) {
        try {
          await requestWithUploadProgress(ticket.uploadUrl, {
            method: "PUT",
            body: file,
            signal,
            jsonResponse: false,
            onUploadProgress: (fraction) => setUploadFileProgress(fileIndex, totalFiles, fraction, `Uploading ${uploadFilename(file)}: ${Math.round(fraction * 100)}%`)
          });
          uploadedDirectly = true;
        } catch (error) {
          directError = error;
        }
      }
      if (!uploadedDirectly && ticket.uploadPost?.url) {
        try {
          onProgress(`Retrying ${uploadFilename(file)} with AWS form upload...`);
          await uploadWithPresignedPost(ticket, file, fileIndex, totalFiles, signal);
          uploadedDirectly = true;
        } catch (error) {
          directError = error;
        }
      }
      if (!uploadedDirectly) throw new Error(`AWS direct upload was blocked${directError?.message ? `: ${directError.message}` : ""}`);
      onProgress(`Saving ${uploadFilename(file)} in the library catalog...`);
      return await enqueueCatalogWrite(() => api("/api/resources/direct-upload-complete", {
        method: "POST",
        body: {
          storageName: ticket.storageName,
          filename: uploadFilename(file),
          originalFilename: uploadFilename(file),
          contentType: file.type || mimeForFilename(uploadFilename(file)),
          size: file.size,
          hash,
          autoCategorize: options.autoCategorize,
          targetCategoryId: options.targetCategoryId
        },
        signal,
        headers: uploadAuthHeaders()
      }));
    }
  } catch (error) {
    if (error.name === "AbortError") throw error;
    if (file.size > DIRECT_FILE_UPLOAD_LIMIT) {
      onProgress(`AWS direct upload failed for ${uploadFilename(file)}. Using safe chunked fallback...`);
      return await uploadChunkedFile(file, fileIndex, totalFiles, options, onProgress, signal);
    }
    onProgress(`Fast AWS upload unavailable for ${uploadFilename(file)}. Using standard upload...`);
  }
  const form = new FormData();
  form.append("autoCategorize", String(options.autoCategorize));
  form.append("targetCategoryId", options.targetCategoryId);
  form.append("files", file, uploadFilename(file));
  onProgress(`Uploading ${uploadFilename(file)} in fast mode...`);
  return await requestWithUploadProgress("/api/resources/upload", {
    method: "POST",
    body: form,
    signal,
    headers: uploadAuthHeaders(),
    onUploadProgress: (fraction) => setUploadFileProgress(fileIndex, totalFiles, fraction, `Uploading ${uploadFilename(file)}: ${Math.round(fraction * 100)}%`)
  });
}

async function uploadChunkedFile(file, fileIndex, totalFiles, options, onProgress, signal) {
  if (!isZipFile(file)) onProgress(`Sending ${uploadFilename(file)} in safe chunks...`);
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
  if (!incoming.length) return [];
  const existing = new Set(state.pendingUploadFiles.map(uploadFileKey));
  const added = [];
  for (const file of incoming) {
    if (!isUploadableLibraryFile(file)) continue;
    const key = uploadFileKey(file);
    if (existing.has(key)) continue;
    existing.add(key);
    added.push(file);
  }
  state.pendingUploadFiles.push(...added);
  return added;
}

async function uploadZipFile(file, fileIndex, totalFiles, options, onProgress, onEntrySaved, signal, seenHashes, knownHashes, depth = 0) {
  const totals = { resources: [], skipped: [], failed: [] };
  const zipName = uploadFilename(file);
  if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
  if (depth > 5) {
    const failed = { filename: zipName, reason: "Nested ZIP is too deep. Please unzip this folder and upload again." };
    totals.failed.push(failed);
    onEntrySaved?.({ resources: [], skipped: [], failed: [failed], progressLabel: `ZIP ${zipName}: nested ZIP limit reached.`, progressCompleted: 1, progressTotal: 1 }, fileIndex + 1, totalFiles);
    return totals;
  }
  onProgress(`Opening ZIP ${zipName} in the browser...`);
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const supportedEntries = entries.filter((entry) => isSupportedLibraryFile(entry.name) || isZipFilename(entry.name));
  const unsupportedEntries = entries.filter((entry) => !isSupportedLibraryFile(entry.name) && !isZipFilename(entry.name));
  const nestedZipCount = supportedEntries.filter((entry) => isZipFilename(entry.name)).length;
  const bookCount = supportedEntries.length - nestedZipCount;
  onProgress(`ZIP ${zipName}: found ${bookCount} PDF/EPUB book file(s) and ${nestedZipCount} nested ZIP file(s) inside ${entries.length} file(s).`);
  if (unsupportedEntries.length) {
    onProgress(`ZIP ${zipName}: ignoring ${unsupportedEntries.length} non-book file(s). Only PDFs, EPUBs, and ZIPs will be checked.`);
  }
  if (!supportedEntries.length) {
    const failed = { filename: zipName, reason: "No supported PDF or EPUB files were found inside this ZIP." };
    totals.failed.push(failed);
    onEntrySaved?.({ resources: [], skipped: [], failed: [failed], progressLabel: `ZIP ${zipName}: no supported files found.`, progressCompleted: 1, progressTotal: 1 }, fileIndex + 1, totalFiles);
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
      extracted.libraryPath = joinLibraryPath(zipName, entry.name);
      if (isZipFilename(entry.name)) {
        onProgress(`Opening nested ZIP ${extracted.libraryPath}...`);
        const nestedData = await uploadZipFile(extracted, entryIndex, supportedEntries.length, options, onProgress, onEntrySaved, signal, seenHashes, knownHashes, depth + 1);
        totals.resources.push(...(Array.isArray(nestedData.resources) ? nestedData.resources : []));
        totals.skipped.push(...(Array.isArray(nestedData.skipped) ? nestedData.skipped : []));
        totals.failed.push(...(Array.isArray(nestedData.failed) ? nestedData.failed : []));
        onEntrySaved?.({ resources: [], skipped: [], failed: [], progressLabel: `ZIP ${zipName}: ${entryIndex + 1} of ${supportedEntries.length} files checked.`, progressCompleted: entryIndex + 1, progressTotal: supportedEntries.length }, fileIndex + 1, totalFiles);
        continue;
      }
      const duplicate = await duplicateSkipForFile(extracted, seenHashes, knownHashes);
      if (duplicate.skipped) {
        totals.skipped.push(duplicate.skipped);
        await removeUploadQueueFile(extracted);
        onEntrySaved?.({ resources: [], skipped: [duplicate.skipped], failed: [], progressLabel: `ZIP ${zipName}: ${entryIndex + 1} of ${supportedEntries.length} files checked.`, progressCompleted: entryIndex + 1, progressTotal: supportedEntries.length }, fileIndex + 1, totalFiles);
        continue;
      }
      onProgress(`Uploading ${entry.name} from ZIP directly to AWS...`);
      const data = await uploadDirectFile(extracted, entryIndex, supportedEntries.length, options, onProgress, signal);
      const addedResources = Array.isArray(data.resources) ? data.resources : [];
      const skipped = Array.isArray(data.skipped) ? data.skipped : [];
      const failed = Array.isArray(data.failed) ? data.failed : [];
      totals.resources.push(...addedResources);
      totals.skipped.push(...skipped);
      totals.failed.push(...failed);
      onEntrySaved?.({ ...data, progressLabel: `ZIP ${zipName}: ${entryIndex + 1} of ${supportedEntries.length} files checked.`, progressCompleted: entryIndex + 1, progressTotal: supportedEntries.length }, fileIndex + 1, totalFiles);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (isAuthError(error)) throw error;
      const failed = { filename: entry.name, reason: error.message };
      totals.failed.push(failed);
      onEntrySaved?.({ resources: [], skipped: [], failed: [failed], progressLabel: `ZIP ${zipName}: ${entryIndex + 1} of ${supportedEntries.length} files checked.`, progressCompleted: entryIndex + 1, progressTotal: supportedEntries.length }, fileIndex + 1, totalFiles);
    }
  }
  return totals;
}

async function uploadChunked(files, options, onProgress, onFileSaved, signal, onTopFileDone, knownHashes = new Set()) {
  const totals = { resources: [], skipped: [], failed: [] };
  const seenHashes = new Set();
  let nextIndex = 0;
  let completedCount = 0;
  const markCompleted = async (file, fileIndex) => {
    completedCount += 1;
    setUploadFileProgress(fileIndex, files.length, 1);
    await onTopFileDone?.(file);
  };
  const processFile = async (fileIndex) => {
    if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
    const currentFile = files[fileIndex];
    try {
      if (isZipFile(currentFile)) {
        const zipData = await uploadZipFile(currentFile, fileIndex, files.length, options, onProgress, onFileSaved, signal, seenHashes, knownHashes);
        totals.resources.push(...(Array.isArray(zipData.resources) ? zipData.resources : []));
        totals.skipped.push(...(Array.isArray(zipData.skipped) ? zipData.skipped : []));
        totals.failed.push(...(Array.isArray(zipData.failed) ? zipData.failed : []));
        await markCompleted(currentFile, fileIndex);
        return;
      }
      if (!isSupportedLibraryFile(uploadFilename(currentFile))) {
        const skipped = { filename: uploadFilename(currentFile), reason: "Only PDF and EPUB files are uploaded." };
        totals.skipped.push(skipped);
        onFileSaved?.({ resources: [], skipped: [skipped], failed: [], progressCompleted: completedCount + 1, progressTotal: files.length }, completedCount + 1, files.length);
        await markCompleted(currentFile, fileIndex);
        return;
      }
      const duplicate = await duplicateSkipForFile(currentFile, seenHashes, knownHashes);
      if (duplicate.skipped) {
        totals.skipped.push(duplicate.skipped);
        onFileSaved?.({ resources: [], skipped: [duplicate.skipped], failed: [], progressCompleted: completedCount + 1, progressTotal: files.length }, completedCount + 1, files.length);
        await markCompleted(currentFile, fileIndex);
        return;
      }
      const data = await uploadDirectFile(currentFile, fileIndex, files.length, options, onProgress, signal);
      const addedResources = Array.isArray(data.resources) ? data.resources : [];
      const skipped = Array.isArray(data.skipped) ? data.skipped : [];
      const failed = Array.isArray(data.failed) ? data.failed : [];
      totals.resources.push(...addedResources);
      totals.skipped.push(...skipped);
      totals.failed.push(...failed);
      onFileSaved?.({ ...data, progressCompleted: completedCount + 1, progressTotal: files.length }, completedCount + 1, files.length);
      await markCompleted(currentFile, fileIndex);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (isAuthError(error)) throw error;
      const filename = uploadFilename(currentFile);
      totals.failed.push({ filename, reason: error.message });
      onFileSaved?.({ resources: [], skipped: [], failed: [{ filename, reason: error.message }], progressCompleted: completedCount + 1, progressTotal: files.length }, completedCount + 1, files.length);
      await markCompleted(currentFile, fileIndex);
    }
  };
  const worker = async () => {
    while (nextIndex < files.length) {
      if (signal?.aborted) throw new DOMException("Upload stopped.", "AbortError");
      const fileIndex = nextIndex;
      nextIndex += 1;
      await processFile(fileIndex);
    }
  };
  const concurrency = Math.min(DIRECT_UPLOAD_CONCURRENCY, Math.max(1, files.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
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

async function loadResourceHashes() {
  const data = await api("/api/resource-hashes");
  state.resourceHashes = new Set(Array.isArray(data.hashes) ? data.hashes.filter(Boolean) : []);
  return state.resourceHashes;
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

function setUploadProgress(completed = 0, total = 0, label = "") {
  const safeTotal = Math.max(0, Number(total || 0));
  const safeCompleted = Math.max(0, Math.min(safeTotal, Number(completed || 0)));
  state.uploadActivity.progressCompleted = safeCompleted;
  state.uploadActivity.progressTotal = safeTotal;
  const wrap = document.querySelector("#uploadProgressWrap");
  const bar = document.querySelector("#uploadProgressBar");
  const text = document.querySelector("#uploadProgressText");
  if (!wrap || !bar || !text) return;
  if (!safeTotal) {
    wrap.hidden = true;
    bar.value = 0;
    text.textContent = "";
    return;
  }
  const percent = Math.round((safeCompleted / safeTotal) * 100);
  wrap.hidden = false;
  bar.value = percent;
  const completedText = Number.isInteger(safeCompleted) ? String(safeCompleted) : safeCompleted.toFixed(1);
  text.textContent = label || `${percent}% complete (${completedText} of ${safeTotal} books checked)`;
}

function setUploadFileProgress(fileIndex, totalFiles, fraction, label = "") {
  const total = Math.max(1, Number(totalFiles || 1));
  if (!Array.isArray(state.uploadActivity.fileProgress) || state.uploadActivity.fileProgress.length !== total) {
    state.uploadActivity.fileProgress = Array(total).fill(0);
  }
  const current = Number(state.uploadActivity.fileProgress[fileIndex] || 0);
  state.uploadActivity.fileProgress[fileIndex] = Math.max(current, Math.max(0, Math.min(1, Number(fraction || 0))));
  const completed = state.uploadActivity.fileProgress.reduce((sum, value) => sum + Number(value || 0), 0);
  setUploadProgress(completed, total, label);
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
  const summary = await api("/api/resources-summary").catch((error) => {
    state.adminSummaryError = error.message || "Book summary is temporarily unavailable.";
    return { recentResources: state.resources || [], counts: state.resourceCounts || { total: 0, byCategory: {} } };
  });
  state.resources = Array.isArray(summary.recentResources) ? summary.recentResources : [];
  state.resourceCounts = summary.counts || { total: 0, byCategory: {} };
}

async function loadStorageUsage() {
  state.storageUsage = await api("/api/storage-usage").catch((error) => {
    state.storageUsageError = error.message || "Storage summary is temporarily unavailable.";
    return state.storageUsage || {};
  });
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
      <button class="secondary active" id="pdfPageMode">Page</button>
      <button class="secondary" id="pdfScrollMode">Scroll</button>
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
        <div class="pdf-stage" id="pdfPageStage">
          <canvas id="pdfCanvas" aria-label="PDF page"></canvas>
        </div>
        <div class="pdf-scroll-stage" id="pdfScrollStage" hidden></div>
      </section>
    `;
  }
  return `<iframe src="/protected-file/${resource.id}" title="${escapeHtml(resource.title)}"></iframe>`;
}

async function setupPdfViewer(resourceId) {
  const status = document.querySelector("#pdfPageStatus");
  const canvas = document.querySelector("#pdfCanvas");
  const pageStage = document.querySelector("#pdfPageStage");
  const scrollStage = document.querySelector("#pdfScrollStage");
  const context = canvas.getContext("2d");
    const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
  const response = await fetch(`/protected-file/${resourceId}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to open this PDF.");
  const pdf = await pdfjs.getDocument({ data: await response.arrayBuffer() }).promise;
  let pageNumber = 1;
  let zoom = 1;
  let mode = "page";
  let rendering = false;
  let scrollRendered = false;
  let scrollRenderToken = 0;

  const scaleFor = (page, container) => {
    const available = Math.max(280, (container?.clientWidth || window.innerWidth) - 24);
    const natural = page.getViewport({ scale: 1 });
    const fit = Math.max(0.55, Math.min(2.2, available / natural.width));
    return fit * zoom;
  };

  const renderCanvas = async (page, targetCanvas, container) => {
    const viewport = page.getViewport({ scale: scaleFor(page, container) });
    const ratio = window.devicePixelRatio || 1;
    const targetContext = targetCanvas.getContext("2d");
    targetCanvas.width = Math.floor(viewport.width * ratio);
    targetCanvas.height = Math.floor(viewport.height * ratio);
    targetCanvas.style.width = `${Math.floor(viewport.width)}px`;
    targetCanvas.style.height = `${Math.floor(viewport.height)}px`;
    await page.render({
      canvasContext: targetContext,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null
    }).promise;
  };

  const renderPage = async () => {
    if (rendering) return;
    rendering = true;
    status.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
    const page = await pdf.getPage(pageNumber);
    await renderCanvas(page, canvas, pageStage);
    document.querySelector("#pdfPrev").disabled = pageNumber <= 1;
    document.querySelector("#pdfNext").disabled = pageNumber >= pdf.numPages;
    rendering = false;
  };

  const updateModeButtons = () => {
    document.querySelector("#pdfPageMode").classList.toggle("active", mode === "page");
    document.querySelector("#pdfScrollMode").classList.toggle("active", mode === "scroll");
    pageStage.hidden = mode !== "page";
    scrollStage.hidden = mode !== "scroll";
  };

  const renderScroll = async (force = false) => {
    if (scrollRendered && !force) return;
    const token = ++scrollRenderToken;
    scrollRendered = true;
    scrollStage.innerHTML = "";
    for (let index = 1; index <= pdf.numPages; index++) {
      if (token !== scrollRenderToken) return;
      status.textContent = `Rendering page ${index} of ${pdf.numPages}`;
      const pageWrap = document.createElement("div");
      pageWrap.className = "pdf-scroll-page";
      pageWrap.dataset.page = String(index);
      const pageCanvas = document.createElement("canvas");
      pageCanvas.setAttribute("aria-label", `PDF page ${index}`);
      pageWrap.appendChild(pageCanvas);
      scrollStage.appendChild(pageWrap);
      const page = await pdf.getPage(index);
      await renderCanvas(page, pageCanvas, scrollStage);
    }
    status.textContent = `Scroll mode: ${pdf.numPages} pages`;
  };

  const setMode = async (nextMode) => {
    mode = nextMode;
    updateModeButtons();
    if (mode === "scroll") await renderScroll();
    else await renderPage();
  };

  const scrollToPage = (nextPage) => {
    pageNumber = Math.max(1, Math.min(pdf.numPages, nextPage));
    const target = scrollStage.querySelector(`[data-page="${pageNumber}"]`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    status.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
    document.querySelector("#pdfPrev").disabled = pageNumber <= 1;
    document.querySelector("#pdfNext").disabled = pageNumber >= pdf.numPages;
  };

  document.querySelector("#pdfPrev").addEventListener("click", async () => {
    if (pageNumber > 1) {
      pageNumber--;
      if (mode === "scroll") scrollToPage(pageNumber);
      else await renderPage();
    }
  });
  document.querySelector("#pdfNext").addEventListener("click", async () => {
    if (pageNumber < pdf.numPages) {
      pageNumber++;
      if (mode === "scroll") scrollToPage(pageNumber);
      else await renderPage();
    }
  });
  document.querySelector("#pdfZoomOut").addEventListener("click", async () => {
    zoom = Math.max(0.65, zoom - 0.15);
    if (mode === "scroll") await renderScroll(true);
    else await renderPage();
  });
  document.querySelector("#pdfZoomIn").addEventListener("click", async () => {
    zoom = Math.min(2.4, zoom + 0.15);
    if (mode === "scroll") await renderScroll(true);
    else await renderPage();
  });
  document.querySelector("#pdfPageMode").addEventListener("click", () => setMode("page"));
  document.querySelector("#pdfScrollMode").addEventListener("click", () => setMode("scroll"));
  scrollStage.addEventListener("scroll", () => {
    if (mode !== "scroll") return;
    const pages = Array.from(scrollStage.querySelectorAll(".pdf-scroll-page"));
    const current = pages.find((page) => page.getBoundingClientRect().bottom > 120);
    if (current?.dataset.page) pageNumber = Number(current.dataset.page);
    status.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
    document.querySelector("#pdfPrev").disabled = pageNumber <= 1;
    document.querySelector("#pdfNext").disabled = pageNumber >= pdf.numPages;
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  scrollStage.addEventListener("contextmenu", (event) => event.preventDefault());
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
  state.adminSummaryError = "";
  state.storageUsageError = "";
  const [reports] = await Promise.all([
    api("/api/reports").catch((error) => {
      state.adminSummaryError = error.message || "Student reports are temporarily unavailable.";
      return state.reports || { users: [], reads: [], logins: [], resources: [] };
    }),
    loadCategories().catch((error) => {
      state.adminSummaryError = error.message || "Categories are temporarily unavailable.";
    }),
    loadAdminSummary(),
    loadStorageUsage()
  ]);
  state.reports = reports || { users: [], reads: [], logins: [], resources: [] };
  layout(`
    <main class="page">
      <h1>Admin Dashboard</h1>
      <p class="subtle">Upload resources, manage library files, manage categories, and review student history.</p>
      ${state.adminSummaryError || state.storageUsageError ? `<div class="notice">Some dashboard summaries are temporarily slow. Login is working; try the summary again after a minute.</div>` : ""}
      <section class="admin-panels">
        <div class="panel">
          <h2>Upload books</h2>
          <form class="form" id="uploadForm">
            <label>Choose files <input type="file" id="resourceFiles" name="files" accept=".pdf,.epub,.zip" multiple></label>
            <label>Choose folder <input type="file" id="resourceFolder" name="folder" webkitdirectory directory multiple></label>
            <button type="button" class="secondary" id="openFolderTree">Open folder tree</button>
            <div class="folder-drop" id="folderDropZone" role="button" tabindex="0">
              <strong>Drop folders, subfolders, ZIPs, PDFs, or EPUBs here</strong>
              <span>The app will scan every subfolder it receives.</span>
            </div>
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
            <div class="upload-progress" id="uploadProgressWrap" hidden>
              <progress id="uploadProgressBar" value="0" max="100"></progress>
              <span id="uploadProgressText"></span>
            </div>
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

function formatUsd(value) {
  const number = Number(value || 0);
  return `$${number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function storageUsageSummary() {
  const usage = state.storageUsage || {};
  const budgetGb = Number(usage.budgetGb || 0);
  const usedGb = Number(usage.usedGb || 0);
  const bookGb = Number(usage.bookGb || 0);
  const remainingGb = usage.remainingGb === null || usage.remainingGb === undefined ? null : Number(usage.remainingGb || 0);
  const usagePercent = usage.usagePercent === null || usage.usagePercent === undefined ? 0 : Math.max(0, Math.min(100, Number(usage.usagePercent || 0)));
  const planMonths = Number(usage.planMonths || 12);
  const remaining = remainingGb === null ? "Set budget" : formatGb(remainingGb);
  const runway = usage.runwayMonths === null || usage.runwayMonths === undefined
    ? `${planMonths}+ months`
    : `${Math.max(1, Math.floor(Number(usage.runwayMonths || 0))).toLocaleString()} months`;
  const status = budgetGb && usedGb <= budgetGb ? `On track for ${planMonths} months` : "Over planned storage budget";
  return `
    <section class="storage-panel">
      <div class="storage-panel-head">
        <div>
          <h3>12-month AWS storage runway</h3>
          <p class="subtle">Based on the configured AWS credit/storage plan. This refreshes after uploads and whenever this dashboard opens.</p>
        </div>
        <button class="secondary" type="button" id="refreshStorageUsage">Refresh</button>
      </div>
      <div class="storage-meter" aria-label="Storage used">
        <span style="width: ${usagePercent.toFixed(2)}%"></span>
      </div>
      <p class="storage-meter-label">${usagePercent.toFixed(2)}% used of the 12-month plan</p>
    </section>
    <section class="stats-grid storage-grid">
      <article class="stat-card stat-total">
        <span>Total usable for ${planMonths} months</span>
        <strong>${formatGb(budgetGb)}</strong>
      </article>
      <article class="stat-card stat-total">
        <span>Storage left</span>
        <strong>${remaining}</strong>
      </article>
      <article class="stat-card">
        <span>Used now</span>
        <strong>${formatGb(usedGb)}</strong>
      </article>
      <article class="stat-card">
        <span>Books stored</span>
        <strong>${formatGb(bookGb)}</strong>
      </article>
      <article class="stat-card">
        <span>Current monthly storage cost</span>
        <strong>${usage.monthlyStorageCostUsd === null || usage.monthlyStorageCostUsd === undefined ? "-" : formatUsd(usage.monthlyStorageCostUsd)}</strong>
      </article>
      <article class="stat-card">
        <span>12-month cost at current use</span>
        <strong>${usage.twelveMonthStorageCostUsd === null || usage.twelveMonthStorageCostUsd === undefined ? "-" : formatUsd(usage.twelveMonthStorageCostUsd)}</strong>
      </article>
      <article class="stat-card">
        <span>Credit remaining at current use</span>
        <strong>${usage.remainingCreditUsd === null || usage.remainingCreditUsd === undefined ? "-" : formatUsd(usage.remainingCreditUsd)}</strong>
      </article>
      <article class="stat-card">
        <span>Status</span>
        <strong>${status}</strong>
      </article>
    </section>
    <p class="subtle">Credit model: ${formatUsd(usage.creditUsd)} over ${planMonths} months at about ${formatUsd(usage.storageUsdPerGbMonth)} per GB-month. Estimated credit-only capacity: ${formatGb(usage.creditCapacityGb)}. Active dashboard cap: ${formatGb(budgetGb)}. Updated ${usage.updatedAt ? new Date(usage.updatedAt).toLocaleString() : "now"}.</p>
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
  const openFolderTreeButton = document.querySelector("#openFolderTree");
  const folderDropZone = document.querySelector("#folderDropZone");
  const refreshStorageButton = document.querySelector("#refreshStorageUsage");
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
  refreshStorageButton?.addEventListener("click", async () => {
    refreshStorageButton.disabled = true;
    refreshStorageButton.textContent = "Refreshing...";
    try {
      await refreshStorageUsage();
    } finally {
      const nextButton = document.querySelector("#refreshStorageUsage");
      if (nextButton) {
        nextButton.disabled = false;
        nextButton.textContent = "Refresh";
      }
    }
  });
  const selectedUploadFiles = () => state.pendingUploadFiles;
  const updateUploadSelection = () => {
    const files = selectedUploadFiles();
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    const hasZip = files.some(isZipFile);
    const mb = (totalSize / 1024 / 1024).toFixed(2);
    const summary = uploadSelectionSummary(files);
    uploadSelection.textContent = files.length
      ? `${summary.supported.length} uploadable book file(s) selected, ${mb} MB total. ${summary.folderCount ? `${summary.folderCount} folder path(s) detected.` : ""}`
      : "No files selected.";
    const message = hasZip
      ? "ZIP mode: the app will open the ZIP folder and upload each PDF/EPUB inside as a separate library book. JPG/image files will be ignored."
      : totalSize > 4 * 1024 * 1024
        ? "Safe upload mode will send each file carefully, then place the finished files into the library."
        : "";
    uploadStatus.textContent = message;
    clearUploadButton.disabled = !files.length || Boolean(uploadController);
  };
  (async () => {
    const rememberedFiles = await loadUploadQueueFiles();
    const added = addPendingUploadFiles(rememberedFiles);
    if (!added.length) return;
    const rememberedState = readRememberedUploadState();
    if (rememberedState.options) {
      document.querySelector("#autoCategorize").value = String(rememberedState.options.autoCategorize !== false);
      if (rememberedState.options.targetCategoryId) document.querySelector("#targetCategoryId").value = rememberedState.options.targetCategoryId;
    }
    updateUploadSelection();
    addUploadLog(`Restored ${added.length} file(s) from the saved upload queue.`);
    if (rememberedState.running) {
      setUploadActivityStatus("Continuing the upload queue after refresh...");
      setTimeout(() => document.querySelector("#uploadForm")?.requestSubmit(), 400);
    }
  })();
  resourceInput.addEventListener("change", () => {
    const summary = uploadSelectionSummary(resourceInput.files);
    const added = addPendingUploadFiles(resourceInput.files);
    resourceInput.value = "";
    updateUploadSelection();
    if (added.length) {
      addUploadLog(`Added ${added.length} selected file(s) to the upload queue.`);
      addUploadLog(`Selection scan found ${summary.pdfCount} PDF, ${summary.epubCount} EPUB, and ${summary.zipCount} ZIP file(s).`);
      if (summary.unsupported) addUploadLog(`Ignored ${summary.unsupported} non-book file(s). Only PDF, EPUB, and ZIP are accepted.`);
      saveUploadQueueFiles(added).catch(() => addUploadLog("The selected upload queue could not be remembered after refresh."));
    } else if (summary.total) {
      addUploadLog("No PDF, EPUB, or ZIP files were found in that selection.");
    }
  });
  folderInput.addEventListener("change", () => {
    const summary = uploadSelectionSummary(folderInput.files);
    const firstFile = Array.from(folderInput.files || [])[0];
    const hasFolderPaths = Boolean(firstFile?.webkitRelativePath);
    const added = addPendingUploadFiles(folderInput.files);
    folderInput.value = "";
    updateUploadSelection();
    if (summary.total && !hasFolderPaths) {
      addUploadLog("This browser did not send subfolder paths. Use Chrome/Edge folder upload or upload a ZIP to include every subfolder.");
    }
    if (added.length) {
      addUploadLog(`Added ${added.length} book file(s) from folder selection to the upload queue.`);
      addUploadLog(`Folder scan found ${summary.supported.length} uploadable book file(s) inside ${summary.folderCount || 1} folder path(s). ${summary.nestedFiles ? `${summary.nestedFiles} file(s) were inside subfolders.` : "No subfolder files were detected."}`);
      addUploadLog(`Folder scan includes ${summary.pdfCount} PDF, ${summary.epubCount} EPUB, and ${summary.zipCount} ZIP file(s). ZIP files will be opened and checked for more books.`);
      if (summary.unsupported) addUploadLog(`Ignored ${summary.unsupported} non-book file(s). Only PDF, EPUB, and ZIP are accepted.`);
      saveUploadQueueFiles(added).catch(() => addUploadLog("The selected upload queue could not be remembered after refresh."));
    } else if (summary.total) {
      addUploadLog("No PDF, EPUB, or ZIP files were found in that folder selection.");
    } else {
      addUploadLog("No files were received from the folder picker. Use Open folder tree, drag the folder into the drop box, or upload a ZIP.");
    }
  });
  openFolderTreeButton?.addEventListener("click", async () => {
    if (!window.showDirectoryPicker) {
      setUploadActivityStatus("This browser cannot open a folder tree directly. Use Chrome/Edge, drag the folder into the drop box, or upload a ZIP.");
      addUploadLog("Open folder tree is not supported in this browser.");
      return;
    }
    try {
      setUploadActivityStatus("Opening folder tree...");
      const handle = await window.showDirectoryPicker({ mode: "read" });
      setUploadActivityStatus("Scanning every subfolder...");
      const files = await walkDirectoryHandle(handle, handle.name);
      const summary = uploadSelectionSummary(files);
      const added = addPendingUploadFiles(files);
      updateUploadSelection();
      if (added.length) {
        addUploadLog(`Added ${added.length} book file(s) from the folder tree.`);
        addUploadLog(`Folder tree scan found ${summary.pdfCount} PDF, ${summary.epubCount} EPUB, and ${summary.zipCount} ZIP file(s) inside ${summary.folderCount || 1} folder path(s). ${summary.nestedFiles ? `${summary.nestedFiles} file(s) were inside subfolders.` : "No subfolder files were detected."}`);
        if (summary.unsupported) addUploadLog(`Ignored ${summary.unsupported} non-book file(s). Only PDF, EPUB, and ZIP are accepted.`);
        await saveUploadQueueFiles(added).catch(() => addUploadLog("The selected upload queue could not be remembered after refresh."));
        setUploadActivityStatus("Folder tree scan complete. Ready to upload.");
      } else {
        setUploadActivityStatus("No PDF, EPUB, or ZIP files were found in that folder tree.");
        addUploadLog("No PDF, EPUB, or ZIP files were found in that folder tree.");
      }
    } catch (error) {
      if (error.name === "AbortError") {
        setUploadActivityStatus("Folder selection cancelled.");
        return;
      }
      setUploadActivityStatus("Folder tree could not be scanned. Try dragging the folder or upload a ZIP.");
      addUploadLog(`Folder tree scan failed: ${error.message}`);
    }
  });
  if (folderDropZone) {
    for (const eventName of ["dragenter", "dragover"]) {
      folderDropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        folderDropZone.classList.add("active");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      folderDropZone.addEventListener(eventName, () => folderDropZone.classList.remove("active"));
    }
    folderDropZone.addEventListener("drop", async (event) => {
      event.preventDefault();
      setUploadActivityStatus("Scanning dropped folders and subfolders...");
      try {
        const droppedFiles = await filesFromDrop(event);
        const summary = uploadSelectionSummary(droppedFiles);
        const added = addPendingUploadFiles(droppedFiles);
        updateUploadSelection();
        if (added.length) {
          addUploadLog(`Added ${added.length} book file(s) from dropped folder/file selection.`);
          addUploadLog(`Dropped scan found ${summary.pdfCount} PDF, ${summary.epubCount} EPUB, and ${summary.zipCount} ZIP file(s) inside ${summary.folderCount || 1} folder path(s). ${summary.nestedFiles ? `${summary.nestedFiles} file(s) were inside subfolders.` : "No subfolder files were detected."}`);
          if (summary.unsupported) addUploadLog(`Ignored ${summary.unsupported} non-book file(s). Only PDF, EPUB, and ZIP are accepted.`);
          saveUploadQueueFiles(added).catch(() => addUploadLog("The dropped upload queue could not be remembered after refresh."));
          setUploadActivityStatus("Folder scan complete. Ready to upload.");
        } else {
          setUploadActivityStatus("No PDF, EPUB, or ZIP files were found in the dropped folder.");
          addUploadLog("No PDF, EPUB, or ZIP files were found in the dropped folder.");
        }
      } catch (error) {
        setUploadActivityStatus("This browser could not scan the dropped folder. Please use Chrome/Edge or upload a ZIP.");
        addUploadLog(`Folder drop failed: ${error.message}`);
      }
    });
  }
  clearUploadButton.addEventListener("click", async () => {
    if (uploadController) return;
    state.pendingUploadFiles = [];
    await clearUploadQueueFiles();
    clearRememberedUploadState();
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
    clearRememberedUploadState();
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
    const markUploadFileFinished = async (file) => {
      const key = uploadFileKey(file);
      state.pendingUploadFiles = state.pendingUploadFiles.filter((item) => uploadFileKey(item) !== key);
      await removeUploadQueueFile(file);
      updateUploadSelection();
    };
    try {
      rememberUploadState(options, true);
      uploadController = new AbortController();
      const uploadSession = await api("/api/resources/upload-token", { method: "POST" });
      state.activeUpload = { controller: uploadController, token: uploadSession.uploadToken };
      state.uploadActivity = { running: true, status: "Uploading...", logs: [], skippedDetails: [], added: 0, skipped: 0, failed: 0, progressCompleted: 0, progressTotal: files.length };
      uploadButton.disabled = true;
      clearUploadButton.disabled = true;
      stopUploadButton.disabled = false;
      uploadLog.innerHTML = "";
      setUploadProgress(0, files.length);
      setUploadActivityStatus("Checking duplicates before upload...");
      const knownHashes = await loadResourceHashes().catch(() => state.resourceHashes || new Set());
      addUploadLog(`Duplicate check loaded. Uploading directly to AWS with up to ${DIRECT_UPLOAD_CONCURRENCY} files at a time.`);
      let data;
      const streamingUpload = true;
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
          setUploadProgress(partial.progressCompleted || completed, partial.progressTotal || total);
          state.uploadActivity.added += addedResources.length;
          state.uploadActivity.skipped += skipped.length;
          state.uploadActivity.failed += failed.length;
          setUploadActivityStatus(`${progressLabel} ${addedResources.length} added in this step, ${skipped.length} skipped, ${failed.length} failed.`);
          state.resources = [...(Array.isArray(state.resources) ? state.resources : []), ...addedResources];
          if (addedResources.length) {
            state.resourceCounts.total = Number(state.resourceCounts.total || 0) + addedResources.length;
            for (const resource of addedResources) {
              if (resource.metadata?.hash) knownHashes.add(resource.metadata.hash);
              state.resourceCounts.byCategory[resource.categoryId || ""] = Number(state.resourceCounts.byCategory[resource.categoryId || ""] || 0) + 1;
            }
            refreshStorageUsage().catch(() => {});
          }
          refreshResourceReviewTable();
          wireResourceActions();
        }, uploadController.signal, markUploadFileFinished, knownHashes);
      } else {
        const uploadFiles = [];
        const clientSkipped = [];
        const seenHashes = new Set();
        for (const file of files) {
          const duplicate = await duplicateSkipForFile(file, seenHashes, knownHashes);
          if (duplicate.skipped) {
            clientSkipped.push(duplicate.skipped);
            await markUploadFileFinished(file);
            setUploadProgress(clientSkipped.length, files.length);
          } else {
            uploadFiles.push(file);
          }
        }
        if (!uploadFiles.length) {
          data = { resources: [], skipped: clientSkipped, failed: [] };
        } else {
        const form = new FormData();
        form.append("autoCategorize", String(options.autoCategorize));
        form.append("targetCategoryId", options.targetCategoryId);
        for (const file of uploadFiles) {
          form.append("files", file, uploadFilename(file));
        }
        uploadFiles.forEach((file) => addUploadLog(`Uploading ${uploadFilename(file)}`));
        data = await api("/api/resources/upload", { method: "POST", body: form, signal: uploadController.signal, headers: uploadAuthHeaders() });
        data.skipped = [...clientSkipped, ...(Array.isArray(data.skipped) ? data.skipped : [])];
        }
        setUploadProgress(files.length, files.length);
        await clearUploadQueueFiles();
      }
      const skippedCount = data.skipped?.length || 0;
      const failedCount = data.failed?.length || 0;
      const addedResources = Array.isArray(data.resources) ? data.resources : [];
      if (!streamingUpload) {
        state.uploadActivity.added += addedResources.length;
        state.uploadActivity.skipped += skippedCount;
        state.uploadActivity.failed += failedCount;
        addedResources.forEach((resource) => resource.metadata?.hash && knownHashes.add(resource.metadata.hash));
      }
      const completionMessage = `Upload completed. Added: ${addedResources.length}. Skipped: ${skippedCount}. Failed: ${failedCount}.`;
      setUploadProgress(state.uploadActivity.progressTotal || files.length, state.uploadActivity.progressTotal || files.length);
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
      await clearUploadQueueFiles();
      clearRememberedUploadState();
      updateUploadSelection();
      setUploadProgress(state.uploadActivity.progressTotal || files.length, state.uploadActivity.progressTotal || files.length);
      window.alert(`${completionMessage}\n\nYou can now upload a new file or folder.`);
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
