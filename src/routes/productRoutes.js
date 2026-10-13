import { Hono } from 'hono';
import { createHome,commonDelete,shiftDevices,syncUserSession,createProductSubmission,getSubmissionByMobile,AIassist,addMember,updateEntity } from '../controllers/productController.js';

const productRouter = new Hono();

// POST endpoint mapping
productRouter.post('/home', createHome);
productRouter.delete('/delete', commonDelete);
productRouter.post('/shift-devices', shiftDevices);
productRouter.post('/session', syncUserSession);

productRouter.post('/submit', createProductSubmission);
productRouter.put('/update', updateEntity);

productRouter.post('/member', addMember);

productRouter.get('/search', getSubmissionByMobile);

productRouter.post('/ai', AIassist);

export default productRouter;