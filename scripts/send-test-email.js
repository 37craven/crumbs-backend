// Sends one real message so you can confirm SMTP works before wiring it into
// the app. Usage:
//
//   npm run mail:test you@example.com
//
// Reads SMTP_* from .env. With no SMTP_HOST it says so and stops, rather than
// pretending the console fallback counts as a successful send.

process.loadEnvFile();

const { isMailConfigured, MAIL_FROM, SMTP_HOST, SMTP_PORT, PUBLIC_URL } = require("../config/mail");
const { sendMail } = require("../services/mailer");

const to = process.argv[2];

if (!to) {
  console.error("Usage: npm run mail:test you@example.com");
  process.exit(1);
}

if (!isMailConfigured()) {
  console.error("SMTP is not configured.");
  console.error("Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD in .env, then run this again.");
  console.error("See the Email (SMTP) section of .env.example for common providers.");
  process.exit(1);
}

(async () => {
  console.log(`From:    ${MAIL_FROM}`);
  console.log(`Server:  ${SMTP_HOST}:${SMTP_PORT}`);
  console.log(`To:      ${to}`);
  console.log(`Link in: ${PUBLIC_URL}`);
  console.log("Sending…");

  const { sent } = await sendMail({
    to,
    subject: "Crumbs: SMTP works",
    text:
      "This is a test message from Crumbs.\n\n" +
      "If you can read it, email sending is configured correctly.\n" +
      "Nothing else is needed; no account was created.\n",
  });

  if (!sent) {
    console.error("\nSending failed. Check SMTP_HOST, SMTP_PORT, SMTP_SECURE and the credentials.");
    console.error("Gmail and some providers require an APP PASSWORD rather than your account password.");
    process.exit(1);
  }

  console.log(`\nSent. Check ${to} (and the spam folder).`);
})();
