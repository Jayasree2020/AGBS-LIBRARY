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

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.collections = ["users", "categories", "resources", "uploadBatches", "loginSessions", "readingSessions", "accessEvents"];
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
    const { MongoClient } = await import("mongodb");
    this.client = new MongoClient(this.uri);
    await this.client.connect();
    this.db = this.client.db(this.databaseName || "seminary_library");
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

  async findOne(collection, predicate) {
    return (await this.all(collection)).find(predicate) || null;
  }

  async filter(collection, predicate) {
    return (await this.all(collection)).filter(predicate);
  }
}

async function createStore() {
  if (process.env.MONGODB_URI) return new MongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB);
  return new JsonStore(DATA_DIR);
}

const db = await createStore();

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
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
        filename: path.basename(entry.entryName),
        contentType: mimeTypes[path.extname(entry.entryName).toLowerCase()] || "application/octet-stream",
        content: entry.getData()
      }));
  } catch {
    throw new Error("ZIP support needs dependencies installed. Run npm install in the deployment environment.");
  }
}

function isStaff(user) {
  return user && ["admin", "director"].includes(user.role);
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
  return rules.find(([, words]) => words.some((word) => lower.includes(word)))?.[0] || "Christian Theology";
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
    return json(res, 200, { resources });
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
    const saved = [];
    for (const file of files) {
      const extension = path.extname(file.filename).toLowerCase();
      if (!allowedResourceExtensions.includes(extension)) continue;
      const suggested = categorySuggestion(file.filename);
      const category = autoCategorize ? (categories.find((item) => item.name === suggested) || selectedCategory) : selectedCategory;
      const storageName = `${crypto.randomUUID()}${extension}`;
      await fs.writeFile(path.join(STORAGE_DIR, storageName), file.content);
      const title = path.basename(file.filename, extension).replace(/[_-]+/g, " ").trim();
      saved.push(await db.insert("resources", {
        title,
        author: "",
        format: extension.slice(1),
        originalFilename: file.filename,
        storageName,
        categoryId: category?.id || "",
        suggestedCategory: suggested,
        uploadMode: autoCategorize ? "auto" : "category",
        status: "pending",
        uploadBatchId: batch.id,
        createdBy: user.id,
        metadata: { size: file.content.length, contentType: file.contentType }
      }));
    }
    return json(res, 201, { resources: saved });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/resources/")) {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const id = url.pathname.split("/").pop();
    const body = await bodyJson(req);
    const patch = {};
    for (const key of ["title", "author", "categoryId", "status"]) if (body[key] !== undefined) patch[key] = body[key];
    return json(res, 200, { resource: await db.update("resources", id, patch) });
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const body = await bodyJson(req);
    const email = String(body.email || "").toLowerCase();
    if (!email || !body.password) return json(res, 400, { error: "Email and password are required." });
    const created = await db.insert("users", {
      email,
      name: body.name || email,
      role: ["student", "admin", "director"].includes(body.role) ? body.role : "student",
      passwordHash: hashPassword(body.password),
      provider: "password",
      active: true
    });
    return json(res, 201, { user: publicUser(created) });
  }

  if (req.method === "GET" && url.pathname === "/api/reports") {
    if (!isStaff(user)) return json(res, 403, { error: "Admin access required." });
    const users = await db.all("users");
    const logins = await db.all("loginSessions");
    const reads = await db.all("readingSessions");
    const resources = await db.all("resources");
    return json(res, 200, { users: users.map(publicUser), logins, reads, resources });
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
  if (!existsSync(filePath)) return send(res, 404, "Missing file");
  const extension = path.extname(resource.storageName);
  res.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Content-Disposition": `inline; filename="${resource.title.replace(/"/g, "")}${extension}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff"
  });
  createReadStream(filePath).pipe(res);
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
