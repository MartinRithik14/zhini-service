import { MongoClient, Binary, ObjectId } from 'mongodb';

export { Binary, ObjectId };

let client = null;
let clientPromise = null;

const getConnectedClient = async (uri) => {
  // 1. Return active client if already connected and ready
  if (client) {
    return client;
  }

  // 2. If a connection is not already in progress, initialize the promise
  if (!clientPromise) {
    console.log("🐘 MongoDB: Initializing Persistent Connection Pool for Zhini...");
    const newClient = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 2,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 5000,
    });

    // Store the PROMISE so simultaneous calls wait for the exact same connection
    clientPromise = newClient.connect().then((connectedClient) => {
      client = connectedClient;
      return client;
    }).catch((err) => {
      // Reset if connection totally fails so subsequent requests can try again
      client = null;
      clientPromise = null;
      throw err;
    });
  }

  // 3. Return the resolving promise
  return clientPromise;
};

export const withDatabase = async (uri, callback) => {
  try {
    const activeClient = await getConnectedClient(uri);
    const db = activeClient.db("zhini-dev");
    
    return await callback(db);
    
  } catch (error) {
    // If the connection pool drops or disconnects, safely clear the cache
    if (
      error.name === 'MongoTopologyClosedError' ||
      error.name === 'MongoServerSelectionError' ||
      error.name === 'MongoNetworkError'
    ) {
      console.warn("⚠️ Resetting MongoDB connection pool cache after network/topology error...");
      client = null;
      clientPromise = null;
    }
    
    console.error("❌ MongoDB Operation Error:", error.message);
    throw error;
  }
};