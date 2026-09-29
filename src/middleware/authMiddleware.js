import { withDatabase } from '../utils/config.js';

const MONGODB_URI = process.env.MONGODB_URI;

// Routes that bypass authentication completely
const PUBLIC_ROUTES = [
  '/',
  '/health',
  '/api/auth/login',
  '/api/auth/verify-otp',
  '/api/webhooks'
];

export const requireAuth = async (c, next) => {
  const currentPath = c.req.path;

  // 1. Bypass whitelist routes
  const isPublic = PUBLIC_ROUTES.some((route) => {
    if (route.endsWith('*')) {
      return currentPath.startsWith(route.slice(0, -1));
    }
    return currentPath === route;
  });

  if (isPublic) {
    return await next();
  }

  try {
    // 2. Read authentication headers
    const incomingToken = c.req.header('x-auth-token') || 
                          c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    const mobile = c.req.header('x-user-phone') || c.req.header('x-phone-no');

    // 3. Reject if either header is missing
    if (!incomingToken) {
      return c.json({ error: "Unauthorized: Missing authentication token ('x-auth-token')" }, 401);
    }
    if (!mobile) {
      return c.json({ error: "Unauthorized: Missing user phone ('x-user-phone')" }, 401);
    }

    const cleanMobile = mobile.trim();
    const numMobile = Number(cleanMobile);

    // 4. Check MongoDB 'users' collection for matching mobile & active device token
    return await withDatabase(MONGODB_URI, async (db) => {
      const user = await db.collection("users").findOne({
        $and: [
          {
            $or: [
              { mobile: cleanMobile },
              { mobile: isNaN(numMobile) ? cleanMobile : numMobile },
              { "UserInfo.phoneNo": cleanMobile }
            ]
          },
          {
            $or: [
              { "PlatformInfo.devices.authToken": incomingToken },
              { "PlatformInfo.devices": { $elemMatch: { authToken: incomingToken } } }
            ]
          }
        ]
      });

      if (!user) {
        return c.json({ 
          error: "Unauthorized: Invalid or expired session. Please re-login." 
        }, 401);
      }

      // 5. Attach verified user profile and identity to context
      c.set('user', user);
      c.set('userId', user._id.toString());
      c.set('userMobile', cleanMobile);

      // 6. Proceed to route handler
      await next();
    });
  } catch (err) {
    console.error("❌ requireAuth Middleware Error:", err);
    return c.json({ error: "Internal Auth Error", details: err.message }, 500);
  }
};