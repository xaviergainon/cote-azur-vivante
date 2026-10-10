const { getRaw, getSecret, setRaw, setSecret } = require("./settings");
const { buildReport, DEFAULT_NOTIFY_EMAIL, DEFAULT_NOTIFY_FROM } = require("./report");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function notifyConfig(db, secret) {
  const email = (await getRaw(db, "notify_email")) || DEFAULT_NOTIFY_EMAIL;
  const from = (await getRaw(db, "notify_from")) || DEFAULT_NOTIFY_FROM;
  const key = (await getSecret(db, secret, "resend_api_key")) || process.env.RESEND_API_KEY || "";
  return { email, from, key };
}

function barRows(items, labelKey) {
  const max = Math.max(1, ...items.map((item) => item.total));
  return items
    .filter((item) => item.total > 0)
    .map((item) => {
      const width = Math.max(4, Math.round((item.total / max) * 100));
      const color = /^#[0-9a-fA-F]{3,8}$/.test(item.color || "") ? item.color : "#3ecfc2";
      return `<tr>
        <td style="padding:4px 10px 4px 0;color:#35555c;">${escapeHtml(item[labelKey])}</td>
        <td style="padding:4px 0;width:58%;">
          <div style="background:#e7f3f1;border-radius:999px;overflow:hidden;">
            <div style="width:${width}%;background:${color};height:8px;"></div>
          </div>
        </td>
        <td style="padding:4px 0 4px 10px;text-align:right;font-variant-numeric:tabular-nums;">${item.total}</td>
      </tr>`;
    })
    .join("");
}

function reportHtml(report, intro) {
  const when = new Date(report.generatedAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  const images = report.images;
  const last = report.lastRun;
  const outcome = last
    ? `${escapeHtml(last.trigger_name && last.trigger_name !== "manual" ? "Collecte planifiée" : "Collecte manuelle")} · ${escapeHtml(last.status)} · ${last.created_count || 0} nouveau(x) · ${last.updated_count || 0} mis à jour`
    : "Aucune collecte enregistrée.";
  return `<!DOCTYPE html>
<html lang="fr">
  <body style="margin:0;background:#f4f8f7;color:#14343c;font-family:Georgia,serif;">
    <div style="max-width:640px;margin:0 auto;padding:28px 20px 40px;">
      <p style="letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:#3d7f86;font-family:sans-serif;">Côte d'Azur Vivante</p>
      <h1 style="font-weight:500;font-size:32px;margin:0 0 8px;">Rapport de la base</h1>
      <p style="margin:0 0 18px;color:#4d6b72;font-family:sans-serif;">${escapeHtml(intro)} ${escapeHtml(when)}, heure de Paris.</p>
      <p style="font-family:sans-serif;">${outcome}</p>
      <table style="width:100%;border-collapse:separate;border-spacing:8px 8px;margin:8px 0 18px;">
        <tr>
          ${stat("Sorties", report.totals.active)}
          ${stat("Brouillons", report.totals.draft)}
          ${stat("Publiées", report.totals.published)}
          ${stat("Affiches", `${images.coverage} %`)}
        </tr>
      </table>
      <p style="font-family:sans-serif;">${images.withImage} sortie(s) ont une affiche, ${images.withoutImage} en attendent une. ${images.proposed} proposition(s) à valider. ${images.uniquePages} page(s) propre(s), dont ${images.uncheckedPages} jamais tentée(s). ${images.uncheckedShared} sortie(s) sont sur un agenda partagé et attendent la page du spectacle.</p>
      <h2 style="font-weight:500;font-size:22px;">Types</h2>
      <table style="width:100%;border-collapse:collapse;font-family:sans-serif;font-size:14px;">${barRows(report.categories, "label")}</table>
      <h2 style="font-weight:500;font-size:22px;">Villes</h2>
      <table style="width:100%;border-collapse:collapse;font-family:sans-serif;font-size:14px;">${barRows(report.cities.map((city) => ({ ...city, label: city.city })), "label")}</table>
      <p style="font-family:sans-serif;color:#4d6b72;">Fenêtre ${escapeHtml(report.window.minDay)} → ${escapeHtml(report.window.maxDay)} · ${report.days.reduce((sum, day) => sum + day.total, 0)} présence(s) au calendrier.</p>
    </div>
  </body>
</html>`;
}

function stat(label, value) {
  return `<td style="background:#ffffff;border-radius:16px;padding:14px 12px;width:25%;">
    <div style="font-family:sans-serif;font-size:12px;color:#5d7c83;">${escapeHtml(label)}</div>
    <div style="font-size:26px;margin-top:4px;">${escapeHtml(value)}</div>
  </td>`;
}

async function sendEmail({ key, from, to, subject, html }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || body.error?.message || `Resend HTTP ${response.status}`);
  }
  return body.id || "";
}

async function deliverScanMail(ctx, runId, intro, asTrigger) {
  const { db, secret } = ctx;
  const run = await db.query("SELECT trigger_name, status, created_count FROM agent_runs WHERE id = $1", [runId]);
  const row = run.rows[0];
  const name = asTrigger || row?.trigger_name;
  const automatic = {
    schedule: row?.status === "error"
      ? "Côte d'Azur Vivante — la collecte du jour a échoué"
      : `Côte d'Azur Vivante — ${row?.created_count || 0} nouvelle(s) sortie(s)`,
    library: "Côte d'Azur Vivante — bibliothèques du mois",
    ratings: "Côte d'Azur Vivante — avis du mois",
  };
  if (!row || !automatic[name]) return { skipped: true };
  const config = await notifyConfig(db, secret);
  if (!config.key) return { sent: false, reason: "clé Resend absente. Colle-la dans le rapport." };
  const report = await buildReport(db);
  const subject = name === "schedule" && row.status === "error"
    ? automatic.schedule
    : automatic[name];
  await sendEmail({
    key: config.key,
    from: config.from,
    to: config.email,
    subject,
    html: reportHtml(report, intro || "Résultat de la collecte automatique."),
  });
  return { sent: true, to: config.email };
}

async function sendReportNow(ctx, intro) {
  const config = await notifyConfig(ctx.db, ctx.secret);
  if (!config.key) {
    const error = new Error("Colle une clé Resend pour envoyer le rapport.");
    error.status = 400;
    throw error;
  }
  const report = await buildReport(ctx.db);
  await sendEmail({
    key: config.key,
    from: config.from,
    to: config.email,
    subject: "Côte d'Azur Vivante — rapport de la base",
    html: reportHtml(report, intro || "Rapport demandé depuis l’administration."),
  });
  return { ok: true, to: config.email };
}

async function saveNotify(db, secret, body) {
  const email = String(body.email || "").trim().slice(0, 120);
  const from = String(body.from || "").trim().slice(0, 160);
  const key = String(body.resendApiKey || "").trim().slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error("Adresse courriel invalide.");
    error.status = 400;
    throw error;
  }
  if (email) await setRaw(db, "notify_email", email);
  if (from && (/[\r\n]/.test(from) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$|^[^<>\r\n]{1,60} <[^@\s]+@[^@\s]+\.[^@\s]+>$/.test(from))) {
    const error = new Error("Expéditeur invalide.");
    error.status = 400;
    throw error;
  }
  if (from) await setRaw(db, "notify_from", from);
  if (key) await setSecret(db, secret, "resend_api_key", key);
  if (!email && !from && !key) {
    const error = new Error("Rien à enregistrer.");
    error.status = 400;
    throw error;
  }
}

module.exports = { notifyConfig, deliverScanMail, sendReportNow, saveNotify, reportHtml };
