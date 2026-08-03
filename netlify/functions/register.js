// netlify/functions/register.js
//
// Handles registration form submission:
//   1. Looks up the property (if a code was provided) to confirm it and get
//      its live URL + Notion page id for the relation.
//   2. Creates/updates a Brevo contact (upsert by email) with attribution.
//   3. Creates a Property Registrations record in Notion.
//   4. Returns a redirect target (live Property URL) or a flag to show the
//      generic "you're registered" confirmation.
//
// Never fetches, references, or returns any PDF or PDF-derived field.
//
// Required environment variables (set in Netlify site settings):
//   NOTION_TOKEN            - Notion internal integration secret
//   PK_Register_Brevo_Key   - Brevo API v3 key

const { Client } = require("@notionhq/client");

// Database IDs (page IDs, not data source/collection IDs) — the
// @notionhq/client SDK's databases.query() and pages.create() expect these.
const PIPELINE_DATABASE_ID = "710fe865009045849686b7c6a64cae81";
const REGISTRATIONS_DATABASE_ID = "a58647ef50074ad69a720466adba77f3";
const BREVO_LIST_ID = 8; // "Registrations - Website"

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function findPipelinePage(notion, code) {
  const response = await notion.databases.query({
    database_id: PIPELINE_DATABASE_ID,
    filter: {
      property: "Property Code",
      rich_text: { equals: code },
    },
    page_size: 1,
  });
  if (!response.results || response.results.length === 0) return null;
  return response.results[0];
}

function getText(prop) {
  if (!prop) return null;
  if (prop.type === "title") return (prop.title || []).map((t) => t.plain_text).join("");
  if (prop.type === "rich_text") return (prop.rich_text || []).map((t) => t.plain_text).join("");
  if (prop.type === "select") return prop.select ? prop.select.name : null;
  if (prop.type === "url") return prop.url;
  return null;
}

async function upsertBrevoContact(apiKey, payload) {
  const res = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  // Brevo returns 400 duplicate_parameter if contact exists; treat as success
  // and fall through to an update call.
  if (res.status === 201) return { created: true };
  if (res.status === 204) return { created: false };

  const body = await res.json().catch(() => ({}));
  if (res.status === 400 && body.code === "duplicate_parameter") {
    const updateRes = await fetch(
      `https://api.brevo.com/v3/contacts/${encodeURIComponent(payload.email)}`,
      {
        method: "PUT",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attributes: payload.attributes,
          listIds: payload.listIds,
        }),
      }
    );
    if (updateRes.ok) return { created: false, updated: true };
    throw new Error(`Brevo update failed: ${updateRes.status}`);
  }
  throw new Error(`Brevo create failed: ${res.status} ${JSON.stringify(body)}`);
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const firstName = (data.firstName || "").trim();
  const email = (data.email || "").trim().toLowerCase();
  const propertyCodeRaw = (data.propertyCode || "").trim();
  const propertyCode = propertyCodeRaw ? propertyCodeRaw.toUpperCase() : "";
  const source = (data.source || "").trim();
  const campaign = (data.campaign || "").trim();
  const utmSource = (data.utmSource || "").trim();
  const utmMedium = (data.utmMedium || "").trim();
  const utmCampaign = (data.utmCampaign || "").trim();
  const landingPageUrl = (data.landingPageUrl || "").trim();

  if (!firstName || !email) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "First name and email are required" }),
    };
  }
  if (!isValidEmail(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid email address" }) };
  }
  if (!process.env.NOTION_TOKEN || !process.env.PK_Register_Brevo_Key) {
    console.error("Missing NOTION_TOKEN or PK_Register_Brevo_Key env vars");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server misconfigured" }) };
  }

  const notion = new Client({ auth: process.env.NOTION_TOKEN });

  // Step 1: resolve property if a code was given
  let pipelinePage = null;
  let propertyUrl = null;
  let isLive = false;
  let registrationType = "General Alert Only";

  if (propertyCode) {
    try {
      pipelinePage = await findPipelinePage(notion, propertyCode);
      if (pipelinePage) {
        const availability = getText(pipelinePage.properties["Availability"]);
        propertyUrl = getText(pipelinePage.properties["Property URL"]);
        isLive = availability === "Available";
        registrationType = "Property-Specific";
      }
    } catch (err) {
      console.error("Pipeline lookup failed during registration:", err);
      // Continue as general registration rather than failing the whole submit
    }
  }

  // Step 2: upsert Brevo contact
  let brevoSynced = false;
  let brevoError = null;
  try {
    await upsertBrevoContact(process.env.PK_Register_Brevo_Key, {
      email,
      attributes: {
        FIRSTNAME: firstName,
        EMAIL_CONSENT: true,
        OPT_IN: true,
        PROPERTY_CODE: propertyCode || "",
        PROPERTY_URL: propertyUrl || "",
        SOURCE_PLATFORM: source || "",
        CAMPAIGN_ID: campaign || "",
      },
      listIds: [BREVO_LIST_ID],
      updateEnabled: true,
    });
    brevoSynced = true;
  } catch (err) {
    console.error("Brevo sync failed:", err);
    brevoError = err.message;
  }

  // Step 3: create Notion registration record
  const redirectTo = isLive && propertyUrl ? propertyUrl : null;
  let notionError = null;
  try {
    const properties = {
      "Registrant Name": { title: [{ text: { content: firstName } }] },
      Email: { rich_text: [{ text: { content: email } }] },
      "Property Code Entered": { rich_text: [{ text: { content: propertyCodeRaw } }] },
      "Source Platform": source ? { select: { name: source } } : undefined,
      "Campaign ID": { rich_text: [{ text: { content: campaign } }] },
      "UTM Source": { rich_text: [{ text: { content: utmSource } }] },
      "UTM Medium": { rich_text: [{ text: { content: utmMedium } }] },
      "UTM Campaign": { rich_text: [{ text: { content: utmCampaign } }] },
      "Landing Page URL": landingPageUrl ? { url: landingPageUrl } : undefined,
      "Property URL at Submission": propertyUrl ? { url: propertyUrl } : undefined,
      "Redirected To": redirectTo ? { url: redirectTo } : undefined,
      "Registration Type": { select: { name: registrationType } },
      "Consent Given": { checkbox: true },
      "Submitted At": { date: { start: new Date().toISOString() } },
      "Brevo Contact Synced": { checkbox: brevoSynced },
      Notes: {
        rich_text: [
          {
            text: {
              content: brevoError ? `Brevo sync failed: ${brevoError}` : "",
            },
          },
        ],
      },
    };
    if (pipelinePage) {
      properties["Property"] = { relation: [{ id: pipelinePage.id }] };
    }
    // Strip undefined keys (Notion API rejects undefined values)
    Object.keys(properties).forEach((k) => properties[k] === undefined && delete properties[k]);

    await notion.pages.create({
      parent: { database_id: REGISTRATIONS_DATABASE_ID },
      properties,
    });
  } catch (err) {
    console.error("Notion registration record failed:", err);
    notionError = err.message;
  }

  // If both systems failed, tell the user something went wrong.
  if (!brevoSynced && notionError) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: "We couldn't complete your registration right now. Please try again shortly.",
      }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      redirectTo, // null if no live property resolved
      isLive,
      registrationType,
    }),
  };
};
