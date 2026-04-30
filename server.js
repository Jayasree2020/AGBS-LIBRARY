import http from "node:http";
import https from "node:https";
import { promises as fs } from "node:fs";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (existsSync(path.join(__dirname, ".env"))) {
  const envText = await fs.readFile(path.join(__dirname, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
}

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || "local-dev-change-me";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "agbsindia2020@gmail.com").toLowerCase();
const ADMIN_BOOTSTRAP_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD || "";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${BASE_URL}/auth/google/callback`;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";
const R2_PREFIX = (process.env.R2_PREFIX || "agbs-library").replace(/^\/+|\/+$/g, "");
const RUNTIME_DIR = process.env.VERCEL ? path.join(os.tmpdir(), "agbs-library") : __dirname;
const DATA_DIR = path.join(RUNTIME_DIR, "data");
const STORAGE_DIR = path.join(RUNTIME_DIR, "storage");
const PUBLIC_DIR = path.join(__dirname, "public");

const defaultCategories = [
  "Old Testament",
  "New Testament",
  "Christian Theology",
  "History of Christianity",
  "Christian Ministry",
  "Missiology",
  "Communication",
  "Christian Ethics",
  "Religions",
  "Social Analysis",
  "Women Studies"
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml"
};

const allowedResourceExtensions = [".pdf", ".epub", ".png", ".jpg", ".jpeg", ".webp", ".gif"];
const CHUNK_DIR = path.join(STORAGE_DIR, "chunks");
const INLINE_FILE_LIMIT = 8 * 1024 * 1024;

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.collections = ["users", "categories", "resources", "uploadBatches", "loginSessions", "readingSessions", "accessEvents", "skippedUploads"];
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    for (const collection of this.collections) {
      const file = this.file(collection);
      if (!existsSync(file)) await fs.writeFile(file, "[]");
    }
  }

  file(collection) {
    return path.join(this.dir, `${collection}.json`);
  }

  async all(collection) {
    return JSON.parse(await fs.readFile(this.file(collection), "utf8"));
  }

  async write(collection, records) {
    await fs.writeFile(this.file(collection), JSON.stringify(records, null, 2));
  }

  async insert(collection, record) {
    const records = await this.all(collection);
    const now = new Date().toISOString();
    const full = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...record };
    records.push(full);
    await this.write(collection, records);
    return full;
  }

  async update(collection, id, patch) {
    const records = await this.all(collection);
    const index = records.findIndex((item) => item.id === id);
    if (index === -1) return null;
    records[index] = { ...records[index], ...patch, updatedAt: new Date().toISOString() };
    await this.write(collection, records);
    return records[index];
  }

  async delete(collection, id) {
    const records = await this.all(collection);
    const next = records.filter((item) => item.id !== id);
    await this.write(collection, next);
    return next.length !== records.length;
  }

  async findOne(collection, predicate) {
    return (await this.all(collection)).find(predicate) || null;
  }

  async filter(collection, predicate) {
    return (await this.all(collection)).filter(predicate);
  }
}

class MongoStore {
  constructor(uri, databaseName) {
    this.uri = uri;
    this.databaseName = databaseName;
  }

  async init() {
    const { MongoClient, GridFSBucket } = await import("mongodb");
    this.client = new MongoClient(this.uri);
    await this.client.connect();
    this.db = this.client.db(this.databaseName || "seminary_library");
    this.bucket = new GridFSBucket(this.db, { bucketName: "resourceFiles" });
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  }

  collection(name) {
    return this.db.collection(name);
  }

  async all(collection) {
    return await this.collection(collection).find({}).toArray();
  }

  async insert(collection, record) {
    const now = new Date().toISOString();
    const full = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...record };
    await this.collection(collection).insertOne(full);
    return full;
  }

  async update(collection, id, patch) {
    await this.collection(collection).updateOne({ id }, { $set: { ...patch, updatedAt: new Date().toISOString() } });
    return await this.findOne(collection, (item) => item.id === id);
  }

  async delete(collection, id) {
    const result = await this.collection(collection).deleteOne({ id });
    return result.deletedCount > 0;
  }

  async findOne(collection, predicate) {
    return (await this.all(collection)).find(predicate) || null;
  }

  async filter(collection, predicate) {
    return (await this.all(collection)).filter(predicate);
  }

  async saveFile(name, buffer, metadata = {}) {
    await this.deleteFile(name);
    await new Promise((resolve, reject) => {
      Readable.from([buffer])
        .pipe(this.bucket.openUploadStream(name, { metadata }))
        .on("error", reject)
        .on("finish", resolve);
    });
  }

  async deleteFile(name) {
    const files = await this.collection("resourceFiles.files").find({ filename: name }).toArray();
    await Promise.all(files.map((file) => this.bucket.delete(file._id).catch(() => {})));
  }

  async readFile(name) {
    const file = await this.collection("resourceFiles.files").findOne({ filename: name });
    if (!file) return null;
    const chunks = [];
    await new Promise((resolve, reject) => {
      this.bucket.openDownloadStreamByName(name)
        .on("data", (chunk) => chunks.push(chunk))
        .on("error", reject)
        .on("end", resolve);
    });
    return Buffer.concat(chunks);
  }
}

class R2Store {
  constructor({ accountId, accessKeyId, secretAccessKey, bucket, prefix }) {
    this.bucket = bucket;
    this.prefix = prefix;
    this.collections = ["users", "categories", "resources", "uploadBatches", "loginSessions", "readingSessions", "accessEvents", "skippedUploads"];
    this.endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    this.credentials = { accessKeyId, secretAccessKey };
  }

  async init() {
    const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    this.commands = { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand };
    this.client = new S3Client({
      region: "auto",
      endpoint: this.endpoint,
      credentials: this.credentials
    });
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    for (const collection of this.collections) {
      const key = this.collectionKey(collection);
      const exists = await this.exists(key);
      if (!exists) await this.putJson(key, []);
    }
  }

  key(value) {
    return `${this.prefix}/${String(value || "").replace(/^\/+/, "")}`;
  }

  collectionKey(collection) {
    return this.key(`data/${collection}.json`);
  }

  fileKey(name) {
    return this.key(`books/${name}`);
  }

  tempChunkKey(uploadId, fileIndex, chunkIndex = "") {
    if (fileIndex === "") return this.key(`tmp/uploads/${uploadId}/`);
    const suffix = chunkIndex === "" ? "" : `${chunkIndex}.part`;
    return this.key(`tmp/uploads/${uploadId}/${fileIndex}/${suffix}`);
  }

  async exists(key) {
    try {
      await this.client.send(new this.commands.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async bodyToBuffer(body) {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async putJson(key, value) {
    await this.client.send(new this.commands.PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: "application/json; charset=utf-8"
    }));
  }

  async getJson(key) {
    const response = await this.client.send(new this.commands.GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return JSON.parse((await this.bodyToBuffer(response.Body)).toString("utf8"));
  }

  async all(collection) {
    return await this.getJson(this.collectionKey(collection));
  }

  async write(collection, records) {
    await this.putJson(this.collectionKey(collection), records);
  }

  async insert(collection, record) {
    const records = await this.all(collection);
    const now = new Date().toISOString();
    const full = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...record };
    records.push(full);
    await this.write(collection, records);
    return full;
  }

  async update(collection, id, patch) {
    const records = await this.all(collection);
    const index = records.findIndex((item) => item.id === id);
    if (index === -1) return null;
    records[index] = { ...records[index], ...patch, updatedAt: new Date().toISOString() };
    await this.write(collection, records);
    return records[index];
  }

  async delete(collection, id) {
    const records = await this.all(collection);
    const next = records.filter((item) => item.id !== id);
    await this.write(collection, next);
    return next.length !== records.length;
  }

  async findOne(collection, predicate) {
    return (await this.all(collection)).find(predicate) || null;
  }

  async filter(collection, predicate) {
    return (await this.all(collection)).filter(predicate);
  }

  async saveFile(name, buffer, metadata = {}) {
    const extension = path.extname(name).toLowerCase();
    await this.client.send(new this.commands.PutObjectCommand({
      Bucket: this.bucket,
      Key: this.fileKey(name),
      Body: buffer,
      ContentType: metadata.contentType || mimeTypes[extension] || "application/octet-stream",
      Metadata: {
        originalFilename: String(metadata.originalFilename || "").slice(0, 1024)
      }
    }));
  }

  async readFile(name) {
    const response = await this.client.send(new this.commands.GetObjectCommand({ Bucket: this.bucket, Key: this.fileKey(name) }));
    return await this.bodyToBuffer(response.Body);
  }

  async deleteFile(name) {
    await this.client.send(new this.commands.DeleteObjectCommand({ Bucket: this.bucket, Key: this.fileKey(name) }));
  }

  async saveTempChunk(uploadId, fileIndex, chunkIndex, buffer) {
    await this.client.send(new this.commands.PutObjectCommand({
      Bucket: this.bucket,
      Key: this.tempChunkKey(uploadId, fileIndex, chunkIndex),
      Body: buffer,
      ContentType: "application/octet-stream"
    }));
  }

  async readTempChunk(uploadId, fileIndex, chunkIndex) {
    try {
      const response = await this.client.send(new this.commands.GetObjectCommand({
        Bucket: this.bucket,
        Key: this.tempChunkKey(uploadId, fileIndex, chunkIndex)
      }));
      return await this.bodyToBuffer(response.Body);
    } catch {
      return null;
    }
  }

  async deleteTempUpload(uploadId) {
    let ContinuationToken;
    do {
      const response = await this.client.send(new this.commands.ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.tempChunkKey(uploadId, ""),
        ContinuationToken
      }));
      const objects = (response.Contents || []).map((item) => ({ Key: item.Key }));
      if (objects.length) {
        await this.client.send(new this.commands.DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects, Quiet: true }
        }));
      }
      ContinuationToken = response.NextContinuationToken;
    } while (ContinuationToken);
  }
}

async function createStore() {
  if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET) {
    return new R2Store({
      accountId: R2_ACCOUNT_ID,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      bucket: R2_BUCKET,
      prefix: R2_PREFIX
    });
  }
  if (process.env.MONGODB_URI) return new MongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB);
  return new JsonStore(DATA_DIR);
}

const db = await createStore();

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function generateTemporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function verifyPassword(password, saved) {
  if (!password || !saved || !saved.includes(":")) return false;
  const [salt, hash] = saved.split(":");
  const check = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), check);
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function makeCookie(sessionId) {
  const value = `${sessionId}.${sign(sessionId)}`;
  return `library_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
}

function makeBootstrapCookie(email) {
  const payload = Buffer.from(JSON.stringify({ email, role: "admin" })).toString("base64url");
  return `bootstrap_admin=${payload}.${sign(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

async function currentUser(req) {
  const bootstrap = parseCookies(req).bootstrap_admin;
  if (bootstrap) {
    const [payload, signature] = bootstrap.split(".");
    if (payload && signature === sign(payload)) {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (data.email === ADMIN_EMAIL && data.role === "admin") {
        return { id: "bootstrap-admin", email: data.email, name: "Library Administrator", role: "admin", provider: "env", active: true };
      }
    }
  }
  const raw = parseCookies(req).library_session;
  if (!raw) return null;
  const [sessionId, signature] = raw.split(".");
  if (!sessionId || signature !== sign(sessionId)) return null;
  const session = await db.findOne("loginSessions", (item) => item.id === sessionId && !item.endedAt);
  if (!session) return null;
  const user = await db.findOne("users", (item) => item.id === session.userId);
  return user ? { ...user, sessionId } : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function postForm(url, form) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(form).toString();
    const target = new URL(url);
    const request = https.request({
      method: "POST",
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(text));
        resolve(JSON.parse(text));
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function decodeJwtPayload(token) {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

async function parseMultipart(req) {
  const type = req.headers["content-type"] || "";
  const boundary = type.match(/boundary=(.+)$/)?.[1];
  if (!boundary) throw new Error("Missing upload boundary.");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(marker) + marker.length + 2;
  while (start > marker.length) {
    const end = buffer.indexOf(marker, start);
    if (end === -1) break;
    const part = buffer.subarray(start, end - 2);
    const split = part.indexOf(Buffer.from("\r\n\r\n"));
    if (split > -1) {
      const header = part.subarray(0, split).toString("utf8");
      const content = part.subarray(split + 4);
      const name = header.match(/name="([^"]+)"/)?.[1];
      const filename = header.match(/filename="([^"]*)"/)?.[1];
      const contentType = header.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
      if (name) parts.push({ name, filename, contentType, content });
    }
    start = end + marker.length + 2;
  }
  return parts;
}

async function unpackUpload(file) {
  const extension = path.extname(file.filename).toLowerCase();
  if (extension !== ".zip") return [file];
  try {
    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip(file.content);
    return zip.getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => ({
        name: "files",
        filename: entry.entryName,
        contentType: mimeTypes[path.extname(entry.entryName).toLowerCase()] || "application/octet-stream",
        content: entry.getData()
      }));
  } catch {
    throw new Error("ZIP support needs dependencies installed. Run npm install in the deployment environment.");
  }
}

async function saveUploadedResources({ files, categories, selectedCategory, autoCategorize, user, batch }) {
  const saved = [];
  const skipped = [];
  const existingResources = await db.all("resources");
  const seenKeys = new Set(existingResources.map(resourceDuplicateKey).filter(Boolean));
  const seenHashes = new Set(existingResources.map((resource) => resource.metadata?.hash).filter(Boolean));
  for (const file of files) {
    const extension = path.extname(file.filename).toLowerCase();
    const hash = fileHash(file.content);
    const duplicateKey = uploadDuplicateKey(file.filename, file.content.length);
    if (!allowedResourceExtensions.includes(extension)) {
      skipped.push(await recordSkippedUpload({ file, reason: "Unsupported file type", user, batch, hash }));
      continue;
    }
    if (seenHashes.has(hash) || seenKeys.has(duplicateKey)) {
      skipped.push(await recordSkippedUpload({ file, reason: "Duplicate file already exists in the library", user, batch, hash }));
      continue;
    }
    const suggested = categorySuggestion(file.filename);
    const category = autoCategorize ? (categories.find((item) => item.name === suggested) || selectedCategory) : selectedCategory;
    const storageName = `${crypto.randomUUID()}${extension}`;
    await fs.writeFile(path.join(STORAGE_DIR, storageName), file.content);
    if (typeof db.saveFile === "function") {
      await db.saveFile(storageName, file.content, { originalFilename: file.filename, contentType: file.contentType });
    }
    const title = path.basename(file.filename, extension).replace(/[_-]+/g, " ").trim();
    saved.push(await db.insert("resources", {
      title,
      author: "",
      format: extension.slice(1),
      originalFilename: file.filename,
      storageName,
      categoryId: category?.id || "",
      suggestedCategory: suggested || category?.name || "",
      uploadMode: autoCategorize ? "auto" : "category",
      status: "published",
      uploadBatchId: batch.id,
      createdBy: user.id,
      inlineContent: shouldInlineFiles() && file.content.length <= INLINE_FILE_LIMIT ? file.content.toString("base64") : undefined,
      metadata: { size: file.content.length, contentType: file.contentType, hash }
    }));
    seenHashes.add(hash);
    seenKeys.add(duplicateKey);
  }
  return { saved, skipped };
}

function safeChunkName(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function saveUploadChunk(uploadId, fileIndex, chunkIndex, content) {
  if (typeof db.saveTempChunk === "function") {
    await db.saveTempChunk(uploadId, fileIndex, chunkIndex, content);
    return;
  }
  const dir = path.join(CHUNK_DIR, uploadId, fileIndex);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${chunkIndex}.part`), content);
}

async function readUploadChunk(uploadId, fileIndex, chunkIndex) {
  if (typeof db.readTempChunk === "function") {
    return await db.readTempChunk(uploadId, fileIndex, chunkIndex);
  }
  const chunkPath = path.join(CHUNK_DIR, uploadId, fileIndex, `${chunkIndex}.part`);
  if (!existsSync(chunkPath)) return null;
  return await fs.readFile(chunkPath);
}

async function removeUploadChunks(uploadId) {
  if (!uploadId) return;
  if (typeof db.deleteTempUpload === "function") {
    await db.deleteTempUpload(uploadId);
    return;
  }
  await fs.rm(path.join(CHUNK_DIR, uploadId), { recursive: true, force: true });
}

function fileHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeFilename(value) {
  return path.basename(String(value || "")).trim().toLowerCase().replace(/\s+/g, " ");
}

function uploadDuplicateKey(filename, size) {
  return `${normalizeFilename(filename)}:${Number(size || 0)}`;
}

function resourceDuplicateKey(resource) {
  return uploadDuplicateKey(resource.originalFilename || resource.title, resource.metadata?.size);
}

async function recordSkippedUpload({ file, reason, user, batch, hash }) {
  return await db.insert("skippedUploads", {
    filename: file.filename,
    normalizedFilename: normalizeFilename(file.filename),
    reason,
    uploadBatchId: batch.id,
    createdBy: user.id,
    size: file.content.length,
    contentType: file.contentType,
    hash,
    checked: false
  });
}

async function replaceResourceFile(resource, file, user) {
  const extension = path.extname(file.filename).toLowerCase();
  if (!allowedResourceExtensions.includes(extension)) throw new Error("Choose a supported PDF, EPUB, or image file.");
  const existingResources = await db.all("resources");
  const hash = fileHash(file.content);
  const duplicateKey = uploadDuplicateKey(file.filename, file.content.length);
  const duplicate = existingResources.find((item) => item.id !== resource.id && (item.metadata?.hash === hash || resourceDuplicateKey(item) === duplicateKey));
  if (duplicate) throw new Error("This file already exists in the library, so it was not added again.");
  const storageName = `${crypto.randomUUID()}${extension}`;
  await fs.writeFile(path.join(STORAGE_DIR, storageName), file.content);
  if (typeof db.saveFile === "function") await db.saveFile(storageName, file.content, { originalFilename: file.filename, contentType: file.contentType });
  await removeStoredFile(resource.storageName);
  const title = path.basename(file.filename, extension).replace(/[_-]+/g, " ").trim();
  return await db.update("resources", resource.id, {
    title,
    format: extension.slice(1),
    originalFilename: file.filename,
    storageName,
    status: "published",
    updatedBy: user.id,
    inlineContent: shouldInlineFiles() && file.content.length <= INLINE_FILE_LIMIT ? file.content.toString("base64") : undefined,
    metadata: { size: file.content.length, contentType: file.contentType, hash }
  });
}

async function removeStoredFile(storageName) {
  if (!storageName) return;
  await fs.rm(path.join(STORAGE_DIR, storageName), { force: true });
  if (typeof db.deleteFile === "function") await db.deleteFile(storageName);
}

function isStaff(user) {
  return user && ["admin", "director"].includes(user.role);
}

function shouldInlineFiles() {
  return typeof db.saveFile !== "function";
}

function publicResource(resource) {
  if (!resource) return null;
  const { inlineContent, ...safe } = resource;
  return safe;
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function categorySuggestion(name) {
  const lower = name.toLowerCase();
  const rules = [
    ["Old Testament", ["old testament", "genesis", "exodus", "leviticus", "numbers", "deuteronomy", "psalm", "isaiah"]],
    ["New Testament", ["new testament", "gospel", "matthew", "mark", "luke", "john", "paul", "romans", "revelation"]],
    ["Christian Theology", ["christian theology", "theology", "doctrine", "christology", "pneumatology", "ecclesiology", "trinity"]],
    ["History of Christianity", ["history of christianity", "church history", "christian history", "patristic", "reformation", "medieval", "ancient church"]],
    ["Christian Ministry", ["christian ministry", "ministry", "pastoral", "counsel", "care", "chaplain", "grief", "preaching", "homiletic", "worship"]],
    ["Missiology", ["mission", "missiology", "evangel", "church planting"]],
    ["Communication", ["communication", "media", "journalism", "public speaking", "writing", "broadcast"]],
    ["Christian Ethics", ["christian ethics", "ethics", "moral", "bioethics", "justice", "virtue"]],
    ["Religions", ["religion", "religions", "hindu", "islam", "buddhist", "buddhism", "interfaith", "comparative"]],
    ["Social Analysis", ["social", "society", "analysis", "politic", "econom", "caste", "culture", "development"]],
    ["Women Studies", ["women", "woman", "gender", "feminist", "feminism", "womanist"]]
  ];
  return rules.find(([, words]) => words.some((word) => lower.includes(word)))?.[0] || "";
}

function fieldValue(parts, name, fallback = "") {
  const part = parts.find((item) => item.name === name && !item.filename);
  return part ? part.content.toString("utf8") : fallback;
}

async function seed() {
  let existingCategories = await db.all("categories");
  for (let index = 0; index < defaultCategories.length; index++) {
    const name = defaultCategories[index];
    const existing = existingCategories.find((category) => category.name === name || category.slug === slug(name));
    if (existing) {
      await db.update("categories", existing.id, { name, slug: slug(name), order: index, archived: false });
    } else {
      await db.insert("categories", { name, slug: slug(name), order: index, archived: false });
    }
  }
  existingCategories = await db.all("categories");
  for (const category of existingCategories) {
    if (!defaultCategories.includes(category.name)) await db.update("categories", category.id, { archived: true });
  }
  const admin = await db.findOne("users", (user) => user.email === ADMIN_EMAIL);
  if (!admin) {
    await db.insert("users", { email: ADMIN_EMAIL, name: "Library Administrator", role: "admin", passwordHash: "", provider: "seed", active: true });
  }
  if (!shouldInlineFiles()) {
    const resources = await db.all("resources");
    for (const resource of resources) {
      if (resource.inlineContent) await db.update("resources", resource.id, { inlineContent: undefined });
    }
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function routeApi(req, res, url) {
  const user = await currentUser(req);

  if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, { user: publicUser(user) });

  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      googleConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
      mongoConfigured: Boolean(process.env.MONGODB_URI),
      r2Configured: Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET),
      adminEmail: ADMIN_EMAIL
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/setup") {
    const body = await bodyJson(req);
    const admin = await db.findOne("users", (item) => item.email === String(body.email || "").toLowerCase() && item.role === "admin");
    if (!admin || admin.passwordHash) return json(res, 403, { error: "Admin setup is not available." });
    if (!body.password || body.password.length < 10) return json(res, 400, { error: "Use at least 10 characters." });
    await db.update("users", admin.id, { passwordHash: hashPassword(body.password) });
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await bodyJson(req);
    const email = String(body.email || "").toLowerCase();
    const found = await db.findOne("users", (item) => item.email === email && item.active !== false);
    const bootstrapAdmin = email === ADMIN_EMAIL && ADMIN_BOOTSTRAP_PASSWORD && body.password === ADMIN_BOOTSTRAP_PASSWORD;
    if (bootstrapAdmin) {
      res.setHeader("Set-Cookie", makeBootstrapCookie(ADMIN_EMAIL));
      return json(res, 200, { user: { id: "bootstrap-admin", email: ADMIN_EMAIL, name: "Library Administrator", role: "admin", provider: "env", active: true } });
    }
    if ((!found || !verifyPassword(body.password, found.passwordHash)) && !bootstrapAdmin) return json(res, 401, { error: "Invalid email or password." });
    const loginUser = found || await db.insert("users", { email: ADMIN_EMAIL, name: "Library Administrator", role: "admin", passwordHash: "", provider: "env", active: true });
    const session = await db.insert("loginSessions", {
      userId: loginUser.id,
      email: loginUser.email,
      startedAt: new Date().toISOString(),
      endedAt: null,
      ip: req.socket.remoteAddress,
      userAgent: req.headers["user-agent"] || ""
    });
    res.setHeader("Set-Cookie", makeCookie(session.id));
    return json(res, 200, { user: publicUser(loginUser) });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/google/start") {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return send(res, 302, "", { Location: "/login?google=not-configured" });
    const csrf = crypto.randomUUID();
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: "code",
      scope: "openid email profile",
      state: csrf,
      prompt: "select_account"
    });
    res.setHeader("Set-Cookie", `google_oauth_state=${csrf}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
    return send(res, 302, "", { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    if (user?.sessionId) await db.update("loginSessions", user.sessionId, { endedAt: new Date().toISOString() });
    res.setHeader("Set-Cookie", [
      "library_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      "bootstrap_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    ]);
    return json(res, 200, { ok: true });
  }

  if (!user) return json(res, 401, { error: "Login required." });

  if (req.method === "GET" && url.pathname === "/api/categories") {
    const categories = (await db.all("categories")).filter((item) => !item.archived).sort((a, b) => a.order - b.order);
    return json(res, 200, { categories });
  }

  if (req.method === "POST" && url.pathname === "/api/categories") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const body = await bodyJson(req);
    const name = String(body.name || "").trim();
    if (!name) return json(res, 400, { error: "Category name is required." });
    return json(res, 201, { category: await db.insert("categories", { name, slug: slug(name), order: Date.now(), archived: false }) });
  }

  if (req.method === "GET" && url.pathname === "/api/resources") {
    const query = String(url.searchParams.get("q") || "").toLowerCase();
    const category = url.searchParams.get("category");
    const resources = (await db.all("resources")).filter((item) => {
      if (!isStaff(user) && item.status !== "published") return false;
      if (category && item.categoryId !== category) return false;
      if (query && !`${item.title} ${item.author || ""}`.toLowerCase().includes(query)) return false;
      return true;
    });
    return json(res, 200, { resources: resources.map(publicResource) });
  }

  if (req.method === "POST" && url.pathname === "/api/resources/upload") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const parts = await parseMultipart(req);
    const uploadedFiles = parts.filter((part) => part.filename);
    const autoCategorize = fieldValue(parts, "autoCategorize", "true") === "true";
    const targetCategoryId = fieldValue(parts, "targetCategoryId", "");
    const files = [];
    for (const uploaded of uploadedFiles) files.push(...await unpackUpload(uploaded));
    if (!files.length) return json(res, 400, { error: "Choose at least one supported file." });
    const categories = await db.all("categories");
    const selectedCategory = categories.find((item) => item.id === targetCategoryId) || categories[0];
    const batch = await db.insert("uploadBatches", { createdBy: user.id, fileCount: files.length, status: "processed" });
    const { saved, skipped } = await saveUploadedResources({ files, categories, selectedCategory, autoCategorize, user, batch });
    if (!saved.length && !skipped.length) return json(res, 400, { error: "No supported PDF, EPUB, or image files were found in that upload." });
    return json(res, 201, { resources: saved.map(publicResource), skipped });
  }

  if (req.method === "POST" && url.pathname === "/api/resources/upload-chunk") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const parts = await parseMultipart(req);
    const chunk = parts.find((part) => part.filename);
    if (!chunk) return json(res, 400, { error: "Missing upload chunk." });
    const uploadId = safeChunkName(fieldValue(parts, "uploadId"));
    const fileIndex = safeChunkName(fieldValue(parts, "fileIndex"));
    const chunkIndex = safeChunkName(fieldValue(parts, "chunkIndex"));
    if (!uploadId || !fileIndex || !chunkIndex) return json(res, 400, { error: "Missing chunk metadata." });
    await saveUploadChunk(uploadId, fileIndex, chunkIndex, chunk.content);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/resources/upload-cancel") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const body = await bodyJson(req);
    const uploadId = safeChunkName(body.uploadId);
    if (!uploadId) return json(res, 400, { error: "Missing upload id." });
    await removeUploadChunks(uploadId);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/resources/upload-complete") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const body = await bodyJson(req);
    const uploadId = safeChunkName(body.uploadId);
    const autoCategorize = body.autoCategorize !== false;
    const categories = await db.all("categories");
    const selectedCategory = categories.find((item) => item.id === body.targetCategoryId) || categories[0];
    const assembled = [];
    for (const meta of body.files || []) {
      const fileIndex = safeChunkName(meta.fileIndex);
      const totalChunks = Number(meta.totalChunks || 0);
      const buffers = [];
      for (let index = 0; index < totalChunks; index++) {
        const chunk = await readUploadChunk(uploadId, fileIndex, index);
        if (!chunk) return json(res, 400, { error: `Missing chunk ${index + 1} for ${meta.filename}. Please try the upload again.` });
        buffers.push(chunk);
      }
      assembled.push({
        name: "files",
        filename: meta.filename,
        contentType: meta.contentType || mimeTypes[path.extname(meta.filename).toLowerCase()] || "application/octet-stream",
        content: Buffer.concat(buffers)
      });
    }
    const files = [];
    for (const uploaded of assembled) files.push(...await unpackUpload(uploaded));
    const batch = await db.insert("uploadBatches", { createdBy: user.id, fileCount: files.length, status: "processed", uploadMode: "chunked" });
    const { saved, skipped } = await saveUploadedResources({ files, categories, selectedCategory, autoCategorize, user, batch });
    await removeUploadChunks(uploadId);
    if (!saved.length && !skipped.length) return json(res, 400, { error: "No supported PDF, EPUB, or image files were found in that upload." });
    return json(res, 201, { resources: saved.map(publicResource), skipped });
  }

  if (req.method === "GET" && url.pathname === "/api/skipped-uploads") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const skipped = (await db.all("skippedUploads")).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json(res, 200, { skipped });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/resources/")) {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const id = url.pathname.split("/").pop();
    const body = await bodyJson(req);
    const patch = {};
    for (const key of ["title", "author", "categoryId", "status"]) if (body[key] !== undefined) patch[key] = body[key];
    return json(res, 200, { resource: publicResource(await db.update("resources", id, patch)) });
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/resources\/[^/]+\/replace$/)) {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const id = url.pathname.split("/")[3];
    const resource = await db.findOne("resources", (item) => item.id === id);
    if (!resource) return json(res, 404, { error: "Resource not found." });
    const parts = await parseMultipart(req);
    const file = parts.find((part) => part.filename);
    if (!file) return json(res, 400, { error: "Choose a replacement file." });
    try {
      return json(res, 200, { resource: publicResource(await replaceResourceFile(resource, file, user)) });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/resources/")) {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const id = url.pathname.split("/").pop();
    const resource = await db.findOne("resources", (item) => item.id === id);
    if (!resource) return json(res, 404, { error: "Resource not found." });
    await removeStoredFile(resource.storageName);
    await db.delete("resources", id);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const body = await bodyJson(req);
    const email = String(body.email || "").toLowerCase();
    if (!email) return json(res, 400, { error: "Email is required." });
    const existing = await db.findOne("users", (item) => item.email === email);
    if (existing && existing.active !== false) return json(res, 409, { error: "This email already exists." });
    const temporaryPassword = generateTemporaryPassword();
    const role = ["student", "admin", "director"].includes(body.role) ? body.role : "student";
    if (existing) {
      const updated = await db.update("users", existing.id, {
        name: body.name || email,
        role,
        passwordHash: hashPassword(temporaryPassword),
        provider: "password",
        active: true,
        removedAt: null,
        removedBy: null,
        temporaryPasswordSetAt: new Date().toISOString()
      });
      return json(res, 200, { user: publicUser(updated), temporaryPassword });
    }
    const created = await db.insert("users", {
      email,
      name: body.name || email,
      role,
      passwordHash: hashPassword(temporaryPassword),
      provider: "password",
      active: true,
      createdBy: user.id,
      temporaryPasswordSetAt: new Date().toISOString()
    });
    return json(res, 201, { user: publicUser(created), temporaryPassword });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/users/")) {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const id = url.pathname.split("/").pop();
    if (id === user.id || id === "bootstrap-admin") return json(res, 400, { error: "You cannot remove your own admin access here." });
    const target = await db.findOne("users", (item) => item.id === id);
    if (!target) return json(res, 404, { error: "User not found." });
    await db.update("users", id, {
      active: false,
      removedAt: new Date().toISOString(),
      removedBy: user.id
    });
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/reports") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const users = await db.all("users");
    const logins = await db.all("loginSessions");
    const reads = await db.all("readingSessions");
    const resources = await db.all("resources");
    return json(res, 200, { users: users.map(publicUser), logins, reads, resources: resources.map(publicResource) });
  }

  if (req.method === "POST" && url.pathname === "/api/reading/start") {
    const body = await bodyJson(req);
    const resource = await db.findOne("resources", (item) => item.id === body.resourceId && (item.status === "published" || isStaff(user)));
    if (!resource) return json(res, 404, { error: "Resource not found." });
    const session = await db.insert("readingSessions", {
      userId: user.id,
      resourceId: resource.id,
      categoryId: resource.categoryId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      seconds: 0,
      lastLocation: ""
    });
    await db.insert("accessEvents", { userId: user.id, resourceId: resource.id, action: "open", at: new Date().toISOString() });
    return json(res, 201, { readingSession: session });
  }

  if (req.method === "POST" && url.pathname === "/api/reading/end") {
    const body = await bodyJson(req);
    const existing = await db.findOne("readingSessions", (item) => item.id === body.readingSessionId && item.userId === user.id);
    if (!existing) return json(res, 404, { error: "Reading session not found." });
    const started = new Date(existing.startedAt).getTime();
    const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
    return json(res, 200, { readingSession: await db.update("readingSessions", existing.id, { endedAt: new Date().toISOString(), seconds, lastLocation: body.lastLocation || "" }) });
  }

  return json(res, 404, { error: "Not found." });
}

async function routeGoogleCallback(req, res, url) {
  const stateCookie = parseCookies(req).google_oauth_state;
  if (!url.searchParams.get("code") || !stateCookie || url.searchParams.get("state") !== stateCookie) {
    return send(res, 302, "", { Location: "/login?google=failed" });
  }
  const token = await postForm("https://oauth2.googleapis.com/token", {
    code: url.searchParams.get("code"),
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code"
  });
  const profile = decodeJwtPayload(token.id_token);
  if (profile.aud !== GOOGLE_CLIENT_ID) return send(res, 302, "", { Location: "/login?google=failed" });
  const email = String(profile.email || "").toLowerCase();
  if (!email || profile.email_verified === false) return send(res, 302, "", { Location: "/login?google=unverified" });
  let user = await db.findOne("users", (item) => item.email === email);
  if (!user) {
    user = await db.insert("users", {
      email,
      name: profile.name || email,
      role: email === ADMIN_EMAIL ? "admin" : "student",
      passwordHash: "",
      provider: "google",
      active: true
    });
  }
  const session = await db.insert("loginSessions", {
    userId: user.id,
    email: user.email,
    startedAt: new Date().toISOString(),
    endedAt: null,
    ip: req.socket.remoteAddress,
    userAgent: req.headers["user-agent"] || "",
    provider: "google"
  });
  res.setHeader("Set-Cookie", [
    makeCookie(session.id),
    "google_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  ]);
  return send(res, 302, "", { Location: "/library" });
}

async function serveResource(req, res, url) {
  const user = await currentUser(req);
  if (!user) return send(res, 302, "", { Location: "/login" });
  const resource = await db.findOne("resources", (item) => item.id === url.pathname.split("/").pop() && (item.status === "published" || isStaff(user)));
  if (!resource) return send(res, 404, "Not found");
  const filePath = path.join(STORAGE_DIR, resource.storageName);
  const extension = path.extname(resource.storageName);
  let stored = null;
  if (!existsSync(filePath) && typeof db.readFile === "function") stored = await db.readFile(resource.storageName);
  if (!existsSync(filePath) && !stored && !resource.inlineContent) return send(res, 404, "Missing file. Please upload this resource again after permanent storage is configured.");
  res.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Content-Disposition": `inline; filename="${resource.title.replace(/"/g, "")}${extension}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff"
  });
  if (existsSync(filePath)) return createReadStream(filePath).pipe(res);
  if (stored) return res.end(stored);
  if (resource.inlineContent) return res.end(Buffer.from(resource.inlineContent, "base64"));
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (["/login", "/library", "/admin"].includes(pathname) || pathname.startsWith("/library/") || pathname.startsWith("/read/") || pathname.startsWith("/admin/")) {
    pathname = "/index.html";
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) return send(res, 404, "Not found");
  sendFile(res, filePath);
}

function sendFile(res, filePath) {
  const extension = path.extname(filePath);
  res.writeHead(200, { "Content-Type": mimeTypes[extension] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

const ready = (async () => {
  await db.init();
  await seed();
})();

export default async function handler(req, res) {
  await ready;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await routeApi(req, res, url);
    if (url.pathname === "/auth/google/callback") return await routeGoogleCallback(req, res, url);
    if (url.pathname.startsWith("/protected-file/")) return await serveResource(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "Server error." });
  }
}

if (!process.env.VERCEL) {
  http.createServer(handler).listen(PORT, () => {
    console.log(`AGBS LIBRARY running at http://localhost:${PORT}`);
  });
}
