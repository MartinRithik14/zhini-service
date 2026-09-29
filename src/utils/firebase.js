import { getAuth } from 'firebase-admin/auth';

export const verifyFirebaseToken = async (token) => {
  return await getAuth().verifyIdToken(token);
};