const mongoose = require("mongoose");
const { assertSafeDatabase } = require("./database");

if (!globalThis.__crumbsMongoose) {
  globalThis.__crumbsMongoose = { connection: null, promise: null };
}
const cached = globalThis.__crumbsMongoose;

async function connectDB() {
  if (cached.connection) return cached.connection;

  const uri = process.env.MONGODB_URI;
  const dbName = assertSafeDatabase(uri);

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(uri, { serverSelectionTimeoutMS: 8000 })
      .then((instance) => {
        console.log(`Connected to MongoDB (${dbName})`);
        return instance;
      })
      .catch((err) => {
        cached.promise = null;
        throw err;
      });
  }

  cached.connection = await cached.promise;
  return cached.connection;
}

module.exports = { connectDB };
