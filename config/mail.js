// SMTP settings for outgoing mail, read from the environment.
//
// Nothing here is a secret except SMTP_PASSWORD, which lives in .env (that file
// is git-ignored). Host, port and security are usually all a provider tells you
// on a settings page.
//
// Common providers:
//   Gmail / Google Workspace : smtp.gmail.com   587  secure=false
//   Outlook / Hotmail        : smtp.office365.com 587 secure=false
//   Yahoo                    : smtp.mail.yahoo.com  587 secure=false
//   Mailgun                  : smtp.mailgun.org    587 secure=false
//   Amazon SES               : email-smtp.<region>.amazonaws.com 587 secure=false
//   Local debugging (MailHog) : localhost          1025 secure=false
//
// Port 465 means implicit TLS (secure=true); 587 means STARTTLS (secure=false).

const SMTP_HOST = process.env.SMTP_HOST ?? "";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD ?? "";

// The "from" address on every message. Providers often insist it matches the
// account you authenticated as.
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || "Crumbs <no-reply@localhost>";

// Where the links in an email point: the web client, not the API. Needed because
// the client is on a different origin in development.
const PUBLIC_URL = (process.env.PUBLIC_URL ?? process.env.CLIENT_ORIGIN ?? "http://localhost:5173").replace(/\/+$/, "");

// Mail is optional: without a host the app runs and prints messages instead of
// sending them, so a developer is never blocked on having SMTP set up.
function isMailConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASSWORD);
}

function transportOptions() {
  return {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  };
}

module.exports = {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  MAIL_FROM,
  PUBLIC_URL,
  isMailConfigured,
  transportOptions,
};
