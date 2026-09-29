import { Hono } from 'hono';
import { addcrash } from '../controllers/crashController.js';

const crashRoutes = new Hono();

crashRoutes.post('/add', addcrash);



export default crashRoutes;
