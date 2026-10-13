import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { requireAuth } from "./src/middleware/authMiddleware.js";
import { rateLimiter } from "./src/middleware/rateLimiter.js"; // 👈 1. Import rate limiter
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import fs from 'fs';

// 🔑 DYNAMIC SERVICE ACCOUNT INITIALIZATION
let firebaseCredential;
let detectedProjectId;

try {
  let rawKey = null;

  if (fs.existsSync('./firebase-key.json')) {
    rawKey = fs.readFileSync('./firebase-key.json', 'utf8');
    console.log("🔑 Using Root Service Account Key File (firebase-key.json).");
  } else if (fs.existsSync('/app/firebase-key.json')) {
    rawKey = fs.readFileSync('/app/firebase-key.json', 'utf8');
    console.log("🔑 Using Docker Service Account Key File (/app/firebase-key.json).");
  }

  if (rawKey) {
    const parsedKey = JSON.parse(rawKey);
    firebaseCredential = cert(parsedKey);
    detectedProjectId = parsedKey.project_id;
  } else {
    firebaseCredential = applicationDefault();
    console.log("☁️ Falling back to Workload Identity Federation.");
  }
} catch (err) {
  console.error("⚠️ Error loading Firebase credentials:", err.message);
  firebaseCredential = applicationDefault();
}

// 🎯 Initialize Firebase Admin with dynamic credentials and project ID
if (!getApps().length) {
  initializeApp({
    credential: firebaseCredential,
    ...(detectedProjectId ? { projectId: detectedProjectId } : {})
  });
  console.log(`✅ Firebase Admin initialized for project: ${detectedProjectId || 'Default'}`);
}

import productRouter from './src/routes/productRoutes.js';
import serviceRouter from './src/routes/serviceRoutes.js';
import crashRouter from './src/routes/crashRoutes.js';

const app = new Hono();

// 1. CORS first to handle preflight headers
app.use('*', cors());

// 2. Health check (kept open for monitoring checks)
app.get('/', (c) => c.json({ status: 'ok', message: 'ZHINI API Live' }));

// 🛑 3. Global Rate Limiter: Protects all subsequent API routes
app.use('*', rateLimiter);

// 🛡️ 4. Global Auth Gatekeeper Middleware


app.route('/product', productRouter);
app.route('/service', serviceRouter);
app.route('/crash', crashRouter);

// Prevent socket drops on missing routes
app.notFound((c) => {
  return c.json({ success: false, message: `Route not found: ${c.req.url}` }, 404);
});

// Prevent socket drops on unhandled exceptions
app.onError((err, c) => {
  console.error('Unhandled Server Error:', err);
  return c.json({ success: false, message: err.message || 'Internal Server Error' }, 500);
});

const port = Number(process.env.PORT) || 5000;

serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0'
}, (info) => {
  console.log(`🚀 ZHINI Backend Live on 0.0.0.0:${info.port}`);
});