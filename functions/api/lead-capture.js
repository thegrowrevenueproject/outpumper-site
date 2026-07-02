// POST /api/lead-capture
// Forwards tool email-gate submissions to Mautic (marketing.coldpumper.com) server-side.
// Env vars (Cloudflare Pages -> Settings -> Environment variables, production):
//   MAUTIC_URL  = https://marketing.coldpumper.com   (no trailing slash)
//   MAUTIC_USER = cf-capture
//   MAUTIC_PASS = <password>  (encrypt)
// Design: fail-soft. The tool UX must never break because Mautic is down.
// The page always gets {ok:true} unless the email itself is invalid.

const MAGNET_MAP = {
  "deliverability": "checker",
  "roi-calculator": "roi",
  "reply-to-close": "r2c",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }

  // Honeypot: field must be present and empty. Bots that fill it get a fake success.
  if (typeof body.hp !== "string" || body.hp !== "") {
    return json({ ok: true });
  }

  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, error: "invalid email" }, 400);
  }

  const magnet = MAGNET_MAP[String(body.magnet || "")] || "unknown";

  // Build Mautic contact payload — field keys are Mautic contact-field aliases.
  const contact = {
    email: email,
    magnet: magnet,
    ipAddress: request.headers.get("CF-Connecting-IP") || undefined,
  };
  if (magnet === "checker" && body.domain) {
    contact.tool_domain = String(body.domain).slice(0, 190);
  }
  if (body.score !== undefined && body.score !== null && !isNaN(Number(body.score))) {
    contact.tool_score = Number(body.score);
  }

  // Tags: canonical magnet tag + any UTM source/campaign as tags.
  const tags = ["magnet:" + magnet];
  for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
    const v = body[k];
    if (v && typeof v === "string" && v.length < 60) {
      tags.push(k.replace("utm_", "utm-") + ":" + v.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40));
    }
  }
  contact.tags = tags;

  // Forward to Mautic with a hard timeout; never block the page on failure.
  const base = (env.MAUTIC_URL || "https://marketing.coldpumper.com").replace(/\/+$/, "");
  const auth = "Basic " + btoa(env.MAUTIC_USER + ":" + env.MAUTIC_PASS);

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(base + "/api/contacts/new", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": auth,
      },
      body: JSON.stringify(contact),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("mautic error", res.status, t.slice(0, 300));
    }
  } catch (err) {
    console.error("mautic unreachable", String(err));
  }

  return json({ ok: true });
}

// Anything but POST -> 405.
export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ ok: false, error: "method not allowed" }, 405);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
