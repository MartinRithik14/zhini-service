import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';

import productRouter from './src/routes/productRoutes.js';
import serviceRouter from './src/routes/serviceRoutes.js';

const app = new Hono();

app.use('*', cors());

// Root health check
app.get('/', (c) => c.json({ status: 'ok', message: 'ZHINI API Live' }));

app.route('/product', productRouter);
app.route('/service', serviceRouter);

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