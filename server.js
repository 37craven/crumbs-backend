try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const app = require("./app");
const { connectDB } = require("./config/connection");

const PORT = process.env.PORT ?? 3000;

if (process.env.VERCEL) {
  module.exports = app;
} else {
  connectDB()
    .then(() => {
      app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error("Connection failed: ", err.message);
      process.exit(1);
    });
}
