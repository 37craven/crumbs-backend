const nodemailer = require("nodemailer");
const {
  MAIL_FROM,
  PUBLIC_URL,
  isMailConfigured,
  transportOptions,
} = require("../config/mail");

// Messages captured by useTestTransport(), newest last.
const captured = [];

// Transport used when SMTP is not set up. Messages go to the console instead of
// being sent, so every flow works on a machine with no mail configuration.
// Swappable so tests can capture messages without a network.
let transport = null;
// Set once a caller supplies a transport, which outranks the console fallback:
// that is how tests capture messages without SMTP configured.
let transportInjected = false;

function getTransport() {
  if (transport) return transport;
  transport = isMailConfigured()
    ? nodemailer.createTransport(transportOptions())
    : nodemailer.createTransport({ jsonTransport: true });
  return transport;
}

// Tests replace this to collect messages instead of sending them.
function useTestTransport() {
  captured.length = 0;
  transportInjected = true;
  transport = {
    async sendMail(message) {
      captured.push(message);
      return { accepted: [message.to], messageId: "test" };
    },
  };
}

function capturedMail() {
  return captured;
}

// Sends a message. NEVER throws: a mail server being down must not turn a
// successful registration into a 500, or a forgotten password into an error.
// Returns { sent, delivered } so the caller can tell the user something useful.
async function sendMail({ to, subject, text }) {
  const message = { from: MAIL_FROM, to, subject, text };

  // With no SMTP configured and no test transport, print instead of sending.
  if (!transportInjected && !isMailConfigured()) {
    // Printed so a developer can click the link and see the whole flow.
    console.log(
      `\n--- email (not sent: SMTP is not configured) ---\n` +
        `to: ${to}\nsubject: ${subject}\n${text}\n--- end email ---\n`,
    );
    return { sent: true, delivered: false };
  }

  try {
    await getTransport().sendMail(message);
    return { sent: true, delivered: transportInjected ? false : true };
  } catch (err) {
    // Logged, never returned: the detail may contain the host or a username.
    console.error(`Could not send mail to ${to}: ${err.message}`);
    return { sent: false, delivered: false };
  }
}

function linkTo(path) {
  return `${PUBLIC_URL}${path}`;
}

module.exports = { sendMail, linkTo, useTestTransport, capturedMail, getTransport };
