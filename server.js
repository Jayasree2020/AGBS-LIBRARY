import http from "node:http";
import https from "node:https";
import { promises as fs } from "node:fs";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
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
const AWS_REGION = process.env.AWS_REGION || "";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "";
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || "";
const AWS_S3_PREFIX = (process.env.AWS_S3_PREFIX || "agbs-library").replace(/^\/+|\/+$/g, "");
const AWS_STORAGE_BUDGET_GB = Number(process.env.AWS_STORAGE_BUDGET_GB || 3000);
const AWS_STORAGE_PLAN_MONTHS = Number(process.env.AWS_STORAGE_PLAN_MONTHS || 12);
const RUNTIME_DIR = process.env.VERCEL ? path.join(os.tmpdir(), "agbs-library") : __dirname;
const DATA_DIR = path.join(RUNTIME_DIR, "data");
const STORAGE_DIR = path.join(RUNTIME_DIR, "storage");
const PUBLIC_DIR = path.join(__dirname, "public");

const defaultCategoryDefinitions = [
  { name: "Old Testament" },
  { name: "New Testament" },
  { name: "Christian Theology" },
  { name: "History of Christianity" },
  { name: "Christian Ministry" },
  { name: "Missiology" },
  { name: "Communication" },
  { name: "Christian Ethics" },
  { name: "Religions" },
  { name: "Social Analysis" },
  { name: "Women Studies" },
  { name: "Languages" },
  { name: "English", parentName: "Languages" },
  { name: "Greek", parentName: "Languages" },
  { name: "Hebrew", parentName: "Languages" },
  { name: "Research Methodology" },
  { name: "Music" },
  { name: "Homiletics" },
  { name: "Pastoral Care and Counselling" }
];
const defaultCategories = defaultCategoryDefinitions.map((category) => category.name);

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

const allowedResourceExtensions = [".pdf", ".epub"];
const CHUNK_DIR = path.join(STORAGE_DIR, "chunks");
const INLINE_FILE_LIMIT = 8 * 1024 * 1024;

function resourceExtensionFor(file) {
  const filename = String(file?.filename || "").trim();
  const namedMatch = filename.match(/\.(pdf|epub)\s*\.?$/i);
  if (namedMatch) return `.${namedMatch[1].toLowerCase()}`;
  const contentType = String(file?.contentType || "").toLowerCase();
  if (contentType.includes("pdf")) return ".pdf";
  if (contentType.includes("epub")) return ".epub";
  const content = Buffer.isBuffer(file?.content) ? file.content : Buffer.from(file?.content || "");
  if (content.subarray(0, 5).toString("utf8") === "%PDF-") return ".pdf";
  return path.extname(filename).toLowerCase();
}

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

  async insertMany(collection, recordsToInsert) {
    const items = Array.isArray(recordsToInsert) ? recordsToInsert : [];
    if (!items.length) return [];
    const records = await this.all(collection);
    const now = new Date().toISOString();
    const full = items.map((record) => ({ id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...record }));
    records.push(...full);
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

  async storageUsage() {
    const usage = {
      provider: "local-json",
      bucket: "",
      prefix: "",
      totalBytes: 0,
      totalObjects: 0,
      bookBytes: 0,
      bookObjects: 0,
      dataBytes: 0,
      dataObjects: 0,
      tempBytes: 0,
      tempObjects: 0
    };
    for (const directory of [DATA_DIR, STORAGE_DIR]) {
      if (!existsSync(directory)) continue;
      const files = await fs.readdir(directory, { recursive: true, withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        const fullPath = path.join(file.parentPath || directory, file.name);
        const stat = await fs.stat(fullPath);
        usage.totalBytes += stat.size;
        usage.totalObjects += 1;
        if (fullPath.startsWith(STORAGE_DIR)) {
          usage.bookBytes += stat.size;
          usage.bookObjects += 1;
        } else {
          usage.dataBytes += stat.size;
          usage.dataObjects += 1;
        }
      }
    }
    return usage;
  }
}

class ObjectStore {
  constructor({ accessKeyId, secretAccessKey, bucket, prefix, region = "auto", endpoint = "" }) {
    this.bucket = bucket;
    this.prefix = prefix;
    this.collections = ["users", "categories", "resources", "uploadBatches", "loginSessions", "readingSessions", "accessEvents", "skippedUploads"];
    this.region = region;
    this.endpoint = endpoint;
    this.credentials = { accessKeyId, secretAccessKey };
    this.jsonCache = new Map();
    this.jsonCacheMs = 10000;
  }

  async init() {
    const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    this.commands = { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand };
    this.client = new S3Client({
      region: this.region,
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
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

  tempZipKey(uploadId) {
    return this.key(`tmp/zips/${uploadId}.zip`);
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
    this.jsonCache.set(key, { value, expiresAt: Date.now() + this.jsonCacheMs });
  }

  async getJson(key) {
    const cached = this.jsonCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const response = await this.client.send(new this.commands.GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const value = JSON.parse((await this.bodyToBuffer(response.Body)).toString("utf8"));
    this.jsonCache.set(key, { value, expiresAt: Date.now() + this.jsonCacheMs });
    return value;
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

  async insertMany(collection, recordsToInsert) {
    const items = Array.isArray(recordsToInsert) ? recordsToInsert : [];
    if (!items.length) return [];
    const records = await this.all(collection);
    const now = new Date().toISOString();
    const full = items.map((record) => ({ id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...record }));
    records.push(...full);
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
    await this.client.send(new this.commands.DeleteObjectCommand({ Bucket: this.bucket, Key: this.tempZipKey(uploadId) })).catch(() => {});
  }

  async saveTempZip(uploadId, buffer) {
    await this.client.send(new this.commands.PutObjectCommand({
      Bucket: this.bucket,
      Key: this.tempZipKey(uploadId),
      Body: buffer,
      ContentType: "application/zip"
    }));
  }

  async readTempZip(uploadId) {
    try {
      const response = await this.client.send(new this.commands.GetObjectCommand({
        Bucket: this.bucket,
        Key: this.tempZipKey(uploadId)
      }));
      return await this.bodyToBuffer(response.Body);
    } catch {
      return null;
    }
  }

  async storageUsage() {
    const usage = {
      provider: "aws-s3",
      bucket: this.bucket,
      prefix: this.prefix,
      totalBytes: 0,
      totalObjects: 0,
      bookBytes: 0,
      bookObjects: 0,
      dataBytes: 0,
      dataObjects: 0,
      tempBytes: 0,
      tempObjects: 0
    };
    const bookPrefix = this.key("books/");
    const dataPrefix = this.key("data/");
    const tempPrefix = this.key("tmp/");
    let ContinuationToken;
    do {
      const response = await this.client.send(new this.commands.ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.key(""),
        ContinuationToken
      }));
      for (const item of response.Contents || []) {
        const size = Number(item.Size || 0);
        usage.totalBytes += size;
        usage.totalObjects += 1;
        if (item.Key.startsWith(bookPrefix)) {
          usage.bookBytes += size;
          usage.bookObjects += 1;
        } else if (item.Key.startsWith(dataPrefix)) {
          usage.dataBytes += size;
          usage.dataObjects += 1;
        } else if (item.Key.startsWith(tempPrefix)) {
          usage.tempBytes += size;
          usage.tempObjects += 1;
        }
      }
      ContinuationToken = response.NextContinuationToken;
    } while (ContinuationToken);
    return usage;
  }
}

async function createStore() {
  if (AWS_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && AWS_S3_BUCKET) {
    return new ObjectStore({
      region: AWS_REGION,
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      bucket: AWS_S3_BUCKET,
      prefix: AWS_S3_PREFIX
    });
  }
  return new JsonStore(DATA_DIR);
}

const db = await createStore();

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function generateTemporaryPassword(studentName, email) {
  const source = `${studentName || ""} ${String(email || "").split("@")[0]}`;
  const prefix = source.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 3) || "stu";
  return `${prefix.padEnd(3, "x")}@agbs2020`;
}

function verifyPassword(password, saved) {
  if (!password || !saved || !saved.includes(":")) return false;
  const [salt, hash] = saved.split(":");
  if (!/^[a-f0-9]{128}$/i.test(hash || "")) return false;
  const check = crypto.scryptSync(password, salt, 64);
  const savedHash = Buffer.from(hash, "hex");
  if (savedHash.length !== check.length) return false;
  return crypto.timingSafeEqual(savedHash, check);
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

function makeUploadToken(user) {
  const payload = Buffer.from(JSON.stringify({
    userId: user.id,
    email: user.email,
    role: user.role,
    exp: Date.now() + 12 * 60 * 60 * 1000
  })).toString("base64url");
  return `${payload}.${sign(`upload:${payload}`)}`;
}

async function userFromUploadToken(req) {
  const raw = String(req.headers["x-upload-token"] || "");
  if (!raw) return null;
  const pathname = new URL(req.url, "http://localhost").pathname;
  const allowedUploadPaths = new Set([
    "/api/resources/upload",
    "/api/resources/upload-chunk",
    "/api/resources/upload-cancel",
    "/api/resources/upload-complete"
  ]);
  if (!allowedUploadPaths.has(pathname)) return null;
  const [payload, signature] = raw.split(".");
  if (!payload || signature !== sign(`upload:${payload}`)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.userId || !data.exp || Date.now() > Number(data.exp)) return null;
    if (data.userId === "bootstrap-admin" && data.email === ADMIN_EMAIL && data.role === "admin") {
      return { id: "bootstrap-admin", email: ADMIN_EMAIL, name: "Library Administrator", role: "admin", provider: "env", active: true };
    }
    const user = await db.findOne("users", (item) => item.id === data.userId && item.active !== false);
    return user && user.role === data.role ? user : null;
  } catch {
    return null;
  }
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
  if (!raw) return await userFromUploadToken(req);
  const [sessionId, signature] = raw.split(".");
  if (!sessionId || signature !== sign(sessionId)) return await userFromUploadToken(req);
  const session = await db.findOne("loginSessions", (item) => item.id === sessionId && !item.endedAt);
  if (!session) return await userFromUploadToken(req);
  const user = await db.findOne("users", (item) => item.id === session.userId);
  return user ? { ...user, sessionId } : await userFromUploadToken(req);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

function download(res, filename, contentType, body) {
  send(res, 200, body, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store"
  });
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
  return await zipEntryFiles(file.content);
}

async function zipEntries(buffer) {
  try {
    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip(buffer);
    return zip.getEntries().filter((entry) => !entry.isDirectory);
  } catch {
    throw new Error("ZIP support needs dependencies installed. Run npm install in the deployment environment.");
  }
}

async function zipEntryFiles(buffer) {
  const entries = await zipEntries(buffer);
  return entries.map((entry) => ({
    name: "files",
    filename: entry.entryName,
    contentType: mimeTypes[path.extname(entry.entryName).toLowerCase()] || "application/octet-stream",
    content: entry.getData()
  }));
}

async function zipEntryAt(buffer, index) {
  const entries = await zipEntries(buffer);
  const entry = entries[index];
  return {
    totalEntries: entries.length,
    file: entry ? {
      name: "files",
      filename: entry.entryName,
      contentType: mimeTypes[path.extname(entry.entryName).toLowerCase()] || "application/octet-stream",
      content: entry.getData()
    } : null
  };
}

async function saveUploadedResources({ files, categories, selectedCategory, autoCategorize, user, batch }) {
  const resourceRecords = [];
  const skippedRecords = [];
  const existingResources = await db.all("resources");
  const seenHashes = new Map(existingResources.map((resource) => [resource.metadata?.hash, resource]).filter(([hash]) => Boolean(hash)));
  for (const file of files) {
    const extension = resourceExtensionFor(file);
    const hash = fileHash(file.content);
    if (!allowedResourceExtensions.includes(extension)) {
      skippedRecords.push(buildSkippedUpload({ file, reason: "Only PDF and EPUB files are allowed", user, batch, hash }));
      continue;
    }
    const duplicate = seenHashes.get(hash);
    if (duplicate) {
      skippedRecords.push(buildSkippedUpload({
        file,
        reason: `Exact duplicate already exists: ${duplicate.title || duplicate.originalFilename || "same file"}`,
        user,
        batch,
        hash
      }));
      continue;
    }
    const category = autoCategorize ? (categoryForFile(file.filename, categories) || selectedCategory) : selectedCategory;
    const suggested = category?.name || selectedCategory?.name || "";
    const storageName = `${crypto.randomUUID()}${extension}`;
    if (typeof db.saveFile === "function") {
      await db.saveFile(storageName, file.content, { originalFilename: file.filename, contentType: file.contentType });
    } else {
      await fs.writeFile(path.join(STORAGE_DIR, storageName), file.content);
    }
    const title = inferTitle(file.filename);
    const author = inferAuthor(file.filename);
    const classification = classifyResource({ title, originalFilename: file.filename, category });
    resourceRecords.push({
      title,
      author,
      format: extension.slice(1),
      resourceType: "E-book",
      originalFilename: file.filename,
      storageName,
      categoryId: category?.id || "",
      suggestedCategory: suggested || category?.name || "",
      classification,
      bibliography: buildBibliography({ title, author, format: extension.slice(1), originalFilename: file.filename, category, classification }),
      uploadMode: autoCategorize ? "auto" : "category",
      status: "published",
      uploadBatchId: batch.id,
      createdBy: user.id,
      inlineContent: shouldInlineFiles() && file.content.length <= INLINE_FILE_LIMIT ? file.content.toString("base64") : undefined,
      metadata: { size: file.content.length, contentType: file.contentType, hash, duplicateCheck: "exact-hash" }
    });
    seenHashes.set(hash, { title, originalFilename: file.filename, metadata: { hash } });
  }
  const saved = typeof db.insertMany === "function" ? await db.insertMany("resources", resourceRecords) : [];
  const skipped = typeof db.insertMany === "function" ? await db.insertMany("skippedUploads", skippedRecords) : [];
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

async function saveUploadZip(uploadId, buffer) {
  if (typeof db.saveTempZip === "function") {
    await db.saveTempZip(uploadId, buffer);
    return;
  }
  const dir = path.join(CHUNK_DIR, uploadId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "upload.zip"), buffer);
}

async function readUploadZip(uploadId) {
  if (typeof db.readTempZip === "function") {
    return await db.readTempZip(uploadId);
  }
  const file = path.join(CHUNK_DIR, uploadId, "upload.zip");
  if (!existsSync(file)) return null;
  return await fs.readFile(file);
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

function cleanAuthorName(value) {
  const text = String(value || "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length < 2 || text.length > 80) return "";
  const lower = text.toLowerCase();
  const subjectWords = [
    "bible", "old testament", "new testament", "genesis", "exodus", "leviticus", "numbers", "deuteronomy",
    "joshua", "judges", "samuel", "kings", "chronicles", "ezra", "nehemiah", "esther", "job", "psalms",
    "proverbs", "ecclesiastes", "isaiah", "jeremiah", "ezekiel", "daniel", "matthew", "mark", "luke",
    "john", "acts", "romans", "corinthians", "galatians", "ephesians", "philippians", "colossians",
    "thessalonians", "timothy", "titus", "philemon", "hebrews", "james", "peter", "jude", "revelation",
    "introduction", "commentary", "notes", "study", "survey"
  ];
  if (subjectWords.some((word) => lower.includes(word))) return "";
  if (/\b(to|in|part|volume|vol|chapter|lesson|unit)\b/i.test(text)) return "";
  if (!/[a-z]/i.test(text)) return "";
  return text;
}

function inferAuthor(filename) {
  const base = path.basename(String(filename || ""), path.extname(String(filename || ""))).replace(/[_]+/g, " ").trim();
  const match = base.match(/^(.{2,80}?)\s+-\s+(.{2,160})$/);
  return match ? cleanAuthorName(match[1]) : "";
}

function inferTitle(filename) {
  const base = path.basename(String(filename || ""), path.extname(String(filename || ""))).replace(/[_]+/g, " ").trim();
  const match = base.match(/^(.{2,80}?)\s+-\s+(.{2,160})$/);
  return (match ? match[2] : base.replace(/[-]+/g, " ")).trim();
}

const deweyRules = [
  { number: "221", label: "Old Testament", keywords: ["old testament", "genesis", "exodus", "leviticus", "numbers", "deuteronomy", "joshua", "judges", "samuel", "kings", "chronicles", "ezra", "nehemiah", "esther", "job", "psalms", "proverbs", "ecclesiastes", "isaiah", "jeremiah", "ezekiel", "daniel", "hosea", "amos", "jonah", "micah", "malachi"] },
  { number: "225", label: "New Testament", keywords: ["new testament", "matthew", "mark", "luke", "john", "acts", "romans", "corinthians", "galatians", "ephesians", "philippians", "colossians", "thessalonians", "timothy", "titus", "philemon", "hebrews", "james", "peter", "jude", "revelation"] },
  { number: "230", label: "Christian Theology", keywords: ["christian theology", "theology", "doctrine", "systematic", "christology", "trinity", "atonement", "soteriology", "pneumatology", "ecclesiology", "eschatology"] },
  { number: "241", label: "Christian Ethics", keywords: ["christian ethics", "ethics", "moral", "morality", "justice", "virtue"] },
  { number: "253", label: "Christian Ministry", keywords: ["christian ministry", "ministry", "pastoral", "preaching", "homiletics", "worship", "discipleship", "leadership", "counseling", "counselling"] },
  { number: "253.5", label: "Homiletics", keywords: ["homiletics", "homiletic", "preaching", "sermon", "sermons", "expository preaching", "pulpit"] },
  { number: "253.5", label: "Pastoral Care and Counselling", keywords: ["pastoral care", "pastoral counselling", "pastoral counseling", "counselling", "counseling", "chaplain", "grief", "care ministry"] },
  { number: "264.2", label: "Music", keywords: ["music", "hymn", "hymns", "hymnology", "worship music", "choir", "song", "songs", "liturgy"] },
  { number: "266", label: "Missiology", keywords: ["missiology", "mission", "missions", "evangelism", "church planting", "cross cultural"] },
  { number: "270", label: "History of Christianity", keywords: ["history of christianity", "church history", "christian history", "reformation", "patristic", "medieval church", "early church"] },
  { number: "200", label: "Religions", keywords: ["religions", "religion", "hinduism", "islam", "buddhism", "sikhism", "tribal religion", "comparative religion"] },
  { number: "261.8", label: "Social Analysis", keywords: ["social analysis", "society", "social", "dalit", "tribal", "poverty", "politics", "economics", "liberation", "human rights"] },
  { number: "001.4", label: "Research Methodology", keywords: ["research methodology", "research method", "research methods", "methodology", "thesis", "dissertation", "academic writing", "citation", "bibliography"] },
  { number: "302.2", label: "Communication", keywords: ["communication", "media", "journalism", "public speaking", "language", "rhetoric"] },
  { number: "305.42", label: "Women Studies", keywords: ["women studies", "women", "woman", "gender", "feminist", "feminism"] },
  { number: "420", label: "English", keywords: ["english", "english language", "grammar", "composition", "reading english", "writing english"] },
  { number: "480", label: "Greek", keywords: ["greek", "biblical greek", "koine", "koine greek", "new testament greek"] },
  { number: "492.4", label: "Hebrew", keywords: ["hebrew", "biblical hebrew", "hebrew bible", "old testament hebrew"] },
  { number: "400", label: "Languages", keywords: ["languages", "language studies", "language", "linguistics", "translation", "lexicon", "dictionary"] }
];

function classifyResource({ title, originalFilename, category }) {
  const text = normalizeCategoryText(`${category?.name || ""} ${title || ""} ${originalFilename || ""}`);
  let best = null;
  for (const rule of deweyRules) {
    let score = 0;
    for (const keyword of rule.keywords) {
      if (text.includes(normalizeCategoryText(keyword))) score += keyword.includes(" ") ? 3 : 1;
    }
    if (!best || score > best.score) best = { ...rule, score };
  }
  if (!best || best.score === 0) best = { number: "200", label: "Religion", score: 0 };
  return {
    system: "Dewey Decimal Classification",
    number: best.number,
    label: best.label,
    source: best.score > 0 ? "Automatic category and filename match" : "Automatic general religion fallback",
    confidence: best.score >= 3 ? "high" : best.score > 0 ? "medium" : "low"
  };
}

function buildBibliography({ title, author, format, originalFilename, category, classification }) {
  const cleanTitle = title || path.basename(originalFilename || "Untitled", path.extname(originalFilename || ""));
  const cleanAuthor = cleanAuthorName(author);
  const authorPart = cleanAuthor ? `${cleanAuthor}. ` : "";
  const categoryPart = category?.name ? ` Department: ${category.name}.` : "";
  const filePart = originalFilename ? ` Source file: ${path.basename(originalFilename)}.` : "";
  return `${authorPart}${cleanTitle}. E-book, ${String(format || "").toUpperCase()}.${categoryPart} Classification: Dewey ${classification?.number || "200"} ${classification?.label || "Religion"}.${filePart}`;
}

function callNumberFor({ title, author, classification }) {
  const base = cleanAuthorName(author) || title || "";
  const code = String(base)
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 4);
  return `${classification?.number || "200"}${code ? ` ${code}` : ""}`;
}

function classificationDetailsFor({ title, author, format, originalFilename, categoryName, classification }) {
  const cleanAuthor = cleanAuthorName(author) || "Unknown";
  return [
    `Call number: ${callNumberFor({ title, author, classification })}`,
    `Dewey: ${classification?.number || "200"} ${classification?.label || "Religion"}`,
    `Title: ${title || "Untitled"}`,
    `Author: ${cleanAuthor}`,
    `Department: ${categoryName || "Uncategorized"}`,
    `Format: ${String(format || "").toUpperCase() || "E-book"}`,
    `File: ${path.basename(originalFilename || "") || "Not recorded"}`,
    `Confidence: ${classification?.confidence || "low"}`
  ].join("; ");
}

function exportRows(resources, categories) {
  return resources
    .slice()
    .sort((a, b) => String(a.title || a.originalFilename || "").localeCompare(String(b.title || b.originalFilename || "")))
    .map((resource, index) => {
      const item = classifiedResource(resource, categories);
      return {
        no: index + 1,
        title: item.title,
        author: item.author || "",
        type: item.resourceType || "E-book",
        format: String(item.format || "").toUpperCase(),
        category: item.categoryName,
        deweyNumber: item.classification?.number || "",
        deweyClass: item.classification?.label || "",
        callNumber: callNumberFor({ title: item.title, author: item.author, classification: item.classification }),
        confidence: item.classification?.confidence || "",
        classificationDetails: classificationDetailsFor({
          title: item.title,
          author: item.author,
          format: item.format,
          originalFilename: item.originalFilename,
          categoryName: item.categoryName,
          classification: item.classification
        }),
        bibliography: item.bibliography || "",
        filename: item.originalFilename || ""
      };
    });
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv(rows) {
  const headers = ["No", "Title", "Author", "Type", "Format", "Category", "Dewey Number", "Dewey Class", "Call Number", "Confidence", "Classification Details", "Bibliography", "Filename"];
  const keys = ["no", "title", "author", "type", "format", "category", "deweyNumber", "deweyClass", "callNumber", "confidence", "classificationDetails", "bibliography", "filename"];
  return [headers.map(escapeCsv).join(","), ...rows.map((row) => keys.map((key) => escapeCsv(row[key])).join(","))].join("\r\n");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function exportHtml(rows) {
  const bodyRows = rows.map((row) => `
    <tr>
      <td>${row.no}</td>
      <td>${escapeHtml(row.title)}</td>
      <td>${escapeHtml(row.author)}</td>
      <td>${escapeHtml(row.type)}</td>
      <td>${escapeHtml(row.format)}</td>
      <td>${escapeHtml(row.category)}</td>
      <td><strong>${escapeHtml(row.callNumber)}</strong><br>${escapeHtml(row.deweyNumber)} ${escapeHtml(row.deweyClass)}<br><span>${escapeHtml(row.confidence)}</span></td>
      <td>${escapeHtml(row.classificationDetails)}</td>
      <td>${escapeHtml(row.bibliography)}</td>
      <td>${escapeHtml(row.filename)}</td>
    </tr>
  `).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AGBS Library Classification and Bibliography</title>
  <style>
    body { font-family: Arial, sans-serif; color: #17202a; margin: 24px; }
    h1 { color: #084d47; margin-bottom: 4px; }
    .summary { color: #53616f; margin-top: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
    th, td { border: 1px solid #d9e0e6; padding: 7px; vertical-align: top; text-align: left; overflow-wrap: anywhere; }
    th { background: #eef8f6; }
    th:nth-child(1), td:nth-child(1) { width: 34px; }
    th:nth-child(2), td:nth-child(2) { width: 14%; }
    th:nth-child(7), td:nth-child(7) { width: 13%; }
    th:nth-child(8), td:nth-child(8) { width: 22%; }
    th:nth-child(9), td:nth-child(9) { width: 22%; }
  </style>
</head>
<body>
  <h1>AGBS Library Classification and Bibliography</h1>
  <p class="summary">Generated ${new Date().toLocaleString("en-IN")}. Total books: ${rows.length}.</p>
  <table>
    <thead><tr><th>No</th><th>Title</th><th>Author</th><th>Type</th><th>Format</th><th>Category</th><th>Dewey / Call No.</th><th>Book Classification Details</th><th>Bibliography</th><th>File</th></tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</body>
</html>`;
}

function exportPdf(rows) {
  const lines = ["AGBS Library Classification and Bibliography", `Generated ${new Date().toLocaleString("en-IN")}`, ""];
  for (const row of rows) {
    lines.push(`${row.no}. ${row.title}`);
    if (row.author) lines.push(`   Author: ${row.author}`);
    lines.push(`   ${row.type} | ${row.format} | ${row.category}`);
    lines.push(`   Call no.: ${row.callNumber} | Dewey ${row.deweyNumber} ${row.deweyClass}`);
    lines.push(`   ${row.classificationDetails}`);
    lines.push(`   ${row.bibliography}`);
    lines.push("");
  }
  return simplePdf(lines);
}

function simplePdf(lines) {
  const objects = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const pageIds = [];
  const perPage = 42;
  const escaped = (value) => String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  for (let pageIndex = 0; pageIndex < Math.max(1, Math.ceil(lines.length / perPage)); pageIndex++) {
    const pageLines = lines.slice(pageIndex * perPage, (pageIndex + 1) * perPage);
    let y = 760;
    const content = ["BT", "/F1 10 Tf", "50 780 Td"];
    for (const line of pageLines) {
      content.push(`1 0 0 1 50 ${y} Tm (${escaped(line).slice(0, 120)}) Tj`);
      y -= 17;
    }
    content.push("ET");
    const contentId = objects.length + 1;
    objects.push(`<< /Length ${Buffer.byteLength(content.join("\n"))} >>\nstream\n${content.join("\n")}\nendstream`);
    const pageId = objects.length + 1;
    pageIds.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const ordered = objects.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of ordered) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${ordered.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${ordered.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

function classifiedResource(resource, categories) {
  const category = categories.find((item) => item.id === resource.categoryId) || null;
  const title = resource.title || path.basename(resource.originalFilename || "Untitled", path.extname(resource.originalFilename || ""));
  const author = cleanAuthorName(resource.author) || inferAuthor(resource.originalFilename || title);
  const classification = resource.classification || classifyResource({ title, originalFilename: resource.originalFilename, category });
  const bibliography = buildBibliography({ title, author, format: resource.format, originalFilename: resource.originalFilename, category, classification });
  return {
    ...resource,
    title,
    author,
    resourceType: resource.resourceType || "E-book",
    categoryName: displayCategoryName(category),
    classification,
    bibliography
  };
}

function displayCategoryName(category) {
  if (!category) return "";
  return category.parentName ? `${category.parentName} / ${category.name}` : category.name;
}

function buildSkippedUpload({ file, reason, user, batch, hash }) {
  return {
    filename: file.filename,
    normalizedFilename: normalizeFilename(file.filename),
    reason: reason || "Skipped by upload validation",
    uploadBatchId: batch.id,
    createdBy: user.id,
    size: file.content.length,
    contentType: file.contentType,
    hash,
    checked: false
  };
}

async function recordSkippedUpload({ file, reason, user, batch, hash }) {
  return await db.insert("skippedUploads", buildSkippedUpload({ file, reason, user, batch, hash }));
}

async function replaceResourceFile(resource, file, user) {
  const extension = resourceExtensionFor(file);
  if (!allowedResourceExtensions.includes(extension)) throw new Error("Choose a supported PDF or EPUB file.");
  const existingResources = await db.all("resources");
  const hash = fileHash(file.content);
  const duplicate = existingResources.find((item) => item.id !== resource.id && item.metadata?.hash === hash);
  if (duplicate) throw new Error(`Exact duplicate already exists: ${duplicate.title || duplicate.originalFilename || "same file"}.`);
  const storageName = `${crypto.randomUUID()}${extension}`;
  if (typeof db.saveFile === "function") {
    await db.saveFile(storageName, file.content, { originalFilename: file.filename, contentType: file.contentType });
  } else {
    await fs.writeFile(path.join(STORAGE_DIR, storageName), file.content);
  }
  await removeStoredFile(resource.storageName);
  const title = inferTitle(file.filename);
  const author = inferAuthor(file.filename);
  const categories = await db.all("categories");
  const category = categories.find((item) => item.id === resource.categoryId) || null;
  const classification = classifyResource({ title, originalFilename: file.filename, category });
  return await db.update("resources", resource.id, {
    title,
    author,
    format: extension.slice(1),
    resourceType: "E-book",
    originalFilename: file.filename,
    storageName,
    status: "published",
    classification,
    bibliography: buildBibliography({ title, author, format: extension.slice(1), originalFilename: file.filename, category, classification }),
    updatedBy: user.id,
    inlineContent: shouldInlineFiles() && file.content.length <= INLINE_FILE_LIMIT ? file.content.toString("base64") : undefined,
    metadata: { size: file.content.length, contentType: file.contentType, hash, duplicateCheck: "exact-hash" }
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

function normalizeCategoryText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compactCategoryText(value) {
  return normalizeCategoryText(value).replace(/\s+/g, "");
}

function categoryForFile(filename, categories) {
  const raw = String(filename || "");
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  const normalizedSegments = segments.map(normalizeCategoryText);
  for (const category of categories) {
    const categoryCompact = compactCategoryText(category.name);
    const direct = normalizedSegments.some((segment) => {
      const segmentCompact = compactCategoryText(segment);
      return segmentCompact === categoryCompact || segmentCompact.includes(categoryCompact) || categoryCompact.includes(segmentCompact);
    });
    if (direct) return category;
  }
  const suggested = categorySuggestion(raw);
  return categories.find((item) => compactCategoryText(item.name) === compactCategoryText(suggested)) || null;
}

function categorySuggestion(name) {
  const lower = normalizeCategoryText(name);
  const compact = compactCategoryText(name);
  const includes = (word) => lower.includes(normalizeCategoryText(word)) || compact.includes(compactCategoryText(word));
  const rules = [
    ["Old Testament", ["old testament", "oldtestament", "genesis", "exodus", "leviticus", "numbers", "deuteronomy", "psalm", "isaiah", "jeremiah", "ezekiel", "hebrew bible"]],
    ["New Testament", ["new testament", "newtestament", "gospel", "matthew", "mark", "luke", "john", "acts", "paul", "romans", "corinthians", "revelation"]],
    ["Christian Theology", ["christian theology", "theology", "systematic theology", "doctrine", "christology", "pneumatology", "ecclesiology", "trinity", "atonement", "soteriology"]],
    ["History of Christianity", ["history of christianity", "history christianity", "history of christnaity", "history of christian", "church history", "christian history", "patristic", "reformation", "medieval", "ancient church", "historical theology"]],
    ["Christian Ministry", ["christian ministry", "ministry", "pastoral", "counsel", "counseling", "care", "chaplain", "grief", "preaching", "homiletic", "worship", "leadership"]],
    ["Missiology", ["mission", "missions", "missiology", "evangel", "church planting", "missionary"]],
    ["Communication", ["communication", "media", "journalism", "public speaking", "writing", "broadcast", "speech"]],
    ["Christian Ethics", ["christian ethics", "ethics", "moral", "bioethics", "justice", "virtue", "rights"]],
    ["Religions", ["religion", "religions", "hindu", "hinduism", "islam", "muslim", "buddhist", "buddhism", "interfaith", "comparative religion"]],
    ["Social Analysis", ["social", "society", "analysis", "politic", "politics", "econom", "caste", "culture", "development", "sociology"]],
    ["Women Studies", ["women", "woman", "gender", "feminist", "feminism", "womanist"]],
    ["Research Methodology", ["research methodology", "research method", "research methods", "methodology", "thesis", "dissertation", "academic writing", "citation", "bibliography"]],
    ["Music", ["music", "hymn", "hymns", "hymnology", "choir", "song", "songs", "worship music"]],
    ["Homiletics", ["homiletic", "homiletics", "preaching", "sermon", "sermons", "expository preaching"]],
    ["Pastoral Care and Counselling", ["pastoral care", "pastoral counselling", "pastoral counseling", "counselling", "counseling", "chaplain", "grief"]],
    ["Greek", ["greek", "biblical greek", "koine", "koine greek"]],
    ["Hebrew", ["hebrew", "biblical hebrew", "old testament hebrew"]],
    ["English", ["english", "english language", "grammar", "composition"]],
    ["Languages", ["language", "languages", "language studies", "linguistics", "translation", "lexicon", "dictionary"]]
  ];
  return rules.find(([, words]) => words.some(includes))?.[0] || "";
}

function fieldValue(parts, name, fallback = "") {
  const part = parts.find((item) => item.name === name && !item.filename);
  return part ? part.content.toString("utf8") : fallback;
}

async function seed() {
  let existingCategories = await db.all("categories");
  for (let index = 0; index < defaultCategoryDefinitions.length; index++) {
    const definition = defaultCategoryDefinitions[index];
    const name = definition.name;
    const existing = existingCategories.find((category) => category.name === name || category.slug === slug(name));
    const base = { name, slug: slug(name), order: index, archived: false, parentName: definition.parentName || "", parentId: "" };
    if (existing) {
      await db.update("categories", existing.id, base);
    } else {
      await db.insert("categories", base);
    }
  }
  existingCategories = await db.all("categories");
  for (const definition of defaultCategoryDefinitions.filter((item) => item.parentName)) {
    const child = existingCategories.find((category) => category.name === definition.name || category.slug === slug(definition.name));
    const parent = existingCategories.find((category) => category.name === definition.parentName || category.slug === slug(definition.parentName));
    if (child && parent) await db.update("categories", child.id, { parentId: parent.id, parentName: parent.name });
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
  await removeUnsupportedResourceFiles();
}

async function removeUnsupportedResourceFiles() {
  const resources = await db.all("resources");
  for (const resource of resources) {
    const extension = resourceExtensionFor({ filename: resource.originalFilename || resource.storageName || "", contentType: resource.metadata?.contentType || "" });
    const format = String(resource.format || "").toLowerCase();
    if (allowedResourceExtensions.includes(extension) || ["pdf", "epub"].includes(format)) continue;
    await removeStoredFile(resource.storageName);
    await db.delete("resources", resource.id);
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.socket?.remoteAddress || "").split(",")[0].trim();
}

async function routeApi(req, res, url) {
  const user = await currentUser(req);

  if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, { user: publicUser(user) });

  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      googleConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
      awsConfigured: Boolean(AWS_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && AWS_S3_BUCKET),
      storageProvider: AWS_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && AWS_S3_BUCKET ? "aws-s3" : "local-json",
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
      ip: requestIp(req),
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
    const terms = query.split(/\s+/).filter(Boolean);
    const category = url.searchParams.get("category");
    const limit = Math.max(0, Math.min(200, Number(url.searchParams.get("limit") || 0)));
    const sort = url.searchParams.get("sort");
    const categories = await db.all("categories");
    const selectedCategory = category ? categories.find((item) => item.id === category) : null;
    const categoryIds = selectedCategory
      ? new Set([selectedCategory.id, ...categories.filter((item) => item.parentId === selectedCategory.id || item.parentName === selectedCategory.name).map((item) => item.id)])
      : null;
    let resources = (await db.all("resources")).filter((item) => {
      if (!isStaff(user) && item.status !== "published") return false;
      if (categoryIds && !categoryIds.has(item.categoryId)) return false;
      if (terms.length) {
        const resourceCategory = categories.find((entry) => entry.id === item.categoryId);
        const classified = classifiedResource(item, categories);
        const haystack = `${classified.title || ""} ${classified.author || ""} ${classified.format || ""} ${classified.originalFilename || ""} ${displayCategoryName(resourceCategory)} ${classified.classification?.number || ""} ${classified.classification?.label || ""} ${classified.bibliography || ""}`.toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) return false;
      }
      return true;
    });
    if (sort === "recent") resources = resources.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
    if (limit) resources = resources.slice(0, limit);
    return json(res, 200, { resources: resources.map((resource) => publicResource(classifiedResource(resource, categories))) });
  }

  if (req.method === "GET" && url.pathname === "/api/resources-summary") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const resources = await db.all("resources");
    const categories = await db.all("categories");
    const counts = resources.reduce((result, resource) => {
      result.total += 1;
      result.byCategory[resource.categoryId || ""] = (result.byCategory[resource.categoryId || ""] || 0) + 1;
      return result;
    }, { total: 0, byCategory: {} });
    const recentResources = resources
      .slice()
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
      .slice(0, 25)
      .map((resource) => publicResource(classifiedResource(resource, categories)));
    return json(res, 200, { counts, recentResources });
  }

  if (req.method === "GET" && url.pathname === "/api/catalog-export") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const format = String(url.searchParams.get("format") || "html").toLowerCase();
    const categories = await db.all("categories");
    const rows = exportRows(await db.all("resources"), categories);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "csv") return download(res, `agbs-classification-bibliography-${stamp}.csv`, "text/csv; charset=utf-8", exportCsv(rows));
    if (format === "xls") return download(res, `agbs-classification-bibliography-${stamp}.xls`, "application/vnd.ms-excel; charset=utf-8", exportHtml(rows));
    if (format === "doc") return download(res, `agbs-classification-bibliography-${stamp}.doc`, "application/msword; charset=utf-8", exportHtml(rows));
    if (format === "pdf") return download(res, `agbs-classification-bibliography-${stamp}.pdf`, "application/pdf", exportPdf(rows));
    return download(res, `agbs-classification-bibliography-${stamp}.html`, "text/html; charset=utf-8", exportHtml(rows));
  }

  if (req.method === "GET" && url.pathname === "/api/storage-usage") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const usage = typeof db.storageUsage === "function" ? await db.storageUsage() : {};
    const usedGb = Number(usage.totalBytes || 0) / 1_000_000_000;
    const bookGb = Number(usage.bookBytes || 0) / 1_000_000_000;
    const budgetGb = Number.isFinite(AWS_STORAGE_BUDGET_GB) && AWS_STORAGE_BUDGET_GB > 0 ? AWS_STORAGE_BUDGET_GB : 0;
    const planMonths = Number.isFinite(AWS_STORAGE_PLAN_MONTHS) && AWS_STORAGE_PLAN_MONTHS > 0 ? AWS_STORAGE_PLAN_MONTHS : 12;
    const runwayBaseGb = usedGb >= 0.01 ? usedGb : 0;
    const runwayMonths = budgetGb && runwayBaseGb ? (budgetGb * planMonths) / runwayBaseGb : null;
    return json(res, 200, {
      ...usage,
      usedGb,
      bookGb,
      budgetGb,
      planMonths,
      remainingGb: budgetGb ? Math.max(0, budgetGb - usedGb) : null,
      runwayMonths,
      usagePercent: budgetGb ? Math.min(100, (usedGb / budgetGb) * 100) : null,
      updatedAt: new Date().toISOString()
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/resources/")) {
    const id = url.pathname.split("/").pop();
    const resource = await db.findOne("resources", (item) => item.id === id && (item.status === "published" || isStaff(user)));
    if (!resource) return json(res, 404, { error: "Resource not found." });
    const categories = await db.all("categories");
    return json(res, 200, { resource: publicResource(classifiedResource(resource, categories)) });
  }

  if (req.method === "POST" && url.pathname === "/api/resources/upload-token") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    return json(res, 200, { uploadToken: makeUploadToken(user), expiresInHours: 12 });
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
    if (!saved.length && !skipped.length) return json(res, 400, { error: "No supported PDF or EPUB files were found in that upload." });
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
    if (!saved.length && !skipped.length) return json(res, 400, { error: "No supported PDF or EPUB files were found in that upload." });
    return json(res, 201, { resources: saved.map(publicResource), skipped });
  }

  if (req.method === "POST" && url.pathname === "/api/resources/upload-zip-start") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const body = await bodyJson(req);
    const uploadId = safeChunkName(body.uploadId);
    const meta = body.file || {};
    const fileIndex = safeChunkName(meta.fileIndex);
    const totalChunks = Number(meta.totalChunks || 0);
    const filename = String(meta.filename || "upload.zip");
    if (!uploadId || !fileIndex || !totalChunks) return json(res, 400, { error: "Missing ZIP upload details." });
    const buffers = [];
    for (let index = 0; index < totalChunks; index++) {
      const chunk = await readUploadChunk(uploadId, fileIndex, index);
      if (!chunk) return json(res, 400, { error: `Missing ZIP chunk ${index + 1} for ${filename}. Please try the upload again.` });
      buffers.push(chunk);
    }
    const zipBuffer = Buffer.concat(buffers);
    await saveUploadZip(uploadId, zipBuffer);
    const entries = await zipEntries(zipBuffer);
    if (!entries.length) {
      await removeUploadChunks(uploadId);
      return json(res, 400, { error: "No files were found inside that ZIP." });
    }
    const batch = await db.insert("uploadBatches", { createdBy: user.id, fileCount: entries.length, status: "processing", uploadMode: "zip-progressive", originalFilename: filename });
    return json(res, 201, { uploadId, batchId: batch.id, totalEntries: entries.length });
  }

  if (req.method === "POST" && url.pathname === "/api/resources/upload-zip-entry") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const body = await bodyJson(req);
    const uploadId = safeChunkName(body.uploadId);
    const batchId = String(body.batchId || "");
    const entryIndex = Number(body.entryIndex);
    const autoCategorize = body.autoCategorize !== false;
    const categories = await db.all("categories");
    const selectedCategory = categories.find((item) => item.id === body.targetCategoryId) || categories[0];
    const batch = await db.findOne("uploadBatches", (item) => item.id === batchId);
    if (!uploadId || !batch || !Number.isInteger(entryIndex) || entryIndex < 0) return json(res, 400, { error: "Missing ZIP entry details." });
    const zipBuffer = await readUploadZip(uploadId);
    if (!zipBuffer) return json(res, 404, { error: "Temporary ZIP was not found. Please upload it again." });
    const { totalEntries, file } = await zipEntryAt(zipBuffer, entryIndex);
    if (!file) return json(res, 404, { error: "ZIP entry was not found." });
    const { saved, skipped } = await saveUploadedResources({ files: [file], categories, selectedCategory, autoCategorize, user, batch });
    const done = entryIndex + 1 >= totalEntries;
    if (done) {
      await db.update("uploadBatches", batch.id, { status: "processed" });
      await removeUploadChunks(uploadId);
    }
    return json(res, 201, { resources: saved.map(publicResource), skipped, entryName: file.filename, entryIndex, totalEntries, done });
  }

  if (req.method === "GET" && url.pathname === "/api/skipped-uploads") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const skipped = (await db.all("skippedUploads")).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json(res, 200, { skipped });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/skipped-uploads/")) {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const id = url.pathname.split("/").pop();
    const removed = await db.delete("skippedUploads", id);
    if (!removed) return json(res, 404, { error: "Skipped upload record not found." });
    return json(res, 200, { ok: true });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/resources/")) {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const id = url.pathname.split("/").pop();
    const body = await bodyJson(req);
    const existing = await db.findOne("resources", (item) => item.id === id);
    if (!existing) return json(res, 404, { error: "Resource not found." });
    const patch = {};
    for (const key of ["title", "author", "categoryId", "status"]) if (body[key] !== undefined) patch[key] = body[key];
    if (patch.title !== undefined || patch.author !== undefined || patch.categoryId !== undefined) {
      const categories = await db.all("categories");
      const next = { ...existing, ...patch };
      const category = categories.find((item) => item.id === next.categoryId) || null;
      patch.classification = classifyResource({ title: next.title, originalFilename: next.originalFilename, category });
      patch.bibliography = buildBibliography({ title: next.title, author: next.author, format: next.format, originalFilename: next.originalFilename, category, classification: patch.classification });
      const updated = await db.update("resources", id, patch);
      return json(res, 200, { resource: publicResource(classifiedResource(updated, categories)) });
    }
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
    const temporaryPassword = generateTemporaryPassword(body.name, email);
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

  if (req.method === "POST" && url.pathname.match(/^\/api\/users\/[^/]+\/reset-password$/)) {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const id = url.pathname.split("/")[3];
    const target = await db.findOne("users", (item) => item.id === id);
    if (!target) return json(res, 404, { error: "User not found." });
    if (!["student", "director", "admin"].includes(target.role)) return json(res, 400, { error: "This user cannot be reset." });
    const temporaryPassword = generateTemporaryPassword(target.name, target.email);
    const updated = await db.update("users", id, {
      passwordHash: hashPassword(temporaryPassword),
      provider: "password",
      active: true,
      removedAt: null,
      removedBy: null,
      temporaryPasswordSetAt: new Date().toISOString()
    });
    return json(res, 200, { user: publicUser(updated), temporaryPassword });
  }

  if (req.method === "GET" && url.pathname === "/api/reports") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const users = await db.all("users");
    const logins = await db.all("loginSessions");
    const reads = await db.all("readingSessions");
    return json(res, 200, { users: users.map(publicUser), logins, reads });
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
    ip: requestIp(req),
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
