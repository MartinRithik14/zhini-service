import { Hono } from 'hono';
import { createHome,getBanners,getTemplate,commonDelete,deleteAccount,shiftDevices,syncUserSession,createProductSubmission,getSubmissionByMobile,AIassist,addMember,updateEntity } from '../controllers/productController.js';

const productRouter = new Hono();

// POST endpoint mapping
productRouter.post('/home', createHome);
productRouter.get('/banners', getBanners);
productRouter.get('/template/:id', getTemplate);

productRouter.delete('/delete', commonDelete);
productRouter.delete('/delete-account', deleteAccount);

productRouter.post('/shift-devices', shiftDevices);
productRouter.post('/session', syncUserSession);

productRouter.post('/submit', createProductSubmission);
productRouter.put('/update', updateEntity);

productRouter.post('/member', addMember);

productRouter.get('/search', getSubmissionByMobile);

productRouter.post('/ai', AIassist);

export default productRouter;